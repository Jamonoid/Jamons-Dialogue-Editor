/**
 * MCP server — exposes Dialogue Forge as an MCP tool provider over local HTTP.
 * Runs inside the Electron main process while the app is open. Tool calls are
 * forwarded to the renderer (where state.js lives) via an `exec` callback, so
 * edits happen on the live canvas with normal undo/redo and persistence.
 *
 * Register once from any repo (user scope → available everywhere):
 *   claude mcp add --transport http --scope user dialogue-forge http://127.0.0.1:4747/mcp
 */
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const MCP_PORT = Number(process.env.DIALOGUE_FORGE_MCP_PORT) || 4747;

/** Builds a fresh McpServer with all tools wired to `exec(toolName, args)`. */
function buildServer(exec) {
  const server = new McpServer({ name: 'dialogue-forge', version: '1.1.0' });

  const register = (name, description, shape) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const result = await exec(name, args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!(result && result.ok === false),
      };
    });
  };

  // Shared param: every edit tool targets an explicit dialogue, or the active one when omitted.
  const dialogueIdParam = z.string().optional()
    .describe('Dialogue ID to operate on; defaults to the dialogue active on the canvas');

  // ── Read tools ──
  register(
    'get_project_summary',
    'Overview of the whole Dialogue Forge project: NPCs, quests, and dialogues (with node counts and which one is active on the canvas). Each item includes its author comment ("comment") — context notes like when a dialogue triggers or who an NPC is.',
    {},
  );
  register(
    'get_dialogue',
    'Read one dialogue. Default format "compact" (token-lean): nodes list {id, npc, es, en?, if?, do?} with empty fields omitted, plus "edges" as [from, to, label?] tuples and "start". Use "structure" for ids/edges only (no text) or "full" for the verbose legacy shape.',
    {
      dialogue_id: z.string().optional().describe('Dialogue ID; defaults to the active dialogue'),
      format: z.enum(['compact', 'structure', 'full']).optional().describe('Output shape; default compact'),
    },
  );
  register(
    'validate_dialogue',
    'Cheap structural check of a dialogue: unreachable nodes, connections pointing to missing nodes, nodes with empty Spanish/English text, and endings (nodes without outgoing connections — informational). Returns ok:false when the tree is broken.',
    { dialogue_id: dialogueIdParam },
  );

  // ── Whole-graph writer (preferred for creating or rewriting dialogue trees) ──
  register(
    'write_dialogue_graph',
    'Write a whole dialogue tree in ONE call: nodes + connections + start node, using your own temp ids ("n1", "n2"...). Returns idMap (temp id → real id). With "title" it creates a new dialogue (optionally linked to npc_name/quest_name, with an author comment) and activates it; without "title" it writes into dialogue_id or the active dialogue. mode "replace" (default) clears existing nodes first — use it to rewrite a dialogue; "append" keeps them (connections may then also reference real existing node ids). The tree is auto-laid-out; no auto_layout call needed. The payload is validated before any mutation, so a bad reference aborts the whole write.',
    {
      title: z.string().optional().describe('Create a new dialogue with this title (ignores dialogue_id/mode)'),
      npc_name: z.string().optional().describe('Main NPC for the new dialogue (created if missing)'),
      quest_name: z.string().optional().describe('Quest for the new dialogue (created if missing)'),
      comment: z.string().optional().describe('Author note for the new dialogue, e.g. when it triggers'),
      dialogue_id: dialogueIdParam,
      mode: z.enum(['replace', 'append']).optional().describe('replace (default): clear existing nodes first; append: add to them'),
      nodes: z.array(z.object({
        id: z.string().describe('Your temp id ("n1") — mapped to a real id in the returned idMap'),
        text_es: z.string().optional().describe('Node text in Spanish'),
        text_en: z.string().optional().describe('Node text in English'),
        npc: z.string().optional().describe('Speaker NPC name (created if missing)'),
        condition: z.string().optional().describe('Game-side condition for this node, e.g. "quest_active(Q1)"'),
        action: z.string().optional().describe('Game-side action this node fires, e.g. "give_item(symbol_fragment)"'),
      })).describe('All nodes of the tree'),
      connections: z.array(z.object({
        from: z.string().describe('Temp id (or real node id in append mode)'),
        to: z.string().describe('Temp id (or real node id in append mode)'),
        label: z.string().optional().describe('Player-choice label shown on the connection'),
      })).optional().describe('Directed edges of the tree'),
      start: z.string().optional().describe('Temp id of the entry node; defaults to the first node'),
    },
  );

  // ── Dialogue-level tools ──
  register(
    'create_dialogue',
    'Create a new EMPTY dialogue (one blank start node) and make it active. Prefer write_dialogue_graph with "title" when you already know the tree — it does this plus all nodes in one call.',
    {
      title: z.string().describe('Dialogue title'),
      npc_name: z.string().optional().describe('Main NPC name'),
      quest_name: z.string().optional().describe('Quest name'),
      comment: z.string().optional().describe('Author note giving the AI context, e.g. "Triggers when the player returns the sword at the end of the quest"'),
    },
  );
  register(
    'update_dialogue',
    'Update a dialogue\'s title, main NPC, quest and/or author comment. Only the provided fields change (npc_name/quest_name accept "" to unlink).',
    {
      dialogue_id: dialogueIdParam,
      title: z.string().optional(),
      npc_name: z.string().optional().describe('Main NPC name (created if missing); empty string unlinks'),
      quest_name: z.string().optional().describe('Quest name (created if missing); empty string unlinks'),
      comment: z.string().optional().describe('Author note (empty string clears it)'),
    },
  );
  register(
    'delete_dialogue',
    'Delete a whole dialogue and all its nodes. dialogue_id is required (never defaults to the active dialogue). Undoable in the app with Ctrl+Z.',
    { dialogue_id: z.string().describe('ID of the dialogue to delete') },
  );
  register(
    'clear_dialogue',
    'Remove ALL nodes of a dialogue, leaving one empty start node. Useful before rewriting a dialogue node-by-node — though write_dialogue_graph with mode "replace" does clear+write in one call.',
    { dialogue_id: dialogueIdParam },
  );
  register(
    'set_active_dialogue',
    'Switch which dialogue is active on the canvas (the default target of edit tools when dialogue_id is omitted).',
    { dialogue_id: z.string().describe('Dialogue ID to activate') },
  );

  // ── Node-level tools ──
  register(
    'add_node',
    'Add a dialogue node. Returns the real node id — use it for connect_nodes. Position is auto-assigned below existing nodes unless x/y are given. For several nodes, prefer write_dialogue_graph.',
    {
      text_es: z.string().describe('Node text in Spanish (primary language)'),
      text_en: z.string().optional().describe('Node text in English'),
      npc_name: z.string().optional().describe('Speaker NPC name (created if missing)'),
      condition: z.string().optional().describe('Game-side condition for this node'),
      action: z.string().optional().describe('Game-side action this node fires'),
      x: z.number().optional(),
      y: z.number().optional(),
      dialogue_id: dialogueIdParam,
    },
  );
  register(
    'update_node',
    'Update text, speaker NPC, condition and/or action of an existing node. Only the provided fields change (condition/action accept "" to clear).',
    {
      node_id: z.string(),
      text_es: z.string().optional(),
      text_en: z.string().optional(),
      npc_name: z.string().optional().describe('Speaker NPC name (created if missing)'),
      condition: z.string().optional().describe('Game-side condition; empty string clears'),
      action: z.string().optional().describe('Game-side action; empty string clears'),
      dialogue_id: dialogueIdParam,
    },
  );
  register(
    'connect_nodes',
    'Create a directed connection between two nodes (source → target), optionally with a player-choice label. If the connection already exists, it just updates the label.',
    {
      source_id: z.string(),
      target_id: z.string(),
      label: z.string().optional().describe('Choice label shown on the connection'),
      dialogue_id: dialogueIdParam,
    },
  );
  register(
    'disconnect_nodes',
    'Remove the directed connection source → target between two nodes.',
    {
      source_id: z.string(),
      target_id: z.string(),
      dialogue_id: dialogueIdParam,
    },
  );
  register(
    'delete_node',
    'Delete a node (and every connection pointing at it).',
    { node_id: z.string(), dialogue_id: dialogueIdParam },
  );
  register(
    'set_start_node',
    'Mark a node as the entry point of the dialogue.',
    { node_id: z.string(), dialogue_id: dialogueIdParam },
  );

  // ── Project-level tools ──
  register(
    'create_npc',
    'Create an NPC (skipped if one with the same name already exists). Color is a hex string like #e06c75.',
    { name: z.string(), color: z.string().optional() },
  );
  register(
    'auto_layout',
    'Automatically arrange the nodes of a dialogue in a tree layout. write_dialogue_graph already lays out what it writes; call this after manual add_node/connect_nodes sequences.',
    { dialogue_id: dialogueIdParam },
  );
  register(
    'set_comment',
    'Set the author note of an NPC, quest or dialogue. These notes give the AI context it cannot infer (when a dialogue triggers, who an NPC is, what a quest is about). Pass an empty string to clear.',
    {
      type: z.enum(['npc', 'quest', 'dialogue']).describe('Kind of item to annotate'),
      id: z.string().describe('ID of the NPC / quest / dialogue'),
      comment: z.string().describe('The author note (empty string clears it)'),
    },
  );

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/**
 * Starts the local MCP endpoint (stateless Streamable HTTP).
 * @param {(tool: string, args: object) => Promise<object>} exec
 * @returns {http.Server}
 */
export function startMcpServer(exec, port = MCP_PORT) {
  const httpServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream, no sessions to delete
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }
    try {
      const body = await readBody(req);
      // Fresh server+transport per request (recommended stateless pattern)
      const server = buildServer(exec);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message || err) }, id: null }));
      }
    }
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[MCP] Dialogue Forge MCP server on http://127.0.0.1:${port}/mcp`);
  });
  httpServer.on('error', (err) => {
    console.error('[MCP] Server error:', err.message);
  });
  return httpServer;
}

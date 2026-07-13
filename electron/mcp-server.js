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
  const server = new McpServer({ name: 'dialogue-forge', version: '1.0.0' });

  const register = (name, description, shape) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const result = await exec(name, args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!(result && result.ok === false),
      };
    });
  };

  // ── Read tools ──
  register(
    'get_project_summary',
    'Overview of the whole Dialogue Forge project: NPCs, quests, and dialogues (with node counts and which one is active on the canvas). Each item includes its author comment ("comment") — context notes like when a dialogue triggers or who an NPC is.',
    {},
  );
  register(
    'get_dialogue',
    'Full contents of one dialogue: every node with its id, NPC, Spanish/English text, outgoing connections and start-node flag. Omit dialogue_id to read the dialogue currently active on the canvas.',
    { dialogue_id: z.string().optional().describe('Dialogue ID; defaults to the active dialogue') },
  );

  // ── Edit tools (operate on the ACTIVE dialogue; they run live on the canvas) ──
  register(
    'create_dialogue',
    'Create a new dialogue (with an empty start node) and make it active on the canvas. Optionally link it to an NPC and/or quest by name — they are created if they do not exist.',
    {
      title: z.string().describe('Dialogue title'),
      npc_name: z.string().optional().describe('Main NPC name'),
      quest_name: z.string().optional().describe('Quest name'),
      comment: z.string().optional().describe('Author note giving the AI context, e.g. "Triggers when the player returns the sword at the end of the quest"'),
    },
  );
  register(
    'set_active_dialogue',
    'Switch which dialogue is active on the canvas. Node-editing tools always operate on the active dialogue.',
    { dialogue_id: z.string().describe('Dialogue ID to activate') },
  );
  register(
    'add_node',
    'Add a dialogue node to the active dialogue. Returns the real node id — use it for connect_nodes. Position is auto-assigned below existing nodes unless x/y are given.',
    {
      text_es: z.string().describe('Node text in Spanish (primary language)'),
      text_en: z.string().optional().describe('Node text in English'),
      npc_name: z.string().optional().describe('Speaker NPC name (created if missing)'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  );
  register(
    'update_node',
    'Update text and/or speaker NPC of an existing node in the active dialogue. Only the provided fields change.',
    {
      node_id: z.string(),
      text_es: z.string().optional(),
      text_en: z.string().optional(),
      npc_name: z.string().optional().describe('Speaker NPC name (created if missing)'),
    },
  );
  register(
    'connect_nodes',
    'Create a directed connection between two nodes of the active dialogue (source → target), optionally with a choice label.',
    {
      source_id: z.string(),
      target_id: z.string(),
      label: z.string().optional().describe('Choice label shown on the connection'),
    },
  );
  register(
    'delete_node',
    'Delete a node (and its connections) from the active dialogue.',
    { node_id: z.string() },
  );
  register(
    'set_start_node',
    'Mark a node as the entry point of the active dialogue.',
    { node_id: z.string() },
  );
  register(
    'create_npc',
    'Create an NPC (skipped if one with the same name already exists). Color is a hex string like #e06c75.',
    { name: z.string(), color: z.string().optional() },
  );
  register(
    'auto_layout',
    'Automatically arrange the nodes of the active dialogue on the canvas (tree layout). Call after adding several nodes.',
    {},
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

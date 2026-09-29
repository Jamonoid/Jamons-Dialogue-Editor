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
  const server = new McpServer({ name: 'dialogue-forge', version: '1.2.0' });

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
  // Layout / comment-box tools also work on the story map
  const graphIdParam = z.string().optional()
    .describe('Dialogue ID, or "story" for the story map; defaults to the dialogue active on the canvas');
  const colorParam = z.string().optional()
    .describe('Hex like #61afef, or a preset: gris, rojo, naranja, amarillo, verde, azul, violeta (English names work too)');
  const commentBoxesParam = z.array(z.object({
    id: z.string().optional().describe('Existing box id (from get_dialogue/get_layout commentBoxes) to re-target around these nodes instead of creating a new box — keeps the author\'s text/color unless given'),
    text: z.string().optional().describe('Title shown on the box (required for new boxes), e.g. "Rama: coquetear con Tama"'),
    nodes: z.array(z.string()).describe('Temp ids (or real ids) of the nodes this box groups'),
    color: colorParam,
  })).optional().describe('Section boxes (UE-style comments) wrapped around groups of nodes after the layout. Give each box a contiguous part of the tree — a branch, a scene, a phase of the talk: every branch gets its own column, so such boxes never overlap. Result "commentBoxes" lists what each box ended up containing (foreignNodeIds = nodes inside that you did not list).');
  const layoutModeParam = z.enum(['auto', 'full']).optional()
    .describe('auto (default): tidy layout of the whole graph on create/replace; in append mode only the new nodes are laid out, as a block to the right of the untouched graph. full: re-lay out the whole graph (also in append).');

  // ── Read tools ──
  register(
    'get_project_summary',
    'Overview of the whole Dialogue Forge project: NPCs, quests (with their related NPC names), dialogues (with node counts and which one is active on the canvas), and a storyMap node count (read the full graph with get_story_map). Each item includes its author comment ("comment") — context notes like when a dialogue triggers or who an NPC is.',
    {},
  );
  register(
    'get_dialogue',
    'Read one dialogue. Default format "compact" (token-lean): nodes list {id, npc, es, en?, if?, do?, locked?} with empty fields omitted, plus "edges" as [from, to, label?] tuples and "start". Nodes with locked:true are author-protected: update_node/delete_node will refuse them and replace-writes keep them. "commentBoxes" (present when there are any) lists the comment boxes on the canvas as {id, text, nodeIds}: the text is the label of that section of the conversation (scene, mood, branch purpose) and nodeIds are the nodes fully inside the box — use it as context for those nodes. Use "structure" for ids/edges/commentBoxes only (no node text) or "full" for the verbose legacy shape. Positions are not included — read them with get_layout.',
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
  register(
    'get_story_map',
    'Read the global story map: the quest-structure graph the author draws in the "Historia" view. Returns nodes {id, quest, es, en?} (quest = quest name or null), "edges" as [from, to, condition?] tuples where the third element is the CONDITION for that next quest/step to start, "start" (entry node id), and "quests" — per quest referenced in the map: its author note plus related NPCs and dialogues (the "Relacionados" the author curated). "commentBoxes" (when present) are comment boxes {id, text, nodeIds} grouping story nodes into acts/arcs/routes. Use this to understand the overall story order and quest gating before writing dialogues.',
    {},
  );

  // ── Whole-graph writer (preferred for creating or rewriting dialogue trees) ──
  register(
    'write_dialogue_graph',
    'Write a whole dialogue tree in ONE call: nodes + connections + start node, using your own temp ids ("n1", "n2"...). Returns idMap (temp id → real id). With "title" it creates a new dialogue (optionally linked to npc_name/quest_name, with an author comment) and activates it; without "title" it writes into dialogue_id or the active dialogue. mode "replace" (default) clears existing nodes first — use it to rewrite a dialogue; "append" keeps them (connections may then also reference real existing node ids). Author-locked nodes (locked:true in get_dialogue) ALWAYS survive a replace — connections may reference their real ids. The tree is auto-laid-out as a tidy top-down tree (each branch in its own column in choice order, nodes where branches reconverge centered below them) — no auto_layout call needed. Use comment_boxes to label sections (branches, scenes) in the same call. On replace, existing comment boxes whose nodes are all gone are parked left of the graph and reported in parkedCommentBoxes (pass their id in comment_boxes to re-target them instead). The payload is validated before any mutation, so a bad reference aborts the whole write.',
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
      })).optional().describe('Directed edges of the tree. Their order per node is the in-game choice order and the left-to-right layout order'),
      start: z.string().optional().describe('Temp id of the entry node; defaults to the first node'),
      comment_boxes: commentBoxesParam,
      layout: layoutModeParam,
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
    'Remove ALL nodes of a dialogue, leaving one empty start node. Author-locked nodes (locked:true) survive the clear. Useful before rewriting a dialogue node-by-node — though write_dialogue_graph with mode "replace" does clear+write in one call.',
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
    'Add a dialogue node. Returns the real node id (use it for connect_nodes) and its position. Placement: below:<nodeId> puts it centered under that node (sliding right if the spot is taken — handy for adding a choice under its parent), right_of:<nodeId> beside it (sliding down if taken), x/y absolute; default: below everything. For several nodes, prefer write_dialogue_graph.',
    {
      text_es: z.string().describe('Node text in Spanish (primary language)'),
      text_en: z.string().optional().describe('Node text in English'),
      npc_name: z.string().optional().describe('Speaker NPC name (created if missing)'),
      condition: z.string().optional().describe('Game-side condition for this node'),
      action: z.string().optional().describe('Game-side action this node fires'),
      below: z.string().optional().describe('Node id to place this node under'),
      right_of: z.string().optional().describe('Node id to place this node to the right of'),
      x: z.number().optional().describe('Absolute canvas x (left edge)'),
      y: z.number().optional().describe('Absolute canvas y (top edge)'),
      dialogue_id: dialogueIdParam,
    },
  );
  register(
    'update_node',
    'Update text, speaker NPC, condition and/or action of an existing node. Only the provided fields change (condition/action accept "" to clear). Refused for author-locked nodes (locked:true).',
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
    'Delete a node (and every connection pointing at it). Refused for author-locked nodes (locked:true).',
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
    'Re-arrange ALL nodes of a dialogue (or of the story map with dialogue_id "story") as a tidy top-down tree: each branch gets its own column in choice order, nodes where several branches reconverge are centered below them, loops back to earlier nodes are ignored for placement, and every row is as tall as its tallest node — nothing overlaps. Comment boxes are refit around the nodes they held (reported in commentBoxes; foreignNodeIds = the box now also covers nodes outside its section). The start node keeps its position. Overrides manual placement. write_dialogue_graph / write_story_map already lay out what they write.',
    {
      dialogue_id: graphIdParam,
      spacing: z.enum(['compact', 'normal', 'wide']).optional().describe('Gap between nodes; default normal'),
    },
  );

  // ── Layout & comment boxes (dialogues and story map) ──
  register(
    'get_layout',
    'Read the geometry of a dialogue (or the story map with dialogue_id "story"). Coordinates are canvas pixels, x → right, y → down; the flow is top-down (a node\'s input connector is its top edge, its output the bottom edge). Returns node boxes {id, x, y, w, h} (width 240 by default, 320 on the story map; height grows with the text), commentBoxes {id, text, x, y, w, h, color, nodeIds} (the title bar is drawn ~28px ABOVE y), bounds, and diagnostics: overlaps = pairs of node ids whose boxes overlap; straddling = [commentBoxId, nodeId] for nodes cut by a box edge (they look grouped but will not move with the box). Use it before move_nodes or manual box edits.',
    { dialogue_id: graphIdParam },
  );
  register(
    'move_nodes',
    'Move nodes of a dialogue (or of the story map with dialogue_id "story"), applied in order so later moves can use earlier ones. Each move sets ONE of: x/y (absolute top-left), dx/dy (relative nudge), or a placement next to another node — below / above (centered on it) or right_of / left_of (top-aligned) — with an optional gap (default 100 vertical, 80 horizontal); dx/dy can be added to a placement to fine-tune it. Validated before moving anything. Returns the new positions and any overlaps involving the moved nodes. Comment boxes do not follow automatically — re-wrap them with update_comment_box(node_ids), or move a box with its contents via update_comment_box(dx/dy).',
    {
      dialogue_id: graphIdParam,
      moves: z.array(z.object({
        node_id: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        below: z.string().optional().describe('Reference node id: place centered under it'),
        above: z.string().optional().describe('Reference node id: place centered over it'),
        right_of: z.string().optional().describe('Reference node id: place to its right, top-aligned'),
        left_of: z.string().optional().describe('Reference node id: place to its left, top-aligned'),
        gap: z.number().optional().describe('Distance to the reference node'),
      })).describe('Moves to apply, in order'),
    },
  );
  register(
    'add_comment_box',
    'Draw a UE-style comment box — a titled, colored section — on a dialogue or on the story map (dialogue_id "story"). Preferred: node_ids → the box wraps those nodes with padding (existing boxes whose nodes are all included end up nested inside). Or x/y (+ width/height, default 400×260) for a free-standing note. Nodes fully inside a box travel with it when the author drags its title. Returns nodeIds actually inside, and foreignNodeIds if the rectangle also covers nodes you did not list (the section is not contiguous — fix it with auto_layout or move_nodes, then update_comment_box(node_ids)).',
    {
      dialogue_id: graphIdParam,
      text: z.string().describe('Title shown on the box, e.g. "Rama: coquetear con Tama"'),
      node_ids: z.array(z.string()).optional().describe('Nodes to wrap'),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      color: colorParam,
    },
  );
  register(
    'update_comment_box',
    'Edit a comment box: text, color, node_ids (re-wrap it around these nodes; the nodes do not move), x/y or dx/dy (move it — nodes and boxes fully inside travel along, like dragging its title in the editor; move_contents:false moves only the box), width/height (resize). node_ids cannot be combined with moving/resizing.',
    {
      dialogue_id: graphIdParam,
      comment_id: z.string().describe('Comment box id (from get_layout / get_dialogue commentBoxes)'),
      text: z.string().optional(),
      color: colorParam,
      node_ids: z.array(z.string()).optional().describe('Re-wrap the box around exactly these nodes'),
      x: z.number().optional(),
      y: z.number().optional(),
      dx: z.number().optional(),
      dy: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      move_contents: z.boolean().optional().describe('Default true: what is inside moves with the box'),
    },
  );
  register(
    'delete_comment_box',
    'Delete a comment box (dialogue or story map). Only the box — its nodes are untouched.',
    {
      dialogue_id: graphIdParam,
      comment_id: z.string(),
    },
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

  // ── Story map tools (global quest-structure graph, "Historia" view) ──
  register(
    'write_story_map',
    'Write the whole story map in ONE call: nodes + connections + start, using your own temp ids ("n1", "n2"...). Each node optionally links a quest by name (created if missing). Each connection carries the CONDITION for the target quest/step to start. mode "replace" (default) rewrites the map; "append" adds to it (connections may then also reference real existing node ids). The graph is validated before any mutation (atomic) and auto-laid-out as a tidy top-down tree (same rules as auto_layout); comment_boxes can group steps into acts/arcs/routes in the same call. Returns idMap (temp id → real id). Preferred over N×add_story_node calls.',
    {
      mode: z.enum(['replace', 'append']).optional().describe('replace (default): rewrite the map; append: add to it'),
      nodes: z.array(z.object({
        id: z.string().describe('Your temp id ("n1") — mapped to a real id in the returned idMap'),
        quest: z.string().optional().describe('Quest name this story step belongs to (created if missing)'),
        text_es: z.string().optional().describe('Step description in Spanish'),
        text_en: z.string().optional().describe('Step description in English'),
      })).describe('All story steps'),
      connections: z.array(z.object({
        from: z.string().describe('Temp id (or real node id in append mode)'),
        to: z.string().describe('Temp id (or real node id in append mode)'),
        condition: z.string().optional().describe('Condition for the target quest/step to start (drawn on the arrow)'),
      })).optional().describe('Directed edges of the story'),
      start: z.string().optional().describe('Temp id of the entry step; defaults to the first node'),
      comment_boxes: commentBoxesParam,
      layout: layoutModeParam,
    },
  );
  register(
    'add_story_node',
    'Add ONE node to the story map, optionally linked to a quest (created if missing). Returns the real node id (use it for connect_story_nodes) and its position. Placement: below:<nodeId> (centered under it, sliding right if taken), right_of:<nodeId> (sliding down if taken), x/y absolute; default: below everything. For several nodes, prefer write_story_map.',
    {
      quest: z.string().optional().describe('Quest name for this step (created if missing)'),
      text_es: z.string().optional().describe('Step description in Spanish'),
      text_en: z.string().optional().describe('Step description in English'),
      below: z.string().optional().describe('Story node id to place this node under'),
      right_of: z.string().optional().describe('Story node id to place this node to the right of'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  );
  register(
    'update_story_node',
    'Update a story map node: its quest and/or description. Only the provided fields change (quest accepts "" to unlink).',
    {
      node_id: z.string(),
      quest: z.string().optional().describe('Quest name (created if missing); empty string unlinks'),
      text_es: z.string().optional(),
      text_en: z.string().optional(),
    },
  );
  register(
    'delete_story_node',
    'Delete a story map node (and every connection pointing at it).',
    { node_id: z.string() },
  );
  register(
    'connect_story_nodes',
    'Create a directed connection between two story nodes (from → to). "condition" is the requirement for the target quest/step to start — it is drawn on the arrow. If the connection already exists, it just updates the condition.',
    {
      from: z.string(),
      to: z.string(),
      condition: z.string().optional().describe('Condition for the target step to start (empty string clears)'),
    },
  );
  register(
    'disconnect_story_nodes',
    'Remove the directed connection from → to between two story nodes.',
    { from: z.string(), to: z.string() },
  );
  register(
    'set_story_start',
    'Mark a story map node as the entry point of the story.',
    { node_id: z.string() },
  );
  register(
    'validate_story',
    'Structural check of the story map: unreachable steps, broken connections, missing ES/EN descriptions, endings, plus story-specific hints — nodes without a quest assigned and edges without a start condition. Returns ok:false when the graph is broken.',
    {},
  );
  register(
    'update_quest_relations',
    'Edit the "Relacionados" of a quest (shared by every story node of that quest): add/remove related NPCs (by name; created if missing on add) and add/remove related dialogues (by id or exact title). Adding a dialogue assigns its quest; removing clears it.',
    {
      quest_name: z.string().describe('Quest name (created if missing)'),
      add_npcs: z.array(z.string()).optional().describe('NPC names to relate'),
      remove_npcs: z.array(z.string()).optional().describe('NPC names to unrelate'),
      add_dialogues: z.array(z.string()).optional().describe('Dialogue ids or exact titles to assign to this quest'),
      remove_dialogues: z.array(z.string()).optional().describe('Dialogue ids or exact titles to unassign'),
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

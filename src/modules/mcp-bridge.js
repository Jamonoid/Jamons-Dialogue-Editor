/**
 * MCP bridge — renderer-side executor for the MCP tools exposed by
 * electron/mcp-server.js. The Electron main process calls
 * window.__mcpExecute(tool, args) via executeJavaScript; each tool runs
 * against the live State (canvas re-renders, undo/redo and persistence
 * behave exactly like manual edits or chat actions).
 */
import * as State from './state.js';

let _autoLayout = null;

// ─── HELPERS ─────────────────────────────────────────

function findOrCreateNPC(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const npcs = State.getState().npcs || [];
  let npc = npcs.find((n) => n.name.toLowerCase() === clean.toLowerCase());
  if (!npc) npc = State.addNPC(clean);
  return npc;
}

function findOrCreateQuest(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const quests = State.getState().quests || [];
  let quest = quests.find((q) => q.name.toLowerCase() === clean.toLowerCase());
  if (!quest) quest = State.addQuest(clean);
  return quest;
}

function requireActiveDialogue() {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No active dialogue. Use create_dialogue or set_active_dialogue first.');
  return dlg;
}

function requireNode(dlg, nodeId) {
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found in active dialogue: ${nodeId}`);
  return node;
}

function serializeDialogue(dlg) {
  return {
    id: dlg.id,
    title: dlg.title,
    npc: dlg.npcId ? (State.getNPC(dlg.npcId)?.name || null) : null,
    startNodeId: dlg.startNodeId,
    nodeCount: dlg.nodes.length,
    nodes: dlg.nodes.map((n) => ({
      id: n.id,
      npc: n.npcId ? (State.getNPC(n.npcId)?.name || null) : null,
      text_es: n.text?.es || '',
      text_en: n.text?.en || '',
      isStart: n.id === dlg.startNodeId,
      condition: n.condition || '',
      action: n.action || '',
      connections: (n.connections || []).map((c) => {
        const conn = State.normalizeConnection(c);
        return { targetId: conn.targetId, label: conn.label || '' };
      }),
    })),
  };
}

// Auto-position new nodes below existing ones (same heuristic as the chat executor)
function nextNodePosition(dlg) {
  let baseY = 120;
  if (dlg.nodes.length > 0) {
    baseY = Math.max(...dlg.nodes.map((n) => (n.y || 0) + (n.height || 160))) + 80;
  }
  return { x: 300, y: baseY };
}

// ─── TOOL IMPLEMENTATIONS ────────────────────────────

const tools = {
  get_project_summary() {
    const state = State.getState();
    const activeId = State.getActiveDialogueId();
    return {
      npcs: (state.npcs || []).map((n) => ({ id: n.id, name: n.name, color: n.color || null })),
      quests: (state.quests || []).map((q) => ({ id: q.id, name: q.name })),
      dialogues: (state.dialogues || []).map((d) => ({
        id: d.id,
        title: d.title,
        npc: d.npcId ? (State.getNPC(d.npcId)?.name || null) : null,
        nodeCount: d.nodes.length,
        isActive: d.id === activeId,
      })),
      currentFile: State.getCurrentFilePath() || null,
    };
  },

  get_dialogue({ dialogue_id }) {
    let dlg;
    if (dialogue_id) {
      dlg = (State.getState().dialogues || []).find((d) => d.id === dialogue_id);
      if (!dlg) throw new Error(`Dialogue not found: ${dialogue_id}`);
    } else {
      dlg = requireActiveDialogue();
    }
    return serializeDialogue(dlg);
  },

  create_dialogue({ title, npc_name, quest_name }) {
    if (!title || !title.trim()) throw new Error('title is required');
    State.startBatch();
    const npc = npc_name ? findOrCreateNPC(npc_name) : null;
    const quest = quest_name ? findOrCreateQuest(quest_name) : null;
    const dlg = State.addDialogue(title.trim(), npc?.id || null, quest?.id || null);
    State.endBatch();
    return {
      dialogueId: dlg.id,
      startNodeId: dlg.startNodeId,
      note: 'Dialogue created with one empty start node; it is now active. Use update_node to fill the start node.',
    };
  },

  set_active_dialogue({ dialogue_id }) {
    const dlg = (State.getState().dialogues || []).find((d) => d.id === dialogue_id);
    if (!dlg) throw new Error(`Dialogue not found: ${dialogue_id}`);
    State.setActiveDialogueId(dialogue_id);
    return { activeDialogueId: dialogue_id, title: dlg.title };
  },

  add_node({ text_es, text_en, npc_name, x, y }) {
    const dlg = requireActiveDialogue();
    State.startBatch();
    try {
      const pos = nextNodePosition(dlg);
      const node = State.addNode(x !== undefined ? x : pos.x, y !== undefined ? y : pos.y);
      if (!node) throw new Error('Could not create node');
      State.updateNodeText(node.id, { es: text_es || '', en: text_en || '' });
      if (npc_name) {
        const npc = findOrCreateNPC(npc_name);
        if (npc) State.updateNodeNPC(node.id, npc.id);
      }
      return { nodeId: node.id };
    } finally {
      State.endBatch();
    }
  },

  update_node({ node_id, text_es, text_en, npc_name }) {
    const dlg = requireActiveDialogue();
    const node = requireNode(dlg, node_id);
    State.startBatch();
    try {
      if (text_es !== undefined || text_en !== undefined) {
        State.updateNodeText(node_id, {
          es: text_es !== undefined ? text_es : (node.text?.es || ''),
          en: text_en !== undefined ? text_en : (node.text?.en || ''),
        });
      }
      if (npc_name) {
        const npc = findOrCreateNPC(npc_name);
        if (npc) State.updateNodeNPC(node_id, npc.id);
      }
      return { nodeId: node_id, updated: true };
    } finally {
      State.endBatch();
    }
  },

  connect_nodes({ source_id, target_id, label }) {
    const dlg = requireActiveDialogue();
    requireNode(dlg, source_id);
    requireNode(dlg, target_id);
    if (source_id === target_id) throw new Error('Cannot connect a node to itself');
    State.startBatch();
    try {
      State.addConnection(source_id, target_id);
      if (label) State.updateConnectionLabel(source_id, target_id, label);
      return { connected: `${source_id} → ${target_id}`, label: label || '' };
    } finally {
      State.endBatch();
    }
  },

  delete_node({ node_id }) {
    const dlg = requireActiveDialogue();
    requireNode(dlg, node_id);
    State.deleteNode(node_id);
    return { deleted: node_id };
  },

  set_start_node({ node_id }) {
    const dlg = requireActiveDialogue();
    requireNode(dlg, node_id);
    State.setStartNode(node_id);
    return { startNodeId: node_id };
  },

  create_npc({ name, color }) {
    if (!name || !name.trim()) throw new Error('name is required');
    const existing = (State.getState().npcs || [])
      .find((n) => n.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) return { npcId: existing.id, name: existing.name, alreadyExisted: true };
    State.startBatch();
    const npc = State.addNPC(name.trim());
    if (npc && color) State.updateNPCColor(npc.id, color);
    State.endBatch();
    return { npcId: npc.id, name: npc.name, alreadyExisted: false };
  },

  auto_layout() {
    requireActiveDialogue();
    if (!_autoLayout) throw new Error('Auto-layout is not available');
    _autoLayout();
    return { done: true };
  },
};

// ─── SETUP ───────────────────────────────────────────

export function setup(autoLayoutFn) {
  _autoLayout = autoLayoutFn;

  window.__mcpExecute = async (toolName, args) => {
    const impl = tools[toolName];
    if (!impl) return { ok: false, error: `Unknown tool: ${toolName}` };
    try {
      const result = await impl(args || {});
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

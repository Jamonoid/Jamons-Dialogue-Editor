/**
 * MCP bridge — renderer-side executor for the MCP tools exposed by
 * electron/mcp-server.js. The Electron main process calls
 * window.__mcpExecute(tool, args) via executeJavaScript; each tool runs
 * against the live State (canvas re-renders, undo/redo and persistence
 * behave exactly like manual edits or chat actions).
 *
 * Every edit tool accepts an optional dialogue_id; when omitted it targets
 * the active dialogue. Edits on non-active dialogues mutate state directly
 * (inside a batch) without touching the canvas camera or selection.
 *
 * The graph/validation/clear helpers are exported so the in-app chat
 * executor (chat.js) can reuse the exact same logic.
 */
import * as State from './state.js';
import { uid } from '../utils/helpers.js';

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

/** Explicit dialogue_id wins; otherwise the active dialogue. Throws with a clear message. */
export function resolveDialogue(dialogueId) {
  if (dialogueId) {
    const dlg = (State.getState().dialogues || []).find((d) => d.id === dialogueId);
    if (!dlg) throw new Error(`Dialogue not found: ${dialogueId}`);
    return dlg;
  }
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No active dialogue. Pass dialogue_id, or use create_dialogue / set_active_dialogue first.');
  return dlg;
}

function requireNode(dlg, nodeId) {
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found in dialogue "${dlg.title}" (${dlg.id}): ${nodeId}`);
  return node;
}

function makeNode(x, y) {
  return {
    id: uid(),
    text: { es: '', en: '' },
    x,
    y,
    width: 240,
    height: null,
    npcId: null,
    connections: [],
    condition: '',
    action: '',
  };
}

/** Add or relabel a connection source → target (direct mutation; call inside a batch). */
function upsertConnection(dlg, sourceId, targetId, label) {
  if (sourceId === targetId) throw new Error('Cannot connect a node to itself');
  const source = requireNode(dlg, sourceId);
  requireNode(dlg, targetId);
  source.connections = (source.connections || []).map(State.normalizeConnection);
  let conn = source.connections.find((c) => c.targetId === targetId);
  if (!conn) {
    conn = { targetId, label: '' };
    source.connections.push(conn);
  }
  if (label !== undefined && label !== null) conn.label = label;
  return conn;
}

/** Remove a node and every connection pointing at it (direct mutation; call inside a batch). */
function removeNodeFrom(dlg, nodeId) {
  requireNode(dlg, nodeId);
  dlg.nodes.forEach((n) => {
    n.connections = (n.connections || [])
      .map(State.normalizeConnection)
      .filter((c) => c.targetId !== nodeId);
  });
  if (dlg.startNodeId === nodeId) {
    const remaining = dlg.nodes.filter((n) => n.id !== nodeId);
    dlg.startNodeId = remaining.length > 0 ? remaining[0].id : null;
  }
  dlg.nodes = dlg.nodes.filter((n) => n.id !== nodeId);
  if (dlg.id === State.getActiveDialogueId() && State.isNodeSelected(nodeId)) {
    State.toggleNodeSelection(nodeId);
  }
}

/** Wipe all nodes, leaving one empty start node (direct mutation; call inside a batch). */
export function clearDialogueContent(dlg) {
  if (dlg.id === State.getActiveDialogueId()) State.clearSelection();
  // Locked nodes (🔒) survive AI clears — only unlocked content is removed
  const kept = dlg.nodes.filter((n) => n.locked);
  if (kept.length > 0) {
    const keptIds = new Set(kept.map((n) => n.id));
    kept.forEach((n) => {
      n.connections = (n.connections || [])
        .map(State.normalizeConnection)
        .filter((c) => keptIds.has(c.targetId));
    });
    dlg.nodes = kept;
    dlg.startNodeId = keptIds.has(dlg.startNodeId) ? dlg.startNodeId : kept[0].id;
    return dlg.startNodeId;
  }
  const start = makeNode(300, 100);
  dlg.nodes = [start];
  dlg.startNodeId = start.id;
  return start.id;
}

// Auto-position new nodes below existing ones (same heuristic as the chat executor)
function nextNodePosition(dlg) {
  let baseY = 120;
  if (dlg.nodes.length > 0) {
    baseY = Math.max(...dlg.nodes.map((n) => (n.y || 0) + (n.height || 160))) + 80;
  }
  return { x: 300, y: baseY };
}

/**
 * Simple layered BFS layout: levels go down, siblings spread horizontally.
 * Used when writing whole graphs (deterministic, works on non-active dialogues).
 * The canvas auto-layout (parent-centered) is still used by the auto_layout
 * tool when the target is the active dialogue.
 */
export function layoutTree(dlg) {
  if (!dlg.nodes.length) return;
  const byId = new Map(dlg.nodes.map((n) => [n.id, n]));
  const startId = dlg.startNodeId && byId.has(dlg.startNodeId) ? dlg.startNodeId : dlg.nodes[0].id;
  const levels = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    (byId.get(id).connections || []).forEach((c) => {
      const t = State.normalizeConnection(c).targetId;
      if (byId.has(t) && !levels.has(t)) {
        levels.set(t, levels.get(id) + 1);
        queue.push(t);
      }
    });
  }
  let maxLvl = 0;
  levels.forEach((l) => { if (l > maxLvl) maxLvl = l; });
  dlg.nodes.forEach((n) => { if (!levels.has(n.id)) levels.set(n.id, maxLvl + 1); });

  const rows = new Map();
  dlg.nodes.forEach((n) => {
    const lvl = levels.get(n.id);
    if (!rows.has(lvl)) rows.set(lvl, []);
    rows.get(lvl).push(n);
  });
  rows.forEach((rowNodes, lvl) => {
    rowNodes.forEach((n, i) => {
      n.x = 400 + (i - (rowNodes.length - 1) / 2) * 340;
      n.y = 80 + lvl * 260;
    });
  });
}

// ─── SERIALIZATION ───────────────────────────────────

function npcName(npcId) {
  return npcId ? (State.getNPC(npcId)?.name || null) : null;
}

function serializeFull(dlg) {
  return {
    id: dlg.id,
    title: dlg.title,
    npc: npcName(dlg.npcId),
    comment: dlg.comment || null,
    startNodeId: dlg.startNodeId,
    nodeCount: dlg.nodes.length,
    nodes: dlg.nodes.map((n) => ({
      id: n.id,
      npc: npcName(n.npcId),
      text_es: n.text?.es || '',
      text_en: n.text?.en || '',
      isStart: n.id === dlg.startNodeId,
      locked: !!n.locked,
      condition: n.condition || '',
      action: n.action || '',
      connections: (n.connections || []).map((c) => {
        const conn = State.normalizeConnection(c);
        return { targetId: conn.targetId, label: conn.label || '' };
      }),
    })),
  };
}

function collectEdges(dlg) {
  const edges = [];
  dlg.nodes.forEach((n) => {
    (n.connections || []).forEach((c) => {
      const conn = State.normalizeConnection(c);
      edges.push(conn.label ? [n.id, conn.targetId, conn.label] : [n.id, conn.targetId]);
    });
  });
  return edges;
}

/** Token-lean shape: empty fields omitted, connections as an edge list. */
function serializeCompact(dlg) {
  const out = {
    id: dlg.id,
    title: dlg.title,
    npc: npcName(dlg.npcId),
    start: dlg.startNodeId,
    nodes: dlg.nodes.map((n) => {
      const node = { id: n.id, es: n.text?.es || '' };
      const npc = npcName(n.npcId);
      if (npc) node.npc = npc;
      if (n.text?.en) node.en = n.text.en;
      if (n.condition) node.if = n.condition;
      if (n.action) node.do = n.action;
      if (n.locked) node.locked = true;
      return node;
    }),
    edges: collectEdges(dlg),
  };
  if (dlg.comment) out.comment = dlg.comment;
  return out;
}

/** Structure only — ids, speakers and edges. No text. */
function serializeStructure(dlg) {
  return {
    id: dlg.id,
    title: dlg.title,
    start: dlg.startNodeId,
    nodeCount: dlg.nodes.length,
    nodes: dlg.nodes.map((n) => {
      const node = { id: n.id };
      const npc = npcName(n.npcId);
      if (npc) node.npc = npc;
      return node;
    }),
    edges: collectEdges(dlg),
  };
}

// ─── GRAPH WRITER (shared with chat.js) ──────────────

/**
 * Write a whole dialogue tree in one call. Payload:
 * {
 *   title?, npc_name?/npc?, quest_name?/quest?, comment?,  // title → create new dialogue (activates it)
 *   dialogue_id?,                     // target existing dialogue (default: active). Ignored when title is given.
 *   mode?: 'replace' | 'append',      // default 'replace' — clears existing nodes first
 *   nodes: [{ id, text_es?, text_en?, npc?, condition?, action? }],   // id = caller's temp id
 *   connections?: [{ from, to, label? }],   // temp ids, or real node ids in append mode
 *   start?: tempId | realId
 * }
 * Validates everything up front (atomic: throws before mutating on bad payloads),
 * maps temp ids → real ids and lays out the tree. Returns { dialogueId, idMap, ... }.
 */
export function writeDialogueGraph(payload = {}) {
  const {
    title, comment, dialogue_id, start,
    nodes = [], connections = [],
  } = payload;
  const npcNameArg = payload.npc_name ?? payload.npc;
  const questNameArg = payload.quest_name ?? payload.quest;
  const mode = payload.mode === 'append' ? 'append' : 'replace';
  const creating = !!(title && String(title).trim());

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('nodes must be a non-empty array');
  }
  const tempIds = new Set();
  nodes.forEach((spec) => {
    if (!spec || typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new Error('Every node needs a string id (a temp id like "n1")');
    }
    if (tempIds.has(spec.id)) throw new Error(`Duplicate node id in payload: ${spec.id}`);
    tempIds.add(spec.id);
  });

  // Resolve target and validate references BEFORE mutating anything.
  // Locked nodes (🔒) survive a replace, so their real ids stay referenceable
  // (and collide-checked) just like existing ids do in append mode.
  const target = creating ? null : resolveDialogue(dialogue_id);
  const isAppend = !creating && mode === 'append';
  const existingIds = new Set(
    isAppend ? target.nodes.map((n) => n.id)
      : target ? target.nodes.filter((n) => n.locked).map((n) => n.id)
      : []
  );
  tempIds.forEach((id) => {
    if (existingIds.has(id)) throw new Error(`Node id collides with an existing node: ${id}. Use fresh temp ids.`);
  });
  const known = (id) => tempIds.has(id) || existingIds.has(id);
  (connections || []).forEach((e) => {
    if (!e || !e.from || !e.to) throw new Error('Each connection needs { from, to }');
    if (!known(e.from)) throw new Error(`Connection references unknown node: ${e.from}`);
    if (!known(e.to)) throw new Error(`Connection references unknown node: ${e.to}`);
    if (e.from === e.to) throw new Error(`Cannot connect a node to itself: ${e.from}`);
  });
  if (start && !known(start)) throw new Error(`start references unknown node: ${start}`);

  State.startBatch();
  try {
    let dlg = target;
    let preservedLocked = 0;
    if (creating) {
      const npc = npcNameArg ? findOrCreateNPC(npcNameArg) : null;
      const quest = questNameArg ? findOrCreateQuest(questNameArg) : null;
      dlg = State.addDialogue(String(title).trim(), npc?.id || null, quest?.id || null);
      if (comment && String(comment).trim()) State.updateDialogue(dlg.id, { comment: String(comment).trim() });
      dlg.nodes = []; // drop the auto-created empty start node — the graph brings its own
      dlg.startNodeId = null;
    } else if (mode === 'replace') {
      if (dlg.id === State.getActiveDialogueId()) State.clearSelection();
      // Locked nodes survive; their connections to removed nodes are pruned
      const kept = dlg.nodes.filter((n) => n.locked);
      const keptIds = new Set(kept.map((n) => n.id));
      kept.forEach((n) => {
        n.connections = (n.connections || [])
          .map(State.normalizeConnection)
          .filter((c) => keptIds.has(c.targetId));
      });
      dlg.nodes = kept;
      dlg.startNodeId = null;
      preservedLocked = kept.length;
    }

    const idMap = {};
    const base = isAppend ? nextNodePosition(dlg) : { x: 300, y: 100 };
    nodes.forEach((spec, i) => {
      const node = makeNode(base.x + (i % 3) * 300, base.y + Math.floor(i / 3) * 210);
      node.text = { es: spec.text_es || '', en: spec.text_en || '' };
      node.condition = spec.condition || '';
      node.action = spec.action || '';
      const speaker = spec.npc ?? spec.npc_name;
      if (speaker && String(speaker).trim()) {
        const npc = findOrCreateNPC(String(speaker));
        if (npc) node.npcId = npc.id;
      }
      dlg.nodes.push(node);
      idMap[spec.id] = node.id;
    });

    const real = (id) => idMap[id] || id;
    (connections || []).forEach((e) => upsertConnection(dlg, real(e.from), real(e.to), e.label));

    if (start) dlg.startNodeId = real(start);
    else if (!dlg.startNodeId) dlg.startNodeId = real(nodes[0].id);

    if (!isAppend) layoutTree(dlg);

    const result = {
      dialogueId: dlg.id,
      created: creating,
      mode: creating ? 'create' : mode,
      nodeCount: dlg.nodes.length,
      startNodeId: dlg.startNodeId,
      idMap,
    };
    if (preservedLocked > 0) {
      result.preservedLockedNodes = preservedLocked;
      result.note = `${preservedLocked} locked node(s) (🔒) were preserved — they are protected from AI rewrites.`;
    }
    return result;
  } finally {
    State.endBatch();
  }
}

// ─── VALIDATION (shared with chat.js) ────────────────

/**
 * Cheap structural check of a dialogue tree. Reports (only non-empty keys):
 * unreachable nodes, connections to missing nodes, nodes with empty ES/EN text,
 * and endings (no outgoing connections — informational, they may be intentional).
 */
export function buildValidationReport(dlg) {
  const ids = new Set(dlg.nodes.map((n) => n.id));
  const hasStart = !!(dlg.startNodeId && ids.has(dlg.startNodeId));

  const brokenConnections = [];
  const adjacency = new Map();
  dlg.nodes.forEach((n) => {
    const targets = [];
    (n.connections || []).forEach((c) => {
      const conn = State.normalizeConnection(c);
      if (ids.has(conn.targetId)) targets.push(conn.targetId);
      else brokenConnections.push({ from: n.id, to: conn.targetId });
    });
    adjacency.set(n.id, targets);
  });

  const reachable = new Set();
  if (hasStart) {
    const queue = [dlg.startNodeId];
    reachable.add(dlg.startNodeId);
    while (queue.length) {
      const id = queue.shift();
      (adjacency.get(id) || []).forEach((t) => {
        if (!reachable.has(t)) { reachable.add(t); queue.push(t); }
      });
    }
  }

  const unreachable = dlg.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  const missingTextEs = dlg.nodes.filter((n) => !(n.text?.es || '').trim()).map((n) => n.id);
  const missingTextEn = dlg.nodes.filter((n) => !(n.text?.en || '').trim()).map((n) => n.id);
  const endings = dlg.nodes.filter((n) => (adjacency.get(n.id) || []).length === 0).map((n) => n.id);

  const report = {
    dialogueId: dlg.id,
    title: dlg.title,
    nodeCount: dlg.nodes.length,
    edgeCount: collectEdges(dlg).length,
    ok: hasStart && unreachable.length === 0 && brokenConnections.length === 0,
  };
  if (!hasStart) report.noStartNode = true;
  if (unreachable.length) report.unreachable = unreachable;
  if (brokenConnections.length) report.brokenConnections = brokenConnections;
  if (missingTextEs.length) report.missingTextEs = missingTextEs;
  if (missingTextEn.length) report.missingTextEn = missingTextEn;
  if (endings.length) report.endings = endings;
  return report;
}

// ─── TOOL IMPLEMENTATIONS ────────────────────────────

const tools = {
  get_project_summary() {
    const state = State.getState();
    const activeId = State.getActiveDialogueId();
    return {
      npcs: (state.npcs || []).map((n) => ({ id: n.id, name: n.name, color: n.color || null, comment: n.comment || null })),
      quests: (state.quests || []).map((q) => ({
        id: q.id,
        name: q.name,
        comment: q.comment || null,
        relatedNpcs: (q.npcIds || []).map(npcName).filter(Boolean),
      })),
      dialogues: (state.dialogues || []).map((d) => ({
        id: d.id,
        title: d.title,
        npc: npcName(d.npcId),
        comment: d.comment || null,
        nodeCount: d.nodes.length,
        isActive: d.id === activeId,
      })),
      storyMap: { nodeCount: (State.getStory().nodes || []).length, hint: 'Read the full graph with get_story_map' },
      currentFile: State.getCurrentFilePath() || null,
    };
  },

  get_story_map() {
    const state = State.getState();
    const story = State.getStory();
    const questById = new Map((state.quests || []).map((q) => [q.id, q]));

    const nodes = story.nodes.map((n) => {
      const q = n.questId ? questById.get(n.questId) : null;
      const item = { id: n.id, quest: q ? q.name : null };
      if (n.text?.es) item.es = n.text.es;
      if (n.text?.en) item.en = n.text.en;
      return item;
    });

    // Edges as [from, to, condition?] — the label on the arrow is the condition
    // for the target quest/step to start.
    const edges = [];
    story.nodes.forEach((n) => {
      (n.connections || []).forEach((c) => {
        const { targetId, label } = State.normalizeConnection(c);
        edges.push(label ? [n.id, targetId, label] : [n.id, targetId]);
      });
    });

    // Relacionados per quest referenced in the map (shared across nodes of the same quest)
    const quests = {};
    const usedQuestIds = [...new Set(story.nodes.map((n) => n.questId).filter(Boolean))];
    usedQuestIds.forEach((qid) => {
      const q = questById.get(qid);
      if (!q) return;
      quests[q.name] = {
        id: q.id,
        comment: q.comment || null,
        relatedNpcs: (q.npcIds || []).map(npcName).filter(Boolean),
        relatedDialogues: (state.dialogues || [])
          .filter((d) => d.questId === qid)
          .map((d) => ({ id: d.id, title: d.title })),
      };
    });

    return { start: story.startNodeId, nodes, edges, quests };
  },

  get_dialogue({ dialogue_id, format } = {}) {
    const dlg = resolveDialogue(dialogue_id);
    if (format === 'full') return serializeFull(dlg);
    if (format === 'structure') return serializeStructure(dlg);
    return serializeCompact(dlg);
  },

  create_dialogue({ title, npc_name, quest_name, comment }) {
    if (!title || !title.trim()) throw new Error('title is required');
    State.startBatch();
    try {
      const npc = npc_name ? findOrCreateNPC(npc_name) : null;
      const quest = quest_name ? findOrCreateQuest(quest_name) : null;
      const dlg = State.addDialogue(title.trim(), npc?.id || null, quest?.id || null);
      if (comment && comment.trim()) State.updateDialogue(dlg.id, { comment: comment.trim() });
      return {
        dialogueId: dlg.id,
        startNodeId: dlg.startNodeId,
        note: 'Dialogue created with one empty start node; it is now active. Tip: write_dialogue_graph can create the dialogue AND its whole tree in one call.',
      };
    } finally {
      State.endBatch();
    }
  },

  update_dialogue({ dialogue_id, title, npc_name, quest_name, comment }) {
    const dlg = resolveDialogue(dialogue_id);
    State.startBatch();
    try {
      const updates = {};
      if (title !== undefined && String(title).trim()) updates.title = String(title).trim();
      if (npc_name !== undefined) updates.npcId = npc_name ? (findOrCreateNPC(npc_name)?.id || null) : null;
      if (quest_name !== undefined) updates.questId = quest_name ? (findOrCreateQuest(quest_name)?.id || null) : null;
      if (comment !== undefined) updates.comment = comment;
      if (Object.keys(updates).length === 0) throw new Error('Nothing to update — pass title, npc_name, quest_name and/or comment');
      State.updateDialogue(dlg.id, updates);
      return { dialogueId: dlg.id, updated: Object.keys(updates) };
    } finally {
      State.endBatch();
    }
  },

  delete_dialogue({ dialogue_id }) {
    if (!dialogue_id) throw new Error('dialogue_id is required (no active-dialogue default for deletion)');
    const dlg = (State.getState().dialogues || []).find((d) => d.id === dialogue_id);
    if (!dlg) throw new Error(`Dialogue not found: ${dialogue_id}`);
    const title = dlg.title;
    State.deleteDialogue(dialogue_id);
    return { deleted: dialogue_id, title };
  },

  clear_dialogue({ dialogue_id } = {}) {
    const dlg = resolveDialogue(dialogue_id);
    State.startBatch();
    try {
      const removed = dlg.nodes.length;
      const startNodeId = clearDialogueContent(dlg);
      return { dialogueId: dlg.id, removedNodes: removed, startNodeId, note: 'One empty start node remains.' };
    } finally {
      State.endBatch();
    }
  },

  set_active_dialogue({ dialogue_id }) {
    const dlg = (State.getState().dialogues || []).find((d) => d.id === dialogue_id);
    if (!dlg) throw new Error(`Dialogue not found: ${dialogue_id}`);
    State.setActiveDialogueId(dialogue_id);
    State.notifyChange();
    return { activeDialogueId: dialogue_id, title: dlg.title };
  },

  write_dialogue_graph(args) {
    return writeDialogueGraph(args || {});
  },

  add_node({ text_es, text_en, npc_name, condition, action, x, y, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    State.startBatch();
    try {
      const pos = nextNodePosition(dlg);
      const node = makeNode(x !== undefined ? x : pos.x, y !== undefined ? y : pos.y);
      node.text = { es: text_es || '', en: text_en || '' };
      node.condition = condition || '';
      node.action = action || '';
      if (npc_name) {
        const npc = findOrCreateNPC(npc_name);
        if (npc) node.npcId = npc.id;
      }
      dlg.nodes.push(node);
      return { nodeId: node.id, dialogueId: dlg.id };
    } finally {
      State.endBatch();
    }
  },

  update_node({ node_id, text_es, text_en, npc_name, condition, action, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    const node = requireNode(dlg, node_id);
    if (node.locked) throw new Error(`Node ${node_id} is locked (🔒) — the author protected it from AI edits. Ask them to unlock it in the editor if the change is needed.`);
    State.startBatch();
    try {
      if (text_es !== undefined || text_en !== undefined) {
        node.text = {
          es: text_es !== undefined ? text_es : (node.text?.es || ''),
          en: text_en !== undefined ? text_en : (node.text?.en || ''),
        };
      }
      if (condition !== undefined) node.condition = condition;
      if (action !== undefined) node.action = action;
      if (npc_name) {
        const npc = findOrCreateNPC(npc_name);
        if (npc) node.npcId = npc.id;
      }
      return { nodeId: node_id, updated: true };
    } finally {
      State.endBatch();
    }
  },

  connect_nodes({ source_id, target_id, label, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    State.startBatch();
    try {
      upsertConnection(dlg, source_id, target_id, label);
      return { connected: `${source_id} → ${target_id}`, label: label || '' };
    } finally {
      State.endBatch();
    }
  },

  disconnect_nodes({ source_id, target_id, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    const source = requireNode(dlg, source_id);
    State.startBatch();
    try {
      const before = (source.connections || []).length;
      source.connections = (source.connections || [])
        .map(State.normalizeConnection)
        .filter((c) => c.targetId !== target_id);
      if (source.connections.length === before) {
        throw new Error(`No connection ${source_id} → ${target_id} to remove`);
      }
      return { disconnected: `${source_id} → ${target_id}` };
    } finally {
      State.endBatch();
    }
  },

  delete_node({ node_id, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    const node = requireNode(dlg, node_id);
    if (node.locked) throw new Error(`Node ${node_id} is locked (🔒) — the author protected it from AI deletion. Ask them to unlock it in the editor if removal is needed.`);
    State.startBatch();
    try {
      removeNodeFrom(dlg, node_id);
      return { deleted: node_id };
    } finally {
      State.endBatch();
    }
  },

  set_start_node({ node_id, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    requireNode(dlg, node_id);
    State.startBatch();
    try {
      dlg.startNodeId = node_id;
      return { startNodeId: node_id };
    } finally {
      State.endBatch();
    }
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

  auto_layout({ dialogue_id } = {}) {
    const dlg = resolveDialogue(dialogue_id);
    if (dlg.id === State.getActiveDialogueId() && _autoLayout) {
      _autoLayout();
    } else {
      State.startBatch();
      try { layoutTree(dlg); } finally { State.endBatch(); }
    }
    return { done: true, dialogueId: dlg.id };
  },

  validate_dialogue({ dialogue_id } = {}) {
    const dlg = resolveDialogue(dialogue_id);
    return buildValidationReport(dlg);
  },

  set_comment({ type, id, comment }) {
    const text = (comment || '').trim();
    const state = State.getState();
    if (type === 'npc') {
      const npc = (state.npcs || []).find((n) => n.id === id);
      if (!npc) throw new Error(`NPC not found: ${id}`);
      State.updateNPCComment(id, text);
    } else if (type === 'quest') {
      const quest = (state.quests || []).find((q) => q.id === id);
      if (!quest) throw new Error(`Quest not found: ${id}`);
      State.updateQuestComment(id, text);
    } else if (type === 'dialogue') {
      const dlg = (state.dialogues || []).find((d) => d.id === id);
      if (!dlg) throw new Error(`Dialogue not found: ${id}`);
      State.updateDialogue(id, { comment: text });
    } else {
      throw new Error(`Invalid type: ${type}. Use 'npc', 'quest' or 'dialogue'.`);
    }
    State.notifyChange();
    return { type, id, comment: text };
  },

  // ─── STORY MAP TOOLS ───────────────────────────────
  // All of these mutate State.getStory() directly (inside a batch), so they
  // work regardless of the current view; the canvas re-renders if the story
  // view is open. Edges carry the CONDITION for the next quest/step to start.

  write_story_map({ mode, nodes = [], connections = [], start } = {}) {
    const story = State.getStory();
    const isAppend = mode === 'append';

    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('nodes must be a non-empty array');
    }
    const tempIds = new Set();
    nodes.forEach((spec) => {
      if (!spec || typeof spec.id !== 'string' || !spec.id.trim()) {
        throw new Error('Every node needs a string id (a temp id like "n1")');
      }
      if (tempIds.has(spec.id)) throw new Error(`Duplicate node id in payload: ${spec.id}`);
      tempIds.add(spec.id);
    });
    const existingIds = new Set(isAppend ? story.nodes.map((n) => n.id) : []);
    tempIds.forEach((id) => {
      if (existingIds.has(id)) throw new Error(`Node id collides with an existing story node: ${id}. Use fresh temp ids.`);
    });
    const known = (id) => tempIds.has(id) || existingIds.has(id);
    (connections || []).forEach((e) => {
      if (!e || !e.from || !e.to) throw new Error('Each connection needs { from, to }');
      if (!known(e.from)) throw new Error(`Connection references unknown node: ${e.from}`);
      if (!known(e.to)) throw new Error(`Connection references unknown node: ${e.to}`);
      if (e.from === e.to) throw new Error(`Cannot connect a node to itself: ${e.from}`);
    });
    if (start && !known(start)) throw new Error(`start references unknown node: ${start}`);

    State.startBatch();
    try {
      if (!isAppend) {
        if (State.getViewMode() === 'story') State.clearSelection();
        story.nodes = [];
        story.startNodeId = null;
      }
      const idMap = {};
      const base = isAppend ? nextNodePosition(story) : { x: 300, y: 100 };
      nodes.forEach((spec, i) => {
        const node = makeNode(base.x + (i % 3) * 380, base.y + Math.floor(i / 3) * 230);
        node.width = 320;
        node.questId = spec.quest ? (findOrCreateQuest(spec.quest)?.id || null) : null;
        node.text = { es: spec.text_es || '', en: spec.text_en || '' };
        story.nodes.push(node);
        idMap[spec.id] = node.id;
      });
      const real = (id) => idMap[id] || id;
      (connections || []).forEach((e) => upsertConnection(story, real(e.from), real(e.to), e.condition ?? e.label));
      if (start) story.startNodeId = real(start);
      else if (!story.startNodeId) story.startNodeId = real(nodes[0].id);
      if (!isAppend) layoutTree(story);
      return { mode: isAppend ? 'append' : 'replace', nodeCount: story.nodes.length, startNodeId: story.startNodeId, idMap };
    } finally {
      State.endBatch();
    }
  },

  add_story_node({ quest, text_es, text_en, x, y } = {}) {
    const story = State.getStory();
    State.startBatch();
    try {
      const pos = nextNodePosition(story);
      const node = makeNode(x !== undefined ? x : pos.x, y !== undefined ? y : pos.y);
      node.width = 320;
      node.questId = quest ? (findOrCreateQuest(quest)?.id || null) : null;
      node.text = { es: text_es || '', en: text_en || '' };
      story.nodes.push(node);
      if (!story.startNodeId) story.startNodeId = node.id;
      return { nodeId: node.id, quest: quest || null };
    } finally {
      State.endBatch();
    }
  },

  update_story_node({ node_id, quest, text_es, text_en }) {
    const story = State.getStory();
    const node = requireNode(story, node_id);
    State.startBatch();
    try {
      if (quest !== undefined) node.questId = quest ? (findOrCreateQuest(quest)?.id || null) : null;
      if (text_es !== undefined || text_en !== undefined) {
        node.text = {
          es: text_es !== undefined ? text_es : (node.text?.es || ''),
          en: text_en !== undefined ? text_en : (node.text?.en || ''),
        };
      }
      return { nodeId: node_id, updated: true };
    } finally {
      State.endBatch();
    }
  },

  delete_story_node({ node_id }) {
    const story = State.getStory();
    requireNode(story, node_id);
    State.startBatch();
    try {
      if (State.getViewMode() === 'story' && State.isNodeSelected(node_id)) State.toggleNodeSelection(node_id);
      removeNodeFrom(story, node_id);
      return { deleted: node_id };
    } finally {
      State.endBatch();
    }
  },

  connect_story_nodes({ from, to, condition }) {
    const story = State.getStory();
    State.startBatch();
    try {
      upsertConnection(story, from, to, condition);
      return { connected: `${from} → ${to}`, condition: condition || '' };
    } finally {
      State.endBatch();
    }
  },

  disconnect_story_nodes({ from, to }) {
    const story = State.getStory();
    const source = requireNode(story, from);
    State.startBatch();
    try {
      const before = (source.connections || []).length;
      source.connections = (source.connections || [])
        .map(State.normalizeConnection)
        .filter((c) => c.targetId !== to);
      if (source.connections.length === before) {
        throw new Error(`No connection ${from} → ${to} to remove`);
      }
      return { disconnected: `${from} → ${to}` };
    } finally {
      State.endBatch();
    }
  },

  set_story_start({ node_id }) {
    const story = State.getStory();
    requireNode(story, node_id);
    State.startBatch();
    try {
      story.startNodeId = node_id;
      return { startNodeId: node_id };
    } finally {
      State.endBatch();
    }
  },

  validate_story() {
    const story = State.getStory();
    const report = buildValidationReport(story);
    delete report.dialogueId;
    delete report.title;
    // Story-specific checks (informational — they don't flip ok)
    const withoutQuest = story.nodes.filter((n) => !n.questId).map((n) => n.id);
    if (withoutQuest.length) report.nodesWithoutQuest = withoutQuest;
    const unlabeled = [];
    story.nodes.forEach((n) => {
      (n.connections || []).forEach((c) => {
        const conn = State.normalizeConnection(c);
        if (!conn.label) unlabeled.push([n.id, conn.targetId]);
      });
    });
    if (unlabeled.length) report.edgesWithoutCondition = unlabeled;
    return report;
  },

  update_quest_relations({ quest_name, add_npcs = [], remove_npcs = [], add_dialogues = [], remove_dialogues = [] }) {
    if (!quest_name || !String(quest_name).trim()) throw new Error('quest_name is required');
    const quest = findOrCreateQuest(String(quest_name));
    const state = State.getState();
    if (!Array.isArray(quest.npcIds)) quest.npcIds = [];

    // Dialogues can be referenced by id or exact title (case-insensitive)
    const findDialogue = (ref) => {
      const dlg = (state.dialogues || []).find(
        (d) => d.id === ref || d.title.toLowerCase() === String(ref).toLowerCase()
      );
      if (!dlg) throw new Error(`Dialogue not found: ${ref}`);
      return dlg;
    };

    State.startBatch();
    try {
      const summary = { quest: quest.name, questId: quest.id, addedNpcs: [], removedNpcs: [], addedDialogues: [], removedDialogues: [] };
      add_npcs.forEach((name) => {
        const npc = findOrCreateNPC(name);
        if (npc && !quest.npcIds.includes(npc.id)) {
          quest.npcIds.push(npc.id);
          summary.addedNpcs.push(npc.name);
        }
      });
      remove_npcs.forEach((name) => {
        const npc = (state.npcs || []).find((n) => n.name.toLowerCase() === String(name).toLowerCase());
        if (npc && quest.npcIds.includes(npc.id)) {
          quest.npcIds = quest.npcIds.filter((id) => id !== npc.id);
          summary.removedNpcs.push(npc.name);
        }
      });
      add_dialogues.forEach((ref) => {
        const dlg = findDialogue(ref);
        State.updateDialogue(dlg.id, { questId: quest.id });
        summary.addedDialogues.push(dlg.title);
      });
      remove_dialogues.forEach((ref) => {
        const dlg = findDialogue(ref);
        if (dlg.questId === quest.id) {
          State.updateDialogue(dlg.id, { questId: null });
          summary.removedDialogues.push(dlg.title);
        }
      });
      return summary;
    } finally {
      State.endBatch();
    }
  },
};

// ─── SETUP ───────────────────────────────────────────

export function setup(autoLayoutFn) {
  _autoLayout = autoLayoutFn;

  // Tools that never go through view-dependent CRUD (reads + story-map tools,
  // which mutate state.story directly): they must not yank the user out of
  // the story map view.
  const VIEW_SAFE_TOOLS = new Set([
    'get_project_summary', 'get_dialogue', 'validate_dialogue',
    'get_story_map', 'write_story_map', 'add_story_node', 'update_story_node',
    'delete_story_node', 'connect_story_nodes', 'disconnect_story_nodes',
    'set_story_start', 'validate_story', 'update_quest_relations',
  ]);

  window.__mcpExecute = async (toolName, args) => {
    const impl = tools[toolName];
    if (!impl) return { ok: false, error: `Unknown tool: ${toolName}` };
    try {
      // Dialogue edit tools may rely on the active view (e.g. auto_layout). If
      // the story map view is open, switch back so they hit the active dialogue.
      if (!VIEW_SAFE_TOOLS.has(toolName) && State.getViewMode() === 'story') State.setViewMode('dialogue');
      const result = await impl(args || {});
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

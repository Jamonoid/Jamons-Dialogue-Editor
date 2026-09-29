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
 * Layout / comment-box tools also accept dialogue_id "story" (the story map).
 *
 * The graph/validation/clear helpers are exported so the in-app chat
 * executor (chat.js) can reuse the exact same logic.
 */
import * as State from './state.js';
import { uid } from '../utils/helpers.js';
import {
  getNodeRect, getNodesInComment, getCommentsInComment, snapshotMembership, wrapRects,
  refitComments, relayoutGraph, placeNewNodesBlock, graphBounds, findOverlaps, rectsOverlap,
  relativePosition, findFreeSpot, DEFAULT_GAP, COMMENT_COLORS, DEFAULT_COMMENT_COLOR, COMMENT_MIN,
} from './layout.js';

let _fitView = null;

const STORY_ID = 'story';
const SPACINGS = ['compact', 'normal', 'wide'];
const PLACEMENTS = ['below', 'above', 'right_of', 'left_of'];

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

/** Like resolveDialogue, but dialogue_id "story" selects the story map. */
function resolveGraph(dialogueId) {
  return dialogueId === STORY_ID ? State.getStory() : resolveDialogue(dialogueId);
}

/** How results name the graph they touched. */
function graphRef(graph) {
  return graph.id === STORY_ID ? { graph: 'story' } : { dialogueId: graph.id, title: graph.title };
}

function requireNode(dlg, nodeId) {
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) {
    const where = dlg.id === STORY_ID ? 'the story map' : `dialogue "${dlg.title}" (${dlg.id})`;
    throw new Error(`Node not found in ${where}: ${nodeId}`);
  }
  return node;
}

function requireCommentBox(graph, commentId) {
  const box = (graph.comments || []).find((c) => c.id === commentId);
  if (!box) throw new Error(`Comment box not found: ${commentId}. List them with get_layout.`);
  return box;
}

// Preset names (ES + EN) of the comment palette, or any #rgb / #rrggbb hex
const COLOR_NAMES = {
  gris: '#94a2b3', gray: '#94a2b3', grey: '#94a2b3',
  rojo: '#e06c75', red: '#e06c75',
  naranja: '#e5934a', orange: '#e5934a',
  amarillo: '#e5c07b', yellow: '#e5c07b',
  verde: '#98c379', green: '#98c379',
  azul: '#61afef', blue: '#61afef',
  violeta: '#c678dd', violet: '#c678dd', purple: '#c678dd',
};

function resolveColor(color) {
  const key = String(color).trim().toLowerCase();
  if (COLOR_NAMES[key]) return COLOR_NAMES[key];
  if (/^#[0-9a-f]{6}$/.test(key)) return key;
  if (/^#[0-9a-f]{3}$/.test(key)) return '#' + [...key.slice(1)].map((c) => c + c).join('');
  throw new Error(`Invalid color "${color}". Use a hex like #61afef or a preset: ${COMMENT_COLORS.map((c) => c.name.toLowerCase()).join(', ')}`);
}

const intRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
const boxRect = (c) => ({ x: c.x, y: c.y, w: c.width, h: c.height });

/** Re-fit the camera when the graph that just changed is the one on screen. */
function fitIfShown(graph) {
  if (_fitView && graph === State.getActiveGraph()) _fitView();
}

function checkFinite(value, label) {
  if (value !== undefined && !Number.isFinite(value)) throw new Error(`${label} must be a number`);
}

/**
 * Put `node` next to the node `refId` (below → siblings fan out to the right,
 * right_of → they stack downwards) without landing on top of another node.
 */
function placeNear(graph, node, where, refId) {
  const ref = getNodeRect(requireNode(graph, refId));
  const r = getNodeRect(node);
  const vertical = where === 'below' || where === 'above';
  const p = relativePosition(ref, r.w, r.h, where, vertical ? DEFAULT_GAP.row : DEFAULT_GAP.col);
  const free = findFreeSpot(graph, { ...r, x: p.x, y: p.y }, {
    axis: vertical ? 'x' : 'y',
    gap: vertical ? DEFAULT_GAP.col : DEFAULT_GAP.row / 2,
    excludeId: node.id,
  });
  node.x = Math.round(free.x);
  node.y = Math.round(free.y);
}

/**
 * Validate a comment_boxes payload (before mutating). Entries:
 * { id?, text?, nodes: [...], color? } — id re-targets an existing box of the
 * graph (keeping its text/color unless given), otherwise a new box is created.
 */
function validateCommentBoxSpecs(specs, known, graph) {
  if (specs === undefined || specs === null) return [];
  if (!Array.isArray(specs)) throw new Error('comment_boxes must be an array');
  const existing = new Set((graph?.comments || []).map((c) => c.id));
  const seen = new Set();
  specs.forEach((b, i) => {
    if (!b || !Array.isArray(b.nodes) || !b.nodes.length) {
      throw new Error(`comment_boxes[${i}] needs a non-empty "nodes" array`);
    }
    b.nodes.forEach((id) => {
      if (!known(id)) throw new Error(`comment_boxes[${i}] references unknown node: ${id}`);
    });
    if (b.id !== undefined) {
      if (!existing.has(b.id)) throw new Error(`comment_boxes[${i}]: no existing comment box with id ${b.id}`);
      if (seen.has(b.id)) throw new Error(`comment_boxes[${i}]: comment box ${b.id} listed twice`);
      seen.add(b.id);
    } else if (!String(b.text ?? '').trim()) {
      throw new Error(`comment_boxes[${i}] needs "text" (the title shown on the box)`);
    }
    if (b.color !== undefined) resolveColor(b.color);
  });
  return specs;
}

/** Create / re-target the boxes of a validated payload; records their members. Returns their ids. */
function applyCommentBoxSpecs(graph, specs, real, members) {
  const ids = new Set();
  if (!specs.length) return ids;
  if (!Array.isArray(graph.comments)) graph.comments = [];
  specs.forEach((b) => {
    let box = b.id !== undefined ? graph.comments.find((c) => c.id === b.id) : null;
    if (!box) {
      // Placeholder rect — refitComments wraps it around its nodes after layout
      box = { id: uid(), text: '', x: 0, y: 0, width: COMMENT_MIN.w, height: COMMENT_MIN.h, color: DEFAULT_COMMENT_COLOR };
      graph.comments.push(box);
    }
    if (String(b.text ?? '').trim()) box.text = String(b.text).trim();
    if (b.color !== undefined) box.color = resolveColor(b.color);
    members.set(box.id, new Set(b.nodes.map(real)));
    ids.add(box.id);
  });
  return ids;
}

/**
 * Shared tail of the graph writers: lay out (full tidy tree, or the new nodes
 * as a block beside an untouched graph) and fit the comment boxes. Adds
 * commentBoxes / parkedCommentBoxes to `result`.
 */
function layoutWrittenGraph(graph, { full, newIds, boxIds, members, result }) {
  let report;
  if (full) {
    report = relayoutGraph(graph, { membership: members });
  } else {
    placeNewNodesBlock(graph, newIds, { membership: members });
    report = refitComments(graph, members, { only: boxIds });
  }
  const shown = full ? report.comments : report.comments.filter((c) => boxIds.has(c.id));
  if (shown.length) result.commentBoxes = shown;
  if (report.parked.length) {
    result.parkedCommentBoxes = report.parked;
    result.parkedNote = 'These existing comment boxes lost all their nodes and were parked (shrunk) left of the graph. Re-target them with comment_boxes [{id, nodes}] / update_comment_box(node_ids), or delete them with delete_comment_box.';
  }
  if ((result.commentBoxes || []).some((c) => c.foreignNodeIds)) {
    result.layoutHint = 'Some boxes also contain nodes outside their section (foreignNodeIds): their nodes are not contiguous in the tree. Consider regrouping, or move_nodes + update_comment_box(node_ids).';
  }
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
    commentBoxes: serializeCommentBoxes(dlg),
  };
}

/**
 * Comment boxes as author-defined sections: title + ids of the nodes fully
 * inside (nested boxes → a node can appear in several). Reading order top→bottom.
 */
export function serializeCommentBoxes(graph) {
  return (graph?.comments || [])
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => ({
      id: c.id,
      text: c.text || '',
      nodeIds: getNodesInComment(graph, c).map((n) => n.id),
    }));
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
  const boxes = serializeCommentBoxes(dlg);
  if (boxes.length) out.commentBoxes = boxes;
  return out;
}

/** Structure only — ids, speakers, edges and section boxes. No node text. */
function serializeStructure(dlg) {
  const out = {
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
  const boxes = serializeCommentBoxes(dlg);
  if (boxes.length) out.commentBoxes = boxes;
  return out;
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
 *   start?: tempId | realId,
 *   comment_boxes?: [{ id?, text?, nodes: [ids], color? }],  // section boxes wrapped around nodes
 *   layout?: 'auto' | 'full'   // auto: full tidy layout, except append → new nodes as a block
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
  if (payload.layout !== undefined && !['auto', 'full'].includes(payload.layout)) {
    throw new Error('layout must be "auto" or "full"');
  }

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
  const boxSpecs = validateCommentBoxSpecs(payload.comment_boxes, known, target);
  // Which nodes every existing box holds — taken before anything moves
  const members = target ? snapshotMembership(target) : new Map();

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

    const result = {
      dialogueId: dlg.id,
      created: creating,
      mode: creating ? 'create' : mode,
      nodeCount: dlg.nodes.length,
      startNodeId: dlg.startNodeId,
      idMap,
    };
    const boxIds = applyCommentBoxSpecs(dlg, boxSpecs, real, members);
    layoutWrittenGraph(dlg, {
      full: !isAppend || payload.layout === 'full',
      newIds: Object.values(idMap),
      boxIds,
      members,
      result,
    });
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

    const out = { start: story.startNodeId, nodes, edges, quests };
    const boxes = serializeCommentBoxes(story);
    if (boxes.length) out.commentBoxes = boxes;
    return out;
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
    const result = writeDialogueGraph(args || {});
    if (result.mode !== 'append' || args?.layout === 'full') {
      fitIfShown((State.getState().dialogues || []).find((d) => d.id === result.dialogueId));
    }
    return result;
  },

  add_node({ text_es, text_en, npc_name, condition, action, x, y, below, right_of, dialogue_id }) {
    const dlg = resolveDialogue(dialogue_id);
    const anchor = below ?? right_of;
    if (below !== undefined && right_of !== undefined) throw new Error('Use either below or right_of, not both');
    if (anchor !== undefined && (x !== undefined || y !== undefined)) throw new Error('Use x/y OR below/right_of, not both');
    if (anchor !== undefined) requireNode(dlg, anchor);
    checkFinite(x, 'x');
    checkFinite(y, 'y');
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
      if (anchor !== undefined) placeNear(dlg, node, below !== undefined ? 'below' : 'right_of', anchor);
      dlg.nodes.push(node);
      return { nodeId: node.id, dialogueId: dlg.id, x: node.x, y: node.y };
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

  auto_layout({ dialogue_id, spacing } = {}) {
    const graph = resolveGraph(dialogue_id);
    if (spacing !== undefined && !SPACINGS.includes(spacing)) throw new Error(`spacing must be one of: ${SPACINGS.join(', ')}`);
    if (!graph.nodes.length) return { ...graphRef(graph), nodeCount: 0 };
    let report;
    State.startBatch();
    try {
      report = relayoutGraph(graph, { spacing });
    } finally {
      State.endBatch();
    }
    fitIfShown(graph);
    const out = { ...graphRef(graph), nodeCount: graph.nodes.length, bounds: intRect(graphBounds(graph)) };
    if (report.comments.length) out.commentBoxes = report.comments;
    if (report.parked.length) out.parkedCommentBoxes = report.parked;
    return out;
  },

  // ─── LAYOUT & COMMENT BOXES ────────────────────────
  // Coordinates are canvas pixels (x → right, y → down). Flow is top-down:
  // a node's input connector is on its top edge, its output on the bottom.

  get_layout({ dialogue_id } = {}) {
    const graph = resolveGraph(dialogue_id);
    const rects = graph.nodes.map((n) => ({ id: n.id, ...intRect(getNodeRect(n)) }));
    const bounds = graphBounds(graph);
    const out = { ...graphRef(graph), start: graph.startNodeId || null, bounds: bounds ? intRect(bounds) : null, nodes: rects };

    const boxes = [];
    const straddling = [];
    (graph.comments || []).forEach((c) => {
      const inside = new Set(getNodesInComment(graph, c).map((n) => n.id));
      boxes.push({ id: c.id, text: c.text || '', ...intRect(boxRect(c)), color: c.color || DEFAULT_COMMENT_COLOR, nodeIds: [...inside] });
      // Nodes cut by the box edge: they look grouped but won't move with the box
      rects.forEach((r) => {
        if (!inside.has(r.id) && rectsOverlap(r, boxRect(c), -2)) straddling.push([c.id, r.id]);
      });
    });
    if (boxes.length) out.commentBoxes = boxes;
    const overlaps = findOverlaps(graph);
    if (overlaps.length) out.overlaps = overlaps;
    if (straddling.length) out.straddling = straddling;
    return out;
  },

  move_nodes({ dialogue_id, moves } = {}) {
    const graph = resolveGraph(dialogue_id);
    if (!Array.isArray(moves) || !moves.length) throw new Error('moves must be a non-empty array');
    // Validate everything first — a bad entry aborts the whole call
    moves.forEach((m, i) => {
      if (!m || !m.node_id) throw new Error(`moves[${i}] needs node_id`);
      requireNode(graph, m.node_id);
      const rel = PLACEMENTS.filter((k) => m[k] !== undefined);
      const abs = m.x !== undefined || m.y !== undefined;
      if (rel.length > 1) throw new Error(`moves[${i}]: use only one of ${PLACEMENTS.join('/')}`);
      if (rel.length && abs) throw new Error(`moves[${i}]: relative placement can't be combined with x/y (use dx/dy to nudge it)`);
      if (!rel.length && !abs && m.dx === undefined && m.dy === undefined) {
        throw new Error(`moves[${i}]: nothing to do — pass x/y, dx/dy or one of ${PLACEMENTS.join('/')}`);
      }
      ['x', 'y', 'dx', 'dy', 'gap'].forEach((k) => checkFinite(m[k], `moves[${i}].${k}`));
      if (rel.length) {
        if (m[rel[0]] === m.node_id) throw new Error(`moves[${i}]: a node can't be placed relative to itself`);
        requireNode(graph, m[rel[0]]);
      }
    });

    State.startBatch();
    try {
      const moved = [];
      moves.forEach((m) => {
        const node = requireNode(graph, m.node_id);
        const where = PLACEMENTS.find((k) => m[k] !== undefined);
        let nx = node.x;
        let ny = node.y;
        if (where) {
          const r = getNodeRect(node);
          const vertical = where === 'below' || where === 'above';
          const gap = m.gap ?? (vertical ? DEFAULT_GAP.row : DEFAULT_GAP.col);
          ({ x: nx, y: ny } = relativePosition(getNodeRect(requireNode(graph, m[where])), r.w, r.h, where, gap));
        } else {
          if (m.x !== undefined) nx = m.x;
          if (m.y !== undefined) ny = m.y;
        }
        node.x = Math.round(nx + (m.dx || 0));
        node.y = Math.round(ny + (m.dy || 0));
        if (!moved.includes(node.id)) moved.push(node.id);
      });
      const out = {
        ...graphRef(graph),
        moved: moved.map((id) => {
          const n = requireNode(graph, id);
          return { id, x: n.x, y: n.y };
        }),
      };
      const overlaps = findOverlaps(graph).filter(([a, b]) => moved.includes(a) || moved.includes(b));
      if (overlaps.length) out.overlaps = overlaps;
      return out;
    } finally {
      State.endBatch();
    }
  },

  add_comment_box({ dialogue_id, text, node_ids, x, y, width, height, color } = {}) {
    const graph = resolveGraph(dialogue_id);
    const label = String(text ?? '').trim();
    if (!label) throw new Error('text is required (the title shown on the box)');
    const hex = color !== undefined ? resolveColor(color) : DEFAULT_COMMENT_COLOR;
    ['x', 'y', 'width', 'height'].forEach((k) => checkFinite({ x, y, width, height }[k], k));

    let rect;
    if (Array.isArray(node_ids) && node_ids.length) {
      const nodes = node_ids.map((id) => requireNode(graph, id));
      const wanted = new Set(node_ids);
      // Existing boxes whose nodes are all part of this one end up nested inside it
      const inner = (graph.comments || []).filter((c) => {
        const ids = getNodesInComment(graph, c).map((n) => n.id);
        return ids.length && ids.length < wanted.size && ids.every((id) => wanted.has(id));
      });
      rect = wrapRects(nodes.map(getNodeRect), inner);
    } else {
      if (x === undefined || y === undefined) throw new Error('Pass node_ids (wrap those nodes) or explicit x and y');
      rect = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(COMMENT_MIN.w, Math.round(width ?? 400)),
        height: Math.max(COMMENT_MIN.h, Math.round(height ?? 260)),
      };
    }

    State.startBatch();
    try {
      if (!Array.isArray(graph.comments)) graph.comments = [];
      const box = { id: uid(), text: label, ...rect, color: hex };
      graph.comments.push(box);
      const inside = getNodesInComment(graph, box).map((n) => n.id);
      const out = { commentId: box.id, ...graphRef(graph), ...intRect(boxRect(box)), nodeIds: inside };
      if (Array.isArray(node_ids) && node_ids.length) {
        const foreign = inside.filter((id) => !node_ids.includes(id));
        if (foreign.length) {
          out.foreignNodeIds = foreign;
          out.hint = 'The box also covers nodes you did not list — move them out (move_nodes) or run auto_layout, then re-wrap with update_comment_box(node_ids).';
        }
      }
      return out;
    } finally {
      State.endBatch();
    }
  },

  update_comment_box({ dialogue_id, comment_id, text, color, node_ids, x, y, dx, dy, width, height, move_contents } = {}) {
    const graph = resolveGraph(dialogue_id);
    const box = requireCommentBox(graph, comment_id);
    const moving = x !== undefined || y !== undefined || dx !== undefined || dy !== undefined;
    const sizing = width !== undefined || height !== undefined;
    if (node_ids !== undefined && (moving || sizing)) throw new Error('node_ids re-wraps the box — it can\'t be combined with x/y/dx/dy/width/height');
    if ((x !== undefined || y !== undefined) && (dx !== undefined || dy !== undefined)) throw new Error('Use x/y OR dx/dy, not both');
    ['x', 'y', 'dx', 'dy', 'width', 'height'].forEach((k) => checkFinite({ x, y, dx, dy, width, height }[k], k));
    if (text !== undefined && !String(text).trim()) throw new Error('text can\'t be empty');
    const hex = color !== undefined ? resolveColor(color) : undefined;
    let wrapNodes = null;
    if (node_ids !== undefined) {
      if (!Array.isArray(node_ids) || !node_ids.length) throw new Error('node_ids must be a non-empty array');
      wrapNodes = node_ids.map((id) => requireNode(graph, id));
    }

    State.startBatch();
    try {
      if (text !== undefined) box.text = String(text).trim();
      if (hex) box.color = hex;
      let movedNodes = 0;
      if (wrapNodes) {
        const wanted = new Set(node_ids);
        const inner = (graph.comments || []).filter((c) => {
          if (c === box) return false;
          const ids = getNodesInComment(graph, c).map((n) => n.id);
          return ids.length && ids.length < wanted.size && ids.every((id) => wanted.has(id));
        });
        Object.assign(box, wrapRects(wrapNodes.map(getNodeRect), inner));
      } else {
        const ddx = x !== undefined ? x - box.x : (dx || 0);
        const ddy = y !== undefined ? y - box.y : (dy || 0);
        if (ddx || ddy) {
          // UE semantics: what is inside the box travels with it
          if (move_contents !== false) {
            const nodes = getNodesInComment(graph, box);
            const nested = getCommentsInComment(graph, box);
            nodes.forEach((n) => { n.x = Math.round(n.x + ddx); n.y = Math.round(n.y + ddy); });
            nested.forEach((c) => { c.x = Math.round(c.x + ddx); c.y = Math.round(c.y + ddy); });
            movedNodes = nodes.length;
          }
          box.x = Math.round(box.x + ddx);
          box.y = Math.round(box.y + ddy);
        }
        if (width !== undefined) box.width = Math.max(COMMENT_MIN.w, Math.round(width));
        if (height !== undefined) box.height = Math.max(COMMENT_MIN.h, Math.round(height));
      }
      const inside = getNodesInComment(graph, box).map((n) => n.id);
      const out = { commentId: box.id, ...graphRef(graph), text: box.text, ...intRect(boxRect(box)), nodeIds: inside };
      if (movedNodes) out.movedNodes = movedNodes;
      if (wrapNodes) {
        const foreign = inside.filter((id) => !node_ids.includes(id));
        if (foreign.length) out.foreignNodeIds = foreign;
      }
      return out;
    } finally {
      State.endBatch();
    }
  },

  delete_comment_box({ dialogue_id, comment_id } = {}) {
    const graph = resolveGraph(dialogue_id);
    const box = requireCommentBox(graph, comment_id);
    State.startBatch();
    try {
      graph.comments = graph.comments.filter((c) => c.id !== comment_id);
      if (State.getSelectedCommentId() === comment_id) State.setSelectedCommentId(null);
      return { deleted: comment_id, text: box.text || '', ...graphRef(graph), note: 'Only the box was removed — its nodes are untouched.' };
    } finally {
      State.endBatch();
    }
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

  write_story_map({ mode, nodes = [], connections = [], start, comment_boxes, layout } = {}) {
    const story = State.getStory();
    const isAppend = mode === 'append';
    if (layout !== undefined && !['auto', 'full'].includes(layout)) throw new Error('layout must be "auto" or "full"');

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
    const boxSpecs = validateCommentBoxSpecs(comment_boxes, known, story);
    const members = snapshotMembership(story);

    let result;
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
      result = { mode: isAppend ? 'append' : 'replace', nodeCount: story.nodes.length, startNodeId: story.startNodeId, idMap };
      const boxIds = applyCommentBoxSpecs(story, boxSpecs, real, members);
      layoutWrittenGraph(story, {
        full: !isAppend || layout === 'full',
        newIds: Object.values(idMap),
        boxIds,
        members,
        result,
      });
    } finally {
      State.endBatch();
    }
    if (!isAppend || layout === 'full') fitIfShown(story);
    return result;
  },

  add_story_node({ quest, text_es, text_en, x, y, below, right_of } = {}) {
    const story = State.getStory();
    const anchor = below ?? right_of;
    if (below !== undefined && right_of !== undefined) throw new Error('Use either below or right_of, not both');
    if (anchor !== undefined && (x !== undefined || y !== undefined)) throw new Error('Use x/y OR below/right_of, not both');
    if (anchor !== undefined) requireNode(story, anchor);
    checkFinite(x, 'x');
    checkFinite(y, 'y');
    State.startBatch();
    try {
      const pos = nextNodePosition(story);
      const node = makeNode(x !== undefined ? x : pos.x, y !== undefined ? y : pos.y);
      node.width = 320;
      node.questId = quest ? (findOrCreateQuest(quest)?.id || null) : null;
      node.text = { es: text_es || '', en: text_en || '' };
      if (anchor !== undefined) placeNear(story, node, below !== undefined ? 'below' : 'right_of', anchor);
      story.nodes.push(node);
      if (!story.startNodeId) story.startNodeId = node.id;
      return { nodeId: node.id, quest: quest || null, x: node.x, y: node.y };
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

export function setup({ fitView } = {}) {
  _fitView = fitView || null;

  // Tools that never go through view-dependent CRUD (reads, story-map tools
  // and the layout/comment-box tools, which mutate the resolved graph
  // directly): they must not yank the user out of the story map view.
  const VIEW_SAFE_TOOLS = new Set([
    'get_project_summary', 'get_dialogue', 'validate_dialogue',
    'get_story_map', 'write_story_map', 'add_story_node', 'update_story_node',
    'delete_story_node', 'connect_story_nodes', 'disconnect_story_nodes',
    'set_story_start', 'validate_story', 'update_quest_relations',
    'get_layout', 'auto_layout', 'move_nodes',
    'add_comment_box', 'update_comment_box', 'delete_comment_box',
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

/**
 * State management — global state, CRUD operations, persistence.
 * Nodes connect directly to other nodes (no inline options).
 */
import { uid } from '../utils/helpers.js';
import { newText } from './lang.js';
import { toast } from './ui.js';

// Color palette for NPCs (visually distinct, dark-mode friendly)
const NPC_COLORS = [
  '#6c5ce7', // purple
  '#00cec9', // teal
  '#fd79a8', // pink
  '#fdcb6e', // gold
  '#55efc4', // mint
  '#e17055', // coral
  '#74b9ff', // sky blue
  '#a29bfe', // lavender
  '#ffeaa7', // yellow
  '#ff7675', // salmon
  '#81ecec', // cyan
  '#fab1a0', // peach
];

// ─── STATE ───────────────────────────────────────────
let state = {
  npcs: [],
  quests: [],
  dialogues: [],
};

let activeDialogueId = null;
let selectedNodeIds = new Set();
let dirty = false;
let currentFilePath = null;

// Undo/Redo stacks
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;
let isBatching = false;

// Callback for when state changes — set by main.js
let onChangeCallback = null;

// C1: Expose dirty state and save for Electron close confirmation
export function isDirty() { return dirty; }
window.__dialogueForgeDirty = () => dirty;

export function onChange(cb) {
  onChangeCallback = cb;
}

/** Allow external modules to start batch processing of multiple state updates */
export function startBatch() {
  if (!isBatching) {
    pushUndo();
    isBatching = true;
  }
}

/** End batch processing and trigger a single emitChange */
export function endBatch() {
  isBatching = false;
  emitChange();
}

/** Allow external modules to notify state changes manually */
export function notifyChange() {
  emitChange();
}

function pushUndo() {
  if (isBatching) return;
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = []; // Clear redo on new action
}

/** Allow external modules to save an undo checkpoint before a batch of changes */
export function pushUndoCheckpoint() {
  pushUndo();
}

export function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(state));
  state = JSON.parse(undoStack.pop());
  dirty = true;
  updateStatus();
  if (onChangeCallback) onChangeCallback();
}

export function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(state));
  state = JSON.parse(redoStack.pop());
  dirty = true;
  updateStatus();
  if (onChangeCallback) onChangeCallback();
}

function emitChange() {
  if (isBatching) {
    dirty = true;
    updateStatus();
    return;
  }
  dirty = true;
  updateStatus();
  if (onChangeCallback) onChangeCallback();
}

// ─── GETTERS ─────────────────────────────────────────
export function getState() {
  return state;
}

export function getActiveDialogueId() {
  return activeDialogueId;
}

export function getActiveDialogue() {
  return state.dialogues.find((d) => d.id === activeDialogueId) || null;
}

export function getSelectedNodeId() {
  if (selectedNodeIds.size === 0) return null;
  return [...selectedNodeIds][0];
}

export function setSelectedNodeId(id) {
  selectedNodeIds.clear();
  if (id) selectedNodeIds.add(id);
}

export function getSelectedNodeIds() {
  return selectedNodeIds;
}

export function isNodeSelected(id) {
  return selectedNodeIds.has(id);
}

export function addToSelection(id) {
  selectedNodeIds.add(id);
}

export function toggleNodeSelection(id) {
  if (selectedNodeIds.has(id)) {
    selectedNodeIds.delete(id);
  } else {
    selectedNodeIds.add(id);
  }
}

export function clearSelection() {
  selectedNodeIds.clear();
}

export function setActiveDialogueId(id) {
  activeDialogueId = id;
  selectedNodeIds.clear();
  // Q16: Persist active dialogue for session restoration
  try { localStorage.setItem('df_activeDialogueId', id || ''); } catch (e) {}
}

// ─── NPC CRUD ────────────────────────────────────────
export function addNPC(name) {
  pushUndo();
  const colorIndex = state.npcs.length % NPC_COLORS.length;
  const npc = { id: uid(), name, color: NPC_COLORS[colorIndex] };
  state.npcs.push(npc);
  emitChange();
  return npc;
}

export function getNPCColor(npcId) {
  if (!npcId) return null;
  const npc = state.npcs.find((n) => n.id === npcId);
  return npc ? (npc.color || '#6c5ce7') : null;
}

export function updateNPC(id, name) {
  const npc = state.npcs.find((n) => n.id === id);
  if (npc) {
    npc.name = name;
    dirty = true;
    updateStatus();
    // Don't call emitChange to avoid re-render during typing
  }
}

export function updateNPCColor(id, color) {
  const npc = state.npcs.find((n) => n.id === id);
  if (npc) {
    npc.color = color;
    dirty = true;
    updateStatus();
    // Don't call emitChange() here — that would re-render the inspector
    // and close the native color picker popup mid-drag.
    // The caller is responsible for calling notifyChange() on picker close.
  }
}

export function deleteNPC(id) {
  pushUndo();
  state.npcs = state.npcs.filter((n) => n.id !== id);
  state.dialogues.forEach((d) => {
    if (d.npcId === id) d.npcId = null;
    // Also clear npcId from nodes
    d.nodes.forEach((node) => {
      if (node.npcId === id) node.npcId = null;
    });
  });
  emitChange();
}

export function getNPC(id) {
  return state.npcs.find((n) => n.id === id) || null;
}

// ─── REORDER (generic for any list) ──────────────────
export function reorderList(collection, fromIndex, toIndex) {
  const arr = state[collection];
  if (!arr || fromIndex < 0 || toIndex < 0 || fromIndex >= arr.length || toIndex >= arr.length) return;
  if (fromIndex === toIndex) return;
  pushUndo();
  const [item] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, item);
  emitChange();
}



// ─── QUEST CRUD ──────────────────────────────────────
export function addQuest(name) {
  pushUndo();
  const quest = { id: uid(), name };
  state.quests.push(quest);
  emitChange();
  return quest;
}

export function updateQuest(id, name) {
  const { quests } = state;
  const quest = quests.find((q) => q.id === id);
  if (quest) {
    quest.name = name;
    dirty = true;
    updateStatus();
  }
}

export function deleteQuest(id) {
  pushUndo();
  state.quests = state.quests.filter((q) => q.id !== id);
  state.dialogues.forEach((d) => {
    if (d.questId === id) d.questId = null;
  });
  emitChange();
}

// ─── DIALOGUE CRUD ───────────────────────────────────
export function addDialogue(title, npcId, questId) {
  pushUndo();
  const startNodeId = uid();
  const dlg = {
    id: uid(),
    title,
    npcId: npcId || null,
    questId: questId || null,
    startNodeId,
    nodes: [
      {
        id: startNodeId,
        text: newText(),
        x: 300,
        y: 100,
        connections: [],
      },
    ],
  };
  state.dialogues.push(dlg);
  activeDialogueId = dlg.id;
  selectedNodeIds.clear();
  emitChange();
  return dlg;
}

export function updateDialogue(id, updates) {
  const dlg = state.dialogues.find((d) => d.id === id);
  if (dlg) {
    Object.assign(dlg, updates);
    dirty = true;
    updateStatus();
  }
}

export function deleteDialogue(id) {
  pushUndo();
  state.dialogues = state.dialogues.filter((d) => d.id !== id);
  if (activeDialogueId === id) {
    activeDialogueId = null;
    selectedNodeIds.clear();
  }
  emitChange();
}

// ─── NODE CRUD ───────────────────────────────────────
export function addNode(x, y) {
  const dlg = getActiveDialogue();
  if (!dlg) return null;

  pushUndo();
  const node = {
    id: uid(),
    text: newText(),
    x,
    y,
    width: 240,
    height: null, // null = auto height
    npcId: null,
    connections: [],
    condition: '',
    action: '',
  };
  dlg.nodes.push(node);
  emitChange();
  return node;
}

export function updateNodeText(nodeId, textObj) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.text = textObj;
    dirty = true;
    updateStatus();
    // Re-render canvas only (inspector handles its own state via isEditing)
    if (onChangeCallback) onChangeCallback();
  }
}

export function updateNodePosition(nodeId, x, y) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.x = x;
    node.y = y;
    dirty = true;
    updateStatus();
  }
}

export function updateNodeSize(nodeId, width, height) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.width = Math.max(160, width);
    node.height = height ? Math.max(80, height) : null;
    dirty = true;
    updateStatus();
  }
}

export function updateNodeNPC(nodeId, npcId) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    pushUndo();
    node.npcId = npcId || null;
    emitChange();
  }
}

export function deleteNode(nodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return;

  pushUndo();

  // Remove connections pointing to this node (handles both string and object format)
  dlg.nodes.forEach((n) => {
    n.connections = n.connections
      .map(normalizeConnection)
      .filter((c) => c.targetId !== nodeId);
  });

  // Reassign start if needed
  if (dlg.startNodeId === nodeId) {
    const remaining = dlg.nodes.filter((n) => n.id !== nodeId);
    dlg.startNodeId = remaining.length > 0 ? remaining[0].id : null;
  }

  dlg.nodes = dlg.nodes.filter((n) => n.id !== nodeId);

  selectedNodeIds.delete(nodeId);
  emitChange();
}

export function duplicateNode(nodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return null;
  const original = dlg.nodes.find((n) => n.id === nodeId);
  if (!original) return null;

  pushUndo();
  const newNode = {
    id: uid(),
    text: { es: original.text?.es || '', en: original.text?.en || '' },
    x: original.x + 40,
    y: original.y + 40,
    width: original.width || 240,
    height: original.height || null,
    npcId: original.npcId || null,
    connections: [],
    condition: original.condition || '',
    action: original.action || '',
  };
  dlg.nodes.push(newNode);
  emitChange();
  return newNode;
}

export function setStartNode(nodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  pushUndo();
  dlg.startNodeId = nodeId;
  emitChange();
}

export function updateNodeCondition(nodeId, condition) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.condition = condition;
    dirty = true;
    updateStatus();
  }
}

export function updateNodeAction(nodeId, action) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (node) {
    node.action = action;
    dirty = true;
    updateStatus();
  }
}

// ─── CONNECTIONS ─────────────────────────────────────

/** Normaliza una conexión al formato {targetId, label}. Acepta strings o objetos. */
export function normalizeConnection(c) {
  if (typeof c === 'string') return { targetId: c, label: '' };
  return { targetId: c.targetId, label: c.label || '' };
}

/** Devuelve las conexiones de un nodo normalizadas como [{targetId, label}] */
export function getConnections(nodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return [];
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return (node.connections || []).map(normalizeConnection);
}

export function addConnection(sourceNodeId, targetNodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const source = dlg.nodes.find((n) => n.id === sourceNodeId);
  if (!source) return;

  // Don't self-connect
  if (sourceNodeId === targetNodeId) return;

  // Normalize existing connections and check for duplicate
  const normalized = source.connections.map(normalizeConnection);
  if (normalized.some((c) => c.targetId === targetNodeId)) return;

  pushUndo();
  // Migrate all existing to normalized format
  source.connections = normalized;
  source.connections.push({ targetId: targetNodeId, label: '' });
  emitChange();
}

export function removeConnection(sourceNodeId, targetNodeId) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const source = dlg.nodes.find((n) => n.id === sourceNodeId);
  if (!source) return;

  pushUndo();
  source.connections = source.connections
    .map(normalizeConnection)
    .filter((c) => c.targetId !== targetNodeId);
  emitChange();
}

export function reorderConnection(sourceNodeId, targetNodeId, direction) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const source = dlg.nodes.find((n) => n.id === sourceNodeId);
  if (!source) return;

  source.connections = source.connections.map(normalizeConnection);
  const idx = source.connections.findIndex((c) => c.targetId === targetNodeId);
  if (idx < 0) return;

  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= source.connections.length) return;

  pushUndo();
  const [item] = source.connections.splice(idx, 1);
  source.connections.splice(newIdx, 0, item);
  emitChange();
}

export function updateConnectionLabel(sourceNodeId, targetNodeId, label) {
  const dlg = getActiveDialogue();
  if (!dlg) return;
  const source = dlg.nodes.find((n) => n.id === sourceNodeId);
  if (!source) return;
  source.connections = source.connections.map(normalizeConnection);
  const conn = source.connections.find((c) => c.targetId === targetNodeId);
  if (conn) {
    conn.label = label;
    dirty = true;
    updateStatus();
    if (onChangeCallback) onChangeCallback();
  }
}

// ─── PERSISTENCE ─────────────────────────────────────
export function save() {
  localStorage.setItem('dialogueForge_data', JSON.stringify(state));
  dirty = false;
  updateStatus();
  toast('Proyecto guardado', 'success');
}

export function load() {
  const savedPath = localStorage.getItem('dialogueForge_currentFilePath');
  if (savedPath) currentFilePath = savedPath;
  const raw = localStorage.getItem('dialogueForge_data');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state = {
        npcs: parsed.npcs || [],
        quests: parsed.quests || [],
        dialogues: parsed.dialogues || [],
      };
      // Migrate old format: convert options to connections & add Narrative Tales fields
      state.dialogues.forEach((dlg) => {
        dlg.nodes.forEach((node) => {
          if (node.condition === undefined) node.condition = '';
          if (node.action === undefined) node.action = '';
          if (!node.connections) {
            node.connections = [];
            if (node.options) {
              node.options.forEach((opt) => {
                if (opt.nextNodeId) {
                  const already = node.connections.some(
                    (c) => normalizeConnection(c).targetId === opt.nextNodeId
                  );
                  if (!already) node.connections.push({ targetId: opt.nextNodeId, label: '' });
                }
              });
              delete node.options;
            }
          } else {
            // Normalize string connections to object format
            node.connections = node.connections.map(normalizeConnection);
          }
        });
      });
    } catch {
      state = { npcs: [], quests: [], dialogues: [] };
    }
  }

  // Q16: Restore active dialogue from previous session
  const savedDlgId = localStorage.getItem('df_activeDialogueId');
  if (savedDlgId && state.dialogues.some((d) => d.id === savedDlgId)) {
    activeDialogueId = savedDlgId;
  }
}

export function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dialogues_export.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('JSON exportado', 'success');
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.npcs && data.dialogues) {
          pushUndo();
          state = {
            npcs: data.npcs || [],
            quests: data.quests || [],
            dialogues: data.dialogues || [],
          };
          // Migrate Narrative Tales fields
          state.dialogues.forEach((dlg) => {
            dlg.nodes.forEach((node) => {
              if (node.condition === undefined) node.condition = '';
              if (node.action === undefined) node.action = '';
              // Normalize connections
              if (node.connections) {
                node.connections = node.connections.map(normalizeConnection);
              } else {
                node.connections = [];
              }
            });
          });
          activeDialogueId = null;
          selectedNodeIds.clear();
          currentFilePath = null;
          localStorage.removeItem('dialogueForge_currentFilePath');
          save();
          toast('Proyecto importado correctamente', 'success');
          resolve();
        } else {
          toast('Formato de archivo no válido', 'error');
          reject(new Error('Invalid format'));
        }
      } catch {
        toast('Error al leer el archivo', 'error');
        reject(new Error('Parse error'));
      }
    };
    reader.readAsText(file);
  });
}

function updateStatus() {
  const el = document.getElementById('status-text');
  if (el) {
    const fileName = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : null;
    if (dirty) {
      el.textContent = fileName ? `${fileName} — Cambios sin guardar` : 'Cambios sin guardar';
    } else {
      el.textContent = fileName ? `${fileName} — Guardado ✓` : 'Guardado ✓';
    }
  }
  // Update window title
  if (window.electronAPI?.setTitle) {
    const base = "Jamon's Dialogue Editor";
    const fileName = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : null;
    window.electronAPI.setTitle(fileName ? `${base} — ${fileName}${dirty ? ' •' : ''}` : base);
  }
}

// ─── FILE PERSISTENCE (Electron IPC) ─────────────────
export async function saveToFile() {
  if (!window.electronAPI?.isElectron) {
    save(); // Fallback to localStorage
    return;
  }
  try {
    const data = JSON.stringify(state, null, 2);
    const result = await window.electronAPI.saveFile(data, currentFilePath);
    if (result) {
      currentFilePath = result;
      localStorage.setItem('dialogueForge_currentFilePath', result);
      dirty = false;
      save(); // Also persist to localStorage as backup
      updateStatus();
      toast('Guardado en ' + result.split(/[\\/]/).pop(), 'success');
    }
  } catch (err) {
    toast('Error al guardar: ' + err.message, 'error');
  }
}

export async function loadFromFile() {
  if (!window.electronAPI?.isElectron) {
    toast('Solo disponible en la aplicación de escritorio', 'error');
    return;
  }
  try {
    const result = await window.electronAPI.openFile();
    if (result) {
      const data = JSON.parse(result.content);
      pushUndo();
      state = {
        npcs: data.npcs || [],
        quests: data.quests || [],
        dialogues: data.dialogues || [],
      };
      // Normalize connections in all nodes
      state.dialogues.forEach((dlg) => {
        dlg.nodes.forEach((node) => {
          if (node.condition === undefined) node.condition = '';
          if (node.action === undefined) node.action = '';
          if (node.connections) {
            node.connections = node.connections.map(normalizeConnection);
          } else {
            node.connections = [];
          }
        });
      });
      currentFilePath = result.filePath;
      localStorage.setItem('dialogueForge_currentFilePath', result.filePath);
      activeDialogueId = null;
      selectedNodeIds.clear();
      dirty = false;
      save(); // Backup to localStorage
      updateStatus();
      toast('Proyecto abierto: ' + result.filePath.split(/[\\/]/).pop(), 'success');
      if (onChangeCallback) onChangeCallback();
    }
  } catch (err) {
    toast('Error al abrir: ' + err.message, 'error');
  }
}

export function getCurrentFilePath() {
  return currentFilePath;
}

// Auto-save every 30 seconds
setInterval(() => {
  if (dirty) save();
}, 30000);

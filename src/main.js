/**
 * Jamon's Dialogue Editor — Main Entry Point
 * Wires all modules together and initializes the app.
 */
import './style.css';

import { $, $$ } from './utils/helpers.js';
import * as State from './modules/state.js';
import * as Canvas from './modules/canvas.js';
import * as Inspector from './modules/inspector.js';
import * as Sidebar from './modules/sidebar.js';
import { initLangToggle } from './modules/lang.js';
import { hideContextMenu, showAISettingsModal, showAIGenerateModal, showAILoading, hideAILoading, toast } from './modules/ui.js';
import * as AI from './modules/ai.js';
import * as Chat from './modules/chat.js';
import * as McpBridge from './modules/mcp-bridge.js';
import { wrapRects, getNodeRect } from './modules/layout.js';
import * as AudioSlicer from './modules/audio-slicer.js';
import * as VectorMemory from './modules/vector-memory.js';
import * as MemoryMap from './modules/memory-map.js';

// ─── RENDER ALL ──────────────────────────────────────
function renderAll() {
  const t0 = performance.now();
  Sidebar.render();
  const t1 = performance.now();
  Canvas.render();
  const t2 = performance.now();
  Inspector.render();
  const t3 = performance.now();
  Chat.onStateChange();
  const t4 = performance.now();
  // Perf tracing: warn when a full re-render is noticeably slow so we can
  // see WHICH phase is eating the time (remove when the jank is solved)
  if (t4 - t0 > 120) {
    console.warn(
      `[perf] renderAll ${Math.round(t4 - t0)}ms — sidebar ${Math.round(t1 - t0)} · canvas ${Math.round(t2 - t1)} · inspector ${Math.round(t3 - t2)} · chat ${Math.round(t4 - t3)}`
    );
  }

  // Sync view tabs (Diálogo / Historia)
  const mode = State.getViewMode();
  $$('#view-tabs .view-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === mode);
  });

  // Disable AI toolbar buttons when no dialogue is active (or in story view)
  const hasDlg = !!State.getActiveDialogue() && mode === 'dialogue';
  const translateBtn = $('#btn-ai-translate-all');
  const generateBtn = $('#btn-ai-generate');
  if (translateBtn) { translateBtn.disabled = !hasDlg; translateBtn.style.opacity = hasDlg ? '' : '0.4'; }
  if (generateBtn) { generateBtn.disabled = !hasDlg; generateBtn.style.opacity = hasDlg ? '' : '0.4'; }

  // Keep the vector memory fresh in the background (debounced; only if already indexed)
  VectorMemory.notifyStateChange();
}

// ─── WIRE MODULES ────────────────────────────────────
State.onChange(() => renderAll());

Sidebar.onSelect((type, id) => {
  // Selecting a dialogue always returns to the dialogue editor view
  if (type === 'dialogue') {
    State.setViewMode('dialogue');
    Inspector.show('dialogue', id);
  } else {
    Inspector.show(type, id);
  }
  renderAll();
});

// ─── VIEW TABS (Diálogo / Historia) ──────────────────
$$('#view-tabs .view-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (State.getViewMode() === tab.dataset.view) return;
    State.setViewMode(tab.dataset.view);
    Inspector.clear();
    renderAll();
  });
});

// Navigation from the story inspector ("Relacionados" → open dialogue)
document.addEventListener('df-open-dialogue', (e) => {
  const id = e.detail?.id;
  if (!id) return;
  State.setActiveDialogueId(id);
  State.setViewMode('dialogue');
  Inspector.show('dialogue', id);
  renderAll();
});

Canvas.onNodeSelected((nodeId) => Inspector.show('node', nodeId));
Canvas.onCommentSelected((commentId) => Inspector.show('comment', commentId));
Canvas.onCanvasClick(() => Inspector.clear());

// Selection changed without going through onSelect (e.g. shift+click toggle):
// sync the inspector with whatever the selection is now
document.addEventListener('df-selection-changed', () => {
  const ids = State.getSelectedNodeIds();
  if (ids.size > 1) Inspector.render(); // multi-select panel
  else if (ids.size === 1) Inspector.show('node', [...ids][0]);
  else Inspector.clear();
});

document.addEventListener('langchange', () => {
  Canvas.render();
  Inspector.render();
});

// Audio Slicer
AudioSlicer.init();
$('#btn-audio-slicer')?.addEventListener('click', () => AudioSlicer.open());

// Memory Map (vector memory / neural map)
MemoryMap.init();
MemoryMap.setOnNavigate(() => renderAll());
$('#btn-memory-map')?.addEventListener('click', () => MemoryMap.open());

// ─── TOOLBAR ─────────────────────────────────────────
function setupToolbar() {
  $('#btn-file-open').addEventListener('click', async () => {
    await State.loadFromFile();
    renderAll();
  });
  $('#btn-save').addEventListener('click', () => State.saveToFile());
  $('#btn-export').addEventListener('click', () => State.exportJSON());
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      await State.importJSON(e.target.files[0]);
      renderAll();
    }
    e.target.value = '';
  });

  // AI buttons
  $('#btn-ai-settings').addEventListener('click', () => {
    showAISettingsModal(AI.getConfig(), (newConfig) => {
      AI.saveConfig(newConfig);
    });
  });

  $('#btn-ai-translate-all').addEventListener('click', async () => {
    const dlg = State.getActiveDialogue();
    if (!dlg) { toast('Selecciona un diálogo primero', 'error'); return; }
    showAILoading('Traduciendo ES → EN...');
    try {
      const count = await AI.translateAllNodes();
      toast(count + ' nodos traducidos a EN', 'success');
      renderAll();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      hideAILoading();
    }
  });

  $('#btn-ai-generate').addEventListener('click', () => {
    const dlg = State.getActiveDialogue();
    if (!dlg) { toast('Selecciona un diálogo primero', 'error'); return; }
    const npc = dlg.npcId ? State.getNPC(dlg.npcId) : null;
    const hasExistingNodes = dlg.nodes.length > 1;
    showAIGenerateModal(npc?.name || '', async ({ prompt, minNodes, maxNodes, mode }) => {
      if (mode === 'extend') {
        showAILoading('Extendiendo diálogo...');
        try {
          const data = await AI.extendDialogue(prompt, npc?.name || '', { minNodes, maxNodes });
          const count = AI.insertExtendedDialogue(data);
          toast(count + ' nodos añadidos', 'success');
          renderAll();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          hideAILoading();
        }
      } else {
        showAILoading('Generando diálogo...');
        try {
          const data = await AI.generateDialogue(prompt, npc?.name || '', { minNodes, maxNodes });
          const count = AI.insertGeneratedDialogue(data);
          toast(count + ' nodos generados', 'success');
          renderAll();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          hideAILoading();
        }
      }
    }, { hasExistingNodes });
  });
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const isInput = e.target.closest('input, textarea, select');

    // Ctrl+S → save (file-based if available)
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (State.saveToFile) {
        State.saveToFile();
      } else {
        State.save();
      }
    }

    // Ctrl+Z → undo (only when not editing text, so browser native undo works)
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey && !isInput) {
      e.preventDefault();
      State.undo();
    }

    // Ctrl+Y or Ctrl+Shift+Z → redo (only when not editing text)
    if (((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) && !isInput) {
      e.preventDefault();
      State.redo();
    }

    // Ctrl+A → select all nodes in the active graph (dialogue or story map)
    if (e.ctrlKey && e.key === 'a' && !isInput) {
      e.preventDefault();
      const dlg = State.getActiveGraph();
      if (dlg && dlg.nodes.length > 0) {
        State.clearSelection();
        dlg.nodes.forEach((n) => State.addToSelection(n.id));
        Canvas.render();
        Inspector.render(); // show the multi-select panel
        toast(dlg.nodes.length + ' nodos seleccionados', 'info');
      }
    }

    // Ctrl+D → duplicate selected nodes
    if (e.ctrlKey && e.key === 'd' && State.getSelectedNodeIds().size > 0 && !isInput) {
      e.preventDefault();
      const ids = [...State.getSelectedNodeIds()];
      State.clearSelection();
      let count = 0;
      State.startBatch();
      ids.forEach((id) => {
        const dup = State.duplicateNode(id);
        if (dup) {
          State.addToSelection(dup.id);
          count++;
        }
      });
      State.endBatch();
      if (count > 0) {
        toast(count + ' nodo(s) duplicado(s)', 'success');
        renderAll();
      }
    }

    // C → UE-style comment box: wrap the selected nodes, or create one at the view center
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.altKey && !e.metaKey && !isInput) {
      const graph = State.getActiveGraph();
      if (graph) {
        e.preventDefault();
        const selectedIds = [...State.getSelectedNodeIds()];
        if (selectedIds.length > 0) {
          // Bounding box of the selection + UE-like padding (extra room on top for the title)
          const rect = wrapRects(graph.nodes.filter((n) => selectedIds.includes(n.id)).map(getNodeRect));
          if (rect) State.addComment({ ...rect, text: 'Comentario' });
        } else {
          // No selection → default-sized box at the center of the view
          const rect = $('#canvas-container').getBoundingClientRect();
          const cx = (rect.width / 2 - Canvas.offset.x) / Canvas.zoom;
          const cy = (rect.height / 2 - Canvas.offset.y) / Canvas.zoom;
          State.addComment({ x: cx - 200, y: cy - 130, width: 400, height: 260, text: 'Comentario' });
        }
        const newId = State.getSelectedCommentId();
        if (newId) Inspector.show('comment', newId);
      }
    }

    // Delete / Backspace → delete all selected nodes (or the selected comment box)
    if ((e.key === 'Delete' || (e.key === 'Backspace' && !isInput)) && !isInput) {
      if (State.getSelectedNodeIds().size > 0) {
        e.preventDefault();
        const ids = [...State.getSelectedNodeIds()];
        State.startBatch();
        ids.forEach((id) => State.deleteNode(id));
        State.endBatch();
        Inspector.clear();
      } else if (State.getSelectedCommentId()) {
        e.preventDefault();
        State.deleteComment(State.getSelectedCommentId());
        Inspector.clear();
      }
    }

    // Escape → close overlays, defocus text editing, deselect all
    if (e.key === 'Escape') {
      $('#modal-overlay').classList.remove('active');
      hideContextMenu();
      // Leave inline text editing (so the next render is a full one)
      const focusedNodeText = document.querySelector('.node-inline-text:focus');
      if (focusedNodeText) focusedNodeText.blur();
      if (State.getSelectedNodeIds().size > 0 || State.getSelectedCommentId()) {
        State.clearSelection();
        Inspector.clear();
        Canvas.render();
      }
    }
  });
}

// ─── INIT ────────────────────────────────────────────
function init() {
  State.load();
  setupToolbar();
  Sidebar.setupAddButtons();
  Canvas.setup();
  // Register auto-layout callback so AI can trigger layout without circular import
  AI.setAutoLayoutCallback(Canvas.autoLayout);
  initLangToggle();
  setupKeyboard();
  renderAll();

  // C1: Expose save for Electron close confirmation
  window.__dialogueForgeSave = () => State.saveToFile();

  // Initialize AI chat assistant
  Chat.setup(renderAll, Canvas.autoLayout);

  // MCP bridge: lets Claude Code (via electron/mcp-server.js) drive the app
  McpBridge.setup({ fitView: Canvas.fitView });
}

init();

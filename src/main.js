/**
 * Dialogue Forge — Main Entry Point
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
import * as AudioSlicer from './modules/audio-slicer.js';

// ─── RENDER ALL ──────────────────────────────────────
function renderAll() {
  Sidebar.render();
  Canvas.render();
  Inspector.render();
  Chat.onStateChange();

  // Disable AI toolbar buttons when no dialogue is active
  const hasDlg = !!State.getActiveDialogue();
  const translateBtn = $('#btn-ai-translate-all');
  const generateBtn = $('#btn-ai-generate');
  if (translateBtn) { translateBtn.disabled = !hasDlg; translateBtn.style.opacity = hasDlg ? '' : '0.4'; }
  if (generateBtn) { generateBtn.disabled = !hasDlg; generateBtn.style.opacity = hasDlg ? '' : '0.4'; }
}

// ─── WIRE MODULES ────────────────────────────────────
State.onChange(() => renderAll());

Sidebar.onSelect((type, id) => {
  if (type === 'dialogue') {
    Inspector.show('dialogue', id);
  } else {
    Inspector.show(type, id);
  }
  renderAll();
});

Canvas.onNodeSelected((nodeId) => Inspector.show('node', nodeId));
Canvas.onCanvasClick(() => Inspector.clear());

document.addEventListener('langchange', () => {
  Canvas.render();
  Inspector.render();
});

// Audio Slicer
AudioSlicer.init();
$('#btn-audio-slicer')?.addEventListener('click', () => AudioSlicer.open());

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

    // Ctrl+A → select all nodes in active dialogue
    if (e.ctrlKey && e.key === 'a' && !isInput) {
      e.preventDefault();
      const dlg = State.getActiveDialogue();
      if (dlg && dlg.nodes.length > 0) {
        State.clearSelection();
        dlg.nodes.forEach((n) => State.addToSelection(n.id));
        Canvas.render();
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

    // Delete / Backspace → delete all selected nodes
    if ((e.key === 'Delete' || (e.key === 'Backspace' && !isInput)) && State.getSelectedNodeIds().size > 0 && !isInput) {
      e.preventDefault();
      const ids = [...State.getSelectedNodeIds()];
      State.startBatch();
      ids.forEach((id) => State.deleteNode(id));
      State.endBatch();
      Inspector.clear();
    }

    // Escape → close overlays, deselect all
    if (e.key === 'Escape') {
      $('#modal-overlay').classList.remove('active');
      hideContextMenu();
      if (State.getSelectedNodeIds().size > 0) {
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
  McpBridge.setup(Canvas.autoLayout);
}

init();

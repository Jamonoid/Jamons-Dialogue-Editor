/**
 * Canvas — pan, zoom, connections SVG, snap-to-grid, selection rectangle.
 * Connections go from node output (bottom) to node input (top).
 */
import { $ } from '../utils/helpers.js';
import * as State from './state.js';
import { normalizeConnection, updateConnectionLabel } from './state.js';
import { renderNodes, setupNodeInteractions, registerGlobalHandlers } from './nodes.js';
import { showContextMenu, showModal, toast } from './ui.js';

// ─── CANVAS STATE ────────────────────────────────────
export let offset = { x: 0, y: 0 };
export let zoom = 1;

// UE-style controls: RIGHT-drag pans, LEFT-drag draws the selection marquee.
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panStartClient = { x: 0, y: 0 };
let panMoved = false; // suppress the context menu that fires after a RMB pan

/** True (once) if the right-button gesture that just ended was a pan, not a click. */
export function consumeRmbPan() {
  const moved = panMoved;
  panMoved = false;
  return moved;
}

// Snap-to-grid
let snapEnabled = localStorage.getItem('dialogueForge_snap') === 'true';
const GRID_SIZE = 24;

// Q10: Camera positions per dialogue
let cameraCache = {};
let lastDialogueId = null;

export function isSnapEnabled() { return snapEnabled; }
export function toggleSnap() {
  snapEnabled = !snapEnabled;
  localStorage.setItem('dialogueForge_snap', snapEnabled);
  updateSnapUI();
}

function updateSnapUI() {
  const btn = $('#btn-snap');
  if (btn) {
    btn.classList.toggle('active', snapEnabled);
    btn.title = snapEnabled ? 'Snap activo (clic para desactivar)' : 'Snap inactivo (clic para activar)';
  }
}

// Selection rectangle
let isSelecting = false;
let selectionStart = { x: 0, y: 0 };
let selectionAdditive = false; // Shift held → add to the current selection

let onNodeSelectedCallback = null;
let onCanvasClickCallback = null;
let onCommentSelectedCallback = null;

export function onNodeSelected(cb) { onNodeSelectedCallback = cb; }
export function onCanvasClick(cb) { onCanvasClickCallback = cb; }
export function onCommentSelected(cb) { onCommentSelectedCallback = cb; }

// ─── RENDER ──────────────────────────────────────────
export function render() {
  const isStory = State.getViewMode() === 'story';
  const dlg = State.getActiveGraph();
  const nodesLayer = $('#nodes-layer');
  const connectionsGroup = $('#connections-group');
  const emptyState = $('#canvas-empty');
  const controls = $('#canvas-controls');
  const addBtn = $('#btn-add-node');

  // Empty-state texts differ per view (story map always exists but may have 0 nodes)
  const emptyTitle = emptyState.querySelector('h3');
  const emptyText = emptyState.querySelector('p');

  if (!dlg) {
    nodesLayer.innerHTML = '';
    connectionsGroup.innerHTML = '';
    if (emptyTitle) emptyTitle.textContent = 'Sin diálogo seleccionado';
    if (emptyText) emptyText.textContent = 'Selecciona o crea un diálogo en la barra lateral';
    emptyState.style.display = '';
    controls.style.display = 'none';
    addBtn.style.display = 'none';
    return;
  }

  // If a node textarea is focused, don't rebuild the DOM (that would destroy
  // the textarea and kill the focus) — but DO sync the selection visuals and
  // connections, otherwise the gold ring lags behind on the previous node.
  // Safety net: if the graph STRUCTURE changed under the focused textarea
  // (node/comment added or removed — e.g. by MCP or chat edits), fall through
  // to the full rebuild anyway; a lost focus beats an invisible node.
  const focusedTextarea = nodesLayer.querySelector('.node-inline-text:focus');
  if (focusedTextarea) {
    const domNodeIds = new Set(
      [...nodesLayer.querySelectorAll('.dialogue-node')].map((el) => el.dataset.nodeId)
    );
    const structureChanged =
      dlg.nodes.length !== domNodeIds.size ||
      dlg.nodes.some((n) => !domNodeIds.has(n.id)) ||
      (dlg.comments || []).length !== nodesLayer.querySelectorAll('.graph-comment').length;
    if (!structureChanged) {
      syncSelectionVisuals(dlg, nodesLayer);
      renderConnections();
      return;
    }
  }

  // Q10: Restore camera when switching dialogues (or dialogue ⇄ story map)
  const currentDlgId = dlg.id;
  if (currentDlgId !== lastDialogueId) {
    if (cameraCache[currentDlgId]) {
      offset.x = cameraCache[currentDlgId].x;
      offset.y = cameraCache[currentDlgId].y;
      zoom = cameraCache[currentDlgId].zoom;
    } else {
      offset.x = 0;
      offset.y = 0;
      zoom = 1;
    }
    lastDialogueId = currentDlgId;
  }

  // Story map with no nodes yet: keep controls + add button, show a hint
  if (isStory && dlg.nodes.length === 0 && !(dlg.comments || []).length) {
    nodesLayer.innerHTML = '';
    connectionsGroup.innerHTML = '';
    if (emptyTitle) emptyTitle.textContent = 'Mapa de historia vacío';
    if (emptyText) emptyText.textContent = 'Agrega tu primera quest con el botón + o clic derecho en el lienzo';
    emptyState.style.display = '';
    controls.style.display = '';
    addBtn.style.display = '';
    applyTransform();
    return;
  }

  emptyState.style.display = 'none';
  controls.style.display = '';
  addBtn.style.display = '';

  renderNodes(dlg, nodesLayer);
  applyTransform();
  renderConnections();
  setupNodeInteractions(dlg, {
    onSelect: (nodeId) => {
      State.setSelectedNodeId(nodeId);
      render();
      if (onNodeSelectedCallback) onNodeSelectedCallback(nodeId);
    },
    onRender: () => {
      render();
    },
    onPositionChange: (nodeId, x, y) => {
      State.updateNodePosition(nodeId, x, y);
      renderConnections();
    },
    onCommentSelect: (commentId) => {
      if (onCommentSelectedCallback) onCommentSelectedCallback(commentId);
    },
    offset,
    get zoom() { return zoom; },
  });
}

/**
 * Lightweight selection sync: toggles the .selected class on the EXISTING
 * node/comment DOM without rebuilding it, and keeps the inline NPC border
 * color coherent (inline style beats the .selected CSS ring, so it must be
 * cleared while selected and restored when deselected). Idempotent — safe to
 * call from anywhere the selection changed without a full re-render.
 */
export function syncSelectionVisuals(dlg, nodesLayer = $('#nodes-layer')) {
  if (!dlg || !nodesLayer) return;
  const isStory = dlg.id === 'story';
  nodesLayer.querySelectorAll('.dialogue-node').forEach((el) => {
    const id = el.dataset.nodeId;
    const selected = State.isNodeSelected(id);
    el.classList.toggle('selected', selected);
    const node = dlg.nodes.find((n) => n.id === id);
    const npcColor = !isStory && node ? State.getNPCColor(node.npcId) : null;
    el.style.borderColor = selected ? '' : (npcColor || '');
  });
  const selComment = State.getSelectedCommentId();
  nodesLayer.querySelectorAll('.graph-comment').forEach((el) => {
    el.classList.toggle('selected', el.dataset.commentId === selComment);
  });
}

export function renderConnections() {
  const isStory = State.getViewMode() === 'story';
  const dlg = State.getActiveGraph();
  const connectionsGroup = $('#connections-group');
  if (!dlg) {
    connectionsGroup.innerHTML = '';
    return;
  }

  const container = $('#canvas-container');
  const containerRect = container.getBoundingClientRect();
  let paths = '';
  let labels = '';

  // Escape for SVG text content
  const escSvg = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Effective canvas scale for label sizing — read from the live CSS transform
  // of the nodes layer (the same scale the node text uses), so the labels
  // always grow/shrink with the world zoom.
  let labelScale = zoom;
  try {
    const m = new DOMMatrix(getComputedStyle($('#nodes-layer')).transform);
    if (m && m.a) labelScale = m.a;
  } catch (e) {}

  dlg.nodes.forEach((node) => {
    if (!node.connections) return;
    node.connections.forEach((rawConn) => {
      const conn = normalizeConnection(rawConn);
      const targetNode = dlg.nodes.find((n) => n.id === conn.targetId);
      if (!targetNode) return;

      // Source: output connector (bottom of source node)
      const sourceEl = $(`.node-output-connector[data-output-node="${node.id}"]`);
      // Target: input connector (top of target node)
      const targetEl = $(`.node-input-connector[data-input-node="${conn.targetId}"]`);
      if (!sourceEl || !targetEl) return;

      const sourceRect = sourceEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();

      const x1 = sourceRect.left + sourceRect.width / 2 - containerRect.left;
      const y1 = sourceRect.top + sourceRect.height / 2 - containerRect.top;
      const x2 = targetRect.left + targetRect.width / 2 - containerRect.left;
      const y2 = targetRect.top + targetRect.height / 2 - containerRect.top;

      const dy = Math.abs(y2 - y1) * 0.4;
      const pathD = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;

      // Invisible fat path for easier clicking + visible thin path
      const hitTitle = isStory ? 'Doble clic: editar condición · Clic derecho: opciones' : 'Doble clic: eliminar · Clic derecho: opciones';
      paths += `<path d="${pathD}" stroke="transparent" stroke-width="16" fill="none" data-source="${node.id}" data-target="${conn.targetId}" class="conn-hitarea"><title>${hitTitle}</title></path>`;
      paths += `<path d="${pathD}" stroke="var(--accent-primary)" stroke-width="2" fill="none" opacity="0.6" class="conn-visible" data-source="${node.id}" data-target="${conn.targetId}"/>`;

      // Story map: always draw a label at the bezier midpoint — the condition
      // text if set, or a clickable "＋ condición" placeholder to add one.
      if (isStory) {
        // Bezier point at t=0.5 (control points cancel out → simple midpoint)
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        // Fully proportional to the world zoom (like node text) — no floor,
        // so it shrinks away when zoomed far out instead of dominating the view.
        const fontSize = Math.round(15 * labelScale * 10) / 10;
        const isEmpty = !conn.label;
        // Wrap long labels into lines of ~28 chars
        const words = (isEmpty ? '＋ condición' : conn.label).split(/\s+/);
        const lines = [];
        let line = '';
        words.forEach((w) => {
          if ((line + ' ' + w).trim().length > 28) { if (line) lines.push(line); line = w; }
          else line = (line + ' ' + w).trim();
        });
        if (line) lines.push(line);
        const lineH = fontSize * 1.25;
        const startY = my - ((lines.length - 1) * lineH) / 2;
        const tspans = lines.map((l, i) =>
          `<tspan x="${mx}" y="${startY + i * lineH}">${escSvg(l)}</tspan>`
        ).join('');
        labels += `<text class="conn-label ${isEmpty ? 'conn-label-empty' : ''}" text-anchor="middle" style="font-size:${fontSize}px;stroke-width:${Math.round(fontSize * 0.3 * 10) / 10}px" data-source="${node.id}" data-target="${conn.targetId}"><title>Clic para editar la condición</title>${tspans}</text>`;
      }
    });
  });

  connectionsGroup.innerHTML = paths + labels;

  // Label click → edit (story map)
  connectionsGroup.querySelectorAll('.conn-label').forEach((labelEl) => {
    labelEl.style.cursor = 'pointer';
    labelEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editConnectionLabel(labelEl.dataset.source, labelEl.dataset.target);
    });
  });

  // Right-click and hover on connections
  connectionsGroup.querySelectorAll('.conn-hitarea').forEach((path) => {
    path.style.pointerEvents = 'stroke';
    path.style.cursor = 'pointer';

    // Q3: Highlight source and target nodes on hover
    path.addEventListener('mouseenter', () => {
      const sourceId = path.dataset.source;
      const targetId = path.dataset.target;
      const sourceEl = document.querySelector(`.dialogue-node[data-node-id="${sourceId}"]`);
      const targetEl = document.querySelector(`.dialogue-node[data-node-id="${targetId}"]`);
      if (sourceEl) sourceEl.classList.add('conn-highlighted');
      if (targetEl) targetEl.classList.add('conn-highlighted');
      // Also highlight the visible path
      const visiblePath = connectionsGroup.querySelector(`.conn-visible[data-source="${sourceId}"][data-target="${targetId}"]`);
      if (visiblePath) { visiblePath.setAttribute('stroke-width', '3'); visiblePath.setAttribute('opacity', '1'); }
    });
    path.addEventListener('mouseleave', () => {
      document.querySelectorAll('.dialogue-node.conn-highlighted').forEach((el) => el.classList.remove('conn-highlighted'));
      connectionsGroup.querySelectorAll('.conn-visible').forEach((p) => { p.setAttribute('stroke-width', '2'); p.setAttribute('opacity', '0.6'); });
    });

    // Double-click on a cable → edit label (story map) / delete (dialogue)
    path.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (State.getViewMode() === 'story') {
        editConnectionLabel(path.dataset.source, path.dataset.target);
        return;
      }
      State.removeConnection(path.dataset.source, path.dataset.target);
      toast('Conexión eliminada', 'info');
    });

    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (consumeRmbPan()) return; // RMB gesture was a pan, not a menu request
      const sourceId = path.dataset.source;
      const targetId = path.dataset.target;
      const menuItems = [];
      if (State.getViewMode() === 'story') {
        menuItems.push({
          label: '✎ Editar etiqueta',
          action: 'edit-label',
          handler: () => editConnectionLabel(sourceId, targetId),
        });
      }
      menuItems.push({
        label: 'Eliminar conexión',
        action: 'delete-conn',
        danger: true,
        handler: () => {
          State.removeConnection(sourceId, targetId);
        },
      });
      showContextMenu(e.clientX, e.clientY, menuItems);
    });
  });
}

/** Edit the label of a connection (story map: the condition for the next quest). */
function editConnectionLabel(sourceId, targetId) {
  const dlg = State.getActiveGraph();
  if (!dlg) return;
  const source = dlg.nodes.find((n) => n.id === sourceId);
  if (!source) return;
  const conn = (source.connections || []).map(normalizeConnection).find((c) => c.targetId === targetId);
  showModal(
    'Etiqueta de la conexión',
    [{
      key: 'label',
      label: 'Condición / etiqueta',
      type: 'textarea',
      value: conn ? conn.label : '',
      placeholder: 'Ej: Aquí puedo escribir la condición para que la quest empiece',
    }],
    (vals) => {
      State.pushUndoCheckpoint();
      updateConnectionLabel(sourceId, targetId, vals.label || '');
    }
  );
}

export function applyTransform() {
  const nodesLayer = $('#nodes-layer');
  const gridBg = $('#grid-bg');

  nodesLayer.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
  // UE-style comment bubbles: titles counter-scale when zoomed OUT so they
  // stay readable as region labels (capped so they don't get absurd).
  nodesLayer.style.setProperty('--inv-zoom', String(Math.max(1, Math.min(3.5, 1 / zoom))));

  const bgSize = GRID_SIZE * zoom;
  gridBg.style.backgroundSize = `${bgSize}px ${bgSize}px`;
  gridBg.style.backgroundPosition = `${offset.x % bgSize}px ${offset.y % bgSize}px`;

  const label = $('#zoom-label');
  if (label) label.textContent = Math.round(zoom * 100) + '%';

  // Q10: Save camera position for current graph (dialogue or story map)
  const graph = State.getActiveGraph();
  if (graph) {
    cameraCache[graph.id] = { x: offset.x, y: offset.y, zoom };
  }
}

// ─── SETUP ───────────────────────────────────────────
export function setup() {
  const container = $('#canvas-container');
  registerGlobalHandlers();

  // UE Blueprint controls:
  //   Right-drag  → pan the canvas
  //   Left-drag   → selection marquee (Shift = add to selection)
  //   Left-click  → deselect
  //   Right-click → context menu (only if the mouse didn't move — no menu after a pan)
  container.addEventListener('mousedown', (e) => {
    const onWidget = e.target.closest('.dialogue-node') || e.target.closest('.canvas-controls') || e.target.closest('.canvas-add-btn')
      || e.target.closest('.graph-comment-title') || e.target.closest('.graph-comment-resize');

    // ── Right button → pan (from anywhere except nodes/comment bars/controls) ──
    if (e.button === 2) {
      if (onWidget) return;
      e.preventDefault();
      isPanning = true;
      panMoved = false;
      panStart.x = e.clientX - offset.x;
      panStart.y = e.clientY - offset.y;
      panStartClient = { x: e.clientX, y: e.clientY };
      container.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;
    if (onWidget) return;
    if (e.target.classList && e.target.classList.contains('conn-hitarea')) return; // clicking a cable shouldn't select (allows dblclick delete)
    if (e.target.closest && e.target.closest('.conn-label')) return; // clicking a connection label shouldn't select (allows click-to-edit)

    // ── Left button → selection marquee ──
    // preventDefault() below also suppresses the native focus change, so blur
    // any focused node textarea manually (click-away must defocus, and the
    // full re-render path depends on nothing being focused).
    const focusedText = document.querySelector('.node-inline-text:focus');
    if (focusedText) focusedText.blur();
    e.preventDefault(); // Prevent native text selection
    isSelecting = true;
    selectionAdditive = e.shiftKey;
    selectionStart = { x: e.clientX, y: e.clientY };
    const rect = $('#selection-rect');
    if (rect) {
      rect.style.display = 'block';
      rect.style.left = e.clientX - container.getBoundingClientRect().left + 'px';
      rect.style.top = e.clientY - container.getBoundingClientRect().top + 'px';
      rect.style.width = '0px';
      rect.style.height = '0px';
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isPanning) {
      offset.x = e.clientX - panStart.x;
      offset.y = e.clientY - panStart.y;
      if (!panMoved && Math.hypot(e.clientX - panStartClient.x, e.clientY - panStartClient.y) > 4) {
        panMoved = true;
      }
      applyTransform();
      renderConnections();
    }

    if (isSelecting) {
      const containerRect = container.getBoundingClientRect();
      const rect = $('#selection-rect');
      if (!rect) return;

      const x = Math.min(e.clientX, selectionStart.x) - containerRect.left;
      const y = Math.min(e.clientY, selectionStart.y) - containerRect.top;
      const w = Math.abs(e.clientX - selectionStart.x);
      const h = Math.abs(e.clientY - selectionStart.y);

      rect.style.left = x + 'px';
      rect.style.top = y + 'px';
      rect.style.width = w + 'px';
      rect.style.height = h + 'px';
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (isPanning && e.button === 2) {
      isPanning = false;
      const c = $('#canvas-container');
      if (c) c.style.cursor = '';
    }

    if (isSelecting && e.button === 0) {
      isSelecting = false;
      const rect = $('#selection-rect');
      if (rect) rect.style.display = 'none';

      // Calculate selection box in canvas coordinates
      const containerRect = container.getBoundingClientRect();
      const sx = (Math.min(e.clientX, selectionStart.x) - containerRect.left - offset.x) / zoom;
      const sy = (Math.min(e.clientY, selectionStart.y) - containerRect.top - offset.y) / zoom;
      const sw = Math.abs(e.clientX - selectionStart.x) / zoom;
      const sh = Math.abs(e.clientY - selectionStart.y) / zoom;

      const dlg = State.getActiveGraph();
      if (dlg && sw > 5 && sh > 5) {
        // Marquee → select nodes inside (Shift adds to the current selection)
        if (!selectionAdditive) State.clearSelection();
        dlg.nodes.forEach((node) => {
          const nw = node.width || 240;
          const nh = node.height || 120;
          // Check overlap
          if (node.x + nw > sx && node.x < sx + sw && node.y + nh > sy && node.y < sy + sh) {
            State.addToSelection(node.id);
          }
        });
        render();
        if (onNodeSelectedCallback && State.getSelectedNodeId()) {
          onNodeSelectedCallback(State.getSelectedNodeId());
        } else if (onCanvasClickCallback && !State.getSelectedNodeId()) {
          // Marquee over empty space selected nothing → clear the inspector too
          onCanvasClickCallback();
        }
      } else {
        // Plain click on empty canvas → deselect (UE behaviour)
        State.clearSelection();
        if (onCanvasClickCallback) onCanvasClickCallback();
        render();
      }
    }
  });

  // Zoom
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prevZoom = zoom;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    zoom = Math.max(0.2, Math.min(3, zoom * factor));
    offset.x = mx - (mx - offset.x) * (zoom / prevZoom);
    offset.y = my - (my - offset.y) * (zoom / prevZoom);
    applyTransform();
    renderConnections();
  }, { passive: false });

  // Context menu on canvas background (suppressed if the RMB gesture was a pan)
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.dialogue-node')) return;
    e.preventDefault();
    if (consumeRmbPan()) return; // the user was panning, not asking for a menu
    // Cable right-clicks are handled by the path listeners in renderConnections
    if (e.target.closest('#canvas-svg')) return;
    const containerRect = container.getBoundingClientRect();
    const nodeX = (e.clientX - containerRect.left - offset.x) / zoom;
    const nodeY = (e.clientY - containerRect.top - offset.y) / zoom;

    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Agregar nodo aquí',
        action: 'add-node',
        handler: () => {
          const node = State.addNode(nodeX, nodeY);
          if (node) {
            State.setSelectedNodeId(node.id);
            render();
            if (onNodeSelectedCallback) onNodeSelectedCallback(node.id);
          }
        },
      },
      {
        label: '💬 Agregar comentario aquí',
        action: 'add-comment',
        handler: () => {
          const comment = State.addComment({ x: nodeX, y: nodeY, width: 400, height: 260, text: 'Comentario' });
          if (comment && onCommentSelectedCallback) onCommentSelectedCallback(comment.id);
        },
      },
      { label: 'Restablecer vista', action: 'reset', handler: () => resetView() },
    ]);
  });

  // Zoom buttons
  $('#btn-zoom-in').addEventListener('click', () => { zoom = Math.min(3, zoom * 1.15); applyTransform(); renderConnections(); });
  $('#btn-zoom-out').addEventListener('click', () => { zoom = Math.max(0.2, zoom * 0.85); applyTransform(); renderConnections(); });
  $('#btn-zoom-reset').addEventListener('click', () => resetView());
  $('#btn-fit').addEventListener('click', () => fitView());

  // Snap-to-grid button
  const snapBtn = $('#btn-snap');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => toggleSnap());
    updateSnapUI();
  }

  // Auto-layout button
  const autoLayoutBtn = $('#btn-auto-layout');
  if (autoLayoutBtn) {
    autoLayoutBtn.addEventListener('click', () => autoLayout());
  }

  // FAB add node
  $('#btn-add-node').addEventListener('click', () => {
    const dlg = State.getActiveGraph();
    if (!dlg) return;
    const rect = container.getBoundingClientRect();
    const cx = (rect.width / 2 - offset.x) / zoom;
    const cy = (rect.height / 2 - offset.y) / zoom;
    const spread = dlg.nodes.length * 30;
    const node = State.addNode(cx + spread, cy + spread);
    if (node) {
      State.setSelectedNodeId(node.id);
      render();
      if (onNodeSelectedCallback) onNodeSelectedCallback(node.id);
    }
  });
}

function resetView() { zoom = 1; offset.x = 0; offset.y = 0; applyTransform(); renderConnections(); }

// ─── AUTO-LAYOUT (BFS jerárquico centrado y sin solapamientos) ───────────
export function autoLayout() {
  const dlg = State.getActiveGraph();
  if (!dlg || dlg.nodes.length === 0) return;

  const NODE_W = 260;
  const NODE_H = 160;
  const COL_GAP = 80;  // horizontal gap between siblings
  const ROW_GAP = 100; // vertical gap between levels

  // Build adjacency
  const childrenOf = {};
  dlg.nodes.forEach((n) => { childrenOf[n.id] = []; });
  dlg.nodes.forEach((n) => {
    (n.connections || []).forEach((rawConn) => {
      const { targetId } = normalizeConnection(rawConn);
      if (childrenOf[targetId] !== undefined) {
        childrenOf[n.id].push(targetId);
      }
    });
  });

  // BFS to assign levels
  const levels = {};
  const visited = new Set();
  const startId = dlg.startNodeId || dlg.nodes[0].id;
  const queue = [startId];
  levels[startId] = 0;
  visited.add(startId);

  while (queue.length > 0) {
    const nodeId = queue.shift();
    const lvl = levels[nodeId];
    (childrenOf[nodeId] || []).forEach((childId) => {
      if (!visited.has(childId)) {
        visited.add(childId);
        levels[childId] = lvl + 1;
        queue.push(childId);
      }
    });
  }

  // Handle orphans (unreachable nodes)
  const maxLvl = Math.max(0, ...Object.values(levels));
  const orphanLevel = maxLvl + 1;
  dlg.nodes.forEach((n) => {
    if (!visited.has(n.id)) {
      levels[n.id] = orphanLevel;
      visited.add(n.id);
    }
  });

  // Group nodes by level
  const levelNodes = {};
  dlg.nodes.forEach((n) => {
    const lvl = levels[n.id];
    if (!levelNodes[lvl]) levelNodes[lvl] = [];
    levelNodes[lvl].push(n.id);
  });

  const PADDING_Y = 80;
  const pos = {};

  // Initialize root
  pos[startId] = { x: 400, y: PADDING_Y };

  // Calculate maximum level
  const allLevels = Object.keys(levelNodes).map(Number).sort((a, b) => a - b);

  // Initial layout: top-down parent-centered distribution
  allLevels.forEach((lvl) => {
    const nodeIds = levelNodes[lvl] || [];
    nodeIds.forEach((parentId) => {
      // Get children of this parent that are in the next level and not positioned yet
      const children = (childrenOf[parentId] || []).filter(
        (childId) => levels[childId] === lvl + 1 && pos[childId] === undefined
      );

      if (children.length > 0) {
        const parentPos = pos[parentId] || { x: 400, y: PADDING_Y + lvl * (NODE_H + ROW_GAP) };
        const parentCenterX = parentPos.x + NODE_W / 2;
        const totalW = children.length * NODE_W + (children.length - 1) * COL_GAP;
        let startX = parentCenterX - totalW / 2;

        children.forEach((childId) => {
          pos[childId] = {
            x: startX,
            y: PADDING_Y + (lvl + 1) * (NODE_H + ROW_GAP),
          };
          startX += NODE_W + COL_GAP;
        });
      }
    });
  });

  // Position any nodes that somehow missed positioning (e.g. orphans)
  dlg.nodes.forEach((n) => {
    if (pos[n.id] === undefined) {
      const lvl = levels[n.id];
      const siblings = levelNodes[lvl] || [];
      const index = siblings.indexOf(n.id);
      const totalW = siblings.length * NODE_W + (siblings.length - 1) * COL_GAP;
      const startX = 400 - totalW / 2;
      pos[n.id] = {
        x: startX + index * (NODE_W + COL_GAP),
        y: PADDING_Y + lvl * (NODE_H + ROW_GAP),
      };
    }
  });

  // Resolve overlaps level by level (left to right)
  allLevels.forEach((lvl) => {
    const nodeIds = levelNodes[lvl] || [];
    // Sort by current X position
    nodeIds.sort((a, b) => pos[a].x - pos[b].x);

    for (let i = 1; i < nodeIds.length; i++) {
      const prevId = nodeIds[i - 1];
      const currId = nodeIds[i];
      const minX = pos[prevId].x + NODE_W + COL_GAP;
      if (pos[currId].x < minX) {
        pos[currId].x = minX;
      }
    }
  });

  // Bottom-up pass to center parents over their children
  for (let i = allLevels.length - 2; i >= 0; i--) {
    const lvl = allLevels[i];
    const nodeIds = levelNodes[lvl] || [];

    nodeIds.forEach((parentId) => {
      const children = (childrenOf[parentId] || []).filter(
        (childId) => levels[childId] === lvl + 1
      );

      if (children.length > 0) {
        // Find bounds of children
        let minX = Infinity;
        let maxX = -Infinity;
        children.forEach((childId) => {
          const cx = pos[childId].x;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
        });
        const midX = (minX + maxX) / 2;
        pos[parentId].x = midX;

        // Resolve overlaps again for this level after shifting the parent
        const siblings = levelNodes[lvl] || [];
        siblings.sort((a, b) => pos[a].x - pos[b].x);
        for (let j = 1; j < siblings.length; j++) {
          const prevId = siblings[j - 1];
          const currId = siblings[j];
          const minX = pos[prevId].x + NODE_W + COL_GAP;
          if (pos[currId].x < minX) {
            pos[currId].x = minX;
          }
        }
      }
    });
  }

  // Apply final positions
  State.startBatch();
  dlg.nodes.forEach((n) => {
    if (pos[n.id] !== undefined) {
      State.updateNodePosition(n.id, pos[n.id].x, pos[n.id].y);
    }
  });
  State.endBatch();

  render();
  fitView();
}

function fitView() {
  const dlg = State.getActiveGraph();
  if (!dlg || dlg.nodes.length === 0) { resetView(); return; }
  const container = $('#canvas-container');
  const rect = container.getBoundingClientRect();
  const padding = 80;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  dlg.nodes.forEach((n) => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + 260); maxY = Math.max(maxY, n.y + 160); });
  const contentW = maxX - minX || 1;
  const contentH = maxY - minY || 1;
  const availW = rect.width - padding * 2;
  const availH = rect.height - padding * 2;
  zoom = Math.min(1.5, Math.min(availW / contentW, availH / contentH));
  offset.x = padding + (availW - contentW * zoom) / 2 - minX * zoom;
  offset.y = padding + (availH - contentH * zoom) / 2 - minY * zoom;
  applyTransform();
  renderConnections();
}

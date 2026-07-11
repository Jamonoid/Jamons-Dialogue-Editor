/**
 * Nodes — renders dialogue nodes and handles drag/connection interactions.
 * Simplified model: nodes connect directly to other nodes (no inline options).
 * Flow is TOP-TO-BOTTOM: input connector at top, output connector at bottom.
 */
import { $, $$, esc } from '../utils/helpers.js';
import { t, tPlaceholder, getLang, setText } from './lang.js';
import { showContextMenu, toast } from './ui.js';
import * as State from './state.js';
import { normalizeConnection } from './state.js';
import { isSnapEnabled } from './canvas.js';

// ─── Persistent drag/connection state (survives re-renders) ──
let draggingNodeId = null;
let dragOffset = { x: 0, y: 0 };
let dragStartPositions = {}; // For multi-drag
let isDrawing = false;
let drawFromNodeId = null;
let drawMode = 'out'; // 'out' = desde conector de salida, 'in' = desde conector de entrada
let tempLine = null;
let snapTargetId = null;
let snapCandidates = []; // conectores válidos como destino (cacheados al iniciar el drag)

// Resize state
let resizingNodeId = null;
let resizeStart = { x: 0, y: 0, width: 0, height: 0 };

// Store current callbacks & context
let activeCallbacks = null;
let activeDlg = null;

// ─── RENDER NODES ────────────────────────────────────
export function renderNodes(dlg, container) {
  const lang = getLang();

  container.innerHTML = dlg.nodes
    .map((node) => {
      const isStart = node.id === dlg.startNodeId;
      const isSelected = State.isNodeSelected(node.id);
      const text = t(node.text);
      const placeholder = tPlaceholder(node.text);
      const connCount = node.connections ? node.connections.length : 0;
      const isMultiBranch = connCount >= 2;

      // NPC color
      const npcColor = State.getNPCColor(node.npcId);
      const npc = node.npcId ? State.getNPC(node.npcId) : null;
      const npcName = npc ? npc.name : null;

      // Convert hex color to rgba for backgrounds
      const hexToRgba = (hex, alpha) => {
        if (!hex) return '';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      };

      // Build inline styles
      const nodeW = node.width || 240;
      let nodeStyle = `left: ${node.x}px; top: ${node.y}px; width: ${nodeW}px;`;
      if (node.height) nodeStyle += ` height: ${node.height}px;`;
      if (npcColor) nodeStyle += ` border-color: ${npcColor};`;
      if (npcColor && isSelected) nodeStyle += ` box-shadow: 0 0 0 2px ${hexToRgba(npcColor, 0.4)}, var(--shadow-lg);`;

      const placeholderText = lang === 'es' ? 'Escribe el diálogo...' : 'Write dialogue...';

      return `
      <div class="dialogue-node ${isStart && !npcColor ? 'start-node' : ''} ${isSelected ? 'selected' : ''}"
           data-node-id="${node.id}"
           style="${nodeStyle}">
        ${isStart ? '<div class="node-start-indicator" title="Nodo inicial">▶</div>' : ''}
        <div class="node-input-connector" data-input-node="${node.id}" title="Soltar un cable aquí, o arrastrar para conectar desde otro nodo" ${npcColor ? `style="border-color: ${npcColor}"` : ''}></div>
        <div class="node-header" ${npcColor ? `style="background: ${hexToRgba(npcColor, 0.1)}; border-bottom-color: ${hexToRgba(npcColor, 0.2)};"` : ''}>
          <span class="node-type-badge" ${npcColor ? `style="background: ${hexToRgba(npcColor, 0.15)}; color: ${npcColor};"` : ''}>${isStart ? 'INICIO' : (npcName ? esc(npcName) : 'NODO')}</span>
          <div class="node-metadata-badges">
            ${node.condition ? `<span class="meta-badge condition" title="Condición: ${node.condition}">IF</span>` : ''}
            ${node.action ? `<span class="meta-badge action" title="Acción: ${node.action}">DO</span>` : ''}
          </div>
          <span class="node-lang-badge">${lang.toUpperCase()}</span>
          <span class="node-id">#${node.id.slice(-5)}</span>
        </div>
        <div class="node-body">
          <textarea class="node-inline-text" data-text-node="${node.id}" placeholder="${placeholderText}">${text || ''}</textarea>
        </div>
        <div class="node-footer">
          ${connCount > 0
            ? isMultiBranch
              ? `<span class="node-conn-count branches">${connCount} ramas</span>`
              : `<span class="node-conn-count">${connCount} conexion${connCount !== 1 ? 'es' : ''}</span>`
            : '<span class="node-conn-label">Arrastrar ↓</span>'}
          <div class="node-output-connector" data-output-node="${node.id}" title="Arrastrar para conectar · soltar en el vacío crea un nodo nuevo" ${npcColor ? `style="border-color: ${npcColor}"` : ''}></div>
        </div>
        <div class="node-resize-handle" data-resize-node="${node.id}"></div>
      </div>
    `;
    })
    .join('');

  // Auto-resize all inline textareas
  container.querySelectorAll('.node-inline-text').forEach(autoResizeTextarea);
}

// ─── NODE INTERACTIONS ───────────────────────────────
export function setupNodeInteractions(dlg, callbacks) {
  activeCallbacks = callbacks;
  activeDlg = dlg;

  const { onSelect, offset } = callbacks;

  // ── Node mousedown → select + start drag ──
  $$('.dialogue-node').forEach((nodeEl) => {
    const nodeId = nodeEl.dataset.nodeId;

    nodeEl.addEventListener('mousedown', (e) => {
      if (
        e.target.classList.contains('node-output-connector') ||
        e.target.classList.contains('node-input-connector') ||
        e.target.classList.contains('node-resize-handle') ||
        e.target.classList.contains('node-inline-text')
      )
        return;
      if (e.button !== 0) return;
      e.stopPropagation();

      // Shift+click → toggle in multi-selection (don't call onSelect which resets)
      if (e.shiftKey) {
        State.toggleNodeSelection(nodeId);
        // Re-render without resetting selection
        if (activeCallbacks && activeCallbacks.onRender) activeCallbacks.onRender();
        return;
      }

      const currentZoom = activeCallbacks.zoom;
      const wasAlreadySelected = State.isNodeSelected(nodeId);
      const node = dlg.nodes.find((n) => n.id === nodeId);
      if (node) {
        // If not already selected, clear and select only this one
        if (!wasAlreadySelected) {
          State.setSelectedNodeId(nodeId);
        }

        State.pushUndoCheckpoint();
        draggingNodeId = nodeId;
        dragOffset.x = (e.clientX - offset.x) / currentZoom - node.x;
        dragOffset.y = (e.clientY - offset.y) / currentZoom - node.y;

        // Store start positions of all selected nodes for multi-drag
        dragStartPositions = {};
        State.getSelectedNodeIds().forEach((id) => {
          const n = dlg.nodes.find((nn) => nn.id === id);
          if (n) dragStartPositions[id] = { x: n.x, y: n.y };
        });
      }

      // Only call onSelect (which triggers render) if we changed the selection
      if (!wasAlreadySelected) {
        onSelect(nodeId);
      }
    });

    // ── Context menu on node ──
    nodeEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isStart = dlg.startNodeId === nodeId;

      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Duplicar nodo (Ctrl+D)',
          action: 'duplicate',
          handler: () => {
            const dup = State.duplicateNode(nodeId);
            if (dup) {
              State.setSelectedNodeId(dup.id);
              if (activeCallbacks && activeCallbacks.onSelect) {
                activeCallbacks.onSelect(dup.id);
              }
              toast('Nodo duplicado', 'success');
            }
          },
        },
        {
          label: isStart ? '✓ Nodo inicial' : 'Establecer como inicio',
          action: 'set-start',
          handler: () => State.setStartNode(nodeId),
        },
        { divider: true },
        {
          label: 'Eliminar nodo (Delete)',
          action: 'delete',
          danger: true,
          handler: () => State.deleteNode(nodeId),
        },
      ]);
    });
  });

  // ── Connectors → start drawing a connection (works from either end) ──
  $$('.node-output-connector').forEach((conn) => {
    conn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startDraw(conn.dataset.outputNode, 'out');
    });
  });

  $$('.node-input-connector').forEach((conn) => {
    conn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startDraw(conn.dataset.inputNode, 'in');
    });
  });

  // ── Resize handle → start resizing ──
  $$('.node-resize-handle').forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const nodeId = handle.dataset.resizeNode;
      const node = dlg.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      State.pushUndoCheckpoint();
      resizingNodeId = nodeId;
      // Get actual rendered height
      const nodeEl = $(`.dialogue-node[data-node-id="${nodeId}"]`);
      const currentHeight = node.height || (nodeEl ? nodeEl.offsetHeight / (activeCallbacks?.zoom || 1) : 120);
      resizeStart = {
        x: e.clientX,
        y: e.clientY,
        width: node.width || 240,
        height: currentHeight,
      };
    });
  });

  $$('.node-inline-text').forEach((textarea) => {
    const nodeId = textarea.dataset.textNode;

    textarea.addEventListener('input', (e) => {
      const node = dlg.nodes.find((n) => n.id === nodeId);
      if (node) {
        const updated = setText({ ...node.text }, e.target.value);
        State.updateNodeText(nodeId, updated);
      }
      autoResizeTextarea(textarea);
      // Update connections since node may have resized
      if (activeCallbacks && activeCallbacks.onPositionChange) {
        const node2 = dlg.nodes.find((n) => n.id === nodeId);
        if (node2) activeCallbacks.onPositionChange(nodeId, node2.x, node2.y);
      }
    });

    // Prevent node drag when clicking textarea
    textarea.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      // Select node silently (no re-render) so textarea keeps focus
      State.setSelectedNodeId(nodeId);
    });

    textarea.addEventListener('focus', () => {
      State.pushUndoCheckpoint();
      if (activeCallbacks && activeCallbacks.onSelect) {
        activeCallbacks.onSelect(nodeId);
      }
    });
  });
}

// ─── AUTO-RESIZE TEXTAREA ────────────────────────────
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

// ─── GLOBAL MOUSE HANDLERS (registered once) ─────────
let globalHandlersRegistered = false;

export function registerGlobalHandlers() {
  if (globalHandlersRegistered) return;
  globalHandlersRegistered = true;

  document.addEventListener('mousemove', (e) => {
    if (!activeCallbacks) return;

    const { offset, zoom, onPositionChange } = activeCallbacks;

    // Dragging node (with multi-select support)
    if (draggingNodeId && activeDlg) {
      const node = activeDlg.nodes.find((n) => n.id === draggingNodeId);
      if (node) {
        let newX = (e.clientX - offset.x) / zoom - dragOffset.x;
        let newY = (e.clientY - offset.y) / zoom - dragOffset.y;

        // Snap-to-grid
        if (typeof isSnapEnabled === 'function' ? isSnapEnabled() : false) {
          newX = Math.round(newX / 24) * 24;
          newY = Math.round(newY / 24) * 24;
        }

        // Calculate delta from dragged node's start position
        const startPos = dragStartPositions[draggingNodeId];
        const dx = newX - (startPos ? startPos.x : node.x);
        const dy = newY - (startPos ? startPos.y : node.y);

        // Move all selected nodes by the same delta
        State.getSelectedNodeIds().forEach((id) => {
          const n = activeDlg.nodes.find((nn) => nn.id === id);
          const sp = dragStartPositions[id];
          if (n && sp) {
            n.x = sp.x + dx;
            n.y = sp.y + dy;
            const el = $(`.dialogue-node[data-node-id="${id}"]`);
            if (el) {
              el.style.left = n.x + 'px';
              el.style.top = n.y + 'px';
            }
          }
        });

        if (onPositionChange) onPositionChange(draggingNodeId, newX, newY);
      }
    }

    // Drawing connection line
    if (isDrawing && tempLine && drawFromNodeId) {
      const originSelector = drawMode === 'out'
        ? `.node-output-connector[data-output-node="${drawFromNodeId}"]`
        : `.node-input-connector[data-input-node="${drawFromNodeId}"]`;
      const connEl = $(originSelector);
      if (!connEl) return;
      const container = $('#canvas-container');
      const connRect = connEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const x1 = connRect.left + connRect.width / 2 - containerRect.left;
      const y1 = connRect.top + connRect.height / 2 - containerRect.top;

      // Magnetic snap: nearest valid connector within radius
      const snapRadius = Math.max(24, 40 * zoom);
      let nearest = null;
      let nearestDist = Infinity;
      snapCandidates.forEach((c) => {
        const r = c.getBoundingClientRect();
        const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (dist < snapRadius && dist < nearestDist) {
          nearest = c;
          nearestDist = dist;
        }
      });

      const dataKey = drawMode === 'out' ? 'inputNode' : 'outputNode';
      const newSnapId = nearest ? nearest.dataset[dataKey] : null;
      if (newSnapId !== snapTargetId) setSnapTarget(newSnapId);

      let x2, y2;
      if (nearest) {
        const r = nearest.getBoundingClientRect();
        x2 = r.left + r.width / 2 - containerRect.left;
        y2 = r.top + r.height / 2 - containerRect.top;
        tempLine.classList.add('snapped');
      } else {
        x2 = e.clientX - containerRect.left;
        y2 = e.clientY - containerRect.top;
        tempLine.classList.remove('snapped');
      }

      const dy = Math.abs(y2 - y1) * 0.5;
      const d = drawMode === 'out'
        ? `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1} ${y1 - dy}, ${x2} ${y2 + dy}, ${x2} ${y2}`;
      tempLine.setAttribute('d', d);
    }

    // Resizing node
    if (resizingNodeId && activeDlg && activeCallbacks) {
      const node = activeDlg.nodes.find((n) => n.id === resizingNodeId);
      if (node) {
        const zoomFactor = activeCallbacks.zoom;
        const dx = (e.clientX - resizeStart.x) / zoomFactor;
        const dy = (e.clientY - resizeStart.y) / zoomFactor;
        const newWidth = Math.max(160, resizeStart.width + dx);
        const newHeight = Math.max(80, resizeStart.height + dy);
        node.width = newWidth;
        node.height = newHeight;

        const nodeEl = $(`.dialogue-node[data-node-id="${resizingNodeId}"]`);
        if (nodeEl) {
          nodeEl.style.width = newWidth + 'px';
          nodeEl.style.height = newHeight + 'px';
        }
        if (activeCallbacks.onPositionChange) {
          activeCallbacks.onPositionChange(resizingNodeId, node.x, node.y);
        }
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (draggingNodeId && activeDlg) {
      // Save final positions of all selected nodes
      State.getSelectedNodeIds().forEach((id) => {
        const n = activeDlg.nodes.find((nn) => nn.id === id);
        if (n) State.updateNodePosition(id, n.x, n.y);
      });
      draggingNodeId = null;
      dragStartPositions = {};
    }
    if (resizingNodeId && activeDlg) {
      const node = activeDlg.nodes.find((n) => n.id === resizingNodeId);
      if (node) {
        State.updateNodeSize(resizingNodeId, node.width, node.height);
      }
      resizingNodeId = null;
    }
    if (isDrawing && drawFromNodeId) {
      // Priority 1: magnetically snapped connector
      let targetNodeId = snapTargetId;

      // Priority 2: any part of a node under the cursor counts as a valid drop
      if (!targetNodeId) {
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const nodeEl = target ? target.closest('.dialogue-node') : null;
        if (nodeEl) targetNodeId = nodeEl.dataset.nodeId;
      }

      if (targetNodeId) {
        if (drawMode === 'out') tryConnect(drawFromNodeId, targetNodeId);
        else tryConnect(targetNodeId, drawFromNodeId);
      } else if (activeCallbacks) {
        // Released on empty space → create new node and connect
        const connOffset = activeCallbacks.offset;
        const connZoom = activeCallbacks.zoom;
        const container = $('#canvas-container');
        const containerRect = container.getBoundingClientRect();

        // Dropped outside the canvas (sidebar, inspector...) → just cancel
        const insideCanvas =
          e.clientX >= containerRect.left && e.clientX <= containerRect.right &&
          e.clientY >= containerRect.top && e.clientY <= containerRect.bottom;
        if (!insideCanvas) {
          endDraw();
          return;
        }

        const dropX = (e.clientX - containerRect.left - connOffset.x) / connZoom;
        const dropY = (e.clientY - containerRect.top - connOffset.y) / connZoom;
        // Position the new node so its connector lands where the cable was dropped
        const nodeX = dropX - 120;
        const nodeY = drawMode === 'out' ? dropY : dropY - 140;

        State.startBatch();
        const newNode = State.addNode(nodeX, nodeY);
        if (newNode) {
          if (drawMode === 'out') State.addConnection(drawFromNodeId, newNode.id);
          else State.addConnection(newNode.id, drawFromNodeId);
          State.setSelectedNodeId(newNode.id);
          State.endBatch();
          toast('Nodo creado y conectado', 'success');
        } else {
          State.endBatch();
        }
      }
      endDraw();
    }
  });

  // Escape → cancel in-progress cable or node drag
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    if (isDrawing) {
      endDraw();
      return;
    }

    if (draggingNodeId && activeDlg) {
      // Restore all dragged nodes to their start positions
      Object.entries(dragStartPositions).forEach(([id, sp]) => {
        const n = activeDlg.nodes.find((nn) => nn.id === id);
        if (n) {
          n.x = sp.x;
          n.y = sp.y;
          const el = $(`.dialogue-node[data-node-id="${id}"]`);
          if (el) {
            el.style.left = sp.x + 'px';
            el.style.top = sp.y + 'px';
          }
        }
      });
      if (activeCallbacks && activeCallbacks.onPositionChange) {
        const n = activeDlg.nodes.find((nn) => nn.id === draggingNodeId);
        if (n) activeCallbacks.onPositionChange(draggingNodeId, n.x, n.y);
      }
      draggingNodeId = null;
      dragStartPositions = {};
    }
  });
}

// ─── CONNECTION DRAWING ──────────────────────────────
function startDraw(fromNodeId, mode) {
  isDrawing = true;
  drawFromNodeId = fromNodeId;
  drawMode = mode;
  snapTargetId = null;

  const svg = $('#canvas-svg');
  tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tempLine.classList.add('temp-connection');
  svg.appendChild(tempLine);

  const container = $('#canvas-container');
  if (container) container.classList.add('drawing-connection');

  // Highlight valid drop targets and cache them for magnetic snapping
  const selector = mode === 'out' ? '.node-input-connector' : '.node-output-connector';
  const dataKey = mode === 'out' ? 'inputNode' : 'outputNode';
  snapCandidates = [];
  $$(selector).forEach((c) => {
    if (c.dataset[dataKey] !== fromNodeId) {
      c.classList.add('connect-target-highlight');
      snapCandidates.push(c);
    }
  });
}

function setSnapTarget(nodeId) {
  document.querySelectorAll('.connect-snap').forEach((c) => c.classList.remove('connect-snap'));
  document.querySelectorAll('.dialogue-node.connect-snap-node').forEach((n) => n.classList.remove('connect-snap-node'));
  snapTargetId = nodeId;
  if (!nodeId) return;
  const dataAttr = drawMode === 'out' ? 'data-input-node' : 'data-output-node';
  const connEl = document.querySelector(`[${dataAttr}="${nodeId}"]`);
  if (connEl) connEl.classList.add('connect-snap');
  const nodeEl = document.querySelector(`.dialogue-node[data-node-id="${nodeId}"]`);
  if (nodeEl) nodeEl.classList.add('connect-snap-node');
}

function tryConnect(sourceId, targetId) {
  if (sourceId === targetId) {
    toast('No se puede conectar un nodo consigo mismo', 'error');
    return;
  }
  const source = activeDlg ? activeDlg.nodes.find((n) => n.id === sourceId) : null;
  const exists = source && (source.connections || [])
    .map(normalizeConnection)
    .some((c) => c.targetId === targetId);
  if (exists) {
    toast('Esa conexión ya existe', 'info');
    return;
  }
  State.addConnection(sourceId, targetId);
  toast('Conexión creada', 'success');
}

function endDraw() {
  isDrawing = false;
  drawFromNodeId = null;
  snapTargetId = null;
  snapCandidates = [];
  if (tempLine) {
    tempLine.remove();
    tempLine = null;
  }
  const container = document.querySelector('#canvas-container');
  if (container) container.classList.remove('drawing-connection');
  document.querySelectorAll('.connect-target-highlight').forEach((ic) => ic.classList.remove('connect-target-highlight'));
  document.querySelectorAll('.connect-snap').forEach((c) => c.classList.remove('connect-snap'));
  document.querySelectorAll('.dialogue-node.connect-snap-node').forEach((n) => n.classList.remove('connect-snap-node'));
}

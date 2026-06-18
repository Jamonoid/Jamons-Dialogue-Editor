/**
 * Nodes — renders dialogue nodes and handles drag/connection interactions.
 * Simplified model: nodes connect directly to other nodes (no inline options).
 * Flow is TOP-TO-BOTTOM: input connector at top, output connector at bottom.
 */
import { $, $$ } from '../utils/helpers.js';
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
let tempLine = null;

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
        <div class="node-input-connector" data-input-node="${node.id}" title="Soltar conexión aquí" ${npcColor ? `style="border-color: ${npcColor}"` : ''}></div>
        <div class="node-header" ${npcColor ? `style="background: ${hexToRgba(npcColor, 0.1)}; border-bottom-color: ${hexToRgba(npcColor, 0.2)};"` : ''}>
          <span class="node-type-badge" ${npcColor ? `style="background: ${hexToRgba(npcColor, 0.15)}; color: ${npcColor};"` : ''}>${isStart ? 'INICIO' : (npcName || 'NODO')}</span>
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
          <div class="node-output-connector" data-output-node="${node.id}" title="Arrastrar para conectar" ${npcColor ? `style="border-color: ${npcColor}"` : ''}></div>
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
          label: 'Duplicar nodo',
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
          label: 'Eliminar nodo',
          action: 'delete',
          danger: true,
          handler: () => State.deleteNode(nodeId),
        },
      ]);
    });
  });

  // ── Output connector → start drawing connection ──
  $$('.node-output-connector').forEach((conn) => {
    conn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isDrawing = true;
      drawFromNodeId = conn.dataset.outputNode;

      const svg = $('#canvas-svg');
      tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tempLine.classList.add('temp-connection');
      svg.appendChild(tempLine);
    });
  });

  // ── Input connectors → receive connection ──
  $$('.node-input-connector').forEach((inputConn) => {
    inputConn.addEventListener('mouseup', (e) => {
      if (!isDrawing || !drawFromNodeId) return;
      e.stopPropagation();

      const targetNodeId = inputConn.dataset.inputNode;
      if (targetNodeId === drawFromNodeId) {
        toast('No se puede conectar un nodo consigo mismo', 'error');
        endDraw();
        return;
      }

      State.addConnection(drawFromNodeId, targetNodeId);
      toast('Conexión creada', 'success');
      endDraw();
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
      const connEl = $(`.node-output-connector[data-output-node="${drawFromNodeId}"]`);
      if (!connEl) return;
      const container = $('#canvas-container');
      const connRect = connEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const x1 = connRect.left + connRect.width / 2 - containerRect.left;
      const y1 = connRect.top + connRect.height / 2 - containerRect.top;
      const x2 = e.clientX - containerRect.left;
      const y2 = e.clientY - containerRect.top;
      const dy = Math.abs(y2 - y1) * 0.5;
      tempLine.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
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
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const isOnInputConnector = target && target.classList.contains('node-input-connector');

      if (!isOnInputConnector && activeCallbacks) {
        // Released on empty space → create new node and connect
        const connOffset = activeCallbacks.offset;
        const connZoom = activeCallbacks.zoom;
        const container = $('#canvas-container');
        const containerRect = container.getBoundingClientRect();
        const nodeX = (e.clientX - containerRect.left - connOffset.x) / connZoom;
        const nodeY = (e.clientY - containerRect.top - connOffset.y) / connZoom;

        State.startBatch();
        const newNode = State.addNode(nodeX, nodeY);
        if (newNode) {
          State.addConnection(drawFromNodeId, newNode.id);
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
}

function endDraw() {
  isDrawing = false;
  drawFromNodeId = null;
  if (tempLine) {
    tempLine.remove();
    tempLine = null;
  }
}

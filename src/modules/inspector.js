/**
 * Inspector — right panel showing properties of the selected element.
 * Simplified: no more inline options, shows direct connections.
 */
import { $, $$, esc } from '../utils/helpers.js';
import * as State from './state.js';
import { t, getLang, setText } from './lang.js';
import { toast, showAILoading, hideAILoading, showAIGenerateModal } from './ui.js';
import * as AI from './ai.js';

let currentTarget = null;
let renderedTarget = null;
let isEditing = false;

export function show(type, id) {
  currentTarget = { type, id };
  render();
}

export function clear() {
  currentTarget = null;
  render();
}

export function render() {
  if (isEditing) return;
  // Skip re-render if canvas inline textarea is focused AND we are already showing that node
  const focusedTextarea = document.querySelector('.node-inline-text:focus');
  if (focusedTextarea) {
    const focusedNodeId = focusedTextarea.dataset.textNode;
    if (
      currentTarget && currentTarget.type === 'node' && currentTarget.id === focusedNodeId &&
      renderedTarget && renderedTarget.type === 'node' && renderedTarget.id === focusedNodeId
    ) {
      return;
    }
  }
  const emptyEl = $('#inspector-empty');
  const contentEl = $('#inspector-content');

  // Multi-selection mode
  const selectedIds = State.getSelectedNodeIds();
  if (selectedIds.size > 1) {
    emptyEl.style.display = 'none';
    contentEl.style.display = '';
    renderMultiSelect(selectedIds);
    renderedTarget = { type: 'multi' };
    return;
  }

  if (!currentTarget) {
    emptyEl.style.display = '';
    contentEl.style.display = 'none';
    renderedTarget = null;
    return;
  }

  emptyEl.style.display = 'none';
  contentEl.style.display = '';

  const { type, id } = currentTarget;
  renderedTarget = { type, id };
  if (type === 'npc') renderNPC(id);
  else if (type === 'quest') renderQuest(id);
  else if (type === 'dialogue') renderDialogue(id);
  else if (type === 'node') renderNode(id);
}

// ─── Multi-select Inspector ─────────────────────────
function renderMultiSelect(selectedIds) {
  const el = $('#inspector-content');
  const count = selectedIds.size;
  el.innerHTML = `
    <div class="inspector-header">
      <div class="type-indicator node-type">✦</div>
      <h3>${count} nodos seleccionados</h3>
    </div>
    <div class="inspector-body">
      <p class="field-hint" style="margin-bottom:12px">Usa Shift+clic para añadir o quitar nodos de la selección.</p>
      <button class="btn btn-danger btn-block" id="insp-multi-delete">Eliminar ${count} nodos</button>
    </div>
  `;

  $('#insp-multi-delete').addEventListener('click', () => {
    const ids = [...selectedIds];
    ids.forEach((id) => State.deleteNode(id));
    clear();
  });
}

// ─── NPC Inspector ───────────────────────────────────
function renderNPC(id) {
  const npc = State.getNPC(id);
  if (!npc) return clear();

  const el = $('#inspector-content');
  el.innerHTML = `
    <div class="inspector-header">
      <div class="type-indicator npc-type" ${npc.color ? `style="background: ${npc.color}20; color: ${npc.color}; border-color: ${npc.color}40;"` : ''}>N</div>
      <h3>${esc(npc.name)}</h3>
    </div>
    <div class="inspector-body">
      <div class="field-group">
        <label class="field-label">Nombre</label>
        <input class="field-input" id="insp-npc-name" value="${esc(npc.name)}">
      </div>
      <div class="field-group">
        <label class="field-label">Color</label>
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="color" id="insp-npc-color" value="${npc.color || '#6c5ce7'}" style="width:40px;height:32px;border:none;background:none;cursor:pointer;padding:0;">
          <span style="font-size:12px;color:var(--text-muted)" id="insp-npc-color-hex">${npc.color || '#6c5ce7'}</span>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">ID</label>
        <input class="field-input" value="${npc.id}" readonly style="opacity:0.5;cursor:default;">
      </div>
      <button class="btn btn-danger btn-block" id="insp-npc-delete">Eliminar NPC</button>
    </div>
  `;

  $('#insp-npc-name').addEventListener('input', (e) => {
    isEditing = true;
    State.updateNPC(id, e.target.value);
    isEditing = false;
  });
  $('#insp-npc-name').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-npc-name').addEventListener('blur', () => {
    State.notifyChange();
  });
  $('#insp-npc-color').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-npc-color').addEventListener('input', (e) => {
    // Update silently (no re-render) so the native color picker stays open
    State.updateNPCColor(id, e.target.value);
    const hexLabel = $('#insp-npc-color-hex');
    if (hexLabel) hexLabel.textContent = e.target.value;
  });
  $('#insp-npc-color').addEventListener('change', () => {
    // Fires when the color picker closes — trigger full re-render now
    State.notifyChange();
  });
  $('#insp-npc-delete').addEventListener('click', () => {
    State.deleteNPC(id);
    clear();
  });
}

// ─── Quest Inspector ─────────────────────────────────
function renderQuest(id) {
  const { quests } = State.getState();
  const quest = quests.find((q) => q.id === id);
  if (!quest) return clear();

  const el = $('#inspector-content');
  el.innerHTML = `
    <div class="inspector-header">
      <div class="type-indicator quest-type">Q</div>
      <h3>${esc(quest.name)}</h3>
    </div>
    <div class="inspector-body">
      <div class="field-group">
        <label class="field-label">Nombre</label>
        <input class="field-input" id="insp-quest-name" value="${esc(quest.name)}">
      </div>
      <div class="field-group">
        <label class="field-label">ID</label>
        <input class="field-input" value="${quest.id}" readonly style="opacity:0.5;cursor:default;">
      </div>
      <button class="btn btn-danger btn-block" id="insp-quest-delete">Eliminar Quest</button>
    </div>
  `;

  $('#insp-quest-name').addEventListener('input', (e) => {
    isEditing = true;
    State.updateQuest(id, e.target.value);
    isEditing = false;
  });
  $('#insp-quest-name').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-quest-name').addEventListener('blur', () => {
    State.notifyChange();
  });
  $('#insp-quest-delete').addEventListener('click', () => {
    State.deleteQuest(id);
    clear();
  });
}

// ─── Dialogue Inspector ──────────────────────────────
function renderDialogue(id) {
  const { dialogues, npcs, quests } = State.getState();
  const dlg = dialogues.find((d) => d.id === id);
  if (!dlg) return clear();

  const el = $('#inspector-content');
  el.innerHTML = `
    <div class="inspector-header">
      <div class="type-indicator dialogue-type">D</div>
      <h3>${esc(dlg.title)}</h3>
    </div>
    <div class="inspector-body">
      <div class="field-group">
        <label class="field-label">Título</label>
        <input class="field-input" id="insp-dlg-title" value="${esc(dlg.title)}">
      </div>
      <div class="field-group">
        <label class="field-label">NPC</label>
        <select class="field-select" id="insp-dlg-npc">
          <option value="">— Sin NPC —</option>
          ${npcs.map((n) => `<option value="${n.id}" ${dlg.npcId === n.id ? 'selected' : ''}>${n.name}</option>`).join('')}
        </select>
      </div>
      <div class="field-group">
        <label class="field-label">Quest</label>
        <select class="field-select" id="insp-dlg-quest">
          <option value="">— Sin Quest —</option>
          ${quests.map((q) => `<option value="${q.id}" ${dlg.questId === q.id ? 'selected' : ''}>${q.name}</option>`).join('')}
        </select>
      </div>
      <div class="field-group">
        <label class="field-label">Nodos</label>
        <span style="font-size:13px;color:var(--text-secondary)">${dlg.nodes.length} nodo${dlg.nodes.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="field-group">
        <label class="field-label">ID</label>
        <input class="field-input" value="${dlg.id}" readonly style="opacity:0.5;cursor:default;">
      </div>
      <button class="btn btn-ai btn-block" id="insp-dlg-translate" style="margin-bottom:8px">🌐 Traducir Todo (ES → EN)</button>
      <button class="btn btn-ai btn-block" id="insp-dlg-generate" style="margin-bottom:8px">✨ Generar Diálogo con IA</button>
      <button class="btn btn-danger btn-block" id="insp-dlg-delete">Eliminar Diálogo</button>
    </div>
  `;

  $('#insp-dlg-title').addEventListener('input', (e) => {
    isEditing = true;
    State.updateDialogue(id, { title: e.target.value });
    isEditing = false;
  });
  $('#insp-dlg-title').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-dlg-title').addEventListener('blur', () => {
    State.notifyChange();
  });
  $('#insp-dlg-npc').addEventListener('change', (e) => {
    State.updateDialogue(id, { npcId: e.target.value || null });
  });
  $('#insp-dlg-quest').addEventListener('change', (e) => {
    State.updateDialogue(id, { questId: e.target.value || null });
  });
  $('#insp-dlg-delete').addEventListener('click', () => {
    State.deleteDialogue(id);
    clear();
  });

  $('#insp-dlg-translate').addEventListener('click', async () => {
    showAILoading('Traduciendo ES → EN...');
    try {
      const count = await AI.translateAllNodes();
      toast(count + ' nodos traducidos a EN', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      hideAILoading();
    }
  });

  $('#insp-dlg-generate').addEventListener('click', () => {
    const npc = dlg.npcId ? State.getNPC(dlg.npcId) : null;
    const hasExistingNodes = dlg.nodes.length > 1;
    showAIGenerateModal(npc?.name || '', async ({ prompt, minNodes, maxNodes, mode }) => {
      if (mode === 'extend') {
        showAILoading('Extendiendo diálogo...');
        try {
          const data = await AI.extendDialogue(prompt, npc?.name || '', { minNodes, maxNodes });
          const count = AI.insertExtendedDialogue(data);
          toast(count + ' nodos añadidos', 'success');
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
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          hideAILoading();
        }
      }
    }, { hasExistingNodes });
  });
}

// ─── Node Inspector ──────────────────────────────────
function renderNode(nodeId) {
  const dlg = State.getActiveDialogue();
  if (!dlg) return clear();
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) return clear();

  const isStart = dlg.startNodeId === nodeId;
  const lang = getLang();
  const currentText = t(node.text);
  const el = $('#inspector-content');
  const { npcs } = State.getState();

  // NPC info
  const npcColor = State.getNPCColor(node.npcId);
  const npc = node.npcId ? State.getNPC(node.npcId) : null;

  // Find connections FROM this node
  const outgoing = (node.connections || [])
    .map((c) => {
      const { targetId } = State.normalizeConnection(c);
      return dlg.nodes.find((n) => n.id === targetId);
    })
    .filter(Boolean);

  // Find connections TO this node
  const incoming = dlg.nodes.filter((n) =>
    n.connections && n.connections.some((c) => State.normalizeConnection(c).targetId === nodeId)
  );

  el.innerHTML = `
    <div class="inspector-header" ${npcColor ? `style="border-left: 3px solid ${npcColor};"` : ''}>
      <div class="type-indicator node-type" ${npcColor ? `style="background: ${npcColor}20; color: ${npcColor}; border-color: ${npcColor}40;"` : ''}>${isStart ? '▶' : (npc ? npc.name.charAt(0).toUpperCase() : 'N')}</div>
      <h3>Nodo ${isStart ? '(Inicio)' : ''}</h3>
      <span class="inspector-lang-badge">${lang.toUpperCase()}</span>
    </div>
    <div class="inspector-body">
      <div class="field-group">
        <label class="field-label">NPC del nodo</label>
        <select class="field-select" id="insp-node-npc">
          <option value="">— Sin NPC —</option>
          ${npcs.map((n) => `<option value="${n.id}" ${node.npcId === n.id ? 'selected' : ''} style="color: ${n.color || '#fff'}">${n.name}</option>`).join('')}
        </select>
      </div>

      <div class="field-group">
        <label class="field-label">Texto <span class="lang-hint">[${lang.toUpperCase()}]</span></label>
        <textarea class="field-textarea" id="insp-node-text" placeholder="Escribe el diálogo en ${lang === 'es' ? 'español' : 'inglés'}...">${currentText}</textarea>
      </div>

      <div class="field-group">
        <label class="field-label">Condición (Narrative Tales)</label>
        <input class="field-input" id="insp-node-condition" placeholder="Ej: tiene_llave == true" value="${node.condition || ''}">
      </div>

      <div class="field-group">
        <label class="field-label">Acción (Narrative Tales)</label>
        <input class="field-input" id="insp-node-action" placeholder="Ej: set tiene_llave = true" value="${node.action || ''}">
      </div>

      <!-- Outgoing connections -->
      <div class="connections-section">
        <div class="connections-header">
          <h4>Conexiones salientes (${outgoing.length})</h4>
        </div>
        <div id="insp-connections-list">
          ${outgoing.map((targetNode, idx) => {
            const targetText = t(targetNode.text);
            return `
              <div class="connection-card" data-nav-node="${targetNode.id}" style="cursor:pointer" title="Clic para ir al nodo">
                <span class="conn-preview">#${targetNode.id.slice(-5)} ${targetText ? '— ' + targetText.slice(0, 25) : '(sin texto)'}</span>
                <div class="conn-actions">
                  ${outgoing.length > 1 ? `<button class="conn-reorder" data-conn-target="${targetNode.id}" data-dir="up" title="Subir" ${idx === 0 ? 'disabled' : ''}>▲</button><button class="conn-reorder" data-conn-target="${targetNode.id}" data-dir="down" title="Bajar" ${idx === outgoing.length - 1 ? 'disabled' : ''}>▼</button>` : ''}
                  <button class="conn-delete" data-conn-target="${targetNode.id}" title="Eliminar conexión">×</button>
                </div>
              </div>
            `;
          }).join('')}
          ${outgoing.length === 0 ? '<p class="empty-state" style="padding:8px 0">Sin conexiones. Arrastra desde el conector ↓ del nodo.</p>' : ''}
        </div>
      </div>

      ${incoming.length > 0 ? `
      <div class="connections-section incoming">
        <div class="connections-header">
          <h4>Recibe de (${incoming.length})</h4>
        </div>
        ${incoming.map((src) => {
          const srcText = t(src.text);
          return `<div class="connection-card incoming-card" data-nav-node="${src.id}" style="cursor:pointer" title="Clic para ir al nodo">
            <span class="conn-preview">#${src.id.slice(-5)} ${srcText ? '— ' + srcText.slice(0, 25) : '(sin texto)'}</span>
          </div>`;
        }).join('')}
      </div>
      ` : ''}

      <div class="field-group" style="margin-top: 4px;">
        <label class="field-label">ID</label>
        <input class="field-input" value="${node.id}" readonly style="opacity:0.5;cursor:default;">
      </div>

      <div style="margin-top:8px">
        ${!isStart ? '<button class="btn btn-block" id="insp-set-start" style="margin-bottom:8px">Establecer como inicio</button>' : ''}
        <button class="btn btn-block" id="insp-duplicate" style="margin-bottom:8px">Duplicar nodo</button>
        <button class="btn btn-ai btn-block" id="insp-node-translate" style="margin-bottom:8px">🌐 Traducir ES → EN</button>
        <button class="btn btn-danger btn-block" id="insp-node-delete">Eliminar Nodo</button>
      </div>
    </div>
  `;

  // ── Event listeners ──
  $('#insp-node-npc').addEventListener('change', (e) => {
    State.updateNodeNPC(nodeId, e.target.value);
  });

  $('#insp-node-text').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });

  $('#insp-node-text').addEventListener('input', (e) => {
    isEditing = true;
    const updated = setText({ ...node.text }, e.target.value);
    State.updateNodeText(nodeId, updated);
    isEditing = false;
  });

  $('#insp-node-condition').addEventListener('input', (e) => {
    isEditing = true;
    State.updateNodeCondition(nodeId, e.target.value);
    isEditing = false;
  });
  $('#insp-node-condition').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-node-condition').addEventListener('blur', () => {
    State.notifyChange();
  });

  $('#insp-node-action').addEventListener('input', (e) => {
    isEditing = true;
    State.updateNodeAction(nodeId, e.target.value);
    isEditing = false;
  });
  $('#insp-node-action').addEventListener('focus', () => {
    State.pushUndoCheckpoint();
  });
  $('#insp-node-action').addEventListener('blur', () => {
    State.notifyChange();
  });

  // Remove connection buttons
  $$('.conn-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      State.removeConnection(nodeId, btn.dataset.connTarget);
    });
  });

  // Q5: Reorder connection buttons
  $$('.conn-reorder').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      State.reorderConnection(nodeId, btn.dataset.connTarget, btn.dataset.dir);
    });
  });

  // Q4: Navigate to node on connection card click
  $$('.connection-card[data-nav-node]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('conn-delete') || e.target.classList.contains('conn-reorder')) return;
      const targetId = card.dataset.navNode;
      State.setSelectedNodeId(targetId);
      show('node', targetId);
    });
  });

  const startBtn = $('#insp-set-start');
  if (startBtn) {
    startBtn.addEventListener('click', () => State.setStartNode(nodeId));
  }

  $('#insp-duplicate').addEventListener('click', () => {
    const dup = State.duplicateNode(nodeId);
    if (dup) {
      State.setSelectedNodeId(dup.id);
      show('node', dup.id);
    }
  });

  $('#insp-node-delete').addEventListener('click', () => {
    State.deleteNode(nodeId);
    clear();
  });

  $('#insp-node-translate').addEventListener('click', async () => {
    showAILoading('Traduciendo nodo...');
    try {
      await AI.translateNode(nodeId);
      toast('Nodo traducido a EN', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      hideAILoading();
    }
  });
}

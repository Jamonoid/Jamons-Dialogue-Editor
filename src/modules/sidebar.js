/**
 * Sidebar — renders NPC, Quest, and Dialogue lists in the left panel.
 */
import { $, $$ } from '../utils/helpers.js';
import * as State from './state.js';
import { showModal, showContextMenu, toast } from './ui.js';

let onSelectCallback = null;

export function onSelect(cb) {
  onSelectCallback = cb;
}

export function render() {
  renderNPCs();
  renderQuests();
  renderDialogues();
}

// ─── NPCs ────────────────────────────────────────────
function renderNPCs() {
  const list = $('#npc-list');
  const { npcs } = State.getState();

  if (npcs.length === 0) {
    list.innerHTML = '<li class="empty-state">Sin NPCs aún</li>';
    return;
  }

  list.innerHTML = npcs
    .map(
      (n) => `
    <li class="section-list-item" data-type="npc" data-id="${n.id}">
      <span class="item-icon npc-icon">N</span>
      <span class="item-name">${n.name}</span>
      <button class="item-delete" data-delete="npc" data-id="${n.id}" title="Eliminar">×</button>
    </li>
  `
    )
    .join('');

  attachListEvents(list, 'npc');
}

function renderQuests() {
  const list = $('#quest-list');
  const { quests } = State.getState();

  if (quests.length === 0) {
    list.innerHTML = '<li class="empty-state">Sin Quests aún</li>';
    return;
  }

  list.innerHTML = quests
    .map(
      (q) => `
    <li class="section-list-item" data-type="quest" data-id="${q.id}">
      <span class="item-icon quest-icon">Q</span>
      <span class="item-name">${q.name}</span>
      <button class="item-delete" data-delete="quest" data-id="${q.id}" title="Eliminar">×</button>
    </li>
  `
    )
    .join('');

  attachListEvents(list, 'quest');
}

function renderDialogues() {
  const list = $('#dialogue-list');
  const { dialogues, npcs } = State.getState();
  const activeId = State.getActiveDialogueId();

  if (dialogues.length === 0) {
    list.innerHTML = '<li class="empty-state">Sin diálogos aún</li>';
    return;
  }

  list.innerHTML = dialogues
    .map((d) => {
      const npc = npcs.find((n) => n.id === d.npcId);
      return `
      <li class="section-list-item ${activeId === d.id ? 'active' : ''}" data-type="dialogue" data-id="${d.id}">
        <span class="item-icon dialogue-icon">D</span>
        <span class="item-name">${d.title}${npc ? ` <span style="color:var(--text-muted);font-size:11px">· ${npc.name}</span>` : ''}</span>
        <button class="item-delete" data-delete="dialogue" data-id="${d.id}" title="Eliminar">×</button>
      </li>
    `;
    })
    .join('');

  attachListEvents(list, 'dialogue');
}

function attachListEvents(list, type) {
  $$(`.section-list-item[data-type="${type}"]`, list).forEach((item) => {
    const id = item.dataset.id;

    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('item-delete')) return;
      if (type === 'dialogue') {
        State.setActiveDialogueId(id);
      }
      if (onSelectCallback) onSelectCallback(type, id);
    });

    item.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('item-delete')) return;
      if (type === 'npc') editNPC(id);
      else if (type === 'quest') editQuest(id);
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menuItems = [];
      if (type !== 'dialogue') {
        menuItems.push({
          label: 'Editar',
          action: 'edit',
          handler: () => {
            if (type === 'npc') editNPC(id);
            else if (type === 'quest') editQuest(id);
          },
        });
      }
      menuItems.push({ divider: true });
      menuItems.push({
        label: 'Eliminar',
        action: 'delete',
        danger: true,
        handler: () => {
          if (type === 'npc') State.deleteNPC(id);
          else if (type === 'quest') State.deleteQuest(id);
          else if (type === 'dialogue') State.deleteDialogue(id);
        },
      });
      showContextMenu(e.clientX, e.clientY, menuItems);
    });
  });

  // Delete buttons
  $$('.item-delete', list).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const deleteType = btn.dataset.delete;
      const deleteId = btn.dataset.id;
      if (deleteType === 'npc') State.deleteNPC(deleteId);
      else if (deleteType === 'quest') State.deleteQuest(deleteId);
      else if (deleteType === 'dialogue') State.deleteDialogue(deleteId);
    });
  });
}

// ─── EDIT MODALS ─────────────────────────────────────
function editNPC(id) {
  const npc = State.getNPC(id);
  if (!npc) return;
  showModal(
    'Editar NPC',
    [{ key: 'name', label: 'Nombre', value: npc.name }],
    (vals) => {
      if (!vals.name) return;
      State.updateNPC(id, vals.name);
    }
  );
}

function editQuest(id) {
  const { quests } = State.getState();
  const quest = quests.find((q) => q.id === id);
  if (!quest) return;
  showModal(
    'Editar Quest',
    [{ key: 'name', label: 'Nombre', value: quest.name }],
    (vals) => {
      if (!vals.name) return;
      State.updateQuest(id, vals.name);
    }
  );
}

// ─── ADD BUTTONS ─────────────────────────────────────
export function setupAddButtons() {
  $('#btn-add-npc').addEventListener('click', () => {
    showModal(
      'Nuevo NPC',
      [{ key: 'name', label: 'Nombre', placeholder: 'Ej: Tabernero' }],
      (vals) => {
        if (!vals.name) return toast('El nombre no puede estar vacío', 'error');
        State.addNPC(vals.name);
      }
    );
  });

  $('#btn-add-quest').addEventListener('click', () => {
    showModal(
      'Nueva Quest',
      [
        {
          key: 'name',
          label: 'Nombre',
          placeholder: 'Ej: La espada perdida',
        },
      ],
      (vals) => {
        if (!vals.name) return toast('El nombre no puede estar vacío', 'error');
        State.addQuest(vals.name);
      }
    );
  });

  $('#btn-add-dialogue').addEventListener('click', () => {
    const { npcs, quests } = State.getState();
    showModal(
      'Nuevo Diálogo',
      [
        {
          key: 'title',
          label: 'Título',
          placeholder: 'Ej: Conversación inicial',
        },
        {
          key: 'npcId',
          label: 'NPC',
          type: 'select',
          value: '',
          options: [
            { value: '', label: '— Sin NPC —' },
            ...npcs.map((n) => ({ value: n.id, label: n.name })),
          ],
        },
        {
          key: 'questId',
          label: 'Quest (opcional)',
          type: 'select',
          value: '',
          options: [
            { value: '', label: '— Sin Quest —' },
            ...quests.map((q) => ({ value: q.id, label: q.name })),
          ],
        },
      ],
      (vals) => {
        if (!vals.title)
          return toast('El título no puede estar vacío', 'error');
        State.addDialogue(vals.title, vals.npcId, vals.questId);
      }
    );
  });
}

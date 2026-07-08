/**
 * Sidebar — renders NPC, Quest, and Dialogue lists in the left panel.
 */
import { $, $$, esc } from '../utils/helpers.js';
import * as State from './state.js';
import { showModal, showContextMenu, toast, confirmDelete } from './ui.js';

let onSelectCallback = null;

// ─── DIALOGUE VIEW PREFS (group / sort / filter) ─────
const DIALOGUE_VIEW_KEY = 'df_dialogue_view';
const dialogueView = loadDialogueView();
let dialogueFilter = ''; // in-memory only (not persisted)

function loadDialogueView() {
  try {
    const saved = JSON.parse(localStorage.getItem(DIALOGUE_VIEW_KEY) || '{}');
    return {
      groupBy: ['none', 'npc', 'quest'].includes(saved.groupBy) ? saved.groupBy : 'none',
      sortBy: ['manual', 'title-asc', 'title-desc'].includes(saved.sortBy) ? saved.sortBy : 'manual',
    };
  } catch {
    return { groupBy: 'none', sortBy: 'manual' };
  }
}

function saveDialogueView() {
  try {
    localStorage.setItem(
      DIALOGUE_VIEW_KEY,
      JSON.stringify({ groupBy: dialogueView.groupBy, sortBy: dialogueView.sortBy })
    );
  } catch (e) {}
}

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
    <li class="section-list-item" draggable="true" data-type="npc" data-id="${n.id}">
      <span class="item-drag-handle" title="Arrastrar para reordenar">⠿</span>
      <span class="item-icon npc-icon">N</span>
      <span class="item-name">${esc(n.name)}</span>
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
    <li class="section-list-item" draggable="true" data-type="quest" data-id="${q.id}">
      <span class="item-drag-handle" title="Arrastrar para reordenar">⠿</span>
      <span class="item-icon quest-icon">Q</span>
      <span class="item-name">${esc(q.name)}</span>
      <button class="item-delete" data-delete="quest" data-id="${q.id}" title="Eliminar">×</button>
    </li>
  `
    )
    .join('');

  attachListEvents(list, 'quest');
}

function dialogueItemHTML(d, index, activeId, npcById, draggable) {
  const npc = npcById.get(d.npcId);
  // Hide the NPC suffix when we're already grouping by NPC (redundant).
  const showNpc = npc && dialogueView.groupBy !== 'npc';
  const npcColor = npc && npc.color ? npc.color : null;
  return `
    <li class="section-list-item ${activeId === d.id ? 'active' : ''}" ${draggable ? 'draggable="true"' : ''} data-type="dialogue" data-id="${d.id}" data-index="${index}">
      ${draggable ? '<span class="item-drag-handle" title="Arrastrar para reordenar">⠿</span>' : ''}
      <span class="item-icon dialogue-icon"${npcColor ? ` style="background:${npcColor}20;color:${npcColor};border-color:${npcColor}33"` : ''}>D</span>
      <span class="item-name">${esc(d.title)}${showNpc ? ` <span style="color:var(--text-muted);font-size:11px">· ${esc(npc.name)}</span>` : ''}</span>
      <button class="item-delete" data-delete="dialogue" data-id="${d.id}" title="Eliminar">×</button>
    </li>`;
}

function sortDialogueItems(items) {
  const { sortBy } = dialogueView;
  if (sortBy === 'manual') return items.slice().sort((a, b) => a.index - b.index);
  const dir = sortBy === 'title-desc' ? -1 : 1;
  return items.slice().sort(
    (a, b) =>
      dir *
      (a.d.title || '').localeCompare(b.d.title || '', 'es', { sensitivity: 'base' })
  );
}

function renderDialogues() {
  const list = $('#dialogue-list');
  const { dialogues, npcs, quests } = State.getState();
  const activeId = State.getActiveDialogueId();

  // Keep the filter clear button in sync with the input's content.
  const clearBtn = $('#dialogue-filter-clear');
  if (clearBtn) clearBtn.style.display = dialogueFilter ? '' : 'none';

  if (dialogues.length === 0) {
    list.innerHTML = '<li class="empty-state">Sin diálogos aún</li>';
    return;
  }

  const npcById = new Map(npcs.map((n) => [n.id, n]));
  const questById = new Map(quests.map((q) => [q.id, q]));

  // Preserve the original index so manual order / reordering still works.
  let items = dialogues.map((d, index) => ({ d, index }));

  // ── Filter (by title, NPC name or Quest name) ──
  const q = dialogueFilter.trim().toLowerCase();
  if (q) {
    items = items.filter(({ d }) => {
      const npc = npcById.get(d.npcId);
      const quest = questById.get(d.questId);
      return (
        (d.title || '').toLowerCase().includes(q) ||
        (npc?.name || '').toLowerCase().includes(q) ||
        (quest?.name || '').toLowerCase().includes(q)
      );
    });
    if (items.length === 0) {
      list.innerHTML = '<li class="empty-state">Sin resultados</li>';
      return;
    }
  }

  const { groupBy } = dialogueView;
  // Drag-reorder only makes sense on the raw, ungrouped, unfiltered manual list.
  const canReorder = groupBy === 'none' && dialogueView.sortBy === 'manual' && !q;

  if (groupBy === 'none') {
    const sorted = sortDialogueItems(items);
    list.innerHTML = sorted
      .map(({ d, index }) => dialogueItemHTML(d, index, activeId, npcById, canReorder))
      .join('');
    attachListEvents(list, 'dialogue', canReorder);
    return;
  }

  // ── Grouped rendering ──
  const NONE_KEY = '__none__';
  const groups = new Map();
  for (const it of items) {
    let key, label;
    if (groupBy === 'npc') {
      const npc = npcById.get(it.d.npcId);
      key = npc ? npc.id : NONE_KEY;
      label = npc ? npc.name : 'Sin NPC';
    } else {
      const quest = questById.get(it.d.questId);
      key = quest ? quest.id : NONE_KEY;
      label = quest ? quest.name : 'Sin Quest';
    }
    if (!groups.has(key)) groups.set(key, { label, items: [] });
    groups.get(key).items.push(it);
  }

  // Order groups following the sidebar order of NPCs/Quests, with the
  // "unassigned" bucket last.
  const orderedKeys = [];
  const sourceList = groupBy === 'npc' ? npcs : quests;
  for (const s of sourceList) if (groups.has(s.id)) orderedKeys.push(s.id);
  if (groups.has(NONE_KEY)) orderedKeys.push(NONE_KEY);

  list.innerHTML = orderedKeys
    .map((key) => {
      const g = groups.get(key);
      const rows = sortDialogueItems(g.items)
        .map(({ d, index }) => dialogueItemHTML(d, index, activeId, npcById, false))
        .join('');
      return `
      <li class="dialogue-group-header">
        <span class="dialogue-group-label">${esc(g.label)}</span>
        <span class="dialogue-group-count">${g.items.length}</span>
      </li>${rows}`;
    })
    .join('');

  attachListEvents(list, 'dialogue', false);
}

function attachListEvents(list, type, enableDnD = true) {
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
      else if (type === 'dialogue') editDialogue(id);
    });

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menuItems = [];
      menuItems.push({
        label: 'Editar',
        action: 'edit',
        handler: () => {
          if (type === 'npc') editNPC(id);
          else if (type === 'quest') editQuest(id);
          else if (type === 'dialogue') editDialogue(id);
        },
      });
      menuItems.push({ divider: true });
      menuItems.push({
        label: 'Eliminar',
        action: 'delete',
        danger: true,
        handler: () => {
          const name = type === 'npc' ? State.getNPC(id)?.name
            : type === 'quest' ? State.getState().quests.find(q => q.id === id)?.name
            : State.getState().dialogues.find(d => d.id === id)?.title;
          confirmDelete(`¿Eliminar ${type === 'npc' ? 'NPC' : type === 'quest' ? 'Quest' : 'Diálogo'} "${name || ''}"? Esta acción no se puede deshacer fácilmente.`, () => {
            if (type === 'npc') State.deleteNPC(id);
            else if (type === 'quest') State.deleteQuest(id);
            else if (type === 'dialogue') State.deleteDialogue(id);
          });
        },
      });
      showContextMenu(e.clientX, e.clientY, menuItems);
    });
  });

  $$('.item-delete', list).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const deleteType = btn.dataset.delete;
      const deleteId = btn.dataset.id;
      const name = deleteType === 'npc' ? State.getNPC(deleteId)?.name
        : deleteType === 'quest' ? State.getState().quests.find(q => q.id === deleteId)?.name
        : State.getState().dialogues.find(d => d.id === deleteId)?.title;
      confirmDelete(`¿Eliminar ${deleteType === 'npc' ? 'NPC' : deleteType === 'quest' ? 'Quest' : 'Diálogo'} "${name || ''}"?`, () => {
        if (deleteType === 'npc') State.deleteNPC(deleteId);
        else if (deleteType === 'quest') State.deleteQuest(deleteId);
        else if (deleteType === 'dialogue') State.deleteDialogue(deleteId);
      });
    });
  });

  // Drag & drop reordering (disabled when grouped/filtered/sorted)
  if (enableDnD) setupDragAndDrop(list, type);
}

// ─── DRAG & DROP REORDER ─────────────────────────────
const TYPE_TO_COLLECTION = { npc: 'npcs', quest: 'quests', dialogue: 'dialogues' };

function setupDragAndDrop(list, type) {
  const items = [...list.querySelectorAll(`.section-list-item[data-type="${type}"]`)];
  const collection = TYPE_TO_COLLECTION[type];
  if (!collection) return;

  let draggedEl = null;

  items.forEach((item, index) => {
    item.dataset.index = index;

    item.addEventListener('dragstart', (e) => {
      draggedEl = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    });

    item.addEventListener('dragend', () => {
      if (draggedEl) draggedEl.classList.remove('dragging');
      draggedEl = null;
      // Clean up all indicators
      items.forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (item === draggedEl) return;

      // Determine if cursor is in top or bottom half
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;

      // Clear all indicators, then set the right one
      items.forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
      item.classList.add(isAbove ? 'drag-over-top' : 'drag-over-bottom');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (item === draggedEl) return;

      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      let toIndex = parseInt(item.dataset.index);

      // If dropping on the bottom half, insert after this item
      if (e.clientY >= midY && toIndex < fromIndex) toIndex++;
      if (e.clientY < midY && toIndex > fromIndex) toIndex--;

      State.reorderList(collection, fromIndex, toIndex);
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
      State.notifyChange();
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
      State.notifyChange();
    }
  );
}

function editDialogue(id) {
  const dlg = State.getState().dialogues.find((d) => d.id === id);
  if (!dlg) return;
  showModal(
    'Editar Diálogo',
    [{ key: 'title', label: 'Título', value: dlg.title }],
    (vals) => {
      if (!vals.title) return;
      State.updateDialogue(id, { title: vals.title });
      State.notifyChange();
    }
  );
}

// ─── ADD BUTTONS ─────────────────────────────────────
export function setupAddButtons() {
  // Q9: Collapsible sidebar sections
  setupCollapsibleSections();

  // Dialogue view controls: filter, group by, sort by
  setupDialogueControls();

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

// ─── DIALOGUE VIEW CONTROLS ──────────────────────────
function setupDialogueControls() {
  const filterInput = $('#dialogue-filter');
  const clearBtn = $('#dialogue-filter-clear');
  const groupSel = $('#dialogue-group-by');
  const sortSel = $('#dialogue-sort-by');

  // Restore persisted preferences into the selects.
  if (groupSel) groupSel.value = dialogueView.groupBy;
  if (sortSel) sortSel.value = dialogueView.sortBy;

  if (filterInput) {
    filterInput.addEventListener('input', () => {
      dialogueFilter = filterInput.value;
      renderDialogues();
    });
  }

  if (clearBtn && filterInput) {
    clearBtn.addEventListener('click', () => {
      dialogueFilter = '';
      filterInput.value = '';
      filterInput.focus();
      renderDialogues();
    });
  }

  if (groupSel) {
    groupSel.addEventListener('change', () => {
      dialogueView.groupBy = groupSel.value;
      saveDialogueView();
      renderDialogues();
    });
  }

  if (sortSel) {
    sortSel.addEventListener('change', () => {
      dialogueView.sortBy = sortSel.value;
      saveDialogueView();
      renderDialogues();
    });
  }
}

// ─── COLLAPSIBLE SECTIONS (Q9) ───────────────────────
function setupCollapsibleSections() {
  const STORAGE_KEY = 'df_collapsed_sections';
  const collapsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

  // Apply initial state
  Object.entries(collapsed).forEach(([section, isCollapsed]) => {
    if (isCollapsed) {
      const sectionEl = document.querySelector(`.sidebar-section[data-section="${section}"]`);
      if (sectionEl) sectionEl.classList.add('collapsed');
    }
  });

  // Click handlers
  $$('[data-collapse]').forEach((header) => {
    header.addEventListener('click', (e) => {
      // Don't collapse when clicking the add button
      if (e.target.closest('.section-add-btn')) return;
      const section = header.dataset.collapse;
      const sectionEl = header.closest('.sidebar-section');
      if (!sectionEl) return;
      sectionEl.classList.toggle('collapsed');
      collapsed[section] = sectionEl.classList.contains('collapsed');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
    });
  });
}

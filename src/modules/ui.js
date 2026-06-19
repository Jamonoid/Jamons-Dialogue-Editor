/**
 * UI utilities — modals, toasts, context menus.
 */
import { $ } from '../utils/helpers.js';

// ─── TOAST ───────────────────────────────────────────
export function toast(msg, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

// ─── CONFIRM DELETE ──────────────────────────────────
/**
 * Show a confirmation modal before a destructive action.
 * @param {string} message - What is being deleted (shown to user).
 * @param {Function} onConfirm - Called if user confirms.
 */
export function confirmDelete(message, onConfirm) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');

  modal.innerHTML = `
    <div class="modal-header"><h3>Confirmar eliminación</h3></div>
    <div class="modal-body">
      <p style="color: var(--text-secondary); font-size: 14px;">${message}</p>
    </div>
    <div class="modal-footer">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn btn-danger" id="modal-confirm">Eliminar</button>
    </div>
  `;

  overlay.classList.add('active');

  const close = () => overlay.classList.remove('active');
  $('#modal-cancel').onclick = close;
  overlay.onmousedown = (e) => { if (e.target === overlay) close(); };
  $('#modal-confirm').onclick = () => {
    close();
    onConfirm();
  };
  modal.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#modal-confirm').click(); }
    if (e.key === 'Escape') close();
  };
}

// ─── MODAL ───────────────────────────────────────────
export function showModal(title, fields, onConfirm) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');

  modal.innerHTML = `
    <div class="modal-header"><h3>${title}</h3></div>
    <div class="modal-body">
      ${fields
        .map(
          (f) => `
        <div class="field-group">
          <label class="field-label">${f.label}</label>
          ${
            f.type === 'textarea'
              ? `<textarea class="field-textarea" id="modal-${f.key}" placeholder="${f.placeholder || ''}">${f.value || ''}</textarea>`
              : f.type === 'select'
                ? `<select class="field-select" id="modal-${f.key}">
                     ${f.options.map((o) => `<option value="${o.value}" ${o.value === f.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                   </select>`
                : `<input class="field-input" type="text" id="modal-${f.key}" value="${f.value || ''}" placeholder="${f.placeholder || ''}">`
          }
        </div>
      `
        )
        .join('')}
    </div>
    <div class="modal-footer">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn btn-primary" id="modal-confirm">Confirmar</button>
    </div>
  `;

  overlay.classList.add('active');

  const firstInput = modal.querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 100);

  const close = () => overlay.classList.remove('active');

  $('#modal-cancel').onclick = close;
  overlay.onmousedown = (e) => {
    if (e.target === overlay) close();
  };
  $('#modal-confirm').onclick = () => {
    const values = {};
    fields.forEach((f) => {
      const el = $(`#modal-${f.key}`);
      values[f.key] = el ? el.value.trim() : '';
    });
    onConfirm(values);
    close();
  };

  modal.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('#modal-confirm').click();
    }
    if (e.key === 'Escape') {
      close();
    }
  };
}

// ─── CONTEXT MENU ────────────────────────────────────
let menuHandlers = new Map();
let closeHandler = null;

function cleanupContextMenu() {
  if (closeHandler) {
    document.removeEventListener('mousedown', closeHandler, true);
    closeHandler = null;
  }
  menuHandlers.clear();
}

export function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  cleanupContextMenu();

  // Store handlers by action name
  items.forEach((item) => {
    if (item.action && item.handler) {
      menuHandlers.set(item.action, item.handler);
    }
  });

  menu.innerHTML = items
    .map((item) => {
      if (item.divider) return '<div class="ctx-divider"></div>';
      return `<button class="ctx-item ${item.danger ? 'danger' : ''}" data-action="${item.action}">${item.icon || ''} ${item.label}</button>`;
    })
    .join('');

  // Position (keep on screen)
  const menuW = 200;
  const menuH = items.length * 36;
  const safeX = Math.min(x, window.innerWidth - menuW - 8);
  const safeY = Math.min(y, window.innerHeight - menuH - 8);
  menu.style.left = safeX + 'px';
  menu.style.top = safeY + 'px';
  menu.classList.add('active');

  // Attach click handlers — execute SYNCHRONOUSLY, no requestAnimationFrame
  menu.querySelectorAll('.ctx-item').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      // Prevent this mousedown from reaching the canvas
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const action = btn.dataset.action;
      const handler = menuHandlers.get(action);
      menu.classList.remove('active');
      cleanupContextMenu();
      // Execute handler synchronously
      if (handler) handler();
    }, { once: true });
  });

  // Close on click outside — delay to avoid closing from the originating right-click
  setTimeout(() => {
    closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('active');
        cleanupContextMenu();
      }
    };
    document.addEventListener('mousedown', closeHandler, true);
  }, 0);
}

export function hideContextMenu() {
  const menu = $('#context-menu');
  if (menu) menu.classList.remove('active');
  cleanupContextMenu();
}

// ─── AI SETTINGS MODAL ──────────────────────────────
export function showAISettingsModal(config, onSave) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');

  modal.innerHTML = `
    <div class="modal-header"><h3>⚙ Configuración de IA</h3></div>
    <div class="modal-body ai-settings-body">
      <div class="field-group">
        <label class="field-label">API Key de OpenRouter</label>
        <input class="field-input" type="password" id="ai-api-key" value="${config.apiKey || ''}" placeholder="sk-or-v1-...">
        <span class="field-hint">Obtén tu key en <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--accent-primary)">openrouter.ai/keys</a></span>
      </div>

      <div class="field-group">
        <label class="field-label">Modelo</label>
        <input class="field-input" type="text" id="ai-model" value="${config.model || ''}" placeholder="anthropic/claude-sonnet-4">
        <span class="field-hint">ID del modelo de <a href="https://openrouter.ai/models" target="_blank" style="color:var(--accent-primary)">openrouter.ai/models</a></span>
      </div>

      <div class="field-row">
        <div class="field-group" style="flex:1">
          <label class="field-label">Temperatura: <span id="ai-temp-value">${config.temperature ?? 0.7}</span></label>
          <input type="range" class="field-range" id="ai-temperature" min="0" max="1.5" step="0.1" value="${config.temperature ?? 0.7}">
        </div>
        <div class="field-group" style="flex:0 0 auto">
          <label class="field-label">Modelo Thinking</label>
          <label class="toggle-switch">
            <input type="checkbox" id="ai-thinking" ${config.isThinking ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label">Archivos de contexto del mundo (.pdf, .md, .txt)</label>
        <span class="field-hint" style="margin-bottom:6px">Lore, personajes, mundo — se envían a la IA al generar diálogos</span>
        <div id="ai-files-list" class="ai-files-list"></div>
        <div class="file-upload-area">
          <input type="file" id="ai-context-file" accept=".pdf,.md,.txt" style="display:none">
          <button class="btn btn-block" id="ai-file-btn">+ Agregar archivo</button>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn btn-primary" id="modal-confirm">Guardar</button>
    </div>
  `;

  overlay.classList.add('active');

  // Temperature slider live update
  const tempSlider = $('#ai-temperature');
  const tempLabel = $('#ai-temp-value');
  tempSlider.addEventListener('input', () => {
    tempLabel.textContent = tempSlider.value;
  });

  // Multi-file management
  const contextFiles = [...(config.contextFiles || [])];

  function renderFilesList() {
    const list = $('#ai-files-list');
    if (contextFiles.length === 0) {
      list.innerHTML = '<span class="field-hint">Sin archivos cargados</span>';
      return;
    }
    list.innerHTML = contextFiles.map((f, i) => `
      <div class="ai-file-item">
        <span class="ai-file-name">📄 ${f.name}</span>
        <span class="ai-file-size">${f.text.length} chars</span>
        <button class="ai-file-delete" data-idx="${i}" title="Eliminar">✕</button>
      </div>
    `).join('');
    list.querySelectorAll('.ai-file-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        contextFiles.splice(parseInt(btn.dataset.idx), 1);
        renderFilesList();
      });
    });
  }
  renderFilesList();

  const fileInput = $('#ai-context-file');
  $('#ai-file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const btn = $('#ai-file-btn');
    btn.textContent = '⏳ Procesando...';
    btn.disabled = true;
    try {
      const { extractFileText } = await import('./ai.js');
      const text = await extractFileText(file);
      contextFiles.push({ name: file.name, text });
      renderFilesList();
      btn.textContent = '+ Agregar archivo';
      btn.disabled = false;
      fileInput.value = '';
    } catch (err) {
      btn.textContent = '+ Agregar archivo';
      btn.disabled = false;
      toast(err.message, 'error');
    }
  });

  const close = () => overlay.classList.remove('active');
  $('#modal-cancel').onclick = close;
  overlay.onmousedown = (e) => { if (e.target === overlay) close(); };

  $('#modal-confirm').onclick = () => {
    onSave({
      apiKey: $('#ai-api-key').value.trim(),
      model: $('#ai-model').value.trim(),
      temperature: parseFloat($('#ai-temperature').value),
      isThinking: $('#ai-thinking').checked,
      contextFiles: contextFiles,
    });
    close();
    toast('Configuración de IA guardada', 'success');
  };
}

// ─── AI GENERATE MODAL ──────────────────────────────
let lastAiPrompt = '';
let lastMinNodes = 5;
let lastMaxNodes = 15;

export function showAIGenerateModal(npcName, onGenerate, { hasExistingNodes = false } = {}) {
  const overlay = $('#modal-overlay');
  const modal = $('#modal');

  modal.innerHTML = `
    <div class="modal-header"><h3>✨ Generar Diálogo con IA</h3></div>
    <div class="modal-body">
      ${npcName ? '<div class="field-hint" style="margin-bottom:12px">NPC: <strong>' + npcName + '</strong></div>' : ''}
      <div class="field-group">
        <label class="field-label">Describe el diálogo que quieres generar</label>
        <textarea class="field-textarea" id="ai-gen-prompt" rows="5" placeholder="Ej: Un guardia le advierte al jugador que la zona está llena de monstruos. El jugador puede preguntar más información, ignorarlo, o pedirle ayuda.">${lastAiPrompt}</textarea>
      </div>
      <div class="field-row" style="gap:16px">
        <div class="field-group" style="flex:1">
          <label class="field-label">Mín. nodos</label>
          <input type="number" class="field-input" id="ai-min-nodes" min="1" step="1" value="${lastMinNodes}" style="width:100%">
        </div>
        <div class="field-group" style="flex:1">
          <label class="field-label">Máx. nodos</label>
          <input type="number" class="field-input" id="ai-max-nodes" min="2" step="1" value="${lastMaxNodes}" style="width:100%">
        </div>
      </div>
    </div>
    <div class="modal-footer" style="gap:8px">
      <button class="btn" id="modal-cancel">Cancelar</button>
      ${hasExistingNodes ? '<button class="btn btn-ai" id="modal-extend">🔗 Extender diálogo</button>' : ''}
      <button class="btn btn-primary" id="modal-confirm">✨ Generar nuevo</button>
    </div>
  `;

  overlay.classList.add('active');
  const textarea = $('#ai-gen-prompt');
  if (textarea) {
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }, 100);

    textarea.addEventListener('input', (e) => {
      lastAiPrompt = e.target.value;
    });
  }

  // Number inputs for min/max persistence
  const minInput = $('#ai-min-nodes');
  const maxInput = $('#ai-max-nodes');

  minInput.addEventListener('change', () => {
    let v = parseInt(minInput.value) || 1;
    if (v < 1) v = 1;
    minInput.value = v;
    lastMinNodes = v;
    if (v > (parseInt(maxInput.value) || 2)) { maxInput.value = v; lastMaxNodes = v; }
  });
  maxInput.addEventListener('change', () => {
    let v = parseInt(maxInput.value) || 2;
    if (v < 2) v = 2;
    maxInput.value = v;
    lastMaxNodes = v;
    if (v < (parseInt(minInput.value) || 1)) { minInput.value = v; lastMinNodes = v; }
  });

  const close = () => overlay.classList.remove('active');
  $('#modal-cancel').onclick = close;
  overlay.onmousedown = (e) => { if (e.target === overlay) close(); };

  const getValues = () => {
    const prompt = textarea ? textarea.value.trim() : '';
    if (!prompt) { toast('Escribe un prompt', 'error'); return null; }
    return { prompt, minNodes: parseInt(minInput.value) || 5, maxNodes: parseInt(maxInput.value) || 15 };
  };

  $('#modal-confirm').onclick = () => {
    const vals = getValues();
    if (!vals) return;
    close();
    onGenerate({ ...vals, mode: 'new' });
  };

  const extendBtn = $('#modal-extend');
  if (extendBtn) {
    extendBtn.onclick = () => {
      const vals = getValues();
      if (!vals) return;
      close();
      onGenerate({ ...vals, mode: 'extend' });
    };
  }
}

// ─── AI LOADING OVERLAY ─────────────────────────────
let loadingEl = null;

export function showAILoading(msg) {
  if (loadingEl) return;
  loadingEl = document.createElement('div');
  loadingEl.className = 'ai-loading-overlay';
  loadingEl.innerHTML = `
    <div class="ai-loading-card">
      <div class="ai-spinner"></div>
      <p>${msg || 'La IA está trabajando...'}</p>
    </div>
  `;
  document.body.appendChild(loadingEl);
}

export function hideAILoading() {
  if (loadingEl) {
    loadingEl.remove();
    loadingEl = null;
  }
}


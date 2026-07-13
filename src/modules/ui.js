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

  // Per-task provider + model rows. Providers: OpenRouter (HTTP) | Claude Code (local CLI).
  const TASK_ROWS = [
    { key: 'generate', label: 'Generación de Diálogos', orPlaceholder: 'anthropic/claude-sonnet-4', orHint: 'Usado para generar y extender diálogos. Recomendado: modelo inteligente.' },
    { key: 'translate', label: 'Traducción', orPlaceholder: 'google/gemini-2.5-flash', orHint: 'Usado para traducir ES → EN. Un modelo rápido y barato funciona bien.' },
    { key: 'chat', label: 'Chat Asistente', orPlaceholder: 'google/gemini-2.5-flash', orHint: 'Usado para el chat integrado de IA.' },
  ];
  const CLAUDE_HINT = 'Usa tu suscripción de Claude (CLI de Claude Code instalado y logueado). Elige un alias de la lista o escribe otro.';
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Model suggestions per provider (free text still allowed — these feed <datalist>)
  const OR_MODELS = [
    'anthropic/claude-sonnet-4', 'anthropic/claude-opus-4',
    'google/gemini-2.5-flash', 'google/gemini-2.5-pro',
    'openai/gpt-4o-mini', 'openai/gpt-4o',
    'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct',
  ];
  const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
  // Ordered by retrieval quality (multilingual/ES). Big models are practical
  // thanks to WebGPU; on CPU-only machines the small ones are the safe picks.
  const EMB_MODELS = [
    'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    'Xenova/multilingual-e5-large',
    'Xenova/bge-m3',
    'Xenova/multilingual-e5-base',
    'Xenova/multilingual-e5-small',
    'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  ];
  const datalist = (id, values) =>
    `<datalist id="${id}">${values.map((v) => `<option value="${v}"></option>`).join('')}</datalist>`;

  const taskRowsHTML = TASK_ROWS.map((t) => {
    const provider = config[`provider${cap(t.key)}`] || 'openrouter';
    const isClaude = provider === 'claude';
    return `
      <div class="field-group">
        <label class="field-label">${t.label}</label>
        <div class="field-row" style="gap:8px">
          <select class="field-input" id="ai-provider-${t.key}" style="flex:0 0 150px">
            <option value="openrouter" ${!isClaude ? 'selected' : ''}>OpenRouter</option>
            <option value="claude" ${isClaude ? 'selected' : ''}>Claude Code</option>
          </select>
          <input class="field-input" type="text" id="ai-model-${t.key}" value="${config[`model${cap(t.key)}`] || ''}"
            placeholder="${isClaude ? 'sonnet' : t.orPlaceholder}" list="${isClaude ? 'dl-claude-models' : 'dl-or-models'}" style="flex:1">
        </div>
        <span class="field-hint" id="ai-hint-${t.key}">${isClaude ? CLAUDE_HINT : t.orHint}</span>
      </div>`;
  }).join('');

  modal.innerHTML = `
    <div class="modal-header"><h3>⚙ Configuración de IA</h3></div>
    <div class="modal-body ai-settings-body">
      ${datalist('dl-or-models', OR_MODELS)}
      ${datalist('dl-claude-models', CLAUDE_MODELS)}
      ${datalist('dl-emb-models', EMB_MODELS)}

      <div class="field-group">
        <div class="field-row" style="gap:8px; align-items:center">
          <span class="field-hint" style="margin:0">Usar el mismo proveedor en todo:</span>
          <button class="btn btn-sm" id="ai-all-openrouter" type="button">OpenRouter</button>
          <button class="btn btn-sm" id="ai-all-claude" type="button">Claude Code</button>
        </div>
      </div>

      <div class="field-group" id="ai-key-group">
        <label class="field-label">API Key de OpenRouter</label>
        <input class="field-input" type="password" id="ai-api-key" value="${config.apiKey || ''}" placeholder="sk-or-v1-...">
        <span class="field-hint">Obtén tu key en <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--accent-primary)">openrouter.ai/keys</a>. Solo se usa con el proveedor OpenRouter.</span>
      </div>

      ${taskRowsHTML}

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
        <label class="field-label">Memoria vectorial (embeddings locales)</label>
        <div class="field-row" style="gap:10px; align-items:center">
          <label class="toggle-switch" title="Activa la memoria semántica del proyecto (RAG para el chat + mapa neuronal)">
            <input type="checkbox" id="ai-embeddings-enabled" ${config.embeddingsEnabled !== false ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <input class="field-input" type="text" id="ai-embeddings-model" value="${config.embeddingsModel || ''}"
            placeholder="Xenova/paraphrase-multilingual-MiniLM-L12-v2" list="dl-emb-models" style="flex:1">
        </div>
        <span class="field-hint">Modelo local que corre 100% en tu PC — en GPU (WebGPU) si está disponible, con fallback a CPU. Se descarga una vez (50 MB–1 GB según el modelo; Claude no genera embeddings). Calidad: Qwen3 &gt; e5-large ≈ bge-m3 &gt; e5-base &gt; e5-small. Tras cambiar de modelo, pulsa "⚡ Reindexar" en 🧠 Memoria para migrar el índice.</span>
      </div>

      <div class="field-group">
        <label class="field-label">Archivos de contexto del mundo (.pdf, .md, .txt)</label>
        <span class="field-hint" style="margin-bottom:6px">Lore, personajes, mundo — se envían a la IA al generar diálogos y se indexan en la memoria vectorial</span>
        <div id="ai-files-list" class="ai-files-list"></div>
        <div class="file-upload-area">
          <input type="file" id="ai-context-file" accept=".pdf,.md,.txt" style="display:none">
          <button class="btn btn-block" id="ai-file-btn">+ Agregar archivo</button>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="ai-test-btn" style="margin-right:auto" title="Verifica la API key de OpenRouter y/o el CLI de Claude Code según los proveedores elegidos">🔌 Probar conexión</button>
      <button class="btn" id="modal-cancel">Cancelar</button>
      <button class="btn btn-primary" id="modal-confirm">Guardar</button>
    </div>
  `;

  overlay.classList.add('active');

  // Hide the API key field when no task uses OpenRouter
  const syncKeyVisibility = () => {
    const anyOpenRouter = TASK_ROWS.some((t) => $(`#ai-provider-${t.key}`).value === 'openrouter');
    const keyGroup = $('#ai-key-group');
    if (keyGroup) keyGroup.style.display = anyOpenRouter ? '' : 'none';
  };

  // Provider selects: update model placeholder + hint + suggestions when switching provider
  const applyProviderUI = (t) => {
    const select = $(`#ai-provider-${t.key}`);
    const isClaude = select.value === 'claude';
    const modelInput = $(`#ai-model-${t.key}`);
    modelInput.placeholder = isClaude ? 'sonnet' : t.orPlaceholder;
    modelInput.setAttribute('list', isClaude ? 'dl-claude-models' : 'dl-or-models');
    $(`#ai-hint-${t.key}`).textContent = isClaude ? CLAUDE_HINT : t.orHint;
  };
  TASK_ROWS.forEach((t) => {
    $(`#ai-provider-${t.key}`).addEventListener('change', () => {
      applyProviderUI(t);
      syncKeyVisibility();
    });
  });
  syncKeyVisibility();

  // "Same provider everywhere" shortcuts
  const setAllProviders = (value) => {
    TASK_ROWS.forEach((t) => {
      $(`#ai-provider-${t.key}`).value = value;
      applyProviderUI(t);
    });
    syncKeyVisibility();
  };
  $('#ai-all-openrouter')?.addEventListener('click', () => setAllProviders('openrouter'));
  $('#ai-all-claude')?.addEventListener('click', () => setAllProviders('claude'));

  // Connection test: checks whichever providers are currently selected
  $('#ai-test-btn')?.addEventListener('click', async () => {
    const btn = $('#ai-test-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Probando...';
    try {
      const usesOR = TASK_ROWS.some((t) => $(`#ai-provider-${t.key}`).value === 'openrouter');
      const usesCl = TASK_ROWS.some((t) => $(`#ai-provider-${t.key}`).value === 'claude');

      if (usesOR) {
        const key = $('#ai-api-key').value.trim();
        if (!key) {
          toast('OpenRouter: falta la API key.', 'error');
        } else {
          try {
            const res = await fetch('https://openrouter.ai/api/v1/key', {
              headers: { 'Authorization': `Bearer ${key}` },
            });
            if (res.ok) toast('OpenRouter: API key válida ✓', 'success');
            else if (res.status === 401) toast('OpenRouter: API key inválida o expirada.', 'error');
            else toast(`OpenRouter respondió ${res.status}.`, 'error');
          } catch {
            toast('OpenRouter: sin conexión a internet.', 'error');
          }
        }
      }

      if (usesCl) {
        const api = window.electronAPI;
        if (!api || !api.claudeCheck) {
          toast('Claude Code solo funciona en la app de escritorio (Electron).', 'error');
        } else {
          const res = await api.claudeCheck().catch(() => null);
          if (res?.ok) toast(`Claude Code disponible ✓ (${res.version || 'CLI detectado'})`, 'success');
          else toast(res?.error || 'Claude Code no está disponible.', 'error');
        }
      }

      if (!usesOR && !usesCl) toast('Selecciona al menos un proveedor.', 'info');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔌 Probar conexión';
    }
  });

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
    const usesClaude = TASK_ROWS.some((t) => $(`#ai-provider-${t.key}`).value === 'claude');
    onSave({
      apiKey: $('#ai-api-key').value.trim(),
      modelGenerate: $('#ai-model-generate').value.trim(),
      modelTranslate: $('#ai-model-translate').value.trim(),
      modelChat: $('#ai-model-chat').value.trim(),
      providerGenerate: $('#ai-provider-generate').value,
      providerTranslate: $('#ai-provider-translate').value,
      providerChat: $('#ai-provider-chat').value,
      temperature: parseFloat($('#ai-temperature').value),
      isThinking: $('#ai-thinking').checked,
      contextFiles: contextFiles,
      embeddingsEnabled: $('#ai-embeddings-enabled').checked,
      embeddingsModel: $('#ai-embeddings-model').value.trim(),
    });
    close();
    toast('Configuración de IA guardada', 'success');

    // If Claude Code is selected for any task, verify the CLI is available
    if (usesClaude) {
      const api = window.electronAPI;
      if (!api || !api.claudeCheck) {
        toast('Claude Code solo funciona en la app de escritorio (Electron).', 'error');
      } else {
        api.claudeCheck().then((res) => {
          if (!res?.ok) toast(res?.error || 'Claude Code no está disponible.', 'error');
        }).catch(() => {});
      }
    }
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


/**
 * AI module — multi-provider AI integration for translation and dialogue generation.
 * Providers: OpenRouter (HTTP API) and Claude Code (local CLI via Electron IPC,
 * uses the user's Claude Pro/Max subscription). Provider is selectable per task.
 * Supports thinking models and PDF context.
 */
import { toast } from './ui.js';
import * as State from './state.js';
import { setText } from './lang.js';
import {
  TRANSLATE_SINGLE_SYSTEM,
  TRANSLATE_BATCH_SYSTEM,
  buildGenerateSystemPrompt,
  buildExtendSystemPrompt,
} from './prompts.js';

// Callback for auto-layout (set by canvas.js after initialization to avoid circular imports)
let _autoLayoutFn = null;
export function setAutoLayoutCallback(fn) { _autoLayoutFn = fn; }

// ─── CONFIG ──────────────────────────────────────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CONFIG_KEY = 'dialogueForge_ai_config';

let config = {
  apiKey: '',
  modelGenerate: '',   // For dialogue generation & extension
  modelTranslate: '',  // For ES → EN translation
  modelChat: '',       // For the integrated chat assistant
  providerGenerate: 'openrouter',   // 'openrouter' | 'claude'
  providerTranslate: 'openrouter',
  providerChat: 'openrouter',
  temperature: 0.7,
  isThinking: false,
  contextFiles: [],  // [{name, text}]
  // Local vector memory (transformers.js — runs on-device, no API key)
  embeddingsEnabled: true,
  embeddingsModel: '', // empty = default multilingual model (see vector-memory.js)
};

export function getConfig() { return { ...config, contextFiles: [...(config.contextFiles || [])] }; }

export function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      config = { ...config, ...parsed };
      // Migrate from single "model" field to per-task models
      if (parsed.model && !parsed.modelGenerate) {
        config.modelGenerate = parsed.model;
        config.modelTranslate = parsed.model;
        config.modelChat = parsed.model;
        delete config.model;
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      }
    }
  } catch { /* ignore */ }
}

// ─── CORE API CALL ───────────────────────────────────
async function callOpenRouter(messages, options = {}) {
  if (!config.apiKey) {
    throw new Error('API Key no configurada. Abre la configuración de IA.');
  }

  const model = options.model || config.modelGenerate;
  if (!model) {
    throw new Error('Modelo no configurado. Abre la configuración de IA.');
  }

  const body = {
    model,
    messages,
    temperature: options.temperature ?? config.temperature,
  };

  if (options.maxTokens) body.max_tokens = options.maxTokens;

  // Hard timeout so a hung request never leaves the UI spinning forever
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);

  let response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dialogue-forge.app',
        'X-Title': "Jamon's Dialogue Editor",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('OpenRouter no respondió a tiempo (timeout de 3 min). Intenta de nuevo.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const apiMsg = err?.error?.message || '';
    let userMsg;
    switch (response.status) {
      case 401:
        userMsg = 'API Key inválida o expirada. Revisa la configuración de IA.';
        break;
      case 402:
        userMsg = 'Sin crédito en OpenRouter. Recarga tu cuenta.';
        break;
      case 403:
        userMsg = 'Acceso denegado. Verifica los permisos de tu API Key.';
        break;
      case 404:
        userMsg = `Modelo "${model}" no encontrado. Verifica el ID del modelo.`;
        break;
      case 429:
        userMsg = 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.';
        break;
      case 503:
        userMsg = 'Servicio temporalmente no disponible. Intenta más tarde.';
        break;
      default:
        userMsg = apiMsg || `Error del servidor (${response.status})`;
    }
    throw new Error(userMsg);
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || '';

  // Handle thinking models — strip <thinking> blocks
  if (config.isThinking) {
    content = stripThinking(content);
  }

  return content.trim();
}

function stripThinking(text) {
  // Remove <thinking>...</thinking> blocks (case insensitive, multiline)
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
}

// ─── CLAUDE CODE (Electron IPC) ──────────────────────
async function callClaudeCode(messages, options = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (!api || !api.claudeCall) {
    throw new Error('Claude Code solo está disponible en la app de escritorio (Electron).');
  }

  // Split system messages from the conversation
  const systemParts = [];
  const convo = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else convo.push(m);
  }

  // Claude Code takes a single prompt — flatten multi-turn history
  let prompt;
  if (convo.length === 1 && convo[0].role === 'user') {
    prompt = convo[0].content;
  } else {
    prompt = convo
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
      .join('\n\n');
  }

  const res = await api.claudeCall({
    prompt,
    systemPrompt: systemParts.join('\n\n') || null,
    model: options.model || 'sonnet',
    maxTokens: options.maxTokens || null,
  });

  if (!res || !res.ok) {
    throw new Error(res?.error || 'Error desconocido al llamar a Claude Code.');
  }

  let content = res.text || '';
  if (config.isThinking) content = stripThinking(content);
  return content.trim();
}

// ─── PROVIDER DISPATCHER ─────────────────────────────
const TASK_FIELDS = {
  generate: { provider: 'providerGenerate', model: 'modelGenerate' },
  translate: { provider: 'providerTranslate', model: 'modelTranslate' },
  chat: { provider: 'providerChat', model: 'modelChat' },
};

/**
 * Routes an AI call to the provider configured for the given task.
 * options.task: 'generate' | 'translate' | 'chat' (default 'generate')
 */
async function callProvider(messages, options = {}) {
  const fields = TASK_FIELDS[options.task] || TASK_FIELDS.generate;
  const provider = config[fields.provider] || 'openrouter';
  const model = options.model || config[fields.model];

  if (provider === 'claude') {
    return callClaudeCode(messages, { ...options, model });
  }
  return callOpenRouter(messages, { ...options, model });
}

// ─── TRANSLATION (ES → EN) ─────────────────────────
export async function translateNode(nodeId) {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');
  const node = dlg.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('Nodo no encontrado');

  const sourceText = node.text.es;
  if (!sourceText || !sourceText.trim()) {
    throw new Error('El nodo no tiene texto en ES');
  }

  const messages = [
    { role: 'system', content: TRANSLATE_SINGLE_SYSTEM },
    { role: 'user', content: sourceText }
  ];

  const translated = await callProvider(messages, { task: 'translate' });
  const updatedText = { ...node.text };
  updatedText.en = translated;
  State.updateNodeText(nodeId, updatedText);
  return translated;
}

export async function translateAllNodes() {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');

  const nodesToTranslate = dlg.nodes.filter((n) => {
    const source = n.text.es;
    return source && source.trim();
  });

  if (nodesToTranslate.length === 0) {
    throw new Error('No hay nodos con texto en ES para traducir');
  }

  // Batch all texts in one call for efficiency
  const texts = nodesToTranslate.map((n, i) => `[${i + 1}] ${n.text.es}`).join('\n---\n');

  const messages = [
    { role: 'system', content: TRANSLATE_BATCH_SYSTEM },
    { role: 'user', content: texts }
  ];

  const result = await callProvider(messages, { task: 'translate', maxTokens: 4096 });

  // Parse results
  const parts = result.split('---').map((p) => p.trim());
  let count = 0;

  State.startBatch();
  for (let i = 0; i < nodesToTranslate.length; i++) {
    const node = nodesToTranslate[i];
    let translated = parts[i] || '';
    // Remove the [N] prefix if present
    translated = translated.replace(/^\[\d+\]\s*/, '').trim();
    if (translated) {
      const updatedText = { ...node.text };
      updatedText.en = translated;
      State.updateNodeText(node.id, updatedText);
      count++;
    }
  }
  State.endBatch();

  return count;
}

// ─── JSON SANITIZER ──────────────────────────────────
export function sanitizeJSON(str) {
  // Remove trailing commas before ] or }
  str = str.replace(/,\s*([\]}])/g, '$1');
  // Remove BOM and zero-width characters
  str = str.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return str;
}

// ─── DIALOGUE GENERATION ─────────────────────────────

// buildSystemPrompt is now in prompts.js as buildGenerateSystemPrompt

async function getContextAndNpcs(query) {
  let contextBlock = '';

  // RAG: retrieve only the lore fragments relevant to the generation prompt.
  // Dynamic import — vector-memory.js statically imports ai.js, so a static
  // import here would create a cycle. Chat exchanges are excluded: assistant
  // conversations about the app are not world lore.
  let usedRag = false;
  try {
    const VectorMemory = await import('./vector-memory.js');
    if (query && VectorMemory.isEnabled() && (await VectorMemory.hasIndex())) {
      const hits = await VectorMemory.search(query, { k: 10, types: ['file', 'node', 'npc', 'quest', 'dialogue'] });
      if (hits.length > 0) {
        const ragText = hits
          .map((h) => `[${h.typeLabel} · sim ${h.score.toFixed(2)}] ${h.text}`)
          .join('\n---\n');
        contextBlock = `\n\nRelevant world lore (fragments retrieved from the local vector memory because they are semantically relevant to the user's request):\n${ragText}`;
        usedRag = true;
      }
    }
  } catch { /* vector memory unavailable — fall back to the raw dump below */ }

  if (!usedRag && config.contextFiles && config.contextFiles.length > 0) {
    const filesText = config.contextFiles.map((f) => `--- ${f.name} ---\n${f.text}`).join('\n\n');
    contextBlock = `\n\nWorld context documents:\n${filesText.slice(0, 8000)}`;
  }

  const allNpcs = State.getState().npcs || [];
  const npcListText = allNpcs.length > 0
    ? allNpcs.map((n) => `"${n.name}"${n.comment && n.comment.trim() ? ` (${n.comment.trim().slice(0, 150)})` : ''}`).join(', ')
    : 'Ninguno';
  return { contextBlock, npcListText };
}

function parseAIResponse(result) {
  let jsonStr = result;
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1];
  const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) jsonStr = jsonObjMatch[0];

  let data;
  try {
    data = JSON.parse(sanitizeJSON(jsonStr));
  } catch {
    throw new Error('La IA no generó un JSON válido. Intenta de nuevo.');
  }
  if (!data.nodes || !Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new Error('La respuesta no contiene nodos válidos.');
  }
  return data;
}

export async function generateDialogue(prompt, npcName, { minNodes = 5, maxNodes = 15 } = {}) {
  const { contextBlock, npcListText } = await getContextAndNpcs(prompt);
  const dlg = State.getActiveDialogue();
  const noteBlock = dlg?.comment?.trim()
    ? `\n\nAuthor note about this dialogue (when/where it happens): ${dlg.comment.trim()}`
    : '';
  const systemPrompt = buildGenerateSystemPrompt(npcName, npcListText, contextBlock + noteBlock, minNodes, maxNodes);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  const dynamicMaxTokens = Math.min(16384, Math.max(4096, maxNodes * 350));
  const result = await callProvider(messages, { task: 'generate', temperature: 0.8, maxTokens: dynamicMaxTokens });

  return parseAIResponse(result);
}

// ─── EXTEND EXISTING DIALOGUE ────────────────────────
export async function extendDialogue(prompt, npcName, { minNodes = 5, maxNodes = 15 } = {}) {
  const dlg = State.getActiveDialogue();
  if (!dlg) throw new Error('No hay diálogo activo');

  const { contextBlock, npcListText } = await getContextAndNpcs(prompt);
  const { normalizeConnection } = await import('./state.js');

  // Find leaf nodes (nodes with empty connections)
  const leafNodes = dlg.nodes.filter((n) => !n.connections || n.connections.length === 0);
  if (leafNodes.length === 0) {
    throw new Error('No hay nodos finales desde los que extender. Todos los nodos tienen conexiones de salida.');
  }

  // Build existing dialogue summary for context
  const existingSummary = dlg.nodes.map((n) => {
    const npc = n.npcId ? State.getNPC(n.npcId) : null;
    const conns = (n.connections || []).map((c) => normalizeConnection(c).targetId);
    return `  - id:"${n.id}" npc:"${npc?.name || '?'}" text:"${(n.text?.es || '').slice(0, 80)}" connections:[${conns.map(c => `"${c}"`).join(',')}]`;
  }).join('\n');

  const leafIds = leafNodes.map((n) => `"${n.id}"`).join(', ');

  const noteBlock = dlg.comment && dlg.comment.trim()
    ? `\n\nAuthor note about this dialogue (when/where it happens): ${dlg.comment.trim()}`
    : '';
  const systemPrompt = buildExtendSystemPrompt(npcName, npcListText, contextBlock + noteBlock, existingSummary, leafIds, minNodes, maxNodes);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ];

  const dynamicMaxTokens = Math.min(16384, Math.max(4096, maxNodes * 350));
  const result = await callProvider(messages, { task: 'generate', temperature: 0.8, maxTokens: dynamicMaxTokens });
  return parseAIResponse(result);
}

export function insertExtendedDialogue(data) {
  const dlg = State.getActiveDialogue();
  if (!dlg) return 0;

  State.startBatch();

  // Map generated IDs to real IDs
  const idMap = {};
  const startX = 300;
  const startY = 100;
  const spacingY = 180;
  const spacingX = 300;
  const nodesPerRow = 3;

  // Offset new nodes below existing ones
  let maxY = 0;
  dlg.nodes.forEach((n) => { if (n.y > maxY) maxY = n.y; });
  const baseY = maxY + spacingY + 100;

  data.nodes.forEach((genNode, i) => {
    const row = Math.floor(i / nodesPerRow);
    const col = i % nodesPerRow;
    const x = startX + col * spacingX;
    const y = baseY + row * spacingY;

    const realNode = State.addNode(x, y);
    if (realNode) {
      idMap[genNode.id] = realNode.id;
      const textObj = {
        es: genNode.text_es || genNode.text || '',
        en: '',
      };
      State.updateNodeText(realNode.id, textObj);

      if (genNode.npc && genNode.npc.trim()) {
        const npcs = State.getState().npcs || [];
        const npcNameClean = genNode.npc.trim();
        let targetNpc = npcs.find((n) => n.name.toLowerCase() === npcNameClean.toLowerCase());
        if (!targetNpc) {
          targetNpc = State.addNPC(npcNameClean);
        }
        if (targetNpc) {
          State.updateNodeNPC(realNode.id, targetNpc.id);
        }
      }
    }
  });

  // Set connections between new nodes
  data.nodes.forEach((genNode) => {
    const realSourceId = idMap[genNode.id];
    if (!realSourceId || !genNode.connections) return;
    genNode.connections.forEach((conn) => {
      const targetGenId = typeof conn === 'string' ? conn : conn.targetId;
      const realTargetId = idMap[targetGenId];
      if (realTargetId) {
        State.addConnection(realSourceId, realTargetId);
      }
    });
  });

  // Link existing leaf nodes to new nodes
  if (data.linkFrom) {
    Object.entries(data.linkFrom).forEach(([existingId, newIds]) => {
      // existingId is the real ID of the leaf node in the existing dialogue
      const existingNode = dlg.nodes.find((n) => n.id === existingId);
      if (!existingNode) return;
      (newIds || []).forEach((newGenId) => {
        const realNewId = idMap[newGenId];
        if (realNewId) {
          State.addConnection(existingId, realNewId);
        }
      });
    });
  }

  State.endBatch();

  // Auto-layout to organize
  setTimeout(() => { if (_autoLayoutFn) _autoLayoutFn(); }, 50);

  return Object.keys(idMap).length;
}

export function insertGeneratedDialogue(data) {
  const dlg = State.getActiveDialogue();
  if (!dlg) return;

  State.startBatch();

  // Map generated IDs to real IDs
  const idMap = {};
  const startX = 300;
  const startY = 100;
  const spacingY = 180;
  const spacingX = 300;

  // Simple layout: arrange in rows
  const nodesPerRow = 3;

  data.nodes.forEach((genNode, i) => {
    const row = Math.floor(i / nodesPerRow);
    const col = i % nodesPerRow;
    const x = startX + col * spacingX;
    const y = startY + row * spacingY;

    const realNode = State.addNode(x, y);
    if (realNode) {
      idMap[genNode.id] = realNode.id;
      const textObj = {
        es: genNode.text_es || genNode.text || '',
        en: '',
      };
      State.updateNodeText(realNode.id, textObj);

      // Asignar NPC al nodo
      if (genNode.npc && genNode.npc.trim()) {
        const npcs = State.getState().npcs || [];
        const npcNameClean = genNode.npc.trim();
        let targetNpc = npcs.find((n) => n.name.toLowerCase() === npcNameClean.toLowerCase());
        if (!targetNpc) {
          // Si no existe, creamos el NPC nuevo
          targetNpc = State.addNPC(npcNameClean);
        }
        if (targetNpc) {
          State.updateNodeNPC(realNode.id, targetNpc.id);
        }
      }
    }
  });

  // Set connections (handle both string ID and legacy object format)
  data.nodes.forEach((genNode) => {
    const realSourceId = idMap[genNode.id];
    if (!realSourceId || !genNode.connections) return;

    genNode.connections.forEach((conn) => {
      const targetGenId = typeof conn === 'string' ? conn : conn.targetId;
      const realTargetId = idMap[targetGenId];
      if (realTargetId) {
        State.addConnection(realSourceId, realTargetId);
      }
    });
  });

  // Set start node
  if (data.startNodeId && idMap[data.startNodeId]) {
    State.setStartNode(idMap[data.startNodeId]);
  }

  State.endBatch();

  // Auto-layout to organize the generated tree
  setTimeout(() => { if (_autoLayoutFn) _autoLayoutFn(); }, 50);

  return Object.keys(idMap).length;
}

// ─── FILE PARSING (PDF & MD) ─────────────────────────
export async function extractFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'md' || ext === 'txt') {
    return extractTextFile(file);
  }
  if (ext === 'pdf') {
    return extractPdfText(file);
  }
  throw new Error(`Formato no soportado: .${ext}. Usa .pdf, .md o .txt`);
}

function extractTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Error al leer el archivo'));
    reader.readAsText(file);
  });
}

let pdfjsModule = null;

async function loadPdfJs() {
  if (pdfjsModule) return pdfjsModule;
  try {
    const pdfjs = await import('pdfjs-dist');
    // Run on main thread to avoid worker URL resolution issues with Vite bundling.
    // Acceptable for dialogue context files which are typically small.
    pdfjs.GlobalWorkerOptions.workerSrc = '';
    pdfjsModule = pdfjs;
    return pdfjsModule;
  } catch (err) {
    throw new Error('Error al cargar la librería PDF: ' + err.message);
  }
}

async function extractPdfText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const typedArray = new Uint8Array(e.target.result);
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument(typedArray).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => item.str).join(' ');
          fullText += pageText + '\n\n';
        }
        resolve(fullText.trim());
      } catch (err) {
        reject(new Error('Error al leer el PDF: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Error al cargar el archivo'));
    reader.readAsArrayBuffer(file);
  });
}

// Init
loadConfig();

/**
 * Public API wrapper — used by the Chat module to call the AI
 * without re-implementing auth logic. Defaults to the 'chat' task
 * so the per-task provider config applies.
 */
export async function callAI(messages, options = {}) {
  return callProvider(messages, { task: 'chat', ...options });
}


/**
 * vector-memory.js — Local semantic memory (RAG) for the AI assistant.
 *
 * Embeds dialogue nodes, world-context files, NPCs/quests and chat history
 * with a local transformers.js model (downloads once, then runs 100% offline,
 * no API key — note: Claude/Claude Code cannot generate embeddings), stores
 * the vectors in IndexedDB (outside the project state, so undo/redo and the
 * 50x state snapshots never touch them), and retrieves the top-k most
 * relevant items by cosine similarity.
 */
import * as State from './state.js';
import * as AI from './ai.js';
import { toast } from './ui.js';

const DB_NAME = 'dialogueForge_vectors';
const DB_VERSION = 1;
const STORE = 'items';
const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'; // 384 dims, ES/EN
const MAX_CHAT_ITEMS = 300;

const TYPE_LABELS = {
  node: 'Nodo',
  file: 'Archivo',
  npc: 'NPC',
  quest: 'Quest',
  dialogue: 'Diálogo',
  chat: 'Chat',
};

// ─── MODULE STATE ─────────────────────────────────────
let dbPromise = null;
let embedderPromise = null;
let embedderModelId = null;
let itemsCache = null;      // in-memory mirror of the IndexedDB store
let indexing = false;
let cancelRequested = false;
let refreshTimer = null;
let progressCb = null;

export function onProgress(cb) { progressCb = cb; }
function reportProgress(info) { if (progressCb) { try { progressCb(info); } catch { /* ignore */ } } }

// ─── CONFIG ──────────────────────────────────────────
export function isEnabled() {
  return AI.getConfig().embeddingsEnabled !== false;
}

export function getModelId() {
  return (AI.getConfig().embeddingsModel || '').trim() || DEFAULT_MODEL;
}

export function isIndexing() { return indexing; }

/** Aborts the current indexing run between batches (nothing is persisted). */
export function requestCancel() { if (indexing) cancelRequested = true; }

// ─── INDEXEDDB ───────────────────────────────────────
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

async function loadAllItems() {
  if (itemsCache) return itemsCache;
  const db = await openDB();
  itemsCache = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return itemsCache;
}

function invalidateCache() { itemsCache = null; }

export async function hasIndex() {
  try {
    const items = await loadAllItems();
    return items.length > 0;
  } catch { return false; }
}

export async function getStats() {
  const items = await loadAllItems().catch(() => []);
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  return { total: items.length, byType, model: getModelId(), device: activeDevice };
}

export async function getAllItems() {
  return loadAllItems().catch(() => []);
}

// ─── EMBEDDER (transformers.js, lazy-loaded) ─────────

/**
 * Per-model usage profile. Embedding models are NOT interchangeable in how
 * they must be called: E5 needs "query:"/"passage:" prefixes, Qwen3-Embedding
 * needs an instruction-formatted query + last-token pooling (decoder-based),
 * BGE-M3's dense vector is the CLS hidden state. Getting this wrong doesn't
 * error — it just silently retrieves much worse.
 */
function getModelProfile() {
  const id = getModelId();
  if (/qwen3-embedding/i.test(id)) {
    return {
      pooling: 'last_token',
      formatQuery: (q) => `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery:${q}`,
      formatPassage: (t) => t,
    };
  }
  if (/(^|[/\-_])e5([\-_]|$)/i.test(id)) {
    return {
      pooling: 'mean',
      formatQuery: (q) => `query: ${q}`,
      formatPassage: (t) => `passage: ${t}`,
    };
  }
  if (/bge-m3/i.test(id)) {
    return { pooling: 'cls', formatQuery: (q) => q, formatPassage: (t) => t };
  }
  // sentence-transformers style (MiniLM, mpnet...): mean pooling, raw text
  return { pooling: 'mean', formatQuery: (q) => q, formatPassage: (t) => t };
}

/** 'webgpu (fp16)' | 'wasm (q8)' | null — which backend the embedder ended up on. */
let activeDevice = null;
export function getActiveDevice() { return activeDevice; }

async function getEmbedder() {
  const modelId = getModelId();
  if (embedderPromise && embedderModelId === modelId) return embedderPromise;
  embedderModelId = modelId;
  embedderPromise = (async () => {
    reportProgress({ phase: 'model', message: 'Cargando modelo de embeddings (la primera vez se descarga: 50 MB–1 GB según el modelo)...' });
    // Lazy import so the WASM/model never bloats app startup (same pattern as pdfjs/jszip)
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false; // always resolve from the HF hub + browser cache

    // Real download feedback: transformers.js reports per-file byte progress.
    // Aggregate across files (model weights + tokenizer + config) and throttle.
    const dlFiles = new Map();
    let lastDlReport = 0;
    const progress_callback = (p) => {
      if (!p || p.status !== 'progress' || !p.file) return;
      dlFiles.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      const now = Date.now();
      if (now - lastDlReport < 150 && p.loaded !== p.total) return;
      lastDlReport = now;
      let loaded = 0, total = 0;
      for (const f of dlFiles.values()) { loaded += f.loaded; total += f.total; }
      if (total > 0) reportProgress({ phase: 'download', loaded, total });
    };

    // Backend attempt chain. IMPORTANT: ORT's WebGPU execution provider lives
    // inside the same WASM binary as the CPU one, so any global wasm state
    // (like the worker proxy) that breaks, breaks EVERY backend — never leave
    // dirty global flags behind between attempts.
    const attempts = [];
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      // Probe the adapter BEFORE downloading GPU weights — if WebGPU is
      // disabled/blocklisted, fail fast instead of wasting a ~1 GB download.
      let adapter = null;
      try {
        adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))
          || (await navigator.gpu.requestAdapter());
      } catch { /* treated as no adapter */ }
      if (adapter) {
        try { console.log('[VectorMemory] WebGPU adapter:', adapter.info?.vendor || '?', adapter.info?.architecture || ''); } catch { /* info optional */ }
        // fp16 first (half the download); fp32 as a compatibility fallback
        // for adapters without usable shader-f16.
        attempts.push({ device: 'webgpu', dtype: 'fp16', label: 'GPU fp16' });
        attempts.push({ device: 'webgpu', dtype: 'fp32', label: 'GPU fp32' });
      } else {
        console.warn('[VectorMemory] WebGPU: requestAdapter() devolvió null — GPU bloqueada o WebGPU deshabilitado. Si acabas de actualizar, cierra y relanza la app completa (el flag de Electron no se aplica con hot-reload).');
      }
    } else {
      console.warn('[VectorMemory] navigator.gpu no existe en este entorno — embeddings en CPU.');
    }
    attempts.push({ dtype: 'q8', label: 'CPU q8' });

    let lastErr = null;
    for (const att of attempts) {
      try {
        try { env.backends.onnx.wasm.proxy = false; } catch { /* keep deterministic wasm state */ }
        reportProgress({ phase: 'model', message: `Cargando modelo (${att.label})...` });
        const opts = { dtype: att.dtype, progress_callback };
        if (att.device) opts.device = att.device;
        const extractor = await pipeline('feature-extraction', modelId, opts);
        reportProgress({ phase: 'model', message: `Preparando el modelo (${att.label})...` });
        await extractor('warmup', { pooling: getModelProfile().pooling, normalize: true });
        activeDevice = att.device ? `webgpu (${att.dtype})` : 'wasm (q8)';
        reportProgress({ phase: 'model', message: `Modelo de embeddings listo — ${att.label}.` });
        if (!att.device && /qwen3|bge-m3|large/i.test(modelId)) {
          toast('Sin GPU (WebGPU): este modelo de embeddings es grande y será MUY lento en CPU. Considera "Xenova/multilingual-e5-small" en IA Config.', 'error');
        }
        return extractor;
      } catch (err) {
        lastErr = err;
        const reason = (err?.message || String(err)).slice(0, 140);
        console.warn(`[VectorMemory] Backend ${att.label} falló:`, err);
        reportProgress({ phase: 'model', message: `${att.label} falló (${reason}) — probando el siguiente backend...` });
        dlFiles.clear();
      }
    }
    throw lastErr || new Error('No se pudo inicializar ningún backend de embeddings.');
  })();
  embedderPromise.catch(() => { embedderPromise = null; embedderModelId = null; });
  return embedderPromise;
}

/**
 * Embeds texts in small batches; returns arrays of normalized floats.
 * kind: 'passage' for stored items, 'query' for search queries — the model
 * profile decides pooling and how each kind is formatted.
 */
async function embedTexts(texts, kind = 'passage') {
  const extractor = await getEmbedder();
  const profile = getModelProfile();
  const format = kind === 'query' ? profile.formatQuery : profile.formatPassage;
  const input = texts.map(format);
  const vectors = [];
  const BATCH = 8;
  // Report before the first batch so the UI switches from "downloading" to
  // "embedding 0/N" immediately (the first batch can take a while on CPU).
  if (input.length > 1) reportProgress({ phase: 'embed', done: 0, total: input.length });
  const t0 = Date.now();
  for (let i = 0; i < input.length; i += BATCH) {
    if (cancelRequested) throw new Error('__cancelled__');
    const batch = input.slice(i, i + BATCH);
    const t = await extractor(batch, { pooling: profile.pooling, normalize: true });
    const [n, dim] = t.dims;
    for (let j = 0; j < n; j++) {
      vectors.push(Array.from(t.data.slice(j * dim, (j + 1) * dim)));
    }
    const done = Math.min(i + BATCH, input.length);
    const etaMs = ((Date.now() - t0) / done) * (input.length - done);
    reportProgress({ phase: 'embed', done, total: input.length, etaMs });
  }
  return vectors;
}

// ─── CONTENT COLLECTION ──────────────────────────────
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Splits long text into ~maxLen-char chunks on paragraph/sentence boundaries. */
function chunkText(text, maxLen = 800) {
  const clean = (text || '').replace(/\r/g, '').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const chunks = [];
  let current = '';
  for (const para of clean.split(/\n\s*\n/)) {
    if ((current + '\n\n' + para).length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
      // A single paragraph longer than maxLen gets hard-split
      while (current.length > maxLen) {
        chunks.push(current.slice(0, maxLen));
        current = current.slice(maxLen - 100); // 100-char overlap
      }
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Gathers every indexable item from the project + AI config. */
function collectProjectItems() {
  const state = State.getState();
  const items = [];

  // Author notes ("comment") carry context the AI can't infer from names alone
  const withNote = (base, obj) => (obj.comment && obj.comment.trim() ? `${base} — ${obj.comment.trim()}` : base);

  for (const npc of state.npcs || []) {
    items.push({ key: `npc:${npc.id}`, type: 'npc', text: withNote(`NPC: ${npc.name}`, npc), meta: { id: npc.id, name: npc.name } });
  }
  for (const q of state.quests || []) {
    items.push({ key: `quest:${q.id}`, type: 'quest', text: withNote(`Quest: ${q.name}`, q), meta: { id: q.id, name: q.name } });
  }
  for (const dlg of state.dialogues || []) {
    // Dialogue-level item: title + relations + author note (nodes go separately below)
    const dlgNpc = dlg.npcId ? State.getNPC(dlg.npcId) : null;
    const dlgQuest = dlg.questId ? (state.quests || []).find((q) => q.id === dlg.questId) : null;
    const parts = [`Diálogo: ${dlg.title}`];
    if (dlgNpc) parts.push(`NPC: ${dlgNpc.name}`);
    if (dlgQuest) parts.push(`Quest: ${dlgQuest.name}`);
    items.push({
      key: `dialogue:${dlg.id}`,
      type: 'dialogue',
      text: withNote(parts.join(' · '), dlg),
      meta: { dialogueId: dlg.id, dialogueTitle: dlg.title },
    });
    for (const node of dlg.nodes || []) {
      const es = node.text?.es || '';
      const en = node.text?.en || '';
      if (!es.trim() && !en.trim()) continue;
      const npc = node.npcId ? State.getNPC(node.npcId) : null;
      const text = `[${dlg.title}] ${npc?.name || '¿?'}: ${es}${en.trim() ? `\nEN: ${en}` : ''}`;
      items.push({
        key: `node:${node.id}`,
        type: 'node',
        text,
        meta: { dialogueId: dlg.id, dialogueTitle: dlg.title, nodeId: node.id, npcName: npc?.name || null },
      });
    }
  }

  const cfg = AI.getConfig();
  for (const f of cfg.contextFiles || []) {
    chunkText(f.text).forEach((chunk, i) => {
      items.push({ key: `file:${f.name}:${i}`, type: 'file', text: chunk, meta: { fileName: f.name, chunk: i } });
    });
  }
  return items;
}

// ─── INDEXING ────────────────────────────────────────
/**
 * Full incremental sync: embeds new/changed items, removes stale ones.
 * Chat items are preserved (they are only managed by addChatExchange/clearChatMemory).
 */
export async function indexProject() {
  if (indexing) return { skipped: true };
  indexing = true;
  cancelRequested = false;
  try {
    const modelId = getModelId();
    const wanted = collectProjectItems();
    const existing = await loadAllItems();
    const existingByKey = new Map(existing.map((it) => [it.key, it]));

    // Re-embed on content change AND on model change: vectors from different
    // models can share dimensions but live in incompatible spaces.
    const toEmbed = [];
    for (const item of wanted) {
      const hash = hashStr(item.text);
      const prev = existingByKey.get(item.key);
      if (!prev || prev.hash !== hash || prev.model !== modelId) toEmbed.push({ ...item, hash });
    }

    // Chat items survive reindexes but must migrate to the current model too
    const staleChat = existing.filter((it) => it.type === 'chat' && it.model !== modelId);

    // Stale = stored project items whose key no longer exists (chat is kept)
    const wantedKeys = new Set(wanted.map((it) => it.key));
    const staleKeys = existing
      .filter((it) => it.type !== 'chat' && !wantedKeys.has(it.key))
      .map((it) => it.key);

    if (toEmbed.length > 0 || staleChat.length > 0) {
      const vectors = await embedTexts([...toEmbed, ...staleChat].map((it) => it.text));
      const now = Date.now();
      await tx('readwrite', (store) => {
        toEmbed.forEach((item, i) => {
          store.put({ ...item, model: modelId, vector: vectors[i], updatedAt: now });
        });
        staleChat.forEach((item, i) => {
          store.put({ ...item, model: modelId, vector: vectors[toEmbed.length + i] });
        });
        staleKeys.forEach((key) => store.delete(key));
      });
    } else if (staleKeys.length > 0) {
      await tx('readwrite', (store) => { staleKeys.forEach((key) => store.delete(key)); });
    }

    invalidateCache();
    const stats = await getStats();
    reportProgress({ phase: 'done', added: toEmbed.length, removed: staleKeys.length, total: stats.total });
    return { added: toEmbed.length, removed: staleKeys.length, total: stats.total };
  } catch (err) {
    // User-requested cancel: nothing was persisted (the write happens after
    // all embeddings complete), so the index is exactly as it was before.
    if (err && err.message === '__cancelled__') return { cancelled: true };
    throw err;
  } finally {
    indexing = false;
    cancelRequested = false;
  }
}

/**
 * Debounced background refresh, called on app state changes.
 * Only runs when the user already built an index once (avoids surprise
 * model downloads) and the feature is enabled.
 */
export function notifyStateChange() {
  if (!isEnabled()) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      if (await hasIndex()) await indexProject();
    } catch { /* background refresh is best-effort */ }
  }, 45_000);
}

// ─── SEARCH ──────────────────────────────────────────
/**
 * Semantic top-k search. Vectors are normalized, so cosine = dot product.
 * @returns [{key, type, typeLabel, text, meta, score}]
 */
export async function search(query, { k = 8, types = null } = {}) {
  const items = await loadAllItems();
  if (items.length === 0) return [];

  const modelId = getModelId();
  const [queryVec] = await embedTexts([query], 'query');
  const results = [];
  for (const item of items) {
    if (types && !types.includes(item.type)) continue;
    if (item.model !== modelId) continue; // stale vector from another embedding model
    const v = item.vector;
    if (!v || v.length !== queryVec.length) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    results.push({ ...item, score: dot, typeLabel: TYPE_LABELS[item.type] || item.type });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, k).filter((r) => r.score > 0.2);
}

// ─── CHAT MEMORY ─────────────────────────────────────
export async function addChatExchange(userText, assistantText) {
  if (!isEnabled() || !(await hasIndex())) return; // only remember once the user opted in by indexing
  const text = `Usuario: ${(userText || '').slice(0, 500)}\nAsistente: ${(assistantText || '').slice(0, 700)}`;
  const [vector] = await embedTexts([text]);
  const now = Date.now();
  const item = {
    key: `chat:${now}:${Math.random().toString(36).slice(2, 7)}`,
    type: 'chat',
    text,
    hash: hashStr(text),
    model: getModelId(),
    vector,
    meta: { ts: now },
    updatedAt: now,
  };
  await tx('readwrite', (store) => store.put(item));
  invalidateCache();

  // Prune oldest chat items beyond the cap
  const items = await loadAllItems();
  const chatItems = items.filter((it) => it.type === 'chat').sort((a, b) => a.updatedAt - b.updatedAt);
  if (chatItems.length > MAX_CHAT_ITEMS) {
    const excess = chatItems.slice(0, chatItems.length - MAX_CHAT_ITEMS).map((it) => it.key);
    await tx('readwrite', (store) => { excess.forEach((key) => store.delete(key)); });
    invalidateCache();
  }
}

export async function clearChatMemory() {
  const items = await loadAllItems();
  const chatKeys = items.filter((it) => it.type === 'chat').map((it) => it.key);
  if (chatKeys.length > 0) {
    await tx('readwrite', (store) => { chatKeys.forEach((key) => store.delete(key)); });
    invalidateCache();
  }
  return chatKeys.length;
}

export async function clearAll() {
  await tx('readwrite', (store) => store.clear());
  invalidateCache();
}

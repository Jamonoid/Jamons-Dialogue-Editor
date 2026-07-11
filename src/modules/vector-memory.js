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
  chat: 'Chat',
};

// ─── MODULE STATE ─────────────────────────────────────
let dbPromise = null;
let embedderPromise = null;
let embedderModelId = null;
let itemsCache = null;      // in-memory mirror of the IndexedDB store
let indexing = false;
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
  return { total: items.length, byType, model: getModelId() };
}

export async function getAllItems() {
  return loadAllItems().catch(() => []);
}

// ─── EMBEDDER (transformers.js, lazy-loaded) ─────────
async function getEmbedder() {
  const modelId = getModelId();
  if (embedderPromise && embedderModelId === modelId) return embedderPromise;
  embedderModelId = modelId;
  embedderPromise = (async () => {
    reportProgress({ phase: 'model', message: 'Cargando modelo de embeddings (primera vez descarga ~50 MB)...' });
    // Lazy import so the WASM/model never bloats app startup (same pattern as pdfjs/jszip)
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false; // always resolve from the HF hub + browser cache
    const extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8' });
    reportProgress({ phase: 'model', message: 'Modelo de embeddings listo.' });
    return extractor;
  })();
  embedderPromise.catch(() => { embedderPromise = null; embedderModelId = null; });
  return embedderPromise;
}

/** Embeds texts in small batches; returns arrays of normalized floats. */
async function embedTexts(texts) {
  const extractor = await getEmbedder();
  const vectors = [];
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const t = await extractor(batch, { pooling: 'mean', normalize: true });
    const [n, dim] = t.dims;
    for (let j = 0; j < n; j++) {
      vectors.push(Array.from(t.data.slice(j * dim, (j + 1) * dim)));
    }
    reportProgress({ phase: 'embed', done: Math.min(i + BATCH, texts.length), total: texts.length });
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

  for (const npc of state.npcs || []) {
    items.push({ key: `npc:${npc.id}`, type: 'npc', text: `NPC: ${npc.name}`, meta: { id: npc.id, name: npc.name } });
  }
  for (const q of state.quests || []) {
    items.push({ key: `quest:${q.id}`, type: 'quest', text: `Quest: ${q.name}`, meta: { id: q.id, name: q.name } });
  }
  for (const dlg of state.dialogues || []) {
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
  try {
    const wanted = collectProjectItems();
    const existing = await loadAllItems();
    const existingByKey = new Map(existing.map((it) => [it.key, it]));

    const toEmbed = [];
    for (const item of wanted) {
      const hash = hashStr(item.text);
      const prev = existingByKey.get(item.key);
      if (!prev || prev.hash !== hash) toEmbed.push({ ...item, hash });
    }

    // Stale = stored project items whose key no longer exists (chat is kept)
    const wantedKeys = new Set(wanted.map((it) => it.key));
    const staleKeys = existing
      .filter((it) => it.type !== 'chat' && !wantedKeys.has(it.key))
      .map((it) => it.key);

    if (toEmbed.length > 0) {
      const vectors = await embedTexts(toEmbed.map((it) => it.text));
      const now = Date.now();
      await tx('readwrite', (store) => {
        toEmbed.forEach((item, i) => {
          store.put({ ...item, vector: vectors[i], updatedAt: now });
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
  } finally {
    indexing = false;
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

  const [queryVec] = await embedTexts([query]);
  const results = [];
  for (const item of items) {
    if (types && !types.includes(item.type)) continue;
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

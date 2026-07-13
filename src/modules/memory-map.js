/**
 * memory-map.js — "Neural map" 3D visualization of the vector memory.
 *
 * Full-screen overlay (same pattern as the Audio Slicer) that projects the
 * embedding vectors to 3D with PCA (power iteration, no dependencies) and
 * renders them on a DPR-aware <canvas> with an orbit camera (drag = rotate,
 * shift/right-drag = pan, wheel = dolly zoom), perspective + depth-sorted
 * points, similarity links and hover tooltips. Pure canvas 2D — no WebGL.
 *
 * Clicking a point opens a right-side detail panel (full text, metadata,
 * nearest neighbors, and a navigate button for nodes/dialogues — clicks no
 * longer jump to the editor directly). The toolbar search box runs the exact
 * same retrieval the chat/generation RAG uses and highlights the hits, so
 * retrieval quality can be eyeballed. Model download/load progress is shown
 * with a real progress bar (bytes) fed by transformers.js progress events.
 */
import * as State from './state.js';
import * as VectorMemory from './vector-memory.js';
import { toast, confirmDelete } from './ui.js';

const TYPE_COLORS = {
  node: '#6c5ce7',
  file: '#00b894',
  npc: '#fdcb6e',
  quest: '#e17055',
  dialogue: '#fd79a8',
  chat: '#74b9ff',
};
const TYPE_LABEL = {
  node: 'Nodo',
  file: 'Archivo',
  npc: 'NPC',
  quest: 'Quest',
  dialogue: 'Diálogo',
  chat: 'Chat',
};
const WORLD_R = 500;        // points live in a cube [-WORLD_R, WORLD_R]³
const FOCAL = 900;          // perspective focal length (px)
const NEAR_PLANE = 60;      // points closer than this to the camera are culled
const LINK_MIN_SIM = 0.5;   // links below this are never computed
const MAX_LINK_ITEMS = 600; // above this, global link precomputation is skipped
const AUTO_ROTATE_SPEED = 0.0025; // rad/frame
const SEARCH_K = 10;        // results for the RAG test search

// ─── MODULE STATE ─────────────────────────────────────
let overlay = null;
let canvas = null;
let ctx = null;
let points = [];        // [{item, x, y, z}] in world coords
let screen = [];        // per-frame projections [{x, y, s, depth} | null]
let links = [];         // [{a, b, sim}] indexes into points
let keyToIdx = new Map();
let hiddenTypes = new Set();
let threshold = 0.75;
// Orbit camera
let yaw = -0.6;
let pitch = 0.35;
let camDist = 2200;
let pan = { x: 0, y: 0 };
let autoRotate = true;
let rafId = null;
let dragMode = null;    // null | 'orbit' | 'pan'
let lastMouse = { x: 0, y: 0 };
let downPos = { x: 0, y: 0 };
let hoveredIdx = -1;
let selectedIdx = -1;   // point shown in the detail panel
let searchHits = null;  // Map(pointIdx → score) while a RAG test search is active
let lastSearch = null;  // { query, results: [{idx, score}] } to return from a detail view
let closeCallback = null;

// ─── INIT ────────────────────────────────────────────
export function init() {
  overlay = document.getElementById('memory-map-overlay');
  if (!overlay) return;

  canvas = overlay.querySelector('#memmap-canvas');
  ctx = canvas?.getContext('2d');

  overlay.querySelector('#memmap-close')?.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Escape peels UI layers before closing the overlay
    const panel = overlay.querySelector('#memmap-detail');
    if (panel?.classList.contains('active')) { closePanel(); return; }
    if (searchHits) { clearSearch(); return; }
    close();
  });

  overlay.querySelector('#memmap-reindex')?.addEventListener('click', () => {
    if (VectorMemory.isIndexing()) {
      // While indexing, the same button cancels the run
      VectorMemory.requestCancel();
      const btn = overlay.querySelector('#memmap-reindex');
      if (btn) btn.textContent = '⏳ Cancelando...';
      return;
    }
    reindex();
  });
  overlay.querySelector('#memmap-index-now')?.addEventListener('click', () => reindex());
  overlay.querySelector('#memmap-clear')?.addEventListener('click', () => clearIndex());

  const rotateBtn = overlay.querySelector('#memmap-rotate');
  rotateBtn?.addEventListener('click', () => {
    autoRotate = !autoRotate;
    rotateBtn.classList.toggle('memmap-rotate-off', !autoRotate);
  });

  const slider = overlay.querySelector('#memmap-threshold');
  const sliderVal = overlay.querySelector('#memmap-threshold-value');
  slider?.addEventListener('input', () => {
    threshold = parseFloat(slider.value);
    if (sliderVal) sliderVal.textContent = threshold.toFixed(2);
    draw();
  });

  // RAG test search
  const searchInput = overlay.querySelector('#memmap-search');
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(searchInput.value.trim());
  });
  overlay.querySelector('#memmap-search-clear')?.addEventListener('click', () => clearSearch());

  // Legend: click to toggle a type on/off
  overlay.querySelectorAll('.memmap-key').forEach((el) => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      if (hiddenTypes.has(type)) hiddenTypes.delete(type);
      else hiddenTypes.add(type);
      el.classList.toggle('memmap-key-off', hiddenTypes.has(type));
      if (selectedIdx >= 0 && hiddenTypes.has(points[selectedIdx]?.item.type)) closePanel();
      draw();
    });
  });

  setupCanvasInteraction();
  window.addEventListener('resize', () => {
    if (overlay.classList.contains('active')) { resizeCanvas(); draw(); }
  });

  VectorMemory.onProgress(renderProgress);
}

/** onNavigate: called after jumping to a node so the app can re-render. */
export function setOnNavigate(cb) { closeCallback = cb; }

// ─── OPEN / CLOSE ────────────────────────────────────
export async function open() {
  if (!overlay) return;
  overlay.classList.add('active');
  overlay.focus();
  resizeCanvas();
  startLoop();
  await reload();
}

export function close() {
  if (overlay) overlay.classList.remove('active');
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function startLoop() {
  if (rafId) return;
  const step = () => {
    rafId = null;
    if (!overlay.classList.contains('active')) return;
    // Idle auto-rotation; pauses while dragging or inspecting a point
    if (autoRotate && !dragMode && hoveredIdx < 0 && points.length > 0) {
      yaw += AUTO_ROTATE_SPEED;
      draw();
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

async function reload() {
  const all = await VectorMemory.getAllItems();
  const emptyEl = overlay.querySelector('#memmap-empty');

  // Point indices change on reload — drop selection/search state
  closePanel();
  searchHits = null;
  lastSearch = null;
  const clearBtn = overlay.querySelector('#memmap-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';

  // Mixed-model guard: after switching the embeddings model (and before a
  // reindex) vectors from different models/dimensions coexist. Project only
  // the largest same-model group — PCA/links must never mix vector spaces.
  const groups = new Map();
  for (const it of all) {
    if (!it.vector || !it.vector.length) continue;
    const key = `${it.model || '?'}:${it.vector.length}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const items = groups.size > 0
    ? [...groups.values()].sort((a, b) => b.length - a.length)[0]
    : [];
  const skipped = all.length - items.length;
  const progressEl = overlay.querySelector('#memmap-progress');
  if (progressEl) {
    progressEl.textContent = skipped > 0
      ? `${skipped} vectores de otro modelo de embeddings ocultos — pulsa ⚡ Reindexar para migrarlos`
      : '';
  }

  if (items.length === 0) {
    points = [];
    links = [];
    keyToIdx = new Map();
    if (emptyEl) emptyEl.style.display = 'flex';
    updateStats();
    draw();
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  buildProjection(items);
  keyToIdx = new Map(points.map((p, i) => [p.item.key, i]));
  buildLinks();
  fitView();
  updateStats();
  draw();
}

async function reindex() {
  if (VectorMemory.isIndexing()) return;
  if (!VectorMemory.isEnabled()) {
    toast('La memoria vectorial está desactivada en IA Config.', 'error');
    return;
  }
  const btn = overlay.querySelector('#memmap-reindex');
  if (btn) { btn.textContent = '✕ Cancelar'; btn.title = 'Cancelar la indexación en curso'; }
  try {
    const res = await VectorMemory.indexProject();
    if (res.cancelled) {
      toast('Indexación cancelada — el índice quedó como estaba.', 'info');
    } else if (!res.skipped) {
      toast(`Índice actualizado: +${res.added || 0} nuevos, −${res.removed || 0} obsoletos (${res.total || 0} total)`, 'success');
      await reload();
    }
  } catch (err) {
    console.error('Reindex error:', err);
    toast('Error al indexar: ' + err.message, 'error');
  } finally {
    if (btn) { btn.textContent = '⚡ Reindexar'; btn.title = 'Reindexar el proyecto (nodos, archivos, NPCs, quests)'; }
    renderProgress(null);
  }
}

function clearIndex() {
  if (VectorMemory.isIndexing()) {
    toast('Hay una indexación en curso — cancélala primero con "✕ Cancelar".', 'error');
    return;
  }
  confirmDelete(
    '¿Borrar todo el índice vectorial? Los nodos, archivos, NPCs y quests se pueden reindexar después; la memoria del chat se pierde.',
    async () => {
      try {
        await VectorMemory.clearAll();
        toast('Índice vectorial borrado.', 'success');
        await reload();
      } catch (err) {
        console.error('Clear index error:', err);
        toast('Error al borrar el índice: ' + err.message, 'error');
      }
    }
  );
}

// ─── PROGRESS FEEDBACK ───────────────────────────────
function renderProgress(info) {
  const el = overlay?.querySelector('#memmap-progress');
  const bar = overlay?.querySelector('#memmap-progressbar');
  const fill = overlay?.querySelector('#memmap-progressbar-fill');
  if (!el) return;
  const showBar = (frac) => {
    if (!bar || !fill) return;
    bar.style.display = '';
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(frac * 100)))}%`;
  };
  const hideBar = () => { if (bar) bar.style.display = 'none'; };

  if (!info) { el.textContent = ''; hideBar(); return; }
  if (info.phase === 'download') {
    const mb = (b) => (b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1);
    const frac = info.total > 0 ? info.loaded / info.total : 0;
    el.textContent = `Descargando modelo: ${mb(info.loaded)} / ${mb(info.total)} MB (${Math.round(frac * 100)}%)`;
    showBar(frac);
  } else if (info.phase === 'model') {
    el.textContent = info.message || '';
    hideBar();
  } else if (info.phase === 'embed') {
    let eta = '';
    if (info.etaMs != null && info.done > 0 && info.done < info.total) {
      eta = info.etaMs > 90_000
        ? ` · ~${Math.round(info.etaMs / 60_000)} min restantes`
        : ` · ~${Math.max(1, Math.round(info.etaMs / 1000))} s restantes`;
    }
    el.textContent = `Generando embeddings... ${info.done}/${info.total}${eta}`;
    showBar(info.total > 0 ? info.done / info.total : 0);
  } else if (info.phase === 'done') {
    el.textContent = '';
    hideBar();
  }
}

async function updateStats() {
  const el = overlay.querySelector('#memmap-stats');
  if (!el) return;
  const stats = await VectorMemory.getStats();
  const parts = Object.entries(stats.byType).map(([t, n]) => `${n} ${t}`).join(' · ');
  const device = stats.device ? ` · ${stats.device}` : '';
  el.textContent = stats.total > 0 ? `${stats.total} vectores (${parts}) — ${stats.model}${device}` : '';
}

// ─── PCA PROJECTION (power iteration, 3 components) ──
function powerIteration(vectors, deflates = [], iterations = 60) {
  const dim = vectors[0].length;
  let v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() - 0.5;

  const normalize = (arr) => {
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) arr[i] /= norm;
  };
  const deflateVec = (arr) => {
    for (const d of deflates) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += arr[i] * d[i];
      for (let i = 0; i < dim; i++) arr[i] -= dot * d[i];
    }
  };

  deflateVec(v); normalize(v);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(dim);
    // next = Σ_i (x_i · v) x_i  — covariance-free power step
    for (const x of vectors) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += x[i] * v[i];
      for (let i = 0; i < dim; i++) next[i] += dot * x[i];
    }
    deflateVec(next); normalize(next);
    v = next;
  }
  return v;
}

function buildProjection(items) {
  const dim = items[0].vector.length;
  const n = items.length;

  // Too few points for 3 principal components: just space them on the X axis
  if (n < 4) {
    points = items.map((item, i) => ({
      item,
      x: n === 1 ? 0 : ((i / (n - 1)) * 2 - 1) * WORLD_R * 0.5,
      y: 0,
      z: 0,
    }));
    return;
  }

  // Mean-center
  const mean = new Float64Array(dim);
  for (const it of items) for (let i = 0; i < dim; i++) mean[i] += it.vector[i];
  for (let i = 0; i < dim; i++) mean[i] /= n;
  const centered = items.map((it) => {
    const c = new Float64Array(dim);
    for (let i = 0; i < dim; i++) c[i] = it.vector[i] - mean[i];
    return c;
  });

  const pc1 = powerIteration(centered);
  const pc2 = powerIteration(centered, [pc1]);
  const pc3 = powerIteration(centered, [pc1, pc2]);
  const proj = (pc) => centered.map((c) => {
    let d = 0;
    for (let i = 0; i < dim; i++) d += c[i] * pc[i];
    return d;
  });

  // Each axis is normalized independently to fill the world cube
  const toWorld = (vals) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = (max - min) || 1;
    return vals.map((v) => (((v - min) / span) * 2 - 1) * WORLD_R * 0.9);
  };
  const xs = toWorld(proj(pc1));
  const ys = toWorld(proj(pc2));
  const zs = toWorld(proj(pc3));

  points = items.map((item, i) => ({ item, x: xs[i], y: ys[i], z: zs[i] }));
}

function buildLinks() {
  links = [];
  const n = points.length;
  if (n < 2 || n > MAX_LINK_ITEMS) return; // too many: links only shown for the hovered point

  const K = 3; // strongest K neighbors per point
  const best = Array.from({ length: n }, () => []);
  for (let a = 0; a < n; a++) {
    const va = points[a].item.vector;
    for (let b = a + 1; b < n; b++) {
      const vb = points[b].item.vector;
      let dot = 0;
      for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
      if (dot < LINK_MIN_SIM) continue;
      best[a].push({ other: b, sim: dot });
      best[b].push({ other: a, sim: dot });
    }
  }
  const seen = new Set();
  for (let a = 0; a < n; a++) {
    best[a].sort((p, q) => q.sim - p.sim);
    for (const { other, sim } of best[a].slice(0, K)) {
      const key = a < other ? `${a}:${other}` : `${other}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ a: Math.min(a, other), b: Math.max(a, other), sim });
    }
  }
}

// ─── VIEW TRANSFORM ──────────────────────────────────
function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function viewSize() {
  const dpr = window.devicePixelRatio || 1;
  return { w: canvas.width / dpr, h: canvas.height / dpr };
}

function fitView() {
  const { w, h } = viewSize();
  yaw = -0.6;
  pitch = 0.35;
  pan = { x: 0, y: 0 };
  // Dolly so the world cube spans ~86% of the smaller viewport side
  const target = Math.min(w, h) * 0.86 || 600;
  camDist = Math.max(FOCAL * 0.7, (FOCAL * 2 * WORLD_R) / target);
}

/** Rotates (yaw around Y, then pitch around X) + perspective-projects one world point. */
function projectPoint(x, y, z, trig, cx, cy) {
  const x1 = x * trig.cy + z * trig.sy;
  const z1 = -x * trig.sy + z * trig.cy;
  const y1 = y * trig.cp - z1 * trig.sp;
  const z2 = y * trig.sp + z1 * trig.cp;
  const depth = z2 + camDist;
  if (depth < NEAR_PLANE) return null; // behind / too close to the camera
  const s = FOCAL / depth;
  return { x: x1 * s + cx, y: y1 * s + cy, s, depth };
}

function computeScreens() {
  const { w, h } = viewSize();
  const trig = { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
  const cx = w / 2 + pan.x;
  const cy = h / 2 + pan.y;
  screen = points.map((p) => projectPoint(p.x, p.y, p.z, trig, cx, cy));
  return { trig, cx, cy };
}

// ─── DRAW ────────────────────────────────────────────
function draw() {
  if (!ctx) return;
  const { w, h } = viewSize();
  ctx.clearRect(0, 0, w, h);

  if (points.length === 0) return;

  const { trig, cx, cy } = computeScreens();
  const visible = (i) => screen[i] && !hiddenTypes.has(points[i].item.type);
  const sRef = FOCAL / camDist; // projection scale at the world center

  drawWorldCube(trig, cx, cy);

  // Links (precomputed kNN, filtered by the live threshold), faded with depth
  ctx.lineWidth = 1;
  for (const { a, b, sim } of links) {
    if (sim < threshold) continue;
    if (!visible(a) || !visible(b)) continue;
    const sa = screen[a], sb = screen[b];
    const alpha = 0.08 + (sim - threshold) / (1 - threshold + 0.001) * 0.35;
    const depthFade = Math.max(0.35, Math.min(1, Math.min(sa.s, sb.s) / sRef));
    ctx.strokeStyle = `rgba(162, 155, 254, ${Math.min(alpha * depthFade, 0.45)})`;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }

  // Hover links (for big datasets where global links are skipped)
  if (hoveredIdx >= 0 && points.length > MAX_LINK_ITEMS && visible(hoveredIdx)) {
    const va = points[hoveredIdx].item.vector;
    const sa = screen[hoveredIdx];
    for (let b = 0; b < points.length; b++) {
      if (b === hoveredIdx || !visible(b)) continue;
      const vb = points[b].item.vector;
      let dot = 0;
      for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
      if (dot < threshold) continue;
      const sb = screen[b];
      ctx.strokeStyle = 'rgba(162, 155, 254, 0.5)';
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    }
  }

  // Points: painter's algorithm — far ones first, perspective size + depth alpha
  const order = [];
  let minD = Infinity, maxD = -Infinity;
  for (let i = 0; i < points.length; i++) {
    if (!visible(i)) continue;
    order.push(i);
    const d = screen[i].depth;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  order.sort((a, b) => screen[b].depth - screen[a].depth);
  const dSpan = (maxD - minD) || 1;

  for (const i of order) {
    const p = points[i];
    const s = screen[i];
    if (s.x < -12 || s.x > w + 12 || s.y < -12 || s.y > h + 12) continue;
    const isHover = i === hoveredIdx;
    const isSelected = i === selectedIdx;
    const hitScore = searchHits ? searchHits.get(i) : undefined;
    const baseR = isHover || isSelected ? 7 : p.item.type === 'file' ? 4 : 5;
    const r = Math.max(1.5, Math.min(10, baseR * (s.s / sRef)));
    const closeness = 1 - (s.depth - minD) / dSpan; // 1 = nearest, 0 = farthest
    let alpha = isHover || isSelected ? 1 : 0.4 + 0.55 * closeness;
    // While a test search is active, spotlight the hits and dim the rest
    if (searchHits) alpha = hitScore !== undefined ? 1 : alpha * 0.25;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = TYPE_COLORS[p.item.type] || '#888';
    ctx.globalAlpha = alpha;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (hitScore !== undefined) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isHover || isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Subtle wireframe of the world cube — the main 3D depth reference. */
function drawWorldCube(trig, cx, cy) {
  const R = WORLD_R;
  const corners = [];
  for (const x of [-R, R]) for (const y of [-R, R]) for (const z of [-R, R]) {
    corners.push(projectPoint(x, y, z, trig, cx, cy));
  }
  // Corner index = (x>0)*4 + (y>0)*2 + (z>0); edges join corners differing in one bit
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(162, 155, 254, 0.10)';
  for (const [a, b] of EDGES) {
    const pa = corners[a], pb = corners[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
}

// ─── DETAIL PANEL ────────────────────────────────────
function getPanel() { return overlay.querySelector('#memmap-detail'); }

function closePanel() {
  selectedIdx = -1;
  const panel = getPanel();
  if (panel) panel.classList.remove('active');
  draw();
}

function metaLines(item) {
  const m = item.meta || {};
  const lines = [];
  if (item.type === 'node') {
    if (m.dialogueTitle) lines.push(['Diálogo', m.dialogueTitle]);
    if (m.npcName) lines.push(['NPC', m.npcName]);
  } else if (item.type === 'dialogue') {
    if (m.dialogueTitle) lines.push(['Título', m.dialogueTitle]);
  } else if (item.type === 'file') {
    if (m.fileName) lines.push(['Archivo', m.fileName]);
    if (m.chunk !== undefined) lines.push(['Fragmento', `#${m.chunk + 1}`]);
  } else if (item.type === 'chat' && m.ts) {
    lines.push(['Fecha', new Date(m.ts).toLocaleString()]);
  }
  return lines;
}

function showDetail(idx) {
  const panel = getPanel();
  if (!panel || !points[idx]) return;
  selectedIdx = idx;
  const item = points[idx].item;
  const color = TYPE_COLORS[item.type] || '#888';
  const label = TYPE_LABEL[item.type] || item.type;

  // Nearest neighbors by cosine (same-model group, so dims always match)
  const va = item.vector;
  const neigh = [];
  for (let j = 0; j < points.length; j++) {
    if (j === idx) continue;
    const vb = points[j].item.vector;
    let dot = 0;
    for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
    neigh.push({ j, sim: dot });
  }
  neigh.sort((a, b) => b.sim - a.sim);
  const top = neigh.slice(0, 6);

  const navBtn = item.type === 'node' && item.meta?.nodeId
    ? '<button class="btn btn-sm btn-block" id="memmap-goto">→ Ir al nodo en el editor</button>'
    : item.type === 'dialogue' && item.meta?.dialogueId
      ? '<button class="btn btn-sm btn-block" id="memmap-goto">→ Abrir el diálogo en el editor</button>'
      : '';
  const backBtn = lastSearch
    ? '<button class="btn btn-sm" id="memmap-back" title="Volver a los resultados de búsqueda">← Resultados</button>'
    : '';

  panel.innerHTML = `
    <div class="memmap-detail-header">
      <span class="memmap-detail-type" style="background:${color}20;color:${color};border-color:${color}40">${label}</span>
      ${backBtn}
      <button class="memmap-detail-close" id="memmap-detail-close" title="Cerrar (Esc)">✕</button>
    </div>
    ${metaLines(item).map(([k, v]) => `<div class="memmap-detail-meta"><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</div>`).join('')}
    <div class="memmap-detail-text">${escapeHtml(item.text)}</div>
    ${navBtn}
    <div class="memmap-detail-simtitle">Más similares (coseno)</div>
    <div class="memmap-detail-neighbors">
      ${top.map(({ j, sim }) => {
        const it = points[j].item;
        return `<div class="memmap-neighbor" data-idx="${j}" title="Ver detalles">
          <i style="background:${TYPE_COLORS[it.type] || '#888'}"></i>
          <span class="memmap-neighbor-text">${escapeHtml(it.text.slice(0, 80))}</span>
          <span class="memmap-neighbor-sim">${sim.toFixed(2)}</span>
        </div>`;
      }).join('') || '<div class="memmap-detail-meta">(sin vecinos)</div>'}
    </div>
  `;
  panel.classList.add('active');
  panel.scrollTop = 0;

  panel.querySelector('#memmap-detail-close')?.addEventListener('click', () => closePanel());
  panel.querySelector('#memmap-back')?.addEventListener('click', () => renderSearchResults());
  panel.querySelector('#memmap-goto')?.addEventListener('click', () => {
    if (item.type === 'node') {
      State.setActiveDialogueId(item.meta.dialogueId);
      State.setSelectedNodeId(item.meta.nodeId);
    } else {
      State.setActiveDialogueId(item.meta.dialogueId);
    }
    State.notifyChange();
    close();
    if (closeCallback) closeCallback(item.meta);
  });
  panel.querySelectorAll('.memmap-neighbor').forEach((row) => {
    row.addEventListener('click', () => showDetail(parseInt(row.dataset.idx, 10)));
  });

  draw();
}

// ─── RAG TEST SEARCH ─────────────────────────────────
async function runSearch(query) {
  if (!query) { clearSearch(); return; }
  if (points.length === 0) {
    toast('Indexa el proyecto primero (⚡ Indexar proyecto).', 'error');
    return;
  }
  const input = overlay.querySelector('#memmap-search');
  if (input) input.disabled = true;
  try {
    // The exact same retrieval path the chat / generation RAG uses
    const hits = await VectorMemory.search(query, { k: SEARCH_K });
    const results = hits
      .map((h) => ({ idx: keyToIdx.get(h.key), score: h.score }))
      .filter((r) => r.idx !== undefined);
    lastSearch = { query, results };
    searchHits = new Map(results.map((r) => [r.idx, r.score]));
    const clearBtn = overlay.querySelector('#memmap-search-clear');
    if (clearBtn) clearBtn.style.display = '';
    renderSearchResults();
    renderProgress(null);
    draw();
  } catch (err) {
    console.error('RAG test search error:', err);
    toast('Error en la búsqueda: ' + err.message, 'error');
  } finally {
    if (input) input.disabled = false;
  }
}

function renderSearchResults() {
  const panel = getPanel();
  if (!panel || !lastSearch) return;
  selectedIdx = -1;
  const { query, results } = lastSearch;

  panel.innerHTML = `
    <div class="memmap-detail-header">
      <span class="memmap-detail-type" style="background:#ffd16620;color:#ffd166;border-color:#ffd16640">🔍 ${results.length} resultado${results.length !== 1 ? 's' : ''}</span>
      <button class="memmap-detail-close" id="memmap-detail-close" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="memmap-detail-meta"><b>Consulta:</b> ${escapeHtml(query)}</div>
    <div class="memmap-detail-meta">Esto es exactamente lo que el RAG recuperaría para esta consulta (chat: top 8 · generación: top 10, sin chat). Score = similitud coseno; &lt;0.2 se descarta.</div>
    <div class="memmap-detail-neighbors">
      ${results.map(({ idx, score }, rank) => {
        const it = points[idx].item;
        return `<div class="memmap-neighbor" data-idx="${idx}" title="Ver detalles">
          <span class="memmap-neighbor-rank">${rank + 1}</span>
          <i style="background:${TYPE_COLORS[it.type] || '#888'}"></i>
          <span class="memmap-neighbor-text">${escapeHtml(it.text.slice(0, 80))}</span>
          <span class="memmap-neighbor-sim">${score.toFixed(2)}</span>
        </div>`;
      }).join('') || '<div class="memmap-detail-meta">Nada supera el umbral de 0.2 — prueba otra consulta o revisa el modelo de embeddings.</div>'}
    </div>
  `;
  panel.classList.add('active');
  panel.scrollTop = 0;

  panel.querySelector('#memmap-detail-close')?.addEventListener('click', () => closePanel());
  panel.querySelectorAll('.memmap-neighbor').forEach((row) => {
    row.addEventListener('click', () => showDetail(parseInt(row.dataset.idx, 10)));
  });
  draw();
}

function clearSearch() {
  searchHits = null;
  lastSearch = null;
  const input = overlay.querySelector('#memmap-search');
  if (input) input.value = '';
  const clearBtn = overlay.querySelector('#memmap-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  closePanel();
}

// ─── INTERACTION ─────────────────────────────────────
function setupCanvasInteraction() {
  if (!canvas) return;
  const tooltip = overlay.querySelector('#memmap-tooltip');

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.shiftKey) {
      dragMode = 'orbit';
      autoRotate = false;
      overlay.querySelector('#memmap-rotate')?.classList.add('memmap-rotate-off');
    } else if (e.button === 0 || e.button === 1 || e.button === 2) {
      dragMode = 'pan';
    } else {
      return;
    }
    if (e.button === 1) e.preventDefault(); // middle click: no autoscroll
    lastMouse = { x: e.clientX, y: e.clientY };
    downPos = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag = pan

  window.addEventListener('mouseup', () => {
    dragMode = null;
    if (canvas) canvas.style.cursor = 'default';
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragMode) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      lastMouse = { x: e.clientX, y: e.clientY };
      if (dragMode === 'orbit') {
        // Trackball feel: the front of the cloud follows the cursor.
        // Screen-x grows right but yaw spins the world the other way, hence -=.
        yaw -= dx * 0.005;
        pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * 0.005));
      } else {
        pan.x += dx;
        pan.y += dy;
      }
      draw();
      return;
    }

    // Hover hit-test on the projected positions (nearest visible point within 10 px)
    let bestIdx = -1, bestDist = 10;
    for (let i = 0; i < points.length; i++) {
      const s = screen[i];
      if (!s || hiddenTypes.has(points[i].item.type)) continue;
      const d = Math.hypot(s.x - mx, s.y - my);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx !== hoveredIdx) {
      hoveredIdx = bestIdx;
      draw();
    }

    if (tooltip) {
      if (hoveredIdx >= 0) {
        const item = points[hoveredIdx].item;
        const label = TYPE_LABEL[item.type] || item.type;
        const extra = item.type === 'node' && item.meta?.dialogueTitle ? ` — ${item.meta.dialogueTitle}` : '';
        tooltip.innerHTML = `<b style="color:${TYPE_COLORS[item.type]}">${label}${extra}</b><br>${escapeHtml(item.text.slice(0, 220))}${item.text.length > 220 ? '…' : ''}<br><i>Clic para ver detalles</i>`;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(mx + 14, rect.width - 320) + 'px';
        tooltip.style.top = Math.min(my + 14, rect.height - 120) + 'px';
        canvas.style.cursor = 'pointer';
      } else {
        tooltip.style.display = 'none';
        if (!dragMode) canvas.style.cursor = 'default';
      }
    }
  });

  canvas.addEventListener('click', (e) => {
    // A drag (orbit/pan) shouldn't select — only treat as click if barely moved
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) return;
    if (hoveredIdx >= 0) {
      showDetail(hoveredIdx);
    } else if (selectedIdx >= 0 || getPanel()?.classList.contains('active')) {
      // Click on empty space: close the panel (search highlights stay)
      closePanel();
    }
  });

  // Wheel = dolly zoom, approximately anchored at the cursor
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { w, h } = viewSize();
    const prevDist = camDist;
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    camDist = Math.max(FOCAL * 0.7, Math.min(9000, camDist * factor));
    // Screen positions scale ~ prevDist/camDist around the (panned) center;
    // shift the pan so the point under the cursor stays put
    const k = prevDist / camDist;
    pan.x = mx - w / 2 - (mx - w / 2 - pan.x) * k;
    pan.y = my - h / 2 - (my - h / 2 - pan.y) * k;
    draw();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => { fitView(); draw(); });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

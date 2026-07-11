/**
 * memory-map.js — "Neural map" visualization of the vector memory.
 *
 * Full-screen overlay (same pattern as the Audio Slicer) that projects the
 * embedding vectors to 2D with PCA (power iteration, no dependencies) and
 * renders them on a DPR-aware <canvas> with pan/zoom, similarity links,
 * hover tooltips and click-to-navigate for dialogue nodes.
 */
import * as State from './state.js';
import * as VectorMemory from './vector-memory.js';
import { toast } from './ui.js';

const TYPE_COLORS = {
  node: '#6c5ce7',
  file: '#00b894',
  npc: '#fdcb6e',
  quest: '#e17055',
  chat: '#74b9ff',
};
const WORLD_W = 1600;
const WORLD_H = 1000;
const LINK_MIN_SIM = 0.5;   // links below this are never computed
const MAX_LINK_ITEMS = 600; // above this, global link precomputation is skipped

// ─── MODULE STATE ─────────────────────────────────────
let overlay = null;
let canvas = null;
let ctx = null;
let points = [];        // [{item, x, y}] in world coords
let links = [];         // [{a, b, sim}] indexes into points
let hiddenTypes = new Set();
let threshold = 0.75;
let offset = { x: 0, y: 0 };
let zoom = 1;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let hoveredIdx = -1;
let closeCallback = null;

// ─── INIT ────────────────────────────────────────────
export function init() {
  overlay = document.getElementById('memory-map-overlay');
  if (!overlay) return;

  canvas = overlay.querySelector('#memmap-canvas');
  ctx = canvas?.getContext('2d');

  overlay.querySelector('#memmap-close')?.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  overlay.querySelector('#memmap-reindex')?.addEventListener('click', () => reindex());
  overlay.querySelector('#memmap-index-now')?.addEventListener('click', () => reindex());

  const slider = overlay.querySelector('#memmap-threshold');
  const sliderVal = overlay.querySelector('#memmap-threshold-value');
  slider?.addEventListener('input', () => {
    threshold = parseFloat(slider.value);
    if (sliderVal) sliderVal.textContent = threshold.toFixed(2);
    draw();
  });

  // Legend: click to toggle a type on/off
  overlay.querySelectorAll('.memmap-key').forEach((el) => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      if (hiddenTypes.has(type)) hiddenTypes.delete(type);
      else hiddenTypes.add(type);
      el.classList.toggle('memmap-key-off', hiddenTypes.has(type));
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
  await reload();
}

export function close() {
  if (overlay) overlay.classList.remove('active');
}

async function reload() {
  const items = await VectorMemory.getAllItems();
  const emptyEl = overlay.querySelector('#memmap-empty');

  if (items.length === 0) {
    points = [];
    links = [];
    if (emptyEl) emptyEl.style.display = 'flex';
    updateStats();
    draw();
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  buildProjection(items);
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
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Indexando...'; }
  try {
    const res = await VectorMemory.indexProject();
    toast(`Índice actualizado: +${res.added || 0} nuevos, −${res.removed || 0} obsoletos (${res.total || 0} total)`, 'success');
    await reload();
  } catch (err) {
    console.error('Reindex error:', err);
    toast('Error al indexar: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Reindexar'; }
    renderProgress(null);
  }
}

function renderProgress(info) {
  const el = overlay?.querySelector('#memmap-progress');
  if (!el) return;
  if (!info) { el.textContent = ''; return; }
  if (info.phase === 'model') el.textContent = info.message || '';
  else if (info.phase === 'embed') el.textContent = `Generando embeddings... ${info.done}/${info.total}`;
  else if (info.phase === 'done') el.textContent = '';
}

async function updateStats() {
  const el = overlay.querySelector('#memmap-stats');
  if (!el) return;
  const stats = await VectorMemory.getStats();
  const parts = Object.entries(stats.byType).map(([t, n]) => `${n} ${t}`).join(' · ');
  el.textContent = stats.total > 0 ? `${stats.total} vectores (${parts}) — ${stats.model}` : '';
}

// ─── PCA PROJECTION (power iteration) ────────────────
function powerIteration(vectors, deflate = null, iterations = 60) {
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
    if (!deflate) return;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += arr[i] * deflate[i];
    for (let i = 0; i < dim; i++) arr[i] -= dot * deflate[i];
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

  // Mean-center
  const mean = new Float64Array(dim);
  for (const it of items) for (let i = 0; i < dim; i++) mean[i] += it.vector[i];
  for (let i = 0; i < dim; i++) mean[i] /= n;
  const centered = items.map((it) => {
    const c = new Float64Array(dim);
    for (let i = 0; i < dim; i++) c[i] = it.vector[i] - mean[i];
    return c;
  });

  let xs, ys;
  if (n < 3) {
    xs = items.map((_, i) => i);
    ys = items.map(() => 0);
  } else {
    const pc1 = powerIteration(centered);
    const pc2 = powerIteration(centered, pc1);
    xs = centered.map((c) => { let d = 0; for (let i = 0; i < dim; i++) d += c[i] * pc1[i]; return d; });
    ys = centered.map((c) => { let d = 0; for (let i = 0; i < dim; i++) d += c[i] * pc2[i]; return d; });
  }

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;

  points = items.map((item, i) => ({
    item,
    x: 60 + ((xs[i] - minX) / spanX) * (WORLD_W - 120),
    y: 60 + ((ys[i] - minY) / spanY) * (WORLD_H - 120),
  }));
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
  zoom = Math.min(w / WORLD_W, h / WORLD_H) * 0.92;
  offset.x = (w - WORLD_W * zoom) / 2;
  offset.y = (h - WORLD_H * zoom) / 2;
}

const toScreen = (p) => ({ x: p.x * zoom + offset.x, y: p.y * zoom + offset.y });

// ─── DRAW ────────────────────────────────────────────
function draw() {
  if (!ctx) return;
  const { w, h } = viewSize();
  ctx.clearRect(0, 0, w, h);

  if (points.length === 0) return;

  const visible = (p) => !hiddenTypes.has(p.item.type);

  // Links (precomputed kNN, filtered by the live threshold)
  ctx.lineWidth = 1;
  for (const { a, b, sim } of links) {
    if (sim < threshold) continue;
    const pa = points[a], pb = points[b];
    if (!visible(pa) || !visible(pb)) continue;
    const sa = toScreen(pa), sb = toScreen(pb);
    const alpha = 0.08 + (sim - threshold) / (1 - threshold + 0.001) * 0.35;
    ctx.strokeStyle = `rgba(162, 155, 254, ${Math.min(alpha, 0.45)})`;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }

  // Hover links (for big datasets where global links are skipped)
  if (hoveredIdx >= 0 && points.length > MAX_LINK_ITEMS) {
    const pa = points[hoveredIdx];
    const va = pa.item.vector;
    const sa = toScreen(pa);
    for (let b = 0; b < points.length; b++) {
      if (b === hoveredIdx || !visible(points[b])) continue;
      const vb = points[b].item.vector;
      let dot = 0;
      for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
      if (dot < threshold) continue;
      const sb = toScreen(points[b]);
      ctx.strokeStyle = 'rgba(162, 155, 254, 0.5)';
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    }
  }

  // Points
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!visible(p)) continue;
    const s = toScreen(p);
    if (s.x < -10 || s.x > w + 10 || s.y < -10 || s.y > h + 10) continue;
    const isHover = i === hoveredIdx;
    const r = isHover ? 7 : p.item.type === 'file' ? 4 : 5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = TYPE_COLORS[p.item.type] || '#888';
    ctx.globalAlpha = isHover ? 1 : 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (isHover) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ─── INTERACTION ─────────────────────────────────────
function setupCanvasInteraction() {
  if (!canvas) return;
  const tooltip = overlay.querySelector('#memmap-tooltip');

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    panStart = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    if (canvas) canvas.style.cursor = 'default';
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isPanning) {
      offset.x = e.clientX - panStart.x;
      offset.y = e.clientY - panStart.y;
      draw();
      return;
    }

    // Hover hit-test (nearest visible point within 10 px)
    let bestIdx = -1, bestDist = 10;
    for (let i = 0; i < points.length; i++) {
      if (hiddenTypes.has(points[i].item.type)) continue;
      const s = toScreen(points[i]);
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
        const label = { node: 'Nodo', file: 'Archivo', npc: 'NPC', quest: 'Quest', chat: 'Chat' }[item.type] || item.type;
        const extra = item.type === 'node' && item.meta?.dialogueTitle ? ` — ${item.meta.dialogueTitle}` : '';
        tooltip.innerHTML = `<b style="color:${TYPE_COLORS[item.type]}">${label}${extra}</b><br>${escapeHtml(item.text.slice(0, 220))}${item.text.length > 220 ? '…' : ''}${item.type === 'node' ? '<br><i>Clic para ir al nodo</i>' : ''}`;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(mx + 14, rect.width - 320) + 'px';
        tooltip.style.top = Math.min(my + 14, rect.height - 120) + 'px';
        canvas.style.cursor = points[hoveredIdx].item.type === 'node' ? 'pointer' : 'default';
      } else {
        tooltip.style.display = 'none';
        if (!isPanning) canvas.style.cursor = 'default';
      }
    }
  });

  canvas.addEventListener('click', (e) => {
    // A drag shouldn't navigate — only treat as click if barely moved
    if (hoveredIdx < 0) return;
    const item = points[hoveredIdx].item;
    if (item.type !== 'node' || !item.meta?.nodeId) return;
    State.setActiveDialogueId(item.meta.dialogueId);
    State.setSelectedNodeId(item.meta.nodeId);
    State.notifyChange();
    close();
    if (closeCallback) closeCallback(item.meta);
  });

  // Cursor-anchored wheel zoom (same math as the dialogue canvas)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const prevZoom = zoom;
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    zoom = Math.max(0.1, Math.min(6, zoom * factor));
    offset.x = mx - (mx - offset.x) * (zoom / prevZoom);
    offset.y = my - (my - offset.y) * (zoom / prevZoom);
    draw();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => { fitView(); draw(); });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

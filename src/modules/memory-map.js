/**
 * memory-map.js — "Neural map" 3D visualization of the vector memory.
 *
 * Full-screen overlay (same pattern as the Audio Slicer) that projects the
 * embedding vectors to 3D with PCA (power iteration, no dependencies) and
 * renders them on a DPR-aware <canvas> with an orbit camera (drag = rotate,
 * shift/right-drag = pan, wheel = dolly zoom), perspective + depth-sorted
 * points, similarity links, hover tooltips and click-to-navigate for
 * dialogue nodes. Pure canvas 2D — no WebGL/three.js dependency.
 */
import * as State from './state.js';
import * as VectorMemory from './vector-memory.js';
import { toast, confirmDelete } from './ui.js';

const TYPE_COLORS = {
  node: '#6c5ce7',
  file: '#00b894',
  npc: '#fdcb6e',
  quest: '#e17055',
  chat: '#74b9ff',
};
const WORLD_R = 500;        // points live in a cube [-WORLD_R, WORLD_R]³
const FOCAL = 900;          // perspective focal length (px)
const NEAR_PLANE = 60;      // points closer than this to the camera are culled
const LINK_MIN_SIM = 0.5;   // links below this are never computed
const MAX_LINK_ITEMS = 600; // above this, global link precomputation is skipped
const AUTO_ROTATE_SPEED = 0.0025; // rad/frame

// ─── MODULE STATE ─────────────────────────────────────
let overlay = null;
let canvas = null;
let ctx = null;
let points = [];        // [{item, x, y, z}] in world coords
let screen = [];        // per-frame projections [{x, y, s, depth} | null]
let links = [];         // [{a, b, sim}] indexes into points
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

function clearIndex() {
  if (VectorMemory.isIndexing()) return;
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
    const baseR = isHover ? 7 : p.item.type === 'file' ? 4 : 5;
    const r = Math.max(1.5, Math.min(10, baseR * (s.s / sRef)));
    const closeness = 1 - (s.depth - minD) / dSpan; // 1 = nearest, 0 = farthest
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = TYPE_COLORS[p.item.type] || '#888';
    ctx.globalAlpha = isHover ? 1 : 0.4 + 0.55 * closeness;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (isHover) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
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
        const label = { node: 'Nodo', file: 'Archivo', npc: 'NPC', quest: 'Quest', chat: 'Chat' }[item.type] || item.type;
        const extra = item.type === 'node' && item.meta?.dialogueTitle ? ` — ${item.meta.dialogueTitle}` : '';
        tooltip.innerHTML = `<b style="color:${TYPE_COLORS[item.type]}">${label}${extra}</b><br>${escapeHtml(item.text.slice(0, 220))}${item.text.length > 220 ? '…' : ''}${item.type === 'node' ? '<br><i>Clic para ir al nodo</i>' : ''}`;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(mx + 14, rect.width - 320) + 'px';
        tooltip.style.top = Math.min(my + 14, rect.height - 120) + 'px';
        canvas.style.cursor = points[hoveredIdx].item.type === 'node' ? 'pointer' : 'default';
      } else {
        tooltip.style.display = 'none';
        if (!dragMode) canvas.style.cursor = 'default';
      }
    }
  });

  canvas.addEventListener('click', (e) => {
    // A drag (orbit/pan) shouldn't navigate — only treat as click if barely moved
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) return;
    if (hoveredIdx < 0) return;
    const item = points[hoveredIdx].item;
    if (item.type !== 'node' || !item.meta?.nodeId) return;
    State.setActiveDialogueId(item.meta.dialogueId);
    State.setSelectedNodeId(item.meta.nodeId);
    State.notifyChange();
    close();
    if (closeCallback) closeCallback(item.meta);
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

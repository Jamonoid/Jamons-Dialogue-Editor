/**
 * Layout — graph geometry shared by the canvas, the MCP bridge and the chat:
 * node box measurement, comment-box containment/wrapping, relative placement
 * and the tidy top-down tree layout.
 *
 * Deliberately free of state.js imports: it only reads/writes the plain graph
 * objects it is given ({ nodes, comments, startNodeId }), so it works on any
 * graph (active dialogue, background dialogue, story map) without cycles.
 * Callers wrap mutations in State.startBatch()/endBatch().
 */

// ─── NODE GEOMETRY ───────────────────────────────────
// Mirrors the .dialogue-node CSS in style.css. Auto-height nodes (height null)
// only have a real size once rendered; otherwise their height is estimated.
export const NODE_DEFAULT_W = 240;
const TEXT_LINE_H = 19.5;    // .node-inline-text: 13px × line-height 1.5
const NODE_CHROME_H = 94;    // header + body/textarea padding + footer + borders
const TEXT_SIDE_CHROME = 32; // borders + paddings left/right of the text
const MIN_TEXT_LINES = 2;    // a textarea never auto-sizes below its default 2 rows

// Advance widths of 13px Inter, rounded UP so estimates err on the tall side
// (a box wrapped around an under-estimated node would not contain it).
function charWidth(ch) {
  if (ch === ' ') return 3.8;
  if ('iljtfI.,;:!|\'"()[]¡¿'.includes(ch)) return 4.2;
  if ('mwMW'.includes(ch)) return 11;
  if (/[A-ZÁÉÍÓÚÑÜ]/.test(ch)) return 9;
  if (/[0-9]/.test(ch)) return 7.8;
  return 7.1;
}

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Wrapped line count of `text` in a textarea whose content box is `width` px wide. */
function estimateTextLines(text, width) {
  if (!text) return 0;
  let lines = 0;
  for (const para of text.split('\n')) {
    let paraLines = 1;
    let lineW = 0;
    for (const word of para.split(' ')) {
      const w = textWidth(word);
      const needed = lineW > 0 ? lineW + charWidth(' ') + w : w;
      if (needed <= width) {
        lineW = needed;
        continue;
      }
      if (lineW > 0) paraLines++;
      // word-break: break-word — an overlong word spills onto extra lines
      if (w > width) {
        paraLines += Math.ceil(w / width) - 1;
        lineW = w % width;
      } else {
        lineW = w;
      }
    }
    lines += paraLines;
  }
  return lines;
}

/** Height estimate for a node that is not rendered — the taller of its ES/EN texts. */
export function estimateNodeHeight(node) {
  const contentW = (node.width || NODE_DEFAULT_W) - TEXT_SIDE_CHROME;
  const lines = Math.max(
    MIN_TEXT_LINES,
    estimateTextLines(node.text?.es || '', contentW),
    estimateTextLines(node.text?.en || '', contentW),
  );
  return Math.ceil(NODE_CHROME_H + lines * TEXT_LINE_H);
}

// offsetHeight is layout size, unaffected by the canvas scale() transform —
// never divide it by the zoom.
function renderedHeight(node) {
  const el = document.querySelector(`.dialogue-node[data-node-id="${node.id}"]`);
  return el ? el.offsetHeight : 0;
}

/** Node box as drawn: explicit size, else the rendered height, else an estimate. */
export function getNodeRect(node) {
  return {
    x: node.x,
    y: node.y,
    w: node.width || NODE_DEFAULT_W,
    h: node.height || renderedHeight(node) || estimateNodeHeight(node),
  };
}

// Layout plans with the taller of rendered/estimated: the estimate also covers
// the language that is not on screen (auto-height nodes grow when ES/EN flips).
function layoutHeight(node) {
  return node.height || Math.max(renderedHeight(node), estimateNodeHeight(node));
}

/** True when the rects intersect; `margin` > 0 demands clearance, < 0 tolerates touching. */
export function rectsOverlap(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin &&
    a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/** Pairs of node ids whose boxes overlap (a couple of px of contact is tolerated). */
export function findOverlaps(graph) {
  const rects = (graph.nodes || []).map((n) => ({ id: n.id, ...getNodeRect(n) }));
  const pairs = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], -2)) pairs.push([rects[i].id, rects[j].id]);
    }
  }
  return pairs;
}

// ─── COMMENT BOXES ───────────────────────────────────
// UE comment palette (context menu presets; free color via inspector / MCP hex)
export const COMMENT_COLORS = [
  { name: 'Gris', value: '#94a2b3' },
  { name: 'Rojo', value: '#e06c75' },
  { name: 'Naranja', value: '#e5934a' },
  { name: 'Amarillo', value: '#e5c07b' },
  { name: 'Verde', value: '#98c379' },
  { name: 'Azul', value: '#61afef' },
  { name: 'Violeta', value: '#c678dd' },
];
export const DEFAULT_COMMENT_COLOR = COMMENT_COLORS[0].value;

// Padding of a box around the nodes it wraps (same as the C-key wrap). The
// title bar is drawn ABOVE the box rect (bottom: 100% in style.css), so it
// needs room outside of it.
export const COMMENT_PAD = { x: 30, top: 56, bottom: 30 };
export const COMMENT_TITLE_H = 28;
export const COMMENT_MIN = { w: 160, h: 90 };

function boxContains(box, r) {
  return r.x >= box.x && r.y >= box.y &&
    r.x + r.w <= box.x + box.width && r.y + r.h <= box.y + box.height;
}

/** Nodes fully inside the comment box (UE group semantics). */
export function getNodesInComment(graph, comment) {
  return (graph?.nodes || []).filter((n) => boxContains(comment, getNodeRect(n)));
}

/** Other comment boxes fully inside this one (they move along with it). */
export function getCommentsInComment(graph, comment) {
  return (graph?.comments || []).filter((c) =>
    c.id !== comment.id && boxContains(comment, { x: c.x, y: c.y, w: c.width, h: c.height }));
}

/** Map commentId → Set of the node ids currently inside it. */
export function snapshotMembership(graph) {
  const rects = (graph.nodes || []).map((n) => ({ id: n.id, r: getNodeRect(n) }));
  const members = new Map();
  (graph.comments || []).forEach((c) => {
    members.set(c.id, new Set(rects.filter((e) => boxContains(c, e.r)).map((e) => e.id)));
  });
  return members;
}

/**
 * Rect of a comment box wrapping `rects` (node rects) plus `innerBoxes`
 * (nested comment boxes, title bar included). Null when there is nothing to wrap.
 */
export function wrapRects(rects, innerBoxes = []) {
  const all = [
    ...rects,
    ...innerBoxes.map((b) => ({ x: b.x, y: b.y - COMMENT_TITLE_H, w: b.width, h: b.height + COMMENT_TITLE_H })),
  ];
  if (!all.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  all.forEach((r) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  });
  const x = Math.floor(minX - COMMENT_PAD.x);
  const y = Math.floor(minY - COMMENT_PAD.top);
  return {
    x,
    y,
    width: Math.max(COMMENT_MIN.w, Math.ceil(maxX + COMMENT_PAD.x - x)),
    height: Math.max(COMMENT_MIN.h, Math.ceil(maxY + COMMENT_PAD.bottom - y)),
  };
}

/** Bounding box of every node and comment box (title bars included), or null. */
export function graphBounds(graph, { skipComments = null } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  (graph.nodes || []).forEach((n) => {
    const r = getNodeRect(n);
    add(r.x, r.y, r.w, r.h);
  });
  (graph.comments || []).forEach((c) => {
    if (skipComments && skipComments.has(c.id)) return;
    add(c.x, c.y - COMMENT_TITLE_H, c.width, c.height + COMMENT_TITLE_H);
  });
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Stale boxes (their nodes are gone) are parked, shrunk, left of the graph:
// author text is never destroyed, and they stop "containing" unrelated nodes.
const PARK = { w: 360, h: 100, gap: 30, margin: 140 };

function parkComments(graph, boxes) {
  if (!boxes.length) return;
  const b = graphBounds(graph, { skipComments: new Set(boxes.map((c) => c.id)) });
  const x = Math.round((b ? b.x : 0) - PARK.margin - PARK.w);
  let y = Math.round((b ? b.y : 0) + COMMENT_TITLE_H);
  boxes.forEach((c) => {
    Object.assign(c, { x, y, width: PARK.w, height: PARK.h });
    y += PARK.h + COMMENT_TITLE_H + PARK.gap;
  });
}

/**
 * Refit comment boxes around the nodes they should hold (`members`: Map
 * commentId → Set of node ids — usually a snapshot taken before the nodes
 * moved). Inner boxes are fitted first so outer boxes wrap them. Boxes that
 * lost every node, or empty notes that would now cover nodes, are parked.
 * `only` restricts the refit to those comment ids.
 * Returns { comments: [{id, text, nodeIds, foreignNodeIds?}], parked: [...] }.
 */
export function refitComments(graph, members, { only = null } = {}) {
  const comments = graph.comments || [];
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const live = new Map();
  comments.forEach((c) => {
    live.set(c.id, new Set([...(members.get(c.id) || [])].filter((id) => byId.has(id))));
  });
  const targets = comments.filter((c) => !only || only.has(c.id));

  const isStrictSubset = (small, big) => small.size > 0 && small.size < big.size &&
    [...small].every((id) => big.has(id));
  targets
    .filter((c) => live.get(c.id).size > 0)
    .sort((a, b) => live.get(a.id).size - live.get(b.id).size)
    .forEach((c) => {
      const set = live.get(c.id);
      const inner = comments.filter((d) => d !== c && isStrictSubset(live.get(d.id), set));
      Object.assign(c, wrapRects([...set].map((id) => getNodeRect(byId.get(id))), inner));
    });

  const parked = targets.filter((c) => {
    if (live.get(c.id).size > 0) return false;
    const hadNodes = (members.get(c.id)?.size || 0) > 0;
    return hadNodes || getNodesInComment(graph, c).length > 0;
  });
  parkComments(graph, parked);
  return describeComments(graph, live, parked);
}

function describeComments(graph, intended, parked) {
  const rects = (graph.nodes || []).map((n) => ({ id: n.id, r: getNodeRect(n) }));
  return {
    comments: (graph.comments || []).map((c) => {
      const inside = rects.filter((e) => boxContains(c, e.r)).map((e) => e.id);
      const item = { id: c.id, text: c.text || '', nodeIds: inside };
      const want = intended.get(c.id);
      const foreign = want && want.size ? inside.filter((id) => !want.has(id)) : [];
      if (foreign.length) item.foreignNodeIds = foreign;
      return item;
    }),
    parked: parked.map((c) => ({ id: c.id, text: c.text || '' })),
  };
}

// ─── RELATIVE PLACEMENT ──────────────────────────────
export const DEFAULT_GAP = { col: 80, row: 100 };

/** Top-left for a w×h box placed below/above/right_of/left_of the `ref` rect. */
export function relativePosition(ref, w, h, where, gap) {
  switch (where) {
    case 'below': return { x: ref.x + (ref.w - w) / 2, y: ref.y + ref.h + gap };
    case 'above': return { x: ref.x + (ref.w - w) / 2, y: ref.y - gap - h };
    case 'right_of': return { x: ref.x + ref.w + gap, y: ref.y };
    case 'left_of': return { x: ref.x - gap - w, y: ref.y };
    default: throw new Error(`Unknown placement: ${where}`);
  }
}

/**
 * Slide `rect` along `axis` ('x' → rightwards, 'y' → downwards) until it
 * overlaps no node of the graph (except `excludeId`), keeping `gap` clearance.
 */
export function findFreeSpot(graph, rect, { axis = 'x', gap = DEFAULT_GAP.col, excludeId = null } = {}) {
  const others = (graph.nodes || []).filter((n) => n.id !== excludeId).map(getNodeRect);
  const r = { ...rect };
  for (let i = 0; i < 200; i++) {
    const hit = others.find((o) => rectsOverlap(r, o, gap / 2));
    if (!hit) break;
    if (axis === 'x') r.x = hit.x + hit.w + gap;
    else r.y = hit.y + hit.h + gap;
  }
  return r;
}

// ─── TREE LAYOUT ─────────────────────────────────────
const SPACING = {
  compact: { col: 50, row: 70 },
  normal: DEFAULT_GAP,
  wide: { col: 130, row: 150 },
};
// With comment boxes on the graph: room for two boxes side by side (30px side
// padding each) and for a title bar + top padding right below another box.
const SECTION_MIN_GAP = { col: 100, row: 130 };
// Empty column that carries a "shortcut" edge (parent → node that also hangs
// below its siblings) so the cable is never hidden behind a sibling's box.
const LANE_W = 90;

function gapsFor(spacing, sections) {
  const base = SPACING[spacing] || SPACING.normal;
  return sections
    ? { col: Math.max(base.col, SECTION_MIN_GAP.col), row: Math.max(base.row, SECTION_MIN_GAP.row) }
    : base;
}

function targetOf(c) {
  return typeof c === 'string' ? c : c?.targetId;
}

/**
 * Tidy top-down layout of `nodes` (only edges among them count). Returns
 * { positions: Map id → {x, y}, width, height } relative to (0, 0); it does
 * not mutate. How it reads:
 *  - Every node reserves a vertical strip as wide as its subtree, so branches
 *    never interleave (a comment box around a branch holds only that branch)
 *    and no two nodes overlap.
 *  - Siblings keep connection order (= in-game choice order), left to right —
 *    except that siblings grouped in the same comment box stay side by side,
 *    or the box would swallow the siblings in between.
 *  - Loops (edges back to a node still being explored, e.g. "¿Algo más?" →
 *    menu) are ignored for placement.
 *  - A node reached from several branches ("join") is placed once, centered
 *    BELOW those branches under their common ancestor — the classic diamond —
 *    instead of inside one of them. If the ancestor also links to it directly,
 *    an empty lane keeps that cable visible.
 *  - Rows are global: nodes at the same depth share a y, and each row is as
 *    tall as its tallest node, so auto-height nodes never collide.
 * `roots` lists preferred entry nodes (e.g. the start node) in order; nodes
 * without incoming edges and leftover cycles become extra roots to the right.
 * `boxes` (Map commentId → Set of node ids) are the comment-box sections.
 */
export function computeTreeLayout(nodes, { roots = [], spacing = 'normal', boxes = null } = {}) {
  const boxList = boxes ? [...boxes.values()].filter((s) => s.size > 1) : [];
  const GAP = gapsFor(spacing, !!(boxes && boxes.size));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeW = (id) => byId.get(id).width || NODE_DEFAULT_W;

  // The widest box holding branch `b` but not its parent `u` — the section
  // that must not be split by the siblings in between
  const sectionOf = (b, u) => {
    let best = null;
    boxList.forEach((s) => {
      if (s.has(b) && !s.has(u) && (!best || s.size > best.size)) best = s;
    });
    return best;
  };
  const groupSiblings = (u, list) => {
    if (!boxList.length || list.length < 3) return list;
    const buckets = [];
    const bySection = new Map();
    list.forEach((b) => {
      const s = sectionOf(b, u);
      if (s && bySection.has(s)) {
        bySection.get(s).push(b);
      } else {
        const bucket = [b];
        buckets.push(bucket);
        if (s) bySection.set(s, bucket);
      }
    });
    return buckets.flat();
  };

  // Successors in connection order, deduped, restricted to `nodes`
  const succ = new Map();
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  nodes.forEach((n) => {
    const out = [];
    (n.connections || []).forEach((c) => {
      const t = targetOf(c);
      if (t && t !== n.id && byId.has(t) && !out.includes(t)) out.push(t);
    });
    succ.set(n.id, out);
    out.forEach((t) => indeg.set(t, indeg.get(t) + 1));
  });

  // 1. DFS spanning forest. An edge into a node still on the stack is a loop.
  const visit = new Map(); // 1 = on stack, 2 = done
  const tp = new Map();    // spanning-tree parent (null for roots)
  const pre = new Map();   // discovery order
  const backEdges = new Set();
  const rootList = [];
  const dfs = (root) => {
    rootList.push(root);
    tp.set(root, null);
    pre.set(root, pre.size);
    visit.set(root, 1);
    const stack = [[root, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const kids = succ.get(frame[0]);
      if (frame[1] < kids.length) {
        const v = kids[frame[1]++];
        const s = visit.get(v);
        if (s === undefined) {
          tp.set(v, frame[0]);
          pre.set(v, pre.size);
          visit.set(v, 1);
          stack.push([v, 0]);
        } else if (s === 1) {
          backEdges.add(`${frame[0]}>${v}`);
        }
      } else {
        visit.set(frame[0], 2);
        stack.pop();
      }
    }
  };
  roots.forEach((id) => { if (byId.has(id) && !visit.has(id)) dfs(id); });
  nodes.forEach((n) => { if (!visit.has(n.id) && indeg.get(n.id) === 0) dfs(n.id); });
  nodes.forEach((n) => { if (!visit.has(n.id)) dfs(n.id); });

  // Forward (non-loop) parents — they form a DAG
  const fparents = new Map(nodes.map((n) => [n.id, []]));
  nodes.forEach((n) => succ.get(n.id).forEach((t) => {
    if (!backEdges.has(`${n.id}>${t}`)) fparents.get(t).push(n.id);
  }));

  // 2. Layout tree: a join hangs from the lowest common ancestor of its parents
  const spDepth = new Map();
  const depthOf = (id) => {
    const chain = [];
    let x = id;
    while (x !== null && !spDepth.has(x)) { chain.push(x); x = tp.get(x); }
    let d = x === null ? -1 : spDepth.get(x);
    for (let i = chain.length - 1; i >= 0; i--) spDepth.set(chain[i], ++d);
    return spDepth.get(id);
  };
  const lca = (a, b) => {
    let da = depthOf(a);
    let db = depthOf(b);
    while (da > db) { a = tp.get(a); da--; }
    while (db > da) { b = tp.get(b); db--; }
    while (a !== b) {
      a = tp.get(a);
      b = tp.get(b);
      if (a === null || b === null) return null; // different trees
    }
    return a;
  };

  const order = nodes.map((n) => n.id).sort((a, b) => pre.get(a) - pre.get(b));
  const lp = new Map(); // layout parent
  const isJoin = new Set();
  order.forEach((id) => {
    const p = tp.get(id);
    lp.set(id, p);
    if (p === null) return; // roots stay roots
    const parents = fparents.get(id);
    if (parents.length < 2) return;
    let anc = parents[0];
    for (let i = 1; i < parents.length && anc !== null; i++) anc = lca(anc, parents[i]);
    if (anc !== null) {
      lp.set(id, anc);
      isJoin.add(id);
    }
  });

  const kidsOf = new Map(nodes.map((n) => [n.id, { branches: [], joins: [] }]));
  order.forEach((id) => {
    const parent = lp.get(id);
    if (parent !== null) kidsOf.get(parent)[isJoin.has(id) ? 'joins' : 'branches'].push(id);
  });
  kidsOf.forEach((k, u) => { k.branches = groupSiblings(u, k.branches); });

  // Child of `u` (branch or join) whose layout subtree holds `x`, or null
  const topUnder = (x, u) => {
    while (x !== null && lp.get(x) !== u) x = lp.get(x);
    return x;
  };

  // 3. Group u's branches with the joins that hang below them
  const buildGroups = (u) => {
    const { branches, joins } = kidsOf.get(u);
    if (!joins.length) return branches.map((b) => ({ slots: [{ id: b }], tiers: [] }));

    const bIndex = new Map(branches.map((b, i) => [b, i]));
    const jSet = new Set(joins);
    const info = new Map();
    joins.forEach((j) => {
      const inf = { idx: new Set(), deps: [], direct: false };
      fparents.get(j).forEach((p) => {
        if (p === u) { inf.direct = true; return; }
        const top = topUnder(p, u);
        if (top === null || top === j) return;
        if (bIndex.has(top)) inf.idx.add(bIndex.get(top));
        else if (jSet.has(top)) inf.deps.push(top);
      });
      info.set(j, inf);
    });
    // A join whose parent sits under another join goes one tier lower and
    // shares that join's branch range (forward edges are acyclic → terminates)
    const range = new Map();
    const rangeOf = (j) => {
      if (!range.has(j)) {
        const r = new Set(info.get(j).idx);
        range.set(j, r);
        info.get(j).deps.forEach((d) => rangeOf(d).forEach((i) => r.add(i)));
      }
      return range.get(j);
    };
    const tier = new Map();
    const tierOf = (j) => {
      if (!tier.has(j)) {
        tier.set(j, 0);
        tier.set(j, info.get(j).deps.reduce((t, d) => Math.max(t, tierOf(d) + 1), 0));
      }
      return tier.get(j);
    };

    const intervals = joins.map((j) => {
      const r = rangeOf(j);
      return r.size
        ? { lo: Math.min(...r), hi: Math.max(...r), joins: [j] }
        : { lo: 0, hi: branches.length - 1, joins: [j] }; // no branch parent: below all
    }).sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const merged = [];
    intervals.forEach((iv) => {
      const last = merged[merged.length - 1];
      if (last && iv.lo <= last.hi) {
        last.hi = Math.max(last.hi, iv.hi);
        last.joins.push(...iv.joins);
      } else {
        merged.push({ lo: iv.lo, hi: iv.hi, joins: [...iv.joins] });
      }
    });

    const raw = [];
    if (!branches.length) {
      raw.push({ lo: 0, hi: -1, joins: merged.flatMap((m) => m.joins) });
    } else {
      let bi = 0;
      merged.forEach((m) => {
        while (bi < m.lo) { raw.push({ lo: bi, hi: bi, joins: [] }); bi++; }
        raw.push(m);
        bi = Math.max(bi, m.hi + 1);
      });
      while (bi < branches.length) { raw.push({ lo: bi, hi: bi, joins: [] }); bi++; }
    }

    const succIdx = new Map(succ.get(u).map((t, i) => [t, i]));
    return raw.map((g) => {
      const gBranches = branches.slice(g.lo, g.hi + 1);
      const sortedJoins = g.joins.sort((a, b) => pre.get(a) - pre.get(b));
      const tiers = [];
      sortedJoins.forEach((j) => { (tiers[tierOf(j)] ||= []).push(j); });
      const slots = gBranches.map((b) => ({ id: b }));
      // Lane for the first tier-0 join the parent also links to directly,
      // at that link's position in the choice order
      const direct = (tiers[0] || []).find((j) => info.get(j).direct && rangeOf(j).size > 0);
      if (direct !== undefined) {
        const at = gBranches.filter((b) => succIdx.get(b) < succIdx.get(direct)).length;
        slots.splice(at, 0, { lane: direct });
      }
      return { slots, tiers: tiers.filter(Boolean) };
    });
  };

  // 4. Measure: subtree strip widths (post-order)
  const widthOf = new Map();
  const plans = new Map();
  const measure = (u) => {
    const groups = buildGroups(u);
    let childrenW = 0;
    let center = null; // center of u relative to the children block
    groups.forEach((g, gi) => {
      let cursor = 0;
      g.slots.forEach((s, si) => {
        s.w = s.lane !== undefined ? LANE_W : measure(s.id);
        s.left = cursor;
        cursor += s.w + (si < g.slots.length - 1 ? GAP.col : 0);
      });
      const rowW = cursor;
      const lane = g.slots.find((s) => s.lane !== undefined);
      const anchor = lane ? lane.left + LANE_W / 2 : rowW / 2;
      g.tierW = g.tiers.map((t) => t.reduce((sum, j, i) => sum + measure(j) + (i ? GAP.col : 0), 0));
      g.tierLeft = g.tierW.map((tw, k) => (k === 0 ? anchor : rowW / 2) - tw / 2);
      const minL = Math.min(0, ...g.tierLeft);
      const maxR = Math.max(rowW, ...g.tierLeft.map((l, k) => l + g.tierW[k]));
      g.slots.forEach((s) => { s.left -= minL; });
      g.tierLeft = g.tierLeft.map((l) => l - minL);
      g.width = maxR - minL;
      g.offset = childrenW + (gi ? GAP.col : 0);
      if (lane && center === null) center = g.offset + lane.left + LANE_W / 2;
      childrenW = g.offset + g.width;
    });
    const own = nodeW(u);
    let padL = 0;
    let width = own;
    if (groups.length) {
      if (center === null) center = childrenW / 2;
      padL = Math.max(0, own / 2 - center);
      const padR = Math.max(0, center + own / 2 - childrenW);
      width = padL + childrenW + padR;
    }
    plans.set(u, { groups, center, padL });
    widthOf.set(u, width);
    return width;
  };

  // 5. Place: x inside each strip, rows by depth; returns the deepest row used
  const rel = new Map();
  const place = (u, left, row) => {
    const { groups, center, padL } = plans.get(u);
    const own = nodeW(u);
    if (!groups.length) {
      rel.set(u, { x: left + (widthOf.get(u) - own) / 2, row });
      return row;
    }
    const block = left + padL;
    rel.set(u, { x: block + center - own / 2, row });
    let maxRow = row;
    groups.forEach((g) => {
      const gl = block + g.offset;
      let gMax = row;
      g.slots.forEach((s) => {
        if (s.lane === undefined) gMax = Math.max(gMax, place(s.id, gl + s.left, row + 1));
      });
      g.tiers.forEach((ids, k) => {
        const tRow = gMax + 1;
        let tl = gl + g.tierLeft[k];
        let tMax = tRow;
        ids.forEach((j) => {
          tMax = Math.max(tMax, place(j, tl, tRow));
          tl += widthOf.get(j) + GAP.col;
        });
        gMax = tMax;
      });
      maxRow = Math.max(maxRow, gMax);
    });
    return maxRow;
  };

  let cursor = 0;
  const rootGap = GAP.col * 2;
  rootList.forEach((r, i) => {
    measure(r);
    if (i) cursor += rootGap;
    place(r, cursor, 0);
    cursor += widthOf.get(r);
  });

  // 6. Rows: each as tall as its tallest node
  const rowH = [];
  rel.forEach((p, id) => { rowH[p.row] = Math.max(rowH[p.row] || 0, layoutHeight(byId.get(id))); });
  const rowY = [];
  let y = 0;
  for (let r = 0; r < rowH.length; r++) {
    rowY[r] = y;
    y += (rowH[r] || 0) + GAP.row;
  }

  const positions = new Map();
  rel.forEach((p, id) => positions.set(id, { x: Math.round(p.x), y: Math.round(rowY[p.row]) }));
  return { positions, width: Math.round(cursor), height: Math.max(0, Math.round(y - GAP.row)) };
}

/**
 * Full re-layout of a graph (mutates node x/y) that keeps its comment boxes
 * meaningful: every box is refit around the nodes it held before (or the ones
 * given in `membership`). The start node keeps its position so the camera
 * doesn't jump. Returns the refitComments() report.
 */
export function relayoutGraph(graph, { spacing = 'normal', membership = null } = {}) {
  const members = membership || snapshotMembership(graph);
  if (!graph.nodes.length) return refitComments(graph, members);
  const { positions } = computeTreeLayout(graph.nodes, { roots: [graph.startNodeId], spacing, boxes: members });
  const anchor = graph.nodes.find((n) => n.id === graph.startNodeId) || graph.nodes[0];
  const a = positions.get(anchor.id);
  const dx = Math.round((Number.isFinite(anchor.x) ? anchor.x : 100) - a.x);
  const dy = Math.round((Number.isFinite(anchor.y) ? anchor.y : 100) - a.y);
  graph.nodes.forEach((n) => {
    const p = positions.get(n.id);
    n.x = p.x + dx;
    n.y = p.y + dy;
  });
  return refitComments(graph, members);
}

/**
 * Lay out freshly added nodes as one tidy block to the right of the rest of
 * the graph — existing nodes never move. The block top sits just below the
 * highest existing node that links into it, so the eye follows the cable.
 */
export function placeNewNodesBlock(graph, newIds, { spacing = 'normal', membership = null } = {}) {
  const idSet = new Set(newIds);
  const fresh = graph.nodes.filter((n) => idSet.has(n.id));
  if (!fresh.length) return;
  const old = graph.nodes.filter((n) => !idSet.has(n.id));
  const boxes = membership || new Map((graph.comments || []).map((c) => [c.id, new Set()]));
  const GAP = gapsFor(spacing, boxes.size > 0);

  const feeders = new Map(); // new node → existing nodes linking into it
  old.forEach((o) => (o.connections || []).forEach((c) => {
    const t = targetOf(c);
    if (idSet.has(t)) {
      if (!feeders.has(t)) feeders.set(t, []);
      feeders.get(t).push(o);
    }
  }));
  const feederX = (id) => Math.min(...feeders.get(id).map((f) => f.x));
  const roots = [...feeders.keys()].sort((a, b) => feederX(a) - feederX(b));
  const { positions } = computeTreeLayout(fresh, { roots, spacing, boxes });

  const bounds = graphBounds({ nodes: old, comments: graph.comments || [] });
  let originX = 100;
  let originY = 100;
  if (bounds) {
    originX = bounds.x + bounds.w + GAP.col * 2;
    const bottoms = [...feeders.values()].flat().map((f) => {
      const r = getNodeRect(f);
      return r.y + r.h;
    });
    originY = bottoms.length ? Math.min(...bottoms) + GAP.row : bounds.y;
  }
  fresh.forEach((n) => {
    const p = positions.get(n.id);
    n.x = Math.round(originX + p.x);
    n.y = Math.round(originY + p.y);
  });
}

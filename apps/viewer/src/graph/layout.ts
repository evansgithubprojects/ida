import type { GraphModel, ModelEdge, ModelNode } from './model';
import type { Rect } from './zoom';

export const NODE_W = 176;
export const NODE_H = 58;

const GAP = 28;
const MIN_R = 140;
/** Clear space between the backdrop ring and the nodes outside it. */
const OUTER_GAP = 80;
const RING_PAD = 40;

/** Top-left corner of each node, in flow coordinates. The circle is centred on the origin. */
export type Positions = Map<string, { x: number; y: number }>;

export interface Layout {
  positions: Positions;
  /** Backdrop circle for the process being looked into; null at the process level. */
  ring: { radius: number } | null;
}

const topLeft = (cx: number, cy: number) => ({ x: cx - NODE_W / 2, y: cy - NODE_H / 2 });

/** Roots first (emitters before handlers), then breadth-first along the edges, so chains run clockwise. */
function order(ids: string[], model: GraphModel): string[] {
  const inner = new Set(ids);
  const out = new Map<string, string[]>();
  const hasIn = new Set<string>();
  for (const e of model.edges) {
    if (!inner.has(e.source) || !inner.has(e.target)) continue;
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    hasIn.add(e.target);
  }
  const kind = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const rank = (id: string) => (kind.get(id) === 'emitter' ? 0 : 1);
  const byRank = (a: string, b: string) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...ids].sort(byRank);
  const seen = new Set<string>();
  const result: string[] = [];
  const walk = (start: string) => {
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      result.push(id);
      for (const next of (out.get(id) ?? []).sort(byRank)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  };
  for (const id of sorted) if (!hasIn.has(id) && !seen.has(id)) walk(id);
  for (const id of sorted) if (!seen.has(id)) walk(id);
  return result;
}

/** Spread angles so neighbours are at least `minSep` apart, keeping them as close to where they were as possible. */
function separate(angles: number[], minSep: number): number[] {
  const n = angles.length;
  if (n * minSep >= 2 * Math.PI) return angles.map((_, i) => -Math.PI / 2 + (2 * Math.PI * i) / n);
  const idx = angles.map((_, i) => i).sort((a, b) => angles[a]! - angles[b]!);
  const a = idx.map((i) => angles[i]!);
  for (let pass = 0; pass < 50; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const gap = j === 0 ? a[0]! + 2 * Math.PI - a[i]! : a[j]! - a[i]!;
      if (gap < minSep - 1e-9) {
        const push = (minSep - gap) / 2;
        a[i] = a[i]! - push;
        a[j] = a[j]! + push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const result = new Array<number>(n);
  idx.forEach((orig, k) => { result[orig] = a[k]!; });
  return result;
}

/** How much worse a pathway drawn through a card is than two pathways crossing: it hides the line under the card. */
const THROUGH_CARD = 3;
/**
 * How much checking the layout may do while untangling (each pathway-against-pathway or pathway-against-card test is
 * one), so a big graph still lays out without a pause. A count rather than a time, so the result is the same on every
 * machine.
 */
const UNTANGLE_WORK = 2_000_000;

type Pt = { x: number; y: number };

/** Whether segment (ax, ay)–(bx, by) crosses segment (cx, cy)–(dx, dy) (touching at an end doesn't count). */
function crossXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) return false;
  if (Math.max(ay, by) < Math.min(cy, dy) || Math.max(cy, dy) < Math.min(ay, by)) return false;
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))) return false;
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);
}

/** Half a card's size, a little inside its border, so a line grazing a corner doesn't count as running through it. */
const HIT_W = NODE_W / 2 - 6;
const HIT_H = NODE_H / 2 - 6;

/** Whether segment (ax, ay)–(bx, by) runs through the card centred on (cx, cy). */
function throughXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const x0 = cx - HIT_W;
  const x1 = cx + HIT_W;
  const y0 = cy - HIT_H;
  const y1 = cy + HIT_H;
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) return false;
  // Clip the segment's x and y ranges (as fractions of its length) against the card; it runs through if any is left.
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  if (dx !== 0) {
    const ta = (x0 - ax) / dx;
    const tb = (x1 - ax) / dx;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (dy !== 0) {
    const ta = (y0 - ay) / dy;
    const tb = (y1 - ay) / dy;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  return t0 < t1;
}

const segmentsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => crossXY(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
const throughCard = (a: Pt, b: Pt, c: Pt) => throughXY(a.x, a.y, b.x, b.y, c.x, c.y);

/**
 * How tangled a placement is: each pair of pathways that cross, plus each pathway drawn through a card it doesn't
 * end at (weighted by `THROUGH_CARD`). `pairs` are the pathways with A→B and B→A counted once.
 */
export function tangle(centres: Map<string, Pt>, pairs: [string, string][]): number {
  const segs = pairs.map(([s, t]) => [centres.get(s), centres.get(t)] as const).filter((p): p is readonly [Pt, Pt] => !!p[0] && !!p[1]);
  const ends = pairs.filter(([s, t]) => centres.has(s) && centres.has(t));
  let cost = 0;
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]!;
    const [si, ti] = ends[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const [sj, tj] = ends[j]!;
      if (si === sj || si === tj || ti === sj || ti === tj) continue;
      if (segmentsCross(a, b, segs[j]![0], segs[j]![1])) cost++;
    }
    for (const [id, c] of centres) if (id !== si && id !== ti && throughCard(a, b, c)) cost += THROUGH_CARD;
  }
  return cost;
}

/** Each pathway between two different nodes once, whichever way it runs. */
function undirectedPairs(model: GraphModel): [string, string][] {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const e of model.edges) {
    if (e.source === e.target) continue;
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (!seen.has(key)) { seen.add(key); pairs.push([e.source, e.target]); }
  }
  return pairs;
}

/**
 * Rearranges nodes among the places they were given, for as few crossings and lines through cards as it can find:
 * swaps two nodes of the same group whenever that untangles things, until no swap helps or the work runs out. Each group
 * keeps its own places (the inner circle's nodes swap among themselves, the outer circle's among themselves). A swap
 * is scored by what it can change only: the pathways of the two nodes, and the other pathways against those two cards.
 */
function untangle(centres: Map<string, Pt>, groups: string[][], model: GraphModel): void {
  const ids = [...centres.keys()];
  const num = new Map(ids.map((id, i) => [id, i]));
  const xs = Float64Array.from(ids, (id) => centres.get(id)!.x);
  const ys = Float64Array.from(ids, (id) => centres.get(id)!.y);
  const ends = undirectedPairs(model).filter(([s, t]) => num.has(s) && num.has(t)).map(([s, t]) => [num.get(s)!, num.get(t)!] as const);
  if (ends.length < 2) return;
  const touching: number[][] = ids.map(() => []);
  ends.forEach(([s, t], k) => { touching[s]!.push(k); touching[t]!.push(k); });
  const mark = new Uint8Array(ends.length);
  let work = 0;
  /** The part of the tangle that moving nodes `a` and `b` can change. */
  const local = (a: number, b: number): number => {
    const moved = [...touching[a]!, ...touching[b]!];
    for (const k of moved) mark[k] = 1;
    let cost = 0;
    for (const k of moved) {
      if (mark[k] !== 1) continue; // a pathway between a and b is listed twice
      mark[k] = 2;
      const [s, t] = ends[k]!;
      const px = xs[s]!, py = ys[s]!, qx = xs[t]!, qy = ys[t]!;
      for (let o = 0; o < ends.length; o++) {
        // A pair of moved pathways is counted once, by whichever comes first.
        if (mark[o] === 2) continue;
        const [so, to] = ends[o]!;
        if (s === so || s === to || t === so || t === to) continue;
        if (crossXY(px, py, qx, qy, xs[so]!, ys[so]!, xs[to]!, ys[to]!)) cost++;
      }
      for (let n = 0; n < ids.length; n++) if (n !== s && n !== t && throughXY(px, py, qx, qy, xs[n]!, ys[n]!)) cost += THROUGH_CARD;
    }
    for (let o = 0; o < ends.length; o++) {
      if (mark[o]) continue;
      const [so, to] = ends[o]!;
      if (a !== so && a !== to && throughXY(xs[so]!, ys[so]!, xs[to]!, ys[to]!, xs[a]!, ys[a]!)) cost += THROUGH_CARD;
      if (b !== so && b !== to && throughXY(xs[so]!, ys[so]!, xs[to]!, ys[to]!, xs[b]!, ys[b]!)) cost += THROUGH_CARD;
    }
    for (const k of moved) mark[k] = 0;
    work += moved.length * (ends.length + ids.length) + ends.length * 2;
    return cost;
  };
  const swap = (a: number, b: number) => {
    const x = xs[a]!; xs[a] = xs[b]!; xs[b] = x;
    const y = ys[a]!; ys[a] = ys[b]!; ys[b] = y;
  };
  const nums = groups.map((g) => g.map((id) => num.get(id)!).filter((n) => n !== undefined));
  for (let improved = true; improved && work < UNTANGLE_WORK;) {
    improved = false;
    for (const group of nums) {
      for (let i = 0; i < group.length && work < UNTANGLE_WORK; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          if (!touching[a]!.length && !touching[b]!.length) continue;
          const before = local(a, b);
          swap(a, b);
          if (local(a, b) < before) improved = true;
          else swap(a, b);
        }
      }
    }
  }
  ids.forEach((id, i) => centres.set(id, { x: xs[i]!, y: ys[i]! }));
}

/** Space between the cards of a chain laid out in a line, so the pathways between them have room to show. */
const CHAIN_GAP = 72;

/**
 * The nodes in order from one end to the other, when the pathways between them form one chain (A → B → C, each
 * linked only to the ones before and after it); otherwise null. Starts from the end nothing flows into.
 */
export function chainOrder(ids: string[], model: GraphModel): string[] | null {
  if (ids.length < 2) return null;
  const inner = new Set(ids);
  const links = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const hasIn = new Set<string>();
  for (const e of model.edges) {
    if (e.source === e.target || !inner.has(e.source) || !inner.has(e.target)) continue;
    links.get(e.source)!.add(e.target);
    links.get(e.target)!.add(e.source);
    hasIn.add(e.target);
  }
  let pairs = 0;
  for (const set of links.values()) { if (set.size > 2) return null; pairs += set.size; }
  // A path has one fewer link than nodes; fewer means it's in pieces, more means it closes into a loop.
  if (pairs / 2 !== ids.length - 1) return null;
  const ends = ids.filter((id) => links.get(id)!.size === 1);
  const start = ends.find((id) => !hasIn.has(id)) ?? ends[0];
  if (!start) return null;
  const path = [start];
  for (let prev: string | null = null, at = start; path.length < ids.length;) {
    const next = [...links.get(at)!].find((id) => id !== prev);
    if (!next) return null;
    path.push(next);
    prev = at;
    at = next;
  }
  return path;
}

/** Distance between the rows of a layout of several chains. */
const ROW_STEP = NODE_H + 72;

/** Each connected piece of the graph as a row, when every piece is a chain; otherwise null. See `layout`. */
export function chainRows(ids: string[], model: GraphModel): string[][] | null {
  const known = new Set(ids);
  const near = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of model.edges) {
    if (e.source === e.target || !known.has(e.source) || !known.has(e.target)) continue;
    near.get(e.source)!.push(e.target);
    near.get(e.target)!.push(e.source);
  }
  const seen = new Set<string>();
  const chains: string[][] = [];
  const alone: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const piece: string[] = [];
    for (const queue = [id]; queue.length;) {
      const at = queue.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      piece.push(at);
      queue.push(...near.get(at)!);
    }
    if (piece.length === 1) { alone.push(piece[0]!); continue; }
    const chain = chainOrder(piece, model);
    if (!chain) return null;
    chains.push(chain);
  }
  // Only worth it when something is a chain; cards with no pathways at all keep the circle.
  if (!chains.length) return null;
  chains.sort((a, b) => b.length - a.length);
  return alone.length ? [...chains, alone] : chains;
}

/**
 * Nodes sit evenly around a circle, except a single chain, which reads left to right in a line (a circle of two or
 * three would stack it up and down, which fits a wide screen badly). When `ring` is set, the nodes of the process
 * being looked into form the inner group and `stub` nodes (other processes) sit on a circle outside the backdrop ring.
 */
export function layout(model: GraphModel, ring: boolean): Layout {
  const positions: Positions = new Map();
  // Without a ring, stubs needn't sit outside anything: a chain that runs through one is still one line.
  const all = model.nodes.map((n) => n.id);
  const whole = chainOrder(all, model);
  const step = NODE_W + CHAIN_GAP;
  // Without a ring: when every connected piece is a chain (a card on its own counts), each chain is a row, longest
  // first, and the cards on their own share a row below. A service with no traffic to the others doesn't turn the
  // rest back into a circle.
  const rows = ring ? null : chainRows(all, model);
  if (rows) {
    rows.forEach((row, r) => row.forEach((id, i) => positions.set(id, topLeft((i - (row.length - 1) / 2) * step, (r - (rows.length - 1) / 2) * ROW_STEP))));
    return { positions, ring: null };
  }
  // With a ring: a chain that enters from other processes, runs through this one and leaves again (warehouse →
  // shipping → labels) stays one row, the other processes on it just outside the ring.
  if (whole) {
    const isStub = new Set(model.nodes.filter((n) => n.kind === 'stub').map((n) => n.id));
    const inside = whole.map((id, i) => (isStub.has(id) ? -1 : i)).filter((i) => i >= 0);
    const lo = inside[0];
    const hi = inside[inside.length - 1];
    if (lo !== undefined && hi !== undefined && hi - lo + 1 === inside.length) {
      const m = inside.length;
      for (let i = lo; i <= hi; i++) positions.set(whole[i]!, topLeft((i - lo - (m - 1) / 2) * step, 0));
      const ringRadius = Math.max(((m - 1) * step) / 2, MIN_R / 2) + NODE_W / 2 + RING_PAD;
      const first = ringRadius + OUTER_GAP + NODE_W / 2;
      for (let i = lo - 1, k = 0; i >= 0; i--, k++) positions.set(whole[i]!, topLeft(-first - k * step, 0));
      for (let i = hi + 1, k = 0; i < whole.length; i++, k++) positions.set(whole[i]!, topLeft(first + k * step, 0));
      return { positions, ring: { radius: ringRadius } };
    }
  }
  const innerIds = order(model.nodes.filter((n) => n.kind !== 'stub').map((n) => n.id), model);
  const n = innerIds.length;
  /** Where each inner node's centre is, for placing the stubs next to what they connect to. */
  const centre = new Map<string, { x: number; y: number }>();
  const chain = chainOrder(innerIds, model);
  let radius: number;
  if (chain) {
    const step = NODE_W + CHAIN_GAP;
    chain.forEach((id, i) => centre.set(id, { x: (i - (n - 1) / 2) * step, y: 0 }));
    radius = ((n - 1) * step) / 2;
  } else {
    radius = n <= 1 ? 0 : Math.max(MIN_R, (NODE_W + GAP) / (2 * Math.sin(Math.PI / n)));
    // Two nodes side by side rather than one above the other.
    const first = n === 2 ? Math.PI : -Math.PI / 2;
    innerIds.forEach((id, i) => {
      const angle = first + (2 * Math.PI * i) / n;
      centre.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  // Around a circle, the order decides what crosses what (a chain inside is already in its best order). The stubs
  // are placed by where their neighbours ended up, then everything is untangled once more with them in.
  if (!chain) untangle(centre, [innerIds], model);

  const ringRadius = Math.max(radius, MIN_R / 2) + NODE_W / 2 + RING_PAD;
  const stubs = model.nodes.filter((s) => s.kind === 'stub').map((s) => s.id);
  if (stubs.length) {
    const outer = ringRadius + NODE_W / 2 + OUTER_GAP;
    const wanted = stubs.map((id, i) => {
      let x = 0;
      let y = 0;
      // What sends in leans left and what it sends to leans right, so a stub tied to a node at the centre still
      // sits beside it rather than above or below.
      let lean = 0;
      for (const e of model.edges) {
        const other = e.source === id ? e.target : e.target === id ? e.source : null;
        const c = other ? centre.get(other) : undefined;
        if (c) { x += c.x; y += c.y; lean += e.source === id ? -1 : 1; }
      }
      if (Math.hypot(x, y) < 1e-6 && lean) x = lean;
      return x || y ? Math.atan2(y, x) : -Math.PI / 2 + (2 * Math.PI * i) / stubs.length;
    });
    const minSep = 2 * Math.asin(Math.min(1, (NODE_W + GAP) / (2 * outer)));
    const spots = separate(wanted, minSep).map((angle) => ({ x: Math.cos(angle) * outer, y: Math.sin(angle) * outer }));
    stubs.forEach((id, i) => centre.set(id, spots[i]!));
  }
  untangle(centre, chain ? [stubs] : [innerIds, stubs], model);
  for (const [id, c] of centre) positions.set(id, topLeft(c.x, c.y));

  return { positions, ring: ring ? { radius: ringRadius } : null };
}

/** Everything the layout draws, ring included, as one rectangle in flow coordinates. */
export function layoutBounds(l: Layout): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const include = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of l.positions.values()) { include(p.x, p.y); include(p.x + NODE_W, p.y + NODE_H); }
  if (l.ring) { include(-l.ring.radius, -l.ring.radius); include(l.ring.radius, l.ring.radius); }
  if (!isFinite(x0)) return { x: 0, y: 0, width: NODE_W, height: NODE_H };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Every node and pathway a graph layer has drawn so far. The layout is computed from all of them, not just what is in
 * the window now, so a node keeps its place when it drops out of the window and when a newcomer arrives only the
 * circle is re-spaced once, instead of the graph being rebuilt around whatever happens to be visible.
 */
export interface Seen {
  nodes: Map<string, ModelNode>;
  edges: Map<string, ModelEdge>;
  /** The nodes' ids, sorted: changes only when a node is seen for the first time. */
  sig: string;
}

/** `prev` plus whatever `model` adds. Returns `prev` itself when nothing is new, so it can be used as a memo key. */
export function accumulate(prev: Seen | null, model: GraphModel): Seen {
  const fresh = model.nodes.some((n) => !prev?.nodes.has(n.id)) || model.edges.some((e) => !prev?.edges.has(e.id));
  if (prev && !fresh) return prev;
  const nodes = new Map(prev?.nodes);
  const edges = new Map(prev?.edges);
  for (const n of model.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
  for (const e of model.edges) if (!edges.has(e.id)) edges.set(e.id, e);
  return { nodes, edges, sig: [...nodes.keys()].sort().join(',') };
}

/** The layout of everything in `seen`; `mapNode` is only carried along (the layout itself doesn't use it). */
export const layoutSeen = (seen: Seen, mapNode: GraphModel['mapNode'], ring: boolean): Layout =>
  layout({ nodes: [...seen.nodes.values()], edges: [...seen.edges.values()], mapNode }, ring);

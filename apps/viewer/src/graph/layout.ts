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
  for (const [id, c] of centre) positions.set(id, topLeft(c.x, c.y));

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
    separate(wanted, minSep).forEach((angle, i) => {
      positions.set(stubs[i]!, topLeft(Math.cos(angle) * outer, Math.sin(angle) * outer));
    });
  }

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

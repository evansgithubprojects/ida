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

/**
 * Nodes sit evenly around a circle. When `ring` is set, the nodes of the process being looked into form the
 * inner circle and `stub` nodes (other processes) sit on a second circle outside the backdrop ring.
 */
export function layout(model: GraphModel, ring: boolean): Layout {
  const positions: Positions = new Map();
  const innerIds = order(model.nodes.filter((n) => n.kind !== 'stub').map((n) => n.id), model);
  const n = innerIds.length;
  const radius = n <= 1 ? 0 : Math.max(MIN_R, (NODE_W + GAP) / (2 * Math.sin(Math.PI / n)));
  const angleOf = new Map<string, number>();
  innerIds.forEach((id, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    angleOf.set(id, angle);
    positions.set(id, topLeft(Math.cos(angle) * radius, Math.sin(angle) * radius));
  });

  const ringRadius = Math.max(radius, MIN_R / 2) + NODE_W / 2 + RING_PAD;
  const stubs = model.nodes.filter((s) => s.kind === 'stub').map((s) => s.id);
  if (stubs.length) {
    const outer = ringRadius + NODE_W / 2 + OUTER_GAP;
    const wanted = stubs.map((id, i) => {
      let x = 0;
      let y = 0;
      for (const e of model.edges) {
        const other = e.source === id ? e.target : e.target === id ? e.source : null;
        const a = other ? angleOf.get(other) : undefined;
        if (a !== undefined) { x += Math.cos(a); y += Math.sin(a); }
      }
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

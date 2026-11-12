import { describe, expect, it } from 'vitest';
import { accumulate, chainOrder, chainRows, layout, layoutSeen, NODE_H, NODE_W, tangle } from '../src/graph/layout';
import type { GraphModel, ModelNode } from '../src/graph/model';

const node = (id: string, kind: ModelNode['kind'] = 'handler'): ModelNode => ({ id, label: id, kind, processId: 'a', detail: '' });
const model = (nodes: ModelNode[], links: [string, string][] = []): GraphModel => ({
  nodes,
  edges: links.map(([source, target]) => ({ id: `${source}>${target}`, source, target, count: 1, times: [], events: [] })),
  mapNode: (id) => id,
});
const centre = (l: ReturnType<typeof layout>, id: string) => {
  const p = l.positions.get(id)!;
  return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
};

const centres = (l: ReturnType<typeof layout>) => new Map([...l.positions.keys()].map((id) => [id, centre(l, id)]));

describe('circular layout', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  // a branches (to b, e and f), so this is no chain: it stays a circle.
  const m = model(ids.map((i) => node(i)), [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'e'], ['a', 'f']]);
  const l = layout(m, false);

  it('puts every node the same distance from the origin', () => {
    const radii = ids.map((id) => Math.hypot(centre(l, id).x, centre(l, id).y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 6);
  });

  it('keeps neighbours at least a card width apart', () => {
    const order = ids.map((id) => centre(l, id)).sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
    for (let i = 0; i < order.length; i++) {
      const p = order[i]!;
      const q = order[(i + 1) % order.length]!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(NODE_W);
    }
  });

  it('is deterministic', () => {
    expect([...layout(m, false).positions]).toEqual([...l.positions]);
  });

  it('orders the circle so no pathway crosses another or runs through a card', () => {
    // In plain breadth-first order (a, b, e, f, c, d) a→f and b→c would cross and a→e would run behind b.
    expect(tangle(centres(l), m.edges.map((e) => [e.source, e.target]))).toBe(0);
  });

  it('untangles as far as it can when crossings are unavoidable', () => {
    // K5 can't be drawn without a crossing; around a circle the best is 5, and nothing should run through a card.
    const k = ['a', 'b', 'c', 'd', 'e'];
    const links = k.flatMap((x, i) => k.slice(i + 1).map((y) => [x, y] as [string, string]));
    expect(tangle(centres(layout(model(k.map((i) => node(i)), links), false)), links)).toBe(5);
  });

  it('moves other processes to where their pathways cross least', () => {
    // h1 and h2 sit left and right; p:x links to h2 and p:y to h1, so their spots are swapped to keep the lines apart.
    const sm = model([node('h1'), node('h2'), node('h3'), node('p:x', 'stub'), node('p:y', 'stub')], [['h1', 'h2'], ['h2', 'h3'], ['h3', 'h1'], ['p:x', 'h2'], ['p:y', 'h1']]);
    expect(tangle(centres(layout(sm, true)), sm.edges.map((e) => [e.source, e.target]))).toBe(0);
  });

  it('centres a lone node', () => {
    const c = centre(layout(model([node('x')]), false), 'x');
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
  });

  it('has no ring at the process level and a ring around the nodes at the handler level', () => {
    expect(l.ring).toBeNull();
    const withRing = layout(m, true);
    const r = Math.hypot(centre(withRing, 'a').x, centre(withRing, 'a').y);
    expect(withRing.ring!.radius).toBeGreaterThan(r + NODE_W / 2);
  });

  it('places other processes on an outer circle, clear of the ring', () => {
    const withStubs = layout(model([node('h1'), node('h2'), node('p:x', 'stub'), node('p:y', 'stub')], [['h1', 'p:x'], ['p:y', 'h2']]), true);
    for (const id of ['p:x', 'p:y']) {
      const c = centre(withStubs, id);
      expect(Math.hypot(c.x, c.y)).toBeGreaterThan(withStubs.ring!.radius + NODE_W / 2);
    }
  });
});

describe('a single chain', () => {
  it('runs left to right in a line, in the order the pathways go', () => {
    const m = model(['c', 'a', 'b'].map((i) => node(i)), [['a', 'b'], ['b', 'c']]);
    const l = layout(m, false);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => centre(l, id));
    expect([a!.y, b!.y, c!.y]).toEqual([0, 0, 0]);
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    expect(b!.x).toBeCloseTo(0, 6); // centred on the origin
    expect(b!.x - a!.x).toBeGreaterThan(NODE_W);
  });

  it('starts from the end nothing flows into, even when pathways go both ways along it', () => {
    expect(chainOrder(['x', 'y', 'z'], model(['x', 'y', 'z'].map((i) => node(i)), [['z', 'y'], ['y', 'x'], ['x', 'y']]))).toEqual(['z', 'y', 'x']);
  });

  it("isn't one when it branches, loops or falls apart", () => {
    const ids = ['a', 'b', 'c', 'd'];
    const nodes = ids.map((i) => node(i));
    expect(chainOrder(ids, model(nodes, [['a', 'b'], ['a', 'c'], ['a', 'd']]))).toBeNull();
    expect(chainOrder(ids, model(nodes, [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]))).toBeNull();
    expect(chainOrder(ids, model(nodes, [['a', 'b'], ['c', 'd']]))).toBeNull();
  });

  it('takes in other processes it runs through, unless there is a ring for them to sit outside', () => {
    const m = model([node('a'), node('s', 'stub'), node('b')], [['a', 's'], ['s', 'b']]);
    const flat = layout(m, false);
    expect(['a', 's', 'b'].map((id) => centre(flat, id).y)).toEqual([0, 0, 0]);
    expect(centre(flat, 'a').x).toBeLessThan(centre(flat, 's').x);
    expect(centre(flat, 's').x).toBeLessThan(centre(flat, 'b').x);
    const ringed = layout(m, true);
    const r = Math.hypot(centre(ringed, 's').x, centre(ringed, 's').y);
    expect(r).toBeGreaterThan(ringed.ring!.radius);
  });

  it('keeps other processes on the row, outside the ring, when the chain runs through the process', () => {
    // warehouse → ship → print → labels, looking into the process that holds ship and print.
    const m = model([node('warehouse', 'stub'), node('ship'), node('print'), node('labels', 'stub')], [['warehouse', 'ship'], ['ship', 'print'], ['print', 'labels']]);
    const l = layout(m, true);
    const xs = ['warehouse', 'ship', 'print', 'labels'].map((id) => centre(l, id).x);
    expect(['warehouse', 'ship', 'print', 'labels'].map((id) => centre(l, id).y)).toEqual([0, 0, 0, 0]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(-xs[0]! - NODE_W / 2).toBeGreaterThan(l.ring!.radius);
    expect(xs[3]! - NODE_W / 2).toBeGreaterThan(l.ring!.radius);
  });

  it('puts a lone node\'s other processes beside it, by which way they send', () => {
    // Not a chain (two senders), so the circle layout places them: senders left, receivers right.
    const m = model([node('a', 'stub'), node('b', 'stub'), node('h'), node('out', 'stub')], [['a', 'h'], ['b', 'h'], ['h', 'out']]);
    const l = layout(m, true);
    expect(centre(l, 'a').x).toBeLessThan(0);
    expect(centre(l, 'b').x).toBeLessThan(0);
    expect(centre(l, 'out').x).toBeGreaterThan(0);
  });

  it('keeps a chain in a row when another card has no pathways, which sits on a row of its own below', () => {
    // payments → orders → warehouse → shipping, and shop on its own.
    const ids = ['shop', 'payments', 'orders', 'warehouse', 'shipping'];
    const m = model(ids.map((i) => node(i)), [['payments', 'orders'], ['orders', 'warehouse'], ['warehouse', 'shipping']]);
    expect(chainRows(ids, m)).toEqual([['payments', 'orders', 'warehouse', 'shipping'], ['shop']]);
    const l = layout(m, false);
    const ys = ['payments', 'orders', 'warehouse', 'shipping'].map((id) => centre(l, id).y);
    expect(new Set(ys).size).toBe(1);
    expect(centre(l, 'shop').y).toBeGreaterThan(ys[0]!);
  });

  it('puts each of two separate chains on its own row, longest first', () => {
    const ids = ['a', 'b', 'x', 'y', 'z'];
    const m = model(ids.map((i) => node(i)), [['a', 'b'], ['x', 'y'], ['y', 'z']]);
    expect(chainRows(ids, m)).toEqual([['x', 'y', 'z'], ['a', 'b']]);
  });

  it('keeps the circle when any piece branches, or nothing is linked', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(chainRows(ids, model(ids.map((i) => node(i)), [['a', 'b'], ['a', 'c'], ['a', 'd']]))).toBeNull();
    expect(chainRows(ids, model(ids.map((i) => node(i))))).toBeNull();
  });

  it('puts two unlinked nodes side by side', () => {
    const l = layout(model([node('a'), node('b')]), false);
    expect(centre(l, 'a').y).toBeCloseTo(centre(l, 'b').y, 6);
  });
});

describe('a layout that remembers what it has drawn', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const all = model(ids.map((i) => node(i)), [['a', 'b'], ['b', 'c'], ['c', 'd']]);

  it('keeps a node in place when it leaves the window, and when it returns', () => {
    const before = layoutSeen(accumulate(null, all), all.mapNode, false);
    const gone = model(ids.slice(0, 2).map((i) => node(i)), [['a', 'b']]); // c and d slide out of the window
    const seen = accumulate(accumulate(null, all), gone);
    const after = layoutSeen(seen, gone.mapNode, false);
    for (const id of ids) expect(after.positions.get(id)).toEqual(before.positions.get(id));
  });

  it('only changes identity when something new appears', () => {
    const seen = accumulate(null, all);
    expect(accumulate(seen, all)).toBe(seen);
    expect(accumulate(seen, model([node('a'), node('b')], [['a', 'b']]))).toBe(seen);
    const grown = accumulate(seen, model([...all.nodes, node('e')], [['d', 'e']]));
    expect(grown).not.toBe(seen);
    expect(grown.sig).toBe('a,b,c,d,e');
  });

  it('notices a pathway between nodes it already knows without renaming the node set', () => {
    const seen = accumulate(null, all);
    const next = accumulate(seen, model(all.nodes, [['a', 'd']]));
    expect(next).not.toBe(seen);
    expect(next.sig).toBe(seen.sig); // so a layout keyed on `sig` stays put
  });
});

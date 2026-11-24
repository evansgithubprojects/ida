import { describe, expect, it } from 'vitest';
import { createRecorder } from '@eda-debugger/core';
import { buildModel, processNodeId } from '../src/graph/model';
import { buildIndex, countFired } from '../src/replay';

function sample() {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 1) });
  const a = {};
  const b = {};
  rec.labelEmitter(a, 'A');
  rec.labelEmitter(b, 'B');
  const send = (e: object, name: string, handlers: Function[]) =>
    rec.dispatch({ emitter: e, eventName: name, handlers, payload: 1 }, (invoke) => handlers.forEach((h) => invoke(h, () => h())));
  const leaf = function leaf() {};
  const root = function root() { send(b, 'leaf', [leaf]); send(b, 'leaf', [leaf]); };
  send(a, 'go', [root]);
  send(a, 'lonely', []);
  return buildIndex(rec.export());
}

describe('graph model', () => {
  const index = sample();

  it('zoomed out: one node per process, aggregated routes, no self edges', () => {
    const m = buildModel(index, { kind: 'process' });
    expect(m.nodes.map((n) => n.label).sort()).toEqual(['A', 'B']);
    const pa = [...index.processLabel].find(([, l]) => l === 'A')![0];
    const pb = [...index.processLabel].find(([, l]) => l === 'B')![0];
    expect(m.edges).toEqual([
      expect.objectContaining({ source: processNodeId(pa), target: processNodeId(pb), count: 2, events: [[...index.events.values()].find((e) => e.label === 'B.leaf')!.key] }),
    ]);
  });

  it('inside a process: its handlers plus stubs for the processes it talks to', () => {
    const pa = [...index.processLabel].find(([, l]) => l === 'A')![0];
    const m = buildModel(index, { kind: 'handlers', processId: pa });
    expect(m.nodes.filter((n) => n.kind === 'handler').map((n) => n.label.replace(/\d+$/, ''))).toEqual(['root']);
    expect(m.nodes.filter((n) => n.kind === 'stub').map((n) => n.label)).toEqual(['B']);
    const root = m.nodes.find((n) => n.kind === 'handler')!;
    expect(m.mapNode(root.rawId!)).toBe(root.id);
  });

  it('events with no listeners dead-end at their emitter', () => {
    const pa = [...index.processLabel].find(([, l]) => l === 'A')![0];
    const m = buildModel(index, { kind: 'handlers', processId: pa });
    const emitter = m.nodes.find((n) => n.kind === 'emitter')!;
    expect(m.edges.some((e) => e.source === emitter.id && e.target === emitter.id)).toBe(false);
    expect(emitter.detail).toMatch(/out/);
  });
});

describe('pathway counters', () => {
  const index = sample();
  const m = buildModel(index, { kind: 'process' });
  const edge = m.edges[0]!;

  it('records the time of every hop, in order', () => {
    expect(edge.times).toHaveLength(edge.count);
    expect([...edge.times].sort((a, b) => a - b)).toEqual(edge.times);
  });

  it('starts at zero on the first event and ends on the total', () => {
    expect(countFired(edge.times, index.start, index.end)).toBe(0);
    expect(countFired(edge.times, index.end, index.end)).toBe(edge.count);
  });

  it('ticks up once the playhead passes each event', () => {
    const [a, b] = edge.times as [number, number];
    expect(countFired(edge.times, a, index.end + 1)).toBe(0);
    expect(countFired(edge.times, a + 1e-6, index.end + 1)).toBe(1);
    expect(countFired(edge.times, b + 1e-6, index.end + 1)).toBe(2);
    expect(countFired(edge.times, -5, index.end)).toBe(0);
  });
});

describe('pinned nodes', () => {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 1) });
  const a = {};
  const idle = {};
  rec.labelEmitter(a, 'A');
  rec.labelEmitter(idle, 'Quiet');
  const h = function h() {};
  rec.dispatch({ emitter: a, eventName: 'go', handlers: [h], payload: 1 }, (invoke) => invoke(h, () => h()));
  rec.dispatch({ emitter: idle, eventName: 'unheard', handlers: [], payload: 1 }, () => {});
  // Both are active over the whole recording; `[]` stands for a window with nothing in it.
  const index = buildIndex(rec.export());
  const quiet = [...index.nodes.values()].find((n) => n.label === 'Quiet')!;
  const level = { kind: 'handlers', processId: quiet.processId } as const;

  it('leaves out an emitter with nothing in the window', () => {
    expect(buildModel(index, level, []).nodes.some((n) => n.id === quiet.id)).toBe(false);
  });

  it('draws it, marked idle, when something is pinned to it', () => {
    const node = buildModel(index, level, [], [quiet.id]).nodes.find((n) => n.id === quiet.id);
    expect(node).toMatchObject({ idle: true, rawId: quiet.id });
  });

  it('does not mark a node that is drawn anyway', () => {
    const active = [...index.nodes.values()].find((n) => n.label === 'A')!;
    const m = buildModel(index, { kind: 'handlers', processId: active.processId }, index.items, [active.id]);
    expect(m.nodes.find((n) => n.id === active.id)?.idle).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createRecorder } from '@ida-dev/core';
import { inWindow, MAX_WINDOW_EVENTS, runId } from '../src/replay';
import { extendTrail, focusTargetOf, TRAIL_MAX, useStore, type Selection } from '../src/store';

type Sel = NonNullable<Selection>;
const node = (id: string): Sel => ({ type: 'node', id });
const edge = (id: string): Sel => ({ type: 'edge', id });

describe('inspection trail', () => {
  it('appends new selections in order', () => {
    let trail: Sel[] = [];
    for (const s of [node('a'), edge('a>b'), { type: 'occurrence', id: 'o1' } as Sel]) trail = extendTrail(trail, s);
    expect(trail.map((t) => t.id)).toEqual(['a', 'a>b', 'o1']);
  });

  it('goes back to a step that is already on the trail', () => {
    const trail = [node('a'), edge('a>b'), node('b')];
    expect(extendTrail(trail, edge('a>b')).map((t) => t.id)).toEqual(['a', 'a>b']);
  });

  it('treats the same id of a different kind as a different step', () => {
    expect(extendTrail([node('x')], edge('x'))).toHaveLength(2);
  });

  it('replaces the last step with a sibling of the same kind', () => {
    const trail = [node('a'), edge('a>b'), node('b')];
    expect(extendTrail(trail, node('c')).map((t) => t.id)).toEqual(['a', 'a>b', 'c']);
    expect(extendTrail([edge('a>b'), { type: 'occurrence', id: 'o1' }], { type: 'occurrence', id: 'o2' }).map((t) => t.id)).toEqual(['a>b', 'o2']);
  });

  it('keeps only the most recent steps', () => {
    let trail: Sel[] = [];
    for (let i = 0; i < TRAIL_MAX + 3; i++) trail = extendTrail(trail, i % 2 ? edge(`n${i}`) : node(`n${i}`));
    expect(trail).toHaveLength(TRAIL_MAX);
    expect(trail[trail.length - 1]!.id).toBe(`n${TRAIL_MAX + 2}`);
  });

  it('starts a new trail from a graph click, since everything on the graph is a sibling', () => {
    const { select } = useStore.getState();
    select(node('a'), { fromGraph: true });
    select(node('b'));
    select(edge('a>b'), { fromGraph: true });
    expect(useStore.getState().trail.map((t) => t.id)).toEqual(['a>b']);
    select(null);
  });

});

describe('focus on inspect', () => {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 10) });
  const a = {};
  rec.labelEmitter(a, 'A');
  const h = function handle() { /* noop */ };
  rec.dispatch({ emitter: a, eventName: 'go', handlers: [h], payload: { n: 1 } }, (invoke) => invoke(h, () => h()));
  const recording = rec.export();
  const emitter = recording.nodes.find((n) => n.label === 'A')!.id;

  it('points each kind of selection at its graph element', () => {
    useStore.getState().load(recording, 'test');
    const index = useStore.getState().index!;
    const occ = index.items[0]!.occ.id;
    expect(focusTargetOf(index, { type: 'node', id: 'x' })).toEqual({ nodeId: 'x' });
    expect(focusTargetOf(index, { type: 'edge', id: 'a>b' })).toEqual({ edgeId: 'a>b' });
    expect(focusTargetOf(index, { type: 'occurrence', id: occ })).toEqual({ nodeId: emitter });
    expect(focusTargetOf(index, { type: 'occurrence', id: 'gone' })).toBeNull();
    expect(focusTargetOf(index, { type: 'run', id: runId(occ, emitter, 'emitted') })).toEqual({ nodeId: emitter });
  });

  it('pans the graph for inspector links but not for graph clicks', () => {
    const { select } = useStore.getState();
    select({ type: 'node', id: 'x' }, { fromGraph: true });
    expect(useStore.getState().focus).toBeNull();
    select({ type: 'node', id: 'x' });
    expect(useStore.getState().focus).toMatchObject({ nodeId: 'x' });
    select(null);
  });

  it('seeks to the occurrence when selecting a run', () => {
    const index = useStore.getState().index!;
    const item = index.items[0]!;
    useStore.getState().selectAt({ type: 'run', id: runId(item.occ.id, emitter, 'emitted') }, item.occ.id);
    const s = useStore.getState();
    expect(s.selection).toEqual({ type: 'run', id: runId(item.occ.id, emitter, 'emitted') });
    expect(s.t).toBe(item.occ.ts);
    expect(s.focus).toMatchObject({ nodeId: emitter });
    s.select(null);
  });

  it('numbers every focus request differently, even after the previous one clears', () => {
    const { select } = useStore.getState();
    select({ type: 'node', id: 'x' });
    const first = useStore.getState().focus!.seq;
    useStore.setState({ focus: null });
    select({ type: 'node', id: 'x' });
    expect(useStore.getState().focus!.seq).toBeGreaterThan(first);
    select(null);
  });
});

describe('links across scopes', () => {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 10) });
  const a = {};
  const b = {};
  rec.labelEmitter(a, 'A');
  rec.labelEmitter(b, 'B');
  const send = (e: object, name: string, handlers: Function[]) =>
    rec.dispatch({ emitter: e, eventName: name, handlers, payload: undefined }, (invoke) => handlers.forEach((h) => invoke(h, () => h())));
  const boom = function boom() { throw new Error('nope'); };
  const start = function start() { send(b, 'charge', [boom]); };
  try { send(a, 'go', [start]); } catch { /* both threw */ }
  const recording = rec.export();
  const node = (label: string) => recording.nodes.find((n) => n.label.startsWith(label))!;

  it('zooms into the process of the handler a link names, not just its process node', () => {
    const s = useStore.getState();
    s.load(recording, 'test');
    const index = useStore.getState().index!;
    const charge = index.items.find((i) => i.template.eventName === 'charge')!;
    s.setLevel({ kind: 'handlers', processId: node('start').processId });
    // The error was thrown in `boom` (process B), though the link was clicked on `start` (process A).
    useStore.getState().selectAt({ type: 'throw', id: index.byId.get(charge.occ.id)!.throws[0]!.id }, charge.occ.id);
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: node('boom').processId });
    expect(useStore.getState().focus).toMatchObject({ nodeId: node('boom').id });
  });

  it('leaves the level alone when the handler is already drawn', () => {
    const s = useStore.getState();
    s.setLevel({ kind: 'handlers', processId: node('boom').processId });
    s.inspectNode(node('boom').id);
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: node('boom').processId });
    expect(useStore.getState().selection).toEqual({ type: 'node', id: node('boom').id });
    s.select(null);
  });
});

describe('the replay window cap', () => {
  const many = (n: number) => {
    let t = 0;
    const rec = createRecorder({ now: () => (t += 10) });
    const bus = {};
    const handler = function onTick() {};
    for (let i = 0; i < n; i++) rec.dispatch({ emitter: bus, label: 'Bus', eventName: 'tick', handlers: [handler], payload: { i } }, (invoke) => invoke(handler, () => handler()));
    return rec.export();
  };
  const load = (n: number) => {
    useStore.getState().load(many(n), 'test');
    return useStore.getState();
  };
  const held = () => inWindow(useStore.getState().index!, useStore.getState().window).length;

  it('opens a big recording on its newest events', () => {
    const s = load(1500);
    expect(held()).toBe(MAX_WINDOW_EVENTS);
    expect(s.window[1]).toBe(s.index!.end);
    expect(s.t).toBe(s.window[0]);
  });

  it('does not touch a recording that already fits', () => {
    const s = load(200);
    expect(s.window).toEqual([s.index!.start, s.index!.end]);
  });

  it('lets the dragged side stay and makes the other follow', () => {
    const s = load(1500);
    const first = s.index!.items[0]!.occ.ts;
    useStore.getState().setWindow([first, s.index!.end], 'start');
    expect(useStore.getState().window[0]).toBe(first);
    expect(held()).toBe(MAX_WINDOW_EVENTS);
    useStore.getState().setWindow([first, s.index!.end], 'end');
    expect(useStore.getState().window[1]).toBe(s.index!.end);
    expect(held()).toBe(MAX_WINDOW_EVENTS);
  });

  it('slides the window to an event outside it instead of growing', () => {
    const s = load(1500);
    const old = s.index!.items[10]!;
    useStore.getState().selectAt({ type: 'occurrence', id: old.occ.id }, old.occ.id);
    const after = useStore.getState();
    expect(after.t).toBe(old.occ.ts);
    expect(after.window[0]).toBeLessThanOrEqual(old.occ.ts);
    expect(after.window[1]).toBeGreaterThan(old.occ.ts);
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
  });

  it('scrubbing anywhere in the recording moves the window to trail the playhead', () => {
    const s = load(1500);
    const mid = s.index!.items[700]!.occ.ts;
    useStore.getState().setT(mid);
    const after = useStore.getState();
    expect(after.t).toBe(mid);
    expect(after.window[0]).toBeLessThanOrEqual(mid);
    expect(after.window[1]).toBeGreaterThan(mid);
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
  });

  it('leaves the window alone while the playhead stays inside it', () => {
    const s = load(1500);
    const before = s.window;
    useStore.getState().setT(s.index!.items[1200]!.occ.ts);
    expect(useStore.getState().window).toEqual(before);
  });

  it('plays past the end of a window by moving it, and stops at the end of the recording', () => {
    const s = load(1500);
    useStore.getState().setT(s.index!.start);
    const first = useStore.getState().window;
    useStore.getState().togglePlay();
    for (let i = 0; i < 1000 && useStore.getState().playing; i++) useStore.getState().tick(500);
    const end = useStore.getState();
    expect(end.window).not.toEqual(first);
    expect(end.playing).toBe(false);
    expect(end.t).toBe(end.index!.end);
  });
});

describe('graph settings', () => {
  it('hides healthy pathways only when asked', () => {
    expect(useStore.getState().hideHealthy).toBe(false);
    useStore.getState().setHideHealthy(true);
    expect(useStore.getState().hideHealthy).toBe(true);
    useStore.getState().setHideHealthy(false);
    expect(useStore.getState().hideHealthy).toBe(false);
  });
});

describe('notification filter', () => {
  it('shows both kinds by default, and saves each one on its own', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    try {
      expect(useStore.getState().notificationKinds).toEqual({ throw: true, finding: true });
      useStore.getState().setNotificationKind('finding', false);
      useStore.getState().setNotificationKind('throw', false);
      useStore.getState().setNotificationKind('throw', true);
      expect(useStore.getState().notificationKinds).toEqual({ throw: true, finding: false });
      expect(JSON.parse(saved.get('ida_graph_settings')!).notificationKinds).toEqual({ throw: true, finding: false });
    } finally {
      vi.unstubAllGlobals();
      useStore.getState().setNotificationKind('finding', true);
    }
  });
});

describe('inspector setting', () => {
  it('is open by default and flips', () => {
    expect(useStore.getState().inspectorOpen).toBe(true);
    useStore.getState().setInspectorOpen(false);
    expect(useStore.getState().inspectorOpen).toBe(false);
    useStore.getState().setInspectorOpen(true);
  });

  it('opens when something on the graph is clicked, but not when the selection is cleared', () => {
    useStore.getState().setInspectorOpen(false);
    useStore.getState().select(null, { fromGraph: true }); // a click on empty canvas
    expect(useStore.getState().inspectorOpen).toBe(false);
    useStore.getState().select({ type: 'node', id: 'n1' }, { fromGraph: true });
    expect(useStore.getState().inspectorOpen).toBe(true);
    useStore.getState().select(null);
  });

  it('is saved together with the graph settings, each keeping the other', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    try {
      useStore.getState().setHideHealthy(true);
      useStore.getState().setInspectorOpen(false);
      expect(JSON.parse(saved.get('ida_graph_settings')!)).toEqual({ hideHealthy: true, inspectorOpen: false, notificationKinds: { throw: true, finding: true } });
    } finally {
      vi.unstubAllGlobals();
      useStore.getState().setHideHealthy(false);
      useStore.getState().setInspectorOpen(true);
    }
  });
});

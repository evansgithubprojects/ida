import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDING_VERSION, type Occurrence, type Recording } from '@ida-dev/core';
import { buildModel, tracedParts, type Level } from '../src/graph/model';
import { buildIndex } from '../src/replay';
import { tracePath, type TraceTarget } from '../src/replay/trace';
import type { SystemView } from '../src/replay/system';
import { occurrenceOfSelection, useStore } from '../src/store';

const ORDERS = 'kafka::topic:orders';

/**
 * Shaped like the server's system view: checkout publishes an order to Kafka; payments and audit both consume it.
 * Payments' handler throws after emitting `charged`, and later sends a receipt to the bank, built from state the failure
 * left behind: that payload is flagged as suspected corrupt and traced to the throw. Inventory runs on its own.
 */
function systemView(linkStatus: 'in-view' | 'outside-window' = 'in-view'): SystemView {
  const occ = (id: string, templateId: string, sourceNodeId: string, ts: number, extra: Partial<Occurrence> = {}): Occurrence => ({
    id, templateId, sourceNodeId, ts, parentId: null, durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [], ...extra,
  });
  const result = (handlerId: string, ts: number, error?: string) => [{ handlerId, ts, durationMs: 1, ...(error && { error: { name: 'Error', message: error } }) }];
  const consumed = (parent: string) => ({ parentId: parent, causality: 'propagated' as const, remoteParent: { sessionId: 'A', occurrenceId: 'e2' } });
  const finding = (id: string, occurrenceId: string, taintSource: { occurrenceId: string; handlerId: string } | null) => ({
    id, kind: 'suspected-corrupt' as const, occurrenceId, ts: 22, confidence: 'high' as const, basis: 'deep' as const,
    reasons: [{ code: 'missing-field' as const, path: 'amount', message: 'amount is missing' }], diff: [], taintSource,
    retroactive: false, summary: 'receipt is missing amount', priority: 'high' as const, externalTargets: ['Bank'],
  });
  const recording: Recording = {
    version: RECORDING_VERSION,
    startedAt: 1_000_000,
    processes: [
      { id: ORDERS, label: 'orders', kind: 'topic', broker: { type: 'kafka' } },
      { id: 'A/p1', label: 'Orders' },
      { id: 'B/p1', label: 'Receipts' },
      { id: 'C/p1', label: 'Stock' },
    ],
    nodes: [
      { id: 'A/em1', label: 'Orders', kind: 'emitter', processId: 'A/p1' },
      { id: 'A/h1', label: 'publishOrder', kind: 'handler', processId: 'A/p1' },
      { id: `${ORDERS}/emitter`, label: 'orders', kind: 'emitter', processId: ORDERS },
      { id: 'B/h1', label: 'charge', kind: 'handler', processId: ORDERS },
      { id: 'B/em1', label: 'Receipts', kind: 'emitter', processId: 'B/p1' },
      { id: 'D/h1', label: 'audit', kind: 'handler', processId: ORDERS },
      { id: 'C/em1', label: 'Stock', kind: 'emitter', processId: 'C/p1' },
      { id: 'C/h1', label: 'recount', kind: 'handler', processId: 'C/p1' },
    ],
    templates: [
      { id: 'A/t1', key: 'a1', emitterId: 'A/em1', eventName: 'placed', handlerIds: ['A/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'A/t2', key: 'a2', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'B/t1', key: 'b1', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: ['B/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'B/t2', key: 'b2', emitterId: 'B/em1', eventName: 'charged', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'B/t3', key: 'b3', emitterId: 'B/em1', eventName: 'receipt', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'D/t1', key: 'd1', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: ['D/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'C/t1', key: 'c1', emitterId: 'C/em1', eventName: 'tick', handlerIds: ['C/h1'], payloadShape: '{}', sampleCount: 1 },
    ],
    occurrences: [
      occ('A/e1', 'A/t1', 'A/em1', 10, { handlerResults: result('A/h1', 10) }),
      occ('A/e2', 'A/t2', 'A/h1', 11, { parentId: 'A/e1' }),
      occ('B/e1', 'B/t1', `${ORDERS}/emitter`, 20, { ...consumed('A/e2'), handlerResults: result('B/h1', 20, 'declined') }),
      occ('B/e2', 'B/t2', 'B/h1', 21, { parentId: 'B/e1' }),
      occ('B/e3', 'B/t3', 'B/em1', 22),
      occ('D/e1', 'D/t1', `${ORDERS}/emitter`, 25, { ...consumed('A/e2'), handlerResults: result('D/h1', 25) }),
      occ('C/e1', 'C/t1', 'C/em1', 30, { handlerResults: result('C/h1', 30) }),
    ],
    findings: [
      finding('f1', 'B/e3', { occurrenceId: 'B/e1', handlerId: 'B/h1' }),
      finding('f2', 'B/e3', null),
    ],
  };
  const service = (sessionId: string, recorderKey: string, processIds: string[]) => ({
    sessionId, recorderKey, runtime: 'node 24', sdk: { language: 'js' as const, version: '0.1.0' }, startedAt: 1_000_000, processIds,
  });
  return {
    recording,
    services: [service('A', 'checkout', ['A/p1', ORDERS]), service('B', 'payments', ['B/p1', ORDERS]), service('D', 'audit', [ORDERS]), service('C', 'inventory', ['C/p1'])],
    links: [
      { occurrenceId: 'B/e1', parent: { sessionId: 'A', occurrenceId: 'e2' }, status: 'in-view' },
      { occurrenceId: 'D/e1', parent: { sessionId: 'A', occurrenceId: 'e2' }, status: 'in-view' },
    ].map((l) => ({ ...l, status: linkStatus })),
    from: 1_000_000, to: 1_060_000, truncated: false,
  };
}

const index = (status?: 'in-view' | 'outside-window') => {
  const { recording, ...rest } = systemView(status);
  return buildIndex(recording, rest);
};

const THROW: TraceTarget = { type: 'throw', id: 'B/e1|B/h1', occurrenceId: 'B/e1' };
const ids = (t: TraceTarget, i = index()) => tracePath(i, t)!.slides.map((s) => s.item.occ.id);

describe('tracePath', () => {
  it('walks from the root to an error, through the broker, and stops there', () => {
    const path = tracePath(index(), THROW)!;
    expect(path.slides.map((s) => s.item.occ.id)).toEqual(['A/e1', 'A/e2', 'B/e1']);
    expect(path.slides.map((s) => s.role)).toEqual(['root', 'hop', 'throw']);
    expect(path.slides.map((s) => s.service)).toEqual(['checkout', 'checkout', 'payments']);
    expect(path.slides[2]!.thrownBy).toEqual({ id: 'B/e1|B/h1', handlerId: 'B/h1', message: 'declined' });
    expect(path.truncated).toBe(false);
  });

  it('leaves out what the error caused and the other consumers of the same publish', () => {
    expect(ids(THROW)).not.toContain('B/e2');
    expect(ids(THROW)).not.toContain('D/e1');
  });

  it('names the broker and how long a consume came after its publish', () => {
    const slides = tracePath(index(), { type: 'occurrence', id: 'D/e1', occurrenceId: 'D/e1' })!.slides;
    expect(slides.map((s) => s.role)).toEqual(['root', 'hop', 'target']);
    expect(slides[1]!.broker).toEqual({ type: 'kafka', kind: 'topic', name: 'orders' });
    expect(slides[1]!.lagMs).toBeUndefined();
    expect(slides[2]!.lagMs).toBe(14);
  });

  it('runs a corrupt payload through the error it is traced to, then ends on the payload', () => {
    const path = tracePath(index(), { type: 'finding', id: 'f1', occurrenceId: 'B/e3' })!;
    expect(path.slides.map((s) => s.item.occ.id)).toEqual(['A/e1', 'A/e2', 'B/e1', 'B/e3']);
    expect(path.slides.map((s) => s.role)).toEqual(['root', 'hop', 'throw', 'target']);
  });

  it('a corrupt payload with no error behind it shows only its own chain', () => {
    expect(ids({ type: 'finding', id: 'f2', occurrenceId: 'B/e3' })).toEqual(['B/e3']);
  });

  it('marks events emitted after the failure on the way to the payload as tainted', () => {
    // `charged` happens after the throw and before the receipt; make the receipt follow from it.
    const { recording, ...rest } = systemView();
    const occurrences = recording.occurrences.map((o) => (o.id === 'B/e3' ? { ...o, parentId: 'B/e2' } : o));
    const path = tracePath(buildIndex({ ...recording, occurrences }, rest), { type: 'finding', id: 'f1', occurrenceId: 'B/e3' })!;
    expect(path.slides.map((s) => [s.item.occ.id, s.role])).toEqual([
      ['A/e1', 'root'], ['A/e2', 'hop'], ['B/e1', 'throw'], ['B/e2', 'tainted'], ['B/e3', 'target'],
    ]);
    expect(path.slides[3]!.subtitle).toBe('charge handled orders.orders and emitted Receipts.charged after the failure, so it may carry the bad state.');
  });

  it('says why each step matters', () => {
    const subs = (t: TraceTarget) => tracePath(index(), t)!.slides.map((s) => s.subtitle);
    expect(subs(THROW)).toEqual([
      'Orders.placed started this chain in checkout.',
      'publishOrder handled Orders.placed and emitted orders.orders, publishing it to topic orders.',
      'charge threw "declined" while handling orders.orders in payments. This is the error.',
    ]);
    const finding = subs({ type: 'finding', id: 'f1', occurrenceId: 'B/e3' });
    expect(finding[2]).toBe('charge threw "declined" while handling orders.orders in payments. The suspect payload is traced to this error.');
    expect(finding[3]).toBe('Receipts.receipt carried a suspected corrupt payload (amount is missing) to Bank.');
    expect(subs({ type: 'occurrence', id: 'D/e1', occurrenceId: 'D/e1' })[2]).toBe('orders.orders came through topic orders and was picked up in audit 14ms after it was published. This is the event you traced.');
  });

  it('says so when the publish that started it is outside the window', () => {
    const { recording, ...rest } = systemView('outside-window');
    // The server leaves a consume whose publish isn't in view without a parent in the merged recording.
    const occurrences = recording.occurrences.filter((o) => !o.id.startsWith('A/')).map((o) => (o.parentId === 'A/e2' ? { ...o, parentId: null } : o));
    const path = tracePath(buildIndex({ ...recording, occurrences }, rest), THROW)!;
    expect(path.slides.map((s) => s.item.occ.id)).toEqual(['B/e1']);
    expect(path.truncated).toBe(true);
  });

  it('is null for an occurrence that is not in the recording', () => {
    expect(tracePath(index(), { type: 'occurrence', id: 'nope', occurrenceId: 'nope' })).toBeNull();
  });
});

describe('tracedParts', () => {
  const traced = (level: Level) => {
    const i = index();
    const model = buildModel(i, level);
    return tracedParts(model, tracePath(i, { type: 'occurrence', id: 'D/e1', occurrenceId: 'D/e1' })!.slides.map((s) => s.item));
  };

  it('lights the path between services at the top level, and nothing unrelated', () => {
    const { nodes, edges } = traced({ kind: 'services' });
    expect([...edges].sort()).toEqual([`p:${ORDERS}>s:audit`, `s:checkout>p:${ORDERS}`]);
    expect(nodes.has('s:inventory')).toBe(false);
    expect(nodes.has('s:payments')).toBe(false);
  });

  it('reaches the other services from inside one, as stubs', () => {
    const { edges } = traced({ kind: 'process', service: 'checkout' });
    expect(edges).toContain(`p:${ORDERS}>s:audit`);
  });
});

describe('trace state', () => {
  afterEach(() => useStore.getState().unload());

  it('opens on the error, steps back and forth, and ends on a new recording', () => {
    const { recording, ...rest } = systemView();
    useStore.getState().load(recording, 'test', rest);
    const i = useStore.getState().index;
    expect(occurrenceOfSelection(i, { type: 'throw', id: 'B/e1|B/h1' })).toBe('B/e1');
    expect(occurrenceOfSelection(i, { type: 'node', id: 'B/h1' })).toBeNull();
    useStore.getState().startTrace(THROW);
    expect(useStore.getState().trace?.at).toBe(0);
    expect(useStore.getState().selection).toEqual({ type: 'occurrence', id: 'A/e1' });
    useStore.getState().traceStep(2);
    expect(useStore.getState().selection).toEqual({ type: 'throw', id: 'B/e1|B/h1' });
    useStore.getState().traceStep(-5);
    expect(useStore.getState().trace?.at).toBe(0);
    useStore.getState().traceStep(99);
    expect(useStore.getState().trace?.at).toBe(2);
    useStore.getState().setLevel({ kind: 'services' });
    expect(useStore.getState().trace).not.toBeNull();
    useStore.getState().load(recording, 'again', rest);
    expect(useStore.getState().trace).toBeNull();
  });

  it('zooms each step into the handlers of the process it happens in, from whatever level is shown', () => {
    const { recording, ...rest } = systemView();
    useStore.getState().load(recording, 'test', rest);
    useStore.getState().setLevel({ kind: 'services' });
    useStore.getState().startTrace(THROW);
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: 'A/p1' });
    useStore.getState().traceStep(2);
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: ORDERS });
    useStore.getState().setLevel({ kind: 'services' });
    useStore.getState().traceStep(2);
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: ORDERS });
    expect(useStore.getState().selection).toEqual({ type: 'throw', id: 'B/e1|B/h1' });
  });

  it('autoplay starts over from the last slide and stops on reaching the end', () => {
    const { recording, ...rest } = systemView();
    useStore.getState().load(recording, 'test', rest);
    useStore.getState().startTrace(THROW);
    useStore.getState().traceStep(2);
    useStore.getState().setTraceAuto(true);
    expect(useStore.getState().trace).toMatchObject({ at: 0, auto: true });
    useStore.getState().traceStep(1);
    expect(useStore.getState().trace).toMatchObject({ at: 1, auto: true });
    useStore.getState().traceStep(2);
    expect(useStore.getState().trace).toMatchObject({ at: 2, auto: false });
  });
});

/** Stands in for the browser's EventSource so the store's live path can be driven by hand. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  close() { this.readyState = FakeEventSource.CLOSED; }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('trace while streaming live', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    useStore.getState().unload();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('freezes the view while open, then goes back to following with what arrived meanwhile', () => {
    const view = systemView();
    useStore.getState().connectLive('http://x/live', 'test');
    const es = FakeEventSource.last!;
    es.onopen?.();
    es.send({ type: 'system-snapshot', view });
    expect(useStore.getState().mode).toBe('live');

    useStore.getState().startTrace(THROW);
    expect(useStore.getState()).toMatchObject({ following: false, playing: false });
    const frozen = useStore.getState().index;
    const later = { ...view.recording, occurrences: [{ ...view.recording.occurrences[5]!, id: 'C/e2', ts: 40 }], findings: [] };
    es.send({ type: 'system-batch', recording: later, services: [], links: [] });
    vi.advanceTimersByTime(1000);
    expect(useStore.getState().index).toBe(frozen);

    useStore.getState().endTrace();
    expect(useStore.getState().trace).toBeNull();
    expect(useStore.getState()).toMatchObject({ mode: 'live', following: true });
    expect(useStore.getState().index!.byId.has('C/e2')).toBe(true);
  });
});

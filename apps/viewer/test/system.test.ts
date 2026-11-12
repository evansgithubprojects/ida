import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDING_VERSION, type Occurrence, type Recording } from '@ida-dev/core';
import { buildModel, levelInto, normalizeLevel, parentLevel, processNodeId, sameLevel, serviceNodeId, topLevel, type Level } from '../src/graph/model';
import { buildIndex } from '../src/replay';
import type { SystemView } from '../src/replay/system';
import { useStore } from '../src/store';

const ORDERS = 'kafka::topic:orders';
const STOCK = 'kafka::topic:stock';

/**
 * Shaped like the server's system view (see apps/server/src/system.ts): checkout publishes an order to Kafka,
 * payments consumes it and emits `charged`; inventory publishes to a topic nobody here consumes.
 */
function systemView(): SystemView {
  const occ = (id: string, templateId: string, sourceNodeId: string, ts: number, extra: Partial<Occurrence> = {}): Occurrence => ({
    id, templateId, sourceNodeId, ts, parentId: null, durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [], ...extra,
  });
  const result = (handlerId: string, ts: number) => [{ handlerId, ts, durationMs: 1 }];
  const recording: Recording = {
    version: RECORDING_VERSION,
    startedAt: 1_000_000,
    processes: [
      { id: ORDERS, label: 'orders', kind: 'topic', broker: { type: 'kafka' } },
      { id: STOCK, label: 'stock', kind: 'topic', broker: { type: 'kafka' } },
      { id: 'A/p1', label: 'Orders' },
      { id: 'B/p1', label: 'Receipts' },
      { id: 'C/p1', label: 'Stock' },
    ],
    nodes: [
      { id: 'A/em1', label: 'Orders', kind: 'emitter', processId: 'A/p1' },
      { id: 'A/h1', label: 'publish_order', kind: 'handler', processId: 'A/p1' },
      { id: `${ORDERS}/emitter`, label: 'orders', kind: 'emitter', processId: ORDERS },
      { id: 'B/h1', label: 'charge', kind: 'handler', processId: ORDERS },
      { id: 'B/em1', label: 'Receipts', kind: 'emitter', processId: 'B/p1' },
      { id: 'C/em1', label: 'Stock', kind: 'emitter', processId: 'C/p1' },
      { id: 'C/h1', label: 'recount', kind: 'handler', processId: 'C/p1' },
      { id: `${STOCK}/emitter`, label: 'stock', kind: 'emitter', processId: STOCK },
    ],
    templates: [
      { id: 'A/t1', key: 'a1', emitterId: 'A/em1', eventName: 'placed', handlerIds: ['A/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'A/t2', key: 'a2', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'B/t1', key: 'b1', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: ['B/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'B/t2', key: 'b2', emitterId: 'B/em1', eventName: 'charged', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'C/t1', key: 'c1', emitterId: 'C/em1', eventName: 'tick', handlerIds: ['C/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'C/t2', key: 'c2', emitterId: `${STOCK}/emitter`, eventName: 'stock', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
    ],
    occurrences: [
      occ('A/e1', 'A/t1', 'A/em1', 10, { handlerResults: result('A/h1', 10) }),
      occ('A/e2', 'A/t2', 'A/h1', 11, { parentId: 'A/e1', meta: { topic: 'orders' } }),
      occ('B/e1', 'B/t1', `${ORDERS}/emitter`, 20, {
        parentId: 'A/e2', causality: 'propagated', remoteParent: { sessionId: 'A', occurrenceId: 'e2' },
        meta: { topic: 'orders', partition: 0, offset: 7, group: 'payments' }, handlerResults: result('B/h1', 20),
      }),
      occ('B/e2', 'B/t2', 'B/h1', 21, { parentId: 'B/e1' }),
      occ('C/e1', 'C/t1', 'C/em1', 30, { handlerResults: result('C/h1', 30) }),
      occ('C/e2', 'C/t2', 'C/h1', 31, { parentId: 'C/e1' }),
    ],
  };
  const service = (sessionId: string, recorderKey: string, language: 'js' | 'python', processIds: string[]) => ({
    sessionId, recorderKey, runtime: language === 'js' ? 'node 24' : 'python 3.12', sdk: { language, version: '0.1.0' }, startedAt: 1_000_000, processIds,
  });
  return {
    recording,
    services: [service('A', 'checkout', 'js', ['A/p1', ORDERS]), service('B', 'payments', 'python', ['B/p1', ORDERS]), service('C', 'inventory', 'js', ['C/p1', STOCK])],
    links: [
      { occurrenceId: 'B/e1', parent: { sessionId: 'A', occurrenceId: 'e2' }, status: 'in-view' },
    ],
    from: 1_000_000, to: 1_060_000, truncated: false,
  };
}

const index = () => {
  const { recording, ...rest } = systemView();
  return buildIndex(recording, rest);
};
const edges = (level: Level) => buildModel(index(), level).edges.map((e) => `${e.source} > ${e.target}${e.propagated ? ' (propagated)' : ''}`).sort();
const nodes = (level: Level) => buildModel(index(), level).nodes.map((n) => `${n.kind}${n.broker ? `/${n.broker}` : ''} ${n.id}`).sort();

describe('system view', () => {
  it('knows which service every node and process belongs to; brokers belong to none', () => {
    const sys = index().system!;
    expect([...sys.services.keys()]).toEqual(['checkout', 'payments', 'inventory']);
    expect(sys.nodeService.get('B/h1')).toBe('payments'); // a consumer's handler, though it sits in the topic's process
    expect(sys.nodeService.get(`${ORDERS}/emitter`)).toBeNull();
    expect(sys.processService.get(ORDERS)).toBeNull();
    expect(sys.processService.get('A/p1')).toBe('checkout');
    expect(sys.consumers.get('A/e2')?.map((l) => l.occurrenceId)).toEqual(['B/e1']);
  });

  it('opens on the services, joined through the brokers they share', () => {
    expect(topLevel(index())).toEqual({ kind: 'services' });
    expect(nodes({ kind: 'services' })).toEqual([
      `process/topic ${processNodeId(ORDERS)}`, `process/topic ${processNodeId(STOCK)}`,
      'service s:checkout', 'service s:inventory', 'service s:payments',
    ]);
    expect(edges({ kind: 'services' })).toEqual([
      `p:${ORDERS} > s:payments (propagated)`, `s:checkout > p:${ORDERS}`, `s:inventory > p:${STOCK}`,
    ]);
  });

  it('inside a service: its processes, the brokers it uses, and the services on their other side', () => {
    const level: Level = { kind: 'process', service: 'payments' };
    // Inventory's topic has nothing to do with payments, so neither it nor inventory is drawn.
    expect(nodes(level)).toEqual(['process p:B/p1', `process/topic ${processNodeId(ORDERS)}`, 'stub s:checkout']);
    expect(edges(level)).toEqual([`p:${ORDERS} > p:B/p1`, `s:checkout > p:${ORDERS}`]);
  });

  it('inside a broker: the handlers of every service that consumes from it', () => {
    const m = buildModel(index(), { kind: 'handlers', processId: ORDERS });
    expect(m.nodes.filter((n) => n.kind !== 'stub').map((n) => n.label).sort()).toEqual(['charge', 'orders']);
    // The services around it stand as one card each; a service that never touched this broker isn't drawn.
    expect(m.nodes.filter((n) => n.kind === 'stub').map((n) => `${n.id} ${n.detail}`).sort()).toEqual(['s:checkout other service', 's:payments other service']);
    expect(m.edges.map((e) => `${e.source} > ${e.target}`).sort()).toEqual([`${ORDERS}/emitter > B/h1`, `B/h1 > s:payments`, `s:checkout > ${ORDERS}/emitter`].sort());
  });

  it('zooms in and out along services, processes and handlers', () => {
    const i = index();
    const services = buildModel(i, { kind: 'services' });
    expect(levelInto(services.nodes.find((n) => n.id === serviceNodeId('payments'))!)).toEqual({ kind: 'process', service: 'payments' });
    expect(levelInto(services.nodes.find((n) => n.id === processNodeId(ORDERS))!)).toEqual({ kind: 'handlers', processId: ORDERS });
    // payments has one process of its own, so its level would only repeat the services level: in goes straight to
    // that process, and out comes back to the services.
    expect(normalizeLevel(i, { kind: 'process', service: 'payments' })).toEqual({ kind: 'handlers', processId: 'B/p1' });
    expect(parentLevel(i, { kind: 'handlers', processId: 'B/p1' })).toEqual({ kind: 'services' });
    expect(parentLevel(i, { kind: 'handlers', processId: ORDERS })).toEqual({ kind: 'services' });
    expect(parentLevel(i, { kind: 'process', service: 'payments' })).toEqual({ kind: 'services' });
    expect(parentLevel(i, { kind: 'services' })).toBeNull();
    expect(sameLevel({ kind: 'process', service: 'a' }, { kind: 'process', service: 'b' })).toBe(false);
    expect(sameLevel({ kind: 'process' }, { kind: 'process' })).toBe(true);
  });

  it('keeps the level of a service that has more than one process', () => {
    const { recording, ...rest } = systemView();
    // A second process in payments (another worker in the same run).
    const two = { ...recording, processes: [...recording.processes, { id: 'B/p2', label: 'Refunds' }] };
    const services = rest.services.map((x) => (x.sessionId === 'B' ? { ...x, processIds: [...x.processIds, 'B/p2'] } : x));
    const i = buildIndex(two, { ...rest, services });
    expect(normalizeLevel(i, { kind: 'process', service: 'payments' })).toEqual({ kind: 'process', service: 'payments' });
    expect(parentLevel(i, { kind: 'handlers', processId: 'B/p1' })).toEqual({ kind: 'process', service: 'payments' });
  });

  it('goes straight into the only process when the zoom is set on a service', () => {
    const { recording, ...rest } = systemView();
    useStore.getState().load(recording, 'system', rest);
    useStore.getState().setLevel({ kind: 'process', service: 'checkout' });
    expect(useStore.getState().level).toEqual({ kind: 'handlers', processId: 'A/p1' });
    useStore.getState().unload();
  });

  it('draws the route from the exchange a message was published to, to the queue it was consumed from', () => {
    const view = systemView();
    const r = view.recording;
    const EXCHANGE = 'rabbitmq:/:exchange:receipts', QUEUE = 'rabbitmq:/:queue:emails';
    r.processes.push(
      { id: EXCHANGE, label: 'receipts', kind: 'exchange', broker: { type: 'rabbitmq', cluster: '/' } },
      { id: QUEUE, label: 'emails', kind: 'queue', broker: { type: 'rabbitmq', cluster: '/' } },
      { id: 'D/p1', label: 'Mailer' },
    );
    r.nodes.push(
      { id: `${EXCHANGE}/emitter`, label: 'receipts', kind: 'emitter', processId: EXCHANGE },
      { id: `${QUEUE}/emitter`, label: 'emails', kind: 'emitter', processId: QUEUE },
      { id: 'D/h1', label: 'send_email', kind: 'handler', processId: QUEUE },
    );
    r.templates.push(
      { id: 'B/t3', key: 'b3', emitterId: `${EXCHANGE}/emitter`, eventName: 'receipt', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
      { id: 'D/t1', key: 'd1', emitterId: `${QUEUE}/emitter`, eventName: 'receipt', handlerIds: ['D/h1'], payloadShape: '{}', sampleCount: 1 },
    );
    r.occurrences.push(
      { id: 'B/e3', templateId: 'B/t3', sourceNodeId: 'B/h1', ts: 22, parentId: 'B/e1', durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [] },
      {
        id: 'D/e1', templateId: 'D/t1', sourceNodeId: `${QUEUE}/emitter`, ts: 25, parentId: 'B/e3', durationMs: 1, causality: 'propagated',
        remoteParent: { sessionId: 'B', occurrenceId: 'e3' }, capture: 'template', handlerResults: [{ handlerId: 'D/h1', ts: 25, durationMs: 1 }],
      },
    );
    view.services.push({ sessionId: 'D', recorderKey: 'notifier', runtime: 'node 24', sdk: { language: 'js', version: '0.1.0' }, startedAt: 1_000_000, processIds: ['D/p1', QUEUE] });
    const { recording, ...rest } = view;
    const i = buildIndex(recording, rest);
    expect(i.byId.get('D/e1')!.hops).toEqual([{ src: `${EXCHANGE}/emitter`, dst: `${QUEUE}/emitter` }, { src: `${QUEUE}/emitter`, dst: 'D/h1' }]);
    const m = buildModel(i, { kind: 'services' });
    expect(m.edges.map((e) => `${e.source} > ${e.target}`)).toEqual(expect.arrayContaining([
      `s:payments > p:${EXCHANGE}`, `p:${EXCHANGE} > p:${QUEUE}`, `p:${QUEUE} > s:notifier`,
    ]));
    // Times count from the first event, not from the window's start.
    expect(i.origin).toBe(i.start);
  });

  it('leaves an ordinary recording as it was', () => {
    const { recording } = systemView();
    const plain = buildIndex(recording);
    expect(plain.system).toBeNull();
    expect(topLevel(plain)).toEqual({ kind: 'process' });
    expect(parentLevel(plain, { kind: 'handlers', processId: 'A/p1' })).toEqual({ kind: 'process' });
    // A single recording draws its brokers in their shapes too, so one service's view shows what it talks to.
    const model = buildModel(plain, { kind: 'process' });
    expect(model.nodes.every((n) => n.kind === 'process')).toBe(true);
    expect(model.nodes.filter((n) => n.broker).map((n) => `${n.broker} ${n.label}`).sort()).toEqual(['topic orders', 'topic stock']);
  });

  it('the store opens a system view on its services', () => {
    const { recording, ...rest } = systemView();
    useStore.getState().load(recording, 'system', rest);
    expect(useStore.getState().level).toEqual({ kind: 'services' });
    useStore.getState().load(recording, 'plain');
    expect(useStore.getState().level).toEqual({ kind: 'process' });
    useStore.getState().unload();
  });
});

/** Stands in for the browser's EventSource so the project stream can be driven by hand. */
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

describe('the project live stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    useStore.getState().unload();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The view without payments: what a snapshot taken before payments' first batch holds. */
  const withoutPayments = (): SystemView => {
    const v = systemView();
    return {
      ...v,
      recording: { ...v.recording, occurrences: v.recording.occurrences.filter((o) => !o.id.startsWith('B/')) },
      services: v.services.filter((x) => x.sessionId !== 'B'),
      links: [],
    };
  };

  it('opens on the services, then merges each batch in without losing the zoom', () => {
    useStore.getState().connectLive('http://x/live', 'all services');
    const es = FakeEventSource.last!;
    es.send({ type: 'system-snapshot', view: withoutPayments() });
    expect(useStore.getState().level).toEqual({ kind: 'services' });
    expect([...useStore.getState().index!.system!.services.keys()]).toEqual(['checkout', 'inventory']);

    useStore.getState().setLevel({ kind: 'process', service: 'checkout' });
    const full = systemView();
    es.send({
      type: 'system-batch',
      recording: { ...full.recording, occurrences: full.recording.occurrences.filter((o) => o.id.startsWith('B/')) },
      services: full.services.filter((x) => x.sessionId === 'B'),
      links: full.links,
    });
    vi.advanceTimersByTime(300); // batches are applied together
    const s = useStore.getState();
    expect(s.level).toEqual({ kind: 'handlers', processId: 'A/p1' }); // checkout's only process
    expect(s.index!.items).toHaveLength(6);
    expect([...s.index!.system!.services.keys()]).toContain('payments');
    expect(s.index!.system!.links.get('B/e1')?.status).toBe('in-view');
  });

  it('keeps the playhead on the same moment when a fresh snapshot counts from a later start', () => {
    useStore.getState().connectLive('http://x/live', 'all services');
    const es = FakeEventSource.last!;
    es.send({ type: 'system-snapshot', view: systemView() });
    useStore.getState().setT(20); // stops following
    const later = systemView();
    const shifted: SystemView = {
      ...later,
      from: later.from + 5,
      recording: { ...later.recording, startedAt: later.recording.startedAt + 5, occurrences: later.recording.occurrences.map((o) => ({ ...o, ts: o.ts - 5 })) },
    };
    es.send({ type: 'system-snapshot', view: shifted });
    expect(useStore.getState().t).toBe(15);
  });

  it('keeps counting times from where it started when the oldest events are dropped', () => {
    useStore.getState().connectLive('http://x/live', 'all services');
    const es = FakeEventSource.last!;
    es.send({ type: 'system-snapshot', view: systemView() });
    const origin = useStore.getState().index!.origin; // the first event, at 10
    // A later snapshot, 5 ms on, that no longer holds the first two events.
    const v = systemView();
    es.send({
      type: 'system-snapshot',
      view: { ...v, from: v.from + 5, recording: { ...v.recording, startedAt: v.recording.startedAt + 5, occurrences: v.recording.occurrences.filter((o) => o.ts > 15).map((o) => ({ ...o, ts: o.ts - 5 })) } },
    });
    const index = useStore.getState().index!;
    expect(index.start).toBe(15);
    expect(index.origin).toBe(origin - 5); // the same moment, on the new clock
  });
});

import { describe, expect, it } from 'vitest';
import { RECORDING_VERSION, type Occurrence, type Recording } from '@ida-dev/core';
import { buildModel, tracedParts, type Level } from '../src/graph/model';
import { buildIndex, traceOf } from '../src/replay';
import type { SystemView } from '../src/replay/system';
import { occurrenceOfSelection, useStore } from '../src/store';

const ORDERS = 'kafka::topic:orders';

/**
 * Shaped like the server's system view: checkout publishes an order to Kafka; payments and audit both consume it.
 * Payments' handler throws after emitting `charged`. Inventory runs on its own, unrelated to the order.
 */
function systemView(linkStatus: 'in-view' | 'outside-window' = 'in-view'): SystemView {
  const occ = (id: string, templateId: string, sourceNodeId: string, ts: number, extra: Partial<Occurrence> = {}): Occurrence => ({
    id, templateId, sourceNodeId, ts, parentId: null, durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [], ...extra,
  });
  const result = (handlerId: string, ts: number, error?: string) => [{ handlerId, ts, durationMs: 1, ...(error && { error: { name: 'Error', message: error } }) }];
  const consumed = (parent: string) => ({ parentId: parent, causality: 'propagated' as const, remoteParent: { sessionId: 'A', occurrenceId: 'e2' } });
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
      { id: 'D/t1', key: 'd1', emitterId: `${ORDERS}/emitter`, eventName: 'orders', handlerIds: ['D/h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 'C/t1', key: 'c1', emitterId: 'C/em1', eventName: 'tick', handlerIds: ['C/h1'], payloadShape: '{}', sampleCount: 1 },
    ],
    occurrences: [
      occ('A/e1', 'A/t1', 'A/em1', 10, { handlerResults: result('A/h1', 10) }),
      occ('A/e2', 'A/t2', 'A/h1', 11, { parentId: 'A/e1' }),
      occ('B/e1', 'B/t1', `${ORDERS}/emitter`, 20, { ...consumed('A/e2'), handlerResults: result('B/h1', 20, 'declined') }),
      occ('B/e2', 'B/t2', 'B/h1', 21, { parentId: 'B/e1' }),
      occ('D/e1', 'D/t1', `${ORDERS}/emitter`, 25, { ...consumed('A/e2'), handlerResults: result('D/h1', 25) }),
      occ('C/e1', 'C/t1', 'C/em1', 30, { handlerResults: result('C/h1', 30) }),
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

describe('traceOf', () => {
  it('follows a message from its cause through every service that consumed it', () => {
    const trace = traceOf(index(), 'A/e1')!;
    expect(trace.steps.map((s) => s.item.occ.id)).toEqual(['A/e1', 'A/e2', 'B/e1', 'B/e2', 'D/e1']);
    expect(trace.steps.map((s) => s.service)).toEqual(['checkout', 'checkout', 'payments', 'payments', 'audit']);
    expect(trace.ids.has('C/e1')).toBe(false);
    expect(trace.truncated).toBe(false);
  });

  it('from one consume: what led to it and what it caused, not the other consumers of the same publish', () => {
    const trace = traceOf(index(), 'B/e1')!;
    expect(trace.steps.map((s) => s.item.occ.id)).toEqual(['A/e1', 'A/e2', 'B/e1', 'B/e2']);
  });

  it('names the broker and how long each consume came after its publish', () => {
    const steps = traceOf(index(), 'A/e1')!.steps;
    const byId = new Map(steps.map((s) => [s.item.occ.id, s]));
    expect(byId.get('A/e2')!.broker).toEqual({ type: 'kafka', kind: 'topic', name: 'orders' });
    expect(byId.get('A/e2')!.lagMs).toBeUndefined();
    expect(byId.get('B/e1')!.lagMs).toBe(9);
    expect(byId.get('D/e1')!.lagMs).toBe(14);
    expect(byId.get('B/e1')!.item.throws.map((t) => t.message)).toEqual(['declined']);
  });

  it('keeps both branches of a message consumed twice, deeper than their publish', () => {
    const steps = traceOf(index(), 'A/e2')!.steps;
    const depth = Object.fromEntries(steps.map((s) => [s.item.occ.id, s.depth]));
    expect(depth).toEqual({ 'A/e1': 0, 'A/e2': 1, 'B/e1': 2, 'B/e2': 3, 'D/e1': 2 });
  });

  it('says so when the publish that started it is outside the window', () => {
    const { recording, ...rest } = systemView('outside-window');
    // The server leaves a consume whose publish isn't in view without a parent in the merged recording.
    const occurrences = recording.occurrences.filter((o) => !o.id.startsWith('A/')).map((o) => (o.parentId === 'A/e2' ? { ...o, parentId: null } : o));
    const trace = traceOf(buildIndex({ ...recording, occurrences }, rest), 'B/e2')!;
    expect(trace.steps.map((s) => s.item.occ.id)).toEqual(['B/e1', 'B/e2']);
    expect(trace.truncated).toBe(true);
  });

  it('is null for an occurrence that is not in the recording', () => {
    expect(traceOf(index(), 'nope')).toBeNull();
  });
});

describe('tracedParts', () => {
  const traced = (level: Level) => {
    const i = index();
    const model = buildModel(i, level);
    return tracedParts(model, traceOf(i, 'A/e1')!);
  };

  it('lights the whole path between services at the top level, and nothing unrelated', () => {
    const { nodes, edges } = traced({ kind: 'services' });
    expect([...edges].sort()).toEqual([`p:${ORDERS}>s:audit`, `p:${ORDERS}>s:payments`, `s:checkout>p:${ORDERS}`]);
    expect(nodes.has('s:inventory')).toBe(false);
  });

  it('reaches the other services from inside one, as stubs', () => {
    const { edges } = traced({ kind: 'process', service: 'checkout' });
    expect(edges).toContain(`p:${ORDERS}>s:payments`);
    expect(edges).toContain(`p:${ORDERS}>s:audit`);
  });
});

describe('trace state', () => {
  it('starts from any selection that names an occurrence, inspects it, and ends on a new recording', () => {
    const { recording, ...rest } = systemView();
    const store = useStore.getState();
    store.load(recording, 'test', rest);
    const i = useStore.getState().index;
    expect(occurrenceOfSelection(i, { type: 'throw', id: 'B/e1|B/h1' })).toBe('B/e1');
    expect(occurrenceOfSelection(i, { type: 'node', id: 'B/h1' })).toBeNull();
    useStore.getState().startTrace('B/e1');
    expect(useStore.getState().trace).toEqual({ occurrenceId: 'B/e1' });
    expect(useStore.getState().selection).toEqual({ type: 'occurrence', id: 'B/e1' });
    useStore.getState().setLevel({ kind: 'services' });
    expect(useStore.getState().trace).not.toBeNull();
    useStore.getState().load(recording, 'again', rest);
    expect(useStore.getState().trace).toBeNull();
  });
});

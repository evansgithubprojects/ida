import { describe, expect, it } from 'vitest';
import { RECORDING_VERSION, type Occurrence, type Recording } from '@ida-dev/core';
import { buildModel, levelInto, type Level } from '../src/graph/model';
import { buildIndex, rateSeries } from '../src/replay';
import type { SessionPeers } from '../src/replay/system';

const ORDERS = 'kafka::topic:orders';
const EXCHANGE = 'rabbitmq:/:exchange:shipping';
const QUEUE = 'rabbitmq:/:queue:labels';

/**
 * One service's own recording, like the demo's warehouse: consumes `orders` from Kafka (packOrder runs inside the
 * topic's process), emits `order:packed`, and requestLabel publishes to the `shipping` exchange.
 */
function warehouse(): Recording {
  const occ = (id: string, templateId: string, sourceNodeId: string, ts: number, extra: Partial<Occurrence> = {}): Occurrence => ({
    id, templateId, sourceNodeId, ts, parentId: null, durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [], ...extra,
  });
  return {
    version: RECORDING_VERSION,
    startedAt: 1_000_000,
    processes: [
      { id: ORDERS, label: 'orders', kind: 'topic', broker: { type: 'kafka' } },
      { id: 'p1', label: 'Warehouse' },
      { id: EXCHANGE, label: 'shipping', kind: 'exchange', broker: { type: 'rabbitmq', cluster: '/' } },
    ],
    nodes: [
      { id: 'em1', label: 'orders', kind: 'emitter', processId: ORDERS },
      { id: 'h1', label: 'packOrder', kind: 'handler', processId: ORDERS },
      { id: 'em2', label: 'Warehouse', kind: 'emitter', processId: 'p1' },
      { id: 'h2', label: 'requestLabel', kind: 'handler', processId: 'p1' },
      { id: 'em3', label: 'shipping', kind: 'emitter', processId: EXCHANGE },
    ],
    templates: [
      { id: 't1', key: 'k1', emitterId: 'em1', eventName: 'orders', handlerIds: ['h1'], payloadShape: '{}', sampleCount: 1 },
      { id: 't2', key: 'k2', emitterId: 'em2', eventName: 'order:packed', handlerIds: ['h2'], payloadShape: '{}', sampleCount: 1 },
      { id: 't3', key: 'k3', emitterId: 'em3', eventName: 'label.print', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
    ],
    occurrences: [
      occ('e1', 't1', 'em1', 10, { causality: 'propagated', remoteParent: { sessionId: 'P', occurrenceId: 'e9' }, handlerResults: [{ handlerId: 'h1', ts: 10, durationMs: 1 }] }),
      occ('e2', 't2', 'h1', 11, { parentId: 'e1', handlerResults: [{ handlerId: 'h2', ts: 11, durationMs: 1 }] }),
      occ('e3', 't3', 'h2', 12, { parentId: 'e2' }),
    ],
  };
}

const peers: SessionPeers = {
  publishedBy: [{ occurrenceId: 'e1', service: 'payments', broker: { id: ORDERS, label: 'orders', kind: 'topic', broker: { type: 'kafka' } } }],
  consumedBy: [{ occurrenceId: 'e3', service: 'shipping', broker: { id: QUEUE, label: 'labels', kind: 'queue', broker: { type: 'rabbitmq', cluster: '/' } } }],
};

const edges = (level: Level, withPeers = true) =>
  buildModel(buildIndex(warehouse(), null, withPeers ? peers : null), level).edges.map((e) => `${e.source} > ${e.target}${e.propagated ? ' (dotted)' : ''}`).sort();
const detail = (id: string, withPeers = true) =>
  buildModel(buildIndex(warehouse(), null, withPeers ? peers : null), { kind: 'process' }).nodes.find((n) => n.id === id)?.detail;

describe("a single service's view of its broker messages", () => {
  it('without peers, the topic has no publisher and the exchange goes nowhere', () => {
    expect(edges({ kind: 'process' }, false)).toEqual([`p:${ORDERS} > p:p1`, `p:p1 > p:${EXCHANGE}`]);
  });

  it('draws who published what it consumed and who consumed what it published, through the far broker', () => {
    expect(edges({ kind: 'process' })).toEqual([
      `p:${ORDERS} > p:p1`,
      `p:p1 > p:${EXCHANGE}`,
      `p:peer:payments > p:${ORDERS} (dotted)`,
      `p:${EXCHANGE} > p:${QUEUE}`,
      `p:${QUEUE} > p:peer:shipping (dotted)`,
    ].sort());
    const model = buildModel(buildIndex(warehouse(), null, peers), { kind: 'process' });
    const peer = model.nodes.find((n) => n.id === 'p:peer:shipping')!;
    expect(peer).toMatchObject({ kind: 'stub', label: 'shipping', detail: 'other service' });
    expect(levelInto(peer)).toBeNull();
    expect(model.nodes.find((n) => n.id === `p:${QUEUE}`)?.broker).toBe('queue');
  });

  it('counts a broker card by messages: arriving at it and delivered from it, not what the consumer did next', () => {
    expect(detail(`p:${ORDERS}`)).toBe('1 in · 1 out');
    expect(detail(`p:${EXCHANGE}`)).toBe('1 in · 1 out');
    expect(detail(`p:${QUEUE}`)).toBe('1 in · 1 out');
    const index = buildIndex(warehouse(), null, peers);
    const r = rateSeries(index, 5000, { mapNode: buildModel(index, { kind: 'process' }).mapNode });
    expect(r.in.get(`p:${ORDERS}`)?.reduce((a, b) => a + b)).toBe(r.out.get(`p:${ORDERS}`)?.reduce((a, b) => a + b));
  });

  it('ignores links to occurrences it no longer holds', () => {
    const gone: SessionPeers = { publishedBy: [], consumedBy: [{ occurrenceId: 'old', service: 'shipping' }] };
    expect(buildModel(buildIndex(warehouse(), null, gone), { kind: 'process' }).nodes.some((n) => n.id === 'p:peer:shipping')).toBe(false);
  });
});

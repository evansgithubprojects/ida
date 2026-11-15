import { describe, expect, it } from 'vitest';
import { RECORDING_VERSION, type Occurrence, type Recording } from '@ida-dev/core';
import { buildIndex, fmtRate, notifications } from '../src/replay';
import { allSpikes, spikeById, spikeItems, spikesAmong, spikeText } from '../src/replay/spikes';

/** `order` events at the given times (ms), with one handler; `tick` events too, if given. */
function recording(orders: number[], ticks: number[] = []): Recording {
  const occ = (id: string, templateId: string, ts: number): Occurrence => ({
    id, templateId, sourceNodeId: 'em', ts, parentId: null, durationMs: 1, causality: 'sync', capture: 'template', handlerResults: [],
  });
  return {
    version: RECORDING_VERSION, startedAt: 0,
    processes: [{ id: 'p', label: 'Shop' }],
    nodes: [{ id: 'em', label: 'Shop', kind: 'emitter', processId: 'p' }, { id: 'h', label: 'charge', kind: 'handler', processId: 'p' }],
    templates: [
      { id: 't1', key: 'k1', emitterId: 'em', eventName: 'order', handlerIds: ['h'], payloadShape: '{}', sampleCount: 1 },
      { id: 't2', key: 'k2', emitterId: 'em', eventName: 'tick', handlerIds: [], payloadShape: '{}', sampleCount: 1 },
    ],
    occurrences: [...orders.map((ts, k) => occ(`o${k}`, 't1', ts)), ...ticks.map((ts, k) => occ(`k${k}`, 't2', ts))],
  };
}

const ORDER_SPIKE = `spike:${JSON.stringify(['em', 'order'])}@20000`;

/** `perSecond` events a second, evenly spaced, from `from` up to (not including) `to`. */
const steady = (perSecond: number, from: number, to: number) => {
  const out: number[] = [];
  for (let t = from; t < to; t += 1000 / perSecond) out.push(Math.round(t));
  return out;
};

describe('spikes', () => {
  it('finds a burst well above the usual rate, with its size, span and events', () => {
    const index = buildIndex(recording([...steady(2, 0, 20_000), ...steady(50, 20_000, 23_000), ...steady(2, 23_000, 40_000)]));
    const spikes = allSpikes(index);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ id: ORDER_SPIKE, label: 'Shop.order', from: 20_000, peak: 50, usual: 2, count: 150 });
    expect(spikes[0]!.to).toBeGreaterThan(22_900);
    expect(spikeItems(index, spikes[0]!)).toHaveLength(150);
    expect(spikeById(index, ORDER_SPIKE)).toEqual(spikes[0]);
  });

  it('ignores a rate that is high but steady', () => {
    expect(allSpikes(buildIndex(recording(steady(40, 0, 30_000))))).toEqual([]);
  });

  it('ignores a burst while the app is starting up', () => {
    expect(allSpikes(buildIndex(recording([...steady(50, 0, 2_000), ...steady(2, 2_000, 20_000)])))).toEqual([]);
  });

  it('keeps bursts apart, and ignores small ones', () => {
    const index = buildIndex(recording([
      ...steady(2, 0, 10_000), ...steady(30, 10_000, 11_000), ...steady(2, 11_000, 30_000), ...steady(30, 30_000, 31_000), ...steady(2, 31_000, 40_000),
      ...steady(6, 0, 40_000).map((t) => t + 1),
    ].sort((a, b) => a - b)));
    // Both bursts sit on 2/s of order plus 6/s more: 38/s over a usual 8/s.
    expect(allSpikes(index).map((s) => s.from)).toEqual([10_000, 30_000]);
  });

  it('keeps its id when older events are dropped', () => {
    const times = [...steady(2, 0, 20_000), ...steady(50, 20_000, 23_000), ...steady(2, 23_000, 40_000)];
    const later = buildIndex(recording(times.filter((t) => t >= 10_000)));
    expect(allSpikes(later).map((s) => s.id)).toEqual([ORDER_SPIKE]);
  });

  it('keeps out of the notifications, which hold only errors and corrupt payloads', () => {
    const rec = recording([...steady(2, 0, 20_000), ...steady(50, 20_000, 23_000), ...steady(2, 23_000, 40_000)]);
    rec.findings = [{
      id: 'f1', kind: 'suspected-corrupt', occurrenceId: 'o70', ts: 35_000, confidence: 'medium', basis: 'deep', reasons: [], diff: [],
      taintSource: null, retroactive: false, summary: 'bad', priority: 'normal', externalTargets: [],
    }];
    const index = buildIndex(rec);
    expect(notifications(index, index.items).map((n) => n.kind)).toEqual(['finding']);
  });

  it('lists the spikes of the events and time a list covers', () => {
    const index = buildIndex(recording([...steady(2, 0, 20_000), ...steady(50, 20_000, 23_000), ...steady(2, 23_000, 40_000)], steady(1, 0, 40_000)));
    const [spike] = spikesAmong(index, index.items);
    expect(spikeText(spike!, fmtRate)).toBe('Shop.order hit 50/s, 25× its usual 2/s');
    // A list of other events, or of a time before it, has none.
    expect(spikesAmong(index, index.items.filter((i) => i.template.eventName === 'tick'))).toEqual([]);
    expect(spikesAmong(index, index.items.filter((i) => i.occ.ts < 15_000))).toEqual([]);
  });
});

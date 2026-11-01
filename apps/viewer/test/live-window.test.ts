import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type RecorderMessage, type Recording } from '@eda-debugger/core';
import { inWindow, MAX_KEPT_EVENTS, MAX_WINDOW_EVENTS } from '../src/replay';
import { useStore } from '../src/store';

/** `n` events with the recorder's own clock, so bursts share a timestamp the way real traffic does. */
function record(n: number, step: number): Recording {
  let t = 0;
  let calls = 0;
  const rec = createRecorder({ now: () => (calls++ % step === 0 ? (t += 1) : t) });
  const bus = {};
  const handler = function onTick() {};
  for (let i = 0; i < n; i++) rec.dispatch({ emitter: bus, label: 'Bus', eventName: 'tick', handlers: [handler], payload: { i } }, (invoke) => invoke(handler, () => handler()));
  return rec.export();
}

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
  send(msg: RecorderMessage) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('the window while streaming live', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    useStore.getState().unload();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stream = (rec: Recording, batches: number) => {
    useStore.getState().connectLive('http://x/live', 'test');
    const es = FakeEventSource.last!;
    es.send({ type: 'snapshot', recording: { ...rec, occurrences: [], findings: [] } });
    const per = Math.ceil(rec.occurrences.length / batches);
    for (let b = 0; b < batches; b++) {
      for (const occurrence of rec.occurrences.slice(b * per, (b + 1) * per)) {
        es.send({ type: 'occurrence', occurrence, template: rec.templates.find((t) => t.id === occurrence.templateId)!, nodes: rec.nodes, processes: rec.processes });
      }
      vi.advanceTimersByTime(300); // the store applies streamed events in batches
    }
  };
  const held = () => inWindow(useStore.getState().index!, useStore.getState().window).length;

  it('keeps following the newest events and never holds more than the cap', () => {
    stream(record(4000, 1), 8);
    const s = useStore.getState();
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
    expect(s.window[1]).toBe(s.index!.end);
  });

  it('keeps only the newest events in memory however long the stream runs', () => {
    const rec = record(6000, 1);
    stream(rec, 12);
    const s = useStore.getState();
    expect(s.recording!.occurrences.length).toBeLessThanOrEqual(MAX_KEPT_EVENTS);
    expect(s.index!.items.length).toBeLessThanOrEqual(MAX_KEPT_EVENTS);
    // The newest event survives and the oldest is gone.
    const ids = new Set(s.recording!.occurrences.map((o) => o.id));
    expect(ids.has(rec.occurrences.at(-1)!.id)).toBe(true);
    expect(ids.has(rec.occurrences[0]!.id)).toBe(false);
  });

  it('pulls a window the viewer left behind back inside what is still kept', () => {
    const rec = record(6000, 1);
    stream({ ...rec, occurrences: rec.occurrences.slice(0, 1500) }, 3);
    const early = useStore.getState().index!;
    useStore.getState().setWindow([early.start, early.items[299]!.occ.ts], 'start'); // looking at old events; stops following
    const send = (from: number, to: number) => {
      for (const occurrence of rec.occurrences.slice(from, to)) {
        FakeEventSource.last!.send({ type: 'occurrence', occurrence, template: rec.templates.find((t) => t.id === occurrence.templateId)!, nodes: rec.nodes, processes: rec.processes });
      }
      vi.advanceTimersByTime(300);
    };
    send(1500, 6000);
    const s = useStore.getState();
    expect(s.following).toBe(false);
    expect(s.window[0]).toBeGreaterThanOrEqual(s.index!.start);
    expect(s.window[1]).toBeLessThanOrEqual(s.index!.end);
    expect(s.t).toBeGreaterThanOrEqual(s.window[0]);
    expect(s.t).toBeLessThanOrEqual(s.window[1]);
  });

  it('holds the cap when many events share a millisecond', () => {
    stream(record(4000, 20), 8);
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
  });
});

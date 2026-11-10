import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, type RecorderMessage, type Recording } from '@ida-dev/core';
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

/** `n` events 18 ms apart, so a burst of 100 covers 1.8 s of recorder time, matching a 1.8 s upload cadence. */
function recordSpaced(n: number): Recording {
  let t = 0;
  const rec = createRecorder({ now: () => t });
  const bus = {};
  const handler = function onTick() {};
  for (let i = 0; i < n; i++) {
    t += 18;
    rec.dispatch({ emitter: bus, label: 'Bus', eventName: 'tick', handlers: [handler], payload: { i } }, (invoke) => invoke(handler, () => handler()));
  }
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

  it('keeps displayed times anchored while the oldest events drop off', () => {
    const rec = record(6000, 1);
    stream({ ...rec, occurrences: rec.occurrences.slice(0, 2500) }, 5);
    const before = useStore.getState().index!;
    for (const occurrence of rec.occurrences.slice(2500, 3000)) {
      FakeEventSource.last!.send({ type: 'occurrence', occurrence, template: rec.templates.find((t) => t.id === occurrence.templateId)!, nodes: rec.nodes, processes: rec.processes });
    }
    vi.advanceTimersByTime(300);
    const after = useStore.getState().index!;
    expect(after.start).toBeGreaterThan(before.start);
    expect(after.origin).toBe(before.origin);
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

  it('switches between Live and Replay', () => {
    stream(record(1500, 1), 3);
    expect(useStore.getState().mode).toBe('live');
    expect(useStore.getState().following).toBe(true);
    useStore.getState().setMode('replay');
    expect(useStore.getState()).toMatchObject({ mode: 'replay', following: false, playing: false });
    useStore.getState().setMode('live');
    const s = useStore.getState();
    expect(s).toMatchObject({ mode: 'live', following: true });
    expect(s.window[1]).toBe(s.index!.end);
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
  });

  it('drops to Replay when the user scrubs', () => {
    stream(record(300, 1), 2);
    const { index } = useStore.getState();
    useStore.getState().setT(index!.start);
    expect(useStore.getState()).toMatchObject({ mode: 'replay', following: false });
  });

  it('opens a saved recording in Replay and refuses Live', () => {
    useStore.getState().load(record(50, 1), 'saved');
    expect(useStore.getState().mode).toBe('replay');
    useStore.getState().setMode('live');
    expect(useStore.getState().mode).toBe('replay');
  });

  describe('playback between bursts', () => {
    const send = (rec: Recording, from: number, to: number) => {
      for (const occurrence of rec.occurrences.slice(from, to)) {
        FakeEventSource.last!.send({ type: 'occurrence', occurrence, template: rec.templates.find((t) => t.id === occurrence.templateId)!, nodes: rec.nodes, processes: rec.processes });
      }
      vi.advanceTimersByTime(300); // the store applies streamed events in batches
    };
    const open = (rec: Recording) => {
      useStore.getState().connectLive('http://x/live', 'test');
      FakeEventSource.last!.send({ type: 'snapshot', recording: { ...rec, occurrences: [], findings: [] } });
      FakeEventSource.last!.onopen?.();
    };

    it('keeps the clock running and plays every burst from the moment it arrives', () => {
      const rec = recordSpaced(1800); // 100 events per 1.8 s burst
      open(rec);
      const steps: number[] = [];
      for (let from = 0; from < 1800; from += 100) {
        send(rec, from, from + 100);
        const s = useStore.getState();
        const burst = rec.occurrences.slice(from, from + 100).map((o) => o.ts);
        // No event of the burst is already over when it arrives, and its spacing is kept.
        const first = burst[0]! + (s.liveShift.get(rec.occurrences[from]!.id) ?? 0);
        const last = burst.at(-1)! + (s.liveShift.get(rec.occurrences[from + 99]!.id) ?? 0);
        if (from > 0) expect(first).toBeGreaterThanOrEqual(s.t - 1e-6);
        expect(last - first).toBe(burst.at(-1)! - burst[0]!);
        for (let ms = 300; ms < 1800; ms += 16) {
          const before = useStore.getState().t;
          useStore.getState().tick(16);
          steps.push(useStore.getState().t - before);
        }
      }
      // The clock moves by exactly the wall time on every frame: no pause between bursts, no jump, no rewind.
      expect(steps.every((dt) => dt === 16)).toBe(true);
    });

    it('does not replay a burst that arrives far too late', () => {
      const rec = recordSpaced(1000); // 18 s of events
      open(rec);
      send(rec, 0, 100);
      useStore.setState({ t: useStore.getState().index!.end + 30_000 }); // e.g. the tab was hidden for a long time
      send(rec, 100, 200);
      const s = useStore.getState();
      expect(s.liveShift.get(rec.occurrences[150]!.id)).toBeUndefined();
    });

    it('leaves the clock alone when events arrive', () => {
      const rec = recordSpaced(300);
      open(rec);
      send(rec, 0, 100);
      useStore.setState({ t: useStore.getState().index!.end + 500 });
      const before = useStore.getState().t;
      send(rec, 100, 200);
      expect(useStore.getState().t).toBe(before);
    });
  });

  it('holds the cap when many events share a millisecond', () => {
    stream(record(4000, 20), 8);
    expect(held()).toBeLessThanOrEqual(MAX_WINDOW_EVENTS);
  });
});

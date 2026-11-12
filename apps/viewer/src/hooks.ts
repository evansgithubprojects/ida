import { useEffect, useMemo, useRef, useState } from 'react';
import { buildModel, type GraphModel, type Level } from './graph/model';
import type { IndexedOccurrence } from './replay';
import type { TracePath } from './replay/trace';
import { activeAt, inWindow, rateSeries, RATE_STEP_MS, recentRates, shownRates, SPIKE_WINDOW_MS, type Active, type HeldSpikes, type Rates } from './replay';
import { FADE_WALL_MS, FLASH_WALL_MS, LIVE_RESYNC_MS, useStore } from './store';

/** The trace slideshow's path, if one is open (see `tracePath`). */
export function useTrace(): TracePath | null {
  return useStore((s) => s.trace?.path ?? null);
}

/** The graph at `level`, or at the store's current level. A level passed in stays put while a zoom transition plays. */
export function useModel(levelOverride?: Level): GraphModel | null {
  const index = useStore((s) => s.index);
  const current = useStore((s) => s.level);
  const level = levelOverride ?? current;
  const window = useStore((s) => s.window);
  // What is being inspected or linked to stays drawn, whatever the window holds.
  const focused = useStore((s) => s.focus?.nodeId);
  const selected = useStore((s) => (s.selection?.type === 'node' ? s.selection.id : undefined));
  const trace = useTrace();
  return useMemo(() => {
    if (!index) return null;
    const pinned = [focused, selected].filter((id): id is string => !!id);
    let items = inWindow(index, window);
    // A trace draws its whole path, even the steps outside the window.
    if (trace) {
      const have = new Set(items.map((i) => i.occ.id));
      const extra = trace.slides.map((s) => s.item).filter((i) => !have.has(i.occ.id));
      if (extra.length) items = [...items, ...extra].sort((a, b) => a.occ.ts - b.occ.ts);
      for (const s of trace.slides) for (const h of s.item.hops) pinned.push(h.src, h.dst);
    }
    return buildModel(index, level, items, pinned);
  }, [index, level, window, focused, selected, trace]);
}

/** How long one pulse takes to cross a pathway in trace mode, and the pause before the next one. */
const TRACE_PULSE_MS = 900;
const TRACE_REST_MS = 500;

/**
 * Trace mode: only the slide shown is drawn, its pathways pulsing over and over; no other traffic. Ignores the playhead
 * and the live stream.
 */
function useTraceActive(model: GraphModel | null): Active | null {
  const index = useStore((s) => s.index);
  const item: IndexedOccurrence | undefined = useStore((s) => s.trace?.path.slides[s.trace.at]?.item);
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!item) return;
    const start = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      setPhase(Math.min((now - start) % (TRACE_PULSE_MS + TRACE_REST_MS), TRACE_PULSE_MS - 1));
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, [item]);
  return useMemo(() => {
    if (!index || !model || !item) return null;
    // Just this one occurrence, read on its own clock: a snapshot taken before a live rebuild still draws right.
    const one = { ...index, items: [item] };
    return activeAt(one, item.occ.ts + phase, { fadeMs: TRACE_PULSE_MS, flashMs: TRACE_PULSE_MS, mapNode: model.mapNode });
  }, [index, model, item, phase]);
}

export function useActive(model: GraphModel | null): Active | null {
  const tracing = useStore((s) => s.trace !== null);
  const traced = useTraceActive(tracing ? model : null);
  const playing = usePlayActive(tracing ? null : model);
  return tracing ? traced : playing;
}

function usePlayActive(model: GraphModel | null): Active | null {
  const index = useStore((s) => s.index);
  const t = useStore((s) => s.t);
  const picked = useStore((s) => s.speed);
  // A following live view plays in real time whatever speed was picked for it.
  const realTime = useStore((s) => s.following && s.live === 'on');
  const speed = realTime ? 1 : picked;
  const window = useStore((s) => s.window);
  const shifts = useStore((s) => s.liveShift);
  return useMemo(
    () =>
      index && model
        ? activeAt(index, t, {
            fadeMs: FADE_WALL_MS * speed,
            flashMs: FLASH_WALL_MS * speed,
            // Late events of a live burst play after the newest recorded time, so the window must not cut them off.
            window: realTime ? [window[0], Infinity] : window,
            mapNode: model.mapNode,
            shiftOf: realTime ? (id) => shifts.get(id) ?? 0 : undefined,
          })
        : null,
    [index, model, t, speed, window, realTime, shifts],
  );
}

/** Advances the playhead with requestAnimationFrame while playing, or while a live view follows the stream. */
export function usePlayback(): void {
  const playing = useStore((s) => s.playing || (s.following && s.live === 'on'));
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      useStore.getState().tick(now - last);
      last = now;
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

/**
 * The graph's event rates (see `rateSeries`) for `model`. The 5 s series is recomputed only when the playhead crosses
 * into the next step or the zoom level changes. The last second is checked for a spike once a second (see
 * `shownRates`), so labels update on those two beats, never every frame.
 */
export function useRates(model: GraphModel | null, level: Level): Rates | null {
  const step = useStore((s) => Math.floor(s.t / RATE_STEP_MS));
  const second = useStore((s) => Math.floor(s.t / SPIKE_WINDOW_MS));
  const hasIndex = useStore((s) => s.index !== null);
  const latest = useRef(model);
  latest.current = model;
  const held = useRef<HeldSpikes | null>(null);
  const process = level.kind === 'handlers' ? level.processId : '';

  const series = useMemo(() => {
    const { index, t, following, live, liveShift } = useStore.getState();
    const m = latest.current;
    if (!index || !m) return null;
    // A following live view plays bursts later than recorded (see `liveShift`); count them when they play.
    const shifted = following && live === 'on';
    return rateSeries(index, t, { mapNode: m.mapNode, shiftOf: shifted ? (id) => liveShift.get(id) ?? 0 : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, level.kind, process, hasIndex && !!model]);

  return useMemo(() => {
    const { index, t, following, live, liveShift } = useStore.getState();
    const m = latest.current;
    if (!index || !m || !series) return null;
    const shifted = following && live === 'on';
    const recent = recentRates(index, t, { mapNode: m.mapNode, shiftOf: shifted ? (id) => liveShift.get(id) ?? 0 : undefined, maxShiftMs: shifted ? LIVE_RESYNC_MS : 0 });
    // Latching is idempotent, so running this twice (React's dev double-invoke) gives the same result.
    const r = shownRates(series, recent, held.current, `${series.step}|${level.kind}|${process}`);
    held.current = r.held;
    return { series, shown: r.shown };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, second]);
}

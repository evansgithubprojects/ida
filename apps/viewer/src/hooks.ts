import { useEffect, useMemo, useRef } from 'react';
import { buildModel, type GraphModel, type Level } from './graph/model';
import { activeAt, inWindow, rateSeries, traceOf, type Trace, RATE_STEP_MS, recentRates, shownRates, SPIKE_WINDOW_MS, type Active, type HeldSpikes, type Rates } from './replay';
import { FADE_WALL_MS, FLASH_WALL_MS, LIVE_RESYNC_MS, useStore } from './store';

/** The trace being followed, if any (see `traceOf`). */
export function useTrace(): Trace | null {
  const index = useStore((s) => s.index);
  const id = useStore((s) => s.trace?.occurrenceId);
  return useMemo(() => (index && id ? traceOf(index, id) : null), [index, id]);
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
  return useMemo(
    () => (index ? buildModel(index, level, inWindow(index, window), [focused, selected].filter((id): id is string => !!id)) : null),
    [index, level, window, focused, selected],
  );
}

export function useActive(model: GraphModel | null): Active | null {
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

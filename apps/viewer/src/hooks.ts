import { useEffect, useMemo } from 'react';
import { buildModel, type GraphModel, type Level } from './graph/model';
import { activeAt, inWindow, type Active } from './replay';
import { FADE_WALL_MS, FLASH_WALL_MS, useStore } from './store';

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

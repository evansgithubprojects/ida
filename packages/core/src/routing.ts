import type { DispatchInfo, Invoke, Recorder } from './recorder';

/** emitter -> the recorders that claimed it with `recorder.track()` */
const tracking = new WeakMap<object, Set<Recorder>>();
let fallback: Recorder | null = null;

/** @internal Used by `recorder.track()`. */
export function trackEmitter(recorder: Recorder, emitter: object): void {
  const set = tracking.get(emitter) ?? new Set();
  set.add(recorder);
  tracking.set(emitter, set);
}

/** @internal Used by `recorder.untrack()`. */
export function untrackEmitter(recorder: Recorder, emitter: object): void {
  const set = tracking.get(emitter);
  if (!set) return;
  set.delete(recorder);
  if (!set.size) tracking.delete(emitter);
}

/**
 * The recorder that records emitters no recorder has claimed with `track()`. `enable()` sets it the first time it runs.
 * Pass `null` to record only tracked emitters.
 */
export function setDefaultRecorder(recorder: Recorder | null): void {
  fallback = recorder;
}

/** The recorder untracked emitters go to, or null when there is none. */
export function getDefaultRecorder(): Recorder | null {
  return fallback;
}

/**
 * For adapter authors: the recorders an emit on `emitter` belongs to, in the order they claimed it. That is every
 * recorder tracking it, or else the default recorder, and only those currently recording.
 */
export function recordersFor(emitter: object): Recorder[] {
  const set = tracking.get(emitter);
  const all = set?.size ? [...set] : fallback ? [fallback] : [];
  return all.filter((r) => r.recording);
}

/**
 * For adapter authors: records one emit in every recorder in `recorders` while running its listeners only once. Each
 * recorder's `invoke` wraps the next, so every recorder sees each handler's timing, errors and emits.
 * With no recorders it just runs.
 */
export function dispatchAll<T>(recorders: readonly Recorder[], info: DispatchInfo, run: (invoke: Invoke) => T): T {
  const step = (i: number, outer: Invoke): T =>
    i === recorders.length
      ? run(outer)
      : recorders[i]!.dispatch(info, (inner) => step(i + 1, (h, call) => outer(h, () => inner(h, call))));
  return step(0, (_h, call) => call());
}

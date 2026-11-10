import { createRecorder, type Recorder, type RecorderOptions } from './recorder';

const byKey = new Map<string, Recorder>();
const watchers = new Set<(recorder: Recorder) => void>();

/** What a recorder key may look like: it names the recorder in your project, so it must be stable and URL-safe. */
export const RECORDER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * The recorder named `key`, created on first use. Call it from anywhere in your app with the same key to get the
 * same recorder: no need to pass it around. `opts` only apply on the call that creates it.
 * @example
 * const payments = connectRecorder('payments', { windowMs: 60_000 });
 * payments.track(paymentsBus);
 * // elsewhere
 * connectRecorder('payments').labelHandler(chargeCard, 'charge card');
 */
export function connectRecorder(key: string, opts?: Omit<RecorderOptions, 'key'>): Recorder {
  if (!RECORDER_KEY.test(key)) {
    throw new TypeError(`[ida] invalid recorder key ${JSON.stringify(key)}: use 1-64 letters, digits, '.', '_', ':' or '-'`);
  }
  let recorder = byKey.get(key);
  if (!recorder) {
    recorder = createRecorder({ ...opts, key });
    byKey.set(key, recorder);
    for (const w of watchers) w(recorder);
  }
  return recorder;
}

/** Every recorder created with `connectRecorder()`, in creation order. */
export function getRecorders(): Recorder[] {
  return [...byKey.values()];
}

/**
 * Calls `listener` for every recorder created with `connectRecorder()`: the existing ones straight away, then each new
 * one as it is created. For integrations such as uploaders.
 * @returns a function that stops listening
 */
export function onRecorder(listener: (recorder: Recorder) => void): () => void {
  watchers.add(listener);
  for (const r of byKey.values()) listener(r);
  return () => { watchers.delete(listener); };
}

/** @internal Forget every keyed recorder. For tests. */
export function resetRecorders(): void {
  byKey.clear();
  watchers.clear();
}

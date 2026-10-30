import { connectRecorder, getRecorders } from './registry';
import type { Recorder, RecorderOptions } from './recorder';
import { getDefaultRecorder, setDefaultRecorder } from './routing';

// Setup
export { createRecorder } from './recorder';
export { connectRecorder, getRecorders, onRecorder, RECORDER_KEY } from './registry';
export { getDefaultRecorder, setDefaultRecorder } from './routing';
export type { CorruptionOptions, FindingNotifier, Policy, Recorder, RecorderOptions } from './recorder';
export type { CaptureRule } from './capture';

// The recording format
export * from './types';
export { isTag } from './json';
export { analyze, SuspectedCorruptionError } from './corruption';

// Customization: template grouping and causality tracking
export { payloadShape, defaultTemplateKey } from './templates';
export type { TemplateKeyFn, TemplateParts } from './templates';
export { SyncStackContext } from './causality';
export type { CausalityContext } from './causality';

// For adapter authors
export type { DispatchInfo, Frame, Invoke } from './recorder';
export { dispatchAll, recordersFor } from './routing';

/** The key `enable()` uses for the shared recorder. */
export const DEFAULT_RECORDER_KEY = 'default';

/**
 * One-line setup: creates (once) and returns the shared recorder, `connectRecorder('default')`. The first call also
 * makes it the default recorder, so adapters record every emitter no other recorder has claimed into it.
 * `opts` only apply to the first call; later calls return the same recorder and ignore them.
 * @example
 * const recorder = enable({ windowMs: 60_000 });
 */
export function enable(opts?: Omit<RecorderOptions, 'key'>): Recorder {
  const recorder = connectRecorder(DEFAULT_RECORDER_KEY, opts);
  if (!getDefaultRecorder()) setDefaultRecorder(recorder);
  return recorder;
}

/** The shared recorder created by `enable()`, or `undefined` if it hasn't been called. */
export function getRecorder(): Recorder | undefined {
  return getRecorders().find((r) => r.key === DEFAULT_RECORDER_KEY);
}

import { EventEmitter } from 'node:events';
import { Server as NetServer } from 'node:net';
import { Stream } from 'node:stream';
import { dispatchAll, enable, isTracked, recordersFor, type Recorder } from '@ida/core';
import { installOriginTracking } from './origin';

/** Call to restore the original `EventEmitter.prototype.emit` and stop recording. */
export type Uninstall = () => void;

export interface EventEmitterAdapterOptions {
  /**
   * Return false to leave an emitter unrecorded. Runs after the built-in ignore list.
   * @example
   * { include: (emitter) => !(emitter instanceof MyNoisyBus) }
   */
  include?: (emitter: EventEmitter) => boolean;
  /**
   * Also record Node internals (streams, sockets, servers, `process`, the emitters behind `fetch`). Noisy.
   * @default false
   */
  includeInternals?: boolean;
  /**
   * Also record emitters created by installed packages. By default an emitter whose class lives in `node_modules`
   * is only recorded for events your code listens to (`ws.on('message', onMessage)`), or when a recorder `track()`s it.
   * @default false
   */
  includeLibraries?: boolean;
  /**
   * Decides which source files are your app. Emitters are sorted by where their class is defined (or, for a plain
   * `new EventEmitter()`, where it is created). By default, anything outside `node_modules` and Node itself is app code.
   * @example
   * { isAppFile: (file) => !file.includes('node_modules') || file.includes('node_modules/@acme/') }
   */
  isAppFile?: (file: string) => boolean;
}

// Emitters Node creates for its own plumbing (fs handles, worker threads, child processes, ...).
const INTERNAL_CLASSES = new Set([
  'FileHandle', 'Worker', 'MessagePort', 'BroadcastChannel', 'ChildProcess', 'FSWatcher', 'StatWatcher',
]);

/**
 * The connection pools behind Node's built-in `fetch` (undici's Client, Pool, Agent, …). Matched by their shared base
 * class rather than their generic names. Without this, an uploader using `fetch` would record its own uploads.
 */
const isFetchDispatcher = (e: EventEmitter): boolean => {
  for (let p = Object.getPrototypeOf(e); p && p !== EventEmitter.prototype; p = Object.getPrototypeOf(p)) {
    if (p.constructor?.name === 'DispatcherBase') return true;
  }
  return false;
};

const isInternal = (e: EventEmitter): boolean =>
  e instanceof Stream || e instanceof NetServer || e === (process as unknown as EventEmitter) ||
  INTERNAL_CLASSES.has((e as { constructor?: { name?: string } }).constructor?.name ?? '') || isFetchDispatcher(e);

/**
 * Patches `EventEmitter.prototype.emit` so every emit is recorded with its handlers, timings, errors and cause.
 * Behavior is unchanged: listeners run in the same order and errors propagate.
 * @param recorder where to record. Leave it out to route each emitter to the recorders that `track()` it, or else to
 * the default recorder (see `enable()`); emitters with neither aren't recorded.
 * @param options which emitters to record
 * @returns a function that restores the original `emit`
 * @example
 * enable();                       // everything goes to the shared recorder...
 * connectRecorder('payments').track(paymentsBus); // ...except what another recorder claims
 * const uninstall = enableEventEmitterRecording();
 */
export function enableEventEmitterRecording(recorder?: Recorder, options: EventEmitterAdapterOptions = {}): Uninstall {
  const proto = EventEmitter.prototype;
  const original = proto.emit;
  const targets = recorder ? () => (recorder.recording ? [recorder] : []) : recordersFor;
  // Internals are already skipped by the cheap check, so they never pay for a stack capture.
  const origin = installOriginTracking({ isAppFile: options.isAppFile, skip: options.includeInternals ? undefined : isInternal });

  /** Whether this emit belongs in the recording: the app's own emitters, and others only where the app is involved. */
  const wanted = (emitter: EventEmitter, raw: Array<Function & { listener?: Function }>): boolean => {
    if (options.include && !options.include(emitter)) return false;
    if (isTracked(emitter)) return true;
    const o = origin.originOf(emitter) ?? origin.originAtEmit(emitter, patchedEmit);
    if (o === 'app') return true;
    if (o === 'library' && options.includeLibraries) return true;
    if (o === 'internal' && options.includeInternals) return true;
    return origin.hasAppListener(raw.map((l) => l.listener ?? l));
  };

  const patchedEmit = function patchedEmit(this: EventEmitter, name: string | symbol, ...args: unknown[]): boolean {
    if (!options.includeInternals && isInternal(this)) return original.call(this, name, ...args);
    const raw = this.rawListeners(name) as Array<Function & { listener?: Function }>;
    const recorders = wanted(this, raw) ? targets(this) : [];
    if (!recorders.length) return original.call(this, name, ...args);
    const info = {
      emitter: this,
      eventName: String(name),
      handlers: raw.map((l) => l.listener ?? l),
      payload: args.length > 1 ? args : args[0],
    };
    // No listeners: nothing to time, and the original keeps Node's 'error' throwing semantics.
    if (raw.length === 0) return dispatchAll(recorders, info, () => original.call(this, name, ...args));
    return dispatchAll(recorders, info, (invoke) => {
      for (const l of raw) invoke(l.listener ?? l, () => l.apply(this, args));
      return true;
    });
  };
  proto.emit = patchedEmit;

  return () => {
    if (proto.emit !== original) proto.emit = original;
    origin.uninstall();
  };
}

export { enable };

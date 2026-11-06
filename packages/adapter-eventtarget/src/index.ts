import { dispatchAll, enable, recordersFor, type Recorder } from '@eda-debugger/core';

/** Call to restore the original `EventTarget` methods and stop recording. */
export type Uninstall = () => void;

export interface EventTargetAdapterOptions {
  /**
   * Return false to leave a target unrecorded.
   * @example
   * { include: (target) => target !== document.body }
   */
  include?: (target: EventTarget) => boolean;
  /**
   * Process label for a target. Return `undefined` to fall back to the default.
   * @default `window`, `document`, `tag#id` or the constructor name (see `describeTarget`)
   * @example
   * { label: (t) => (t === document ? 'Page' : undefined) }
   */
  label?: (target: EventTarget) => string | undefined;
}

type Listener = EventListenerOrEventListenerObject;

const call = (l: Listener, thisArg: unknown, event: Event) =>
  typeof l === 'function' ? l.call(thisArg, event) : l.handleEvent(event);

/** The default process label for a target: `window`, `document`, `tag#id` / `tag.class`, or the constructor name. */
export function describeTarget(t: EventTarget): string {
  const g = globalThis as { window?: unknown; document?: unknown };
  if (t === g.window) return 'window';
  if (t === g.document) return 'document';
  const el = t as Partial<Element>;
  if (typeof el.tagName === 'string') {
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : '');
  }
  return (t as { constructor?: { name?: string } }).constructor?.name ?? 'EventTarget';
}

/**
 * Patches EventTarget so listeners are tracked per target and every dispatch is recorded: native events
 * (click, input, ...) and `dispatchEvent` alike. Listener behavior (order, `once`, `capture`, `passive`,
 * `handleEvent` objects, `removeEventListener`) is unchanged because the original methods still do the registering.
 * @param recorder where to record. Leave it out to route each target to the recorders that `track()` it, or else to the
 * default recorder (see `enable()`); targets with neither aren't recorded.
 * @param options which targets to record and how to label them
 * @returns a function that restores the original methods
 * @example
 * const uninstall = enableEventTargetRecording(enable(), { label: (t) => (t === document ? 'Page' : undefined) });
 */
export function enableEventTargetRecording(recorder?: Recorder, options: EventTargetAdapterOptions = {}): Uninstall {
  const proto = EventTarget.prototype;
  const { addEventListener, removeEventListener, dispatchEvent } = proto;

  // target -> type -> original listener -> the wrapper registered in its place
  const wrappers = new WeakMap<EventTarget, Map<string, Map<Listener, Map<boolean, EventListener>>>>();
  // target -> type -> originals, in registration order, so the handler set of a dispatch is known up front
  const registered = new WeakMap<EventTarget, Map<string, Listener[]>>();
  // events already opened as an occurrence (native events get one when their first wrapped listener runs)
  const open = new WeakMap<Event, { invoke: <R>(h: Function, c: () => R) => R }>();

  const tracked = (t: EventTarget) => !options.include || options.include(t);
  const targets = recorder ? () => (recorder.recording ? [recorder] : []) : recordersFor;
  const captureOf = (o?: boolean | AddEventListenerOptions) => (typeof o === 'boolean' ? o : !!o?.capture);

  const handlersFor = (t: EventTarget, type: string): Listener[] => registered.get(t)?.get(type) ?? [];

  /** Runs `fn` inside an occurrence for `event` on `target`, reusing one already open for this Event. */
  function record(target: EventTarget, event: Event, run: () => boolean): boolean {
    return dispatchAll(
      targets(target),
      {
        emitter: target, label: options.label?.(target) ?? describeTarget(target), eventName: event.type,
        handlers: handlersFor(target, event.type).map((l) => (typeof l === 'function' ? l : (l.handleEvent as Function))),
        payload: eventPayload(event),
      },
      (invoke) => {
        open.set(event, { invoke });
        try {
          return run();
        } finally {
          open.delete(event);
        }
      },
    );
  }

  proto.addEventListener = function (this: EventTarget, type: string, listener: Listener | null, opts?: boolean | AddEventListenerOptions) {
    if (!listener || !tracked(this)) return addEventListener.call(this, type, listener as Listener, opts);
    const cap = captureOf(opts);
    const perType = wrappers.get(this) ?? new Map();
    wrappers.set(this, perType);
    const perListener: Map<Listener, Map<boolean, EventListener>> = perType.get(type) ?? new Map();
    perType.set(type, perListener);
    if (perListener.get(listener)?.has(cap)) return; // duplicate registration is a no-op, like the platform

    const wrapper: EventListener = (event) => {
      const ctx = open.get(event);
      const target = this;
      if (ctx) return ctx.invoke(listener as unknown as Function, () => call(listener, target, event));
      // Native event: open its occurrence now. Handlers that run later reuse it.
      let result: unknown;
      record(target, event, () => {
        open.get(event)!.invoke(listener as unknown as Function, () => (result = call(listener, target, event)));
        return true;
      });
      return result;
    };
    const byCapture = perListener.get(listener) ?? new Map();
    byCapture.set(cap, wrapper);
    perListener.set(listener, byCapture);
    const list = registered.get(this) ?? new Map();
    registered.set(this, list);
    list.set(type, [...(list.get(type) ?? []), listener]);
    return addEventListener.call(this, type, wrapper, opts);
  } as typeof proto.addEventListener;

  proto.removeEventListener = function (this: EventTarget, type: string, listener: Listener | null, opts?: boolean | EventListenerOptions) {
    const cap = captureOf(opts as AddEventListenerOptions);
    const wrapper = listener ? wrappers.get(this)?.get(type)?.get(listener)?.get(cap) : undefined;
    if (!listener || !wrapper) return removeEventListener.call(this, type, listener as Listener, opts);
    const perListener = wrappers.get(this)!.get(type)!;
    perListener.get(listener)!.delete(cap);
    if (!perListener.get(listener)!.size) {
      perListener.delete(listener);
      const list = registered.get(this)!;
      list.set(type, (list.get(type) ?? []).filter((l) => l !== listener));
    }
    return removeEventListener.call(this, type, wrapper, opts);
  } as typeof proto.removeEventListener;

  proto.dispatchEvent = function (this: EventTarget, event: Event) {
    if (!tracked(this) || open.has(event) || !targets(this).length) return dispatchEvent.call(this, event);
    return record(this, event, () => dispatchEvent.call(this, event));
  };

  return () => {
    proto.addEventListener = addEventListener;
    proto.removeEventListener = removeEventListener;
    proto.dispatchEvent = dispatchEvent;
  };
}

/** Plain-data view of an Event: its type-specific fields are not enumerable on the object itself. */
function eventPayload(event: Event): unknown {
  const detail = (event as CustomEvent).detail;
  if (detail !== undefined && detail !== null) return detail;
  const out: Record<string, unknown> = {};
  for (const key of ['key', 'code', 'button', 'clientX', 'clientY', 'data', 'inputType', 'value'] as const) {
    if (key in event) out[key] = (event as unknown as Record<string, unknown>)[key];
  }
  return Object.keys(out).length ? out : undefined;
}

export { enable };

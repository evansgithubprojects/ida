import { RingBuffer } from './buffer';
import { matchesCapture, type CaptureRule } from './capture';
import { SyncStackContext, type CausalityContext } from './causality';
import { CorruptionEngine, SuspectedCorruptionError, type EngineOptions, type Observation } from './corruption';
import { Registry } from './ids';
import { toJsonSafe } from './json';
import { trackEmitter, untrackEmitter } from './routing';
import { payloadShape, TemplateRegistry, type TemplateKeyFn } from './templates';
import {
  RECORDING_VERSION, type ErrorInfo, type Finding, type HandlerResult, type Occurrence,
  type RecorderMessage, type Recording,
} from './types';

/** Called with each finding as it is raised. */
export type FindingNotifier = (finding: Finding) => void;

/** What to do with a suspect payload: `'notify'` lets the event continue, `'block'` stops it before any handler runs. */
export type Policy = 'notify' | 'block';

export interface CorruptionOptions extends EngineOptions {
  /**
   * Where findings are reported. `'console'` prints a warning (`console.error` for external systems); a function
   * receives the finding; pass an array for both.
   * @default undefined (nothing is printed or called; findings are still recorded)
   * @example
   * { notify: ['console', (f) => metrics.increment('corrupt_payload', { event: f.summary })] }
   */
  notify?: 'console' | FindingNotifier | Array<'console' | FindingNotifier>;
  /**
   * 'notify' lets the event continue; 'block' throws a `SuspectedCorruptionError` from emit instead of calling
   * any handler.
   * @default 'notify'
   */
  policy?: Policy;
  /**
   * Policy for payloads headed to an external system.
   * @default the value of `policy`
   */
  externalPolicy?: Policy;
  /**
   * What counts as an external system (HTTP APIs, databases, third parties). Corrupt payloads reaching these are
   * reported as high priority. Also see `recorder.markExternal()`.
   * @example
   * { external: { handlers: [postToBillingApi], events: ['db:write'] } }
   */
  external?: {
    /** Event names, or a function of the event name and the emitter's label, that deliver to an external system. */
    events?: string[] | ((eventName: string, emitterLabel: string) => boolean);
    /** Handler functions that talk to an external system. */
    handlers?: Function[];
    /** Emitters whose every event is delivered to an external system. */
    emitters?: object[];
  };
}

export interface RecorderOptions {
  /**
   * Names the recorder. `connectRecorder(key)` sets it; uploads use it to file recordings under this recorder.
   * @default 'unnamed'
   */
  key?: string;
  /**
   * How much history to keep, in milliseconds. Older events are dropped as new ones arrive.
   * @default 300000 (5 minutes)
   */
  windowMs?: number;
  /**
   * The most events to keep, whatever the window. The oldest are dropped first.
   * @default 50000
   */
  maxEvents?: number;
  /**
   * Deep logging: events listed here keep their full payload; all others are template-only.
   * @default undefined (every event is template-only)
   * @example
   * { deepLogging: { events: ['order:confirmed'] } }
   */
  deepLogging?: CaptureRule;
  /** Alias of deepLogging. */
  capture?: CaptureRule;
  /**
   * How events are grouped into templates. Receives the emitter, event name, handler set and payload shape.
   * Return a coarser key to group more events together.
   * @default defaultTemplateKey (emitter + event name + handler set + payload shape)
   * @example
   * { templateKey: (p) => `${p.emitterId}|${p.eventName}` } // ignore handlers and payload shape
   */
  templateKey?: TemplateKeyFn;
  /**
   * Detection of suspected corrupt payloads. Findings are always recorded and shown in the viewer; this controls
   * how they are reported and whether they block the event.
   */
  corruption?: CorruptionOptions;
  /**
   * Tracks which event is being handled, so emits can point at their cause. Swap it to support async hops.
   * @default SyncStackContext (synchronous causality only)
   */
  context?: CausalityContext<Frame>;
  /**
   * Start recording straight away. When `false`, call `recorder.start()` first.
   * @default true
   */
  autoStart?: boolean;
  /**
   * The clock used for timestamps, in milliseconds.
   * @default performance.now
   */
  now?: () => number;
}

/** What an adapter hands the recorder for one emit. */
export interface DispatchInfo {
  /** The object the event was emitted on. It becomes a process in the graph. */
  emitter: object;
  /** Display name hint for the emitter's process, e.g. "Payments" or "button#save". */
  label?: string;
  eventName: string;
  /** The listeners that will run, in order. Each becomes a handler node. */
  handlers: Function[];
  /** The raw payload. It is only stored when the event is deep-logged. */
  payload: unknown;
}

/** Run one handler under the current event so emits inside it point back at it. */
export type Invoke = <R>(handler: Function, call: () => R) => R;

/** The "currently handling" entry kept by the causality context. For adapter and context authors. */
export interface Frame {
  eventId: string;
  handlerId: string;
  /** Emits made while this handler ran, kept so they can be flagged if it throws afterwards. */
  children: Observation[];
}

export interface Recorder {
  /** The name given with `connectRecorder(key)` or the `key` option. */
  readonly key: string;
  /**
   * Claim an emitter: adapters installed without a recorder send its events here instead of to the default recorder.
   * Optional for your own emitters: one nobody tracks is still recorded, by the default recorder (the one `enable()`
   * sets up), when there is one. Tracking also forces in an emitter an installed package created, which the Node
   * adapter otherwise skips unless your code listens to it. It doesn't name the emitter (see `labelEmitter`).
   * Several recorders may track the same emitter; each records its events and the listeners still run once.
   * Parent links don't cross recorders: an event caused by one recorded in another starts a new chain.
   * @example
   * connectRecorder('payments').track(paymentsBus);
   */
  track(emitter: object): void;
  /** Stop claiming an emitter. */
  untrack(emitter: object): void;
  /**
   * For adapter authors: records one emit and runs it. `run` must call each listener through `invoke` so its timing,
   * errors and emits are attributed to it. Returns whatever `run` returns.
   */
  dispatch<T>(info: DispatchInfo, run: (invoke: Invoke) => T): T;
  /** Resume recording. Events emitted while stopped are not recorded. */
  start(): void;
  /** Pause recording. What was already recorded is kept. */
  stop(): void;
  /** Whether events are currently being recorded. */
  readonly recording: boolean;
  /** A snapshot of everything in the window as a versioned, JSON-serializable `Recording` for the viewer. */
  export(): Recording;
  /** Forget everything recorded so far. */
  clear(): void;
  /**
   * Receive each new occurrence and finding as it happens.
   * @returns a function that stops the subscription
   */
  subscribe(listener: (message: RecorderMessage) => void): () => void;
  /**
   * Name an emitter's process in the viewer. Optional: labeling only renames, it doesn't decide what is recorded.
   * Adapters record every emitter your code creates (each emit goes to the recorders that `track()` it, else the
   * default recorder), so unlabeled ones show up too, under the adapter's guess: usually the class name plus a
   * counter, like `EventEmitter#3`. Emitters created by installed packages or Node itself are skipped by the Node
   * adapter unless your code listens to them or a recorder tracks them.
   * Call it before the emitter's first recorded emit; once the recorder has seen an emitter, its name is fixed.
   * @example
   * recorder.labelEmitter(paymentsBus, 'Payments');
   */
  labelEmitter(emitter: object, label: string): void;
  /**
   * Name a handler in the viewer. Without it, the function's own name is used.
   * @example
   * recorder.labelHandler(onOrder, 'charge card');
   */
  labelHandler(fn: Function, label: string): void;
  /** Mark a handler function or a whole emitter as delivering to an external system. */
  markExternal(target: object | Function): void;
}

const toErrorInfo = (err: unknown): ErrorInfo =>
  err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : { name: 'Error', message: String(err) };

const looksLikeError = (v: unknown): boolean =>
  v instanceof Error || (typeof v === 'object' && v !== null && 'message' in v && 'stack' in v);

function normalizeNotify(n: CorruptionOptions['notify']): FindingNotifier[] {
  return (Array.isArray(n) ? n : n ? [n] : []).map((x) =>
    x === 'console'
      ? (f: Finding) => (f.priority === 'high' ? console.error : console.warn)(
          `[eda-debugger] ${f.priority === 'high' ? 'HIGH PRIORITY ' : ''}${f.confidence} confidence${f.retroactive ? ' (retroactive)' : ''}: ${f.summary}`,
        )
      : x,
  );
}

/**
 * Creates a recorder. Adapters call `recorder.dispatch()` for you; you read the result with `recorder.export()`.
 * Most apps want `enable()` instead, which shares one recorder with the adapters.
 * @example
 * const recorder = createRecorder({ windowMs: 60_000, deepLogging: { events: ['order:confirmed'] } });
 * enableEventEmitterRecording(recorder);
 */
export function createRecorder(opts: RecorderOptions = {}): Recorder {
  const now = opts.now ?? (() => performance.now());
  const origin = now();
  const startedAt = Date.now();
  const deepRule = opts.deepLogging ?? opts.capture;
  const registry = new Registry();
  const templates = new TemplateRegistry(opts.templateKey);
  const buffer = new RingBuffer<Occurrence>(opts.maxEvents ?? 50_000, opts.windowMs ?? 5 * 60_000);
  const ctx: CausalityContext<Frame> = opts.context ?? new SyncStackContext<Frame>();
  const engine = new CorruptionEngine(opts.corruption);
  const notifiers = normalizeNotify(opts.corruption?.notify);
  const consoleOn = [opts.corruption?.notify].flat().includes('console');
  const policy = opts.corruption?.policy ?? 'notify';
  const externalPolicy = opts.corruption?.externalPolicy ?? policy;
  const externalRule = opts.corruption?.external;
  /** Where each thrown error object was first seen, so one that propagates through several handlers stays one error. */
  const thrownAt = new WeakMap<object, { occurrenceId: string; handlerId: string }>();
  const externalHandlers = new WeakSet<object>(externalRule?.handlers ?? []);
  const externalEmitters = new WeakSet<object>(externalRule?.emitters ?? []);
  const listeners = new Set<(m: RecorderMessage) => void>();
  let findings: Finding[] = [];
  let recording = opts.autoStart !== false;
  let seq = 0;

  const emit = (m: RecorderMessage) => listeners.forEach((l) => l(m));

  const report = (finding: Finding) => {
    findings.push(finding);
    // External payloads are always surfaced on the console too (as an error) when any notification is on.
    if (finding.priority === 'high' && notifiers.length && !consoleOn) {
      console.error(`[eda-debugger] HIGH PRIORITY ${finding.summary}`);
    }
    for (const n of notifiers) n(finding);
    emit({ type: 'finding', finding });
  };

  const evict = (items: Occurrence[]) => items.forEach((o) => templates.release(o.templateId));

  function dispatch<T>(info: DispatchInfo, run: (invoke: Invoke) => T): T {
    if (!recording) return run((_h, call) => call());

    const frame = ctx.current();
    const emitter = registry.emitter(info.emitter, info.label);
    const handlerIds = info.handlers.map((h) => registry.handler(h, emitter).id);
    const shape = payloadShape(info.payload);
    const template = templates.intern({ emitterId: emitter.node.id, eventName: info.eventName, handlerIds, payloadShape: shape });
    const ev = externalRule?.events;
    const externalTargets: string[] = [];
    if (externalEmitters.has(info.emitter) || (typeof ev === 'function' ? ev(info.eventName, emitter.process.label) : ev?.includes(info.eventName))) {
      externalTargets.push(`${emitter.process.label} → ${info.eventName}`);
    }
    for (const h of info.handlers) if (externalHandlers.has(h)) externalTargets.push(registry.handler(h, emitter).label);
    if (externalTargets.length) template.external = externalTargets;
    const deep = matchesCapture(deepRule, info.eventName, emitter.process.label);
    const payload = deep ? toJsonSafe(info.payload) : undefined;
    const ts = now() - origin;
    const id = `e${++seq}`;

    const occurrence: Occurrence = {
      id, templateId: template.id, parentId: frame?.eventId ?? null,
      sourceNodeId: frame?.handlerId ?? emitter.node.id, ts, durationMs: 0, handlerResults: [],
      capture: deep ? 'full' : 'template', ...(deep ? { payload } : {}), causality: 'sync',
    };
    const observation: Observation = {
      occurrenceId: id, parentId: occurrence.parentId, sourceNodeId: occurrence.sourceNodeId,
      emitterId: emitter.node.id, eventName: info.eventName, label: `${emitter.process.label} → ${info.eventName}`,
      shape, payload, ts, externalTargets: externalTargets.length ? externalTargets : undefined,
    };
    frame?.children.push(observation);

    const finding = engine.observe(observation);
    if (info.eventName === 'error' && looksLikeError(info.payload)) {
      occurrence.signalsError = true;
      engine.onError(frame?.handlerId ?? null, emitter.node.id, id, ts);
    }

    const finalize = () => {
      occurrence.durationMs = now() - origin - ts;
      const fresh = registry.drainFresh();
      emit({ type: 'occurrence', occurrence, template, nodes: fresh.nodes, processes: fresh.processes });
    };
    evict(buffer.push(occurrence));

    if (finding) {
      report(finding);
      if ((finding.priority === 'high' ? externalPolicy : policy) === 'block') {
        occurrence.blocked = true;
        finalize();
        throw new SuspectedCorruptionError(finding);
      }
    }

    const invoke: Invoke = (handler, call) => {
      const node = registry.handler(handler, emitter);
      const handlerFrame: Frame = { eventId: id, handlerId: node.id, children: [] };
      const result: HandlerResult = { handlerId: node.id, ts: now() - origin, durationMs: 0 };
      try {
        return ctx.run(handlerFrame, call);
      } catch (err) {
        result.error = toErrorInfo(err);
        const trackable = typeof err === 'object' && err !== null;
        const first = trackable ? thrownAt.get(err) : undefined;
        const source = first ?? { occurrenceId: id, handlerId: node.id };
        if (first) {
          result.rethrown = first;
        } else {
          if (trackable) thrownAt.set(err, source);
          engine.onError(node.id, emitter.node.id, id, now() - origin);
        }
        for (const child of handlerFrame.children) {
          if (engine.isFlagged(child.occurrenceId)) {
            const at = findings.findIndex((f) => f.occurrenceId === child.occurrenceId);
            const updated = at >= 0 && engine.attribute(findings[at]!, source);
            if (updated) {
              findings[at] = updated;
              emit({ type: 'finding', finding: updated });
            }
            continue;
          }
          const late = engine.observe(child, source);
          if (late) report({ ...late, retroactive: true });
        }
        throw err;
      } finally {
        result.durationMs = now() - origin - result.ts;
        occurrence.handlerResults.push(result);
      }
    };

    try {
      return run(invoke);
    } finally {
      finalize();
    }
  }

  const self: Recorder = {
    key: opts.key ?? 'unnamed',
    track(emitter) { trackEmitter(self, emitter); },
    untrack(emitter) { untrackEmitter(self, emitter); },
    dispatch,
    start() { recording = true; },
    stop() { recording = false; },
    get recording() { return recording; },
    export(): Recording {
      const occurrences = buffer.toArray();
      const kept = new Set(occurrences.map((o) => o.id));
      return {
        version: RECORDING_VERSION,
        startedAt,
        processes: [...registry.processes.values()],
        nodes: [...registry.nodes.values()],
        templates: templates.all().map((t) => ({ ...t })),
        occurrences: occurrences.map((o) => ({ ...o, handlerResults: o.handlerResults.slice() })),
        findings: findings.filter((f) => kept.has(f.occurrenceId)),
      };
    },
    clear() {
      evict(buffer.clear());
      templates.clear();
      engine.clear();
      findings = [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    labelEmitter: (e, l) => registry.labelEmitter(e, l),
    labelHandler: (f, l) => registry.labelHandler(f, l),
    markExternal: (t) => { (typeof t === 'function' ? externalHandlers : externalEmitters).add(t); },
  };
  return self;
}

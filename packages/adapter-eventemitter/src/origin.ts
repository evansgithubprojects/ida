import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

/** Where an emitter's code lives: the app's own files, an installed package, or Node itself. */
export type Origin = 'app' | 'library' | 'internal';

export interface OriginOptions {
  /** Decides whether a source file belongs to the app. By default, anything outside `node_modules` and Node itself. */
  isAppFile?: (file: string) => boolean;
  /** Emitters to skip entirely, without paying for a stack capture (the adapter's cheap internals check). */
  skip?: (emitter: EventEmitter) => boolean;
}

interface Site { file: string | null; fn: string | null; ctor: boolean }

const STACK_LIMIT = 12;

/** The caller's stack as structured frames, starting below `below`. Cheap: no string formatting. */
function sites(below: Function): Site[] {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  const holder: { stack?: NodeJS.CallSite[] } = {};
  try {
    Error.prepareStackTrace = (_e, s) => s;
    Error.stackTraceLimit = STACK_LIMIT;
    Error.captureStackTrace(holder, below);
    const raw = holder.stack;
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => ({ file: s.getFileName() ?? null, fn: s.getFunctionName(), ctor: s.isConstructor() }));
  } catch {
    return [];
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}

/** This file, so our own wrappers never count as the caller. */
const OWN_FILE = (function probe() { return sites(probe)[0]?.file ?? null; })();

const isNode = (file: string | null) => !file || file.startsWith('node:') || !/[\\/]/.test(file);

function normalize(file: string): string {
  if (!file.startsWith('file://')) return file;
  try { return fileURLToPath(file); } catch { return file; }
}

export const defaultIsAppFile = (file: string): boolean => !/[\\/]node_modules[\\/]/.test(file);

/**
 * Tells app emitters from those a package or Node created, by looking at where each one is constructed, and remembers
 * which listeners app code added. Installed once per adapter install; `uninstall` restores everything it wrapped.
 */
export function installOriginTracking(opts: OriginOptions = {}) {
  const isAppFile = opts.isAppFile ?? defaultIsAppFile;
  const origins = new WeakMap<object, Origin>();
  const appListeners = new WeakSet<Function>();

  const classify = (file: string | null): Origin => (isNode(file) ? 'internal' : isAppFile(normalize(file!)) ? 'app' : 'library');

  /**
   * The frame that says where an emitter's class lives: its most-derived constructor (`new Bus`), so an app subclass
   * of a library class counts as app. A plain `new EventEmitter()` belongs to whoever called it.
   */
  const creationOrigin = (emitter: EventEmitter, frames: Site[]): Origin => {
    const name = (emitter as { constructor?: { name?: string } }).constructor?.name ?? '';
    if (name && name !== 'EventEmitter') {
      const own = frames.find((f) => f.ctor && f.fn === name);
      if (own) return classify(own.file);
    } else {
      const at = frames.findIndex((f) => f.fn === 'EventEmitter' && isNode(f.file));
      const caller = frames.slice(at + 1).find((f) => !(f.file === 'node:events'));
      if (caller) return classify(caller.file);
    }
    const first = frames.find((f) => !isNode(f.file));
    return first ? classify(first.file) : 'internal';
  };

  /** The first frame that isn't Node's own events plumbing (e.g. `once` calling `on`): who actually called in. */
  const callerOrigin = (below: Function): Origin => {
    const caller = sites(below).find((f) => f.file !== 'node:events' && f.file !== OWN_FILE);
    return classify(caller?.file ?? null);
  };

  const ctor = EventEmitter as unknown as { init: (this: EventEmitter, ...a: unknown[]) => void };
  const originalInit = ctor.init;
  const init = function wrappedInit(this: EventEmitter, ...args: unknown[]) {
    // Nothing in here may log: console output creates a stream, which is itself an emitter and would recurse.
    if (this && typeof this === 'object' && !origins.has(this) && !opts.skip?.(this)) {
      origins.set(this, creationOrigin(this, sites(wrappedInit)));
    }
    return originalInit.apply(this, args);
  };
  ctor.init = init;

  const proto = EventEmitter.prototype as unknown as Record<string, Function>;
  const methods = ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener'] as const;
  const saved = methods.map((m) => [m, proto[m]!] as const);
  for (const [m, original] of saved) {
    const wrapped = function (this: EventEmitter, name: string | symbol, listener: Function & { listener?: Function }) {
      // Only emitters the app didn't create need this: an app emitter is recorded regardless of who listens.
      if (typeof listener === 'function' && this && typeof this === 'object' && originOf(this) !== 'app' && !opts.skip?.(this) && callerOrigin(wrapped) === 'app') {
        appListeners.add(listener.listener ?? listener);
      }
      return original.call(this, name, listener);
    };
    proto[m] = wrapped;
  }

  /** The emitter's origin, or undefined if it was created before this was installed. */
  function originOf(emitter: EventEmitter): Origin | undefined {
    return origins.get(emitter);
  }

  return {
    originOf,
    /**
     * Origin of an emitter created before install: decided once, on its first emit, by who emitted it.
     * `below` is the patched emit, so its own frame is skipped.
     */
    originAtEmit(emitter: EventEmitter, below: Function): Origin {
      let o = origins.get(emitter);
      if (!o) { o = callerOrigin(below); origins.set(emitter, o); }
      return o;
    },
    /** Whether app code added one of these listeners. */
    hasAppListener(listeners: readonly Function[]): boolean {
      return listeners.some((l) => appListeners.has(l));
    },
    uninstall() {
      if (ctor.init === init) ctor.init = originalInit;
      for (const [m, original] of saved) proto[m] = original;
    },
  };
}

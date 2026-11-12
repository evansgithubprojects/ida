/**
 * Tracks "what is currently being handled" so emits can point at their cause.
 * Swappable: `defaultContext()` picks `AsyncStorageContext` where Node's AsyncLocalStorage exists, and the sync stack
 * elsewhere. A TC39 AsyncContext implementation can replace it later.
 */
export interface CausalityContext<F> {
  current(): F | undefined;
  run<R>(frame: F, fn: () => R): R;
  /**
   * True when `current()` is a frame whose handler already returned: the emit happens after an `await`, in a timer
   * or another async continuation the handler started. Such links are marked `'inferred'`.
   */
  isAsync?(): boolean;
}

export class SyncStackContext<F> implements CausalityContext<F> {
  private stack: F[] = [];

  current(): F | undefined {
    return this.stack[this.stack.length - 1];
  }

  run<R>(frame: F, fn: () => R): R {
    this.stack.push(frame);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }
}

/** The part of Node's `AsyncLocalStorage` this needs, so core never imports Node. */
export interface AsyncStorage<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

interface Cell<F> {
  frame: F;
  /** True while the handler's synchronous part runs. */
  sync: boolean;
}

/**
 * Follows a handler into its async continuations (after `await`, timers, promise callbacks) using an
 * AsyncLocalStorage, so events emitted there still point at the event the handler was handling.
 */
export class AsyncStorageContext<F> implements CausalityContext<F> {
  constructor(private readonly storage: AsyncStorage<Cell<F>>) {}

  current(): F | undefined {
    return this.storage.getStore()?.frame;
  }

  isAsync(): boolean {
    const cell = this.storage.getStore();
    return !!cell && !cell.sync;
  }

  run<R>(frame: F, fn: () => R): R {
    const cell: Cell<F> = { frame, sync: true };
    try {
      return this.storage.run(cell, fn);
    } finally {
      cell.sync = false;
    }
  }
}

type GetBuiltin = (id: string) => { AsyncLocalStorage?: new <T>() => AsyncStorage<T> } | undefined;

/**
 * `AsyncStorageContext` in Node (20.16+ / 22.3+, via `process.getBuiltinModule`, so nothing is imported and browser
 * bundles are unaffected); the sync stack everywhere else.
 */
export function defaultContext<F>(): CausalityContext<F> {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: GetBuiltin } }).process?.getBuiltinModule;
  const ALS = getBuiltin?.('node:async_hooks')?.AsyncLocalStorage;
  return ALS ? new AsyncStorageContext<F>(new ALS<Cell<F>>()) : new SyncStackContext<F>();
}

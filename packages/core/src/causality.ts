/**
 * Tracks "what is currently being handled" so emits can point at their cause.
 * Swappable: an AsyncLocalStorage / AsyncContext implementation can replace the sync stack
 * and mark its links as 'inferred'.
 */
export interface CausalityContext<F> {
  current(): F | undefined;
  run<R>(frame: F, fn: () => R): R;
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

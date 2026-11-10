import type { RecorderMessage } from '@ida-dev/core';

/** What a live viewer is sent after a batch is stored. */
export interface LiveBatch {
  sessionId: string;
  messages: RecorderMessage[];
}

/**
 * Fans stored batches out to the live streams watching each recorder. In-process: with more than one server
 * instance this moves to Postgres LISTEN/NOTIFY.
 */
export class LiveHub {
  private readonly watchers = new Map<string, Set<(b: LiveBatch) => void>>();

  watch(recorderId: string, fn: (b: LiveBatch) => void): () => void {
    const set = this.watchers.get(recorderId) ?? new Set();
    set.add(fn);
    this.watchers.set(recorderId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.watchers.delete(recorderId);
    };
  }

  publish(recorderId: string, batch: LiveBatch): void {
    this.watchers.get(recorderId)?.forEach((fn) => fn(batch));
  }

  watching(recorderId: string): number {
    return this.watchers.get(recorderId)?.size ?? 0;
  }
}

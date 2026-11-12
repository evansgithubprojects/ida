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
  private readonly projectWatchers = new Map<string, Set<(b: LiveBatch) => void>>();

  watch(recorderId: string, fn: (b: LiveBatch) => void): () => void {
    return add(this.watchers, recorderId, fn);
  }

  /** Every recorder's batches in one project: the system view's live stream. */
  watchProject(projectId: string, fn: (b: LiveBatch) => void): () => void {
    return add(this.projectWatchers, projectId, fn);
  }

  publish(recorderId: string, batch: LiveBatch, projectId?: string): void {
    this.watchers.get(recorderId)?.forEach((fn) => fn(batch));
    if (projectId) this.projectWatchers.get(projectId)?.forEach((fn) => fn(batch));
  }

  watching(recorderId: string): number {
    return this.watchers.get(recorderId)?.size ?? 0;
  }
}

function add<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
  const set = map.get(key) ?? new Set();
  set.add(fn);
  map.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) map.delete(key);
  };
}

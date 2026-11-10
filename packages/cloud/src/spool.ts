import type { Gap, IngestBatch } from '@ida/core';

/** Where spooled batches are kept. Entries are read back in increasing `id` order. */
export interface SpoolStore {
  /** Shown to the developer, e.g. a directory or "IndexedDB (ida-spool)". */
  readonly where: string;
  /** Every stored id with its size in bytes, in increasing id order. */
  list(): Promise<{ id: number; bytes: number }[]>;
  write(id: number, data: string): Promise<void>;
  read(id: number): Promise<string | undefined>;
  remove(id: number): Promise<void>;
}

/** Keeps batches in memory only: they survive an outage but not a restart. */
export function memoryStore(): SpoolStore {
  const data = new Map<number, string>();
  return {
    where: 'memory (lost if the app exits)',
    list: async () => [...data].sort(([a], [b]) => a - b).map(([id, s]) => ({ id, bytes: s.length })),
    write: async (id, s) => { data.set(id, s); },
    read: async (id) => data.get(id),
    remove: async (id) => { data.delete(id); },
  };
}

/**
 * A first-in, first-out queue of batches waiting for the server, bounded by bytes. When full, the oldest batch is
 * replaced by a stub that carries only its envelope and a `gap`, so the server still learns what was lost.
 */
export class Spool {
  private entries: { id: number; bytes: number }[] | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly store: SpoolStore, readonly maxBytes = 50 * 1024 * 1024) {}

  get where(): string {
    return this.store.where;
  }

  /** Batches waiting, including any left by a previous run of the app. */
  async size(): Promise<number> {
    return this.serial(async () => (await this.load()).length);
  }

  async push(batch: IngestBatch): Promise<void> {
    return this.serial(async () => {
      const entries = await this.load();
      const data = JSON.stringify(batch);
      const id = this.nextId++;
      await this.store.write(id, data);
      entries.push({ id, bytes: data.length });
      await this.trim(entries);
    });
  }

  /** The oldest batch, without removing it. */
  async peek(): Promise<IngestBatch | undefined> {
    return this.serial(async () => {
      const first = (await this.load())[0];
      const data = first && (await this.store.read(first.id));
      return data ? (JSON.parse(data) as IngestBatch) : undefined;
    });
  }

  /** Removes the oldest batch, once it has been delivered. */
  async shift(): Promise<void> {
    return this.serial(async () => {
      const first = (await this.load()).shift();
      if (first) await this.store.remove(first.id);
    });
  }

  private async load() {
    if (!this.entries) {
      this.entries = await this.store.list();
      this.nextId = (this.entries.at(-1)?.id ?? 0) + 1;
    }
    return this.entries;
  }

  private async trim(entries: { id: number; bytes: number }[]) {
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    for (let i = 0; total > this.maxBytes && i < entries.length - 1; i++) {
      const e = entries[i]!;
      const data = await this.store.read(e.id);
      if (!data) continue;
      const batch = JSON.parse(data) as IngestBatch;
      if (!batch.messages.length) continue; // already a stub
      const stub = JSON.stringify({ ...batch, messages: [], gap: mergeGap(batch.gap, lost(batch)) } satisfies IngestBatch);
      await this.store.write(e.id, stub);
      total += stub.length - e.bytes;
      e.bytes = stub.length;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** What dropping `batch`'s messages loses. */
function lost(batch: IngestBatch): Gap {
  const ts = batch.messages.flatMap((m) => (m.type === 'occurrence' ? [m.occurrence.ts] : m.type === 'snapshot' ? m.recording.occurrences.map((o) => o.ts) : []));
  const dropped = batch.messages.reduce((n, m) => n + (m.type === 'occurrence' ? 1 : m.type === 'snapshot' ? m.recording.occurrences.length : 0), 0);
  return { fromTs: ts.length ? Math.min(...ts) : 0, toTs: ts.length ? Math.max(...ts) : 0, dropped };
}

function mergeGap(a: Gap | undefined, b: Gap): Gap {
  if (!a) return b;
  return { fromTs: Math.min(a.fromTs, b.fromTs), toTs: Math.max(a.toTs, b.toTs), dropped: a.dropped + b.dropped };
}

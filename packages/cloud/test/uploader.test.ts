import 'fake-indexeddb/auto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectRecorder, type IngestBatch, type Recorder } from '@ida/core';
import { resetRecorders } from '../../core/src/registry';
import { memoryStore, Spool, type SpoolStore } from '../src/spool';
import { fileStore } from '../src/store-node';
import { indexedDbStore } from '../src/store-browser';
import { createUploader, type UploadStatus, type Uploader } from '../src/uploader';

/** A fake server: records what it receives, and can be switched off or made to refuse. */
function fakeServer() {
  const received: IngestBatch[] = [];
  const state = { mode: 'up' as 'up' | 'down' | 'refuse' | 'busy' };
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (state.mode === 'down') throw new TypeError('fetch failed');
    if (state.mode === 'refuse') return new Response(JSON.stringify({ error: 'unknown or revoked project key' }), { status: 401 });
    if (state.mode === 'busy') return new Response('', { status: 503 });
    received.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { received, state, fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch };
}

function emit(rec: Recorder, name = 'go') {
  const h = function handle() {};
  rec.dispatch({ emitter: rec, eventName: name, handlers: [h], payload: { n: 1 } }, (inv) => inv(h, h));
}

const occurrences = (batches: IngestBatch[]) => batches.flatMap((b) => b.messages.filter((m) => m.type === 'occurrence'));

let uploader: Uploader | undefined;
let statuses: UploadStatus[];

function start(server: ReturnType<typeof fakeServer>, store: SpoolStore | false = memoryStore(), extra = {}) {
  statuses = [];
  uploader = createUploader(
    { projectKey: 'eda_key', endpoint: 'https://api.test/', fetch: server.fetch, flushMs: 50, spool: store, quiet: true, onStatus: (s) => statuses.push(s), ...extra },
    () => null,
    'test',
  );
  return uploader;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  await uploader?.close();
  uploader = undefined;
  resetRecorders();
});

describe('uploading', () => {
  it('batches each recorder’s messages and sends them with the project key', async () => {
    const server = fakeServer();
    const rec = connectRecorder('payments');
    start(server);
    emit(rec);
    emit(rec);
    await vi.advanceTimersByTimeAsync(60);
    expect(server.received).toHaveLength(1);
    const [batch] = server.received;
    expect(batch).toMatchObject({ recorderKey: 'payments', seq: 0, runtime: 'test' });
    expect(occurrences(server.received)).toHaveLength(2);
    expect(server.calls.mock.calls[0]![0]).toBe('https://api.test/v1/ingest');
    expect((server.calls.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer eda_key' });

    emit(rec);
    await uploader!.flush();
    expect(server.received.map((b) => b.seq)).toEqual([0, 1]);
    expect(new Set(server.received.map((b) => b.sessionId)).size).toBe(1);
  });

  it('uploads recorders created after configure, and what a recorder held before it', async () => {
    const server = fakeServer();
    const early = connectRecorder('early');
    emit(early);
    start(server);
    const late = connectRecorder('late');
    emit(late);
    await uploader!.flush();
    const byKey = Object.fromEntries(server.received.map((b) => [b.recorderKey, b]));
    expect(byKey.early!.messages[0]).toMatchObject({ type: 'snapshot' });
    expect(byKey.late!.messages[0]).toMatchObject({ type: 'occurrence' });
  });

  it('splits a large backlog into batches of maxBatch', async () => {
    const server = fakeServer();
    const rec = connectRecorder('r');
    start(server, memoryStore(), { maxBatch: 2, flushMs: 10_000 });
    for (let i = 0; i < 5; i++) emit(rec);
    await uploader!.flush();
    expect(server.received.map((b) => b.messages.length)).toEqual([2, 2, 1]);
  });
});

describe('batch size', () => {
  // Captured strings are capped at 2000 characters, so a big payload is many of them: about 190 KiB.
  const big = Object.fromEntries(Array.from({ length: 95 }, (_, i) => [`k${i}`, 'x'.repeat(1990)]));

  it('keeps every batch under maxBatchBytes', async () => {
    const server = fakeServer();
    const rec = connectRecorder('r', { deepLogging: { events: ['go'] } });
    start(server, memoryStore(), { maxBatchBytes: 1024 * 1024, flushMs: 10_000 });
    const h = function handle() {};
    for (let i = 0; i < 6; i++) rec.dispatch({ emitter: rec, eventName: 'go', handlers: [h], payload: big }, (inv) => inv(h, h));
    await uploader!.flush();
    const sizes = server.calls.mock.calls.map(([, init]) => new TextEncoder().encode(String((init as RequestInit).body)).byteLength);
    expect(sizes.every((n) => n <= 1024 * 1024)).toBe(true);
    expect(occurrences(server.received)).toHaveLength(6);
    expect(server.received.map((b) => b.seq)).toEqual([...sizes.keys()]);
  });

  it('sends an event too big on its own without its payload, as template-only', async () => {
    const server = fakeServer();
    const rec = connectRecorder('r', { deepLogging: { events: ['go'] } });
    start(server, memoryStore(), { maxBatchBytes: 64 * 1024 });
    const h = function handle() {};
    rec.dispatch({ emitter: rec, eventName: 'go', handlers: [h], payload: big }, (inv) => inv(h, h));
    await uploader!.flush();
    const [m] = occurrences(server.received) as Extract<IngestBatch['messages'][number], { type: 'occurrence' }>[];
    expect(m!.occurrence.capture).toBe('template');
    expect(m!.occurrence.payload).toBeUndefined();
    expect(statuses).toEqual([]);
  });

  it('splits a snapshot too big for one batch', async () => {
    const server = fakeServer();
    const rec = connectRecorder('r', { deepLogging: { events: ['go'] } });
    const h = function handle() {};
    for (let i = 0; i < 4; i++) rec.dispatch({ emitter: rec, eventName: 'go', handlers: [h], payload: big }, (inv) => inv(h, h));
    start(server, memoryStore(), { maxBatchBytes: 450 * 1024 });
    await uploader!.flush();
    const snaps = server.received.flatMap((b) => b.messages).filter((m) => m.type === 'snapshot') as Extract<IngestBatch['messages'][number], { type: 'snapshot' }>[];
    expect(snaps.length).toBeGreaterThan(1);
    expect(snaps.flatMap((m) => m.recording.occurrences).map((o) => o.payload !== undefined)).toEqual([true, true, true, true]);
  });
});

describe('offline', () => {
  it('spools while the server is down, says so, and uploads in order when it is back', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const rec = connectRecorder('r');
    start(server, store);

    server.state.mode = 'down';
    emit(rec, 'first');
    await uploader!.flush();
    expect(statuses).toEqual([expect.objectContaining({ state: 'offline', error: 'fetch failed', where: store.where })]);
    emit(rec, 'second');
    await uploader!.flush();
    expect((await store.list()).length).toBe(2);

    server.state.mode = 'up';
    emit(rec, 'third');
    await vi.advanceTimersByTimeAsync(1_000); // first backoff
    await uploader!.flush();
    expect(server.received.map((b) => b.seq)).toEqual([0, 1, 2]);
    expect(server.received.map((b) => !!b.spooled)).toEqual([true, true, true]);
    expect(statuses.at(-1)).toEqual({ state: 'recovered', uploaded: 3 });
    expect(await store.list()).toEqual([]);

    emit(rec, 'fourth');
    await uploader!.flush();
    expect(server.received.at(-1)).toMatchObject({ seq: 3 });
    expect(server.received.at(-1)!.spooled).toBeUndefined();
  });

  it('treats 5xx like an outage and keeps retrying', async () => {
    const server = fakeServer();
    const rec = connectRecorder('r');
    start(server);
    server.state.mode = 'busy';
    emit(rec);
    await uploader!.flush();
    expect(uploader!.status.state).toBe('offline');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(uploader!.status.state).toBe('offline');
    server.state.mode = 'up';
    await vi.advanceTimersByTimeAsync(2_000); // second, longer backoff
    expect(uploader!.status).toEqual({ state: 'recovered', uploaded: 1 });
  });

  it('drops a batch the server refuses for good instead of spooling it', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const rec = connectRecorder('r');
    start(server, store);
    server.state.mode = 'refuse';
    emit(rec);
    await uploader!.flush();
    expect(statuses).toEqual([{ state: 'rejected', status: 401, error: 'unknown or revoked project key' }]);
    expect(await store.list()).toEqual([]);
  });

  it('writes to the console when the connection drops and recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = fakeServer();
    const rec = connectRecorder('r');
    start(server, memoryStore(), { quiet: false });
    server.state.mode = 'down';
    emit(rec);
    await uploader!.flush();
    expect(warn.mock.calls[0]![0]).toMatch(/can't reach https:\/\/api\.test\/ .*kept in memory/);
    server.state.mode = 'up';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(info.mock.calls[0]![0]).toMatch(/reconnected .* uploaded 1 batch recorded while offline/);
    warn.mockRestore();
    info.mockRestore();
  });

  it('delivers what an earlier run left in the spool', async () => {
    const store = memoryStore();
    const old = new Spool(store);
    await old.push({ recorderKey: 'r', sessionId: '00000000-0000-4000-8000-000000000000', startedAt: 1, seq: 9, messages: [] });
    const server = fakeServer();
    start(server, store);
    await vi.advanceTimersByTimeAsync(0);
    await uploader!.flush();
    expect(server.received).toMatchObject([{ seq: 9, spooled: true }]);
    expect(statuses).toEqual([{ state: 'recovered', uploaded: 1 }]);
  });
});

describe('spool', () => {
  const batch = (seq: number, n: number): IngestBatch => ({
    recorderKey: 'r', sessionId: 's', startedAt: 0, seq,
    messages: Array.from({ length: n }, (_, i) => ({ type: 'occurrence', occurrence: { id: `e${i}`, ts: seq * 100 + i } as never, template: {} as never, nodes: [], processes: [] })),
  });

  it('turns the oldest batches into gap stubs when full', async () => {
    const spool = new Spool(memoryStore(), 600);
    await spool.push(batch(0, 3));
    await spool.push(batch(1, 3));
    await spool.push(batch(2, 3));
    const first = await spool.peek();
    expect(first).toMatchObject({ seq: 0, messages: [], gap: { fromTs: 0, toTs: 2, dropped: 3 } });
    await spool.shift();
    // The newest batch is always kept whole.
    await spool.shift();
    expect((await spool.peek())!.messages).toHaveLength(3);
  });

  it('keeps batches in files across restarts', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'eda-spool-'));
    try {
      await new Spool(fileStore(dir)).push(batch(0, 1));
      await new Spool(fileStore(dir)).push(batch(1, 1));
      expect(await readdir(dir)).toHaveLength(2);
      const again = new Spool(fileStore(dir));
      expect((await again.peek())!.seq).toBe(0);
      await again.shift();
      expect((await again.peek())!.seq).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps batches in IndexedDB across restarts', async () => {
    vi.useRealTimers();
    await new Spool(indexedDbStore('test-spool')).push(batch(0, 1));
    await new Spool(indexedDbStore('test-spool')).push(batch(1, 1));
    const again = new Spool(indexedDbStore('test-spool'));
    expect(await again.size()).toBe(2);
    expect((await again.peek())!.seq).toBe(0);
  });
});

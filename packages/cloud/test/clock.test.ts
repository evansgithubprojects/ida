import { afterEach, describe, expect, it } from 'vitest';
import { connectRecorder, type IngestBatch, type Recorder } from '@ida-dev/core';
import { resetRecorders } from '../../core/src/registry';
import { memoryStore } from '../src/spool';
import { clockSample, createUploader, type Uploader } from '../src/uploader';

describe('clockSample', () => {
  it('finds the offset and error from the four timestamps', () => {
    // Server 1000 ms ahead; 40 ms each way on the network; 5 ms of server work.
    const t0 = 0, t1 = 1040, t2 = 1045, t3 = 85;
    expect(clockSample(t0, t1, t2, t3)).toEqual({ offsetMs: 1000, errorMs: 40 });
  });

  it('bounds the error when the network is lopsided', () => {
    // True offset 1000; 10 ms out, 70 ms back. The estimate is off by 30, within the 40 ms error.
    const s = clockSample(0, 1010, 1010, 80)!;
    expect(Math.abs(s.offsetMs - 1000)).toBeLessThanOrEqual(s.errorMs);
  });

  it('rejects impossible timings', () => {
    expect(clockSample(0, 10, 20, 5)).toBeUndefined(); // the server took longer than the whole request
    expect(clockSample(0, NaN, 20, 30)).toBeUndefined(); // a server that didn't send its times
  });
});

let uploader: Uploader | undefined;
afterEach(async () => {
  await uploader?.close();
  uploader = undefined;
  resetRecorders();
});

const emit = (rec: Recorder) => {
  const h = function handle() {};
  rec.dispatch({ emitter: rec, eventName: 'go', handlers: [h], payload: {} }, (inv) => inv(h, h));
};

describe('uploader clock', () => {
  it('times each request and sends its best estimate with the next batch', async () => {
    const SERVER_AHEAD = 5_000;
    const received: IngestBatch[] = [];
    const delays = [30, 4, 20]; // network ms each way, per request
    const rec = connectRecorder('svc');
    const fetch = (async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(String(init.body)) as IngestBatch;
      received.push(batch);
      const delay = delays[received.length - 1] ?? 10;
      await new Promise((r) => setTimeout(r, delay)); // out
      const receivedAt = rec.wallTime() + SERVER_AHEAD;
      await new Promise((r) => setTimeout(r, delay)); // back
      return new Response(JSON.stringify({ ok: true, receivedAt, repliedAt: receivedAt }), { status: 200 });
    }) as typeof globalThis.fetch;
    uploader = createUploader({ projectKey: 'ida_key', endpoint: 'https://api.test', fetch, flushMs: 1, spool: memoryStore(), quiet: true }, () => null, 'test');

    for (let i = 0; i < 4; i++) {
      emit(rec);
      await uploader.flush();
    }
    expect(received[0]!.clock).toBeUndefined(); // nothing measured yet
    expect(received[0]!.sentAt).toBeTypeOf('number');
    // From then on the best sample so far: the second request had the least delay.
    for (const b of received.slice(1)) expect(Math.abs(b.clock!.offsetMs - SERVER_AHEAD)).toBeLessThanOrEqual(b.clock!.errorMs + 2);
    expect(received[3]!.clock!.errorMs).toBeLessThan(received[1]!.clock!.errorMs);
  });

  it('still uploads when the server sends no times', async () => {
    const received: IngestBatch[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      received.push(JSON.parse(String(init.body)));
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    const rec = connectRecorder('svc');
    uploader = createUploader({ projectKey: 'ida_key', endpoint: 'https://api.test', fetch, flushMs: 1, spool: memoryStore(), quiet: true }, () => null, 'test');
    emit(rec);
    await uploader.flush();
    emit(rec);
    await uploader.flush();
    expect(received).toHaveLength(2);
    expect(received[1]!.clock).toBeUndefined();
  });
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { AsyncStorageContext, defaultContext, SyncStackContext } from '../src/causality';
import { createRecorder } from '../src/recorder';
import type { Frame } from '../src/recorder';
import type { Occurrence, RecorderMessage } from '../src/types';

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const rec = createRecorder({ context: new AsyncStorageContext<Frame>(new AsyncLocalStorage()) });
  const bus = {};
  const messages: RecorderMessage[] = [];
  rec.subscribe((m) => messages.push(m));
  const emit = (eventName: string, handlers: Function[]) =>
    rec.dispatch({ emitter: bus, eventName, handlers, payload: {} }, (inv) => handlers.map((h) => inv(h, () => h())));
  const byName = (name: string) => rec.export().occurrences.find((o) => rec.export().templates.find((t) => t.id === o.templateId)!.eventName === name)!;
  return { rec, emit, messages, byName };
}

describe('default context', () => {
  it('follows async hops in Node', () => {
    expect(defaultContext()).toBeInstanceOf(AsyncStorageContext);
  });

  it('falls back to the sync stack without AsyncLocalStorage', () => {
    const g = globalThis as { process?: unknown };
    const real = g.process;
    g.process = undefined;
    try {
      expect(defaultContext()).toBeInstanceOf(SyncStackContext);
    } finally {
      g.process = real;
    }
  });
});

describe('async causality', () => {
  it('links an emit after await to the event being handled, as inferred', async () => {
    const { emit, byName } = setup();
    const charge = async function charge() {
      emit('charged-sync', []);
      await tick();
      emit('charged-later', []);
    };
    await Promise.all(emit('order', [charge]) as Promise<void>[]);
    const order = byName('order');
    expect(byName('charged-sync')).toMatchObject({ parentId: order.id, causality: 'sync' });
    expect(byName('charged-later')).toMatchObject({ parentId: order.id, causality: 'inferred' });
  });

  it('follows timers', async () => {
    const { emit, byName } = setup();
    let fired!: () => void;
    const done = new Promise<void>((r) => (fired = r));
    const later = function later() { setTimeout(() => { emit('timeout', []); fired(); }, 1); };
    emit('start', [later]);
    await done;
    expect(byName('timeout')).toMatchObject({ parentId: byName('start').id, causality: 'inferred' });
  });

  it('keeps unrelated work out of a chain', async () => {
    const { emit, byName } = setup();
    emit('first', [function noop() {}]);
    await tick();
    emit('second', []);
    expect(byName('second')).toMatchObject({ parentId: null, causality: 'sync' });
  });
});

describe('async handlers', () => {
  it('times a handler until its promise settles, and sends the occurrence again then', async () => {
    const { emit, messages, byName } = setup();
    const slow = async function slow() { await new Promise((r) => setTimeout(r, 30)); };
    const out = emit('job', [slow]) as Promise<void>[];
    const first = messages.filter((m) => m.type === 'occurrence');
    expect(first).toHaveLength(1);
    await Promise.all(out);
    const sent = messages.filter((m): m is Extract<RecorderMessage, { type: 'occurrence' }> => m.type === 'occurrence');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.occurrence.id).toBe(sent[0]!.occurrence.id);
    const job = byName('job');
    expect(job.handlerResults[0]!.durationMs).toBeGreaterThanOrEqual(25);
    expect(job.durationMs).toBeGreaterThanOrEqual(25);
  });

  it('records a rejection and still rejects for the caller', async () => {
    const { emit, byName } = setup();
    const boom = async function boom() { await tick(); throw new Error('card declined'); };
    const [p] = emit('pay', [boom]) as Promise<void>[];
    await expect(p).rejects.toThrow('card declined');
    expect(byName('pay').handlerResults[0]!.error).toMatchObject({ message: 'card declined' });
  });

  it('leaves a rejection nobody handles unhandled', async () => {
    const { emit } = setup();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      emit('pay', [async function boom() { throw new Error('nobody caught me'); }]);
      await tick();
      await tick();
      expect(unhandled).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('leaves synchronous handlers as they were', () => {
    const { emit, messages, byName } = setup();
    expect(emit('sync', [function plain() { return 1; }])).toEqual([1]);
    expect(messages.filter((m) => m.type === 'occurrence')).toHaveLength(1);
    expect((byName('sync') as Occurrence).handlerResults).toHaveLength(1);
  });
});

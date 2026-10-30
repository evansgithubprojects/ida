import { afterEach, describe, expect, it } from 'vitest';
import { connectRecorder, createRecorder, dispatchAll, enable, getDefaultRecorder, getRecorder, getRecorders, onRecorder, recordersFor, setDefaultRecorder } from '../src';
import { resetRecorders } from '../src/registry';

afterEach(() => {
  resetRecorders();
  setDefaultRecorder(null);
});

describe('keyed recorders', () => {
  it('returns the same recorder for the same key, created with the first options', () => {
    const a = connectRecorder('payments', { windowMs: 1000 });
    expect(connectRecorder('payments')).toBe(a);
    expect(a.key).toBe('payments');
    expect(connectRecorder('cart')).not.toBe(a);
    expect(getRecorders().map((r) => r.key)).toEqual(['payments', 'cart']);
  });

  it('rejects keys that cannot name a recorder', () => {
    for (const bad of ['', ' payments', 'a/b', 'x'.repeat(65), '-lead']) expect(() => connectRecorder(bad)).toThrow(TypeError);
  });

  it('tells listeners about existing recorders, then new ones', () => {
    connectRecorder('one');
    const seen: string[] = [];
    const stop = onRecorder((r) => seen.push(r.key));
    connectRecorder('two');
    connectRecorder('one');
    stop();
    connectRecorder('three');
    expect(seen).toEqual(['one', 'two']);
  });

  it('enable() is the default keyed recorder', () => {
    const shared = enable();
    expect(shared.key).toBe('default');
    expect(connectRecorder('default')).toBe(shared);
    expect(getRecorder()).toBe(shared);
    expect(getDefaultRecorder()).toBe(shared);
  });
});

describe('routing', () => {
  const emitter = {};

  it('sends an emitter to the recorders that track it, else the default, else nowhere', () => {
    expect(recordersFor(emitter)).toEqual([]);
    const fallback = enable();
    expect(recordersFor(emitter)).toEqual([fallback]);
    const payments = connectRecorder('payments');
    payments.track(emitter);
    expect(recordersFor(emitter)).toEqual([payments]);
    payments.untrack(emitter);
    expect(recordersFor(emitter)).toEqual([fallback]);
  });

  it('skips recorders that are stopped', () => {
    const r = connectRecorder('r');
    r.track(emitter);
    r.stop();
    expect(recordersFor(emitter)).toEqual([]);
    r.untrack(emitter);
  });

  it('records one emit in several recorders while running each handler once', () => {
    const a = createRecorder({ key: 'a' });
    const b = createRecorder({ key: 'b' });
    const calls: string[] = [];
    const h = function handle() { calls.push('h'); };
    const result = dispatchAll([a, b], { emitter, eventName: 'go', handlers: [h], payload: 1 }, (invoke) => {
      invoke(h, h);
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toEqual(['h']);
    for (const r of [a, b]) {
      const out = r.export();
      expect(out.occurrences).toHaveLength(1);
      expect(out.occurrences[0]!.handlerResults).toHaveLength(1);
    }
  });

  it('records a handler error in every recorder and still throws it once', () => {
    const a = createRecorder({ key: 'a' });
    const b = createRecorder({ key: 'b' });
    const h = function boom() { throw new Error('nope'); };
    expect(() => dispatchAll([a, b], { emitter, eventName: 'go', handlers: [h], payload: 1 }, (invoke) => invoke(h, h))).toThrow('nope');
    for (const r of [a, b]) expect(r.export().occurrences[0]!.handlerResults[0]!.error).toMatchObject({ message: 'nope' });
  });

  it('just runs when no recorder wants the emit', () => {
    expect(dispatchAll([], { emitter, eventName: 'go', handlers: [], payload: 1 }, () => 'ran')).toBe('ran');
  });
});

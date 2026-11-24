import { describe, expect, it } from 'vitest';
import { createRecorder } from '@eda-debugger/core';
import { buildIndex, notifications, parseThrowId, recipientsOf, throwId } from '../src/replay';
import { extendTrail } from '../src/store';

/** A baseline of clean orders, then one bad payload with no error and one inside a handler that throws. */
function record() {
  let t = 0;
  const rec = createRecorder({ deepLogging: { events: ['order'] }, now: () => (t += 1) });
  const bus = {};
  const api = function ledgerApi() {};
  rec.markExternal(api);
  const audit = function audit() {};
  const send = (payload: unknown, handlers: Function[] = [api, audit]) =>
    rec.dispatch({ emitter: bus, label: 'Shop', eventName: 'order', handlers, payload }, (invoke) => handlers.forEach((h) => invoke(h, () => h(payload))));
  for (let i = 0; i < 6; i++) send({ id: `o${100 + i}`, total: i + 1 });
  send({ id: 'o200', total: 'free' }); // no error thrown
  const failing = function failing() {
    send({ id: 'o201', total: undefined });
    throw new Error('boom');
  };
  try { rec.dispatch({ emitter: bus, label: 'Shop', eventName: 'go', handlers: [failing], payload: undefined }, (invoke) => invoke(failing, () => failing())); } catch { /* expected */ }
  return buildIndex(rec.export());
}

describe('notifications', () => {
  const index = record();
  const list = notifications(index, index.items);

  it('lists the finding with no error first, then the rest by severity', () => {
    expect(list[0]).toMatchObject({ kind: 'finding', unattributed: true, external: true });
    expect(list.map((n) => n.kind)).toContain('throw');
    expect(list.filter((n) => n.unattributed)).toHaveLength(1);
  });

  it('links findings to the throw that sent them', () => {
    const thrown = list.find((n) => n.kind === 'throw')!;
    const tainted = index.findingsBySource.get(thrown.id) ?? [];
    expect(tainted).toHaveLength(1);
    expect(tainted[0]!.taintSource).not.toBeNull();
    expect(thrown.external).toBe(true);
    expect(thrown.id).toBe(throwId(thrown.occurrenceId, tainted[0]!.taintSource!.handlerId));
  });

  it('parses throw ids back, even when the occurrence id contains the separator', () => {
    const thrown = list.find((n) => n.kind === 'throw')!;
    expect(parseThrowId(index, thrown.id)).toEqual({ occurrenceId: thrown.occurrenceId, handlerId: expect.any(String) });
    expect(parseThrowId(index, 'nope|h')).toBeNull();
  });

  it('puts external recipients first', () => {
    const recipients = recipientsOf(index, [...index.findingsById.values()]);
    expect(recipients[0]).toMatchObject({ external: true });
    expect(recipients.some((r) => !r.external)).toBe(true);
    expect(recipients.map((r) => r.external)).toEqual([...recipients.map((r) => r.external)].sort((a, b) => Number(b) - Number(a)));
  });
});

describe('inspection trail', () => {
  it('keeps throws and findings as separate steps and goes back to them', () => {
    const a = { type: 'throw', id: 'x|h' } as const;
    const b = { type: 'finding', id: 'f1' } as const;
    expect(extendTrail(extendTrail([a], b), a)).toEqual([a]);
    expect(extendTrail([a], { type: 'finding', id: 'x|h' })).toHaveLength(2);
  });
});

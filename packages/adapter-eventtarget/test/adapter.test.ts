import { afterEach, describe, expect, it } from 'vitest';
import { createRecorder } from '@eda-debugger/core';
import { enableEventTargetRecording } from '../src';

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

const names = (rec: ReturnType<typeof createRecorder>) => {
  const r = rec.export();
  return r.occurrences.map((o) => r.templates.find((t) => t.id === o.templateId)!.eventName);
};

describe('dom adapter', () => {
  it('records dispatchEvent with its handler and keeps listener semantics', () => {
    const rec = createRecorder();
    uninstall = enableEventTargetRecording(rec);
    const el = document.createElement('button');
    el.id = 'save';
    const calls: string[] = [];
    el.addEventListener('ping', () => calls.push('a'));
    el.addEventListener('ping', { handleEvent: () => calls.push('b') });
    el.addEventListener('ping', () => calls.push('once'), { once: true });
    expect(el.dispatchEvent(new CustomEvent('ping', { detail: { n: 1 } }))).toBe(true);
    el.dispatchEvent(new CustomEvent('ping'));
    expect(calls).toEqual(['a', 'b', 'once', 'a', 'b']);
    const r = rec.export();
    expect(r.processes.map((p) => p.label)).toEqual(['button#save']);
    expect(r.occurrences).toHaveLength(2);
    expect(r.occurrences[0]!.handlerResults).toHaveLength(3);
  });

  it('honours removeEventListener and de-duplicates identical registrations', () => {
    const rec = createRecorder();
    uninstall = enableEventTargetRecording(rec);
    const el = document.createElement('div');
    let n = 0;
    const h = () => n++;
    el.addEventListener('x', h);
    el.addEventListener('x', h);
    el.dispatchEvent(new Event('x'));
    expect(n).toBe(1);
    el.removeEventListener('x', h);
    el.dispatchEvent(new Event('x'));
    expect(n).toBe(1);
    const last = rec.export().templates.at(-1)!;
    expect(last.handlerIds).toEqual([]);
  });

  it('nests events dispatched from inside handlers', () => {
    const rec = createRecorder();
    uninstall = enableEventTargetRecording(rec);
    const a = document.createElement('div');
    const b = document.createElement('span');
    b.addEventListener('inner', function onInner() {});
    a.addEventListener('outer', function onOuter() { b.dispatchEvent(new Event('inner')); });
    a.dispatchEvent(new Event('outer'));
    const r = rec.export();
    expect(names(rec)).toEqual(['outer', 'inner']);
    expect(r.occurrences[1]!.parentId).toBe(r.occurrences[0]!.id);
  });

  it('creates one root occurrence per native event, shared by all its listeners', () => {
    const rec = createRecorder();
    uninstall = enableEventTargetRecording(rec);
    const el = document.createElement('button');
    document.body.append(el);
    let seen = 0;
    el.addEventListener('click', () => seen++);
    document.addEventListener('click', () => seen++);
    // click() dispatches natively (not through the patched dispatchEvent) and bubbles to document.
    el.click();
    expect(seen).toBe(2);
    const r = rec.export();
    expect(r.occurrences.map((o) => o.parentId)).toEqual([null, null]);
    expect(r.processes.map((p) => p.label).sort()).toEqual(['button', 'document']);
    el.remove();
  });

  it('records handler errors without changing behavior, and uninstall restores the prototype', () => {
    const original = EventTarget.prototype.addEventListener;
    const rec = createRecorder();
    const un = enableEventTargetRecording(rec);
    expect(EventTarget.prototype.addEventListener).not.toBe(original);
    // The platform reports an uncaught listener error to the window; that is expected here.
    window.addEventListener('error', (e) => e.preventDefault(), { once: true });
    const el = document.createElement('div');
    el.addEventListener('x', function bad() { throw new Error('boom'); });
    el.addEventListener('x', function after() {});
    el.dispatchEvent(new Event('x')); // jsdom reports listener errors to the window and carries on
    expect(rec.export().occurrences[0]!.handlerResults.map((h) => !!h.error)).toEqual([true, false]);
    un();
    expect(EventTarget.prototype.addEventListener).toBe(original);
  });
});

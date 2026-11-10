import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRecorder, createRecorder, enable, setDefaultRecorder } from '@ida/core';
import { resetRecorders } from '../../core/src/registry';
import { enableEventEmitterRecording } from '../src';

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

describe('node adapter', () => {
  it('records the parent chain across emitters', () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    const a = new EventEmitter();
    const b = new EventEmitter();
    rec.labelEmitter(a, 'A');
    rec.labelEmitter(b, 'B');
    b.on('leaf', function onLeaf() {});
    a.on('root', function onRoot() { b.emit('leaf', 1); });
    a.emit('root', { x: 1 });
    const r = rec.export();
    expect(r.occurrences.map((o) => r.templates.find((t) => t.id === o.templateId)!.eventName)).toEqual(['root', 'leaf']);
    expect(r.occurrences[1]!.parentId).toBe(r.occurrences[0]!.id);
  });

  it('keeps emit semantics: order, return value, once, and error propagation', () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    const e = new EventEmitter();
    const order: number[] = [];
    e.on('x', () => order.push(1));
    e.once('x', () => order.push(2));
    e.on('x', () => order.push(3));
    expect(e.emit('x')).toBe(true);
    expect(e.emit('x')).toBe(true);
    expect(order).toEqual([1, 2, 3, 1, 3]);
    expect(e.emit('nobody')).toBe(false);
    expect(() => e.emit('error', new Error('unhandled'))).toThrow('unhandled');
    e.on('bad', () => { throw new Error('in handler'); });
    expect(() => e.emit('bad')).toThrow('in handler');
    const bad = rec.export().occurrences.find((o) => o.handlerResults.some((h) => h.error));
    expect(bad).toBeDefined();
  });

  it('uninstall restores the original emit', () => {
    const original = EventEmitter.prototype.emit;
    const un = enableEventEmitterRecording(createRecorder());
    expect(EventEmitter.prototype.emit).not.toBe(original);
    un();
    expect(EventEmitter.prototype.emit).toBe(original);
  });

  it('ignores Node internals such as streams by default', async () => {
    const { PassThrough } = await import('node:stream');
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    const s = new PassThrough();
    s.on('data', () => {});
    s.write('hi');
    expect(rec.export().occurrences).toHaveLength(0);
  });

  it('ignores the connection pools behind fetch, so an uploader never records its own uploads', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    const { port } = server.address() as { port: number };
    await (await fetch(`http://127.0.0.1:${port}`)).text();
    // An aborted request emits on undici's per-request `Fetch` emitter, which no blocklist names.
    const ac = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/slow`, { signal: ac.signal }).catch(() => {});
    ac.abort();
    await pending;
    await new Promise<void>((r) => server.close(() => r()));
    expect(rec.export().processes.map((p) => p.label)).toEqual([]);
  });
});

describe('routed by tracking', () => {
  afterEach(() => {
    resetRecorders();
    setDefaultRecorder(null);
  });

  const names = (r: ReturnType<typeof createRecorder>) => {
    const out = r.export();
    return out.occurrences.map((o) => out.templates.find((t) => t.id === o.templateId)!.eventName);
  };

  it('records each emitter in the recorder that tracks it and the rest in the default one', () => {
    uninstall = enableEventEmitterRecording();
    const shared = enable();
    const payments = connectRecorder('payments');
    const bus = new EventEmitter();
    const other = new EventEmitter();
    payments.track(bus);
    bus.on('charge', () => {});
    other.on('ping', () => {});
    bus.emit('charge', 1);
    other.emit('ping');
    expect(names(payments)).toEqual(['charge']);
    expect(names(shared)).toEqual(['ping']);
  });

  it('records nothing for untracked emitters without a default recorder', () => {
    uninstall = enableEventEmitterRecording();
    const payments = connectRecorder('payments');
    const e = new EventEmitter();
    let ran = 0;
    e.on('x', () => ran++);
    e.emit('x');
    expect(ran).toBe(1);
    expect(payments.export().occurrences).toHaveLength(0);
  });

  it('runs listeners once when two recorders track the same emitter', () => {
    uninstall = enableEventEmitterRecording();
    const a = connectRecorder('a');
    const b = connectRecorder('b');
    const e = new EventEmitter();
    a.track(e);
    b.track(e);
    let ran = 0;
    e.on('x', () => ran++);
    expect(e.emit('x')).toBe(true);
    expect(ran).toBe(1);
    expect(names(a)).toEqual(['x']);
    expect(names(b)).toEqual(['x']);
  });
});

const lib = createRequire(import.meta.url)('./fixtures/node_modules/fake-lib') as {
  LibClient: new () => EventEmitter & { tick(): void };
  makeBus: () => EventEmitter;
};
const eventNames = (rec: ReturnType<typeof createRecorder>) => {
  const r = rec.export();
  return r.occurrences.map((o) => r.templates.find((t) => t.id === o.templateId)!.eventName);
};

describe('which emitters are recorded', () => {
  it("records the app's own emitters", () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    class Bus extends EventEmitter {}
    new Bus().emit('a');
    new EventEmitter().emit('b');
    expect(eventNames(rec)).toEqual(['a', 'b']);
  });

  it('skips emitters a package created when only the package listens', () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    new lib.LibClient().tick();
    lib.makeBus().emit('ping');
    expect(eventNames(rec)).toEqual([]);
  });

  it("records a package's events that app code listens to", () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    const client = new lib.LibClient();
    client.on('tick', function appOnTick() {});
    const bus = lib.makeBus();
    bus.once('ping', function appOnPing() {});
    client.tick();
    bus.emit('ping');
    bus.emit('other');
    expect(eventNames(rec)).toEqual(['tick', 'ping']);
  });

  it("records an app subclass of a package's emitter", () => {
    const rec = createRecorder();
    uninstall = enableEventEmitterRecording(rec);
    class MyClient extends lib.LibClient {}
    new MyClient().tick();
    expect(eventNames(rec)).toEqual(['tick']);
  });

  it('records package emitters when asked: tracked, includeLibraries, or isAppFile', () => {
    const rec = createRecorder();
    setDefaultRecorder(rec);
    try {
      uninstall = enableEventEmitterRecording();
      const tracked = new lib.LibClient();
      connectRecorder('lib-tracker').track(tracked);
      tracked.tick();
      expect(eventNames(connectRecorder('lib-tracker'))).toEqual(['tick']);
      uninstall();

      const all = createRecorder();
      uninstall = enableEventEmitterRecording(all, { includeLibraries: true });
      new lib.LibClient().tick();
      expect(eventNames(all)).toEqual(['tick']);
      uninstall();

      const mine = createRecorder();
      uninstall = enableEventEmitterRecording(mine, { isAppFile: () => true });
      new lib.LibClient().tick();
      expect(eventNames(mine)).toEqual(['tick']);
    } finally {
      setDefaultRecorder(null);
      resetRecorders();
    }
  });

  it('restores EventEmitter.init and the listener methods on uninstall', () => {
    const init = (EventEmitter as unknown as { init: unknown }).init;
    const { on, once, addListener, prependListener, prependOnceListener } = EventEmitter.prototype;
    enableEventEmitterRecording(createRecorder())();
    expect((EventEmitter as unknown as { init: unknown }).init).toBe(init);
    expect(EventEmitter.prototype).toMatchObject({ on, once, addListener, prependListener, prependOnceListener });
  });
});

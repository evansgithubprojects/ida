import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRecorder, PARENT_HEADER, setDefaultRecorder } from '@ida-dev/core';
import { resetRecorders } from '../../core/src/registry';
import { decodeContent, enableAmqplibRecording, vhostOf, type Uninstall } from '../src/index';

type Msg = { content: Buffer; fields: { exchange: string; routingKey: string; deliveryTag: number; redelivered: boolean }; properties: { headers?: Record<string, unknown> } };

/**
 * A stand-in for amqplib, shaped like it: ConfirmChannel extends Channel and calls its publish, sendToQueue goes
 * through publish, and the promise and callback modules both have `connect`. Messages go straight to consumers.
 */
function fakeAmqp() {
  const consumers = new Map<string, ((m: Msg | null) => unknown)[]>();
  const bindings = new Map<string, string[]>(); // exchange -> queues
  const sent: { exchange: string; routingKey: string; options?: { headers?: Record<string, unknown> } }[] = [];
  let tag = 0;
  const route = (exchange: string, routingKey: string) => (exchange === '' ? [routingKey] : bindings.get(exchange) ?? []);

  class Channel {
    publish(exchange: string, routingKey: string, content: Buffer, options?: { headers?: Record<string, unknown> }) {
      sent.push({ exchange, routingKey, options });
      for (const q of route(exchange, routingKey)) {
        for (const fn of consumers.get(q) ?? []) {
          fn({ content, fields: { exchange, routingKey, deliveryTag: ++tag, redelivered: false }, properties: { headers: options?.headers } });
        }
      }
      return true;
    }
    sendToQueue(queue: string, content: Buffer, options?: { headers?: Record<string, unknown> }) {
      return this.publish('', queue, content, options);
    }
    consume(queue: string, fn: (m: Msg | null) => unknown) {
      consumers.set(queue, [...(consumers.get(queue) ?? []), fn]);
      return Promise.resolve({ consumerTag: `c${consumers.size}` });
    }
    bindQueue(queue: string, exchange: string) {
      bindings.set(exchange, [...(bindings.get(exchange) ?? []), queue]);
    }
  }
  class ConfirmChannel extends Channel {
    override publish(exchange: string, routingKey: string, content: Buffer, options?: { headers?: Record<string, unknown> }, cb?: () => void) {
      const ok = super.publish(exchange, routingKey, content, options);
      cb?.();
      return ok;
    }
  }
  class ChannelModel {
    createChannel() { return Promise.resolve(new Channel()); }
    createConfirmChannel() { return Promise.resolve(new ConfirmChannel()); }
  }
  class CallbackModel {
    createChannel(cb: (err: unknown, ch: Channel) => void) { const ch = new Channel(); setTimeout(() => cb(null, ch)); return ch; }
  }
  const promiseApi = { connect: (_url?: unknown) => Promise.resolve(new ChannelModel()) };
  const callbackApi = { connect: (_url: unknown, cb: (err: unknown, conn: CallbackModel) => void) => setTimeout(() => cb(null, new CallbackModel())) };
  return { promiseApi, callbackApi, Channel, ConfirmChannel, sent, cancel: (q: string) => consumers.get(q)?.forEach((fn) => fn(null)) };
}

let uninstall: Uninstall | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  resetRecorders();
  setDefaultRecorder(null);
});

const json = (v: unknown) => Buffer.from(JSON.stringify(v));

async function service(amqp: ReturnType<typeof fakeAmqp>, key: string, url = 'amqp://localhost') {
  const rec = connectRecorder(key);
  const conn = await amqp.promiseApi.connect(url);
  rec.track(conn);
  return { rec, conn };
}

describe('amqplib adapter', () => {
  it('links a publish in one service to its consumer in another', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const orders = await service(amqp, 'orders');
    const mailer = await service(amqp, 'mailer');

    const inbox = await mailer.conn.createChannel();
    inbox.bindQueue('emails', 'notifications');
    const sendEmail = vi.fn(function sendEmail(_m: Msg | null) {});
    mailer.rec.labelHandler(sendEmail, 'sendEmail');
    await inbox.consume('emails', sendEmail);

    const out = await orders.conn.createChannel();
    const notify = function notify() { out.publish('notifications', 'order.paid', json({ orderId: 'o-1' })); };
    orders.rec.labelHandler(notify, 'notify');
    orders.rec.dispatch({ emitter: {}, eventName: 'paid', handlers: [notify], payload: {} }, (inv) => inv(notify, notify));

    const pub = orders.rec.export();
    const publish = pub.occurrences[1]!;
    expect(publish).toMatchObject({
      sourceNodeId: pub.nodes.find((n) => n.label === 'notify')!.id, causality: 'sync',
      meta: { exchange: 'notifications', routingKey: 'order.paid' },
    });
    expect(pub.processes.find((p) => p.id === 'rabbitmq:/:exchange:notifications')).toMatchObject({ kind: 'exchange', broker: { type: 'rabbitmq', cluster: '/' } });

    expect(sendEmail).toHaveBeenCalledOnce();
    const got = mailer.rec.export();
    expect(got.occurrences).toHaveLength(1);
    expect(got.occurrences[0]).toMatchObject({
      causality: 'propagated', remoteParent: { sessionId: orders.rec.sessionId, occurrenceId: publish.id },
      meta: { exchange: 'notifications', routingKey: 'order.paid', queue: 'emails', deliveryTag: 1, redelivered: false },
      handlerResults: [{ handlerId: got.nodes.find((n) => n.label === 'sendEmail')!.id }],
    });
    expect(got.processes.map((p) => p.id)).toEqual(['rabbitmq:/:queue:emails']);
    expect(got.templates[0]!.payloadShape).toBe('{orderId:string}');
  });

  it('records sendToQueue and confirm channels once each', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const { rec, conn } = await service(amqp, 'svc');
    const ch = await conn.createConfirmChannel();
    const confirmed = vi.fn();
    ch.publish('x', 'k', json({}), {}, confirmed);
    ch.sendToQueue('jobs', json({}));
    (await conn.createChannel()).sendToQueue('jobs', json({}));
    expect(confirmed).toHaveBeenCalledOnce();
    const occ = rec.export().occurrences;
    expect(occ).toHaveLength(3);
    expect(occ.map((o) => o.meta)).toEqual([
      { exchange: 'x', routingKey: 'k' }, { exchange: '', routingKey: 'jobs' }, { exchange: '', routingKey: 'jobs' },
    ]);
    expect(rec.export().processes.map((p) => p.label).sort()).toEqual(['(default exchange)', 'x']);
  });

  it('adds the header without touching the caller’s options', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const { conn } = await service(amqp, 'svc');
    const options = { headers: { trace: 'abc' }, persistent: true };
    (await conn.createChannel()).publish('x', 'k', json({}), options);
    expect(options).toEqual({ headers: { trace: 'abc' }, persistent: true });
    expect(amqp.sent[0]!.options).toMatchObject({ persistent: true, headers: { trace: 'abc', [PARENT_HEADER]: expect.any(String) } });
  });

  it('uses the vhost from the connection URL', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const { rec, conn } = await service(amqp, 'svc', 'amqp://u:p@host:5672/shop%2Fprod');
    (await conn.createChannel()).publish('x', 'k', json({}));
    expect(rec.export().processes[0]!.id).toBe('rabbitmq:shop/prod:exchange:x');
  });

  it('works with the callback API', async () => {
    const amqp = fakeAmqp();
    const rec = connectRecorder('svc');
    setDefaultRecorder(rec);
    uninstall = enableAmqplibRecording(amqp.callbackApi);
    await new Promise<void>((done) => amqp.callbackApi.connect('amqp://h', (_e, conn) => {
      conn.createChannel((_err, ch) => { ch.sendToQueue('jobs', json({})); done(); });
    }));
    expect(rec.export().occurrences).toHaveLength(1);
  });

  it('records a consumer that throws, and the error still reaches amqplib', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const { rec, conn } = await service(amqp, 'svc');
    const ch = await conn.createChannel();
    await ch.consume('jobs', function failing() { throw new Error('bad job'); });
    expect(() => ch.sendToQueue('jobs', json({}))).toThrow('bad job');
    const consumed = rec.export().occurrences.find((o) => o.handlerResults.length)!;
    expect(consumed.handlerResults[0]!.error).toMatchObject({ message: 'bad job' });
  });

  it('passes a cancelled consumer’s null straight through', async () => {
    const amqp = fakeAmqp();
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const { rec, conn } = await service(amqp, 'svc');
    const onMessage = vi.fn();
    await (await conn.createChannel()).consume('jobs', onMessage);
    amqp.cancel('jobs');
    expect(onMessage).toHaveBeenCalledWith(null);
    expect(rec.export().occurrences).toHaveLength(0);
  });

  it('warns once and still publishes when nothing is recording', async () => {
    const amqp = fakeAmqp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    uninstall = enableAmqplibRecording(amqp.promiseApi);
    const ch = await (await amqp.promiseApi.connect()).createChannel();
    ch.publish('x', 'k', json({}));
    ch.publish('x', 'k', json({}));
    expect(amqp.sent).toHaveLength(2);
    expect(amqp.sent[0]!.options?.headers).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('restores amqplib on uninstall', async () => {
    const amqp = fakeAmqp();
    const { connect } = amqp.promiseApi;
    const { publish } = amqp.Channel.prototype;
    const undo = enableAmqplibRecording(amqp.promiseApi);
    await (await amqp.promiseApi.connect()).createChannel();
    expect(amqp.Channel.prototype.publish).not.toBe(publish);
    undo();
    expect(amqp.promiseApi.connect).toBe(connect);
    expect(amqp.Channel.prototype.publish).toBe(publish);
  });

  it('explains what to pass when given a read-only module', () => {
    const frozen = Object.freeze({ connect: () => {} });
    expect(() => enableAmqplibRecording(frozen)).toThrow(/import amqp from 'amqplib'/);
    const namespace = Object.freeze({ connect: () => {}, default: { connect: () => Promise.resolve() } });
    expect(() => enableAmqplibRecording(namespace)()).not.toThrow();
  });
});

describe('helpers', () => {
  it('reads the vhost', () => {
    expect(vhostOf('amqp://localhost')).toBe('/');
    expect(vhostOf('amqp://h/%2F')).toBe('/');
    expect(vhostOf('amqps://h:5671/prod')).toBe('prod');
    expect(vhostOf({ hostname: 'h', vhost: 'v' })).toBe('v');
    expect(vhostOf(undefined)).toBe('/');
  });

  it('parses JSON bodies and leaves the rest as bytes', () => {
    expect(decodeContent(json({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeContent(Buffer.from('hello'))).toBeInstanceOf(Buffer);
  });
});

describe('with the real amqplib', () => {
  it('wraps both modules’ connect and passes connection errors through', async () => {
    const promiseApi = (await import('amqplib')).default as unknown as { connect: (url: string) => Promise<unknown> };
    const callbackApi = (await import('amqplib/callback_api')).default as unknown as { connect: (url: string, cb: (err: unknown) => void) => void };
    const undoPromise = enableAmqplibRecording(promiseApi);
    const undoCallback = enableAmqplibRecording(callbackApi);
    try {
      await expect(promiseApi.connect('amqp://127.0.0.1:1')).rejects.toThrow();
      await expect(new Promise((ok, fail) => callbackApi.connect('amqp://127.0.0.1:1', (err) => (err ? fail(err) : ok(null))))).rejects.toThrow();
    } finally {
      undoCallback();
      undoPromise();
    }
  });
});

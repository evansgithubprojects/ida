import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRecorder, createRecorder, PARENT_HEADER, type Occurrence, type Recording } from '@ida-dev/core';
import { resetRecorders } from '../../core/src/registry';
import { setDefaultRecorder } from '../../core/src/routing';
import type { ConsumerRunConfig, EachBatchPayload, EachMessagePayload, KafkaMessage, Message, ProducerBatch, ProducerRecord } from 'kafkajs';
import { decodeValue, enableKafkajsRecording, type Uninstall } from '../src/index';

type KafkaClass = Parameters<typeof enableKafkajsRecording>[0];

/** A stand-in for kafkajs: producers append to an in-memory log, consumers are fed from it by the test. */
function fakeKafka() {
  const log: { topic: string; message: Message }[] = [];
  const consumers: { groupId: string; config?: ConsumerRunConfig }[] = [];
  class Kafka {
    producer() {
      const send = async (r: ProducerRecord) => { for (const message of r.messages) log.push({ topic: r.topic, message }); return []; };
      const sendBatch = async (b: ProducerBatch) => { for (const t of b.topicMessages ?? []) await send(t); return []; };
      return { send, sendBatch, transaction: async () => ({ send, sendBatch }) };
    }
    consumer({ groupId }: { groupId: string }) {
      const entry: { groupId: string; config?: ConsumerRunConfig } = { groupId };
      consumers.push(entry);
      return { run: async (config?: ConsumerRunConfig) => { entry.config = config; } };
    }
  }
  /** Delivers every logged message on `topic` to the consumer's `eachMessage`, as kafkajs would. */
  const deliver = async (i: number, topic: string) => {
    let offset = 0;
    for (const { message } of log.filter((l) => l.topic === topic)) {
      const km = { ...message, offset: String(offset++), value: toBuf(message.value), key: toBuf(message.key), headers: bufHeaders(message.headers) } as KafkaMessage;
      await consumers[i]!.config!.eachMessage!({ topic, partition: 0, message: km, heartbeat: async () => {}, pause: () => () => {} } as EachMessagePayload);
    }
  };
  return { Kafka, log, consumers, deliver };
}

// On the wire everything is bytes, as kafkajs hands it to a consumer.
const toBuf = (v: unknown) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v)));
const bufHeaders = (h: Message['headers']) => h && Object.fromEntries(Object.entries(h).map(([k, v]) => [k, toBuf(v)]));

let uninstall: Uninstall | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  resetRecorders();
  setDefaultRecorder(null);
});

const eventOf = (rec: Recording, o: Occurrence) => rec.templates.find((t) => t.id === o.templateId)!.eventName;

/** A service: a recorder, a Kafka client it tracks, and an in-process bus whose handler produces. */
function service(kafka: ReturnType<typeof fakeKafka>, key: string) {
  const rec = connectRecorder(key);
  const client = new kafka.Kafka();
  rec.track(client);
  return { rec, client };
}

describe('kafkajs adapter', () => {
  it('links a message produced in one service to its consumer in another', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const checkout = service(kafka, 'checkout');
    const payments = service(kafka, 'payments');

    const producer = checkout.client.producer();
    const bus = {};
    const placeOrder = async function placeOrder() {
      await producer.send({ topic: 'orders', messages: [{ key: 'o-1', value: JSON.stringify({ orderId: 'o-1', total: 42 }) }] });
    };
    checkout.rec.labelHandler(placeOrder, 'placeOrder');
    await checkout.rec.dispatch({ emitter: bus, eventName: 'checkout', handlers: [placeOrder], payload: {} }, (inv) => inv(placeOrder, placeOrder));

    const consumer = payments.client.consumer({ groupId: 'payments' });
    const charge = vi.fn(async function charge(_p: EachMessagePayload) {});
    payments.rec.labelHandler(charge, 'charge');
    await consumer.run({ eachMessage: charge });
    await kafka.deliver(0, 'orders');

    // Producer side: the publish hangs off the handler that sent it, on the shared topic process.
    const sent = checkout.rec.export();
    const publish = sent.occurrences.find((o) => eventOf(sent, o) === 'orders')!;
    const handler = sent.nodes.find((n) => n.label === 'placeOrder')!;
    expect(publish).toMatchObject({ sourceNodeId: handler.id, parentId: sent.occurrences[0]!.id, causality: 'sync', meta: { topic: 'orders' } });
    expect(publish.meta).not.toHaveProperty('key');
    expect(sent.processes.find((p) => p.id === 'kafka::topic:orders')).toMatchObject({ kind: 'topic', label: 'orders', broker: { type: 'kafka' } });
    expect(sent.templates.find((t) => t.eventName === 'orders')!.payloadShape).toBe('{orderId:string,total:number}');

    // The message carries the header; the user's message object doesn't.
    expect(String(kafka.log[0]!.message.headers![PARENT_HEADER])).toBe(`1:${checkout.rec.sessionId}:${publish.id}`);

    // Consumer side.
    expect(charge).toHaveBeenCalledOnce();
    const got = payments.rec.export();
    expect(got.occurrences).toHaveLength(1);
    expect(got.occurrences[0]).toMatchObject({
      causality: 'propagated', remoteParent: { sessionId: checkout.rec.sessionId, occurrenceId: publish.id },
      meta: { topic: 'orders', partition: 0, offset: '0', group: 'payments' },
      handlerResults: [{ handlerId: got.nodes.find((n) => n.label === 'charge')!.id }],
    });
    expect(got.processes.map((p) => p.id)).toEqual(['kafka::topic:orders']);
  });

  it('does not change the messages the caller passed in', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const { client } = service(kafka, 'svc');
    const messages = [{ value: 'x', headers: { trace: 'abc' } }];
    await client.producer().send({ topic: 't', messages });
    expect(messages[0]!.headers).toEqual({ trace: 'abc' });
    expect(kafka.log[0]!.message.headers).toMatchObject({ trace: 'abc', [PARENT_HEADER]: expect.any(String) });
  });

  it('records sendBatch and transactions', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const { rec, client } = service(kafka, 'svc');
    const p = client.producer();
    await p.sendBatch({ topicMessages: [{ topic: 'a', messages: [{ value: '1' }] }, { topic: 'b', messages: [{ value: '2' }, { value: '3' }] }] });
    const tx = await p.transaction();
    await tx.send({ topic: 'c', messages: [{ value: '4' }] });
    expect(rec.export().occurrences).toHaveLength(4);
    expect(kafka.log.every((l) => l.message.headers?.[PARENT_HEADER])).toBe(true);
  });

  it('records a handler that rejects, and kafkajs still sees the rejection', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const { rec, client } = service(kafka, 'svc');
    await client.producer().send({ topic: 'orders', messages: [{ value: '{}' }] });
    const consumer = client.consumer({ groupId: 'g' });
    await consumer.run({ eachMessage: async function failing() { throw new Error('declined'); } });
    await expect(kafka.deliver(0, 'orders')).rejects.toThrow('declined');
    const consumed = rec.export().occurrences.find((o) => o.handlerResults.length)!;
    expect(consumed.handlerResults[0]!.error).toMatchObject({ message: 'declined' });
  });

  it('records a batch as one occurrence linked to its first producer', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const a = service(kafka, 'a');
    const b = service(kafka, 'b');
    await a.client.producer().send({ topic: 't', messages: [{ value: '{"n":1}' }, { value: '{"n":2}' }] });
    const consumer = b.client.consumer({ groupId: 'g' });
    const handle = vi.fn(async function handleBatch() {});
    await consumer.run({ eachBatch: handle });
    const messages = kafka.log.map((l, i) => ({ ...l.message, offset: String(i), value: toBuf(l.message.value), headers: bufHeaders(l.message.headers) }));
    await kafka.consumers[0]!.config!.eachBatch!({ batch: { topic: 't', partition: 0, messages } } as unknown as EachBatchPayload);
    const [occ] = b.rec.export().occurrences;
    expect(handle).toHaveBeenCalledOnce();
    expect(occ).toMatchObject({ causality: 'propagated', meta: { messages: 2, firstOffset: '0', lastOffset: '1', group: 'g' } });
    expect(occ!.remoteParent!.occurrenceId).toBe(a.rec.export().occurrences[0]!.id);
  });

  it('keeps keys only when asked', async () => {
    const kafka = fakeKafka();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass, { recordKeys: true });
    const { rec, client } = service(kafka, 'svc');
    await client.producer().send({ topic: 't', messages: [{ key: 'user-7', value: '{}' }] });
    expect(rec.export().occurrences[0]!.meta).toMatchObject({ key: 'user-7' });
  });

  it('records to the default recorder, or to the one passed in', async () => {
    const kafka = fakeKafka();
    const own = createRecorder();
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass, { recorder: own });
    await new kafka.Kafka().producer().send({ topic: 't', messages: [{ value: '1' }] });
    expect(own.export().occurrences).toHaveLength(1);
  });

  it('warns once and still sends when nothing is recording', async () => {
    const kafka = fakeKafka();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    uninstall = enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass);
    const p = new kafka.Kafka().producer();
    await p.send({ topic: 't', messages: [{ value: '1' }] });
    await p.send({ topic: 't', messages: [{ value: '2' }] });
    expect(kafka.log).toHaveLength(2);
    expect(kafka.log[0]!.message.headers).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('restores kafkajs on uninstall', () => {
    const kafka = fakeKafka();
    const { producer } = kafka.Kafka.prototype;
    enableKafkajsRecording(kafka.Kafka as unknown as KafkaClass)();
    expect(kafka.Kafka.prototype.producer).toBe(producer);
  });
});

describe('decodeValue', () => {
  it('parses JSON and leaves everything else as bytes', () => {
    expect(decodeValue(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
    expect(decodeValue(Buffer.from('plain text'))).toBeInstanceOf(Buffer);
    expect(decodeValue(Buffer.from('{broken'))).toBeInstanceOf(Buffer);
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue(Buffer.alloc(70_000, 0x7b))).toBeInstanceOf(Buffer);
  });
});


describe('with the real kafkajs', () => {
  it('records and stamps a message before kafkajs touches the network', async () => {
    const { Kafka, logLevel } = await import('kafkajs');
    uninstall = enableKafkajsRecording(Kafka);
    const rec = connectRecorder('real');
    const kafka = new Kafka({ brokers: ['127.0.0.1:1'], retry: { retries: 0 }, connectionTimeout: 200, logLevel: logLevel.NOTHING });
    rec.track(kafka);
    const producer = kafka.producer({ createPartitioner: () => () => 0 });
    await expect(producer.send({ topic: 'orders', messages: [{ value: '{"id":1}' }] })).rejects.toThrow();
    expect(rec.export().occurrences).toHaveLength(1);
    expect(rec.export().processes[0]!.id).toBe('kafka::topic:orders');
    // Consumers are wrapped too (running one needs a broker).
    expect(kafka.consumer({ groupId: 'g' }).run).toBeTypeOf('function');
  });
});

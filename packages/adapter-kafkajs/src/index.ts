import {
  dispatchAll, formatParentHeader, getDefaultRecorder, parseParentHeader, recordersFor, PARENT_HEADER,
  type DispatchInfo, type JsonValue, type Recorder,
} from '@ida-dev/core';
import type { Consumer, ConsumerRunConfig, EachBatchPayload, EachMessagePayload, IHeaders, Kafka, Message, Producer, ProducerBatch, ProducerRecord, Transaction } from 'kafkajs';

/** Call to restore the original methods. Producers and consumers created before keep recording. */
export type Uninstall = () => void;

export interface KafkajsAdapterOptions {
  /**
   * Where to record. Leave it out to route each client to the recorders that `track()` it (the `Kafka` instance),
   * or else to the default recorder (see `enable()`).
   */
  recorder?: Recorder;
  /**
   * A name for the Kafka cluster, part of every topic's id. Give each cluster its own name when services use more
   * than one, so a topic called `orders` in each isn't drawn as one.
   * @default '' (one cluster)
   */
  cluster?: string;
  /**
   * Keep message keys in each occurrence's `meta`. Off by default: keys are often ids from your data, and Ida keeps
   * only shapes unless you ask for values.
   * @default false
   */
  recordKeys?: boolean;
  /**
   * Print one console warning the first time a message is produced or consumed with no recorder to receive it.
   * @default true
   */
  warnIfNoRecorder?: boolean;
}

type KafkaClass = { prototype: Pick<Kafka, 'producer' | 'consumer'> };

/** Payloads larger than this are recorded as `bytes` rather than parsed for their shape. */
const MAX_PARSE_BYTES = 64 * 1024;

/** A message value as data: parsed JSON when it is JSON, else the raw bytes (shape `bytes`). */
export function decodeValue(value: Buffer | string | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && value.length > MAX_PARSE_BYTES) return value;
  const text = typeof value === 'string' ? value : value.toString('utf8');
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

const headerOf = (headers: IHeaders | undefined) => {
  const h = headers?.[PARENT_HEADER];
  return parseParentHeader(Array.isArray(h) ? h[0] : h);
};

/**
 * Records Kafka traffic through kafkajs. Each produced message becomes an occurrence on its topic, emitted by the
 * handler that was running, and carries an `ida-parent` header. Each consumed message (or batch) becomes an
 * occurrence handled by your `eachMessage` / `eachBatch`, linked back to the service that produced it.
 * Patches `Kafka.prototype`, so it covers every client, producer and consumer created after this call.
 * @param KafkaCtor the `Kafka` class from `kafkajs`
 * @returns a function that restores the original methods
 * @example
 * import { Kafka } from 'kafkajs';
 * enable();
 * enableKafkajsRecording(Kafka);
 */
export function enableKafkajsRecording(KafkaCtor: KafkaClass, options: KafkajsAdapterOptions = {}): Uninstall {
  const proto = KafkaCtor.prototype;
  const { producer, consumer } = proto;
  const cluster = options.cluster ?? '';

  /** One emitter object per topic: the registry keys emitters by object identity. */
  const topics = new Map<string, object>();
  const topicEmitter = (topic: string) => topics.get(topic) ?? topics.set(topic, { topic }).get(topic)!;

  const targets = (client: object): Recorder[] =>
    options.recorder ? (options.recorder.recording ? [options.recorder] : []) : recordersFor(client);

  let warned = false;
  const warnUnrecorded = (topic: string) => {
    if (warned || options.recorder || options.warnIfNoRecorder === false || getDefaultRecorder()) return;
    warned = true;
    console.warn(
      `[ida] a Kafka message on "${topic}" went unrecorded because no recorder is receiving it. ` +
      'Call enable() first, or connectRecorder(key).track(kafka) to record a client on its own recorder. ' +
      'Pass { warnIfNoRecorder: false } to enableKafkajsRecording() to silence this.',
    );
  };

  const info = (topic: string, payload: unknown, meta: Record<string, JsonValue>, extra: Partial<DispatchInfo> = {}): DispatchInfo => ({
    emitter: topicEmitter(topic), label: topic, eventName: topic, handlers: [], payload,
    broker: { type: 'kafka', kind: 'topic', name: topic, cluster }, meta, ...extra,
  });

  /** Records each outgoing message and returns copies carrying the `ida-parent` header. The user's objects are left alone. */
  const stamp = (client: object, topic: string, messages: Message[]): Message[] => {
    const recorders = targets(client);
    if (!recorders.length) {
      warnUnrecorded(topic);
      return messages;
    }
    return messages.map((m) => {
      const meta: Record<string, JsonValue> = { topic };
      if (m.partition !== undefined) meta.partition = m.partition;
      if (options.recordKeys && m.key !== undefined && m.key !== null) meta.key = String(m.key);
      return dispatchAll(recorders, info(topic, decodeValue(m.value), meta), (_invoke, recorded) =>
        recorded ? { ...m, headers: { ...m.headers, [PARENT_HEADER]: formatParentHeader(recorded) } } : m);
    });
  };

  const wrapSenders = <T extends Pick<Producer, 'send' | 'sendBatch'>>(client: object, target: T): T => {
    const { send, sendBatch } = target;
    target.send = (record: ProducerRecord) => send.call(target, { ...record, messages: stamp(client, record.topic, record.messages) });
    target.sendBatch = (batch: ProducerBatch) => sendBatch.call(target, {
      ...batch,
      topicMessages: batch.topicMessages?.map((t) => ({ ...t, messages: stamp(client, t.topic, t.messages) })),
    });
    return target;
  };

  proto.producer = function (this: Kafka, ...args: Parameters<Kafka['producer']>) {
    const p = wrapSenders(this, producer.apply(this, args));
    const { transaction } = p;
    p.transaction = async () => wrapSenders(this, await transaction.call(p)) as Transaction;
    return p;
  };

  proto.consumer = function (this: Kafka, ...args: Parameters<Kafka['consumer']>) {
    const c: Consumer = consumer.apply(this, args);
    const client = this;
    const group = args[0]?.groupId ?? '';
    const { run } = c;
    c.run = (config?: ConsumerRunConfig) => {
      if (!config) return run.call(c, config);
      const { eachMessage, eachBatch } = config;
      return run.call(c, {
        ...config,
        ...(eachMessage && {
          eachMessage: (payload: EachMessagePayload) => {
            const recorders = targets(client);
            if (!recorders.length) {
              warnUnrecorded(payload.topic);
              return eachMessage(payload);
            }
            const { topic, partition, message } = payload;
            const meta: Record<string, JsonValue> = { topic, partition, offset: message.offset, group };
            if (options.recordKeys && message.key) meta.key = message.key.toString('utf8');
            const remoteParent = headerOf(message.headers);
            return dispatchAll(
              recorders,
              info(topic, decodeValue(message.value), meta, { handlers: [eachMessage], ...(remoteParent && { remoteParent }) }),
              (invoke) => invoke(eachMessage, () => eachMessage(payload)),
            );
          },
        }),
        ...(eachBatch && {
          // One occurrence per batch, since the handler runs once for all of it. It links to the first message
          // that names its producer; `meta.messages` says how many it held.
          eachBatch: (payload: EachBatchPayload) => {
            const recorders = targets(client);
            const { topic, partition, messages } = payload.batch;
            if (!recorders.length) {
              warnUnrecorded(topic);
              return eachBatch(payload);
            }
            const remoteParent = messages.map((m) => headerOf(m.headers)).find(Boolean);
            const meta: Record<string, JsonValue> = {
              topic, partition, group, messages: messages.length,
              ...(messages.length && { firstOffset: messages[0]!.offset, lastOffset: messages[messages.length - 1]!.offset }),
            };
            return dispatchAll(
              recorders,
              info(topic, messages.slice(0, 20).map((m) => decodeValue(m.value)), meta, { handlers: [eachBatch], ...(remoteParent && { remoteParent }) }),
              (invoke) => invoke(eachBatch, () => eachBatch(payload)),
            );
          },
        }),
      });
    };
    return c;
  };

  return () => {
    proto.producer = producer;
    proto.consumer = consumer;
  };
}

export { enable } from '@ida-dev/core';

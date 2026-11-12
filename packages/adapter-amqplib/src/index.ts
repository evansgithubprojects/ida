import {
  dispatchAll, formatParentHeader, getDefaultRecorder, isTracked, parseParentHeader, recordersFor, PARENT_HEADER,
  type JsonValue, type Recorder,
} from '@ida-dev/core';

/** Call to restore amqplib's original methods. */
export type Uninstall = () => void;

export interface AmqplibAdapterOptions {
  /**
   * Where to record. Leave it out to route each channel to the recorders that `track()` it (or its connection), or
   * else to the default recorder (see `enable()`).
   */
  recorder?: Recorder;
  /**
   * Print one console warning the first time a message is published or consumed with no recorder to receive it.
   * @default true
   */
  warnIfNoRecorder?: boolean;
}

/** `amqplib` or `amqplib/callback_api`: anything with a `connect`. */
export interface AmqplibModule {
  connect: (...args: any[]) => any;
}

/** The parts of a channel this adapter touches, the same in every amqplib version since 0.10. */
interface Channelish {
  publish(exchange: string, routingKey: string, content: Buffer, options?: { headers?: Record<string, unknown> }, ...rest: unknown[]): boolean;
  consume(queue: string, onMessage: ((msg: Delivery | null) => unknown) | undefined, ...rest: unknown[]): unknown;
}

interface Delivery {
  content: Buffer;
  fields: { exchange: string; routingKey: string; deliveryTag: number; redelivered: boolean };
  properties: { headers?: Record<string, unknown> };
}

/** Payloads larger than this are recorded as `bytes` rather than parsed for their shape. */
const MAX_PARSE_BYTES = 64 * 1024;

/** A message body as data: parsed JSON when it is JSON, else the raw bytes (shape `bytes`). */
export function decodeContent(content: Buffer | null | undefined): unknown {
  if (!content) return null;
  if (content.length > MAX_PARSE_BYTES) return content;
  const text = content.toString('utf8');
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return content;
  try {
    return JSON.parse(text);
  } catch {
    return content;
  }
}

/** The vhost a connect call names: the URL's path, or an options object's `vhost`. */
export function vhostOf(url: unknown): string {
  if (url && typeof url === 'object' && typeof (url as { vhost?: unknown }).vhost === 'string') return (url as { vhost: string }).vhost || '/';
  if (typeof url !== 'string') return '/';
  try {
    const path = new URL(url).pathname.slice(1);
    return path ? decodeURIComponent(path) : '/';
  } catch {
    return '/';
  }
}

/**
 * Records RabbitMQ traffic through amqplib, promise or callback API. Each published message (`publish`,
 * `sendToQueue`) becomes an occurrence on its exchange, emitted by the handler that was running, and carries an
 * `ida-parent` header. Each delivery to a `consume` callback becomes an occurrence on its queue, handled by that
 * callback and linked back to the service that published it.
 * Wraps `connect`, so call it before connecting.
 * @param amqp the module: `import amqp from 'amqplib'` or `require('amqplib/callback_api')`
 * @returns a function that restores amqplib
 * @example
 * import amqp from 'amqplib';
 * enable();
 * enableAmqplibRecording(amqp);
 * const conn = await amqp.connect('amqp://localhost');
 */
export function enableAmqplibRecording(amqp: AmqplibModule, options: AmqplibAdapterOptions = {}): Uninstall {
  // `import * as amqp` gives a read-only namespace; its `default` is the real module.
  const target = writable(amqp, 'connect') ? amqp : (amqp as { default?: AmqplibModule }).default;
  if (!target || !writable(target, 'connect')) {
    throw new TypeError("[ida] enableAmqplibRecording() can't wrap amqplib's connect. Pass the module itself: import amqp from 'amqplib'.");
  }
  const connect = target.connect;
  const restore: (() => void)[] = [() => { target.connect = connect; }];
  /** channel -> where it is connected */
  const channels = new WeakMap<object, { connection: object; vhost: string }>();
  const patched = new WeakSet<object>();
  const exchanges = new Map<string, object>();
  const queues = new Map<string, object>();
  const token = (map: Map<string, object>, vhost: string, name: string) => {
    const key = `${vhost}\u0000${name}`;
    return map.get(key) ?? map.set(key, { name }).get(key)!;
  };
  let publishing = 0;

  const targets = (channel: object): Recorder[] => {
    if (options.recorder) return options.recorder.recording ? [options.recorder] : [];
    const connection = channels.get(channel)?.connection;
    return isTracked(channel) || !connection ? recordersFor(channel) : recordersFor(connection);
  };

  let warned = false;
  const warnUnrecorded = (what: string) => {
    if (warned || options.recorder || options.warnIfNoRecorder === false || getDefaultRecorder()) return;
    warned = true;
    console.warn(
      `[ida] a RabbitMQ message (${what}) went unrecorded because no recorder is receiving it. ` +
      'Call enable() first, or connectRecorder(key).track(connection) to record a connection on its own recorder. ' +
      'Pass { warnIfNoRecorder: false } to enableAmqplibRecording() to silence this.',
    );
  };

  /** Patches each class in the channel's prototype chain once: every channel of those classes is recorded. */
  const patchChannel = (channel: Channelish) => {
    for (let proto = Object.getPrototypeOf(channel); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      if (patched.has(proto)) continue;
      patched.add(proto);
      if (Object.hasOwn(proto, 'publish')) patchPublish(proto);
      if (Object.hasOwn(proto, 'consume')) patchConsume(proto);
    }
  };

  const patchPublish = (proto: Channelish) => {
    const publish = proto.publish;
    restore.push(() => { proto.publish = publish; });
    proto.publish = function (this: Channelish, exchange, routingKey, content, opts, ...rest) {
      // ConfirmChannel.publish calls Channel.publish, and sendToQueue calls publish: record the outermost call only.
      if (publishing) return publish.call(this, exchange, routingKey, content, opts, ...rest);
      const recorders = targets(this);
      const vhost = channels.get(this)?.vhost ?? '/';
      publishing++;
      try {
        if (!recorders.length) {
          warnUnrecorded(`published to "${exchange || routingKey}"`);
          return publish.call(this, exchange, routingKey, content, opts, ...rest);
        }
        return dispatchAll(
          recorders,
          {
            emitter: token(exchanges, vhost, exchange), label: exchange || '(default exchange)', eventName: routingKey || exchange,
            handlers: [], payload: decodeContent(content),
            broker: { type: 'rabbitmq', kind: 'exchange', name: exchange, cluster: vhost },
            meta: { exchange, routingKey },
          },
          (_invoke, recorded) => {
            const headers = recorded ? { ...opts?.headers, [PARENT_HEADER]: formatParentHeader(recorded) } : opts?.headers;
            return publish.call(this, exchange, routingKey, content, { ...opts, ...(headers && { headers }) }, ...rest);
          },
        );
      } finally {
        publishing--;
      }
    };
  };

  const patchConsume = (proto: Channelish) => {
    const consume = proto.consume;
    restore.push(() => { proto.consume = consume; });
    proto.consume = function (this: Channelish, queue, onMessage, ...rest) {
      if (typeof onMessage !== 'function') return consume.call(this, queue, onMessage, ...rest);
      const channel = this;
      const wrapped = function (this: unknown, msg: Delivery | null) {
        if (!msg) return onMessage.call(this, msg); // the consumer was cancelled
        const recorders = targets(channel);
        if (!recorders.length) {
          warnUnrecorded(`delivered from "${queue}"`);
          return onMessage.call(this, msg);
        }
        const vhost = channels.get(channel)?.vhost ?? '/';
        const { exchange, routingKey, deliveryTag, redelivered } = msg.fields;
        const remoteParent = parseParentHeader(msg.properties.headers?.[PARENT_HEADER]);
        const meta: Record<string, JsonValue> = { exchange, routingKey, queue, deliveryTag, redelivered };
        return dispatchAll(
          recorders,
          {
            emitter: token(queues, vhost, queue), label: queue, eventName: routingKey || queue, handlers: [onMessage],
            payload: decodeContent(msg.content), broker: { type: 'rabbitmq', kind: 'queue', name: queue, cluster: vhost },
            meta, ...(remoteParent && { remoteParent }),
          },
          (invoke) => invoke(onMessage, () => onMessage.call(this, msg)),
        );
      };
      return consume.call(this, queue, wrapped, ...rest);
    };
  };

  const seeChannel = (channel: unknown, connection: object, vhost: string) => {
    if (!channel || typeof channel !== 'object' || typeof (channel as Channelish).publish !== 'function') return;
    channels.set(channel, { connection, vhost });
    patchChannel(channel as Channelish);
  };

  /** Promise API: `createChannel()` resolves to the channel. Callback API: it takes a callback, and also returns it. */
  const watchConnection = (connection: unknown, vhost: string) => {
    if (!connection || typeof connection !== 'object') return;
    const conn = connection as Record<string, unknown>;
    for (const method of ['createChannel', 'createConfirmChannel']) {
      const original = conn[method];
      if (typeof original !== 'function') continue;
      conn[method] = function (this: unknown, ...args: unknown[]) {
        const last = args.length - 1;
        if (typeof args[last] === 'function') {
          const cb = args[last] as (err: unknown, ch: unknown) => unknown;
          args[last] = (err: unknown, ch: unknown) => {
            if (!err) seeChannel(ch, connection, vhost);
            return cb(err, ch);
          };
        }
        const out = original.apply(this, args);
        if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
          return (out as Promise<unknown>).then((ch) => { seeChannel(ch, connection, vhost); return ch; });
        }
        seeChannel(out, connection, vhost);
        return out;
      };
    }
  };

  target.connect = function (this: unknown, url: unknown, ...rest: unknown[]) {
    const vhost = vhostOf(url);
    const last = rest.length - 1;
    if (typeof rest[last] === 'function') {
      const cb = rest[last] as (err: unknown, conn: unknown) => unknown;
      rest[last] = (err: unknown, conn: unknown) => {
        if (!err) watchConnection(conn, vhost);
        return cb(err, conn);
      };
      return connect.call(this, url, ...rest);
    }
    const out = connect.call(this, url, ...rest);
    return out && typeof out.then === 'function' ? out.then((conn: unknown) => { watchConnection(conn, vhost); return conn; }) : out;
  };

  return () => {
    for (const r of restore.reverse()) r();
  };
}

function writable(obj: object, key: string): boolean {
  if (Object.isFrozen(obj)) return false;
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return !!d.writable || !!d.set;
  }
  return Object.isExtensible(obj);
}

export { enable } from '@ida-dev/core';

# @ida-dev/adapter-amqplib

Records RabbitMQ traffic made with [amqplib](https://amqp-node.github.io/amqplib/): each published message on its exchange, and each delivery as handled by your consume callback, linked across services through an `ida-parent` message header. See [Tracing messages across services](../guides/brokers.md).

```bash
npm install @ida-dev/core @ida-dev/adapter-amqplib
```

Requires `amqplib` 0.10 or later (a peer dependency). Both the promise API and the callback API (`amqplib/callback_api`) are supported.

## enableAmqplibRecording

```ts
function enableAmqplibRecording(amqp: { connect: Function }, options?: AmqplibAdapterOptions): Uninstall
```

Wraps the module's `connect`, then the channels each connection creates (`createChannel` and `createConfirmChannel`). Call it **before connecting**, and pass the module itself.

Returns a function that restores amqplib.

```js
import amqp from 'amqplib';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';

enable();
enableAmqplibRecording(amqp);

const connection = await amqp.connect('amqp://localhost');
connectRecorder('notifier').track(connection); // optional: record this connection on its own recorder

const channel = await connection.createChannel();
channel.publish('receipts', 'receipt.send', Buffer.from(JSON.stringify(receipt)));

await channel.consume('emails', (msg) => {
  sendEmail(JSON.parse(msg.content.toString()));
  channel.ack(msg);
});
```

With `import * as amqp from 'amqplib'`, the adapter uses the namespace's `default`. If it can't find a writable `connect`, it throws:

```
TypeError: [ida] enableAmqplibRecording() can't wrap amqplib's connect. Pass the module itself: import amqp from 'amqplib'.
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `recorder` | `Recorder` | routing | Record everything here. Leave it out to route each channel to the recorders that `track()` it, or its connection, or else to the default recorder. |
| `warnIfNoRecorder` | `boolean` | `true` | Print one console warning the first time a message has no recorder to go to. |

## What is recorded

**Publishing** with `publish`, `sendToQueue`, or a confirm channel: each message is one event on its exchange (the default exchange shows as `(default exchange)`), named after its routing key, emitted by the handler that was running. The `ida-parent` header is added to a copy of your options; your object isn't changed.

**Consuming** with `consume`: each delivery is one event on its queue, named after its routing key, handled by your callback, and linked to the publish that sent it. A `null` delivery (the consumer was cancelled) is passed to your callback without being recorded.

Exchanges and queues are identified by vhost and name, taken from the URL or options you connect with.

Message facts kept with each event (`meta`):

| | Publish | Delivery |
| --- | --- | --- |
| `exchange` | ✓ | ✓ |
| `routingKey` | ✓ | ✓ |
| `queue` | | ✓ |
| `deliveryTag` | | ✓ |
| `redelivered` | | ✓ |

## Helpers

| Export | |
| --- | --- |
| `decodeContent(content)` | How message bodies become payloads: `null` for none; parsed JSON when the body starts with `{`, `[` or `"` and parses; otherwise the buffer (shape `bytes`). Bodies over 64 KiB aren't parsed. |
| `vhostOf(urlOrOptions)` | The vhost a `connect` call names: the URL's path, or an options object's `vhost`, else `/`. |
| `enable` | Re-exported from `@ida-dev/core`. |
| `Uninstall`, `AmqplibAdapterOptions`, `AmqplibModule` | Types. |

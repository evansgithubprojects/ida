# @ida-dev/adapter-kafkajs

Records Kafka traffic made with [kafkajs](https://kafka.js.org): each produced message on its topic, and each consumed message or batch as handled by your code, linked across services through an `ida-parent` message header. See [Tracing messages across services](../guides/brokers.md).

```bash
npm install @ida-dev/core @ida-dev/adapter-kafkajs
```

Requires `kafkajs` 2.x (a peer dependency).

## enableKafkajsRecording

```ts
function enableKafkajsRecording(Kafka: typeof import('kafkajs').Kafka, options?: KafkajsAdapterOptions): Uninstall
```

Patches `Kafka.prototype.producer` and `Kafka.prototype.consumer`, so it covers every producer and consumer created **after** the call. Call it before creating them.

Returns a function that restores the original methods. Producers and consumers created before uninstalling keep recording.

```js
import { Kafka } from 'kafkajs';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';

enable();
enableKafkajsRecording(Kafka);

const kafka = new Kafka({ brokers: ['localhost:9092'] });
connectRecorder('checkout').track(kafka); // optional: record this client on its own recorder

const producer = kafka.producer();
await producer.connect();
await producer.send({ topic: 'orders', messages: [{ value: JSON.stringify(order) }] });

const consumer = kafka.consumer({ groupId: 'payments' });
await consumer.connect();
await consumer.subscribe({ topic: 'orders' });
await consumer.run({
  eachMessage: async ({ message }) => chargeCard(JSON.parse(message.value.toString())),
});
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `recorder` | `Recorder` | routing | Record everything here. Leave it out to route each client to the recorders that `track()` its `Kafka` instance, or else to the default recorder. |
| `cluster` | `string` | `''` | Names the cluster. Give each cluster its own name when services use more than one, so a topic called `orders` in each isn't drawn as one. Use the same name in every service. |
| `recordKeys` | `boolean` | `false` | Keep message keys. Off by default because keys are often ids from your data. |
| `warnIfNoRecorder` | `boolean` | `true` | Print one console warning the first time a message has no recorder to go to. |

## What is recorded

**Producing** with `send`, `sendBatch`, or a transaction's `send` / `sendBatch`: each message is one event, named after its topic, emitted by the handler that was running (or by the topic for a root event). The message is sent as a copy with an `ida-parent` header added; your objects aren't changed.

**Consuming** with `consumer.run`:

| Handler | Recorded as |
| --- | --- |
| `eachMessage` | One event per message, handled by your function, linked to the produce that sent it. |
| `eachBatch` | One event per batch, handled by your function. Its payload is the first 20 decoded values, and it links to the first message with a header. |

Message facts kept with each event (`meta`):

| | Produce | `eachMessage` | `eachBatch` |
| --- | --- | --- | --- |
| `topic` | ✓ | ✓ | ✓ |
| `partition` | if given | ✓ | ✓ |
| `offset` | | ✓ | |
| `group` | | ✓ | ✓ |
| `key` | with `recordKeys` | with `recordKeys` | |
| `messages`, `firstOffset`, `lastOffset` | | | ✓ |

## decodeValue

```ts
function decodeValue(value: Buffer | string | null | undefined): unknown
```

How message values become payloads: `null` for no value; parsed JSON when the text starts with `{`, `[` or `"` and parses; otherwise the raw value (shape `bytes` for a buffer). Buffers over 64 KiB aren't parsed.

## Exports

| Export | |
| --- | --- |
| `enableKafkajsRecording` | See above. |
| `decodeValue` | See above. |
| `enable` | Re-exported from `@ida-dev/core`. |
| `Uninstall`, `KafkajsAdapterOptions` | Types. |

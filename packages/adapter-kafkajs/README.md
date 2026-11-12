# @ida-dev/adapter-kafkajs

Records Kafka traffic made with [kafkajs](https://kafka.js.org): each produced message on its topic, and each consumed message or batch as handled by your code, linked across services (in any language Ida supports) through an `ida-parent` message header. Part of [Ida](../../README.md).

```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-kafkajs
```

Requires `kafkajs` 2.x.

## Setup

Call it before you create producers and consumers:

```ts
import { Kafka } from 'kafkajs';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';

configure({ projectKey: process.env.IDA_PROJECT_KEY!, endpoint: 'https://your-server' });
enable();
const uninstall = enableKafkajsRecording(Kafka);

const kafka = new Kafka({ brokers: ['localhost:9092'] });
connectRecorder('checkout').track(kafka); // optional: name this service
```

Then produce (`send`, `sendBatch`, transactions) and consume (`consumer.run({ eachMessage })` or `eachBatch`) as usual. Your message objects are never changed: the header is added to a copy.

## `enableKafkajsRecording(Kafka, options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `recorder` | `Recorder` | routing | Record everything here instead of routing by `track(kafka)`. |
| `cluster` | `string` | `''` | Names the cluster when services use more than one, so equal topic names stay apart. |
| `recordKeys` | `boolean` | `false` | Keep message keys. Off by default: keys are often ids from your data. |
| `warnIfNoRecorder` | `boolean` | `true` | Print one warning when a message has no recorder to go to. |

Full documentation: the **Docs** section of the Ida web app (`/docs/reference/adapter-kafkajs`, source in [`docs/`](../../docs/reference/adapter-kafkajs.md)).

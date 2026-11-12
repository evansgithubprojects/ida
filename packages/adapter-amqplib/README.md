# @ida-dev/adapter-amqplib

Records RabbitMQ traffic made with [amqplib](https://amqp-node.github.io/amqplib/): each publish on its exchange, and each delivery as handled by your consume callback, linked across services (in any language Ida supports) through an `ida-parent` message header. Part of [Ida](../../README.md).

```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-amqplib
```

Requires `amqplib` 0.10 or later; the promise and callback APIs both work.

## Setup

Pass the module itself, before connecting:

```ts
import amqp from 'amqplib';
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';

configure({ projectKey: process.env.IDA_PROJECT_KEY!, endpoint: 'https://your-server' });
enable();
const uninstall = enableAmqplibRecording(amqp);

const connection = await amqp.connect('amqp://localhost');
connectRecorder('notifier').track(connection); // optional: name this service
```

Then `publish`, `sendToQueue` and `consume` as usual. Your options object is never changed: the header is added to a copy.

## `enableAmqplibRecording(amqp, options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `recorder` | `Recorder` | routing | Record everything here instead of routing by `track(channel or connection)`. |
| `warnIfNoRecorder` | `boolean` | `true` | Print one warning when a message has no recorder to go to. |

Full documentation: the **Docs** section of the Ida web app (`/docs/reference/adapter-amqplib`, source in [`docs/`](../../docs/reference/adapter-amqplib.md)).

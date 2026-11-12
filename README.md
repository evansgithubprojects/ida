# Ida

Makes event-driven JavaScript easy to follow. It records every event in a time window, shows how events connect, and replays the timeline so you can watch pathways light up as events fire.

An event is **who called it and what it called, including payloads**. Handlers are the nodes; each event points at the event that caused it, so chains form a web.

**Documentation:** quick starts, guides and the full API reference live in [`docs/`](docs/overview.md), and are served by the web app at `/docs`.

## Packages

| Package | What it does |
| --- | --- |
| [`@ida-dev/core`](packages/core/README.md) | Recorder, ring buffer, templates, causality, corruption detection, JSON export. No DOM dependency. |
| [`@ida-dev/adapter-eventemitter`](packages/adapter-eventemitter/README.md) | Records Node `EventEmitter`. |
| [`@ida-dev/adapter-eventtarget`](packages/adapter-eventtarget/README.md) | Records DOM `EventTarget` (native events and `dispatchEvent`). |
| [`@ida-dev/adapter-kafkajs`](packages/adapter-kafkajs/README.md) | Records Kafka producers and consumers made with kafkajs, linked across services. |
| [`@ida-dev/adapter-amqplib`](packages/adapter-amqplib/README.md) | Records RabbitMQ publishes and deliveries made with amqplib, linked across services. |
| [`@ida-dev/cloud`](packages/cloud/README.md) | Uploads recorders to a project on the server; spools locally while offline. |
| [`ida-sdk`](python/README.md) (PyPI) | The Python SDK: recorder, `ida.Emitter`, uploads, Kafka (confluent-kafka) and RabbitMQ (pika). |
| `docs` | The documentation, in markdown. The web app renders it at `/docs`. |
| `apps/server` | Ingest and project API (Node, Hono, Postgres), with Supabase sign-in. See [its README](apps/server/README.md). |
| `apps/viewer` | The web app: projects, recorders and recordings, plus the replay viewer (also usable locally, without an account). |
| `apps/demo` | A stand-in user app (Node and browser) that uses the built packages and uploads to a project. Dev only. |

## Quick start

```ts
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

const recorder = enable({ windowMs: 60_000 });
enableEventEmitterRecording(recorder); // one line: patches EventEmitter.prototype.emit

// ... run your app ...
fs.writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

On a replay screen, open **Recordings** and use **Open file…** (or drop the file on that window) to view `recording.json`, or stream live with `startBridge` from `@ida-dev/core/bridge-node` and connect to it from the recorder dropdown under **View Remote Endpoint**.

### Projects: upload recorders to the web app

Create a project in the web app, make an ingest key, and add:

```ts
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY!, endpoint: 'https://your-server' });
enable();                                       // the default recorder: catches every emitter nothing else claims
enableEventEmitterRecording();
connectRecorder('payments').track(paymentsBus); // anywhere: same key, same recorder
```

Without `enable()`, only emitters that a recorder `track()`s are recorded. The adapter prints one console warning the first time an emit has nowhere to go (turn it off with `{ warnIfNoRecorder: false }`).

Each recorder appears under the project with one recording per run of your app, and can be watched live. On a replay screen, **Recordings** lists them, and each row has a **View** button that opens it. If the server can't be reached, batches are kept on disk (Node) or in IndexedDB (browser), the console says so, and they are uploaded in order once the connection is back. The viewer marks events that arrived late and gaps where data was lost.

### Storage: templates, not full copies

Each event stores a reference to its **template** (emitter + event name + handler set + payload shape) plus a timestamp, parent link and ids. Values are **not** stored unless you opt in per event ("deep logging"):

```ts
createRecorder({ deepLogging: { events: ['order:confirmed'] } });
```

The viewer labels every occurrence as `template-only` or `full capture`.

### Suspected corrupt payloads

When a handler throws (or emits an `error` event) and the same handler or emitter keeps emitting, those payloads are compared with earlier ones. With deep logging the values are compared; without it only the shapes are. Findings say *suspected*, never *corrupt*.

```ts
createRecorder({
  deepLogging: { events: ['order:confirmed'] },
  corruption: {
    notify: 'console',              // or a callback, or both; off by default
    external: { handlers: [postToBillingApi] }, // payloads reaching these are HIGH priority
    policy: 'notify',               // 'block' throws instead of calling handlers
    externalPolicy: 'block',        // stricter policy for external systems only
  },
});
```

Core cannot see inside a handler, so declare what talks to the outside world (`external`, or `recorder.markExternal(fnOrEmitter)`). External findings use `console.error`, carry `priority: 'high'`, and carry a red **EXTERNAL** badge in the viewer's inspector.

## Production

```bash
npm run build   # packages (dist/), server (apps/server/dist), web app (apps/viewer/dist)
npm start       # runs the server: node apps/server/dist/main.js
```

Set `NODE_ENV=production`, `SUPABASE_URL`, `DATABASE_URL`, `STREAM_SECRET` and `WEB_ORIGINS` for the server (see `apps/server/.env.example`). Build the web app with `VITE_*` set for production and serve `apps/viewer/dist` from any static host. Publish packages with `npm publish -w @ida-dev/<name>`.

Replay never re-runs your code: it plays recorded data back against the graph.

## Scope of the first milestone

Async hops are followed in Node 20.16+ / 22.3+ (`AsyncLocalStorage`) and in Python (`contextvars`); browsers record synchronous causality only until AsyncContext ships, and the `CausalityContext` interface is the seam for it. mitt / eventemitter3 / Vue / React adapters, an in-page overlay and a DevTools extension are not built yet.

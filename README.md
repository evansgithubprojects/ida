# Event Chain Debugger

Makes event-driven JavaScript easy to follow. It records every event in a time window, shows how events connect, and replays the timeline so you can watch pathways light up as events fire.

An event is **who called it and what it called, including payloads**. Handlers are the nodes; each event points at the event that caused it, so chains form a web.

## Packages

| Package | What it does |
| --- | --- |
| [`@eda-debugger/core`](packages/core/README.md) | Recorder, ring buffer, templates, causality, corruption detection, JSON export. No DOM dependency. |
| [`@eda-debugger/adapter-eventemitter`](packages/adapter-eventemitter/README.md) | Records Node `EventEmitter`. |
| [`@eda-debugger/adapter-eventtarget`](packages/adapter-eventtarget/README.md) | Records DOM `EventTarget` (native events and `dispatchEvent`). |
| [`@eda-debugger/cloud`](packages/cloud/README.md) | Uploads recorders to a project on the server; spools locally while offline. |
| `apps/server` | Ingest and project API (Node, Hono, Postgres), with Supabase sign-in. See [its README](apps/server/README.md). |
| `apps/viewer` | The web app: projects, recorders and recordings, plus the replay viewer (also usable locally, without an account). |
| `apps/demo` | Simulated event stream and a browser page that produce recordings. |

## Quick start

```ts
import { enable } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

const recorder = enable({ windowMs: 60_000 });
enableEventEmitterRecording(recorder); // one line: patches EventEmitter.prototype.emit

// ... run your app ...
fs.writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

Open `recording.json` in the viewer (drag and drop), or stream live with `startBridge` from `@eda-debugger/core/bridge-node` and press **Connect live**.

### Projects: upload recorders to the web app

Create a project in the web app, make an ingest key, and add:

```ts
import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

configure({ projectKey: process.env.EDA_PROJECT_KEY!, endpoint: 'https://your-server' });
enableEventEmitterRecording();
connectRecorder('payments').track(paymentsBus); // anywhere: same key, same recorder
```

Each recorder appears under the project with one recording per run of your app, and can be watched live. If the server can't be reached, batches are kept on disk (Node) or in IndexedDB (browser), the console says so, and they are uploaded in order once the connection is back. The viewer marks events that arrived late and gaps where data was lost.

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

Core cannot see inside a handler, so declare what talks to the outside world (`external`, or `recorder.markExternal(fnOrEmitter)`). External findings use `console.error`, carry `priority: 'high'`, and show in the viewer as sticky red **EXTERNAL** toasts.

## Develop

```bash
npm install
npm test                 # all workspaces
npm run build            # core + adapters (ESM, CJS, .d.ts)
npm run demo             # generate a sample recording and open the viewer
npm run demo:live        # stream a looping simulation; press "Connect live" in the viewer
npm run dom -w @eda-debugger/demo   # browser page using the DOM adapter

# Projects web app (copy apps/server/.env.example and apps/viewer/.env.example first)
npm run server           # API on :8787, embedded PGlite unless DATABASE_URL is set
npm run web              # web app on :5173
EDA_PROJECT_KEY=eda_… npm run cloud -w @eda-debugger/demo -- --outage   # upload the demo, with simulated outages
```

Replay never re-runs your code: it plays recorded data back against the graph.

## Scope of the first milestone

Synchronous causality only. Async hops (AsyncLocalStorage / AsyncContext), mitt / eventemitter3 / Vue / React adapters, an in-page overlay and a DevTools extension are not built yet. The `CausalityContext` interface is the seam for async support.

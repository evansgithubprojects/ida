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
| `apps/demo` | A stand-in user app (Node and browser) that uses the built packages and uploads to a project. Dev only. |

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
cp apps/server/.env.example apps/server/.env        # dev Supabase project URL
cp apps/viewer/.env.example apps/viewer/.env.local  # same project's publishable key
npm run dev
```

`npm run dev` builds the packages, then runs everything and rebuilds on change:

| Part | Where |
| --- | --- |
| Packages (`core`, adapters, `cloud`) | `tsup --watch` |
| Server | http://localhost:8787 (embedded PGlite unless `DATABASE_URL` is set) |
| Web app | http://localhost:5173 |
| Demo codebase (`apps/demo`) | Node shop plus a browser page at http://localhost:5174, both using the built packages |

The demo uploads to a project, so: sign in at :5173, create a project, make an ingest key, then `cp apps/demo/.env.example apps/demo/.env` and paste the key. Until then the demo waits and says so. For a simulated outage run `npm run node -w @eda-debugger/demo -- --outage`.

Other scripts: `npm test`, `npm run typecheck`.

## Production

```bash
npm run build   # packages (dist/), server (apps/server/dist), web app (apps/viewer/dist)
npm start       # runs the server: node apps/server/dist/main.js
```

Set `NODE_ENV=production`, `SUPABASE_URL`, `DATABASE_URL`, `STREAM_SECRET` and `WEB_ORIGINS` for the server (see `apps/server/.env.example`). Build the web app with `VITE_*` set for production and serve `apps/viewer/dist` from any static host. Publish packages with `npm publish -w @eda-debugger/<name>`.

Replay never re-runs your code: it plays recorded data back against the graph.

## Scope of the first milestone

Synchronous causality only. Async hops (AsyncLocalStorage / AsyncContext), mitt / eventemitter3 / Vue / React adapters, an in-page overlay and a DevTools extension are not built yet. The `CausalityContext` interface is the seam for async support.

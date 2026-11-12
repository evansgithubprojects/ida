# Quick start: Node.js

This guide records a small order pipeline built on Node's `EventEmitter`, first to a local file and then to a project in the web app. It takes about five minutes.

You need Node 20 or later. On Node 20.16+ or 22.3+, Ida also follows events across `await` and timers (see [Events and causality](../concepts/events-and-causality.md)).

## 1. Install

```bash
npm install @ida-dev/core @ida-dev/adapter-eventemitter
```

## 2. Record

Call `enable()` and install the adapter once, as early as possible in your app's startup, before your emitters are created:

```js
// pipeline.js
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

const recorder = enable({ windowMs: 60_000 }); // keep the last minute
enableEventEmitterRecording();                 // patches EventEmitter.prototype.emit

// An order pipeline: placed -> charge -> ship.
const orders = new EventEmitter();
const payments = new EventEmitter();
const shipping = new EventEmitter();
recorder.labelEmitter(orders, 'Orders');
recorder.labelEmitter(payments, 'Payments');
recorder.labelEmitter(shipping, 'Shipping');

orders.on('order:placed', function chargeCard(order) {
  payments.emit(order.total > 100 ? 'charge:declined' : 'charge:ok', order);
});
payments.on('charge:ok', function shipOrder(order) {
  shipping.emit('ship', order);
});
shipping.on('ship', function printLabel(order) {
  console.log(`order ${order.id} shipped`);
});

for (let id = 1; id <= 6; id++) orders.emit('order:placed', { id, total: id * 30 });

writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

```bash
node pipeline.js
```

Your listeners run exactly as before. The adapter records each emit, the handlers it reached, how long each took, any error thrown, and which event caused it.

> **Tip:** if you don't need options, `import '@ida-dev/adapter-eventemitter/auto';` does both steps (it calls `enable()` and `enableEventEmitterRecording()`).

## 3. View the file

Sign in to the web app, open a project and click **Open viewer**, then click **Recordings** and choose **Open file…** (or drop `recording.json` on the window). The file is read in your browser, not uploaded. See [Opening the viewer](../viewer/recordings.md#from-a-file).

You'll see three processes (Orders, Payments, Shipping). Double-click one to see its handlers, press **Play** to watch the pathways light up, and click `chargeCard` to see every order it handled.

## 4. Upload to a project

Files are fine for one-off debugging. To see every run of your app, and watch it live, upload to a project instead.

1. In the web app, create a project (see [Projects and teams](../projects.md)).
2. Click **Connect an app** and create an **ingest key**. It is shown once: store it as `IDA_PROJECT_KEY`.
3. Install the uploader and call `configure` before anything else:

```bash
npm install @ida-dev/cloud
```

```js
import { configure } from '@ida-dev/cloud';
import { connectRecorder, enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '{{API_URL}}' });
enable();                       // the default recorder: every emitter nothing else claims
enableEventEmitterRecording();

// Optional, anywhere in your app: keep the payments bus in its own recorder.
connectRecorder('payments').track(payments);
```

Run your app. In the project, each recorder (`default` and `payments` here) appears under **Recorders** once it sends data, with one recording per run of your app. **Open viewer** shows them live.

If the server can't be reached, recording carries on: batches are kept in `.ida/spool` and uploaded once the connection is back. Add `.ida/` to your `.gitignore`. See [Offline and delivery](../concepts/offline.md).

## Next steps

- [Recorders](../concepts/recorders.md): split your app into several recorders, and route emitters between them.
- [Naming processes and handlers](../guides/naming.md): make the graph read like your architecture.
- [Choose what gets recorded](../guides/what-gets-recorded.md): emitters from libraries and Node internals.
- [Templates and payloads](../concepts/templates.md): keep full payloads for the events you are debugging.
- [Watching live](live.md): stream events to the viewer as they happen.

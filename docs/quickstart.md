# Quick start

<!-- languages: node, browser, python -->

This guide records a small order pipeline and opens it in the viewer. It takes about five minutes. Pick your language above; the choice carries over to every page in the docs.

:::lang node
You need Node 20 or later. On Node 20.16+ or 22.3+, Ida also follows events across `await` and timers (see [Events and causality](concepts/events-and-causality.md)).
:::

:::lang browser
The packages are ES modules; use them from any bundler (Vite, webpack, esbuild, Next.js client code). Ida records DOM events such as clicks and inputs, and your own `CustomEvent`s.
:::

:::lang python
You need Python 3.9 or later. The SDK has no dependencies of its own. Python and JavaScript services upload to the same projects, and messages between them are linked in the viewer.
:::

## 1. Install

:::lang node
```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventemitter
```
:::

:::lang browser
```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventtarget
```
:::

:::lang python
```bash
pip install ida-sdk                  # your own events only
pip install "ida-sdk[kafka]"         # plus confluent-kafka
pip install "ida-sdk[rabbitmq]"      # plus pika
```
:::

## 2. Get an ingest key

1. Sign in to the web app and create a project (see [Projects and teams](projects.md)).
2. Click **Connect an app** and create an **ingest key**. It is shown once.

Ingest keys can only upload to their project, never read from it. If one leaks, revoke it in the project and make a new one.

:::lang node
Store the key as the `IDA_PROJECT_KEY` environment variable.
:::

:::lang browser
Shipping the key in your bundle is safe, since it can only upload.
:::

:::lang python
Store the key as the `IDA_PROJECT_KEY` environment variable.
:::

## 3. Configure once at startup

Run this once, as early as possible: before your app creates its emitters or adds its listeners.

:::lang node
```js
import { configure } from '@ida-dev/cloud';
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '{{API_URL}}' });
const recorder = enable();     // the default recorder: every emitter nothing else claims
enableEventEmitterRecording(); // patches EventEmitter.prototype.emit
```
:::

:::lang browser
Put this at the very top of your entry module. Listeners added before `enableEventTargetRecording` aren't recorded.

```js
// main.js, first lines
import { configure } from '@ida-dev/cloud';
import { enable } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

configure({ projectKey: 'ida_…', endpoint: '{{API_URL}}' });
const recorder = enable();
enableEventTargetRecording(undefined, {
  label: (t) => (t === document ? 'Page' : undefined), // name the targets you care about
});
```
:::

:::lang python
```python
import os
import ida
import ida.cloud  # import it explicitly: `import ida` alone doesn't load it

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="{{API_URL}}")
ida.enable()  # the default recorder: everything no keyed recorder has claimed
```
:::

## 4. Record your events

Use your events as usual. Ida records each emit, the handlers it reached, how long each took, anything thrown, and which event caused it. Your handlers run exactly as before.

:::lang node
```js
import { EventEmitter } from 'node:events';

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
```

`charge:ok` is recorded as caused by `order:placed`, because it was emitted while `chargeCard` was handling `order:placed`.

> **Tip:** with no options to set, `import '@ida-dev/adapter-eventemitter/auto';` does `enable()` and `enableEventEmitterRecording()` in one line.
:::

:::lang browser
```js
const cart = new EventTarget();
recorder.labelEmitter(cart, 'Cart');

document.querySelector('#add').addEventListener('click', function addToCart() {
  cart.dispatchEvent(new CustomEvent('item:added', { detail: { sku: 'tea-01', qty: 1 } }));
});

cart.addEventListener('item:added', function updateBadge(e) {
  document.querySelector('#badge').textContent = String(e.detail.qty);
});
```

Clicking **Add** records a `click` on `button#add` handled by `addToCart`, which caused `item:added` on Cart, handled by `updateBadge`. For a `CustomEvent` the payload is its `detail`; for native events, fields such as `key`, `button` or `value`.

Busy pages emit a lot (`mousemove`, `scroll`…). To skip targets you don't need, add an `include` option to the `enableEventTargetRecording` call from step 3:

```js
include: (t) => !(t instanceof Element) || t.closest('#checkout') !== null,
```
:::

:::lang python
`ida.Emitter` is a small event emitter that records every emit and handler:

```python
orders = ida.Emitter("Orders")
payments = ida.Emitter("Payments")

@orders.on("placed")
def charge_card(order):
    payments.emit("charged" if order["total"] < 100 else "declined", order)

@payments.on("charged")
def send_receipt(order):
    print("receipt for", order["orderId"])

orders.emit("placed", {"orderId": "o-1", "total": 42})
```

`charged` is recorded as caused by `placed`, because it was emitted while `charge_card` was handling `placed`. Coroutine handlers work too: `await orders.emit_async("placed", order)` awaits each one in turn.

To record Kafka or RabbitMQ instead, see the [Kafka](/docs/kafka?lang=python) and [RabbitMQ](/docs/rabbitmq?lang=python) setup pages.
:::

## 5. Open the viewer

Run your app, then open the project and click **Open viewer**. Your events appear live: double-click a process to see its handlers, press **Play** to watch the pathways light up, and click a handler to see everything it handled. See [Opening the viewer](viewer/recordings.md) and [Replaying a recording](viewer/replay.md).

Each run of your app is one recording. If the server can't be reached, recording carries on and batches are uploaded once the connection is back (see [Offline and delivery](concepts/offline.md)).

:::lang node
Batches wait in `.ida/spool` while offline: add `.ida/` to your `.gitignore`.
:::

:::lang browser
Batches are sent every second and when the tab is hidden. Anything that couldn't be sent waits in IndexedDB until the next visit.
:::

:::lang python
At exit, the SDK spends up to 3 seconds uploading what is left. For a script that ends quickly, flush yourself:

```python
ida.cloud.get_uploader().flush()
```
:::

## Without a project

You can also record to a file and open it in the viewer (**Recordings** → **Open file…**). The file is read in your browser, not uploaded. Leave out `configure` and export what the recorder holds:

:::lang node
```js
import { writeFileSync } from 'node:fs';
writeFileSync('recording.json', JSON.stringify(recorder.export()));
```
:::

:::lang browser
```js
const blob = new Blob([JSON.stringify(recorder.export())], { type: 'application/json' });
const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'recording.json' });
a.click();
```
:::

:::lang python
```python
import json
with open("recording.json", "w") as f:
    json.dump(ida.get_recorder().export(), f)
```
:::

See [Exporting recordings](guides/export-and-format.md).

## Keeping full payloads

Only payload shapes are recorded by default (`{orderId:string,total:number}`), not values. To keep values for the events you are debugging, pass them to the first `enable()` call:

:::lang node,browser
```js
enable({ deepLogging: { events: ['charge:declined'] } });
// or decide per event, from its name and its emitter's label
enable({ deepLogging: { events: (eventName, emitterLabel) => emitterLabel === 'Payments' } });
```
:::

:::lang python
```python
ida.enable(deep_logging=["declined"])
# or decide per event, from its name and its emitter's label
ida.enable(deep_logging=lambda event_name, emitter_label: emitter_label == "Payments")
```
:::

See [Templates and payloads](concepts/templates.md).

## Next steps

- [Recorders](concepts/recorders.md): split your app into several recorders, and route emitters between them.
- [Naming processes and handlers](guides/naming.md): make the graph read like your architecture.
- [Watching live](quickstart/live.md): the live view, and streaming without a project.

:::lang node
- [Choose what gets recorded](guides/what-gets-recorded.md): emitters from libraries and Node internals.
- [EventEmitter adapter reference](reference/adapter-eventemitter.md)
:::

:::lang browser
- [EventTarget adapter reference](reference/adapter-eventtarget.md)
:::

:::lang python
- [Python reference](reference/python.md): every function and option, and how the Python SDK differs from JavaScript.
:::

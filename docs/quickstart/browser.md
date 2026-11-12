# Quick start: browser

This guide records a web page's events, native ones such as clicks and inputs as well as your own `CustomEvent`s, and uploads them to a project.

## 1. Install

```bash
npm install @ida-dev/core @ida-dev/cloud @ida-dev/adapter-eventtarget
```

The packages are ES modules with no DOM-only build step; use them from any bundler (Vite, webpack, esbuild, Next.js client code).

## 2. Create an ingest key

In the web app, open your project, click **Connect an app** and create a key. Ingest keys can only upload, never read, so it is safe to ship one in a browser bundle. If one leaks, revoke it in the project and make a new one.

## 3. Enable recording first

Run this at the very top of your entry module, **before** your app adds any event listeners. Listeners added earlier are not recorded.

```js
// main.js, first lines
import { configure } from '@ida-dev/cloud';
import { connectRecorder } from '@ida-dev/core';
import { enableEventTargetRecording } from '@ida-dev/adapter-eventtarget';

configure({ projectKey: 'ida_…', endpoint: '{{API_URL}}' });

const recorder = connectRecorder('page');
enableEventTargetRecording(recorder, {
  // Name the processes you care about; everything else gets a default name.
  label: (t) => (t === document ? 'Page' : undefined),
});
```

Then use the DOM as usual:

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

Clicking **Add** records a `click` on `button#add` handled by `addToCart`, which caused `item:added` on Cart, handled by `updateBadge`.

## What the payload is

For a `CustomEvent`, the payload is its `detail`. For native events, it is whichever of `key`, `code`, `button`, `clientX`, `clientY`, `data`, `inputType` and `value` the event has. Only the payload's shape is kept unless you turn on [deep logging](../concepts/templates.md#keeping-full-payloads) for that event.

## Recording only part of the page

Busy pages emit a lot (`mousemove`, `scroll`, `pointerover`…). Use `include` to skip targets you don't need:

```js
enableEventTargetRecording(recorder, {
  include: (t) => !(t instanceof Element) || t.closest('#checkout') !== null,
});
```

## Leaving the page

Batches are sent every second, and once more when the tab is hidden. Anything that couldn't be sent waits in IndexedDB and is uploaded on the next visit (see [Offline and delivery](../concepts/offline.md)).

## Next steps

- [EventTarget adapter reference](../reference/adapter-eventtarget.md)
- [Opening the viewer](../viewer/recordings.md) and [Replaying a recording](../viewer/replay.md)
- [Recorders](../concepts/recorders.md): several recorders on one page.

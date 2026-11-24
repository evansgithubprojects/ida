# Choose what gets recorded

A Node process is full of emitters: yours, your dependencies', and Node's own. Recording all of them would bury your events in noise, so the EventEmitter adapter picks a sensible default. This page explains the default and how to change it. For the browser, see [the EventTarget section](#browser) below.

## The default in Node

| Emitter | Recorded? |
| --- | --- |
| Created by your code (its class, or the `new EventEmitter()` call, is in your app's files) | Yes, every event. |
| Created by an installed package (its class lives in `node_modules`) | Only events your code listens to. `ws.on('message', onMessage)` records `message`, but not the library's internal events. |
| Node internals: streams, sockets, servers, `process`, file handles, workers, child processes, watchers, and the connection pools behind `fetch` | No. |
| Any emitter a recorder `track()`s | Yes, every event, whoever created it. |

"Your app's files" means anything outside `node_modules` and Node itself. The adapter decides from where an emitter's class is defined, or where a plain `EventEmitter` is constructed. An emitter created before the adapter was installed is classified by whoever first emits on it.

Ignoring internals also means the uploader in `@ida-dev/cloud` never records its own uploads.

## Recording more

Record everything installed packages emit:

```js
enableEventEmitterRecording(undefined, { includeLibraries: true });
```

Or just one library emitter, by tracking it:

```js
const socket = new WebSocket(url);
getRecorder().track(socket);
```

Treat some packages as your own code, for example your company's scoped packages or a monorepo's linked workspaces:

```js
enableEventEmitterRecording(undefined, {
  isAppFile: (file) => !file.includes('node_modules') || file.includes('node_modules/@acme/'),
});
```

Record Node's internals too (very noisy; mostly useful when debugging streams):

```js
enableEventEmitterRecording(undefined, { includeInternals: true });
```

## Recording less

`include` runs after the built-in rules and can veto any emitter:

```js
enableEventEmitterRecording(undefined, {
  include: (emitter) => !(emitter instanceof MetricsBus),
});
```

To pause recording entirely for a while, `recorder.stop()` and `recorder.start()`. To record only certain emitters, don't call `enable()`; `track()` the ones you want with keyed recorders. With no default recorder, untracked emitters aren't recorded. The adapter warns once about an emit that went nowhere; turn that off with `warnIfNoRecorder: false` if it's intended.

## Turning on recording without code changes

```js
import '@ida-dev/adapter-eventemitter/auto';
```

This side-effect import calls `enable()` and `enableEventEmitterRecording()` with defaults. You can also load it from the command line, with no change to your code:

```bash
node --import @ida-dev/adapter-eventemitter/auto app.js
```

## Browser

The EventTarget adapter records every target by default: `window`, `document`, every element, and every `EventTarget` you create. Narrow it with `include`:

```js
enableEventTargetRecording(recorder, {
  include: (t) => !(t instanceof Element) || t.closest('[data-ida]') !== null,
});
```

Only listeners added **after** `enableEventTargetRecording` are recorded, so call it before your app registers its listeners. Listeners on targets `include` rejects are never wrapped, so they cost nothing.

## Payload values

None of these settings decide whether values are kept. Every event is template-only unless [deep logging](../concepts/templates.md#keeping-full-payloads) matches it.

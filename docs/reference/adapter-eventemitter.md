# @ida-dev/adapter-eventemitter

Records every emit on Node `EventEmitter`s, and anything built on them, with its handlers, timings, errors and cause.

```bash
npm install @ida-dev/core @ida-dev/adapter-eventemitter
```

## enableEventEmitterRecording

```ts
function enableEventEmitterRecording(recorder?: Recorder, options?: EventEmitterAdapterOptions): Uninstall
```

Patches `EventEmitter.prototype.emit` so every emit is recorded. Your listeners behave exactly as before: they run in the same order, and errors propagate the same way.

| Parameter | |
| --- | --- |
| `recorder` | Where to record. Leave it out to [route](../concepts/recorders.md#routing-which-recorder-records-an-event) each emitter to the recorders that `track()` it, or else to the default recorder. |
| `options` | See below. |

Returns a function that restores the original `emit`.

```js
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

enable();
const uninstall = enableEventEmitterRecording();
// ...
uninstall();
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `include` | `(emitter: EventEmitter) => boolean` | record all | Return `false` to leave an emitter unrecorded. Runs after the built-in rules. |
| `includeInternals` | `boolean` | `false` | Also record Node internals: streams, sockets, servers, `process`, file handles, workers, child processes, watchers, and the connection pools behind `fetch`. Noisy. |
| `includeLibraries` | `boolean` | `false` | Record every event of emitters created by installed packages. By default those are recorded only for events your code listens to, or when tracked. |
| `isAppFile` | `(file: string) => boolean` | outside `node_modules` | Decides which source files are your app, from where an emitter's class is defined (or where a plain `EventEmitter` is created). |
| `warnIfNoRecorder` | `boolean` | `true` | Print one console warning the first time an emit has no recorder to go to. Ignored when you pass a recorder. |

See [Choose what gets recorded](../guides/what-gets-recorded.md) for how these fit together.

## What is recorded for each emit

| | |
| --- | --- |
| Event name | The first argument to `emit`. A symbol is recorded as `Symbol(description)`. |
| Payload | The second argument, or the array of every argument after the name when there is more than one. |
| Handlers | Every listener, in order. `once` listeners are recorded as the function you passed, not Node's wrapper. |
| Errors | An error thrown by a listener is recorded on it, then propagates. An `error` emit with no listener still throws, as in Node. |

## The /auto entry

```js
import '@ida-dev/adapter-eventemitter/auto';
```

Calls `enable()` and `enableEventEmitterRecording()` with defaults. Load it without touching your code with `node --import @ida-dev/adapter-eventemitter/auto app.js`.

## Exports

| Export | |
| --- | --- |
| `enableEventEmitterRecording` | See above. |
| `enable` | Re-exported from `@ida-dev/core`. |
| `Uninstall` | `() => void` |
| `EventEmitterAdapterOptions` | The options type. |

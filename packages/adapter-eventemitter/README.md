# @ida-dev/adapter-eventemitter

Records every emit on Node `EventEmitter`s (and anything built on them) with its handlers, timings, errors and cause. Part of [Ida](../../README.md).

```bash
npm install @ida-dev/core @ida-dev/adapter-eventemitter
```

## Setup

```ts
import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

const recorder = enable({ windowMs: 60_000 });
const uninstall = enableEventEmitterRecording(recorder);
```

Or, with no configuration, record on the shared recorder:

```ts
import '@ida-dev/adapter-eventemitter/auto';
```

Your listeners behave exactly as before. Call `uninstall()` to stop recording.

## `enableEventEmitterRecording(recorder?, options?)`

`recorder` defaults to the shared recorder from `enable()`. Returns an `Uninstall` function.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `include` | `(emitter) => boolean` | record all | Return `false` to leave an emitter unrecorded. Runs after the built-in ignore list. |
| `includeInternals` | `boolean` | `false` | Also record Node internals (streams, sockets, servers, `process`). Noisy. |

## What is ignored

Node's own plumbing (streams, sockets, `process`, fs handles, workers) is skipped unless `includeInternals: true`.

## Naming things

Processes and handlers are named by the recorder, so label them there:

```ts
recorder.labelEmitter(paymentsBus, 'Payments');
recorder.labelHandler(onOrder, 'charge card');
```

## Documentation

Quick starts, guides and the full API reference are in the **Docs** section of the Ida web app, and in the repo's [`docs/`](../../docs/overview.md) folder.

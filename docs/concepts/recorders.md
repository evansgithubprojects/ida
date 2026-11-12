# Recorders

A **recorder** holds the events recorded for one part of your app: a time window of occurrences, their templates, and the processes and handlers they involve. Each recorder is uploaded and shown on its own in the viewer.

Most apps need just one, from `enable()`. Use several when one process does several jobs you want to look at separately (an API and a background worker, or payments and everything else).

## Getting a recorder

| Call | Returns |
| --- | --- |
| `enable(options?)` | The shared recorder with key `default`. The first call also makes it the **default recorder**. |
| `connectRecorder(key, options?)` | The recorder named `key`, created on first use. Call it with the same key anywhere and you get the same recorder, so there is nothing to pass around. |
| `createRecorder(options?)` | A new, independent recorder that isn't registered under a key. It is not uploaded by `@ida-dev/cloud`; pass it to an adapter yourself. Useful in tests. |
| `getRecorder()` | The `default` recorder, or `undefined` before `enable()`. |
| `getRecorders()` | Every keyed recorder, in creation order. |

Options apply only on the call that creates the recorder; later calls with the same key return it unchanged. Keys are 1–64 characters: letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit.

```js
// payments/bus.js
import { connectRecorder } from '@ida-dev/core';
export const paymentsBus = new EventEmitter();
connectRecorder('payments', { windowMs: 10 * 60_000 }).track(paymentsBus);

// anywhere else
connectRecorder('payments').labelHandler(retryCharge, 'retry charge');
```

## Routing: which recorder records an event

When an adapter is installed **without** a recorder (`enableEventEmitterRecording()`), each emit is routed by its emitter:

1. If one or more recorders `track()` the emitter, it goes to each of them.
2. Otherwise it goes to the **default recorder**.
3. If there is no default recorder, it isn't recorded (and the adapter prints a one-time warning).

```js
enable();                                       // default: everything not claimed below
connectRecorder('payments').track(paymentsBus); // payments bus goes here instead
connectRecorder('audit').track(paymentsBus);    // ...and here too
enableEventEmitterRecording();
```

- Several recorders can track one emitter. Its listeners still run **once**; each recorder records the event.
- `recorder.untrack(emitter)` releases an emitter back to the default.
- `setDefaultRecorder(recorder)` changes the default; `setDefaultRecorder(null)` records only tracked emitters.
- For brokers, track the client: the `Kafka` instance (kafkajs), the connection or channel (amqplib), a producer, consumer or pika connection (Python).

When you **pass** a recorder to an adapter (`enableEventEmitterRecording(recorder)`), routing is skipped and that recorder records everything the adapter sees.

### Parent links stay inside a recorder

Causality is tracked per recorder. If an event recorded in `payments` causes an event recorded only in `default`, the second one starts a new chain in `default`. Track an emitter in both recorders if you want the chain in both.

## Starting, stopping and clearing

```js
const recorder = enable({ autoStart: false });
// ...
recorder.start();   // record from here
recorder.stop();    // pause; what was recorded is kept
recorder.clear();   // forget what was recorded
recorder.recording; // true while recording
```

Events emitted while a recorder is stopped are not recorded, and their listeners run normally.

## The window

Each recorder keeps a rolling window, bounded by time and by count, whichever is smaller:

| Option | Default |
| --- | --- |
| `windowMs` | 300 000 (5 minutes) |
| `maxEvents` | 50 000 |

Older occurrences are dropped as new ones arrive. This bounds memory in long-running apps. When uploading to a project, everything is uploaded as it happens, so the server keeps the whole run; the window only limits what the process holds in memory and what `export()` returns.

## Sessions

Each recorder has a `sessionId` (a UUID) for the life of the process. Every run of your app is therefore one recording per recorder in the web app.

## Next steps

- [Naming processes and handlers](../guides/naming.md)
- [`Recorder` reference](../reference/core.md#the-recorder)

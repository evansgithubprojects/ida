# @eda-debugger/core

Recorder for [Ida](../../README.md): templates, causality, corruption detection and JSON export. No DOM or Node-only imports, except the optional `@eda-debugger/core/bridge-node`.

```bash
npm install @eda-debugger/core
```

You normally pair it with an adapter ([`adapter-eventemitter`](../adapter-eventemitter/README.md), [`adapter-eventtarget`](../adapter-eventtarget/README.md)), which calls the recorder for you.

## Quick start

```ts
import { enable } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

const recorder = enable({ windowMs: 60_000 });
enableEventEmitterRecording(recorder);

// ... run your app ...
fs.writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

Open `recording.json` in the viewer, or stream live with `startBridge` (below).

## Creating a recorder

- `connectRecorder(key, options?)` returns the recorder named `key`, creating it on first use. Call it with the same key anywhere in your app to get the same recorder, with no need to pass it around. Options only apply to the call that creates it. Keys are 1-64 letters, digits, `.`, `_`, `:` or `-`.
- `enable(options?)` is `connectRecorder('default')`, and the first call also makes it the default recorder (below). `getRecorder()` returns it, or `undefined` before `enable()`.
- `createRecorder(options?)` always creates a new, independent recorder that isn't in the keyed registry.
- `getRecorders()` lists the keyed recorders; `onRecorder(listener)` is called for each existing and future one (uploaders use it).

### Several recorders: which one records an event

Adapters installed without a recorder route every emit by its emitter:

```ts
enable();                                       // the default recorder gets everything...
connectRecorder('payments').track(paymentsBus); // ...except emitters another recorder claims
enableEventEmitterRecording();
```

- An emitter tracked by one or more recorders (`recorder.track(emitter)`) is recorded by each of them; its listeners still run once. `untrack` releases it.
- Every other emitter goes to the default recorder, set by `enable()` or `setDefaultRecorder(recorder)`. With `setDefaultRecorder(null)`, only tracked emitters are recorded.
- Parent links don't cross recorders: an event recorded in one, caused by an event recorded in another, starts a new chain.

Passing a recorder to an adapter (`enableEventEmitterRecording(recorder)`) skips routing: that recorder gets everything.

To upload recorders to a project in the web app, see [`@eda-debugger/cloud`](../cloud/README.md).

### `RecorderOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `windowMs` | `number` | `300000` | How much history to keep, in milliseconds. |
| `maxEvents` | `number` | `50000` | The most events to keep, whatever the window. |
| `deepLogging` | `{ events }` | none | Events whose full payload is kept. All others are template-only. `events` is a list of names or `(eventName, emitterLabel) => boolean`. |
| `capture` | `{ events }` | none | Alias of `deepLogging`. |
| `templateKey` | `(parts) => string` | `defaultTemplateKey` | How events are grouped into templates. Default: emitter + event name + handler set + payload shape. |
| `corruption` | `CorruptionOptions` | see below | Detection of suspected corrupt payloads. |
| `context` | `CausalityContext` | `SyncStackContext` | Tracks which event is being handled. Swap it to support async hops. |
| `autoStart` | `boolean` | `true` | Start recording immediately. When `false`, call `recorder.start()`. |
| `now` | `() => number` | `performance.now` | Clock for timestamps, in milliseconds. |

```ts
createRecorder({
  deepLogging: { events: ['order:confirmed'] },
  templateKey: (p) => `${p.emitterId}|${p.eventName}`, // group by emitter and name only
});
```

### `CorruptionOptions`

Findings are always recorded and shown in the viewer. These options control how they are reported and whether they block the event.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `notify` | `'console' \| fn \| Array` | none | Where findings are reported. External findings use `console.error`. |
| `policy` | `'notify' \| 'block'` | `'notify'` | `'block'` throws `SuspectedCorruptionError` from `emit` instead of calling any handler. |
| `externalPolicy` | `'notify' \| 'block'` | `policy` | Policy for payloads headed to an external system. |
| `external` | `{ events, handlers, emitters }` | none | What counts as an external system (HTTP APIs, databases, third parties). Findings reaching these have `priority: 'high'`. |
| `detectUntainted` | `boolean` | `true` | Also flag suspect payloads that no failure points to. |
| `taintWindowMs` | `number` | `1000` | How long a failure keeps its handler or emitter suspect. |
| `taintCount` | `number` | `5` | ...or for this many of its next emits, whichever ends first. |
| `taintDepth` | `number` | `1` | How many hops a flagged payload keeps tainting the events emitted because of it. |

Core can't see inside a handler, so declare what talks to the outside world with `external`, or `recorder.markExternal(fnOrEmitter)`.

## The `Recorder`

| Member | Description |
| --- | --- |
| `key` | The name given with `connectRecorder(key)` or the `key` option. |
| `track(emitter)` / `untrack(emitter)` | Claim an emitter for this recorder (see routing above). |
| `start()` / `stop()` | Resume or pause recording. What was recorded is kept. |
| `recording` | Whether events are currently being recorded. |
| `export()` | A versioned, JSON-serializable `Recording`. |
| `clear()` | Forget everything recorded so far. |
| `subscribe(listener)` | Receive each new occurrence and finding. Returns a function that unsubscribes. |
| `labelEmitter(emitter, label)` | Name an emitter's process in the viewer. |
| `labelHandler(fn, label)` | Name a handler. Defaults to the function's name. |
| `markExternal(target)` | Mark a handler or emitter as delivering to an external system. |
| `dispatch(info, run)` | For adapter authors, see below. |

## Analyzing a recording

```ts
import { analyze } from '@eda-debugger/core';
const findings = analyze(JSON.parse(fs.readFileSync('recording.json', 'utf8')));
```

`analyze(recording, options?)` replays the live detection rules in time order, so it also finds payloads emitted before their handler threw. `options` are the same detection options as `corruption`.

## Live viewing: `@eda-debugger/core/bridge-node`

```ts
import { startBridge } from '@eda-debugger/core/bridge-node';
const bridge = await startBridge(recorder, { port: 7777 });
// in the viewer, open the recorder dropdown and choose "View Remote Endpoint"; later: await bridge.close();
```

Streams a snapshot on connect, then every new occurrence and finding, over Server-Sent Events. `port` defaults to `7777` (use `0` for a free one) and `host` to `127.0.0.1`. Keep it on loopback: the stream carries your event data.

## The recording format

`recorder.export()` returns a `Recording` with `version` (`RECORDING_VERSION`), `startedAt`, `processes`, `nodes` (handlers and emitters), `templates`, `occurrences` and `findings`. `capture: 'full'` occurrences also carry a JSON-safe `payload`; values JSON can't carry are encoded as tagged objects that `isTag()` detects. All types are exported.

## Writing an adapter

An adapter hooks a dispatcher and reports each emit:

```ts
recorder.dispatch(
  { emitter, eventName, handlers, payload, label: 'Payments' },
  (invoke) => {
    for (const h of handlers) invoke(h, () => h(payload)); // time and attribute each handler
    return true;
  },
);
```

Call every listener through `invoke` so its timing, errors and any events it emits are attributed to it. Causality tracking is swappable through `CausalityContext` (for example `AsyncLocalStorage`).

To support routing, find the recorders with `recordersFor(emitter)` and record through all of them with `dispatchAll(recorders, info, run)`, which nests their `dispatch` calls and runs the listeners once.

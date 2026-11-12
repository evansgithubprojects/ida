# @ida-dev/core

The recorder: keyed recorders and routing, templates, causality, suspected-corruption detection, JSON export, and a local live bridge. It has no DOM or Node-only imports, except the optional `@ida-dev/core/bridge-node` entry.

```bash
npm install @ida-dev/core
```

You normally pair it with an adapter, which calls the recorder for you: [EventEmitter](adapter-eventemitter.md), [EventTarget](adapter-eventtarget.md), [kafkajs](adapter-kafkajs.md) or [amqplib](adapter-amqplib.md).

## Getting a recorder

### enable

```ts
function enable(options?: Omit<RecorderOptions, 'key'>): Recorder
```

Returns the shared recorder, `connectRecorder('default', options)`. The first call also makes it the [default recorder](#setdefaultrecorder), so adapters installed without a recorder record every emitter nothing else claims into it.

`options` apply only on the first call; later calls return the same recorder and ignore them.

```js
const recorder = enable({ windowMs: 60_000, deepLogging: { events: ['order:confirmed'] } });
```

### connectRecorder

```ts
function connectRecorder(key: string, options?: Omit<RecorderOptions, 'key'>): Recorder
```

Returns the recorder named `key`, creating it on first use. Calling it with the same key anywhere in your app returns the same recorder. `options` apply only on the call that creates it.

| Parameter | |
| --- | --- |
| `key` | 1–64 characters: letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit (`RECORDER_KEY`). It names the recorder in the web app. |
| `options` | [`RecorderOptions`](#recorderoptions). |

Throws a `TypeError` for an invalid key:

```
[ida] invalid recorder key "my key": use 1-64 letters, digits, '.', '_', ':' or '-'
```

```js
connectRecorder('payments').track(paymentsBus);
```

### createRecorder

```ts
function createRecorder(options?: RecorderOptions): Recorder
```

Creates a new, independent recorder that isn't registered under a key. `@ida-dev/cloud` doesn't upload it, and routing never sends it anything: pass it to an adapter yourself. Useful in tests.

### getRecorder

```ts
function getRecorder(): Recorder | undefined
```

The shared `default` recorder, or `undefined` before `enable()` (or `connectRecorder('default')`) has been called.

### getRecorders

```ts
function getRecorders(): Recorder[]
```

Every keyed recorder, in the order they were created.

### onRecorder

```ts
function onRecorder(listener: (recorder: Recorder) => void): () => void
```

Calls `listener` for each keyed recorder that exists now, then for each one created later. Returns a function that stops listening. This is how `@ida-dev/cloud` finds recorders to upload.

### setDefaultRecorder

```ts
function setDefaultRecorder(recorder: Recorder | null): void
function getDefaultRecorder(): Recorder | null
```

The default recorder receives every emit whose emitter no recorder [tracks](#track-untrack). `enable()` sets it on its first call if none is set. Pass `null` to record only tracked emitters.

### Constants

| Name | Value |
| --- | --- |
| `DEFAULT_RECORDER_KEY` | `'default'` |
| `RECORDER_KEY` | `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/` |
| `RECORDING_VERSION` | `2`, the current [recording format](recording-format.md) version. |

## RecorderOptions

All fields are optional.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `key` | `string` | `'unnamed'` | The recorder's name. Set by `connectRecorder`; only meaningful for `createRecorder`. |
| `windowMs` | `number` | `300000` | How much history to keep, in milliseconds. Older events are dropped as new ones arrive. |
| `maxEvents` | `number` | `50000` | The most events to keep, whatever the window. |
| `deepLogging` | `CaptureRule` | none | Events whose full payload is kept. All others are template-only. See below. |
| `capture` | `CaptureRule` | none | Alias of `deepLogging`. `deepLogging` wins if both are set. |
| `templateKey` | `(parts: TemplateParts) => string` | `defaultTemplateKey` | How events are grouped into templates. See [Templates](../concepts/templates.md#custom-grouping). |
| `corruption` | [`CorruptionOptions`](#corruptionoptions) | see below | Detection of suspected corrupt payloads. |
| `context` | [`CausalityContext`](#causality-contexts) | `defaultContext()` | Tracks which event is being handled. `AsyncStorageContext` on Node 20.16+ / 22.3+, `SyncStackContext` elsewhere. |
| `autoStart` | `boolean` | `true` | Start recording immediately. When `false`, call `recorder.start()`. |
| `now` | `() => number` | `performance.now` | Clock for timestamps, in milliseconds. |

### CaptureRule

```ts
type CaptureRule = { events?: string[] | ((eventName: string, emitterLabel: string) => boolean) } | undefined
```

```js
enable({ deepLogging: { events: ['order:confirmed'] } });
enable({ deepLogging: { events: (name, emitter) => emitter === 'Payments' || name.startsWith('error') } });
```

## CorruptionOptions

Findings are always recorded and shown in the viewer. These options control how they are reported and whether a flagged emit is blocked. See [Suspected corrupt payloads](../guides/corruption.md).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `notify` | `'console' \| (finding) => void \| Array<'console' \| (finding) => void>` | none | Where findings are reported as they happen. `'console'` uses `console.warn`, or `console.error` for high priority. |
| `policy` | `'notify' \| 'block'` | `'notify'` | `'block'` throws [`SuspectedCorruptionError`](#suspectedcorruptionerror) from the emit instead of calling any handler. |
| `externalPolicy` | `'notify' \| 'block'` | `policy` | Policy for findings headed to an external system (`priority: 'high'`). |
| `external` | `{ events?, handlers?, emitters? }` | none | What counts as an external system. `events` is a list of names or `(eventName, emitterLabel) => boolean`; `handlers` a list of functions; `emitters` a list of emitters. |
| `detectUntainted` | `boolean` | `true` | Also flag suspect payloads that no failure points to. |
| `taintWindowMs` | `number` | `1000` | How long a failure keeps its handler or emitter suspect. |
| `taintCount` | `number` | `5` | …or for this many of its next emits, whichever ends first. |
| `taintDepth` | `number` | `1` | How many hops a flagged payload keeps tainting the events emitted because of it. |

## The Recorder

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `key` | `string` | The recorder's name. |
| `sessionId` | `string` | A UUID for this run. Each run is one recording in the web app. |
| `recording` | `boolean` | Whether events are being recorded right now. |

### track / untrack

```ts
track(emitter: object): void
untrack(emitter: object): void
```

Claims an emitter for this recorder, so adapters installed without a recorder send its events here instead of to the default recorder. Several recorders can track one emitter; each records its events, and its listeners still run once. For the EventEmitter adapter, tracking also records an emitter created by a library or by Node. `untrack` releases it.

For brokers, track the client: the `Kafka` instance (kafkajs), or the amqplib connection or channel.

### start / stop

```ts
start(): void
stop(): void
```

Resume or pause recording. What was recorded is kept. Events emitted while stopped aren't recorded; their listeners run as usual.

### export

```ts
export(): Recording
```

A JSON-serializable snapshot of what the recorder holds: the occurrences in its window, with their templates, processes and nodes, and the findings about them. See the [recording format](recording-format.md).

```js
writeFileSync('recording.json', JSON.stringify(recorder.export()));
```

### clear

```ts
clear(): void
```

Forgets every occurrence, template and finding, and the baselines corruption detection compares against. Labels, and the processes and handlers already seen, are kept.

### subscribe

```ts
subscribe(listener: (message: RecorderMessage) => void): () => void
```

Calls `listener` with each new occurrence (`{ type: 'occurrence', occurrence, template, nodes, processes }`) and each finding (`{ type: 'finding', finding }`). Returns a function that unsubscribes.

An occurrence whose handlers returned promises is delivered twice with the same `id`: once when the emit returns, and again when the promises settle, with the final `durationMs`. Replace the earlier one by id.

### labelEmitter

```ts
labelEmitter(emitter: object, label: string): void
```

Names an emitter's process in the viewer. Emitters with the same label share a process. Call it before the emitter's first recorded event: once seen, a process keeps its name. See [Naming](../guides/naming.md).

### labelHandler

```ts
labelHandler(fn: Function, label: string): void
```

Names a handler. Without a label, handlers are named after the function (`fn.name`), or `anonymous#n`.

### markExternal

```ts
markExternal(target: object | Function): void
```

Marks a handler (a function) or an emitter (an object) as delivering to an external system, such as an HTTP API or a database. Suspected corrupt payloads reaching it get `priority: 'high'`, and the viewer shows an **EXTERNAL** badge.

### wallTime

```ts
wallTime(): number
```

The current time in epoch milliseconds, on the recorder's monotonic clock: the time it started plus the time since. It doesn't jump when the system clock changes.

### dispatch

```ts
dispatch<T>(info: DispatchInfo, run: (invoke: Invoke, recorded?: Recorded) => T): T
```

For adapter authors: records one emit and runs it. See "Writing an adapter" in the `@ida-dev/core` package README.

## Analysis

### analyze

```ts
function analyze(
  recording: Recording,
  options?: { detectUntainted?: boolean; taintWindowMs?: number; taintCount?: number; taintDepth?: number },
): Finding[]
```

Runs the suspected-corruption rules over a recording, in time order, and returns the findings. The options mean the same as in [`CorruptionOptions`](#corruptionoptions). Which systems were external is taken from the recording. It also catches payloads emitted before a later failure in the same handler run (`retroactive: true`).

```js
const findings = analyze(JSON.parse(readFileSync('recording.json', 'utf8')));
```

### SuspectedCorruptionError

```ts
class SuspectedCorruptionError extends Error {
  readonly name: 'SuspectedCorruptionError';
  readonly finding: Finding;
}
```

Thrown from `emit` when a policy is `'block'` and the payload is flagged. No handler runs, and the occurrence is recorded with `blocked: true`. Its message is `Blocked emit: <summary>`.

## Live bridge

`@ida-dev/core/bridge-node` streams a recorder to the viewer from a Node process, with no server. See [Watching live](../quickstart/live.md#local-bridge).

### startBridge

```ts
import { startBridge } from '@ida-dev/core/bridge-node';

function startBridge(recorder: Recorder, options?: BridgeOptions): Promise<Bridge>
```

| Option | Default | |
| --- | --- | --- |
| `port` | `7777` | Port to listen on. `0` picks a free one. |
| `host` | `'127.0.0.1'` | Interface to listen on. Keep it on loopback: the stream carries your event data. |

Returns a `Bridge` with `port` (the port it listens on) and `close(): Promise<void>`. Rejects if the server can't start, for example when the port is in use.

Each client receives `{ type: 'snapshot', recording }` on connecting, then every [`RecorderMessage`](recording-format.md#recordermessage), as Server-Sent Events.

## Templates and shapes

### payloadShape

```ts
function payloadShape(value: unknown): string
```

The value-free shape of a payload, as used in templates: `{orderId:string,total:number}`. See [Payload shapes](../concepts/templates.md#payload-shapes) for the rules.

### defaultTemplateKey

```ts
const defaultTemplateKey: (parts: TemplateParts) => string
```

The default grouping: emitter id, event name, sorted handler ids and payload shape. `TemplateParts` is `{ emitterId: string; eventName: string; handlerIds: string[]; payloadShape: string }`.

### isTag

```ts
function isTag(value: unknown, kind?: string): value is { $eda: string }
```

Whether a value in a captured payload is a tagged stand-in for something JSON can't carry (`{ "$eda": "Date", "v": "…" }`). Pass `kind` to check for one kind. See [Limits on captured payloads](../concepts/templates.md#limits-on-captured-payloads).

## Causality contexts

How a recorder knows which event is being handled. The default fits most apps; replace it to bring your own async context.

```ts
interface CausalityContext<F> {
  current(): F | undefined;
  run<R>(frame: F, fn: () => R): R;
  isAsync?(): boolean; // true when called outside the handler's synchronous part
}
```

| Export | |
| --- | --- |
| `SyncStackContext` | A plain stack: synchronous links only. The default in browsers and older Node. |
| `AsyncStorageContext` | `new AsyncStorageContext(storage)` with an `AsyncLocalStorage` (or anything with `getStore()` and `run(store, fn)`). Follows `await` and timers; links made after the handler's synchronous part are *inferred*. |
| `defaultContext()` | `AsyncStorageContext` when Node's `async_hooks` is available through `process.getBuiltinModule` (Node 20.16+, 22.3+), else `SyncStackContext`. |

## Message headers

Helpers for propagating causality through message brokers. The Kafka and RabbitMQ adapters use them; you only need them to link messages through a transport Ida has no adapter for.

| Export | |
| --- | --- |
| `PARENT_HEADER` | `'ida-parent'` |
| `formatParentHeader({ sessionId, occurrenceId })` | `'1:<sessionId>:<occurrenceId>'` |
| `parseParentHeader(value)` | Parses a header from a string or UTF-8 bytes. Returns `{ sessionId, occurrenceId }`, or `undefined` for anything malformed. |
| `brokerProcessId(broker, kind, name, cluster?)` | The deterministic process id of a topic, exchange or queue, shared by every service: `kafka:<cluster>:topic:<name>`. |

## Adapter-author exports

`DispatchInfo`, `Invoke`, `Recorded`, `Frame`, `BrokerRef`, `dispatchAll`, `recordersFor` and `isTracked` are for writing adapters. They're described in the package README's "Writing an adapter" section.

## Types

Every type in the [recording format](recording-format.md) is exported: `Recording`, `Process`, `GraphNode`, `Template`, `Occurrence`, `HandlerResult`, `ErrorInfo`, `Finding`, `Reason`, `ReasonCode`, `DiffEntry`, `Gap`, `RecorderMessage`, `IngestBatch`, `JsonValue`, `Capture`, `Confidence`.

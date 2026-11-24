# Recording format

The JSON that `recorder.export()` returns, that the viewer opens, and that the uploader sends to the server. All types are exported from `@ida-dev/core`. The current version is `2` (`RECORDING_VERSION`); every version 1 recording is valid version 2.

Times are milliseconds. `startedAt` is wall-clock (epoch ms); every other time (`ts`) counts from the recorder's start.

## Recording

| Field | Type | |
| --- | --- | --- |
| `version` | `number` | Format version. |
| `startedAt` | `number` | When the recorder started, epoch ms. |
| `processes` | `Process[]` | Groups of emitters. |
| `nodes` | `GraphNode[]` | Handlers and emitters. |
| `templates` | `Template[]` | What occurrences have in common. |
| `occurrences` | `Occurrence[]` | One per recorded event. |
| `findings` | `Finding[]` | Suspected corrupt payloads (JavaScript only). Optional. |
| `gaps` | `Gap[]` | Stretches lost to offline spool overflow. Optional; set by the server. |

## Process

| Field | Type | |
| --- | --- | --- |
| `id` | `string` | `p1`, or for brokers `kafka:<cluster>:topic:<name>` (and so on), the same in every service. |
| `label` | `string` | The process's name. |
| `kind` | `'emitter' \| 'topic' \| 'exchange' \| 'queue'` | Optional; `'emitter'` when absent. |
| `broker` | `{ type: 'kafka' \| 'rabbitmq'; cluster?: string }` | For topics, exchanges and queues. `cluster` is the Kafka cluster name or the RabbitMQ vhost. |

## GraphNode

| Field | Type | |
| --- | --- | --- |
| `id` | `string` | `h1` for handlers, `em1` for emitters. |
| `processId` | `string` | The process it belongs to. A handler belongs to the process of the first emitter it was seen on. |
| `label` | `string` | Its name. |
| `kind` | `'handler' \| 'emitter'` | |

## Template

| Field | Type | |
| --- | --- | --- |
| `id` | `string` | `t1`… |
| `key` | `string` | The grouping key (see `templateKey`). |
| `emitterId` | `string` | The emitter node. |
| `eventName` | `string` | |
| `handlerIds` | `string[]` | Handler nodes the event reached. |
| `payloadShape` | `string` | e.g. `{orderId:string,total:number}`. |
| `sampleCount` | `number` | How many occurrences used it. |
| `external` | `string[]` | Labels of the external systems it reaches. Optional. |

## Occurrence

| Field | Type | |
| --- | --- | --- |
| `id` | `string` | `e1`… Unique within its recording. |
| `templateId` | `string` | |
| `parentId` | `string \| null` | The occurrence that caused it, in the same recording. |
| `sourceNodeId` | `string` | The handler that was running when it was emitted, or the emitter node for a root event. |
| `ts` | `number` | When it was emitted. |
| `durationMs` | `number` | Until every handler finished, including promises they returned. |
| `handlerResults` | `HandlerResult[]` | One per handler, in order. |
| `capture` | `'template' \| 'full'` | Whether the payload's values were kept. |
| `payload` | JSON | Only when `capture` is `'full'`. Values JSON can't carry are [tags](../concepts/templates.md#limits-on-captured-payloads). |
| `causality` | `'sync' \| 'inferred' \| 'propagated'` | How the parent link was made. See [Events and causality](../concepts/events-and-causality.md). |
| `remoteParent` | `{ sessionId, occurrenceId }` | The occurrence in another recording that caused this one, from a message header. Optional. |
| `meta` | `Record<string, JSON>` | Broker facts: topic, partition, offset, exchange, routing key… Optional. |
| `signalsError` | `boolean` | It is an `error` event carrying an `Error`. Optional. |
| `blocked` | `boolean` | Blocked by a corruption policy; no handler ran. Optional. |
| `late` | `boolean` | Uploaded late, from an offline spool. Optional; set by the server. |

### HandlerResult

| Field | Type | |
| --- | --- | --- |
| `handlerId` | `string` | |
| `ts` | `number` | When it started. |
| `durationMs` | `number` | |
| `error` | `{ name, message, stack? }` | What it threw. A thrown non-`Error` becomes `{ name: 'Error', message: String(value) }`. Optional. |
| `rethrown` | `{ occurrenceId, handlerId }` | The error is one already recorded there, propagating outward. Optional. |

## Finding

| Field | Type | |
| --- | --- | --- |
| `id` | `string` | `f1`… |
| `kind` | `'suspected-corrupt'` | |
| `occurrenceId` | `string` | The flagged occurrence. |
| `ts` | `number` | |
| `confidence` | `'high' \| 'medium' \| 'low'` | |
| `basis` | `'deep' \| 'shape'` | Whether values or only shapes were compared. |
| `reasons` | `{ code, path, message }[]` | `code` is one of `missing-field`, `bad-value`, `type-change`, `empty-value`, `outlier`, `format-change`, `stale-payload`, `shape-changed`. |
| `diff` | `{ path, baseline, actual }[]` | What changed. |
| `taintSource` | `{ occurrenceId, handlerId } \| null` | The failure that made its sender suspect, or `null`. |
| `retroactive` | `boolean` | Emitted before the failure that flagged it. |
| `summary` | `string` | One line, as printed to the console. |
| `priority` | `'high' \| 'normal'` | `'high'` when it reaches an external system. |
| `externalTargets` | `string[]` | The external systems it reaches. |

## Gap

| Field | Type | |
| --- | --- | --- |
| `fromTs`, `toTs` | `number` | The stretch lost. |
| `dropped` | `number` | How many events. |

## RecorderMessage

What `recorder.subscribe()` delivers, and what the bridge and the uploader send:

```ts
type RecorderMessage =
  | { type: 'occurrence'; occurrence: Occurrence; template: Template; nodes: GraphNode[]; processes: Process[] }
  | { type: 'finding'; finding: Finding }
  | { type: 'snapshot'; recording: Recording };
```

An `occurrence` message carries its template and any nodes and processes it introduced, so a stream of messages can be rebuilt into a `Recording`. The same occurrence id may arrive twice (when its handlers' promises settle); the later one replaces the earlier.

## IngestBatch

The body of `POST <endpoint>/v1/ingest`, authenticated with `Authorization: Bearer ida_…`. You only need it to upload from a language without an SDK.

| Field | Type | |
| --- | --- | --- |
| `recorderKey` | `string` | |
| `sessionId` | `string` | UUID of this run. |
| `startedAt` | `number` | Epoch ms. |
| `seq` | `number` | Counts up by one per batch. A repeated `(sessionId, seq)` is acknowledged and not stored again. |
| `runtime` | `string` | Optional. |
| `sdk` | `{ language: 'js' \| 'python'; version }` | Optional. |
| `sentAt` | `number` | Sender's clock when sent, epoch ms. Optional. |
| `clock` | `{ offsetMs, errorMs }` | The sender's clock estimate. Optional. |
| `spooled` | `boolean` | Sent from the offline spool. Optional. |
| `messages` | `RecorderMessage[]` | |
| `gap` | `Gap` | Events lost to spool overflow. Optional. |

Batches are limited to 2 MiB. The server replies `200` with `{ ok, duplicate, receivedAt, repliedAt }`. The repo's `spec/README.md` is the full wire specification, including the shape rules and the `ida-parent` header.

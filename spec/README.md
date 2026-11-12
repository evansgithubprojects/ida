# Ida SDK spec

The rules every Ida SDK (JavaScript, Python, …) follows so the server and viewer can't tell which language a recording came from, and so events can be linked across services. The TypeScript types in `packages/core/src/types.ts` are the reference; this file explains the parts an SDK author has to reproduce exactly.

The fixtures in `fixtures/` are the conformance suite. Every SDK's tests load them and must pass every case.

## Wire format

An SDK uploads `IngestBatch` JSON to `POST /v1/ingest` with `Authorization: Bearer <ingest key>`:

| Field | Type | Notes |
| --- | --- | --- |
| `recorderKey` | string | 1–64 of `A-Z a-z 0-9 . _ : -`, starting with a letter or digit |
| `sessionId` | UUID | One per recorder run. The same id goes into `ida-parent` headers. |
| `startedAt` | integer | Whole epoch milliseconds when the run started. Occurrence `ts` values are milliseconds after this. |
| `seq` | integer ≥ 0 | +1 per batch in a session. The server ignores a `seq` it already has, so retries are safe. |
| `runtime` | string? | e.g. `node 24.1`, `python 3.12.4` |
| `sdk` | `{ language, version }`? | `language` is `js` or `python` |
| `spooled` | boolean? | Sent from the offline spool |
| `sentAt` | number? | The recorder's clock (`startedAt` + current `ts`) when this request was sent. Omit for batches from an earlier run. |
| `clock` | `{ offsetMs, errorMs }`? | Best recent estimate of server clock minus recorder clock (see Clock) |
| `messages` | `RecorderMessage[]` | `occurrence`, `finding` or `snapshot` |
| `gap` | `{ fromTs, toTs, dropped }`? | Data dropped because the spool overflowed |

An `occurrence` message carries the occurrence plus its template and any processes and nodes it introduces. Ids (`e1`, `t1`, `h1`, …) only need to be unique within a session, except broker process ids (below).

Findings are optional. An SDK without corruption detection simply never sends them.

The server answers `200 { ok, duplicate, receivedAt, repliedAt }`. The last two are the server's clock in epoch ms.

## Clock

Services run on different machines, so the server puts every session on its own clock. Each SDK has to:

1. Keep a recorder clock that is monotonic: `startedAt` (wall clock at start) plus elapsed monotonic time. Occurrence `ts` values and `sentAt` both use it.
2. Read the clock just before sending (`t0`, also sent as `sentAt`) and after reading the response (`t3`). With the response's `receivedAt` (`t1`) and `repliedAt` (`t2`), compute:
   - `offsetMs = ((t1 - t0) + (t2 - t3)) / 2`
   - `errorMs = ((t3 - t0) - (t2 - t1)) / 2`
   Discard the sample if `errorMs < 0` or a value is missing.
3. Keep the last 8 samples per session and send the one with the smallest `errorMs` as `clock` on every batch.

The server keeps one offset per session: the most precise one so far, or a newer one once the stored one is over 10 minutes old and disagrees by more than both errors. When it changes, the whole session moves together, so a service's own events never reorder. Before any round trip, `sentAt` gives a rough one-way estimate.

## Payload shape

A value-free signature of a payload. Templates group on it, so it must match byte for byte across SDKs.

| Value | Shape |
| --- | --- |
| null / `None` | `null` |
| string | `string` |
| any number (int or float) | `number` |
| NaN | `NaN` |
| boolean | `boolean` |
| bytes (`Buffer`, `Uint8Array`, Python `bytes`/`bytearray`) | `bytes` |
| array / list / tuple | `T[]` for one kind, `(A\|B)[]` for several (kinds sorted, deduplicated, first 20 items only), `[]` when empty |
| object / dict | `{k1:S1,k2:S2}` with keys sorted by code point; at most 40 keys, then `…` |
| date (`Date`, `datetime`) | `Date` |
| error / exception | `Error` |
| map, set | `Map`, `Set` |
| a class instance | the class name before the braces: `Order{id:number}` |
| deeper than 4 levels | `…` |
| a cycle | `[Circular]` |

JS-only values (`undefined`, `function`, `bigint`, `symbol`) map to their `typeof`.

## Template key

`emitterId|eventName|<handler ids sorted, joined by ",">|payloadShape`. Users may override it per SDK; the default must match.

## Cross-service links

### The `ida-parent` header

When a producer adapter publishes a message, it records the publish as an occurrence and writes this header on the message:

```
ida-parent: 1:<sessionId>:<occurrenceId>
```

- Kafka: a record header (bytes, UTF-8).
- RabbitMQ: an entry in `properties.headers` (a string).

The consumer adapter reads it and sets these on the consume occurrence:

```json
{ "remoteParent": { "sessionId": "…", "occurrenceId": "e12" }, "causality": "propagated" }
```

Ignore the header, starting a new chain, when the version isn't `1`, the session id isn't a UUID, or the occurrence id is missing or has more than 64 characters outside `A-Z a-z 0-9 . _ -`. Lower-case the session id. The server only links sessions within the same project.

### Broker processes

Topics, exchanges and queues are processes shared between services. Their ids are deterministic so the server can merge them:

```
<broker>:<cluster>:<kind>:<name>
```

- `broker` is `kafka` or `rabbitmq`, and `kind` is `topic`, `exchange` or `queue`.
- `cluster` is a user-chosen cluster name for Kafka (empty by default) and the vhost for RabbitMQ.
- The RabbitMQ default exchange (`""`) is written `(default)`.

Set `Process.kind` and `Process.broker` on them.

### Broker metadata

`Occurrence.meta` holds small facts that are kept even in template-only mode:

| Broker | Keys |
| --- | --- |
| Kafka | `topic`, `partition`, `offset`, `key` (string, or omitted), `group` (consumers) |
| RabbitMQ | `exchange`, `routingKey`, `queue` (consumers), `deliveryTag`, `redelivered` |

Never put payload values in `meta`.

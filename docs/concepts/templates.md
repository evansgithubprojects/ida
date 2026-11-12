# Templates and payloads

Ida doesn't store a full copy of every event. Events that look alike share a **template**, and each occurrence stores only a reference to its template plus what is unique to it. This keeps memory and uploads small, and keeps your data out of recordings unless you ask for it.

## What a template is

A template holds what every occurrence of "the same event" has in common:

- the emitter,
- the event name,
- the set of handlers it reached,
- the **shape** of its payload.

Each occurrence then stores its template id, timestamp, duration, parent link, handler results (timings and errors) and, for broker messages, a few facts such as topic and offset.

If any of the four parts changes (a new listener is added, or the payload gains a field), the next occurrence gets a new template. The viewer shows each template's shape in the inspector, so a change in shape is easy to spot.

## Payload shapes

A shape describes the type of every field, never its values:

| Payload | Shape |
| --- | --- |
| `{ orderId: 'o-1', total: 42 }` | `{orderId:string,total:number}` |
| `[1, 2, 3]` | `number[]` |
| `[1, 'a']` | `(number\|string)[]` |
| `{ at: new Date(), tags: new Set() }` | `{at:Date,tags:Set}` |
| `new Order({ id: 1 })` | `Order{id:number}` |
| `null`, `undefined`, `NaN` | `null`, `undefined`, `NaN` |
| `Buffer`, `Uint8Array`, `ArrayBuffer` | `bytes` |

Keys are sorted, so `{a, b}` and `{b, a}` have the same shape. To stay cheap on large payloads, shapes stop at depth 4 (deeper values become `…`), list at most 40 keys per object, and look at the first 20 items of an array. Circular references become `[Circular]`.

The Python SDK produces the same shapes for the same data, so templates line up across languages.

## Keeping full payloads

By default every occurrence is **template-only**: its values aren't stored. Turn on **deep logging** for the events you need values for:

```js
enable({
  deepLogging: {
    events: ['order:confirmed', 'payment:failed'],
  },
});

// or decide per event, from its name and its emitter's label
enable({
  deepLogging: { events: (eventName, emitterLabel) => emitterLabel === 'Payments' },
});
```

```python
ida.enable(deep_logging=["order.confirmed"])
ida.enable(deep_logging=lambda event_name, emitter_label: emitter_label == "Payments")
```

Matching occurrences are stored with `capture: 'full'` and a JSON-safe copy of the payload. The viewer labels every payload as **template-only** or **full capture**, so you always know whether you're looking at real values or a shape.

> **Note:** deep-logged payloads are uploaded to your project as they are. Don't deep-log events that carry passwords, tokens or personal data you aren't allowed to store.

### Limits on captured payloads

Captured payloads are copied, not referenced, so later mutations don't change the recording. The copy is limited to depth 6, 100 keys per object, 100 items per array, and 2000 characters per string (longer ones end with `…`).

Values JSON can't carry are stored as tagged objects, such as `{ "$eda": "Date", "v": "2026-01-01T00:00:00.000Z" }` for a `Date`, or tags for `undefined`, `NaN`, `Infinity`, `bigint`, `symbol`, functions, circular references, `Error`, `Map` and `Set`. `isTag(value)` from `@ida-dev/core` detects them when you read an exported recording.

When uploading, a single event too large for a batch (`maxBatchBytes`, 1 MiB by default) is sent without its payload, as template-only.

## Custom grouping

`templateKey` decides which occurrences share a template. The default is emitter + event name + handler set + payload shape. To group more coarsely, for example ignoring payload shape:

```js
createRecorder({
  templateKey: (p) => `${p.emitterId}|${p.eventName}|${[...p.handlerIds].sort().join(',')}`,
});
```

`p` has `emitterId`, `eventName`, `handlerIds` (in listener order; sort them if order shouldn't matter) and `payloadShape`. A coarser key means fewer templates, but the viewer can no longer show a shape change as a new template.

## Next steps

- [Recording format](../reference/recording-format.md): the `Template` and `Occurrence` fields.
- [Suspected corrupt payloads](../guides/corruption.md): how deep-logged values are compared over time.

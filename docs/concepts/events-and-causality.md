# Events and causality

This page explains what Ida stores for each event and how it decides which event caused which.

## Occurrences, handlers and emitters

Every time an event is emitted while recording, Ida stores one **occurrence**:

| Part | What it is |
| --- | --- |
| Emitter | The object the event was emitted on (an `EventEmitter`, an `EventTarget`, a Kafka topic, a RabbitMQ exchange…). In the viewer, emitters are grouped into **processes** by their label. |
| Source | The handler that was running when the event was emitted, or the emitter itself when nothing was running (a **root** event, such as a click or a timer). |
| Handlers | Every listener the event reached, in order, each with when it started, how long it took, and the error it threw, if any. |
| Payload | The data passed along: its shape always, its values only when [deep logging](templates.md#keeping-full-payloads) is on for that event. |
| Parent | The occurrence that caused this one, if any. |
| Timestamp and duration | When the emit started, and how long until every handler finished (including promises they returned). |

## Parent links and chains

When a handler emits an event, the new event's parent is the event that handler is handling:

```js
orders.on('order:placed', function chargeCard(order) {
  payments.emit('charge:ok', order); // parent: order:placed
});
```

Following parent links from any event back to an event with no parent gives you its **chain**, from the root cause forward. Since every event can have many children, the chains from one root form a tree, and since one handler handles many events, all chains together form a web with handlers as its nodes.

A handler belongs to the process of the first emitter it was seen on.

## How causality is tracked

Ida keeps track of "the event currently being handled" inside the dispatch it wraps. How far that reaches depends on the runtime:

| Link | Shown as | When |
| --- | --- | --- |
| **sync** | sync | The child was emitted synchronously inside the parent's handler. Always exact. |
| **inferred** | inferred (after an await or a timer) | The child was emitted after the handler's synchronous part returned: after an `await`, in a timer, or in a callback. |
| **propagated** | from another service, in a message header | The child was consumed from Kafka or RabbitMQ and its parent was produced in another service (or another run). |

### Node.js

On Node 20.16+ and 22.3+, Ida uses `AsyncLocalStorage`, so a handler's context carries across `await`, `setTimeout`, promise callbacks and most callback APIs:

```js
orders.on('order:placed', async function chargeCard(order) {
  const ok = await paymentApi.charge(order);    // context survives the await
  payments.emit(ok ? 'charge:ok' : 'charge:declined', order); // parent: order:placed (inferred)
});
```

Such links are marked *inferred* because async context can be carried further than you'd expect (for example, into a long-lived connection opened during a handler). On older Node versions, and in the browser, only synchronous links are recorded, and an event emitted after an `await` starts a new chain.

### Browser

Browsers have no built-in async context yet, so only synchronous links are recorded. The `context` option on a recorder (a [`CausalityContext`](../reference/core.md#causality-contexts)) is the place to plug one in when the platform gains one.

### Python

The Python SDK follows context with `contextvars`, which reach everything a handler starts: awaited coroutines, `asyncio` tasks, and thread pools that copy the context (such as `loop.run_in_executor`). An emit on the handler's own thread and task while it runs, including after an `await`, is *sync*. An emit anywhere else (a task or thread it started, or a callback that runs after it returned) is *inferred*. A plain `threading.Thread` doesn't copy the context, so its emits start a new chain.

### Across services

Kafka and RabbitMQ adapters add an `ida-parent` header to each message they produce, naming the recording and occurrence that produced it. The consuming side reads it, in either language, and the server links the two. See [Tracing messages across services](../guides/brokers.md).

## Errors

An error thrown in a handler is recorded on that handler's result, with its name, message and stack, and still propagates exactly as it would without Ida. If the same error object is rethrown through outer handlers, it is recorded once and the outer handlers point back at the first throw, so the viewer shows one error, not one per stack frame.

Emitting an `error` event with an `Error` payload counts as a failure too.

## Ordering and clocks

Timestamps within one recording come from a monotonic clock (`performance.now()` in JavaScript), so ordering inside a run is exact even if the system clock changes. When several services upload to one project, the server estimates each one's clock offset and puts every service on the server's clock, so messages from machines whose clocks disagree still play back in order. When a consume still appears before its publish, the viewer shows a *clock skew* badge.

## Next steps

- [Recorders](recorders.md): which recorder an event goes to.
- [Templates and payloads](templates.md): what is stored for each occurrence.

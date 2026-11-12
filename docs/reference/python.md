# Python SDK

The `ida-sdk` package records event-driven Python (your own events, Kafka and RabbitMQ) and uploads it to your project. It follows the JavaScript SDK closely, with Python naming. New to it? Start with the [Python quick start](../quickstart/python.md).

```bash
pip install ida-sdk                    # no dependencies
pip install "ida-sdk[kafka]"           # confluent-kafka >= 2.0
pip install "ida-sdk[rabbitmq]"        # pika >= 1.0
```

Python 3.9 or later. Fully typed (`py.typed`).

## ida

### enable

```python
ida.enable(**options) -> Recorder
```

The shared recorder, `connect_recorder("default", **options)`. The first call also makes it the default recorder, so adapters record everything no other recorder has claimed into it. `options` are [`Recorder`](#recorder) options and apply only on the first call.

### connect_recorder

```python
ida.connect_recorder(key: str, **options) -> Recorder
```

The recorder named `key`, created on first use; the same recorder anywhere you call it with that key. Keys follow the same rule as JavaScript (1–64 letters, digits, `.`, `_`, `:`, `-`). Raises `ValueError` for an invalid key.

```python
payments = ida.connect_recorder("payments", window_ms=60_000)
payments.track(payments_consumer)
```

### Other functions

| Function | |
| --- | --- |
| `get_recorder() -> Recorder \| None` | The `default` recorder, or `None` before `enable()`. |
| `get_recorders() -> list[Recorder]` | Every keyed recorder, in creation order. |
| `on_recorder(listener) -> Callable[[], None]` | Calls `listener(recorder)` for each keyed recorder now and later. Returns a function that stops listening. |
| `set_default_recorder(recorder \| None)` | The recorder for everything no recorder tracks. `None` records only tracked emitters. |
| `get_default_recorder() -> Recorder \| None` | |
| `payload_shape(value) -> str` | The value-free shape of a payload, identical to the JavaScript SDK's for the same data. |
| `default_template_key(parts) -> str` | The default template grouping. |

Adapter-author functions (`dispatch_all`, `open_all`, `recorders_for`, `is_tracked`, `format_parent_header`, `parse_parent_header`, `broker_process_id`) and types (`DispatchInfo`, `BrokerRef`, `RemoteParent`, `Frame`, `Invoke`, `Scope`) are exported too. `ida.RECORDING_VERSION` is `2`, `ida.PARENT_HEADER` is `"ida-parent"`, and `ida.__version__` is the SDK version.

## Recorder

```python
Recorder(
    key: str = "unnamed",
    *,
    window_ms: float = 300_000,
    max_events: int = 50_000,
    deep_logging: Sequence[str] | Callable[[str, str], bool] | None = None,
    template_key: Callable[[TemplateParts], str] | None = None,
    context: CausalityContext | None = None,
    auto_start: bool = True,
    now: Callable[[], float] | None = None,
)
```

Usually made with `enable()` or `connect_recorder()`, which take the same keyword options.

| Option | Default | |
| --- | --- | --- |
| `window_ms` | 5 minutes | How much history to keep. |
| `max_events` | 50 000 | The most events to keep. |
| `deep_logging` | none | Event names whose full payload is kept, or a function `(event_name, emitter_label) -> bool`. Note: a plain list or function, not `{"events": …}` as in JavaScript. |
| `template_key` | `default_template_key` | How events are grouped into templates. |
| `context` | `ContextVarContext()` | Causality tracking through `contextvars`. |
| `auto_start` | `True` | When `False`, call `start()` first. |
| `now` | `time.perf_counter() * 1000` | Clock, in milliseconds. |

| Member | |
| --- | --- |
| `key`, `session_id`, `started_at` | Its name, this run's UUID, and when it started (epoch ms). |
| `recording` | Whether it is recording now. |
| `start()` / `stop()` | Resume or pause. What was recorded is kept. |
| `track(obj)` / `untrack(obj)` | Claim an `ida.Emitter`, a Kafka producer or consumer, or a pika connection (which covers its channels). |
| `label_emitter(emitter, label)` | Name a process. Call it before the emitter's first event. |
| `label_handler(fn, label)` | Name a handler. Default: the function's qualified name without `<locals>.`; lambdas are `anonymous#n`. |
| `export() -> dict` | The recording, as a JSON-serializable dict in the [recording format](recording-format.md). |
| `clear()` | Forget what was recorded. |
| `subscribe(listener) -> Callable[[], None]` | Calls `listener(message)` with each new occurrence message. Returns a function that unsubscribes. |
| `wall_time() -> float` | Epoch ms on the recorder's monotonic clock. |
| `dispatch(info, run)`, `open(info, handler) -> Scope` | For adapter authors. |

## Emitter

```python
ida.Emitter(label: str | None = None)
```

A small in-process event bus whose events are recorded: the Python counterpart of Node's `EventEmitter`. Events are routed like any other emitter (to recorders that track it, else the default recorder).

| Method | |
| --- | --- |
| `on(event, handler=None)` | Adds a handler and returns it. Without a handler, returns a decorator: `@orders.on("placed")`. |
| `off(event, handler)` | Removes a handler. |
| `listeners(event) -> list` | The handlers for an event. |
| `emit(event, payload=None) -> list` | Calls each handler with `payload`, in order, and returns their results. A handler that raises stops the rest, and the exception propagates. |
| `await emit_async(event, payload=None) -> list` | Like `emit`, awaiting coroutine handlers one after another. |

```python
orders = ida.Emitter("Orders")

@orders.on("placed")
def reserve_stock(order): ...

orders.emit("placed", {"orderId": "o-1"})
```

## ida.cloud

Import it explicitly: `import ida.cloud`.

### configure

```python
ida.cloud.configure(project_key: str, endpoint: str, **options) -> Uploader
```

Starts uploading every keyed recorder, existing and future, from a background thread (`ida-uploader`). At exit, it spends up to 3 seconds uploading what is left.

Raises `ValueError` for a missing project key, a key that isn't an ingest key (`ida_…`), or a missing endpoint, and `RuntimeError` if it was already called.

| Option | Default | |
| --- | --- | --- |
| `flush_ms` | `1000` | How long messages wait to be batched. |
| `max_batch` | `500` | Most messages per batch. |
| `max_batch_bytes` | 1 MiB | Largest batch body. An event too big on its own is sent without its payload. |
| `spool` | `FileStore(".ida/spool")` | Where unsent batches wait: `FileStore(dir)`, `MemoryStore()`, or `False` to drop them. |
| `spool_max_bytes` | 50 MiB | Spool size limit. |
| `on_status` | none | Called with a dict: `{"state": "offline" \| "recovered" \| "rejected" \| "online", …}`, the same fields as JavaScript's [`UploadStatus`](cloud.md#uploadstatus). |
| `quiet` | `False` | Don't log connection changes. |
| `runtime` | `python <version>` | Shown with each recording. |
| `timeout` | `10` | Seconds per request. |
| `transport` | `urllib` | `(url, headers, body, timeout) -> (status, body)`, raising on network errors. For tests or a custom HTTP client. |

### Uploader

| Member | |
| --- | --- |
| `status` | The latest status dict. |
| `flush(timeout=None) -> bool` | Sends everything recorded so far and waits. Returns `False` if `timeout` (seconds) ran out first. |
| `close(timeout=5.0)` | Flushes, stops the thread, and lets you call `configure` again. |

`ida.cloud.get_uploader()` returns the current uploader, or `None`.

Connection changes are logged to the `ida` logger: a warning when offline and on recovery, an error the first time a batch is refused.

`FileStore` uses the same layout as the Node SDK's `fileStore`, so either SDK can deliver what the other left in a shared folder.

## ida.adapters.kafka

Records [confluent-kafka](https://github.com/confluentinc/confluent-kafka-python).

### instrument

```python
ida.adapters.kafka.instrument(
    module=None, *,
    recorder: Recorder | None = None,
    cluster: str = "",
    record_keys: bool = False,
    warn_if_no_recorder: bool = True,
) -> Callable[[], None]
```

Replaces `confluent_kafka.Producer` and `Consumer` with recorded subclasses, and records `SerializingProducer` (with the value before serialization) and `DeserializingConsumer` (with the value after). **Import the classes after calling it.** Returns a function that undoes it.

| Option | |
| --- | --- |
| `recorder` | Record everything here instead of routing by `track()`. |
| `cluster` | Names the cluster when services use more than one; use the same name in every service, JavaScript included. |
| `record_keys` | Keep message keys. Off by default because keys are often ids from your data. |
| `warn_if_no_recorder` | Log once when a message goes unrecorded. |

Each `produce()` is recorded on its topic and adds an `ida-parent` header to the message (without changing your headers object).

### run

```python
ida.adapters.kafka.run(consumer, handler, *, poll_timeout: float = 1.0, stop: threading.Event | None = None) -> None
```

A poll loop that calls `handler(message)` for each message and records it as handled by your function. Messages with an error are skipped. An exception in `handler` is recorded and re-raised, which ends the loop; set `stop` to end it from another thread. Raises `TypeError` if the consumer isn't recorded (create it after `instrument()`, or wrap it).

With your own `poll()` loop instead, everything your code does after `poll()` returns a message is recorded as handling it, until the next `poll()` or `close()`. That handler is named `<group.id> consumer`.

### wrap_producer / wrap_consumer

```python
producer = ida.adapters.kafka.wrap_producer(producer)
consumer = ida.adapters.kafka.wrap_consumer(consumer, group="payments")
```

For clients created before `instrument()`, or by a library: returns a recorded proxy to use in its place. An already-recorded client is returned as it is.

## ida.adapters.rabbitmq

Records [pika](https://pika.readthedocs.io).

```python
ida.adapters.rabbitmq.instrument(*, recorder: Recorder | None = None, warn_if_no_recorder: bool = True) -> Callable[[], None]
```

Records `basic_publish` and `basic_consume` on every channel type, and the `BlockingChannel.consume()` generator. Works with `BlockingConnection`, `SelectConnection` and the other connection adapters, for connections and channels created before or after the call. Returns a function that undoes it.

- `basic_publish` is recorded on its exchange, and adds an `ida-parent` header to a copy of your properties.
- Each delivery to a `basic_consume` callback is recorded on its queue, handled by your callback.
- With `channel.consume(queue)`, the code handling each message is recorded until the generator yields the next one, as a handler named `<queue> consumer`.

Track a pika connection to record it, and its channels, on a keyed recorder. The vhost comes from the connection's parameters.

## Differences from JavaScript

| | JavaScript | Python |
| --- | --- | --- |
| Names | `camelCase` | `snake_case` |
| Deep logging | `{ deepLogging: { events: [...] } }` | `deep_logging=[...]` |
| Invalid recorder key | `TypeError` | `ValueError` |
| Suspected-corruption detection, `markExternal`, findings | ✓ | not yet |
| Causality across async code | Node 20.16+ / 22.3+ (`AsyncLocalStorage`) | always (`contextvars`) |
| Uploads | async, on the event loop | a background thread |
| Local live bridge | `@ida-dev/core/bridge-node` | not available |

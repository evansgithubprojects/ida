# Ida for Python

Records event-driven Python (Kafka, RabbitMQ and your own events) and uploads it to your Ida project. There, you can
replay it and follow each message from the service that sent it to the one that handled it, including services
written in JavaScript.

```bash
pip install "ida-sdk[kafka]"      # confluent-kafka
pip install "ida-sdk[rabbitmq]"   # pika
pip install "ida-sdk[kafka,rabbitmq]"
```

Python 3.9 or later. The SDK itself has no dependencies; the extras only pin the broker client versions it supports.

## Setup

Create a project in the web app and make an ingest key, then run this once at startup, before you create any
producers, consumers or channels:

```python
import os
import ida
import ida.cloud

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="https://your-ida-server")
ida.enable()  # the default recorder: everything no keyed recorder has claimed
```

Then install the adapter for your broker.

### Kafka (confluent-kafka)

```python
import ida.adapters.kafka
ida.adapters.kafka.instrument()

from confluent_kafka import Consumer, Producer  # import after instrument()

producer = Producer({"bootstrap.servers": "localhost:9092"})
producer.produce("orders", value=json.dumps(order))

consumer = Consumer({"bootstrap.servers": "localhost:9092", "group.id": "payments"})
consumer.subscribe(["orders"])
ida.adapters.kafka.run(consumer, charge_card)  # calls charge_card(message) for each message
```

- Each `produce()` is recorded on its topic and adds an `ida-parent` header to the message. The consumer reads it, so
  the web app links the publish to whatever handled it, in any service that records with Ida.
- `run()` records each message as handled by your function, with its exceptions. With your own `poll()` loop,
  everything your code does after `poll()` returns a message is recorded as part of handling it, until the next
  `poll()`. In the viewer that handler is named after the consumer group.
- `SerializingProducer` and `DeserializingConsumer` are recorded too, with the payload your code sees.
- `instrument()` replaces `confluent_kafka.Producer` and `Consumer` with recorded subclasses. If a class was imported
  earlier, or a client created earlier, wrap it: `producer = ida.adapters.kafka.wrap_producer(producer)`,
  `consumer = ida.adapters.kafka.wrap_consumer(consumer, group="payments")`.

| `instrument()` option | Default | |
| --- | --- | --- |
| `recorder` | routing | Record everything into this recorder instead of routing by `track()`. |
| `cluster` | `""` | Names the cluster when your services use more than one, so equal topic names stay apart. |
| `record_keys` | `False` | Keep message keys. Off by default because keys are often ids from your data. |
| `warn_if_no_recorder` | `True` | Log once when a message goes unrecorded. |

### RabbitMQ (pika)

```python
import ida.adapters.rabbitmq
ida.adapters.rabbitmq.instrument()

connection = pika.BlockingConnection(pika.ConnectionParameters("localhost"))
channel = connection.channel()
channel.basic_publish(exchange="orders", routing_key="order.placed", body=json.dumps(order))

def send_receipt(ch, method, properties, body): ...
channel.basic_consume(queue="receipts", on_message_callback=send_receipt)
channel.start_consuming()
```

- `basic_publish` is recorded on its exchange and adds an `ida-parent` header to a copy of your properties.
- Each delivery to a `basic_consume` callback is recorded on its queue, handled by your callback, with the exchange,
  routing key and delivery tag.
- With `channel.consume(queue)`, the code that handles each message is recorded until the generator yields the next
  one.
- Works with `BlockingConnection`, `SelectConnection` and the other pika adapters, for channels opened before or after
  `instrument()`.

## Several services in one process

Keyed recorders keep parts of an app apart. `connect_recorder(key)` returns the same recorder anywhere you call it:

```python
payments = ida.connect_recorder("payments")
payments.track(payments_consumer)       # a Kafka producer or consumer
payments.track(rabbit_connection)       # a pika connection covers its channels
```

Adapters send each event to the recorders that track its client, or else to the default recorder.

## Your own events

`ida.Emitter` records events that don't go through a broker:

```python
orders = ida.Emitter("Orders")

@orders.on("placed")
def reserve_stock(order): ...

orders.emit("placed", {"orderId": "o-1"})
await orders.emit_async("placed", order)  # awaits coroutine handlers
```

## What is recorded

- **The shape of each payload, not its data.** `{"orderId": "o-1", "total": 42}` is stored as
  `{orderId:string,total:number}`. Events with the same emitter, name, handlers and shape share one template.
- **Broker facts:** topic, partition, offset and consumer group, or exchange, routing key, queue and delivery tag.
  Message keys only with `record_keys=True`.
- **Full payloads for the events you choose:**
  `ida.enable(deep_logging=["payment.failed"])`, or a function `(event_name, emitter_label) -> bool`.
- **Causality.** An event emitted while a handler runs points back at the event that handler is handling. The SDK
  follows this through `contextvars`, so it carries across `await`; such links are marked *inferred* in the viewer.
  Links between services travel in the `ida-parent` header and are marked *propagated*.

Timestamps from every service are put on the server's clock, so messages from machines whose clocks differ still play
back in order.

## When the server can't be reached

Recording carries on. Batches go to `.ida/spool` and are uploaded in order once the server is back; the `ida` logger
says when that happens. Past `spool_max_bytes` the oldest batches are dropped, and the web app shows the gap.

| `configure()` option | Default | |
| --- | --- | --- |
| `project_key` | required | The project's ingest key (`ida_…`). Keys can only upload. |
| `endpoint` | required | The Ida server URL. |
| `flush_ms` | `1000` | How long messages wait to be batched. |
| `max_batch` | `500` | Most messages per batch. |
| `max_batch_bytes` | 1 MiB | Largest batch body. An event too big on its own is sent without its payload. |
| `spool` | `FileStore(".ida/spool")` | Where unsent batches wait: a `FileStore(dir)`, `MemoryStore()`, or `False`. |
| `spool_max_bytes` | 50 MiB | Spool size limit. |
| `on_status` | — | Called with `{"state": "offline" \| "recovered" \| "rejected" \| "online", …}`. |
| `quiet` | `False` | Don't log connection changes. |
| `timeout` | `10` s | Per request. |

At exit, the SDK spends up to 3 seconds uploading what is left. Call `ida.cloud.get_uploader().flush()` to upload
sooner, for example at the end of a short script.

## Documentation

The Python quick start and full reference are in the **Docs** section of the Ida web app (`/docs/quickstart/python` and `/docs/reference/python`), and in the repo's [`docs/`](../docs/reference/python.md) folder.

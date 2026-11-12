# Quick start: Python

The Python SDK records your own events, Kafka (`confluent-kafka`) and RabbitMQ (`pika`), and uploads them to the same projects as the JavaScript SDK. Messages between a Python service and a JavaScript one are linked in the viewer.

You need Python 3.9 or later. The SDK has no dependencies of its own.

## 1. Install

```bash
pip install ida-sdk                  # your own events only
pip install "ida-sdk[kafka]"         # plus confluent-kafka
pip install "ida-sdk[rabbitmq]"      # plus pika
pip install "ida-sdk[kafka,rabbitmq]"
```

## 2. Configure once at startup

Create an ingest key in your project (**Connect an app**), store it as `IDA_PROJECT_KEY`, and run this before you create any emitters, producers, consumers or channels:

```python
import os
import ida
import ida.cloud  # import it explicitly: `import ida` alone doesn't load it

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="{{API_URL}}")
ida.enable()  # the default recorder: everything no keyed recorder has claimed
```

## 3. Record your own events

`ida.Emitter` is a small event emitter that records every emit and handler:

```python
orders = ida.Emitter("Orders")
payments = ida.Emitter("Payments")

@orders.on("placed")
def charge_card(order):
    payments.emit("charged" if order["total"] < 100 else "declined", order)

@payments.on("charged")
def send_receipt(order):
    print("receipt for", order["orderId"])

orders.emit("placed", {"orderId": "o-1", "total": 42})
```

`charged` is recorded as caused by `placed`, because it was emitted while `charge_card` was handling `placed`. Coroutine handlers work too: `await orders.emit_async("placed", order)` awaits each one in turn, and causality follows across `await` (see [Events and causality](../concepts/events-and-causality.md#python)).

## 4. Or record a broker

```python
import ida.adapters.kafka
ida.adapters.kafka.instrument()

from confluent_kafka import Consumer, Producer  # import after instrument()

consumer = Consumer({"bootstrap.servers": "localhost:9092", "group.id": "payments"})
consumer.subscribe(["orders"])
ida.adapters.kafka.run(consumer, charge_card)  # calls charge_card(message) for each message
```

See the [Kafka](/docs/kafka?lang=python) and [RabbitMQ](/docs/rabbitmq?lang=python) setup pages, and [Tracing messages across services](../guides/brokers.md).

## 5. Short scripts: flush before exit

At exit, the SDK spends up to 3 seconds uploading what is left. For a script that ends quickly, or to be sure, flush yourself:

```python
ida.cloud.get_uploader().flush()
```

## Keeping full payloads

Only payload shapes are uploaded by default. To keep values for the events you are debugging:

```python
ida.enable(deep_logging=["payment.failed"])
# or a function of (event_name, emitter_label)
ida.enable(deep_logging=lambda name, emitter: emitter == "Payments")
```

`enable()` options only apply on its first call, so pass them where you first call it.

## Next steps

- [Python reference](../reference/python.md): every function, class and option, and how the Python SDK differs from JavaScript.
- [Recorders](../concepts/recorders.md): several services in one process.
- [Offline and delivery](../concepts/offline.md)

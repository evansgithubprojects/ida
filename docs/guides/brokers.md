# Tracing messages across services

When services talk through Kafka or RabbitMQ, a bug often starts in one service and shows up in another. Ida links each message from the service that produced it to the service that consumed it, in either language, so you can follow one order from the storefront, through Kafka, into payments, through RabbitMQ, and out to the email.

## How the link works

1. When a recorded service **produces** a message, the adapter records it on its topic or exchange, as emitted by whichever handler was running, and adds an `ida-parent` header: `1:<sessionId>:<occurrenceId>`.
2. When a recorded service **consumes** it, the adapter records the delivery on its topic or queue, handled by your code, and reads the header.
3. The server joins the two. In the viewer, the consume's causality is *propagated*, and the [viewer](../viewer/traces-and-system.md) draws the hop as a dotted pathway between the two services.

Your message objects are never changed: the header is added to a copy. Messages without the header (from services that don't record with Ida) are still recorded; they just start a new chain.

## Setup

Every service needs `configure` (or `ida.cloud.configure`) with the **same project's** ingest key, a recorder, and the adapter for its client. Give each service its own recorder key so the system view can tell them apart.

### Node, kafkajs

```js
import { Kafka } from 'kafkajs';
import { configure } from '@ida-dev/cloud';
import { connectRecorder } from '@ida-dev/core';
import { enableKafkajsRecording } from '@ida-dev/adapter-kafkajs';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '{{API_URL}}' });
enableKafkajsRecording(Kafka); // before creating producers and consumers

const kafka = new Kafka({ brokers: ['localhost:9092'] });
connectRecorder('checkout').track(kafka);
```

Produce with `send` or `sendBatch` (transactions too) and consume with `consumer.run({ eachMessage })` or `eachBatch` as usual.

### Node, amqplib

```js
import amqp from 'amqplib';
import { configure } from '@ida-dev/cloud';
import { connectRecorder } from '@ida-dev/core';
import { enableAmqplibRecording } from '@ida-dev/adapter-amqplib';

configure({ projectKey: process.env.IDA_PROJECT_KEY, endpoint: '{{API_URL}}' });
enableAmqplibRecording(amqp); // pass the module itself, before connecting

const connection = await amqp.connect('amqp://localhost');
connectRecorder('notifier').track(connection);
```

`publish`, `sendToQueue` and confirm channels are recorded on publish; `consume` callbacks on delivery. The callback API (`amqplib/callback_api`) works the same way.

### Python, confluent-kafka

```python
import ida, ida.cloud, ida.adapters.kafka

ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="{{API_URL}}")
payments = ida.connect_recorder("payments")
ida.set_default_recorder(payments)
ida.adapters.kafka.instrument()

from confluent_kafka import Consumer  # import after instrument()

consumer = Consumer({"bootstrap.servers": "localhost:9092", "group.id": "payments"})
consumer.subscribe(["orders"])
ida.adapters.kafka.run(consumer, charge_card)
```

`run()` records each message as handled by your function. With your own `poll()` loop, everything your code does after `poll()` returns a message is recorded as handling it, until the next `poll()`.

### Python, pika

```python
import ida.adapters.rabbitmq
ida.adapters.rabbitmq.instrument()

channel.basic_publish(exchange="receipts", routing_key="receipt.send", body=json.dumps(receipt))
channel.basic_consume(queue="emails", on_message_callback=send_email)
```

Works with `BlockingConnection`, `SelectConnection` and the other pika adapters, for channels opened before or after `instrument()`.

Full setup for each language is on the [Kafka](/docs/kafka) and [RabbitMQ](/docs/rabbitmq) pages.

## What is recorded for each message

| Broker | Event name | Recorded on | Kept with every message |
| --- | --- | --- | --- |
| Kafka produce | topic | the topic | topic, partition (if given), key (if `recordKeys`) |
| Kafka consume | topic | the topic | topic, partition, offset, consumer group, key (if `recordKeys`) |
| Kafka `eachBatch` | topic | the topic | topic, partition, group, message count, first and last offset |
| RabbitMQ publish | routing key (or exchange) | the exchange | exchange, routing key |
| RabbitMQ delivery | routing key (or queue) | the queue | exchange, routing key, queue, delivery tag, redelivered |

Message values are decoded for their shape: JSON text is parsed, anything else (or anything over 64 KiB) is `bytes`. As everywhere in Ida, only the shape is kept unless you deep-log the event (the event name is the topic for Kafka, the routing key for RabbitMQ).

Message **keys** are often ids from your data, so they are kept only with `recordKeys: true` (`record_keys=True` in Python).

## Several clusters

Topics are identified by cluster and name. If your services use more than one Kafka cluster, name each one with the `cluster` option so a topic called `orders` in each isn't drawn as one:

```js
enableKafkajsRecording(Kafka, { cluster: 'eu-west' });
```

RabbitMQ exchanges and queues are identified by their vhost automatically.

## Seeing it

- Open the project's viewer (**Open viewer**) to see every service together, with topics, exchanges and queues between them. Topics show the Kafka logo and exchanges and queues the RabbitMQ logo; hover one to see what it is.
- Select any event and press **T** (or **Trace**) to light up everything that led to it and everything it caused, across services. See [Traces and the system view](../viewer/traces-and-system.md).
- The inspector shows each message's broker facts, who published it, who consumed it, and the time between the two.

## Try it

The repo's `examples/brokers` folder runs three services (Node with kafkajs, Python with confluent-kafka and pika, Node with amqplib) against Kafka and RabbitMQ in Docker, with an error every seventh order to trace.

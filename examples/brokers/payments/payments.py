"""
Payments: consumes orders from the Kafka topic `orders`, charges them, and publishes a receipt to the RabbitMQ
exchange `receipts`. Orders over 900 are declined, so there are errors to trace.
"""

import json
import os
import signal
import threading

import ida
import ida.adapters.kafka
import ida.adapters.rabbitmq
import ida.cloud

ida.cloud.configure(
    project_key=os.environ.get("IDA_PROJECT_KEY", ""),
    endpoint=os.environ.get("IDA_ENDPOINT", "http://localhost:8787"),
)
# Everything this service records goes to one recorder, so it shows up as `payments` in the system view.
ida.set_default_recorder(ida.connect_recorder("payments"))
ida.adapters.kafka.instrument()
ida.adapters.rabbitmq.instrument()

import pika  # noqa: E402
from confluent_kafka import Consumer  # noqa: E402  (imported after instrument(), so it is the recorded one)

KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:9094")
AMQP_URL = os.environ.get("AMQP_URL", "amqp://guest:guest@localhost:5673")


class CardDeclined(Exception):
    pass


params = pika.URLParameters(AMQP_URL)
# A BlockingConnection only answers RabbitMQ's heartbeats while pika has control, and this service spends its time in
# the Kafka poll loop. Fine for a demo on one machine; a real service would run pika on its own thread instead.
params.heartbeat = 0
rabbit = pika.BlockingConnection(params)
channel = rabbit.channel()
channel.exchange_declare("receipts", "direct", durable=False)

ledger = ida.Emitter("Ledger")


@ledger.on("charged")
def send_receipt(payment: dict) -> None:
    channel.basic_publish("receipts", "receipt.send", json.dumps(payment).encode())


def charge_card(message) -> None:
    order = json.loads(message.value())
    if order["total"] > 900:
        raise CardDeclined(f"card declined for {order['id']}: {order['total']} is over the limit")
    ledger.emit("charged", {"orderId": order["id"], "customer": order["customer"], "amount": order["total"]})


consumer = Consumer({
    "bootstrap.servers": KAFKA_BROKERS,
    "group.id": "payments",
    "auto.offset.reset": "earliest",
})
consumer.subscribe(["orders"])

stop = threading.Event()
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda *_: stop.set())

print(f"[payments] consuming 'orders' on {KAFKA_BROKERS}", flush=True)
while not stop.is_set():
    try:
        # Each message is recorded as handled by charge_card; a decline is recorded as its error, then we go on.
        ida.adapters.kafka.run(consumer, charge_card, stop=stop)
    except CardDeclined as err:
        print(f"[payments] {err}", flush=True)

consumer.close()
rabbit.close()
ida.cloud.get_uploader().flush(5)

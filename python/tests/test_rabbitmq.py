"""
The pika adapter against pika's own channel classes. A small in-memory broker stands in for RabbitMQ underneath them,
so publishes and deliveries go through the real ``basic_publish``, ``basic_consume`` and ``consume()`` code.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any, Optional

import pika
import pika.channel
import pytest
from pika import frame, spec
from pika.adapters.blocking_connection import BlockingChannel
from pika.callback import CallbackManager

import ida
from ida import PARENT_HEADER, Emitter
from ida.adapters import rabbitmq
from ida.core.keyed import _reset


class Broker:
    """Routes the default exchange by queue name and other exchanges by binding."""

    def __init__(self) -> None:
        self.bindings: dict[tuple[str, str], str] = {}
        self.consumers: dict[str, list[tuple[Connection, int, str]]] = defaultdict(list)
        self.published: list[tuple[str, str, Any, bytes]] = []
        self.waiting: dict[str, list[tuple[str, str, Any, bytes]]] = defaultdict(list)  # queued, no consumer yet
        self.delivery_tag = 0

    def route(self, exchange: str, routing_key: str, props: Any, body: bytes) -> None:
        self.published.append((exchange, routing_key, props, body))
        queue = routing_key if exchange == "" else self.bindings.get((exchange, routing_key))
        if queue:
            self.waiting[queue].append((exchange, routing_key, props, body))
            self.deliver(queue)

    def deliver(self, queue: str) -> None:
        if not self.consumers[queue]:
            return
        conn, number, tag = self.consumers[queue][0]
        for exchange, routing_key, props, body in self.waiting.pop(queue, []):
            self.delivery_tag += 1
            deliver = spec.Basic.Deliver(tag, self.delivery_tag, False, exchange, routing_key)
            conn.outbox += [
                frame.Method(number, deliver),
                frame.Header(number, len(body), props),
                frame.Body(number, body),
            ]


class Connection:
    """Stands in for pika.connection.Connection beneath pika.channel.Channel."""

    def __init__(self, broker: Broker, vhost: str = "/") -> None:
        self.broker = broker
        self.callbacks = CallbackManager()
        self.params = SimpleNamespace(virtual_host=vhost)
        self.channels: dict[int, pika.channel.Channel] = {}
        self.outbox: deque[Any] = deque()

    def channel(self) -> pika.channel.Channel:
        number = len(self.channels) + 1
        ch = self.channels[number] = pika.channel.Channel(self, number, None)  # type: ignore[arg-type]
        ch.open()
        self.pump()
        assert ch.is_open
        return ch

    def _send_method(self, number: int, method: Any, content: Optional[tuple[Any, bytes]] = None) -> None:
        if isinstance(method, spec.Channel.Open):
            self.outbox.append(frame.Method(number, spec.Channel.OpenOk()))
        elif isinstance(method, spec.Basic.Consume):
            self.broker.consumers[method.queue].append((self, number, method.consumer_tag))
            self.outbox.append(frame.Method(number, spec.Basic.ConsumeOk(method.consumer_tag)))
            self.broker.deliver(method.queue)
        elif isinstance(method, spec.Basic.Publish):
            assert content is not None
            self.broker.route(method.exchange, method.routing_key, *content)

    def pump(self) -> None:
        """Hands received frames to the channels, as pika.connection.Connection._process_frame does."""
        while self.outbox:
            f = self.outbox.popleft()
            if isinstance(f, frame.Method) and self.callbacks.pending(f.channel_number, f.method):
                self.callbacks.process(f.channel_number, f.method, self, f)
            else:
                self.channels[f.channel_number]._handle_content_frame(f)


class Blocking:
    """Stands in for pika.BlockingConnection: pika's BlockingChannel over our Connection."""

    def __init__(self, broker: Broker, vhost: str = "/") -> None:
        self._impl = Connection(broker, vhost)
        self.blocking: list[BlockingChannel] = []

    def channel(self) -> BlockingChannel:
        ch = BlockingChannel(self._impl.channel(), self)  # type: ignore[arg-type]
        self.blocking.append(ch)
        return ch

    def _flush_output(self, *_waiters: Any) -> None:
        self._impl.pump()

    def _request_channel_dispatch(self, _number: int) -> None: ...

    def process_data_events(self, time_limit: Optional[float] = 0) -> None:
        self._impl.pump()
        for ch in self.blocking:
            ch._dispatch_events()


@pytest.fixture(autouse=True)
def instrumented() -> Iterator[None]:
    _reset()
    uninstall = rabbitmq.instrument()
    yield
    uninstall()
    _reset()


def event(rec: ida.Recorder, name: str) -> dict[str, Any]:
    out = rec.export()
    ids = {t["id"] for t in out["templates"] if t["eventName"] == name}
    return next(o for o in out["occurrences"] if o["templateId"] in ids)


def label(rec: ida.Recorder, node_id: str) -> str:
    return next(n["label"] for n in rec.export()["nodes"] if n["id"] == node_id)


def test_links_a_published_message_to_the_callback_that_handled_it() -> None:
    broker = Broker()
    broker.bindings[("orders", "order.placed")] = "emails"
    shop, mailer = Blocking(broker), Blocking(broker, vhost="prod")
    checkout, notifier = ida.connect_recorder("checkout"), ida.connect_recorder("notifier")
    checkout.track(shop)  # tracking the connection covers its channels
    notifier.track(mailer)
    sent: list[Any] = []

    def send_email(ch: Any, method: Any, props: Any, body: bytes) -> None:
        sent.append(json.loads(body))
        receipts.emit("sent")

    receipts = Emitter("Receipts")
    notifier.track(receipts)
    mailer.channel().basic_consume("emails", send_email)

    caller_props = pika.BasicProperties(content_type="application/json", headers={"trace": "abc"})
    shop.channel().basic_publish("orders", "order.placed", b'{"orderId":"o-1","total":42}', caller_props)
    mailer.process_data_events()

    assert sent == [{"orderId": "o-1", "total": 42}]
    assert caller_props.headers == {"trace": "abc"}  # the caller's properties are not changed
    publish = event(checkout, "order.placed")
    assert len(checkout.export()["occurrences"]) == 1  # BlockingChannel → Channel is recorded once
    assert publish["meta"] == {"exchange": "orders", "routingKey": "order.placed"}
    assert checkout.export()["processes"][0]["id"] == "rabbitmq:/:exchange:orders"
    _, _, props, _ = broker.published[0]
    assert props.content_type == "application/json"
    assert props.headers == {"trace": "abc", PARENT_HEADER: f"1:{checkout.session_id}:{publish['id']}"}

    delivered = event(notifier, "order.placed")
    assert delivered["causality"] == "propagated"
    assert delivered["remoteParent"] == {"sessionId": checkout.session_id, "occurrenceId": publish["id"]}
    assert delivered["meta"] == {
        "exchange": "orders",
        "routingKey": "order.placed",
        "queue": "emails",
        "deliveryTag": 1,
        "redelivered": False,
    }
    assert label(notifier, delivered["handlerResults"][0]["handlerId"]) == "send_email"
    assert event(notifier, "sent")["parentId"] == delivered["id"]
    assert notifier.export()["processes"][0]["id"] == "rabbitmq:prod:queue:emails"


def test_records_callback_errors_and_raises_them() -> None:
    rec = ida.enable()
    conn = Blocking(Broker())
    ch = conn.channel()

    def charge(*_: Any) -> None:
        raise RuntimeError("card declined")

    ch.basic_consume("payments", charge)
    ch.basic_publish("", "payments", b"{}")
    with pytest.raises(RuntimeError, match="card declined"):
        conn.process_data_events()
    delivered = [o for o in rec.export()["occurrences"] if o["handlerResults"]]
    assert delivered[0]["handlerResults"][0]["error"]["message"] == "card declined"
    assert delivered[0]["meta"]["exchange"] == ""
    assert rec.export()["processes"][0]["label"] == "(default exchange)"


def test_the_select_connection_channel() -> None:
    """pika.channel.Channel directly, as SelectConnection and the async adapters use it."""
    rec = ida.enable()
    conn = Connection(Broker())
    ch = conn.channel()
    got: list[Any] = []
    ch.basic_consume("q", lambda _ch, _m, props, body: got.append((props.headers[PARENT_HEADER], body)))
    ch.basic_publish("", "q", "plain text", mandatory=True)
    conn.pump()
    publish, delivered = rec.export()["occurrences"]
    assert got == [(f"1:{rec.session_id}:{publish['id']}", b"plain text")]
    assert delivered["remoteParent"]["occurrenceId"] == publish["id"]
    shapes = [t["payloadShape"] for t in rec.export()["templates"]]
    assert shapes == ["string", "bytes"]  # a str body as given; on delivery, bytes that aren't JSON


def test_the_consume_generator_keeps_each_message_current_until_the_next() -> None:
    rec = ida.enable()
    conn = Blocking(Broker())
    ch = conn.channel()
    for i in range(2):
        ch.basic_publish("", "jobs", json.dumps({"i": i}).encode())
    worker = Emitter("Worker")
    seen = []
    for method, _props, body in ch.consume("jobs", inactivity_timeout=0):
        if method is None:
            worker.emit("idle")
            break
        seen.append(json.loads(body)["i"])
        worker.emit("done", seen[-1])
    delivered = [o for o in rec.export()["occurrences"] if o["handlerResults"]]
    done = [o for o in rec.export()["occurrences"] if o["templateId"] == event(rec, "done")["templateId"]]
    assert seen == [0, 1]
    assert [d["parentId"] for d in done] == [d["id"] for d in delivered]
    assert event(rec, "idle")["parentId"] is None  # the timeout tuple opens nothing
    assert label(rec, delivered[0]["handlerResults"][0]["handlerId"]) == "jobs consumer"
    assert len(rec.export()["occurrences"]) == 2 + 2 + 2 + 1  # publishes, deliveries, done, idle


def test_a_tracked_channel_overrides_its_connection() -> None:
    a, b = ida.connect_recorder("a"), ida.connect_recorder("b")
    conn = Blocking(Broker())
    a.track(conn)
    ch1, ch2 = conn.channel(), conn.channel()
    b.track(ch2)
    ch1.basic_publish("", "q", b"1")
    ch2.basic_publish("", "q", b"2")
    assert len(a.export()["occurrences"]) == 1 and len(b.export()["occurrences"]) == 1


def test_warns_once_when_nothing_records(caplog: pytest.LogCaptureFixture) -> None:
    broker = Broker()
    ch = Blocking(broker).channel()
    ch.basic_publish("", "q", b"1")
    ch.basic_publish("", "q", b"2")
    assert broker.published[0][2].headers is None  # no recorder: the message goes out as it was
    assert len([r for r in caplog.records if "went unrecorded" in r.getMessage()]) == 1


def test_uninstall_puts_pika_back() -> None:
    patched = BlockingChannel.basic_publish
    rabbitmq.instrument()()  # a second install and its uninstall
    assert BlockingChannel.basic_publish is patched
    assert "rabbitmq" in pika.channel.Channel.basic_publish.__module__ + patched.__module__

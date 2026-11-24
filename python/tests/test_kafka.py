from __future__ import annotations

import json
import threading
import types
from collections.abc import Iterator
from typing import Any, Optional

import pytest

import ida
from ida import PARENT_HEADER, Emitter
from ida.adapters import kafka
from ida.core.keyed import _reset


class Message:
    def __init__(self, topic: str, value: Any, key: Any, headers: Any, offset: int, error: Any = None) -> None:
        self._t, self._v, self._k, self._h, self._o, self._e = topic, value, key, headers, offset, error

    def topic(self) -> str:
        return self._t

    def partition(self) -> int:
        return 0

    def offset(self) -> int:
        return self._o

    def key(self) -> Any:
        return self._k

    def value(self) -> Any:
        return self._v

    def headers(self) -> Any:
        return self._h

    def error(self) -> Any:
        return self._e


def fake_module() -> types.SimpleNamespace:
    """Shaped like confluent_kafka: produce() appends to a log, poll() reads it back as a broker would."""
    log: list[Message] = []

    class Producer:
        def __init__(self, config: dict[str, Any]) -> None:
            self.config = config

        def produce(
            self,
            topic: str,
            value: Any = None,
            key: Any = None,
            partition: int = -1,
            on_delivery: Any = None,
            timestamp: int = 0,
            headers: Any = None,
        ) -> None:
            # On the wire, headers are a list of (name, bytes).
            items = list(headers.items()) if isinstance(headers, dict) else list(headers or [])
            wire = [(k, v.encode() if isinstance(v, str) else v) for k, v in items] or None
            body = value.encode() if isinstance(value, str) else value
            log.append(Message(topic, body, key, wire, len(log)))

    class Consumer:
        def __init__(self, config: dict[str, Any]) -> None:
            self.config = config
            self.position = 0

        def poll(self, timeout: float = -1) -> Optional[Message]:
            if self.position >= len(log):
                return None
            self.position += 1
            return log[self.position - 1]

        def consume(self, num_messages: int = 1, timeout: float = -1) -> list[Message]:
            out = log[self.position : self.position + num_messages]
            self.position += len(out)
            return out

        def close(self) -> None: ...

    class SerializingProducer(Producer):
        def produce(
            self,
            topic: str,
            key: Any = None,
            value: Any = None,
            partition: int = -1,
            on_delivery: Any = None,
            timestamp: int = 0,
            headers: Any = None,
        ) -> None:
            super().produce(topic, json.dumps(value).encode(), key, partition, on_delivery, timestamp, headers)

    class DeserializingConsumer(Consumer):
        def poll(self, timeout: float = -1) -> Optional[Message]:
            msg = super().poll(timeout)
            if msg is not None:
                msg = Message(msg.topic(), json.loads(msg.value()), msg.key(), msg.headers(), msg.offset())
            return msg

    return types.SimpleNamespace(
        Producer=Producer,
        Consumer=Consumer,
        SerializingProducer=SerializingProducer,
        DeserializingConsumer=DeserializingConsumer,
        log=log,
    )


@pytest.fixture
def ck() -> Iterator[types.SimpleNamespace]:
    _reset()
    module = fake_module()
    uninstall = kafka.instrument(module)
    yield module
    uninstall()
    _reset()


def event(rec: ida.Recorder, name: str) -> dict[str, Any]:
    out = rec.export()
    ids = {t["id"] for t in out["templates"] if t["eventName"] == name}
    return next(o for o in out["occurrences"] if o["templateId"] in ids)


def test_links_a_message_from_one_service_to_its_consumer(ck: Any) -> None:
    checkout, payments = ida.connect_recorder("checkout"), ida.connect_recorder("payments")
    producer = ck.Producer({"bootstrap.servers": "x"})
    checkout.track(producer)
    orders = Emitter("Orders")
    checkout.track(orders)

    @orders.on("placed")
    def publish_order(order: Any) -> None:
        producer.produce("orders", json.dumps(order), key="o-1", headers={"trace": "abc"})

    orders.emit("placed", {"orderId": "o-1", "total": 42})

    consumer = ck.Consumer({"group.id": "payments", "bootstrap.servers": "x"})
    payments.track(consumer)
    receipts = Emitter("Receipts")
    payments.track(receipts)
    msg = consumer.poll(1.0)
    receipts.emit("send")  # code running after poll(): points back at the message
    assert consumer.poll(1.0) is None
    receipts.emit("later")  # after the next poll: a new chain

    publish = event(checkout, "orders")
    handler = next(n for n in checkout.export()["nodes"] if n["label"] == "publish_order")
    assert publish["sourceNodeId"] == handler["id"] and publish["parentId"] == event(checkout, "placed")["id"]
    assert publish["meta"] == {"topic": "orders"}
    shapes = {t["eventName"]: t["payloadShape"] for t in checkout.export()["templates"]}
    assert shapes["orders"] == "{orderId:string,total:number}"
    assert dict(msg.headers()) == {"trace": b"abc", PARENT_HEADER: f"1:{checkout.session_id}:{publish['id']}".encode()}

    consumed = event(payments, "orders")
    assert consumed["causality"] == "propagated"
    assert consumed["remoteParent"] == {"sessionId": checkout.session_id, "occurrenceId": publish["id"]}
    assert consumed["meta"] == {"topic": "orders", "partition": 0, "offset": 0, "group": "payments"}
    labels = {n["id"]: n["label"] for n in payments.export()["nodes"]}
    assert labels[consumed["handlerResults"][0]["handlerId"]] == "payments consumer"
    assert event(payments, "send")["parentId"] == consumed["id"]
    assert event(payments, "later")["parentId"] is None
    assert payments.export()["processes"][0]["id"] == "kafka::topic:orders"


def test_leaves_the_callers_headers_alone(ck: Any) -> None:
    ida.enable()
    headers = {"trace": "abc"}
    as_list = [("trace", b"abc")]
    p = ck.Producer({})
    p.produce("t", "1", headers=headers)
    p.produce("t", "2", None, -1, None, 0, as_list)  # all positional
    assert headers == {"trace": "abc"} and as_list == [("trace", b"abc")]
    assert all(dict(m.headers())[PARENT_HEADER] for m in ck.log)


def test_run_records_the_handler_and_its_errors(ck: Any) -> None:
    rec = ida.enable()
    ck.Producer({}).produce("jobs", '{"n":1}')
    ck.Producer({}).produce("jobs", '{"n":2}')
    consumer = ck.Consumer({"group.id": "workers"})
    seen: list[int] = []

    def process_job(msg: Any) -> None:
        n = json.loads(msg.value())["n"]
        seen.append(n)
        if n == 2:
            raise ValueError("bad job")

    with pytest.raises(ValueError, match="bad job"):
        kafka.run(consumer, process_job, poll_timeout=0)
    consumed = [o for o in rec.export()["occurrences"] if o["handlerResults"]]
    labels = {n["id"]: n["label"] for n in rec.export()["nodes"]}
    assert seen == [1, 2]
    assert [labels[o["handlerResults"][0]["handlerId"]] for o in consumed] == ["process_job", "process_job"]
    assert consumed[1]["handlerResults"][0]["error"]["message"] == "bad job"
    assert "error" not in consumed[0]["handlerResults"][0]


def test_run_stops_when_asked(ck: Any) -> None:
    ida.enable()
    stop = threading.Event()
    ck.Producer({}).produce("t", "{}")
    kafka.run(ck.Consumer({}), lambda _m: stop.set(), poll_timeout=0, stop=stop)
    assert stop.is_set()


def test_a_consume_batch_is_one_occurrence(ck: Any) -> None:
    rec = ida.enable()
    p = ck.Producer({})
    for i in range(3):
        p.produce("t", json.dumps({"i": i}))
    consumer = ck.Consumer({"group.id": "g"})
    assert len(consumer.consume(10)) == 3
    consumer.close()
    batch = [o for o in rec.export()["occurrences"] if o["handlerResults"]]
    assert len(batch) == 1
    assert batch[0]["meta"] == {
        "topic": "t",
        "partition": 0,
        "group": "g",
        "messages": 3,
        "firstOffset": 0,
        "lastOffset": 2,
    }
    assert batch[0]["remoteParent"]["occurrenceId"] == rec.export()["occurrences"][0]["id"]


def test_serializing_producer_and_deserializing_consumer(ck: Any) -> None:
    rec = ida.enable()
    ck.SerializingProducer({}).produce("orders", key="k", value={"id": 7})
    consumer = ck.DeserializingConsumer({"group.id": "g"})
    assert consumer.poll(0).value() == {"id": 7}
    consumer.close()
    shapes = [t["payloadShape"] for t in rec.export()["templates"]]
    assert shapes == ["{id:number}", "{id:number}"]
    assert [o["causality"] for o in rec.export()["occurrences"]] == ["sync", "propagated"]


def test_keys_only_when_asked(ck: Any) -> None:
    rec = ida.enable()
    kafka.instrument(ck, record_keys=True)
    ck.Producer({}).produce("t", "{}", key=b"user-7")
    assert rec.export()["occurrences"][0]["meta"]["key"] == "user-7"


def test_wrapping_existing_clients(ck: Any) -> None:
    rec = ida.enable()
    raw_producer = types.SimpleNamespace(
        produce=lambda topic, **kw: ck.log.append(Message(topic, kw["value"], None, kw["headers"], 0))
    )
    raw_consumer = ck.Consumer.__bases__[0]({})  # created before instrument(): not recorded
    kafka.wrap_producer(raw_producer).produce("t", b'{"a":1}')
    consumer = kafka.wrap_consumer(raw_consumer, group="legacy")
    consumer.poll(0)
    consumer.close()
    occ = rec.export()["occurrences"]
    assert len(occ) == 2 and occ[1]["meta"]["group"] == "legacy" and occ[1]["causality"] == "propagated"


def test_wrapping_a_recorded_client_changes_nothing(ck: Any) -> None:
    producer, consumer = ck.Producer({}), ck.Consumer({})
    assert kafka.wrap_producer(producer) is producer and kafka.wrap_consumer(consumer) is consumer
    proxy = kafka.wrap_consumer(ck.Consumer.__bases__[0]({}))
    assert kafka.wrap_consumer(proxy) is proxy
    serializing = ck.SerializingProducer({})
    assert kafka.wrap_producer(serializing) is serializing


def test_warns_once_when_nothing_records(ck: Any, caplog: pytest.LogCaptureFixture) -> None:
    p = ck.Producer({})
    p.produce("t", "1")
    p.produce("t", "2")
    assert len(ck.log) == 2 and ck.log[0].headers() is None
    assert len([r for r in caplog.records if "went unrecorded" in r.getMessage()]) == 1


def test_uninstall_restores_the_module() -> None:
    module = fake_module()
    original = module.Producer
    kafka.instrument(module)()
    assert module.Producer is original


def test_with_the_real_confluent_kafka() -> None:
    """Producing needs no broker (messages queue locally), so the real classes can be checked end to end."""
    import confluent_kafka

    _reset()
    uninstall = kafka.instrument()
    try:
        rec = ida.enable()
        assert issubclass(confluent_kafka.Producer, confluent_kafka.cimpl.Producer)
        producer = confluent_kafka.Producer({"bootstrap.servers": "127.0.0.1:1", "log_level": 0})
        producer.produce("orders", value=b'{"id":1}', headers={"trace": "x"})
        assert rec.export()["processes"][0]["id"] == "kafka::topic:orders"
        consumer = confluent_kafka.Consumer({"bootstrap.servers": "127.0.0.1:1", "group.id": "g", "log_level": 0})
        assert consumer.poll(0) is None
        consumer.close()
    finally:
        uninstall()
        _reset()
    assert confluent_kafka.Producer is confluent_kafka.cimpl.Producer


def test_a_wrapped_client_follows_whichever_of_proxy_and_original_is_tracked(ck: Any) -> None:
    a, b = ida.connect_recorder("a"), ida.connect_recorder("b")
    raw_one, raw_two = ck.Producer.__bases__[0]({}), ck.Producer.__bases__[0]({})
    one, two = kafka.wrap_producer(raw_one), kafka.wrap_producer(raw_two)
    a.track(one)  # the proxy
    b.track(raw_two)  # the original
    one.produce("t", "{}")
    two.produce("t", "{}")
    assert len(a.export()["occurrences"]) == 1 and len(b.export()["occurrences"]) == 1

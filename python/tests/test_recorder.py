from __future__ import annotations

import asyncio
import contextvars
import json
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest

import ida
from ida import DispatchInfo, Emitter, Recorder
from ida.core.keyed import _reset


@pytest.fixture(autouse=True)
def fresh() -> Iterator[None]:
    _reset()
    yield
    _reset()


def event(rec: Recorder, name: str) -> dict[str, Any]:
    out = rec.export()
    template_ids = {t["id"] for t in out["templates"] if t["eventName"] == name}
    return next(o for o in out["occurrences"] if o["templateId"] in template_ids)


def test_records_an_event_chain() -> None:
    rec = ida.enable()
    orders, payments = Emitter("Orders"), Emitter("Payments")

    @payments.on("charged")
    def send_receipt(payload: Any) -> None:
        pass

    @orders.on("placed")
    def charge(payload: Any) -> str:
        payments.emit("charged", {"amount": payload["total"]})
        return "ok"

    assert orders.emit("placed", {"id": "o-1", "total": 42}) == ["ok"]
    out = rec.export()
    assert [p["label"] for p in out["processes"]] == ["Orders", "Payments"]
    placed, charged = event(rec, "placed"), event(rec, "charged")
    charge_node = next(n for n in out["nodes"] if n["label"] == "charge")
    assert placed["parentId"] is None and placed["causality"] == "sync"
    assert charged == {**charged, "parentId": placed["id"], "sourceNodeId": charge_node["id"], "causality": "sync"}
    assert next(t for t in out["templates"] if t["eventName"] == "placed")["payloadShape"] == "{id:string,total:number}"
    assert placed["capture"] == "template" and "payload" not in placed
    json.dumps(out)  # the export is plain JSON


def test_deep_logging_keeps_payloads() -> None:
    rec = ida.enable(deep_logging=["placed"])
    bus = Emitter()
    bus.emit("placed", {"total": 42.5, "when": float("nan")})
    bus.emit("other", {"x": 1})
    assert event(rec, "placed")["payload"] == {"total": 42.5, "when": {"$eda": "NaN"}}
    assert "payload" not in event(rec, "other")


def test_records_a_handler_that_raises() -> None:
    rec = ida.enable()
    bus = Emitter("Bus")

    @bus.on("go")
    def boom(_: Any) -> None:
        raise ValueError("card declined")

    with pytest.raises(ValueError, match="card declined"):
        bus.emit("go")
    error = event(rec, "go")["handlerResults"][0]["error"]
    assert error["name"] == "ValueError" and error["message"] == "card declined" and "Traceback" in error["stack"]


def test_threads_that_copy_the_context_are_inferred() -> None:
    rec = ida.enable()
    bus = Emitter("Bus")

    @bus.on("start")
    def start(_: Any) -> None:
        ctx = contextvars.copy_context()
        t = threading.Thread(target=ctx.run, args=(bus.emit, "worker"))
        t.start()
        t.join()

    bus.emit("start")
    assert event(rec, "worker")["parentId"] == event(rec, "start")["id"]
    assert event(rec, "worker")["causality"] == "inferred"


def test_async_handlers_keep_their_chain_and_are_timed() -> None:
    rec = ida.enable()
    bus = Emitter("Bus")
    sent: list[dict[str, Any]] = []
    rec.subscribe(lambda m: sent.append(m))

    @bus.on("order")
    async def charge(_: Any) -> str:
        bus.emit("before-await")
        await asyncio.sleep(0.03)
        bus.emit("after-await")
        asyncio.get_running_loop().call_soon(bus.emit, "callback")
        await asyncio.sleep(0)
        return "charged"

    assert asyncio.run(bus.emit_async("order")) == ["charged"]
    order = event(rec, "order")
    assert event(rec, "before-await")["parentId"] == order["id"]
    assert event(rec, "after-await")["causality"] == "sync"  # same task: exact
    assert event(rec, "callback") == {**event(rec, "callback"), "parentId": order["id"], "causality": "inferred"}
    assert order["handlerResults"][0]["durationMs"] >= 25
    # Sent once when emit returned and again, complete, when the coroutine finished.
    assert [m["occurrence"]["id"] for m in sent].count(order["id"]) == 2


def test_async_handler_errors_are_recorded_and_raised() -> None:
    rec = ida.enable()
    bus = Emitter("Bus")

    @bus.on("pay")
    async def pay(_: Any) -> None:
        await asyncio.sleep(0)
        raise RuntimeError("declined")

    with pytest.raises(RuntimeError, match="declined"):
        asyncio.run(bus.emit_async("pay"))
    assert event(rec, "pay")["handlerResults"][0]["error"]["message"] == "declined"


def test_open_scopes_parent_everything_until_closed() -> None:
    rec = ida.enable()
    bus = Emitter("Bus")
    topic = object()

    def consumer() -> None: ...

    scope = rec.open(DispatchInfo(emitter=topic, event_name="msg", label="orders"), consumer)
    bus.emit("inside")
    scope.close(ValueError("bad message"))
    bus.emit("outside")
    msg = event(rec, "msg")
    assert event(rec, "inside")["parentId"] == msg["id"]
    assert event(rec, "outside")["parentId"] is None
    assert msg["handlerResults"][0]["error"]["message"] == "bad message"
    assert scope.recorded == {"sessionId": rec.session_id, "occurrenceId": msg["id"]}


def test_broker_processes_get_shared_ids() -> None:
    rec = ida.enable()
    info = DispatchInfo(
        emitter=object(),
        event_name="orders",
        broker=ida.BrokerRef("kafka", "topic", "orders"),
        meta={"topic": "orders", "partition": 0},
        remote_parent={"sessionId": "s", "occurrenceId": "e1"},
    )
    rec.dispatch(info, lambda _inv, _rec: None)
    out = rec.export()
    assert out["processes"] == [
        {"id": "kafka::topic:orders", "label": "orders", "kind": "topic", "broker": {"type": "kafka"}}
    ]
    occ = out["occurrences"][0]
    assert occ["causality"] == "propagated" and occ["meta"] == {"topic": "orders", "partition": 0}
    assert occ["remoteParent"] == {"sessionId": "s", "occurrenceId": "e1"}


def test_routing_and_keyed_recorders() -> None:
    default = ida.enable()
    payments = ida.connect_recorder("payments")
    assert ida.connect_recorder("payments") is payments
    tracked, untracked = Emitter("Tracked"), Emitter("Untracked")
    payments.track(tracked)
    tracked.emit("a")
    untracked.emit("b")
    assert len(payments.export()["occurrences"]) == 1 and len(default.export()["occurrences"]) == 1
    # Two recorders on one emitter: both record it, the handler runs once.
    calls: list[int] = []
    tracked.on("c", lambda _: calls.append(1))
    default.track(tracked)
    tracked.emit("c")
    assert calls == [1] and len(payments.export()["occurrences"]) == 2 and len(default.export()["occurrences"]) == 2
    with pytest.raises(ValueError):
        ida.connect_recorder("bad key!")


def test_nothing_is_recorded_without_a_recorder_or_while_stopped() -> None:
    bus = Emitter()
    assert bus.emit("x") == []
    rec = ida.enable()
    rec.stop()
    bus.emit("x")
    assert rec.export()["occurrences"] == []


def test_window_and_count_limits_evict_old_events() -> None:
    clock = [0.0]
    rec = Recorder("r", window_ms=100, max_events=3, now=lambda: clock[0])
    ida.set_default_recorder(rec)
    bus = Emitter()
    for t in [0, 10, 20, 30, 200]:
        clock[0] = t
        bus.emit("tick")
    assert [o["ts"] for o in rec.export()["occurrences"]] == [200]
    assert rec.export()["templates"][0]["sampleCount"] == 1


def test_labels_and_wall_time() -> None:
    rec = ida.enable()
    bus = Emitter()
    rec.label_emitter(bus, "Checkout")

    def on_go(_: Any) -> None: ...

    rec.label_handler(on_go, "start checkout")
    bus.on("go", on_go)
    bus.emit("go")
    labels = {n["label"] for n in rec.export()["nodes"]}
    assert labels == {"Checkout", "start checkout"}
    assert abs(rec.wall_time() - (rec.started_at + event(rec, "go")["ts"])) < 1_000


@dataclass
class Order:
    id: str
    total: float


def test_shapes_of_python_objects() -> None:
    assert ida.payload_shape(Order("o", 1.0)) == "Order{id:string,total:number}"
    assert ida.payload_shape({"o": Order("o", 1.0)}) == "{o:Order{id:string,total:number}}"
    loop: dict[str, Any] = {}
    loop["self"] = loop
    assert ida.payload_shape(loop) == "{self:[Circular]}"


def test_bound_methods_are_one_handler() -> None:
    rec = ida.enable()
    bus = Emitter()

    class Service:
        def handle(self, _: Any) -> None: ...

    svc = Service()
    bus.on("a", svc.handle)
    bus.on("b", svc.handle)
    bus.emit("a")
    bus.emit("b")
    handlers = [n for n in rec.export()["nodes"] if n["kind"] == "handler"]
    assert [h["label"] for h in handlers] == [
        "test_bound_methods_are_one_handler.<locals>.Service.handle".rsplit("<locals>.", 1)[-1]
    ]

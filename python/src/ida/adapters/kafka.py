"""
Records Kafka traffic through confluent-kafka.

>>> import ida, ida.adapters.kafka
>>> ida.enable()
>>> ida.adapters.kafka.instrument()       # before creating producers and consumers
>>> from confluent_kafka import Producer   # import the classes after instrument()

Each produced message becomes an occurrence on its topic, emitted by the handler that was running, and carries an
``ida-parent`` header. confluent-kafka consumers are poll-based, so there is no handler function to wrap: each message
``poll()`` returns opens an occurrence that stays current until the next ``poll()``, and everything your code emits
meanwhile points back at it. Use `run()` to have your handler function recorded by name and its exceptions recorded.
"""

from __future__ import annotations

import inspect
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ..core.propagation import PARENT_HEADER, format_parent_header, parse_parent_header
from ..core.recorder import DispatchInfo, Recorder
from ..core.registry import BrokerRef
from ..core.routing import Scopes, dispatch_all, get_default_recorder, is_tracked, open_all, recorders_for
from ._decode import decode

log = logging.getLogger("ida")

_PRODUCE_ARGS = ("value", "key", "partition", "on_delivery", "timestamp", "headers")


@dataclass
class _Options:
    recorder: Optional[Recorder] = None
    cluster: str = ""
    record_keys: bool = False
    warn_if_no_recorder: bool = True


_options = _Options()
_topics: dict[str, object] = {}
_topics_lock = threading.Lock()
_warned = False


def _topic(name: str) -> object:
    with _topics_lock:
        token = _topics.get(name)
        if token is None:
            token = _topics[name] = type("KafkaTopic", (), {"name": name})()
        return token


def _targets(client: Any) -> list[Recorder]:
    if _options.recorder:
        return [_options.recorder] if _options.recorder.recording else []
    # A wrapped client is routed by whichever of the proxy and the original your code tracked.
    if isinstance(client, _Proxy) and not is_tracked(client) and is_tracked(client._inner):
        return recorders_for(client._inner)
    return recorders_for(client)


def _warn_unrecorded(topic: str) -> None:
    global _warned
    if _warned or _options.recorder or not _options.warn_if_no_recorder or get_default_recorder():
        return
    _warned = True
    log.warning(
        '[ida] a Kafka message on "%s" went unrecorded because no recorder is receiving it. Call ida.enable() first, '
        "or ida.connect_recorder(key).track(producer_or_consumer). Pass warn_if_no_recorder=False to instrument() to "
        "silence this.",
        topic,
    )


def _info(topic: str, payload: Any, meta: dict[str, Any], **extra: Any) -> DispatchInfo:
    return DispatchInfo(
        emitter=_topic(topic),
        label=topic,
        event_name=topic,
        payload=payload,
        broker=BrokerRef("kafka", "topic", topic, _options.cluster),
        meta=meta,
        **extra,
    )


def _with_header(headers: Any, value: bytes) -> Any:
    """The message's headers plus ``ida-parent``. The caller's dict or list is never modified."""
    if headers is None:
        return [(PARENT_HEADER, value)]
    if isinstance(headers, dict):
        return {**headers, PARENT_HEADER: value}
    return [*headers, (PARENT_HEADER, value)]


def _stamp(client: Any, topic: str, value: Any, key: Any, partition: Any, headers: Any) -> Any:
    """Records one outgoing message and returns its headers with ``ida-parent`` added."""
    recorders = _targets(client)
    if not recorders:
        _warn_unrecorded(topic)
        return headers
    meta: dict[str, Any] = {"topic": topic}
    if isinstance(partition, int) and partition >= 0:
        meta["partition"] = partition
    if _options.record_keys and key is not None:
        meta["key"] = key.decode("utf-8", "replace") if isinstance(key, (bytes, bytearray)) else str(key)
    return dispatch_all(
        recorders,
        _info(topic, decode(value), meta),
        lambda _invoke, rec: _with_header(headers, format_parent_header(rec).encode()) if rec else headers,
    )


def _header_parent(msg: Any) -> Any:
    for name, value in msg.headers() or []:
        if name == PARENT_HEADER:
            return parse_parent_header(value)
    return None


# --- consumers: an occurrence per poll, open until the next one ---


def _consume_handler(group: str) -> Callable[..., Any]:
    """Stands in for "your code after poll()" in the graph, named after the consumer group."""

    def handler(*_: Any) -> None: ...

    handler.__qualname__ = handler.__name__ = f"{group or 'kafka'} consumer"
    return handler


def _init_consumer(consumer: Any, config: Any) -> None:
    group = config.get("group.id", "") if isinstance(config, dict) else ""
    consumer._ida_group = group
    consumer._ida_handler = _consume_handler(group)
    consumer._ida_scope = None


def _close_scope(consumer: Any, error: Optional[BaseException] = None) -> None:
    scope: Optional[Scopes] = getattr(consumer, "_ida_scope", None)
    if scope is not None:
        consumer._ida_scope = None
        scope.close(error)


def _open_scope(consumer: Any, messages: Sequence[Any]) -> None:
    good = [m for m in messages if m is not None and m.error() is None]
    if not good:
        return
    first = good[0]
    topic = first.topic()
    recorders = _targets(consumer)
    if not recorders:
        _warn_unrecorded(topic)
        return
    group = getattr(consumer, "_ida_group", "")
    if len(good) == 1:
        meta: dict[str, Any] = {
            "topic": topic,
            "partition": first.partition(),
            "offset": first.offset(),
            "group": group,
        }
        payload = decode(first.value())
    else:
        # A batch from consume(): one occurrence, linked to the first message that names its producer.
        meta = {
            "topic": topic,
            "partition": first.partition(),
            "group": group,
            "messages": len(good),
            "firstOffset": good[0].offset(),
            "lastOffset": good[-1].offset(),
        }
        payload = [decode(m.value()) for m in good[:20]]
    if _options.record_keys and len(good) == 1 and first.key() is not None:
        key = first.key()
        meta["key"] = key.decode("utf-8", "replace") if isinstance(key, (bytes, bytearray)) else str(key)
    parent = next((p for p in (_header_parent(m) for m in good) if p), None)
    consumer._ida_scope = open_all(recorders, _info(topic, payload, meta, remote_parent=parent), consumer._ida_handler)


def _recording_producer(base: type) -> type:
    class RecordingProducer(base):  # type: ignore[misc]
        """confluent_kafka.Producer, recorded by Ida."""

        def produce(self, topic: str, *args: Any, **kwargs: Any) -> Any:
            kw = dict(zip(_PRODUCE_ARGS, args))
            kw.update(kwargs)
            kw["headers"] = _stamp(
                self, topic, kw.get("value"), kw.get("key"), kw.get("partition", -1), kw.get("headers")
            )
            return super().produce(topic, **kw)

    RecordingProducer.produce._ida = True  # type: ignore[attr-defined]
    RecordingProducer.__name__ = RecordingProducer.__qualname__ = "Producer"
    return RecordingProducer


def _recording_consumer(base: type) -> type:
    class RecordingConsumer(base):  # type: ignore[misc]
        """confluent_kafka.Consumer, recorded by Ida."""

        def __init__(self, config: Any = None, *args: Any, **kwargs: Any) -> None:
            if config is None:
                super().__init__(*args, **kwargs)
            else:
                super().__init__(config, *args, **kwargs)
            _init_consumer(self, config if config is not None else kwargs)

        def poll(self, *args: Any, **kwargs: Any) -> Any:
            _close_scope(self)
            msg = super().poll(*args, **kwargs)
            _open_scope(self, [msg])
            return msg

        def consume(self, *args: Any, **kwargs: Any) -> Any:
            _close_scope(self)
            messages = super().consume(*args, **kwargs)
            _open_scope(self, messages)
            return messages

        def close(self, *args: Any, **kwargs: Any) -> Any:
            _close_scope(self)
            return super().close(*args, **kwargs)

    RecordingConsumer.__name__ = RecordingConsumer.__qualname__ = "Consumer"
    return RecordingConsumer


class _Proxy:
    def __init__(self, inner: Any) -> None:
        object.__setattr__(self, "_inner", inner)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class ProducerProxy(_Proxy):
    """A recorded view of an existing producer. See `wrap_producer`."""

    def produce(self, topic: str, *args: Any, **kwargs: Any) -> Any:
        kw = dict(zip(_PRODUCE_ARGS, args))
        kw.update(kwargs)
        kw["headers"] = _stamp(self, topic, kw.get("value"), kw.get("key"), kw.get("partition", -1), kw.get("headers"))
        return self._inner.produce(topic, **kw)


class ConsumerProxy(_Proxy):
    """A recorded view of an existing consumer. See `wrap_consumer`."""

    def __init__(self, inner: Any, group: str = "") -> None:
        super().__init__(inner)
        _init_consumer(self, {"group.id": group})

    def __setattr__(self, name: str, value: Any) -> None:
        object.__setattr__(self, name, value)

    def poll(self, *args: Any, **kwargs: Any) -> Any:
        _close_scope(self)
        msg = self._inner.poll(*args, **kwargs)
        _open_scope(self, [msg])
        return msg

    def consume(self, *args: Any, **kwargs: Any) -> Any:
        _close_scope(self)
        messages = self._inner.consume(*args, **kwargs)
        _open_scope(self, messages)
        return messages

    def close(self, *args: Any, **kwargs: Any) -> Any:
        _close_scope(self)
        return self._inner.close(*args, **kwargs)


def wrap_producer(producer: Any) -> Any:
    """For a producer created before `instrument()` (or by a library): a recorded proxy to use in its place. A
    producer that is already recorded is returned as it is, so nothing is recorded twice."""
    if isinstance(producer, ProducerProxy) or getattr(getattr(type(producer), "produce", None), "_ida", False):
        return producer
    return ProducerProxy(producer)


def wrap_consumer(consumer: Any, group: str = "") -> Any:
    """For a consumer created before `instrument()`: a recorded proxy to use in its place. `group` names it. A
    consumer that is already recorded is returned as it is."""
    if hasattr(consumer, "_ida_handler"):
        return consumer
    return ConsumerProxy(consumer, group)


def run(
    consumer: Any,
    handler: Callable[[Any], Any],
    *,
    poll_timeout: float = 1.0,
    stop: Optional[threading.Event] = None,
) -> None:
    """
    A poll loop that calls ``handler(message)`` for each message, recorded under your handler's name, with its
    exceptions recorded (and raised, which ends the loop). Messages with an error are skipped. Runs until `stop` is set.

    >>> ida.adapters.kafka.run(consumer, charge_card, stop=shutdown)
    """
    if not hasattr(consumer, "_ida_handler"):
        raise TypeError("[ida] run() needs a recorded consumer: create it after instrument(), or wrap_consumer() it")
    previous = consumer._ida_handler
    consumer._ida_handler = handler
    try:
        while stop is None or not stop.is_set():
            msg = consumer.poll(poll_timeout)
            if msg is None or msg.error() is not None:
                continue
            try:
                handler(msg)
            except Exception as err:
                _close_scope(consumer, err)
                raise
    finally:
        _close_scope(consumer)
        consumer._ida_handler = previous


def instrument(
    module: Any = None,
    *,
    recorder: Optional[Recorder] = None,
    cluster: str = "",
    record_keys: bool = False,
    warn_if_no_recorder: bool = True,
) -> Callable[[], None]:
    """
    Replaces ``confluent_kafka.Producer`` and ``Consumer`` with recorded subclasses, and records
    ``SerializingProducer`` / ``DeserializingConsumer``. Producers and consumers created afterwards are recorded;
    import the classes after calling it (``from confluent_kafka import Producer`` binds whatever is there then).

    :param recorder: where to record. By default each producer or consumer goes to the recorders that ``track()`` it,
        or else the default recorder (see `ida.enable()`).
    :param cluster: a name for the Kafka cluster, part of each topic's id, when services use more than one.
    :param record_keys: keep message keys in ``meta``. Off by default: keys are often ids from your data.
    :returns: a function that puts confluent_kafka back.
    """
    global _options, _warned
    if module is None:
        import confluent_kafka as module  # noqa: PLC0415
    _options = _Options(recorder, cluster, record_keys, warn_if_no_recorder)
    _warned = False
    undo: list[Callable[[], None]] = []

    def replace(target: Any, name: str, value: Any) -> None:
        original = getattr(target, name)
        setattr(target, name, value)
        undo.append(lambda: setattr(target, name, original))

    replace(module, "Producer", _recording_producer(module.Producer))
    replace(module, "Consumer", _recording_consumer(module.Consumer))

    serializing = getattr(module, "SerializingProducer", None)
    if serializing is not None and "produce" in vars(serializing):
        original_produce = serializing.produce
        signature = inspect.signature(original_produce)

        def produce(self: Any, topic: str, *args: Any, **kwargs: Any) -> Any:
            bound = signature.bind(self, topic, *args, **kwargs)
            a = bound.arguments
            # The value before serialization: the object your code passed in.
            a["headers"] = _stamp(self, topic, a.get("value"), a.get("key"), a.get("partition", -1), a.get("headers"))
            return original_produce(*bound.args, **bound.kwargs)

        produce._ida = True  # type: ignore[attr-defined]
        replace(serializing, "produce", produce)

    deserializing = getattr(module, "DeserializingConsumer", None)
    if deserializing is not None and "poll" in vars(deserializing):
        original_init, original_poll = deserializing.__init__, deserializing.poll

        def init(self: Any, conf: Any, *args: Any, **kwargs: Any) -> None:
            original_init(self, conf, *args, **kwargs)
            _init_consumer(self, conf)

        def poll(self: Any, *args: Any, **kwargs: Any) -> Any:
            _close_scope(self)
            msg = original_poll(self, *args, **kwargs)
            _open_scope(self, [msg])
            return msg

        replace(deserializing, "__init__", init)
        replace(deserializing, "poll", poll)

    def uninstall() -> None:
        for u in reversed(undo):
            u()

    return uninstall

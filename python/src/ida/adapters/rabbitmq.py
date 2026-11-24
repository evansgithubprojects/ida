"""
Records RabbitMQ traffic through pika (BlockingConnection, SelectConnection and the other adapters).

>>> import ida, ida.adapters.rabbitmq
>>> ida.enable()
>>> ida.adapters.rabbitmq.instrument()

Each ``basic_publish`` becomes an occurrence on its exchange, emitted by the handler that was running, and carries an
``ida-parent`` header. Each delivery to a ``basic_consume`` callback becomes an occurrence on its queue, handled by
that callback and linked back to the service that published it. Messages from ``BlockingChannel.consume()`` open an
occurrence that stays current until the generator yields the next one.
"""

from __future__ import annotations

import copy
import logging
import threading
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ..core.propagation import PARENT_HEADER, format_parent_header, parse_parent_header
from ..core.recorder import DispatchInfo, Recorder
from ..core.registry import BrokerRef
from ..core.routing import Scopes, dispatch_all, get_default_recorder, is_tracked, open_all, recorders_for
from ._decode import decode

log = logging.getLogger("ida")


@dataclass
class _Options:
    recorder: Optional[Recorder] = None
    warn_if_no_recorder: bool = True


_options = _Options()
_tokens: dict[tuple[str, str, str], object] = {}
_tokens_lock = threading.Lock()
_inside = threading.local()  # BlockingChannel calls the inner Channel: record the outer call only
_warned = False


def _token(kind: str, vhost: str, name: str) -> object:
    with _tokens_lock:
        key = (kind, vhost, name)
        token = _tokens.get(key)
        if token is None:
            token = _tokens[key] = type("RabbitMQ", (), {"name": name})()
        return token


def _connection_of(channel: Any) -> Any:
    try:
        return channel.connection
    except Exception:
        return None


def _vhost(channel: Any) -> str:
    conn = _connection_of(channel)
    for holder in (conn, getattr(conn, "_impl", None)):
        params = getattr(holder, "params", None)
        vhost = getattr(params, "virtual_host", None)
        if isinstance(vhost, str):
            return vhost or "/"
    return "/"


def _targets(channel: Any) -> list[Recorder]:
    if _options.recorder:
        return [_options.recorder] if _options.recorder.recording else []
    conn = _connection_of(channel)
    if is_tracked(channel) or conn is None:
        return recorders_for(channel)
    return recorders_for(conn)


def _warn_unrecorded(what: str) -> None:
    global _warned
    if _warned or _options.recorder or not _options.warn_if_no_recorder or get_default_recorder():
        return
    _warned = True
    log.warning(
        "[ida] a RabbitMQ message (%s) went unrecorded because no recorder is receiving it. Call ida.enable() first, "
        "or ida.connect_recorder(key).track(connection). Pass warn_if_no_recorder=False to instrument() to silence "
        "this.",
        what,
    )


def _depth() -> int:
    return getattr(_inside, "depth", 0)


class _Inside:
    def __enter__(self) -> None:
        _inside.depth = _depth() + 1

    def __exit__(self, *_: Any) -> None:
        _inside.depth = _depth() - 1


def _with_header(properties: Any, value: str) -> Any:
    """A copy of the message properties with ``ida-parent`` added. The caller's object is never modified."""
    import pika  # noqa: PLC0415

    props = copy.copy(properties) if properties is not None else pika.BasicProperties()
    props.headers = {**(props.headers or {}), PARENT_HEADER: value}
    return props


def _publish_wrapper(original: Callable[..., Any]) -> Callable[..., Any]:
    def basic_publish(
        self: Any, exchange: str, routing_key: str, body: Any, properties: Any = None, *args: Any, **kwargs: Any
    ) -> Any:
        if _depth():
            return original(self, exchange, routing_key, body, properties, *args, **kwargs)
        with _Inside():
            recorders = _targets(self)
            if not recorders:
                _warn_unrecorded(f'published to "{exchange or routing_key}"')
                return original(self, exchange, routing_key, body, properties, *args, **kwargs)
            vhost = _vhost(self)
            info = DispatchInfo(
                emitter=_token("exchange", vhost, exchange),
                label=exchange or "(default exchange)",
                event_name=routing_key or exchange,
                payload=decode(body),
                broker=BrokerRef("rabbitmq", "exchange", exchange, vhost),
                meta={"exchange": exchange, "routingKey": routing_key},
            )

            def send(_invoke: Any, rec: Any) -> Any:
                props = _with_header(properties, format_parent_header(rec)) if rec else properties
                return original(self, exchange, routing_key, body, props, *args, **kwargs)

            return dispatch_all(recorders, info, send)

    return basic_publish


def _delivery_info(channel: Any, queue: str, method: Any, properties: Any, body: Any, **extra: Any) -> DispatchInfo:
    vhost = _vhost(channel)
    exchange = getattr(method, "exchange", "")
    routing_key = getattr(method, "routing_key", "")
    headers = getattr(properties, "headers", None) or {}
    return DispatchInfo(
        emitter=_token("queue", vhost, queue),
        label=queue,
        event_name=routing_key or queue,
        payload=decode(body),
        broker=BrokerRef("rabbitmq", "queue", queue, vhost),
        meta={
            "exchange": exchange,
            "routingKey": routing_key,
            "queue": queue,
            "deliveryTag": getattr(method, "delivery_tag", None),
            "redelivered": bool(getattr(method, "redelivered", False)),
        },
        remote_parent=parse_parent_header(headers.get(PARENT_HEADER)),
        **extra,
    )


def _consume_wrapper(original: Callable[..., Any]) -> Callable[..., Any]:
    def basic_consume(self: Any, queue: str, on_message_callback: Any, *args: Any, **kwargs: Any) -> Any:
        if _depth() or not callable(on_message_callback):
            return original(self, queue, on_message_callback, *args, **kwargs)
        channel = self

        def on_message(ch: Any, method: Any, properties: Any, body: Any) -> Any:
            recorders = _targets(channel)
            if not recorders:
                _warn_unrecorded(f'delivered from "{queue}"')
                return on_message_callback(ch, method, properties, body)
            info = _delivery_info(channel, queue, method, properties, body, handlers=[on_message_callback])
            return dispatch_all(
                recorders,
                info,
                lambda invoke, _rec: invoke(
                    on_message_callback, lambda: on_message_callback(ch, method, properties, body)
                ),
            )

        with _Inside():
            return original(self, queue, on_message, *args, **kwargs)

    return basic_consume


def _consume_generator_wrapper(original: Callable[..., Any]) -> Callable[..., Any]:
    def consume(self: Any, queue: str, *args: Any, **kwargs: Any) -> Generator[Any, None, None]:
        inner = original(self, queue, *args, **kwargs)
        handler = _generator_handler(queue)
        scope: Optional[Scopes] = None
        try:
            while True:
                if scope:
                    scope.close()
                    scope = None
                with _Inside():
                    try:
                        item = next(inner)
                    except StopIteration:
                        return
                method, properties, body = item
                if method is not None:  # (None, None, None) after an inactivity timeout
                    recorders = _targets(self)
                    if recorders:
                        scope = open_all(recorders, _delivery_info(self, queue, method, properties, body), handler)
                    else:
                        _warn_unrecorded(f'delivered from "{queue}"')
                yield item
        finally:
            if scope:
                scope.close()
            inner.close()

    return consume


def _generator_handler(queue: str) -> Callable[..., Any]:
    def handler(*_: Any) -> None: ...

    handler.__qualname__ = handler.__name__ = f"{queue} consumer"
    return handler


def instrument(*, recorder: Optional[Recorder] = None, warn_if_no_recorder: bool = True) -> Callable[[], None]:
    """
    Records pika: ``basic_publish`` and ``basic_consume`` on every channel type, and ``BlockingChannel.consume()``.
    Works for connections and channels created before or after the call.

    :param recorder: where to record. By default each channel goes to the recorders that ``track()`` it or its
        connection, or else the default recorder (see `ida.enable()`).
    :returns: a function that puts pika back.
    """
    global _options, _warned
    import pika.adapters.blocking_connection as blocking  # noqa: PLC0415
    import pika.channel  # noqa: PLC0415

    _options = _Options(recorder, warn_if_no_recorder)
    _warned = False
    undo: list[Callable[[], None]] = []

    def patch(cls: Any, name: str, wrap: Callable[[Callable[..., Any]], Callable[..., Any]]) -> None:
        original = cls.__dict__[name]
        setattr(cls, name, wrap(original))
        undo.append(lambda: setattr(cls, name, original))

    for cls in (blocking.BlockingChannel, pika.channel.Channel):
        patch(cls, "basic_publish", _publish_wrapper)
        patch(cls, "basic_consume", _consume_wrapper)
    patch(blocking.BlockingChannel, "consume", _consume_generator_wrapper)

    def uninstall() -> None:
        for u in reversed(undo):
            u()

    return uninstall

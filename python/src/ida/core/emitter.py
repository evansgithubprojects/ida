"""A small in-process event bus whose events are recorded: the Python counterpart of Node's EventEmitter."""

from __future__ import annotations

import inspect
from typing import Any, Callable, Optional

from .recorder import DispatchInfo
from .routing import dispatch_all, recorders_for

Handler = Callable[..., Any]


class Emitter:
    """
    Register handlers with `on`, fire events with `emit` (or `emit_async` for coroutine handlers). Every event is
    recorded by the recorders that `track()` this emitter, or else the default one (see `ida.enable()`).

    >>> orders = Emitter("Orders")
    >>> orders.on("placed", charge_card)
    >>> orders.emit("placed", {"id": "o-1", "total": 42})
    """

    def __init__(self, label: Optional[str] = None) -> None:
        self.label = label
        self._handlers: dict[str, list[Handler]] = {}

    def on(self, event: str, handler: Optional[Handler] = None) -> Any:
        """Adds a handler. Without one, returns a decorator: ``@orders.on("placed")``."""
        if handler is None:

            def register(fn: Handler) -> Handler:
                self.on(event, fn)
                return fn

            return register
        self._handlers.setdefault(event, []).append(handler)
        return handler

    def off(self, event: str, handler: Handler) -> None:
        handlers = self._handlers.get(event, [])
        if handler in handlers:
            handlers.remove(handler)

    def listeners(self, event: str) -> list[Handler]:
        return list(self._handlers.get(event, []))

    def emit(self, event: str, payload: Any = None) -> list[Any]:
        """Calls each handler with `payload`, in order, and returns their results. A handler that raises stops the
        rest, and the exception propagates, as with any function call."""
        handlers = self.listeners(event)
        info = DispatchInfo(emitter=self, label=self.label, event_name=event, handlers=handlers, payload=payload)
        return dispatch_all(
            recorders_for(self), info, lambda invoke, _rec: [invoke(h, _caller(h, payload)) for h in handlers]
        )

    async def emit_async(self, event: str, payload: Any = None) -> list[Any]:
        """Like `emit`, awaiting coroutine handlers one after another."""
        results = []
        for out in self.emit(event, payload):
            results.append(await out if inspect.isawaitable(out) else out)
        return results


def _caller(handler: Handler, payload: Any) -> Callable[[], Any]:
    return lambda: handler(payload)

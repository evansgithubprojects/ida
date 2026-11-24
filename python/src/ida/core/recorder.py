"""The recorder: turns each dispatched event into an occurrence, grouped by template, with causality."""

from __future__ import annotations

import inspect
import threading
import time
import traceback
import uuid
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, TypeVar, Union

from .buffer import RingBuffer
from .causality import CausalityContext, ContextVarContext
from .json_safe import to_json_safe
from .propagation import RemoteParent
from .registry import BrokerRef, Registry
from .shapes import TemplateKeyFn, TemplateParts, default_template_key, payload_shape

#: Version of the recording format (see `RECORDING_VERSION` in the JS core).
RECORDING_VERSION = 2

T = TypeVar("T")

#: Which events keep their full payload: a list of event names, or a function of (event name, emitter label).
DeepLogging = Union[Sequence[str], Callable[[str, str], bool], None]

#: Runs one handler under the current event: ``invoke(handler, lambda: handler(payload))``.
Invoke = Callable[[Callable[..., Any], Callable[[], Any]], Any]

Listener = Callable[[dict[str, Any]], None]


@dataclass
class DispatchInfo:
    """What an adapter hands the recorder for one event."""

    #: The object the event was emitted on. It becomes a process in the graph.
    emitter: Any
    event_name: str
    #: The handlers that will run, in order. Each becomes a handler node.
    handlers: Sequence[Callable[..., Any]] = ()
    #: The raw payload. Only stored when the event is deep-logged; its shape always is.
    payload: Any = None
    #: Display name hint for the emitter's process.
    label: Optional[str] = None
    #: Set when the emitter is a topic, exchange or queue.
    broker: Optional[BrokerRef] = None
    #: Small facts kept even when the payload isn't (topic, partition, offset, routing key, ...).
    meta: Optional[dict[str, Any]] = None
    #: The publish this event consumes, from the message's ``ida-parent`` header.
    remote_parent: Optional[RemoteParent] = None


@dataclass
class Frame:
    event_id: str
    handler_id: str


@dataclass
class _Dispatch:
    occurrence: dict[str, Any]
    template: dict[str, Any]
    emitter: Any
    unsettled: int = 0
    finalized: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


def _error_info(err: BaseException) -> dict[str, Any]:
    return {
        "name": type(err).__name__,
        "message": str(err),
        "stack": "".join(traceback.format_exception(type(err), err, err.__traceback__)),
    }


class _Templates:
    def __init__(self, key_fn: TemplateKeyFn) -> None:
        self._key_fn = key_fn
        self._by_key: dict[str, dict[str, Any]] = {}
        self._by_id: dict[str, dict[str, Any]] = {}
        self._seq = 0

    def intern(self, parts: TemplateParts) -> dict[str, Any]:
        key = self._key_fn(parts)
        t = self._by_key.get(key)
        if not t:
            self._seq += 1
            t = {
                "id": f"t{self._seq}",
                "key": key,
                "emitterId": parts["emitterId"],
                "eventName": parts["eventName"],
                "handlerIds": list(parts["handlerIds"]),
                "payloadShape": parts["payloadShape"],
                "sampleCount": 0,
            }
            self._by_key[key] = t
            self._by_id[t["id"]] = t
        t["sampleCount"] += 1
        return t

    def release(self, template_id: str) -> None:
        t = self._by_id.get(template_id)
        if not t:
            return
        t["sampleCount"] -= 1
        if t["sampleCount"] <= 0:
            del self._by_id[template_id]
            self._by_key.pop(t["key"], None)

    def all(self) -> list[dict[str, Any]]:
        return list(self._by_id.values())

    def clear(self) -> None:
        self._by_key.clear()
        self._by_id.clear()


class Scope:
    """An occurrence whose handler is "whatever runs until `close()`": see `Recorder.open`."""

    def __init__(self, close: Callable[[Optional[BaseException]], None], recorded: Optional[RemoteParent]) -> None:
        self._close = close
        self._closed = False
        #: The recorded occurrence, for an outgoing message's ``ida-parent`` header.
        self.recorded = recorded

    def close(self, error: Optional[BaseException] = None) -> None:
        if not self._closed:
            self._closed = True
            self._close(error)

    def __enter__(self) -> Scope:
        return self

    def __exit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> None:
        self.close(exc)


class Recorder:
    """
    Records events. Adapters call `dispatch()` for you; read the result with `export()`. Most apps want `ida.enable()`
    or `ida.connect_recorder(key)` instead of constructing one.
    """

    def __init__(
        self,
        key: str = "unnamed",
        *,
        window_ms: float = 5 * 60_000,
        max_events: int = 50_000,
        deep_logging: DeepLogging = None,
        template_key: Optional[TemplateKeyFn] = None,
        context: Optional[CausalityContext[Frame]] = None,
        auto_start: bool = True,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self.key = key
        #: This run's id. Uploads file the run under it; broker adapters write it into ``ida-parent`` headers.
        self.session_id = str(uuid.uuid4())
        self._now = now or (lambda: time.perf_counter() * 1000)
        self._origin = self._now()
        #: Epoch milliseconds when recording started.
        self.started_at = time.time_ns() // 1_000_000  # whole epoch ms, as the wire format requires
        self._deep = deep_logging
        self._registry = Registry()
        self._templates = _Templates(template_key or default_template_key)
        self._buffer = RingBuffer(max_events, window_ms)
        self._ctx: CausalityContext[Frame] = context or ContextVarContext()
        self._listeners: list[Listener] = []
        self._recording = auto_start
        self._seq = 0
        self._lock = threading.RLock()

    # --- clock ---

    def wall_time(self) -> float:
        """The current time on this recorder's clock, in epoch ms: `started_at` plus the current ``ts``. Monotonic."""
        return self.started_at + self._now() - self._origin

    def _ts(self) -> float:
        return self._now() - self._origin

    # --- control ---

    @property
    def recording(self) -> bool:
        return self._recording

    def start(self) -> None:
        self._recording = True

    def stop(self) -> None:
        self._recording = False

    def track(self, emitter: Any) -> None:
        """Claim an emitter (or a Kafka client / RabbitMQ connection): adapters send its events here."""
        from .routing import track

        track(self, emitter)

    def untrack(self, emitter: Any) -> None:
        from .routing import untrack

        untrack(self, emitter)

    def label_emitter(self, emitter: Any, label: str) -> None:
        """Name an emitter's process in the viewer. Call it before the emitter's first recorded event."""
        self._registry.label_emitter(emitter, label)

    def label_handler(self, fn: Callable[..., Any], label: str) -> None:
        """Name a handler in the viewer. Without it, the function's qualified name is used."""
        self._registry.label_handler(fn, label)

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """Receive each new occurrence as it happens. Returns a function that stops the subscription."""
        with self._lock:
            self._listeners.append(listener)

        def stop() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return stop

    def _emit(self, message: dict[str, Any]) -> None:
        for listener in list(self._listeners):
            listener(message)

    # --- recording ---

    def _deep_logged(self, event_name: str, label: str) -> bool:
        rule = self._deep
        if rule is None:
            return False
        return bool(rule(event_name, label)) if callable(rule) else event_name in rule

    def _begin(self, info: DispatchInfo) -> tuple[_Dispatch, Optional[Frame]]:
        frame = self._ctx.current()
        with self._lock:
            ref = self._registry.emitter(info.emitter, info.label, info.broker)
            handler_ids = [self._registry.handler(h, ref)["id"] for h in info.handlers]
            template = self._templates.intern(
                {
                    "emitterId": ref.node["id"],
                    "eventName": info.event_name,
                    "handlerIds": handler_ids,
                    "payloadShape": payload_shape(info.payload),
                }
            )
            deep = self._deep_logged(info.event_name, ref.process["label"])
            self._seq += 1
            occurrence: dict[str, Any] = {
                "id": f"e{self._seq}",
                "templateId": template["id"],
                "parentId": frame.event_id if frame else None,
                "sourceNodeId": frame.handler_id if frame else ref.node["id"],
                "ts": self._ts(),
                "durationMs": 0,
                "handlerResults": [],
                "capture": "full" if deep else "template",
                "causality": "propagated"
                if info.remote_parent
                else "inferred"
                if frame and self._ctx.is_async()
                else "sync",
            }
            if deep:
                occurrence["payload"] = to_json_safe(info.payload)
            if info.remote_parent:
                occurrence["remoteParent"] = dict(info.remote_parent)
            if info.meta:
                occurrence["meta"] = to_json_safe(info.meta)
            for old in self._buffer.push(occurrence):
                self._templates.release(old["templateId"])
        return _Dispatch(occurrence, template, ref), frame

    def _send(self, d: _Dispatch, fresh: bool) -> None:
        nodes, processes = self._registry.drain_fresh() if fresh else ([], [])
        occ = {**d.occurrence, "handlerResults": [dict(r) for r in d.occurrence["handlerResults"]]}
        self._emit(
            {
                "type": "occurrence",
                "occurrence": occ,
                "template": dict(d.template),
                "nodes": nodes,
                "processes": processes,
            }
        )

    def _finalize(self, d: _Dispatch) -> None:
        with d.lock:
            d.finalized = True
            d.occurrence["durationMs"] = self._ts() - d.occurrence["ts"]
        self._send(d, fresh=True)

    def _settled(self, d: _Dispatch) -> None:
        with d.lock:
            d.unsettled -= 1
            if d.unsettled > 0 or not d.finalized:
                return
            d.occurrence["durationMs"] = max(d.occurrence["durationMs"], self._ts() - d.occurrence["ts"])
        self._send(d, fresh=False)

    def _invoke_for(self, d: _Dispatch) -> Invoke:
        def invoke(handler: Callable[..., Any], call: Callable[[], Any]) -> Any:
            node = self._registry.handler(handler, d.emitter)
            frame = Frame(d.occurrence["id"], node["id"])
            result: dict[str, Any] = {"handlerId": node["id"], "ts": self._ts(), "durationMs": 0}
            d.occurrence["handlerResults"].append(result)
            try:
                out = self._ctx.run(frame, call)
            except Exception as err:
                result["error"] = _error_info(err)
                result["durationMs"] = self._ts() - result["ts"]
                raise
            if not inspect.isawaitable(out):
                result["durationMs"] = self._ts() - result["ts"]
                return out
            # A coroutine: its body runs when awaited, still under this handler's frame. Timed, and its exception
            # recorded, when it finishes; the occurrence is then sent again, complete.
            with d.lock:
                d.unsettled += 1
            return self._settle(d, frame, result, out)

        return invoke

    async def _settle(self, d: _Dispatch, frame: Frame, result: dict[str, Any], awaitable: Awaitable[Any]) -> Any:
        try:
            return await self._ctx.run_async(frame, awaitable)
        except Exception as err:
            result["error"] = _error_info(err)
            raise
        finally:
            result["durationMs"] = self._ts() - result["ts"]
            self._settled(d)

    def dispatch(self, info: DispatchInfo, run: Callable[[Invoke, Optional[RemoteParent]], T]) -> T:
        """
        For adapter authors: records one event and runs it. `run` must call each handler through ``invoke`` so its
        timing, errors and events are attributed to it; its second argument is the recorded occurrence, for an
        outgoing message's ``ida-parent`` header. Returns what `run` returns.
        """
        if not self._recording:
            return run(lambda _h, call: call(), None)
        d, _ = self._begin(info)
        try:
            return run(self._invoke_for(d), {"sessionId": self.session_id, "occurrenceId": d.occurrence["id"]})
        finally:
            self._finalize(d)

    def open(self, info: DispatchInfo, handler: Callable[..., Any]) -> Scope:
        """
        For adapter authors: records an event whose handling is "whatever runs until `close()`", for APIs with no
        handler function to wrap (the code after a Kafka ``poll()``). Events emitted until then point back at it.
        """
        if not self._recording:
            return Scope(lambda _e: None, None)
        d, _ = self._begin(DispatchInfo(**{**info.__dict__, "handlers": [handler]}))
        node = self._registry.handler(handler, d.emitter)
        result: dict[str, Any] = {"handlerId": node["id"], "ts": self._ts(), "durationMs": 0}
        d.occurrence["handlerResults"].append(result)
        release = self._ctx.open(Frame(d.occurrence["id"], node["id"]))

        def close(error: Optional[BaseException]) -> None:
            release()
            result["durationMs"] = self._ts() - result["ts"]
            if error is not None:
                result["error"] = _error_info(error)
            self._finalize(d)

        return Scope(close, {"sessionId": self.session_id, "occurrenceId": d.occurrence["id"]})

    # --- reading ---

    def export(self) -> dict[str, Any]:
        """Everything in the window as a JSON-serializable recording, the format the viewer opens."""
        with self._lock:
            return {
                "version": RECORDING_VERSION,
                "startedAt": self.started_at,
                "processes": [dict(p) for p in self._registry.processes.values()],
                "nodes": [dict(n) for n in self._registry.nodes.values()],
                "templates": [dict(t) for t in self._templates.all()],
                "occurrences": [
                    {**o, "handlerResults": [dict(r) for r in o["handlerResults"]]} for o in self._buffer.to_list()
                ],
            }

    def clear(self) -> None:
        """Forget everything recorded so far."""
        with self._lock:
            self._buffer.clear()
            self._templates.clear()

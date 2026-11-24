"""Which recorders an event goes to: the ones that `track()` its emitter, else the default recorder."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Callable, Optional, TypeVar

from .identity import IdentityMap
from .propagation import RemoteParent
from .recorder import DispatchInfo, Invoke, Recorder, Scope

T = TypeVar("T")

_tracking: IdentityMap[list[Recorder]] = IdentityMap()
_default: Optional[Recorder] = None


def track(recorder: Recorder, emitter: Any) -> None:
    recorders = _tracking.get(emitter) or []
    if recorder not in recorders:
        _tracking.set(emitter, [*recorders, recorder])


def untrack(recorder: Recorder, emitter: Any) -> None:
    recorders = [r for r in (_tracking.get(emitter) or []) if r is not recorder]
    if recorders:
        _tracking.set(emitter, recorders)
    else:
        _tracking.pop(emitter)


def set_default_recorder(recorder: Optional[Recorder]) -> None:
    """The recorder for emitters no recorder has claimed with `track()`. `enable()` sets it the first time."""
    global _default
    _default = recorder


def get_default_recorder() -> Optional[Recorder]:
    return _default


def is_tracked(emitter: Any) -> bool:
    """For adapter authors: whether any recorder claimed this emitter with `track()`."""
    return bool(_tracking.get(emitter))


def recorders_for(emitter: Any) -> list[Recorder]:
    """For adapter authors: every recorder tracking `emitter`, or else the default one; only those recording."""
    tracked = _tracking.get(emitter)
    candidates = tracked if tracked else [_default] if _default else []
    return [r for r in candidates if r.recording]


def dispatch_all(
    recorders: Sequence[Recorder], info: DispatchInfo, run: Callable[[Invoke, Optional[RemoteParent]], T]
) -> T:
    """
    For adapter authors: records one event in every recorder while running its handlers once. ``recorded`` is the
    first recorder's occurrence: a message carries one ``ida-parent`` header.
    """

    def step(i: int, outer: Invoke, first: Optional[RemoteParent]) -> T:
        if i == len(recorders):
            return run(outer, first)

        def inner_run(inner: Invoke, recorded: Optional[RemoteParent]) -> T:
            def chained(h: Callable[..., Any], call: Callable[[], Any]) -> Any:
                return outer(h, lambda: inner(h, call))

            return step(i + 1, chained, first or recorded)

        return recorders[i].dispatch(info, inner_run)

    return step(0, lambda _h, call: call(), None)


class Scopes:
    """`Recorder.open` across several recorders, closed together."""

    def __init__(self, scopes: list[Scope]) -> None:
        self._scopes = scopes
        self.recorded = next((s.recorded for s in scopes if s.recorded), None)

    def close(self, error: Optional[BaseException] = None) -> None:
        for s in reversed(self._scopes):
            s.close(error)


def open_all(recorders: Sequence[Recorder], info: DispatchInfo, handler: Callable[..., Any]) -> Scopes:
    return Scopes([r.open(info, handler) for r in recorders])

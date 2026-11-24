"""Keyed recorders: `connect_recorder(key)` returns the same recorder for the same key anywhere in an app."""

from __future__ import annotations

import re
import threading
from typing import Any, Callable, Optional

from .recorder import Recorder
from .routing import get_default_recorder, set_default_recorder

#: What a recorder key may look like: it names the recorder in your project, so it must be stable and URL-safe.
RECORDER_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
DEFAULT_RECORDER_KEY = "default"

_by_key: dict[str, Recorder] = {}
_watchers: list[Callable[[Recorder], None]] = []
_lock = threading.RLock()


def connect_recorder(key: str, **options: Any) -> Recorder:
    """
    The recorder named `key`, created on first use. Call it anywhere with the same key to get the same recorder.
    `options` (see `Recorder`) only apply on the call that creates it.

    >>> payments = connect_recorder("payments", window_ms=60_000)
    >>> payments.track(payments_bus)
    """
    if not isinstance(key, str) or not RECORDER_KEY.match(key):
        raise ValueError(f"[ida] invalid recorder key {key!r}: use 1-64 letters, digits, '.', '_', ':' or '-'")
    with _lock:
        recorder = _by_key.get(key)
        if recorder:
            return recorder
        recorder = Recorder(key, **options)
        _by_key[key] = recorder
        watchers = list(_watchers)
    for w in watchers:
        w(recorder)
    return recorder


def get_recorders() -> list[Recorder]:
    """Every recorder created with `connect_recorder()`, in creation order."""
    return list(_by_key.values())


def on_recorder(listener: Callable[[Recorder], None]) -> Callable[[], None]:
    """Calls `listener` for every keyed recorder: existing ones now, new ones as they are created."""
    with _lock:
        _watchers.append(listener)
        existing = list(_by_key.values())
    for r in existing:
        listener(r)

    def stop() -> None:
        with _lock:
            if listener in _watchers:
                _watchers.remove(listener)

    return stop


def enable(**options: Any) -> Recorder:
    """
    One-line setup: the shared recorder, ``connect_recorder("default")``. The first call also makes it the default
    recorder, so adapters record everything no other recorder has claimed into it.
    """
    recorder = connect_recorder(DEFAULT_RECORDER_KEY, **options)
    if not get_default_recorder():
        set_default_recorder(recorder)
    return recorder


def get_recorder() -> Optional[Recorder]:
    """The shared recorder created by `enable()`, or None."""
    return _by_key.get(DEFAULT_RECORDER_KEY)


def _reset() -> None:
    """Forget every keyed recorder and the default one. For tests."""
    with _lock:
        _by_key.clear()
        _watchers.clear()
    set_default_recorder(None)

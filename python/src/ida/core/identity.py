from __future__ import annotations

import inspect
import threading
import weakref
from typing import Any, Generic, Optional, TypeVar

V = TypeVar("V")


class IdentityMap(Generic[V]):
    """
    A map keyed by object identity that works for any object: unhashable ones (dicts, dataclasses), ones that can't
    be weakly referenced, and bound methods (a fresh object on every attribute access, so keyed by instance and
    function). Entries go away when a weakly-referenceable key is collected; other keys are held strongly.
    """

    def __init__(self) -> None:
        self._d: dict[tuple[int, ...], tuple[Any, V]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(obj: Any) -> tuple[tuple[int, ...], Any]:
        if inspect.ismethod(obj):
            return (id(obj.__self__), id(obj.__func__)), obj.__self__
        return (id(obj),), obj

    def get(self, obj: Any) -> Optional[V]:
        entry = self._d.get(self._key(obj)[0])
        return entry[1] if entry else None

    def __contains__(self, obj: Any) -> bool:
        return self._key(obj)[0] in self._d

    def set(self, obj: Any, value: V) -> None:
        key, anchor = self._key(obj)
        with self._lock:
            known = key in self._d
            try:
                ref: Any = weakref.ref(anchor)
                if not known:
                    weakref.finalize(anchor, self._d.pop, key, None)
            except TypeError:
                ref = anchor  # can't be weakly referenced: hold it, so its id can't be reused
            self._d[key] = (ref, value)

    def pop(self, obj: Any) -> Optional[V]:
        with self._lock:
            entry = self._d.pop(self._key(obj)[0], None)
        return entry[1] if entry else None

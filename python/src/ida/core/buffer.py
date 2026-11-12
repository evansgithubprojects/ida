from __future__ import annotations

from typing import Any


class RingBuffer:
    """Append-only buffer of occurrences, evicted from the front by count and by time window."""

    def __init__(self, max_events: int, window_ms: float) -> None:
        self.max_events = max_events
        self.window_ms = window_ms
        self._items: list[dict[str, Any]] = []

    def push(self, item: dict[str, Any]) -> list[dict[str, Any]]:
        """Adds an item and returns whatever it evicted."""
        self._items.append(item)
        drop = max(0, len(self._items) - self.max_events)
        cutoff = item["ts"] - self.window_ms
        while drop < len(self._items) - 1 and self._items[drop]["ts"] < cutoff:
            drop += 1
        if not drop:
            return []
        evicted, self._items = self._items[:drop], self._items[drop:]
        return evicted

    def to_list(self) -> list[dict[str, Any]]:
        return list(self._items)

    def clear(self) -> list[dict[str, Any]]:
        old, self._items = self._items, []
        return old

    def __len__(self) -> int:
        return len(self._items)

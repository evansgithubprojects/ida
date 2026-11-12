"""Where batches wait while the server can't be reached. Only the uploader's thread touches a spool."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional, Protocol

from .fit import dumps


class SpoolStore(Protocol):
    #: Shown to the developer, e.g. a directory.
    where: str

    def list(self) -> list[tuple[int, int]]:
        """Every stored id with its size in bytes, in increasing id order."""
        ...

    def write(self, id: int, data: str) -> None: ...
    def read(self, id: int) -> Optional[str]: ...
    def remove(self, id: int) -> None: ...


class MemoryStore:
    """Keeps batches in memory: they survive an outage but not a restart."""

    where = "memory (lost if the app exits)"

    def __init__(self) -> None:
        self._data: dict[int, str] = {}

    def list(self) -> list[tuple[int, int]]:
        return sorted((i, len(s)) for i, s in self._data.items())

    def write(self, id: int, data: str) -> None:
        self._data[id] = data

    def read(self, id: int) -> Optional[str]:
        return self._data.get(id)

    def remove(self, id: int) -> None:
        self._data.pop(id, None)


_NAME = re.compile(r"^\d{12}\.json$")


class FileStore:
    """Keeps batches as files in `directory` (default ``.ida/spool``), so they survive a restart. Same layout as the
    Node SDK's, so either can deliver what the other left."""

    def __init__(self, directory: str = ".ida/spool") -> None:
        self.root = Path(directory).resolve()
        self.where = str(self.root)

    def _file(self, id: int) -> Path:
        return self.root / f"{id:012d}.json"

    def list(self) -> list[tuple[int, int]]:
        if not self.root.is_dir():
            return []
        names = sorted(n for n in os.listdir(self.root) if _NAME.match(n))
        return [(int(n[:12]), (self.root / n).stat().st_size) for n in names]

    def write(self, id: int, data: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self._file(id).with_suffix(".tmp")
        tmp.write_text(data, "utf-8")
        os.replace(tmp, self._file(id))

    def read(self, id: int) -> Optional[str]:
        try:
            return self._file(id).read_text("utf-8")
        except OSError:
            return None

    def remove(self, id: int) -> None:
        try:
            self._file(id).unlink()
        except FileNotFoundError:
            pass


class Spool:
    """
    A first-in, first-out queue of batches, bounded by bytes. When full, the oldest batch is replaced by a stub that
    carries only its envelope and a ``gap``, so the server still learns what was lost.
    """

    def __init__(self, store: SpoolStore, max_bytes: int = 50 * 1024 * 1024) -> None:
        self.store = store
        self.max_bytes = max_bytes
        self._entries: Optional[list[list[int]]] = None  # [id, bytes]
        self._next_id = 1

    @property
    def where(self) -> str:
        return self.store.where

    def _load(self) -> list[list[int]]:
        if self._entries is None:
            self._entries = [[i, b] for i, b in self.store.list()]
            self._next_id = (self._entries[-1][0] if self._entries else 0) + 1
        return self._entries

    def size(self) -> int:
        return len(self._load())

    def push(self, batch: dict[str, Any]) -> None:
        entries = self._load()
        data = dumps(batch)
        id = self._next_id
        self._next_id += 1
        self.store.write(id, data)
        entries.append([id, len(data)])
        self._trim(entries)

    def peek(self) -> Optional[dict[str, Any]]:
        entries = self._load()
        if not entries:
            return None
        data = self.store.read(entries[0][0])
        return json.loads(data) if data else None

    def shift(self) -> None:
        entries = self._load()
        if entries:
            self.store.remove(entries.pop(0)[0])

    def _trim(self, entries: list[list[int]]) -> None:
        total = sum(b for _, b in entries)
        i = 0
        while total > self.max_bytes and i < len(entries) - 1:
            entry = entries[i]
            i += 1
            data = self.store.read(entry[0])
            if not data:
                continue
            batch = json.loads(data)
            if not batch["messages"]:
                continue  # already a stub
            stub = dumps({**batch, "messages": [], "gap": _merge_gap(batch.get("gap"), _lost(batch))})
            self.store.write(entry[0], stub)
            total += len(stub) - entry[1]
            entry[1] = len(stub)


def _lost(batch: dict[str, Any]) -> dict[str, Any]:
    ts: list[float] = []
    for m in batch["messages"]:
        if m["type"] == "occurrence":
            ts.append(m["occurrence"]["ts"])
        elif m["type"] == "snapshot":
            ts.extend(o["ts"] for o in m["recording"]["occurrences"])
    return {"fromTs": min(ts) if ts else 0, "toTs": max(ts) if ts else 0, "dropped": len(ts)}


def _merge_gap(a: Optional[dict[str, Any]], b: dict[str, Any]) -> dict[str, Any]:
    if not a:
        return b
    return {
        "fromTs": min(a["fromTs"], b["fromTs"]),
        "toTs": max(a["toTs"], b["toTs"]),
        "dropped": a["dropped"] + b["dropped"],
    }

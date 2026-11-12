"""
Tracks "what is currently being handled" so emits can point at their cause.

Python's ``contextvars`` follow a handler into everything it starts (awaited coroutines, ``asyncio`` tasks, thread
pools that copy the context), so causality works across async code from the start. Emits on the handler's own thread
and task, while it runs, are ``'sync'``; emits anywhere else (a task or thread it started, a callback that runs after it
returned) are ``'inferred'``.
"""

from __future__ import annotations

import asyncio
import contextvars
import itertools
import threading
from collections.abc import Awaitable
from typing import Callable, Generic, Optional, Protocol, TypeVar

F = TypeVar("F")
R = TypeVar("R")

_names = itertools.count(1)


def _here() -> tuple[int, Optional[int]]:
    try:
        task = asyncio.current_task()
    except RuntimeError:
        task = None
    return threading.get_ident(), id(task) if task else None


class _Cell(Generic[F]):
    __slots__ = ("frame", "owner", "done")

    def __init__(self, frame: F) -> None:
        self.frame = frame
        self.owner = _here()
        self.done = False


class CausalityContext(Protocol[F]):
    def current(self) -> Optional[F]: ...
    def is_async(self) -> bool: ...
    def run(self, frame: F, fn: Callable[[], R]) -> R: ...
    async def run_async(self, frame: F, awaitable: Awaitable[R]) -> R: ...
    def open(self, frame: F) -> Callable[[], None]: ...


class ContextVarContext(Generic[F]):
    def __init__(self) -> None:
        self._var: contextvars.ContextVar[Optional[_Cell[F]]] = contextvars.ContextVar(
            f"ida_frame_{next(_names)}", default=None
        )

    def current(self) -> Optional[F]:
        cell = self._var.get()
        return cell.frame if cell else None

    def is_async(self) -> bool:
        cell = self._var.get()
        return cell is not None and (cell.done or cell.owner != _here())

    def run(self, frame: F, fn: Callable[[], R]) -> R:
        cell = _Cell(frame)
        token = self._var.set(cell)
        try:
            return fn()
        finally:
            self._var.reset(token)
            cell.done = True

    async def run_async(self, frame: F, awaitable: Awaitable[R]) -> R:
        cell = _Cell(frame)
        token = self._var.set(cell)
        try:
            return await awaitable
        finally:
            self._var.reset(token)
            cell.done = True

    def open(self, frame: F) -> Callable[[], None]:
        """Makes `frame` current until the returned function is called: for handlers with no function to wrap, such
        as the code after a Kafka ``poll()``."""
        cell = _Cell(frame)
        token = self._var.set(cell)

        def close() -> None:
            cell.done = True
            try:
                self._var.reset(token)
            except ValueError:  # closed from another context: leave that context alone, clear this one if it's ours
                if self._var.get() is cell:
                    self._var.set(None)

        return close

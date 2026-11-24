"""
Uploads every keyed recorder to your Ida project.

>>> import ida, ida.cloud
>>> ida.enable()
>>> ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="https://api.example.com")
"""

from __future__ import annotations

import atexit
from typing import Any, Optional

from .spool import FileStore, MemoryStore, SpoolStore
from .uploader import Status, Transport, Uploader, clock_sample

_current: Optional[Uploader] = None


def configure(project_key: str, endpoint: str, **options: Any) -> Uploader:
    """
    Uploads every recorder made with `ida.connect_recorder()` (or `ida.enable()`) to your project, from now on and
    including what they already hold. Call it once at startup. While the server can't be reached, batches are kept in
    ``.ida/spool`` and uploaded, in order, when it is back; the ``ida`` logger says when that happens.

    Options: ``flush_ms`` (1000), ``max_batch`` (500), ``max_batch_bytes`` (1 MiB), ``spool`` (a `SpoolStore`, or
    False to keep nothing), ``spool_max_bytes`` (50 MiB), ``on_status``, ``quiet``, ``runtime``, ``timeout`` (10 s).
    """
    global _current
    if _current is not None:
        raise RuntimeError("[ida] configure() was already called; close() the uploader it returned first")
    uploader = Uploader(project_key, endpoint, **options)
    _current = uploader
    close = uploader.close

    def close_and_forget(timeout: Optional[float] = 5.0) -> None:
        global _current
        atexit.unregister(_at_exit)
        close(timeout)
        _current = None

    uploader.close = close_and_forget  # type: ignore[method-assign]
    atexit.register(_at_exit)
    return uploader


def get_uploader() -> Optional[Uploader]:
    """The uploader `configure()` started, or None."""
    return _current


def _at_exit() -> None:
    # Last batches before the interpreter exits; best effort, and never for long.
    if _current is not None:
        _current.flush(timeout=3.0)


__all__ = [
    "FileStore",
    "MemoryStore",
    "SpoolStore",
    "Status",
    "Transport",
    "Uploader",
    "clock_sample",
    "configure",
    "get_uploader",
]

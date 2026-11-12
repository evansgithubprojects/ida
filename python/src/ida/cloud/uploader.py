"""Uploads keyed recorders to an Ida project from a background thread, spooling to disk while offline."""

from __future__ import annotations

import json
import logging
import platform
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Union

from .. import __version__
from ..core.keyed import on_recorder
from ..core.recorder import Recorder
from .fit import dumps, fit_message, json_bytes
from .spool import FileStore, MemoryStore, Spool, SpoolStore

log = logging.getLogger("ida")

#: ``(url, headers, body, timeout) -> (status, response body)``. Raise on network errors.
Transport = Callable[[str, dict[str, str], bytes, float], "tuple[int, bytes]"]

#: What `on_status` receives: ``{"state": "online" | "offline" | "recovered" | "rejected", ...}``.
Status = dict[str, Any]

BACKOFF_S = [1, 2, 5, 10, 30, 60]
CLOCK_SAMPLES = 8
_KEY_PREFIXES = ("ida_", "eda_")


def urllib_transport(url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def clock_sample(t0: float, t1: float, t2: float, t3: float) -> Optional[tuple[float, float]]:
    """NTP-style (offset, error) from sent (t0), received by the server (t1), answered (t2), response read (t3)."""
    delay = (t3 - t0) - (t2 - t1)
    if not delay >= 0:
        return None
    return ((t1 - t0) + (t2 - t3)) / 2, delay / 2


def check_options(project_key: Any, endpoint: Any) -> None:
    """Fails at startup, with what to do, when the project key or endpoint is missing or can't be right."""
    key = project_key.strip() if isinstance(project_key, str) else ""
    if not key:
        raise ValueError(
            "[ida] configure() is missing a project_key.\n  Create a project in the web app, make an ingest key and "
            'pass it: configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint=...).'
        )
    if not key.startswith(_KEY_PREFIXES):
        raise ValueError(
            "[ida] configure() was given a project_key that isn't an ingest key.\n  Ingest keys start with 'ida_'. Use "
            "one made under the project's ingest keys in the web app, not an account, API or Supabase key."
        )
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError(
            "[ida] configure() is missing an endpoint.\n  Pass the URL of your Ida server: "
            "configure(project_key=..., endpoint='https://api.example.com')."
        )


@dataclass
class _Stream:
    recorder: Recorder
    seq: int = 0
    pending: list[dict[str, Any]] = field(default_factory=list)
    clock: list[tuple[float, float]] = field(default_factory=list)
    unsubscribe: Callable[[], None] = lambda: None

    def best_clock(self) -> Optional[tuple[float, float]]:
        return min(self.clock, key=lambda c: c[1]) if self.clock else None


class Uploader:
    def __init__(
        self,
        project_key: str,
        endpoint: str,
        *,
        flush_ms: float = 1000,
        max_batch: int = 500,
        max_batch_bytes: int = 1024 * 1024,
        spool: Union[SpoolStore, bool, None] = None,
        spool_max_bytes: int = 50 * 1024 * 1024,
        on_status: Optional[Callable[[Status], None]] = None,
        quiet: bool = False,
        runtime: Optional[str] = None,
        transport: Optional[Transport] = None,
        timeout: float = 10.0,
    ) -> None:
        check_options(project_key, endpoint)
        self._key = project_key.strip()
        self._endpoint = endpoint
        self._url = endpoint.rstrip("/") + "/v1/ingest"
        self._flush_s = flush_ms / 1000
        self._max_batch = max_batch
        self._budget = max_batch_bytes - 1024  # room for the envelope
        store: Optional[SpoolStore]
        if spool is False:
            store = None
        elif spool is None or spool is True:
            store = FileStore()
        else:
            store = spool
        self._spool = Spool(store, spool_max_bytes) if store else None
        self._on_status = on_status
        self._quiet = quiet
        self._runtime = runtime or f"python {platform.python_version()}"
        self._transport = transport or urllib_transport
        self._timeout = timeout

        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._streams: list[_Stream] = []
        self._ready: list[dict[str, Any]] = []
        self._status: Status = {"state": "online"}
        self._retry_at = 0.0
        self._attempt = 0
        self._rejected_once = False
        self._closed = False
        self._requested = 0  # flush requests
        self._done = 0  # flush requests served

        self._stop_watching = on_recorder(self._attach)
        self._thread = threading.Thread(target=self._loop, name="ida-uploader", daemon=True)
        self._thread.start()
        if self._spool and self._spool.size():
            self._request()  # batches an earlier run left behind go up as soon as possible

    # --- public ---

    @property
    def status(self) -> Status:
        return self._status

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Sends everything recorded so far and waits for the attempt to finish. False if `timeout` ran out."""
        if threading.current_thread() is self._thread:
            self._cycle()
            return True
        with self._lock:
            ticket = self._request_locked()
            return self._wake.wait_for(lambda: self._done >= ticket or not self._thread.is_alive(), timeout)

    def close(self, timeout: Optional[float] = 5.0) -> None:
        """Flushes, then stops uploading."""
        if self._closed:
            return
        self.flush(timeout)
        self._stop_watching()
        with self._lock:
            self._closed = True
            for s in self._streams:
                s.unsubscribe()
            self._wake.notify_all()
        self._thread.join(timeout)

    # --- recorders ---

    def _attach(self, recorder: Recorder) -> None:
        # What the recorder already holds goes first, as one snapshot, so events from before configure() aren't lost.
        recording = recorder.export()
        stream = _Stream(recorder)
        if recording["occurrences"]:
            stream.pending.append({"type": "snapshot", "recording": recording})

        def on_message(message: dict[str, Any]) -> None:
            with self._lock:
                stream.pending.append(message)
                if len(stream.pending) >= self._max_batch:
                    self._request_locked()

        stream.unsubscribe = recorder.subscribe(on_message)
        with self._lock:
            self._streams.append(stream)

    # --- the upload thread ---

    def _request(self) -> None:
        with self._lock:
            self._request_locked()

    def _request_locked(self) -> int:
        self._requested += 1
        self._wake.notify_all()
        return self._requested

    def _loop(self) -> None:
        while True:
            with self._lock:
                if self._closed:
                    return
                self._wake.wait_for(lambda: self._requested > self._done or self._closed, self._flush_s)
                if self._closed:
                    return
                ticket = self._requested
            try:
                self._cycle()
            except Exception:  # never let the uploader thread die
                log.exception("[ida] upload failed unexpectedly")
            with self._lock:
                self._done = max(self._done, ticket)
                self._wake.notify_all()

    def _cut(self) -> None:
        """Turns each stream's pending messages into batches that fit."""
        with self._lock:
            work = [(s, s.pending) for s in self._streams if s.pending]
            for s in self._streams:
                s.pending = []
        dropped = 0
        for stream, pending in work:
            messages: list[dict[str, Any]] = []
            size = 0

            def emit(stream: _Stream = stream) -> None:  # called within this iteration only
                nonlocal messages, size
                if messages:
                    rec = stream.recorder
                    self._ready.append(
                        {
                            "recorderKey": rec.key,
                            "sessionId": rec.session_id,
                            "startedAt": rec.started_at,
                            "seq": stream.seq,
                            "runtime": self._runtime,
                            "sdk": {"language": "python", "version": __version__},
                            "messages": messages,
                        }
                    )
                    stream.seq += 1
                messages, size = [], 0

            for message in pending:
                fits, lost = fit_message(message, self._budget)
                dropped += lost
                for m in fits:
                    n = json_bytes(m)
                    if messages and (len(messages) >= self._max_batch or size + n > self._budget):
                        emit()
                    messages.append(m)
                    size += n
            emit()
        if dropped:
            noun = "message was" if dropped == 1 else "messages were"
            self._set_status(
                {
                    "state": "rejected",
                    "status": 413,
                    "error": f"{dropped} {noun} too large to upload even without payloads, and dropped",
                }
            )

    def _cycle(self) -> None:
        self._cut()
        if self._status["state"] == "offline" and time.monotonic() < self._retry_at:
            # Waiting out a backoff: queue behind the spool rather than jump ahead of it.
            self._spool_ready()
            return
        self._drain()

    def _spool_ready(self) -> None:
        while self._ready:
            batch = self._ready.pop(0)
            if self._spool:
                self._spool.push(batch)

    def _drain(self) -> None:
        """Spooled batches first, oldest first; then the ones just cut. Stops at the first failure."""
        uploaded = 0
        while self._spool and (b := self._spool.peek()):
            result, error, status = self._post({**b, "spooled": True})
            if result == "retry":
                self._go_offline(error)
                return
            if result == "refused":
                self._set_status({"state": "rejected", "status": status, "error": error})
            self._spool.shift()
            uploaded += 1
        if self._status["state"] == "offline" or uploaded:
            self._attempt = 0
            self._set_status({"state": "recovered", "uploaded": uploaded})
        while self._ready:
            batch = self._ready.pop(0)
            result, error, status = self._post(batch)
            if result == "retry":
                # Keep the order: this batch and every one after it waits in the spool.
                if self._spool:
                    self._spool.push(batch)
                self._go_offline(error)
                self._spool_ready()
                return
            if result == "refused":
                self._set_status({"state": "rejected", "status": status, "error": error})

    def _post(self, batch: dict[str, Any]) -> tuple[str, str, Optional[int]]:
        # Only a live recorder can time the request; a batch an earlier run left in the spool goes without.
        stream = next((s for s in self._streams if s.recorder.session_id == batch["sessionId"]), None)
        body = batch
        t0 = 0.0
        if stream:
            t0 = stream.recorder.wall_time()
            body = {**batch, "sentAt": t0}
            best = stream.best_clock()
            if best:
                body["clock"] = {"offsetMs": best[0], "errorMs": best[1]}
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        try:
            status, raw = self._transport(self._url, headers, dumps(body).encode("utf-8"), self._timeout)
        except Exception as err:
            return "retry", str(err) or type(err).__name__, None
        if 200 <= status < 300:
            if stream:
                t3 = stream.recorder.wall_time()
                try:
                    data = json.loads(raw or b"null")
                    sample = clock_sample(t0, float(data["receivedAt"]), float(data["repliedAt"]), t3)
                except (ValueError, TypeError, KeyError):
                    sample = None
                if sample:
                    stream.clock = [*stream.clock, sample][-CLOCK_SAMPLES:]
            return "ok", "", status
        try:
            error = str(json.loads(raw).get("error") or raw.decode("utf-8", "replace"))
        except (ValueError, AttributeError):
            error = raw.decode("utf-8", "replace")
        # Retry what may succeed later; anything else would fail the same way forever.
        transient = status >= 500 or status in (408, 429)
        return ("retry" if transient else "refused"), error or f"HTTP {status}", status

    def _go_offline(self, error: str) -> None:
        if self._status["state"] != "offline":
            self._set_status(
                {
                    "state": "offline",
                    "error": error,
                    "where": self._spool.where if self._spool else "nowhere (spool disabled)",
                    "spooled": self._spool.size() if self._spool else 0,
                }
            )
        self._retry_at = time.monotonic() + BACKOFF_S[min(self._attempt, len(BACKOFF_S) - 1)]
        self._attempt += 1
        # Wake up for the retry even if nothing new is recorded.
        timer = threading.Timer(self._retry_at - time.monotonic() + 0.01, self._request)
        timer.daemon = True  # never keeps the app from exiting
        timer.start()

    def _set_status(self, status: Status) -> None:
        self._status = status
        if self._on_status:
            try:
                self._on_status(status)
            except Exception:
                log.exception("[ida] on_status raised")
        if self._quiet:
            return
        state = status["state"]
        if state == "offline":
            log.warning(
                "[ida] can't reach %s (%s). Recording continues: batches are kept in %s and will be uploaded when the "
                "connection is back.",
                self._endpoint,
                status["error"],
                status["where"],
            )
        elif state == "recovered":
            n = status["uploaded"]
            log.warning(
                "[ida] reconnected to %s; uploaded %d batch%s recorded while offline.",
                self._endpoint,
                n,
                "" if n == 1 else "es",
            )
        elif state == "rejected" and not self._rejected_once:
            self._rejected_once = True
            hint = " Check the project key." if status.get("status") in (401, 403) else ""
            log.error(
                "[ida] %s refused an upload (%s: %s).%s Refused data is dropped.",
                self._endpoint,
                status.get("status"),
                status["error"],
                hint,
            )


__all__ = [
    "FileStore",
    "MemoryStore",
    "Spool",
    "SpoolStore",
    "Transport",
    "Uploader",
    "clock_sample",
    "urllib_transport",
]

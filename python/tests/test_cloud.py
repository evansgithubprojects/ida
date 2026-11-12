from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Optional

import pytest

import ida
from ida import Emitter
from ida.cloud import FileStore, MemoryStore, Uploader, clock_sample, configure, get_uploader
from ida.cloud.fit import fit_message
from ida.cloud.spool import Spool
from ida.core.keyed import _reset


@pytest.fixture(autouse=True)
def fresh() -> Iterator[None]:
    _reset()
    yield
    up = get_uploader()
    if up:
        up.close(1)
    _reset()


class FakeServer:
    """Records what it receives; can be switched off or made to refuse."""

    def __init__(self, ahead_ms: float = 0) -> None:
        self.received: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.mode = "up"
        self.ahead_ms = ahead_ms
        self.clock: Optional[ida.Recorder] = None  # stands in for the server's clock

    def __call__(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> tuple[int, bytes]:
        assert url == "https://api.test/v1/ingest"
        if self.mode == "down":
            raise ConnectionRefusedError("connection refused")
        if self.mode == "refuse":
            return 401, b'{"error":"unknown or revoked project key"}'
        if self.mode == "busy":
            return 503, b""
        self.received.append(json.loads(body))
        self.headers.append(headers)
        now = (self.clock.wall_time() if self.clock else 0) + self.ahead_ms
        return 200, json.dumps({"ok": True, "receivedAt": now, "repliedAt": now}).encode()


def start(server: FakeServer, **options: Any) -> Uploader:
    return configure(
        "ida_test",
        "https://api.test/",
        transport=server,
        spool=options.pop("spool", MemoryStore()),
        flush_ms=options.pop("flush_ms", 10_000),
        quiet=True,
        **options,
    )


def occurrences(batches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [m for b in batches for m in b["messages"] if m["type"] == "occurrence"]


def test_uploads_each_recorder_with_the_project_key() -> None:
    rec = ida.connect_recorder("payments")
    bus = Emitter("Bus")
    rec.track(bus)
    bus.emit("before-configure")
    server = FakeServer()
    up = start(server)
    bus.emit("after")
    assert up.flush(5)
    [batch] = server.received
    assert server.headers[0]["Authorization"] == "Bearer ida_test"
    assert batch["recorderKey"] == "payments" and batch["sessionId"] == rec.session_id and batch["seq"] == 0
    assert batch["sdk"]["language"] == "python" and batch["runtime"].startswith("python ")
    assert [m["type"] for m in batch["messages"]] == ["snapshot", "occurrence"]
    assert batch["sentAt"] > batch["startedAt"] and isinstance(batch["startedAt"], int)


def test_flushes_on_its_own_timer() -> None:
    server = FakeServer()
    start(server, flush_ms=20)
    rec = ida.enable()
    Emitter().emit("x")
    for _ in range(100):
        if server.received:
            break
        threading.Event().wait(0.02)
    assert len(occurrences(server.received)) == 1
    assert rec.export()["occurrences"]


def test_measures_the_clock_and_sends_the_best_estimate() -> None:
    rec = ida.enable()
    server = FakeServer(ahead_ms=5_000)
    server.clock = rec
    up = start(server)
    bus = Emitter()
    for _ in range(3):
        bus.emit("tick")
        up.flush(5)
    assert "clock" not in server.received[0]
    for b in server.received[1:]:
        assert abs(b["clock"]["offsetMs"] - 5_000) <= b["clock"]["errorMs"] + 1


def test_spools_while_offline_and_delivers_in_order() -> None:
    statuses: list[dict[str, Any]] = []
    server = FakeServer()
    up = start(server, on_status=statuses.append)
    rec = ida.enable()
    bus = Emitter()
    server.mode = "down"
    bus.emit("one")
    up.flush(5)
    assert statuses[-1]["state"] == "offline" and statuses[-1]["spooled"] == 1
    bus.emit("two")
    up.flush(5)  # still backing off: goes behind the spool
    server.mode = "up"
    up._retry_at = 0  # skip the backoff
    bus.emit("three")
    up.flush(5)
    assert statuses[-1] == {"state": "recovered", "uploaded": 2}
    assert [b.get("spooled", False) for b in server.received] == [True, True, False]
    assert [b["seq"] for b in server.received] == [0, 1, 2]
    assert len(occurrences(server.received)) == 3
    assert rec.session_id == server.received[0]["sessionId"]


def test_drops_refused_batches_and_says_why() -> None:
    statuses: list[dict[str, Any]] = []
    server = FakeServer()
    server.mode = "refuse"
    up = start(server, on_status=statuses.append)
    ida.enable()
    Emitter().emit("x")
    up.flush(5)
    assert statuses[-1] == {"state": "rejected", "status": 401, "error": "unknown or revoked project key"}
    server.mode = "up"
    up.flush(5)
    assert server.received == []


def test_retries_a_busy_server() -> None:
    server = FakeServer()
    server.mode = "busy"
    up = start(server)
    ida.enable()
    Emitter().emit("x")
    up.flush(5)
    assert up.status["state"] == "offline"


def test_rejects_bad_configuration() -> None:
    with pytest.raises(ValueError, match="missing a project_key"):
        configure("", "https://api.test")
    with pytest.raises(ValueError, match="start with 'ida_'"):
        configure("sb_secret_123", "https://api.test")
    with pytest.raises(ValueError, match="missing an endpoint"):
        configure("ida_x", "")
    start(FakeServer())
    with pytest.raises(RuntimeError, match="already called"):
        start(FakeServer())


def test_delivers_what_an_earlier_run_left_in_the_spool(tmp_path: Path) -> None:
    store = FileStore(str(tmp_path / "spool"))
    Spool(store).push({"recorderKey": "old", "sessionId": "x", "startedAt": 0, "seq": 0, "messages": []})
    server = FakeServer()
    up = start(server, spool=store)
    up.flush(5)
    assert [b["recorderKey"] for b in server.received] == ["old"]
    assert server.received[0]["spooled"] is True and "sentAt" not in server.received[0]
    assert store.list() == []


def test_spool_overflow_keeps_a_gap(tmp_path: Path) -> None:
    spool = Spool(FileStore(str(tmp_path)), max_bytes=400)
    for i in range(4):
        occ = {"type": "occurrence", "occurrence": {"id": f"e{i}", "ts": i * 10, "x": "y" * 60}}
        spool.push({"recorderKey": "r", "sessionId": "s", "startedAt": 0, "seq": i, "messages": [occ]})
    first = spool.peek()
    assert first is not None and first["messages"] == [] and first["gap"]["dropped"] >= 1
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"{i:012d}.json" for i in range(1, 5)]


def test_fit_strips_payloads_then_splits_snapshots() -> None:
    big = {
        "type": "occurrence",
        "occurrence": {"id": "e1", "ts": 0, "capture": "full", "payload": "x" * 5000},
        "template": {},
        "nodes": [],
        "processes": [],
    }
    [fitted], dropped = fit_message(big, 1000)
    assert dropped == 0 and "payload" not in fitted["occurrence"] and fitted["occurrence"]["capture"] == "template"
    snapshot = {
        "type": "snapshot",
        "recording": {
            "processes": [],
            "nodes": [],
            "templates": [],
            "occurrences": [{"id": f"e{i}", "ts": i, "pad": "p" * 200} for i in range(10)],
        },
    }
    parts, dropped = fit_message(snapshot, 1000)
    assert dropped == 0 and len(parts) > 1
    assert sum(len(p["recording"]["occurrences"]) for p in parts) == 10


def test_clock_sample() -> None:
    assert clock_sample(0, 1040, 1045, 85) == (1000, 40)
    assert clock_sample(0, 10, 20, 5) is None


def test_real_http_round_trip() -> None:
    """The default transport (urllib) against a real HTTP server."""
    got: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            body = json.dumps({"ok": True, "duplicate": False, "receivedAt": 1, "repliedAt": 1}).encode()
            self.send_response(200 if self.headers["Authorization"] == "Bearer ida_real" else 401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        up = configure("ida_real", f"http://127.0.0.1:{server.server_port}", spool=MemoryStore(), quiet=True)
        ida.enable()
        Emitter().emit("x")
        up.flush(5)
        assert len(got) == 1 and up.status["state"] == "online"
    finally:
        server.shutdown()

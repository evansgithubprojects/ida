from __future__ import annotations

import json
from typing import Any


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def json_bytes(value: Any) -> int:
    """UTF-8 size of `value` as JSON: what it costs in a request body."""
    return len(dumps(value).encode("utf-8"))


def fit_message(message: dict[str, Any], max_bytes: int) -> tuple[list[dict[str, Any]], int]:
    """
    `message` as one or more messages that each fit in `max_bytes`, losing as little as possible: a snapshot is split,
    an occurrence too big because of its captured payload goes without it (template-only), and anything still too
    big is dropped. Returns the messages and how many were dropped.
    """
    if json_bytes(message) <= max_bytes:
        return [message], 0

    kind = message["type"]
    if kind == "occurrence" and "payload" in message["occurrence"]:
        occ = {k: v for k, v in message["occurrence"].items() if k != "payload"}
        return fit_message({**message, "occurrence": {**occ, "capture": "template"}}, max_bytes)

    if kind == "snapshot":
        rec = message["recording"]
        occurrences = rec["occurrences"]
        if len(occurrences) > 1:
            half = (len(occurrences) + 1) // 2
            # The graph and findings go with the first half; the server merges snapshots.
            first = {"type": "snapshot", "recording": {**rec, "occurrences": occurrences[:half]}}
            rest = {
                "type": "snapshot",
                "recording": {
                    **rec,
                    "processes": [],
                    "nodes": [],
                    "templates": [],
                    "findings": [],
                    "occurrences": occurrences[half:],
                },
            }
            a, da = fit_message(first, max_bytes)
            b, db = fit_message(rest, max_bytes)
            return a + b, da + db
        if len(occurrences) == 1 and "payload" in occurrences[0]:
            graph = {"type": "snapshot", "recording": {**rec, "occurrences": []}}
            if json_bytes(graph) <= max_bytes:
                bare = {k: v for k, v in occurrences[0].items() if k != "payload"}
                return fit_message(
                    {"type": "snapshot", "recording": {**rec, "occurrences": [{**bare, "capture": "template"}]}},
                    max_bytes,
                )

    return [], 1

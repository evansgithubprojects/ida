"""Turns any value into JSON-safe data for deep-logged payloads and metadata."""

from __future__ import annotations

import base64
import datetime
import math
from collections.abc import Mapping
from typing import Any

#: Values JSON can't carry are encoded as ``{"$eda": <kind>}``, as in the JS SDK.
TAG = "$eda"


def to_json_safe(
    value: Any, *, max_depth: int = 6, max_keys: int = 100, max_items: int = 100, max_string: int = 2000
) -> Any:
    ancestors: set[int] = set()

    def walk(v: Any, depth: int) -> Any:
        if v is None or isinstance(v, bool):
            return v
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            if math.isnan(v):
                return {TAG: "NaN"}
            if math.isinf(v):
                return {TAG: "Infinity" if v > 0 else "-Infinity"}
            return v
        if isinstance(v, str):
            return v[:max_string] + "…" if len(v) > max_string else v
        if isinstance(v, (bytes, bytearray, memoryview)):
            raw = bytes(v)
            return {TAG: "Bytes", "v": base64.b64encode(raw[:max_string]).decode("ascii"), "length": len(raw)}
        if isinstance(v, (datetime.date, datetime.time)):
            return {TAG: "Date", "v": v.isoformat()}
        if isinstance(v, BaseException):
            return {TAG: "Error", "name": type(v).__name__, "message": str(v)}
        if callable(v):
            return {TAG: "Function", "v": getattr(v, "__qualname__", None) or "anonymous"}
        if id(v) in ancestors:
            return {TAG: "Circular"}
        if depth >= max_depth:
            return {TAG: "Truncated"}
        ancestors.add(id(v))
        try:
            if isinstance(v, (list, tuple)):
                return [walk(x, depth + 1) for x in v[:max_items]]
            if isinstance(v, (set, frozenset)):
                return {TAG: "Set", "v": [walk(x, depth + 1) for x in list(v)[:max_items]]}
            if isinstance(v, Mapping):
                items = list(v.items())[:max_keys]
            elif hasattr(v, "__dict__"):
                items = [(k, x) for k, x in vars(v).items() if not k.startswith("_")][:max_keys]
            else:
                text = repr(v)
                return {TAG: type(v).__name__, "v": text[:max_string]}
            return {str(k): walk(x, depth + 1) for k, x in items}
        finally:
            ancestors.discard(id(v))

    return walk(value, 0)

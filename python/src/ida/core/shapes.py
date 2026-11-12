"""Payload shapes and template keys. Must match the JS SDK byte for byte: see spec/README.md."""

from __future__ import annotations

import datetime
import inspect
import math
from collections.abc import Mapping
from typing import Any, Callable, Optional, TypedDict

MAX_DEPTH = 4
MAX_KEYS = 40
MAX_ITEMS = 20


def payload_shape(value: Any, depth: int = 0, seen: Optional[set[int]] = None) -> str:
    """Stable, value-free signature of a payload: keys (sorted) and types only, e.g. ``{id:string,total:number}``."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, float):
        return "NaN" if math.isnan(value) else "number"
    if isinstance(value, int):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "bytes"
    if inspect.isroutine(value) or inspect.isclass(value):
        return "function"
    if isinstance(value, (datetime.date, datetime.time)):
        return "Date"
    if isinstance(value, BaseException):
        return "Error"

    if seen is None:
        seen = set()
    if id(value) in seen:
        return "[Circular]"
    if depth >= MAX_DEPTH:
        return "…"
    seen.add(id(value))
    try:
        if isinstance(value, (list, tuple)):
            kinds = sorted({payload_shape(item, depth + 1, seen) for item in value[:MAX_ITEMS]})
            if not kinds:
                return "[]"
            inner = "|".join(kinds)
            return (f"({inner})" if len(kinds) > 1 else inner) + "[]"
        if isinstance(value, (set, frozenset)):
            return "Set"
        if isinstance(value, Mapping):
            fields: Mapping[Any, Any] = value
            prefix = "" if type(value) is dict else type(value).__name__
        elif hasattr(value, "__dict__"):
            fields = {k: v for k, v in vars(value).items() if not k.startswith("_")}
            prefix = type(value).__name__
        else:
            return f"{type(value).__name__}{{}}"
        keys = sorted(str(k) for k in fields)
        by_name = {str(k): v for k, v in fields.items()}
        body = [f"{k}:{payload_shape(by_name[k], depth + 1, seen)}" for k in keys[:MAX_KEYS]]
        if len(keys) > MAX_KEYS:
            body.append("…")
        return prefix + "{" + ",".join(body) + "}"
    finally:
        seen.discard(id(value))


class TemplateParts(TypedDict):
    emitterId: str
    eventName: str
    handlerIds: list[str]
    payloadShape: str


TemplateKeyFn = Callable[[TemplateParts], str]


def default_template_key(parts: TemplateParts) -> str:
    """emitter + event name + handler set + payload shape."""
    return "|".join(
        [parts["emitterId"], parts["eventName"], ",".join(sorted(parts["handlerIds"])), parts["payloadShape"]]
    )

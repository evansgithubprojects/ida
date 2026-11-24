from __future__ import annotations

import json
from typing import Any

#: Bodies larger than this are recorded as bytes rather than parsed for their shape.
MAX_PARSE_BYTES = 64 * 1024


def decode(value: Any) -> Any:
    """A message body as data: parsed JSON when it is JSON, else the raw bytes (shape ``bytes``). Values that are
    already objects (from a deserializing consumer) are kept as they are."""
    if value is None or not isinstance(value, (bytes, bytearray, str)):
        return value
    if len(value) > MAX_PARSE_BYTES:
        return value
    text = value if isinstance(value, str) else bytes(value).decode("utf-8", "replace")
    if text.lstrip()[:1] not in ("{", "[", '"'):
        return value
    try:
        return json.loads(text)
    except ValueError:
        return value

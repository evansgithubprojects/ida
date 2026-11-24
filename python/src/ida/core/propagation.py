"""Cross-service links: the ``ida-parent`` header and broker process ids (spec/README.md)."""

from __future__ import annotations

import re
from typing import Literal, Optional, TypedDict, Union

PARENT_HEADER = "ida-parent"

_VERSION = "1"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_OCC_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

BrokerType = Literal["kafka", "rabbitmq"]
BrokerKind = Literal["topic", "exchange", "queue"]


class RemoteParent(TypedDict):
    sessionId: str
    occurrenceId: str


def format_parent_header(parent: RemoteParent) -> str:
    """``1:<sessionId>:<occurrenceId>``"""
    return f"{_VERSION}:{parent['sessionId']}:{parent['occurrenceId']}"


def parse_parent_header(value: Union[str, bytes, bytearray, None, object]) -> Optional[RemoteParent]:
    """Reads an ``ida-parent`` header (text or bytes). Anything malformed gives None, so it just starts a new chain."""
    if isinstance(value, (bytes, bytearray)):
        try:
            text = bytes(value).decode("utf-8")
        except UnicodeDecodeError:
            return None
    elif isinstance(value, str):
        text = value
    else:
        return None
    parts = text.split(":")
    if len(parts) != 3:
        return None
    version, session_id, occurrence_id = parts
    if version != _VERSION or not _UUID.match(session_id) or not _OCC_ID.match(occurrence_id):
        return None
    return {"sessionId": session_id.lower(), "occurrenceId": occurrence_id}


def broker_process_id(broker: BrokerType, kind: BrokerKind, name: str, cluster: str = "") -> str:
    """``<broker>:<cluster>:<kind>:<name>``. The RabbitMQ default exchange is ``(default)``."""
    return ":".join([broker, cluster, kind, "(default)" if name == "" and kind == "exchange" else name])

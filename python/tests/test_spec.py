"""The cross-SDK conformance suite in spec/fixtures. The JS SDK's tests load the same files."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from ida import broker_process_id, default_template_key, format_parent_header, parse_parent_header, payload_shape

FIXTURES = Path(__file__).resolve().parents[2] / "spec" / "fixtures"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text("utf-8"))


def revive(v: Any) -> Any:
    """Turns the fixture tags back into the values JSON can't hold."""
    if isinstance(v, list):
        return [revive(x) for x in v]
    if isinstance(v, dict):
        if v.get("$nan") is True:
            return float("nan")
        if isinstance(v.get("$bytes"), str):
            return base64.b64decode(v["$bytes"])
        return {k: revive(x) for k, x in v.items()}
    return v


@pytest.mark.parametrize("case", fixture("payload-shapes.json")["cases"], ids=lambda c: c["name"])
def test_payload_shape(case: dict[str, Any]) -> None:
    assert payload_shape(revive(case["input"])) == case["shape"]


def test_tuples_and_bytearrays_match_their_js_counterparts() -> None:
    assert payload_shape((1, 2)) == "number[]"
    assert payload_shape(bytearray(b"x")) == "bytes"


@pytest.mark.parametrize("case", fixture("template-keys.json")["cases"], ids=lambda c: c["key"])
def test_template_key(case: dict[str, Any]) -> None:
    assert default_template_key(case["parts"]) == case["key"]


PROPAGATION = fixture("propagation.json")


@pytest.mark.parametrize("case", PROPAGATION["format"], ids=lambda c: c["header"])
def test_format_header(case: dict[str, Any]) -> None:
    assert format_parent_header(case["parent"]) == case["header"]


@pytest.mark.parametrize("case", PROPAGATION["parse"], ids=lambda c: repr(c["header"]))
def test_parse_header(case: dict[str, Any]) -> None:
    assert parse_parent_header(case["header"]) == case["parent"]


def test_parse_header_from_bytes() -> None:
    case = PROPAGATION["format"][0]
    assert parse_parent_header(case["header"].encode()) == case["parent"]
    assert parse_parent_header(b"\xff\xfe") is None


@pytest.mark.parametrize("case", PROPAGATION["brokerProcessIds"], ids=lambda c: c["id"])
def test_broker_process_id(case: dict[str, Any]) -> None:
    broker, kind, name, cluster = case["args"]
    assert broker_process_id(broker, kind, name, cluster) == case["id"]

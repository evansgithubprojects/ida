"""Stable ids and labels for emitters (processes) and handlers (nodes)."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .identity import IdentityMap
from .propagation import BrokerKind, BrokerType, broker_process_id

_GENERIC = {"object", "dict", "SimpleNamespace", "Emitter", ""}


@dataclass(frozen=True)
class BrokerRef:
    """Identifies a topic, exchange or queue. Its process gets a deterministic id shared by every service."""

    type: BrokerType
    kind: BrokerKind
    name: str
    #: Kafka: a cluster name of your choosing; RabbitMQ: the vhost.
    cluster: str = ""


@dataclass
class EmitterRef:
    node: dict[str, Any]
    process: dict[str, Any]


class Registry:
    def __init__(self) -> None:
        self.processes: dict[str, dict[str, Any]] = {}
        self.nodes: dict[str, dict[str, Any]] = {}
        self._emitters: IdentityMap[EmitterRef] = IdentityMap()
        self._handlers: IdentityMap[dict[str, Any]] = IdentityMap()
        self._emitter_labels: IdentityMap[str] = IdentityMap()
        self._handler_labels: IdentityMap[str] = IdentityMap()
        self._process_by_label: dict[str, dict[str, Any]] = {}
        self._label_counts: dict[str, int] = {}
        self._seq = {"em": 0, "h": 0, "p": 0}
        self._fresh_nodes: list[dict[str, Any]] = []
        self._fresh_processes: list[dict[str, Any]] = []
        self._lock = threading.RLock()

    def label_emitter(self, emitter: Any, label: str) -> None:
        self._emitter_labels.set(emitter, label)

    def label_handler(self, fn: Callable[..., Any], label: str) -> None:
        self._handler_labels.set(fn, label)

    def emitter(self, obj: Any, hint: Optional[str] = None, broker: Optional[BrokerRef] = None) -> EmitterRef:
        with self._lock:
            known = self._emitters.get(obj)
            if known:
                return known
            if broker:
                process = self._broker_process(obj, broker)
            else:
                own = self._emitter_labels.get(obj)
                base = own or hint or type(obj).__name__
                label = base
                if own is None and (not hint or base in _GENERIC):
                    name = base or "Emitter"
                    n = self._label_counts.get(name, 0) + 1
                    self._label_counts[name] = n
                    label = f"{name}#{n}"
                found = self._process_by_label.get(label)
                if not found:
                    self._seq["p"] += 1
                    found = {"id": f"p{self._seq['p']}", "label": label}
                    self._process_by_label[label] = found
                    self._add_process(found)
                process = found
            self._seq["em"] += 1
            node = {
                "id": f"em{self._seq['em']}",
                "processId": process["id"],
                "label": process["label"],
                "kind": "emitter",
            }
            self.nodes[node["id"]] = node
            self._fresh_nodes.append(node)
            ref = EmitterRef(node, process)
            self._emitters.set(obj, ref)
            return ref

    def _broker_process(self, obj: Any, b: BrokerRef) -> dict[str, Any]:
        pid = broker_process_id(b.type, b.kind, b.name, b.cluster)
        process = self.processes.get(pid)
        if not process:
            label = (
                self._emitter_labels.get(obj) or b.name or ("(default exchange)" if b.kind == "exchange" else b.name)
            )
            broker: dict[str, Any] = {"type": b.type}
            if b.cluster:
                broker["cluster"] = b.cluster
            process = {"id": pid, "label": label, "kind": b.kind, "broker": broker}
            self._add_process(process)
        return process

    def _add_process(self, process: dict[str, Any]) -> None:
        self.processes[process["id"]] = process
        self._fresh_processes.append(process)

    def handler(self, fn: Callable[..., Any], owner: EmitterRef) -> dict[str, Any]:
        """A handler belongs to the process of the first emitter it was seen on."""
        with self._lock:
            known = self._handlers.get(fn)
            if known:
                return known
            self._seq["h"] += 1
            n = self._seq["h"]
            label = self._handler_labels.get(fn) or _function_label(fn) or f"anonymous#{n}"
            node = {"id": f"h{n}", "processId": owner.process["id"], "kind": "handler", "label": label}
            self._handlers.set(fn, node)
            self.nodes[node["id"]] = node
            self._fresh_nodes.append(node)
            return node

    def drain_fresh(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Nodes and processes created since the last call (for live streaming)."""
        with self._lock:
            nodes, processes = self._fresh_nodes, self._fresh_processes
            self._fresh_nodes, self._fresh_processes = [], []
            return nodes, processes


def _function_label(fn: Any) -> Optional[str]:
    name = getattr(fn, "__qualname__", None) or getattr(fn, "__name__", None)
    if not isinstance(name, str) or not name or "<lambda>" in name:
        return None
    # Drop the "<locals>" noise of nested functions: `make_app.<locals>.on_order` -> `on_order`.
    return name.rsplit("<locals>.", 1)[-1]

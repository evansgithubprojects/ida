"""
Ida for Python: records event-driven code and uploads it to your Ida project, where you can replay it.

>>> import ida
>>> ida.enable()
>>> ida.cloud.configure(project_key=os.environ["IDA_PROJECT_KEY"], endpoint="https://api.example.com")
"""

from __future__ import annotations

from .core.emitter import Emitter
from .core.keyed import DEFAULT_RECORDER_KEY, connect_recorder, enable, get_recorder, get_recorders, on_recorder
from .core.propagation import PARENT_HEADER, RemoteParent, broker_process_id, format_parent_header, parse_parent_header
from .core.recorder import RECORDING_VERSION, DispatchInfo, Frame, Invoke, Recorder, Scope
from .core.registry import BrokerRef
from .core.routing import (
    dispatch_all,
    get_default_recorder,
    is_tracked,
    open_all,
    recorders_for,
    set_default_recorder,
)
from .core.shapes import default_template_key, payload_shape

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_RECORDER_KEY",
    "PARENT_HEADER",
    "RECORDING_VERSION",
    "BrokerRef",
    "DispatchInfo",
    "Emitter",
    "Frame",
    "Invoke",
    "Recorder",
    "RemoteParent",
    "Scope",
    "__version__",
    "broker_process_id",
    "connect_recorder",
    "default_template_key",
    "dispatch_all",
    "enable",
    "format_parent_header",
    "get_default_recorder",
    "get_recorder",
    "get_recorders",
    "is_tracked",
    "on_recorder",
    "open_all",
    "parse_parent_header",
    "payload_shape",
    "recorders_for",
    "set_default_recorder",
]

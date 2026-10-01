"""P4-G0 one-run, host-owned event channel and closed in-memory timeline."""

from __future__ import annotations

import hmac
import json
import re
import secrets
import socket
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Mapping

from .protocol import BRIDGE_CODES, REASONS, STATUSES, _pairs_unique

VERSION = "1"
MAX_FRAME = 2048
MAX_FRAMES = 256
MAX_BYTES = 256 * 1024
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_FP = re.compile(r"^[a-f0-9]{64}$")
_TOOLS = frozenset(("browser_navigate", "browser_snapshot", "browser_find",
                    "browser_generate_locator", "browser_click", "browser_fill_form",
                    "browser_select_option", "browser_wait_for"))
_QUALITY = frozenset(("UNSUPPORTED_GRAMMAR", "WEAK_IDENTITY",
                      "TEST_ID_PROVENANCE_UNVERIFIED", "NON_UNIQUE_MATCH", "TARGET_MISMATCH"))
_BASE = frozenset(("testSpecId", "executionProfileRef", "profileFingerprint"))
_SCOPES: dict[str, tuple[set[str], set[str]]] = {
    "workflow_started": (set(), set()),
    "interpretation_started": (set(), set()),
    "interpretation_finished": (set(), set()),
    "exploration_started": ({"explorationAttemptId"}, {"explorationAttemptId"}),
    "step_decision_started": ({"explorationAttemptId", "originStepId"}, {"explorationAttemptId", "originStepId"}),
    "step_decision_finished": ({"explorationAttemptId", "originStepId"}, {"explorationAttemptId", "originStepId"}),
    "mcp_tool_started": ({"explorationAttemptId", "mcpCallId"}, {"explorationAttemptId", "mcpCallId"}),
    "mcp_tool_finished": ({"explorationAttemptId", "mcpCallId"}, {"explorationAttemptId", "mcpCallId"}),
    "locator_assessed": ({"explorationAttemptId", "originStepId", "executionStepId", "locatorId"},
                         {"explorationAttemptId", "originStepId", "executionStepId", "locatorId"}),
    "resolved_spec_ready": ({"explorationAttemptId", "resolvedSpecId"}, {"explorationAttemptId", "resolvedSpecId"}),
    "replay_started": ({"explorationAttemptId", "resolvedSpecId", "executionRunId"},
                       {"explorationAttemptId", "resolvedSpecId", "executionRunId"}),
    "replay_finished": ({"explorationAttemptId", "resolvedSpecId", "executionRunId"},
                        {"explorationAttemptId", "resolvedSpecId", "executionRunId"}),
    "report_completed": (set(), {"explorationAttemptId", "resolvedSpecId"}),
    "stream_truncated": (set(), set()),
    "terminal": (set(), {"explorationAttemptId", "resolvedSpecId"}),
}
_ENVELOPE = frozenset(("eventStreamVersion", "streamId", "sequence", "occurredAt", "kind", "context", "data"))


class InvalidEvent(ValueError):
    """An event cannot be displayed as a trusted Node execution fact."""


def _object(value: Any, required: set[str] | frozenset[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise InvalidEvent("Invalid event object")
    return value


def _choice(value: Any, choices: set[str] | frozenset[str]) -> None:
    if type(value) is not str or value not in choices:
        raise InvalidEvent("Unreviewed event value")


def _id(value: Any) -> None:
    if type(value) is not str or not _ID.fullmatch(value):
        raise InvalidEvent("Invalid event identifier")


def parse_event_frame(frame: bytes, stream_id: str) -> dict[str, Any]:
    if not frame.endswith(b"\n") or len(frame) > MAX_FRAME or b"\r" in frame or b"\n" in frame[:-1]:
        raise InvalidEvent("Invalid event framing")
    try:
        value = json.loads(frame[:-1].decode("utf-8"), object_pairs_hook=_pairs_unique)
    except (UnicodeError, ValueError, TypeError) as error:
        raise InvalidEvent("Invalid event JSON") from error
    event = _object(value, _ENVELOPE)
    if event["eventStreamVersion"] != VERSION or event["streamId"] != stream_id or \
            type(event["sequence"]) is not int or not 1 <= event["sequence"] <= MAX_FRAMES:
        raise InvalidEvent("Invalid event envelope")
    timestamp = event["occurredAt"]
    if type(timestamp) is not str or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", timestamp):
        raise InvalidEvent("Invalid event timestamp")
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise InvalidEvent("Invalid event timestamp") from error
    kind = event["kind"]
    if type(kind) is not str or kind not in _SCOPES:
        raise InvalidEvent("Unreviewed event kind")
    data = _object(event["data"], set(), {
        "outcome", "tool", "basis", "reasons", "ordinal", "status", "availability",
        "cause", "resultKind", "stopKind", "phase", "reason", "code", "cleanup",
    })
    if kind in {"workflow_started", "interpretation_started", "exploration_started",
                "step_decision_started", "step_decision_finished", "resolved_spec_ready"}:
        _object(data, set())
    elif kind == "interpretation_finished":
        _object(data, {"outcome"}); _choice(data["outcome"], {"accepted", "stopped"})
    elif kind in {"mcp_tool_started", "mcp_tool_finished"}:
        _object(data, {"tool"} | ({"outcome"} if kind.endswith("finished") else set()))
        _choice(data["tool"], _TOOLS)
        if "outcome" in data: _choice(data["outcome"], {"completed", "failed"})
    elif kind == "locator_assessed":
        _object(data, {"outcome", "basis", "reasons"})
        _choice(data["outcome"], {"accepted", "rejected"})
        _choice(data["basis"], {"mcp_generated", "semantic_row_scope"})
        reasons = data["reasons"]
        if type(reasons) is not list or len(reasons) > 5 or any(type(reason) is not str or reason not in _QUALITY for reason in reasons) or len(set(reasons)) != len(reasons):
            raise InvalidEvent("Invalid locator reasons")
    elif kind in {"replay_started", "replay_finished"}:
        _object(data, {"ordinal"} | ({"status"} if kind.endswith("finished") else set()))
        if type(data["ordinal"]) is not int or data["ordinal"] not in {1, 2}: raise InvalidEvent("Invalid replay ordinal")
        if "status" in data: _choice(data["status"], STATUSES)
    elif kind == "report_completed":
        _object(data, {"availability"}); _choice(data["availability"], {"available", "unavailable"})
    elif kind == "stream_truncated":
        _object(data, {"cause"}); _choice(data["cause"], {"event_limit", "byte_limit"})
    else:
        result_kind = data.get("resultKind")
        _choice(result_kind, {"success", "typed_stop", "bridge_error"})
        if result_kind == "bridge_error":
            _object(data, {"resultKind", "code", "cleanup"})
            _choice(data["code"], BRIDGE_CODES)
            _choice(data["cleanup"], {"not_started", "verified", "unverified"})
        else:
            _object(data, {"resultKind", "phase", "status"} |
                    ({"stopKind"} if result_kind == "typed_stop" else set()), {"reason"})
            _choice(data["phase"], {"interpretation", "exploration", "locator", "execution"})
            _choice(data["status"], STATUSES)
            if "stopKind" in data: _choice(data["stopKind"], {"qa_failure", "automation_stop"})
            if "reason" in data: _choice(data["reason"], REASONS)
    context = event["context"]
    if kind == "terminal" and data["resultKind"] == "bridge_error":
        if context is not None: raise InvalidEvent("Bridge terminal context must be null")
    else:
        required, allowed = _SCOPES[kind]
        context = _object(context, _BASE | required, allowed - required)
        for key in context.keys() - {"executionProfileRef", "profileFingerprint"}:
            _id(context[key])
        ref = _object(context["executionProfileRef"], {"id", "version"})
        _id(ref["id"])
        if type(ref["version"]) is not str or not _VERSION.fullmatch(ref["version"]):
            raise InvalidEvent("Invalid profile version")
        if type(context["profileFingerprint"]) is not str or not _FP.fullmatch(context["profileFingerprint"]):
            raise InvalidEvent("Invalid fingerprint")
    return event


class LiveEventBuffer:
    """Thread-safe display cache; no persistence or QA authority."""

    def __init__(self) -> None:
        self.stream_id = str(uuid.uuid4())
        self._lock = threading.Lock()
        self._events: list[dict[str, Any]] = []
        self._count = 0
        self._bytes = 0
        self.state = "waiting"
        self.omitted = 0
        self._identity: tuple[Any, ...] | None = None
        self._mcp: dict[str, str] = {}
        self._replays: dict[int, str] = {}
        self._attempt: str | None = None
        self._resolved: str | None = None

    def add(self, frame: bytes) -> None:
        event = parse_event_frame(frame, self.stream_id)
        with self._lock:
            if self.state == "unavailable": return
            self._count += 1; self._bytes += len(frame)
            if self._count > MAX_FRAMES or self._bytes > MAX_BYTES or event["sequence"] != self._count:
                self.state = "unavailable"; raise InvalidEvent("Event sequence or stream limit")
            context = event["context"]
            if context is not None:
                identity = (context["testSpecId"], context["executionProfileRef"]["id"],
                            context["executionProfileRef"]["version"], context["profileFingerprint"])
                if self._identity is None:
                    if event["kind"] != "workflow_started" or self._count != 1:
                        self.state = "unavailable"; raise InvalidEvent("Workflow start missing")
                    self._identity = identity
                elif self._identity != identity:
                    self.state = "unavailable"; raise InvalidEvent("Event correlation changed")
            elif event["kind"] != "terminal":
                self.state = "unavailable"; raise InvalidEvent("Unexpected null event context")
            kind = event["kind"]
            if context is not None:
                attempt = context.get("explorationAttemptId")
                resolved = context.get("resolvedSpecId")
                if kind == "exploration_started":
                    if self._attempt is not None:
                        self.state = "unavailable"; raise InvalidEvent("Duplicate exploration")
                    self._attempt = attempt
                elif attempt is not None and attempt != self._attempt:
                    self.state = "unavailable"; raise InvalidEvent("Exploration correlation changed")
                if kind == "resolved_spec_ready":
                    if self._resolved is not None:
                        self.state = "unavailable"; raise InvalidEvent("Duplicate resolved spec")
                    self._resolved = resolved
                elif resolved is not None and resolved != self._resolved:
                    self.state = "unavailable"; raise InvalidEvent("Resolved spec correlation changed")
            if kind == "mcp_tool_started": self._mcp[context["mcpCallId"]] = event["data"]["tool"]
            if kind == "mcp_tool_finished":
                if self._mcp.pop(context["mcpCallId"], None) != event["data"]["tool"]:
                    self.state = "unavailable"; raise InvalidEvent("Unpaired MCP call")
            if kind == "replay_started":
                ordinal = event["data"]["ordinal"]
                if self._resolved is None or ordinal in self._replays or \
                        (ordinal == 2 and 1 not in self._replays):
                    self.state = "unavailable"; raise InvalidEvent("Replay order invalid")
                self._replays[ordinal] = context["executionRunId"]
            if kind == "replay_finished" and self._replays.get(event["data"]["ordinal"]) != context["executionRunId"]:
                self.state = "unavailable"; raise InvalidEvent("Replay correlation invalid")
            self._events.append(event)
            if len(self._events) > 128:
                self._events.pop(0); self.omitted += 1
            self.state = "live"

    def mark_unavailable(self) -> None:
        with self._lock: self.state = "unavailable"

    def reconcile(self, outcome: Mapping[str, Any]) -> None:
        with self._lock:
            if self.state == "unavailable": return
            terminal = self._events[-1] if self._events and self._events[-1]["kind"] == "terminal" else None
            if terminal is None:
                self.state = "unavailable"; return
            data = terminal["data"]
            if data["resultKind"] != outcome["kind"]:
                self.state = "inconsistent"; return
            if outcome["kind"] == "bridge_error":
                if data["code"] != outcome["code"] or data["cleanup"] != outcome["cleanup"]:
                    self.state = "inconsistent"
            elif outcome["kind"] in {"success", "typed_stop"}:
                final = outcome["terminal"]
                if any(data.get(key) != final.get(key) for key in ("phase", "status", "reason")) or \
                        (outcome["kind"] == "typed_stop" and data.get("stopKind") != outcome["stopKind"]) or \
                        self._identity is None or self._identity != (
                            outcome["context"]["testSpecId"], outcome["context"]["executionProfileRef"]["id"],
                            outcome["context"]["executionProfileRef"]["version"],
                            outcome["context"]["profileFingerprint"]):
                    self.state = "inconsistent"
                progress = outcome["context"]["progress"]
                if progress["stage"] != "not_started" and self._attempt != progress["explorationAttemptId"]:
                    self.state = "inconsistent"
                if progress["stage"] == "replayed" and (
                        self._resolved != progress["resolvedSpecId"] or
                        [self._replays.get(1), self._replays.get(2)] != progress["executionRunIds"]):
                    self.state = "inconsistent"
            else:
                self.state = "unavailable"

    def snapshot(self) -> tuple[str, int, list[dict[str, Any]]]:
        with self._lock:
            # A contradiction with the final v1 result invalidates the whole
            # display timeline, including events accepted before reconciliation.
            if self.state == "inconsistent":
                return self.state, 0, []
            return self.state, self.omitted, list(self._events)


class EventChannel:
    """Exactly one authenticated localhost connection per Node child."""

    def __init__(self, buffer: LiveEventBuffer):
        self.buffer = buffer
        self.capability = secrets.token_hex(32)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.25)
        self.port = self.listener.getsockname()[1]
        self._closed = threading.Event()
        self._peer: socket.socket | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None: self._thread.start()

    def close(self) -> None:
        self._closed.set()
        try: self.listener.close()
        except OSError: pass
        if self._peer is not None:
            try: self._peer.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            self._peer.close()
        self._thread.join(timeout=0.5)

    def _readline(self, peer: socket.socket, limit: int) -> bytes:
        frame = bytearray()
        while not self._closed.is_set():
            chunk = peer.recv(1)
            if not chunk: raise InvalidEvent("Event channel EOF")
            frame.extend(chunk)
            if len(frame) > limit: raise InvalidEvent("Event frame too large")
            if chunk == b"\n": return bytes(frame)
        raise InvalidEvent("Event channel closed")

    def _run(self) -> None:
        authenticated = False
        deadline = time.monotonic() + 15
        try:
            while not self._closed.is_set() and time.monotonic() < deadline:
                try: peer, address = self.listener.accept()
                except socket.timeout: continue
                if address[0] != "127.0.0.1": peer.close(); continue
                peer.settimeout(5)
                self._peer = peer
                try:
                    hello = json.loads(self._readline(peer, MAX_FRAME)[:-1].decode("utf-8"),
                                       object_pairs_hook=_pairs_unique)
                    _object(hello, {"eventStreamVersion", "kind", "streamId", "capability"})
                    if hello["eventStreamVersion"] != VERSION or hello["kind"] != "hello" or \
                            hello["streamId"] != self.buffer.stream_id or type(hello["capability"]) is not str or \
                            not hmac.compare_digest(hello["capability"], self.capability):
                        raise InvalidEvent("Event authentication denied")
                    authenticated = True
                    self.listener.close()
                    peer.sendall((json.dumps({"eventStreamVersion": VERSION, "kind": "ready",
                                              "streamId": self.buffer.stream_id}) + "\n").encode())
                    self.capability = ""
                    peer.settimeout(None)
                    while not self._closed.is_set():
                        try: frame = self._readline(peer, MAX_FRAME)
                        except InvalidEvent as error:
                            if str(error) == "Event channel EOF" and self.buffer.snapshot()[2] and \
                                    self.buffer.snapshot()[2][-1]["kind"] == "terminal":
                                break
                            raise
                        self.buffer.add(frame)
                finally:
                    peer.close()
                break
            if not authenticated and not self._closed.is_set(): self.buffer.mark_unavailable()
        except (OSError, UnicodeError, ValueError, TypeError):
            if not self._closed.is_set(): self.buffer.mark_unavailable()
        finally:
            if not authenticated and not self._closed.is_set():
                try: self.listener.close()
                except OSError: pass

    def wait_for_eof(self, seconds: float = 0.5) -> None:
        self._thread.join(timeout=seconds)
        if self._thread.is_alive(): self.buffer.mark_unavailable()

"""Thin consumer of Node's separate read-only report projection exchange."""

from __future__ import annotations

import json
import math
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Mapping

from .host import HostCallResult, _Drain, _failure, _stderr_summary, _stop_child
from .protocol import InvalidWire, REASONS, STATUSES, parse_response

VERSION = "1"
MAX_REQUEST_BYTES = 8_192
MAX_RESPONSE_BYTES = 65_536
_REASONS = frozenset({"REPORT_UNAVAILABLE", "REPORT_NOT_FOUND", "REPORT_EXPIRED",
                      "CORRELATION_MISMATCH", "REPORT_INVALID", "REPORT_TOO_LARGE",
                      "INVALID_REQUEST", "CONFIGURATION_UNAVAILABLE"})
_SCREENSHOTS = frozenset({"capture_disabled", "not_captured", "stored_restricted"})
_MEDIA = frozenset({"application/json", "text/plain", "image/png", "application/zip", "video/webm"})
_SENSITIVITY = frozenset({"redacted", "restricted"})
_ASSERTIONS = frozenset({"assert_visible", "assert_text", "assert_value", "assert_url",
                        "assert_link_collection"})
_PHASES = frozenset({"interpretation", "exploration", "locator", "execution"})


def _closed(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise InvalidWire("Invalid projection fields")
    return value


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise InvalidWire("Duplicate projection field")
        value[key] = item
    return value


def parse_report_projection(data: bytes, result: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the bounded UI contract and correlate it with the trusted v1 result."""
    if len(data) > MAX_RESPONSE_BYTES:
        raise InvalidWire("Projection response too large")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(InvalidWire("Invalid JSON constant")))
    except (UnicodeError, ValueError) as error:
        raise InvalidWire("Invalid projection JSON") from error
    _closed(value, {"reportProjectionVersion", "kind"},
            {"reason", "testSpecId", "executionProfileRef", "profileFingerprint",
             "explorationAttemptId", "resolvedSpecId", "executionRunIds", "terminal",
             "observation", "outcomes", "evidence", "screenshot"})
    if value["reportProjectionVersion"] != VERSION:
        raise InvalidWire("Unsupported projection version")
    if value["kind"] == "unavailable":
        _closed(value, {"reportProjectionVersion", "kind", "reason"})
        if value["reason"] not in _REASONS:
            raise InvalidWire("Invalid unavailable reason")
        return value
    _closed(value, {"reportProjectionVersion", "kind", "testSpecId", "executionProfileRef",
                    "profileFingerprint", "executionRunIds", "terminal", "observation",
                    "outcomes", "evidence", "screenshot"},
            {"explorationAttemptId", "resolvedSpecId"})
    if value["kind"] != "available" or result.get("kind") not in {"success", "typed_stop"}:
        raise InvalidWire("Projection is not tied to an engine result")
    terminal = _closed(value["terminal"], {"phase", "status"}, {"reason"})
    if type(terminal["phase"]) is not str or terminal["phase"] not in _PHASES or \
       type(terminal["status"]) is not str or terminal["status"] not in STATUSES or \
       ("reason" in terminal and (type(terminal["reason"]) is not str or
        terminal["reason"] not in REASONS)):
        raise InvalidWire("Invalid terminal vocabulary")
    context = result["context"]
    if context["report"].get("kind") != "available" or any((
        value["testSpecId"] != context["testSpecId"],
        value["executionProfileRef"] != context["executionProfileRef"],
        value["profileFingerprint"] != context["profileFingerprint"],
        value["terminal"] != result["terminal"],
        value["observation"] != context["observation"]["state"],
        value["screenshot"] not in _SCREENSHOTS,
    )):
        raise InvalidWire("Projection correlation mismatch")
    progress = context["progress"]
    if value.get("explorationAttemptId") != progress.get("explorationAttemptId") or \
       value.get("resolvedSpecId") != progress.get("resolvedSpecId") or \
       value["executionRunIds"] != progress.get("executionRunIds", []):
        raise InvalidWire("Projection progress mismatch")
    outcomes, evidence = value["outcomes"], value["evidence"]
    if type(outcomes) is not list or len(outcomes) > 128 or type(evidence) is not list or len(evidence) > 64:
        raise InvalidWire("Projection collection limit exceeded")
    for item in outcomes:
        _closed(item, {"phase", "status", "expected", "actual"},
                {"reason", "originStepId", "executionStepId", "executionRunId", "assertionType"})
        if type(item["phase"]) is not str or item["phase"] not in _PHASES or \
           type(item["status"]) is not str or item["status"] not in STATUSES or \
           ("reason" in item and (type(item["reason"]) is not str or item["reason"] not in REASONS)):
            raise InvalidWire("Invalid outcome vocabulary")
        if item.get("assertionType") is not None and item["assertionType"] not in _ASSERTIONS:
            raise InvalidWire("Unknown assertion type")
        for key in ("expected", "actual"):
            state = item[key]
            if type(state) is not dict or state.get("state") not in {"absent", "withheld", "displayable"}:
                raise InvalidWire("Invalid value state")
            _closed(state, {"state"}, {"value"} if state["state"] == "displayable" else frozenset())
            if state["state"] == "displayable" and ("value" not in state or
                type(state["value"]) not in {int, float, bool, type(None)} or
                (type(state["value"]) is float and not math.isfinite(state["value"]))):
                raise InvalidWire("Invalid display value")
    for item in evidence:
        _closed(item, {"evidenceId", "owner", "mediaType", "sensitivity", "capturedAt", "byteLength"},
                {"originStepId", "executionStepId"})
        _closed(item["owner"], {"kind", "id"})
        if item["mediaType"] not in _MEDIA or item["sensitivity"] not in _SENSITIVITY or \
           item["owner"]["kind"] not in {"attempt", "run"} or \
           type(item["byteLength"]) is not int or item["byteLength"] < 0:
            raise InvalidWire("Invalid evidence metadata")
    return value


def call_report_projection(
    result: Mapping[str, Any], *, node_entry: str | Path, config_path: str | Path,
    node_executable: str | Path = "node", deadline_ms: int = 30_000,
    environment: Mapping[str, str] | None = None,
) -> HostCallResult:
    """Request only safe metadata; the artifact root stays a trusted launch argument."""
    if type(deadline_ms) is not int or not 0 < deadline_ms <= 30_000:
        raise ValueError("Invalid projection deadline")
    result_data = json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    # The v1 parser is reused for validation; it does not grant report access.
    ref = result.get("context", {}).get("executionProfileRef", {}) if type(result.get("context")) is dict else {}
    parse_response(result_data, ref)
    data = json.dumps({"reportProjectionVersion": VERSION, "result": result},
                      separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
    if len(data) > MAX_REQUEST_BYTES:
        raise ValueError("Projection request exceeds limit")
    try:
        process = subprocess.Popen(
            [str(node_executable), str(node_entry), "--config", str(config_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(environment) if environment is not None else None,
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
    except OSError:
        return _failure("LAUNCH_FAILED", cleanup="not_started")
    assert process.stdin and process.stdout and process.stderr
    stdout, stderr = _Drain(process.stdout, MAX_RESPONSE_BYTES), _Drain(process.stderr, 16_384)
    stdout.start()
    stderr.start()

    def write_request() -> None:
        try:
            process.stdin.write(data)
            process.stdin.close()
        except (OSError, ValueError):
            pass

    threading.Thread(target=write_request, daemon=True).start()
    try:
        try:
            process.wait(timeout=deadline_ms / 1000)
        except subprocess.TimeoutExpired:
            forced, descendants = _stop_child(process)
            return _failure("DEADLINE_EXCEEDED", forced=forced, descendants=descendants)
        stdout.join(timeout=2)
        stderr.join(timeout=2)
        if stdout.is_alive() or stderr.is_alive() or stdout.overflow or stderr.overflow:
            return _failure("OUTPUT_LIMIT_EXCEEDED", exit_code=process.returncode)
        diagnostic = _stderr_summary(stderr.data)
        if process.returncode != 0 or not stdout.data:
            return _failure("UNEXPECTED_EXIT" if stdout.data else "MISSING_RESPONSE",
                            exit_code=process.returncode, stderr=diagnostic)
        try:
            return HostCallResult(parse_report_projection(bytes(stdout.data), result), diagnostic)
        except InvalidWire:
            return _failure("MALFORMED_RESPONSE", exit_code=process.returncode, stderr=diagnostic)
    finally:
        # Keep every subprocess handle owned by this call; otherwise CPython
        # reports unclosed readers on repeated successful projection requests.
        if process.stdin is not None and not process.stdin.closed:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass
        stdout.join(timeout=2)
        stderr.join(timeout=2)
        if process.stdout is not None and not process.stdout.closed and not stdout.is_alive():
            process.stdout.close()
        if process.stderr is not None and not process.stderr.closed and not stderr.is_alive():
            process.stderr.close()

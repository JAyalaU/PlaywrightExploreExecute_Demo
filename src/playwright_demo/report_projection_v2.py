"""Bounded, closed consumer of Node's read-only agentic report projection v2."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from .host import HostCallResult, _Drain, _failure, _stderr_summary, _stop_child
from .wire_common import InvalidWire, _FP, _id, _obj, _pairs_unique
from .protocol_v2 import REASONS, TERMINALS, parse_response

VERSION = "2"
MAX_REQUEST_BYTES = 8_192
MAX_RESPONSE_BYTES = 65_536
UNAVAILABLE = frozenset({"REPORT_UNAVAILABLE", "REPORT_NOT_FOUND", "REPORT_EXPIRED",
    "CORRELATION_MISMATCH", "REPORT_INVALID", "REPORT_TOO_LARGE", "INVALID_REQUEST",
    "CONFIGURATION_UNAVAILABLE"})
RUN_STATES = frozenset({"completed_pass", "completed_fail", "automation_failed", "unavailable"})
MEDIA = frozenset({"application/json", "text/plain", "image/png", "application/zip", "video/webm"})
_UTC_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$")


def _safe_value(value: Any, qa: bool) -> None:
    item = _obj(value, {"state"}, {"value"})
    if item["state"] in {"absent", "withheld"}:
        _obj(item, {"state"})
    elif item["state"] == "displayable" and qa:
        _obj(item, {"state", "value"})
        v = item["value"]
        if type(v) not in {int, float, bool, type(None)} or type(v) is float and not math.isfinite(v):
            raise InvalidWire("Invalid projected assertion value")
    else:
        raise InvalidWire("Unreviewed projected assertion value")


def _parse_report_projection(data: bytes, result: Mapping[str, Any]) -> dict[str, Any]:
    if not data or len(data) > MAX_RESPONSE_BYTES: raise InvalidWire("Invalid projection size")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs_unique,
            parse_constant=lambda _: (_ for _ in ()).throw(InvalidWire("Invalid JSON constant")))
    except (UnicodeError, ValueError) as error:
        raise InvalidWire("Invalid projection JSON") from error
    item = _obj(value, {"reportProjectionVersion", "kind"}, {"reason", "testSpecId", "executionProfileRef",
        "profileFingerprint", "explorationAttemptId", "successfulTraceId", "compilerAttemptId",
        "resolvedSpecId", "executionRunIds", "terminal", "stages", "replays", "reproducibility",
        "authoritativeQa", "observation", "cleanup", "outcomes", "evidence", "screenshot"})
    if item["reportProjectionVersion"] != VERSION: raise InvalidWire("Wrong projection version")
    if item["kind"] == "unavailable":
        _obj(item, {"reportProjectionVersion", "kind", "reason"})
        if item["reason"] not in UNAVAILABLE: raise InvalidWire("Invalid unavailability reason")
        return item
    _obj(item, {"reportProjectionVersion", "kind", "testSpecId", "executionProfileRef",
        "profileFingerprint", "explorationAttemptId", "successfulTraceId", "executionRunIds",
        "terminal", "stages", "replays", "reproducibility", "observation", "cleanup",
        "outcomes", "evidence", "screenshot"}, {"compilerAttemptId", "resolvedSpecId", "authoritativeQa"})
    if item["kind"] != "available" or result.get("protocolVersion") != VERSION or result.get("kind") not in {"success", "typed_stop"}:
        raise InvalidWire("Projection is not tied to agentic result")
    ref = result.get("context", {}).get("result", {}).get("executionProfileRef", {})
    parse_response(json.dumps(result, separators=(",", ":")).encode("utf-8"), ref)
    context = result["context"]
    record = context["result"]
    for key in ("testSpecId", "executionProfileRef", "profileFingerprint", "explorationAttemptId",
                "successfulTraceId", "compilerAttemptId", "resolvedSpecId", "executionRunIds", "terminal",
                "observation", "cleanup"):
        if item.get(key) != record.get(key): raise InvalidWire("Projection correlation mismatch")
    if context["report"]["kind"] != "available" or not _FP.fullmatch(item["profileFingerprint"]):
        raise InvalidWire("Unapproved projection availability")
    qa = record["terminal"]["stage"] == "qa"
    if item.get("authoritativeQa") != (record["terminal"]["status"] if qa else None):
        raise InvalidWire("Projection QA mismatch")
    stages = _obj(item["stages"], {"exploration", "compilation", "replay"})
    for name, stage in stages.items():
        _obj(stage, {"status"}, {"reason"})
        if stage["status"] not in {"not_started", "completed", "stopped"} or \
           ("reason" in stage and stage["reason"] not in REASONS):
            raise InvalidWire("Invalid projected stage")
    replays = item["replays"]
    if type(replays) is not list or len(replays) != len(record["executionRunIds"]):
        raise InvalidWire("Invalid projected replays")
    for index, replay in enumerate(replays):
        _obj(replay, {"executionRunId", "state"}); _id(replay["executionRunId"])
        if replay["executionRunId"] != record["executionRunIds"][index] or replay["state"] not in RUN_STATES:
            raise InvalidWire("Replay mismatch")
    if item["reproducibility"] not in {"not_established", "agreed", "disagreed"} or \
       (item["reproducibility"] == "disagreed") != (record["terminal"]["stage"] == "reproducibility") or \
       (qa and (item["reproducibility"] != "agreed" or len(replays) != 2 or
                any(x["state"] != ("completed_pass" if record["terminal"]["status"] == "QA_ASSERTION_PASSED" else "completed_fail") for x in replays))):
        raise InvalidWire("Reproducibility mismatch")
    if item["screenshot"] not in {"capture_disabled", "not_captured", "stored_restricted"}:
        raise InvalidWire("Unknown screenshot state")
    outcomes, evidence = item["outcomes"], item["evidence"]
    if type(outcomes) is not list or len(outcomes) > 128 or type(evidence) is not list or len(evidence) > 64:
        raise InvalidWire("Projection collection limit")
    for outcome in outcomes:
        _obj(outcome, {"executionRunId", "status", "expected", "actual"},
             {"originStepId", "executionStepId", "reason"})
        _id(outcome["executionRunId"])
        if outcome["executionRunId"] not in record["executionRunIds"] or outcome["status"] not in TERMINALS or \
           ("reason" in outcome and outcome["reason"] not in REASONS):
            raise InvalidWire("Invalid projected outcome")
        for key in ("originStepId", "executionStepId"):
            if key in outcome: _id(outcome[key])
        _safe_value(outcome["expected"], qa); _safe_value(outcome["actual"], qa)
    for descriptor in evidence:
        _obj(descriptor, {"evidenceId", "owner", "mediaType", "sensitivity", "capturedAt", "byteLength"},
             {"originStepId", "executionStepId"})
        _id(descriptor["evidenceId"])
        owner = _obj(descriptor["owner"], {"kind", "id"}); _id(owner["id"])
        if owner["kind"] != "run" or owner["id"] not in record["executionRunIds"] or \
           descriptor["mediaType"] not in MEDIA or descriptor["sensitivity"] not in {"redacted", "restricted"} or \
           type(descriptor["byteLength"]) is not int or descriptor["byteLength"] < 0 or \
           type(descriptor["capturedAt"]) is not str or not _UTC_INSTANT.fullmatch(descriptor["capturedAt"]):
            raise InvalidWire("Invalid evidence descriptor")
        try: datetime.fromisoformat(descriptor["capturedAt"].replace("Z", "+00:00"))
        except ValueError as error: raise InvalidWire("Invalid evidence timestamp") from error
        for key in ("originStepId", "executionStepId"):
            if key in descriptor: _id(descriptor[key])
    return item


def parse_report_projection(data: bytes, result: Mapping[str, Any]) -> dict[str, Any]:
    """Reject wrong-shaped Node metadata without affecting terminal authority."""
    try:
        return _parse_report_projection(data, result)
    except (KeyError, TypeError, ValueError) as error:
        raise InvalidWire("Invalid agentic projection") from error


def call_report_projection(result: Mapping[str, Any], *, node_entry: str | Path,
                           config_path: str | Path, node_executable: str | Path = "node",
                           deadline_ms: int = 30_000,
                           environment: Mapping[str, str] | None = None) -> HostCallResult:
    if type(deadline_ms) is not int or not 0 < deadline_ms <= 30_000:
        raise ValueError("Invalid projection deadline")
    ref = result.get("context", {}).get("result", {}).get("executionProfileRef", {})
    parse_response(json.dumps(result, separators=(",", ":")).encode("utf-8"), ref)
    data = json.dumps({"reportProjectionVersion": VERSION, "result": result},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(data) > MAX_REQUEST_BYTES: raise ValueError("Projection request exceeds limit")
    try:
        process = subprocess.Popen([str(node_executable), str(node_entry), "--config", str(config_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(environment) if environment is not None else None,
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
    except OSError:
        return _failure("LAUNCH_FAILED", cleanup="not_started")
    assert process.stdin and process.stdout and process.stderr
    stdout, stderr = _Drain(process.stdout, MAX_RESPONSE_BYTES), _Drain(process.stderr, 16_384)
    stdout.start(); stderr.start()
    def write_request() -> None:
        try:
            process.stdin.write(data); process.stdin.close()
        except (OSError, ValueError): pass
    threading.Thread(target=write_request, daemon=True).start()
    try:
        try: process.wait(timeout=deadline_ms / 1000)
        except subprocess.TimeoutExpired:
            forced, descendants = _stop_child(process)
            return _failure("DEADLINE_EXCEEDED", forced=forced, descendants=descendants)
        stdout.join(timeout=2); stderr.join(timeout=2)
        if stdout.is_alive() or stderr.is_alive() or stdout.overflow or stderr.overflow:
            return _failure("OUTPUT_LIMIT_EXCEEDED", exit_code=process.returncode)
        diagnostic = _stderr_summary(stderr.data)
        if process.returncode != 0 or not stdout.data:
            return _failure("UNEXPECTED_EXIT" if stdout.data else "MISSING_RESPONSE",
                            exit_code=process.returncode, stderr=diagnostic)
        try: return HostCallResult(parse_report_projection(bytes(stdout.data), result), diagnostic)
        except InvalidWire: return _failure("MALFORMED_RESPONSE", exit_code=process.returncode, stderr=diagnostic)
    finally:
        if process.stdin is not None and not process.stdin.closed: process.stdin.close()
        stdout.join(timeout=2); stderr.join(timeout=2)
        if process.stdout is not None and not process.stdout.closed and not stdout.is_alive(): process.stdout.close()
        if process.stderr is not None and not process.stderr.closed and not stderr.is_alive(): process.stderr.close()

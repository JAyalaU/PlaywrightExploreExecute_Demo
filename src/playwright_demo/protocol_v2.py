"""Closed Python consumer of Node's agentic subprocess protocol v2."""

from __future__ import annotations

import json
from typing import Any, Mapping

from .wire_common import (_FP, InvalidWire, _id, _obj, _one, _pairs_unique,
                          _version, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES)

VERSION = "2"
REASONS = frozenset((
    "TARGET_NOT_FOUND", "BUDGET_EXHAUSTED", "UNSAFE_RECOVERY", "UNSUPPORTED_OPERATION",
    "UNSUPPORTED_CAPABILITY", "PROVIDER_ERROR", "PROVIDER_TIMEOUT", "MODEL_ERROR",
    "MODEL_TIMEOUT", "BROWSER_UNAVAILABLE", "NETWORK_POLICY_DENIED", "UNSUPPORTED_GRAMMAR",
    "WEAK_IDENTITY", "NON_UNIQUE_MATCH", "TARGET_MISMATCH", "PROFILE_MISMATCH",
    "POSTCONDITION_MISMATCH", "COMPILER_ENVIRONMENT_UNAVAILABLE", "REPLAY_ENVIRONMENT_UNAVAILABLE",
    "NO_MATCH", "AMBIGUOUS_MATCH", "FRAME_RESOLUTION_FAILED", "WAIT_CONDITION_TIMEOUT",
    "UNKNOWN_TIMEOUT_POLICY", "REPLAY_EXECUTION_FAILED", "EVALUATION_FAILED",
    "REPLAY_OUTCOMES_DISAGREE", "NOT_VISIBLE", "TEXT_MISMATCH", "VALUE_MISMATCH",
    "URL_MISMATCH", "LINK_COUNT_MISMATCH", "LINK_DESTINATION_MISMATCH",
    "SESSION_CLEANUP_FAILED", "CANCELLED", "REDACTED_REASON", "INVALID_TEST_SPEC",
    "MATERIAL_AMBIGUITY", "MALFORMED_MODEL_OUTPUT",
))
TERMINALS = {
    "INTERPRETATION_FAILED": ("interpretation", {"INVALID_TEST_SPEC", "MALFORMED_MODEL_OUTPUT", "REDACTED_REASON"}),
    "AMBIGUOUS_INSTRUCTION": ("interpretation", {"MATERIAL_AMBIGUITY", "REDACTED_REASON"}),
    "EXPLORATION_UNRESOLVED": ("exploration", {"TARGET_NOT_FOUND", "BUDGET_EXHAUSTED", "UNSAFE_RECOVERY", "REDACTED_REASON"}),
    "EXPLORATION_UNSUPPORTED": ("exploration", {"UNSUPPORTED_OPERATION", "UNSUPPORTED_CAPABILITY", "REDACTED_REASON"}),
    "COMPILATION_FAILED": ("compilation", {"UNSUPPORTED_GRAMMAR", "WEAK_IDENTITY", "NON_UNIQUE_MATCH", "TARGET_MISMATCH", "PROFILE_MISMATCH", "POSTCONDITION_MISMATCH", "REDACTED_REASON"}),
    "COMPILATION_UNSUPPORTED": ("compilation", {"UNSUPPORTED_CAPABILITY", "REDACTED_REASON"}),
    "REPLAY_BINDING_FAILED": ("replay", {"NO_MATCH", "AMBIGUOUS_MATCH", "FRAME_RESOLUTION_FAILED", "TARGET_MISMATCH", "REDACTED_REASON"}),
    "REPLAY_WAIT_FAILED": ("replay", {"WAIT_CONDITION_TIMEOUT", "NO_MATCH", "FRAME_RESOLUTION_FAILED", "UNKNOWN_TIMEOUT_POLICY", "REDACTED_REASON"}),
    "REPLAY_EXECUTION_FAILED": ("replay", {"REPLAY_EXECUTION_FAILED", "EVALUATION_FAILED", "REDACTED_REASON"}),
    "REPRODUCIBILITY_FAILED": ("reproducibility", {"REPLAY_OUTCOMES_DISAGREE"}),
    "QA_ASSERTION_PASSED": ("qa", None),
    "QA_ASSERTION_FAILED": ("qa", {"NO_MATCH", "NOT_VISIBLE", "TEXT_MISMATCH", "VALUE_MISMATCH", "URL_MISMATCH", "LINK_COUNT_MISMATCH", "LINK_DESTINATION_MISMATCH", "REDACTED_REASON"}),
    "ENVIRONMENT_FAILED": ("environment", {"MODEL_ERROR", "MODEL_TIMEOUT", "PROVIDER_ERROR", "PROVIDER_TIMEOUT", "BROWSER_UNAVAILABLE", "NETWORK_POLICY_DENIED", "COMPILER_ENVIRONMENT_UNAVAILABLE", "REPLAY_ENVIRONMENT_UNAVAILABLE", "SESSION_CLEANUP_FAILED", "REDACTED_REASON"}),
    "CANCELLED": ("cancellation", {"CANCELLED"}),
}
BRIDGE_CODES = frozenset(("INVALID_REQUEST", "INVALID_TRUSTED_CONFIGURATION", "PROFILE_UNAVAILABLE",
    "DESTINATION_DENIED", "PROVIDER_CONFIGURATION_ERROR", "CANCELLED", "WORKFLOW_FAILED",
    "REPORT_INVALID", "PROTOCOL_INVALID", "PROTOCOL_UNSUPPORTED_VERSION", "REQUEST_TOO_LARGE"))


def terminal(value: Any) -> dict[str, Any]:
    item = _obj(value, {"stage", "status"}, {"reason"})
    spec = TERMINALS.get(item["status"]) if type(item["status"]) is str else None
    if spec is None or item["stage"] != spec[0] or (
        (spec[1] is None and "reason" in item) or
        (spec[1] is not None and item.get("reason") not in spec[1])
    ):
        raise InvalidWire("Invalid agentic terminal")
    return item


def result_record(value: Any, request_ref: Mapping[str, Any]) -> dict[str, Any]:
    item = _obj(value, {"resultVersion", "workflowVersion", "testSpecId", "executionProfileRef",
        "profileFingerprint", "presentationMode", "observation", "executionRunIds", "terminal", "cleanup"},
        {"explorationAttemptId", "successfulTraceId", "compilerAttemptId", "resolvedSpecId", "semanticReplay"})
    if item["resultVersion"] != VERSION or item["workflowVersion"] != "semantic-general-v1":
        raise InvalidWire("Wrong agentic result version")
    _id(item["testSpecId"])
    ref = _obj(item["executionProfileRef"], {"id", "version"})
    _id(ref["id"]); _version(ref["version"])
    if ref != request_ref or type(item["profileFingerprint"]) is not str or not _FP.fullmatch(item["profileFingerprint"]):
        raise InvalidWire("Agentic profile mismatch")
    _one(item["presentationMode"], {"headless", "headed"})
    _one(item["observation"], {"unobserved", "no_intervention", "intervened", "observational"})
    if (item["presentationMode"] == "headed") != (item["observation"] == "observational"):
        raise InvalidWire("Invalid headed provenance")
    _one(item["cleanup"], {"not_started", "verified", "unverified"})
    for key in ("explorationAttemptId", "successfulTraceId", "compilerAttemptId", "resolvedSpecId"):
        if key in item: _id(item[key])
    runs = item["executionRunIds"]
    if type(runs) is not list or len(runs) > 2:
        raise InvalidWire("Invalid replay IDs")
    for run in runs: _id(run)
    if len(set(runs)) != len(runs): raise InvalidWire("Duplicate replay IDs")
    if (item.get("successfulTraceId") and not item.get("explorationAttemptId") or
        item.get("compilerAttemptId") and not item.get("successfulTraceId") or
        item.get("resolvedSpecId") and not item.get("compilerAttemptId") or
        runs and not item.get("resolvedSpecId")):
        raise InvalidWire("Broken agentic ID chain")
    if bool(item.get("resolvedSpecId")) != bool(item.get("semanticReplay")):
        raise InvalidWire("Semantic v10 linkage mismatch")
    if "semanticReplay" in item:
        linkage = _obj(item["semanticReplay"], {"sourceSchemaVersion", "sourceContractVersion",
            "groundingVersion", "traceVersion", "compilerVersion", "resolvedSchemaVersion",
            "runnerVersion", "replayPairVersion", "orchestrationId", "traceDigest",
            "resolvedDigest", "pairDigest", "executionSessionIds", "runDigests"})
        for key, expected in (("sourceSchemaVersion", "7"), ("sourceContractVersion", "3"),
                              ("groundingVersion", "semantic_capability_discovery_v1"),
                              ("traceVersion", "semantic_grounded_trace_v1"),
                              ("compilerVersion", "5"), ("resolvedSchemaVersion", "10"),
                              ("runnerVersion", "10"), ("replayPairVersion", "2")):
            if linkage[key] != expected: raise InvalidWire("Wrong semantic replay version")
        _id(linkage["orchestrationId"])
        for key in ("traceDigest", "resolvedDigest", "pairDigest"):
            if type(linkage[key]) is not str or not _FP.fullmatch(linkage[key]):
                raise InvalidWire("Invalid semantic replay digest")
        sessions = linkage["executionSessionIds"]
        digests = linkage["runDigests"]
        if type(sessions) is not list or type(digests) is not list or \
           len(sessions) != len(runs) or len(digests) != len(runs):
            raise InvalidWire("Semantic replay run mismatch")
        for session in sessions:
            if session is not None: _id(session)
        if len({session for session in sessions if session is not None}) != \
           len([session for session in sessions if session is not None]):
            raise InvalidWire("Duplicate semantic replay session")
        for digest in digests:
            if type(digest) is not str or not _FP.fullmatch(digest):
                raise InvalidWire("Invalid semantic run digest")
        if item["terminal"]["stage"] == "qa" and any(session is None for session in sessions):
            raise InvalidWire("QA requires two fresh semantic sessions")
    t = terminal(item["terminal"])
    if (t["stage"] in {"qa", "reproducibility"} and
        (len(runs) != 2 or not item.get("resolvedSpecId") or item["cleanup"] != "verified")):
        raise InvalidWire("Unverified authoritative result")
    if (t["stage"] == "exploration" and not item.get("explorationAttemptId") or
        t["stage"] == "compilation" and not item.get("compilerAttemptId") or
        t["stage"] == "replay" and not item.get("resolvedSpecId")):
        raise InvalidWire("Missing stage correlation")
    if item["cleanup"] == "unverified" and (t["stage"], t.get("reason")) != ("environment", "SESSION_CLEANUP_FAILED"):
        raise InvalidWire("Unverified cleanup must overlay result")
    return item


def request_bytes(request: Mapping[str, Any]) -> bytes:
    item = _obj(request, {"protocolVersion", "request"})
    if item["protocolVersion"] != VERSION: raise ValueError("Unsupported protocol version")
    task = _obj(item["request"], {"taskText", "targetUrl", "executionProfileRef"})
    if (type(task["taskText"]) is not str or len(task["taskText"]) > 16_384 or
        type(task["targetUrl"]) is not str or len(task["targetUrl"]) > 2_048):
        raise ValueError("Invalid bounded request")
    ref = _obj(task["executionProfileRef"], {"id", "version"})
    _id(ref["id"]); _version(ref["version"])
    data = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(data) > MAX_REQUEST_BYTES: raise ValueError("Request exceeds wire limit")
    return data


def _parse_response(data: bytes, request_ref: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    if not data or len(data) > MAX_RESPONSE_BYTES: raise InvalidWire("Missing or oversized response")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs_unique,
            parse_constant=lambda _: (_ for _ in ()).throw(InvalidWire("Invalid JSON constant")))
    except (UnicodeError, ValueError) as error:
        raise InvalidWire("Invalid response JSON") from error
    item = _obj(value, {"protocolVersion", "kind"}, {"context", "terminal", "stopKind", "code", "cleanup"})
    if item["protocolVersion"] != VERSION: raise InvalidWire("Unsupported response version")
    if item["kind"] == "bridge_error":
        _obj(item, {"protocolVersion", "kind", "code", "cleanup"})
        _one(item["code"], BRIDGE_CODES); _one(item["cleanup"], {"not_started", "verified", "unverified"})
        return item, 130 if item["code"] == "CANCELLED" else 64
    if item["kind"] == "success": _obj(item, {"protocolVersion", "kind", "context"})
    elif item["kind"] == "typed_stop": _obj(item, {"protocolVersion", "kind", "context", "stopKind"})
    else: raise InvalidWire("Unknown agentic response kind")
    context = _obj(item["context"], {"result", "progress", "report"})
    record = result_record(context["result"], request_ref)
    progress = _obj(context["progress"], {"stage"}, {"explorationAttemptId", "successfulTraceId", "compilerAttemptId", "resolvedSpecId", "executionRunIds"})
    stage = progress["stage"]
    fields = {"not_started": set(), "exploration": {"explorationAttemptId"},
        "compilation": {"explorationAttemptId", "successfulTraceId"},
        "replay": {"explorationAttemptId", "successfulTraceId", "compilerAttemptId", "resolvedSpecId", "executionRunIds"}}.get(stage)
    if fields is None: raise InvalidWire("Invalid progress")
    optional = {"compilerAttemptId"} if stage == "compilation" else set()
    _obj(progress, {"stage"} | fields, optional)
    if stage == "replay":
        if type(progress["executionRunIds"]) is not list or progress["executionRunIds"] != record["executionRunIds"]:
            raise InvalidWire("Replay progress mismatch")
    for key in ("explorationAttemptId", "successfulTraceId", "compilerAttemptId", "resolvedSpecId"):
        if progress.get(key) != record.get(key): raise InvalidWire("Progress correlation mismatch")
    if stage != "replay" and record["executionRunIds"]: raise InvalidWire("Unexpected replay IDs")
    report = _obj(context["report"], {"kind"}, {"testSpecId"})
    if report["kind"] == "available":
        _obj(report, {"kind", "testSpecId"}); _id(report["testSpecId"])
        if report["testSpecId"] != record["testSpecId"] or not record.get("successfulTraceId"):
            raise InvalidWire("Invalid report correlation")
    elif report["kind"] == "unavailable": _obj(report, {"kind"})
    else: raise InvalidWire("Unknown report kind")
    t = record["terminal"]
    if item["kind"] == "success":
        if t["status"] != "QA_ASSERTION_PASSED" or stage != "replay": raise InvalidWire("Invalid success")
        return item, 0
    expected = {"qa": "qa_failure", "environment": "environment_stop", "cancellation": "cancelled",
        "reproducibility": "reproducibility_stop"}.get(t["stage"], "automation_stop")
    if t["status"] == "QA_ASSERTION_PASSED" or item["stopKind"] != expected:
        raise InvalidWire("Agentic stop kind mismatch")
    return item, 1 if expected == "qa_failure" else 130 if expected == "cancelled" else 2


def parse_response(data: bytes, request_ref: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    """Reject malformed child output as InvalidWire, including wrong JSON types."""
    try:
        return _parse_response(data, request_ref)
    except (KeyError, TypeError, ValueError) as error:
        raise InvalidWire("Invalid agentic response") from error

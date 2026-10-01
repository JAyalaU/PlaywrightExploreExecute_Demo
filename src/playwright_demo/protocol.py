"""Validation for the P2-3A v1 Python-host wire boundary.

This mirrors only the closed transport envelope. Node remains the authority
for task semantics, browser policy, and QA result classification.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

VERSION = "1"
MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 65_536
MAX_STDERR_BYTES = 16_384
DEFAULT_DEADLINE_MS = 300_000
MAX_DEADLINE_MS = 1_200_000
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FP = re.compile(r"^[a-f0-9]{64}$")

STATUSES = frozenset((
    "INTERPRETATION_FAILED", "AMBIGUOUS_INSTRUCTION", "MCP_EXPLORATION_FAILED",
    "TARGET_RESOLUTION_FAILED", "LOCATOR_GENERATION_FAILED", "LOCATOR_QUALITY_FAILED",
    "TEST_BUILD_FAILED", "LOCATOR_BINDING_FAILED", "BROWSER_EXECUTION_FAILED",
    "QA_ASSERTION_FAILED", "QA_ASSERTION_PASSED", "OPERATION_SUCCEEDED", "NOT_RUN",
))
REASONS = frozenset((
    "AMBIGUOUS_MATCH", "AMBIGUOUS_TARGET", "DATA_REFERENCE_UNAVAILABLE",
    "DATA_REFERENCE_UNAVAILABLE_DURING_EXPLORATION", "DEPENDENCY_FAILED",
    "EVALUATION_FAILED", "FIND_LIMIT_EXCEEDED", "FRAME_RESOLUTION_FAILED",
    "INSUFFICIENT_CONTEXT", "INVALID_REQUEST", "INVALID_TEST_SPEC",
    "MALFORMED_LOCATOR_RESPONSE", "MALFORMED_MODEL_OUTPUT", "MATERIAL_AMBIGUITY",
    "MODEL_ERROR", "MODEL_TIMEOUT", "NETWORK_POLICY_DENIED", "NO_MATCH",
    "NON_UNIQUE_MATCH", "NOT_VISIBLE", "OPERATION_ERROR", "PAGE_CLOSED",
    "PREREQUISITE_LIMIT_EXCEEDED", "PREREQUISITE_VALUE_MISSING",
    "PROVIDER_ERROR", "PROVIDER_TIMEOUT", "QUALITY_NOT_ACCEPTED",
    "REDACTED_REASON", "REF_NOT_IN_CURRENT_SNAPSHOT", "SESSION_CLEANUP_FAILED",
    "START_STATE_FAILED", "TARGET_LOCATOR_MISSING", "TARGET_MISMATCH",
    "TARGET_NOT_FOUND", "TEST_ID_PROVENANCE_UNVERIFIED", "TEXT_MISMATCH",
    "UNEXPECTED_PAGE_COUNT", "UNKNOWN_TIMEOUT_POLICY", "UNSUPPORTED_GRAMMAR",
    "UNSUPPORTED_REQUEST", "UNSUPPORTED_SOURCE_TEXT", "URL_MISMATCH",
    "VALUE_MISMATCH", "WAIT_CONDITION_TIMEOUT", "WAIT_LIMIT_EXCEEDED",
    "WEAK_IDENTITY",
))
BRIDGE_CODES = frozenset((
    "INVALID_REQUEST", "INVALID_TRUSTED_CONFIGURATION", "PROFILE_UNAVAILABLE",
    "DESTINATION_DENIED", "PROVIDER_CONFIGURATION_ERROR", "CANCELLED",
    "WORKFLOW_FAILED", "REPORT_INVALID", "PROTOCOL_INVALID",
    "PROTOCOL_UNSUPPORTED_VERSION", "REQUEST_TOO_LARGE",
))


class InvalidWire(ValueError):
    """The child response cannot be trusted as a Node result."""


def _obj(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise InvalidWire("Missing or unknown fields")
    return value


def _one(value: Any, choices: set[str] | frozenset[str]) -> None:
    if type(value) is not str or value not in choices:
        raise InvalidWire("Invalid enum")


def _id(value: Any, limit: int = 128) -> None:
    if type(value) is not str or len(value) > limit or not _ID.fullmatch(value):
        raise InvalidWire("Invalid identifier")


def _version(value: Any) -> None:
    if type(value) is not str or len(value) > 64 or not _VERSION.fullmatch(value):
        raise InvalidWire("Invalid profile version")


def _id_list(value: Any, length: int | None = None, minimum: int = 0) -> None:
    if type(value) is not list or len(value) < minimum or (length is not None and len(value) != length):
        raise InvalidWire("Invalid identifier list")
    for item in value:
        _id(item)


def request_bytes(request: Mapping[str, Any]) -> bytes:
    """Apply host-side framing and authority checks; Node validates task semantics."""
    _obj(request, {"protocolVersion", "request"})
    if request["protocolVersion"] != VERSION:
        raise ValueError("Unsupported protocol version")
    task = _obj(request["request"], {"taskText", "targetUrl", "executionProfileRef"})
    if type(task["taskText"]) is not str or type(task["targetUrl"]) is not str:
        raise ValueError("Task and URL must be strings")
    ref = _obj(task["executionProfileRef"], {"id", "version"})
    _id(ref["id"])
    _version(ref["version"])
    data = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(data) > MAX_REQUEST_BYTES:
        raise ValueError("Request exceeds wire limit")
    return data


def _pairs_unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidWire("Duplicate JSON field")
        result[key] = value
    return result


def _context(value: Any, request_ref: Mapping[str, Any]) -> str:
    _obj(value, {"testSpecId", "executionProfileRef", "profileFingerprint",
                 "presentationMode", "observation", "progress", "report"})
    _id(value["testSpecId"])
    ref = _obj(value["executionProfileRef"], {"id", "version"})
    _id(ref["id"])
    _version(ref["version"])
    if ref != request_ref:
        raise InvalidWire("Response profile reference mismatch")
    if type(value["profileFingerprint"]) is not str or not _FP.fullmatch(value["profileFingerprint"]):
        raise InvalidWire("Invalid profile fingerprint")
    mode = value["presentationMode"]
    _one(mode, {"headed", "headless"})
    observation = value["observation"]
    if type(observation) is not dict:
        raise InvalidWire("Invalid observation")
    state = observation.get("state")
    if state == "observational":
        _obj(observation, {"state", "inputProvenance", "autonomousEligible", "eventIds"})
        if observation["inputProvenance"] != "unverified" or observation["autonomousEligible"] is not False:
            raise InvalidWire("Invalid headed provenance")
    elif state in {"unobserved", "no_intervention", "intervened"}:
        _obj(observation, {"state", "autonomousEligible", "eventIds"})
        if observation["autonomousEligible"] is not (state == "no_intervention"):
            raise InvalidWire("Invalid autonomous eligibility")
    else:
        raise InvalidWire("Unknown observation state")
    _id_list(observation["eventIds"], minimum=1 if state == "intervened" else 0)
    if state in {"unobserved", "no_intervention"} and observation["eventIds"]:
        raise InvalidWire("Unexpected event IDs")
    if (mode == "headed") != (state == "observational"):
        raise InvalidWire("Presentation/provenance mismatch")
    progress = value["progress"]
    if type(progress) is not dict:
        raise InvalidWire("Invalid progress")
    stage = progress.get("stage")
    if stage == "not_started":
        _obj(progress, {"stage"})
    elif stage == "exploration":
        _obj(progress, {"stage", "explorationAttemptId"})
        _id(progress["explorationAttemptId"])
    elif stage == "replayed":
        _obj(progress, {"stage", "explorationAttemptId", "resolvedSpecId", "executionRunIds"})
        _id(progress["explorationAttemptId"])
        _id(progress["resolvedSpecId"])
        _id_list(progress["executionRunIds"], length=2)
        if progress["executionRunIds"][0] == progress["executionRunIds"][1]:
            raise InvalidWire("Duplicate replay run IDs")
    else:
        raise InvalidWire("Unknown progress stage")
    report = value["report"]
    if type(report) is not dict:
        raise InvalidWire("Invalid report")
    if report.get("kind") == "unavailable":
        _obj(report, {"kind"})
    elif report.get("kind") == "available":
        _obj(report, {"kind", "testSpecId"})
        _id(report["testSpecId"])
        if report["testSpecId"] != value["testSpecId"]:
            raise InvalidWire("Report ID mismatch")
    else:
        raise InvalidWire("Unknown report kind")
    if stage in {"exploration", "replayed"} and report["kind"] != "available":
        raise InvalidWire("Progress requires report")
    return stage


def parse_response(data: bytes, request_ref: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    """Return a validated Node envelope and its required process exit code."""
    if not data:
        raise InvalidWire("Missing response")
    if len(data) > MAX_RESPONSE_BYTES:
        raise InvalidWire("Response too large")
    try:
        content = data.decode("utf-8").lstrip()
        decoder = json.JSONDecoder(object_pairs_hook=_pairs_unique,
                                   parse_constant=lambda _: (_ for _ in ()).throw(InvalidWire("Invalid constant")))
        value, end = decoder.raw_decode(content)
        remainder = content[end:].strip()
        if remainder:
            try:
                _, second_end = decoder.raw_decode(remainder)
            except (json.JSONDecodeError, InvalidWire):
                raise InvalidWire("Invalid trailing data") from None
            if remainder[second_end:].strip():
                raise InvalidWire("Invalid trailing data")
            raise InvalidWire("Multiple responses")
    except (UnicodeError, json.JSONDecodeError) as error:
        raise InvalidWire("Invalid JSON") from error
    if type(value) is not dict or value.get("protocolVersion") != VERSION:
        raise InvalidWire("Unsupported response version")
    kind = value.get("kind")
    if kind == "bridge_error":
        _obj(value, {"protocolVersion", "kind", "code", "cleanup"})
        _one(value["code"], BRIDGE_CODES)
        _one(value["cleanup"], {"not_started", "verified", "unverified"})
        return value, 130 if value["code"] == "CANCELLED" else 64
    if kind == "success":
        _obj(value, {"protocolVersion", "kind", "context", "terminal"})
    elif kind == "typed_stop":
        _obj(value, {"protocolVersion", "kind", "stopKind", "context", "terminal"})
        _one(value["stopKind"], {"qa_failure", "automation_stop"})
    else:
        raise InvalidWire("Unknown response kind")
    stage = _context(value["context"], request_ref)
    terminal = _obj(value["terminal"], {"phase", "status"}, {"reason"})
    _one(terminal["phase"], {"interpretation", "exploration", "locator", "execution"})
    _one(terminal["status"], STATUSES)
    if "reason" in terminal:
        _one(terminal["reason"], REASONS)
    if kind == "success":
        if stage != "replayed" or terminal["phase"] != "execution" or terminal["status"] not in {
            "OPERATION_SUCCEEDED", "QA_ASSERTION_PASSED",
        }:
            raise InvalidWire("Invalid success")
        return value, 0
    qa = terminal["status"] == "QA_ASSERTION_FAILED"
    if (value["stopKind"] == "qa_failure") != qa or terminal["status"] in {
        "OPERATION_SUCCEEDED", "QA_ASSERTION_PASSED",
    } or (qa and (stage != "replayed" or terminal["phase"] != "execution")):
        raise InvalidWire("Invalid typed stop")
    return value, 1 if qa else 2

"""Shared closed v2 host/result fixtures for retained workflows."""

from __future__ import annotations

import json

from playwright_demo.protocol_v2 import parse_response

REF = {"id": "approved", "version": "1"}
FP = "a" * 64


def result(status="EXPLORATION_UNRESOLVED", reason="TARGET_NOT_FOUND", *,
           trace=False, compiled=False, runs=0, cleanup="verified"):
    stages = {
        "EXPLORATION_UNRESOLVED": "exploration", "EXPLORATION_UNSUPPORTED": "exploration",
        "COMPILATION_FAILED": "compilation", "COMPILATION_UNSUPPORTED": "compilation",
        "REPLAY_BINDING_FAILED": "replay", "REPLAY_WAIT_FAILED": "replay",
        "REPLAY_EXECUTION_FAILED": "replay", "REPRODUCIBILITY_FAILED": "reproducibility",
        "QA_ASSERTION_PASSED": "qa", "QA_ASSERTION_FAILED": "qa",
        "ENVIRONMENT_FAILED": "environment", "CANCELLED": "cancellation",
    }
    stage = stages[status]
    value = {"resultVersion": "2", "workflowVersion": "semantic-general-v1",
             "testSpecId": "testone", "executionProfileRef": REF,
             "profileFingerprint": FP, "presentationMode": "headless",
             "observation": "no_intervention", "executionRunIds": ["runone", "runtwo"][:runs],
             "terminal": {"stage": stage, "status": status}, "cleanup": cleanup}
    if reason: value["terminal"]["reason"] = reason
    if stage != "interpretation": value["explorationAttemptId"] = "attemptone"
    if trace or compiled or runs: value["successfulTraceId"] = "traceone"
    if compiled or runs: value["compilerAttemptId"] = "compilerone"
    if runs: value["resolvedSpecId"] = "resolvedone"
    return value


def envelope(record, report="unavailable"):
    p = {"stage": "not_started"}
    if "explorationAttemptId" in record:
        p = {"stage": "exploration", "explorationAttemptId": record["explorationAttemptId"]}
    if "successfulTraceId" in record:
        p = {"stage": "compilation", "explorationAttemptId": record["explorationAttemptId"],
             "successfulTraceId": record["successfulTraceId"]}
        if "compilerAttemptId" in record: p["compilerAttemptId"] = record["compilerAttemptId"]
    if "resolvedSpecId" in record:
        p = {"stage": "replay", "explorationAttemptId": record["explorationAttemptId"],
             "successfulTraceId": record["successfulTraceId"], "compilerAttemptId": record["compilerAttemptId"],
             "resolvedSpecId": record["resolvedSpecId"], "executionRunIds": record["executionRunIds"]}
    context = {"result": record, "progress": p, "report": {"kind": report}}
    if report == "available": context["report"]["testSpecId"] = record["testSpecId"]
    stage = record["terminal"]["stage"]
    if record["terminal"]["status"] == "QA_ASSERTION_PASSED":
        return {"protocolVersion": "2", "kind": "success", "context": context}
    stop = {"qa": "qa_failure", "environment": "environment_stop", "cancellation": "cancelled",
            "reproducibility": "reproducibility_stop"}.get(stage, "automation_stop")
    return {"protocolVersion": "2", "kind": "typed_stop", "stopKind": stop, "context": context}


def parse(value):
    return parse_response(json.dumps(value).encode(), REF)


def render_result(final):
    from playwright_demo.ui_shell import render_shell
    render_shell(lambda _: final)

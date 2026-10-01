"""Closed serialization checks for deferred results; Node retains runtime authority."""

from .protocol import InvalidWire, _FP, _id, _obj, _one


def _digest(value):
    if type(value) is not str or not _FP.fullmatch(value):
        raise InvalidWire("Invalid deferred digest")


def validate_deferred_linkage(record):
    _obj(record["terminal"], {"stage", "status"}, {"reason"})
    replay, stage = record.get("deferredReplay"), record.get("deferredStage")
    if (replay is None) == (stage is None):
        raise InvalidWire("Deferred result requires one linkage")
    if replay is not None:
        versions = {"orchestrationVersion": "1", "sourceSchemaVersion": "6", "sourceContractVersion": "2",
                    "traceVersion": "5", "compilerVersion": "4", "resolvedSchemaVersion": "9", "runnerVersion": "9"}
        digests = {"sourceDigest", "admissionDigest", "traceDigest", "compilerDigest", "resolvedDigest", "orchestrationDigest"}
        _obj(replay, set(versions) | digests | {"orchestrationId", "executionSessionIds", "runDigests"})
        if any(replay[k] != v for k, v in versions.items()):
            raise InvalidWire("Deferred version mismatch")
        _id(replay["orchestrationId"])
        for key in digests: _digest(replay[key])
        sessions, hashes = replay["executionSessionIds"], replay["runDigests"]
        if type(sessions) is not list or len(sessions) > 2 or type(hashes) is not list or len(hashes) != len(record["executionRunIds"]):
            raise InvalidWire("Invalid deferred run linkage")
        for value in sessions: _id(value)
        for value in hashes: _digest(value)
        if len(set(sessions)) != len(sessions): raise InvalidWire("Reused deferred session")
        if record["terminal"]["stage"] in {"qa", "reproducibility", "execution"} and len(sessions) != 2:
            raise InvalidWire("Agreement requires fresh sessions")
    else:
        validate_deferred_stage(stage, record)
    if record["terminal"].get("status") == "EXECUTION_REPRODUCED":
        _obj(record["terminal"], {"stage", "status", "reason"})
        if record["terminal"] != {"stage": "execution", "status": "EXECUTION_REPRODUCED", "reason": "NO_ASSERTIONS"} or replay is None or len(record["executionRunIds"]) != 2 or record["cleanup"] != "verified" or not record.get("resolvedSpecId"):
            raise InvalidWire("Unproved assertion-free execution")


def validate_deferred_stage(stage, record):
    from .deferred_stage_codes import STAGE_CODES
    _obj(stage, {"integrationVersion", "sourceSchemaVersion", "sourceContractVersion", "stage", "category", "code", "sourceDigest"},
         {"admissionDigest", "traceDigest"})
    if (stage["integrationVersion"], stage["sourceSchemaVersion"], stage["sourceContractVersion"]) != ("1", "6", "2"):
        raise InvalidWire("Deferred stage version mismatch")
    _one(stage["stage"], {"interpretation", "grounding", "trace", "compilation", "environment", "cancellation"})
    _one(stage["category"], {"structural", "semantic_disagreement", "omission_fidelity", "unresolved", "authored_ambiguity", "unsupported_operation", "unsupported_constraint", "unsupported", "provider_environment", "provider", "environment", "integrity", "persistence", "cancelled"})
    _one(stage["code"], STAGE_CODES)
    for key in ("sourceDigest", "admissionDigest", "traceDigest"):
        if key in stage: _digest(stage[key])
    if record["executionRunIds"] or record.get("resolvedSpecId") or record["terminal"]["stage"] not in {"interpretation", "exploration", "compilation", "environment", "cancellation"}:
        raise InvalidWire("Early stop contains replay authority")
    if stage["stage"] in {"grounding", "trace", "compilation"} and (not stage.get("admissionDigest") or not record.get("explorationAttemptId")):
        raise InvalidWire("Missing admitted grounding linkage")
    if stage["stage"] == "compilation" and (not stage.get("traceDigest") or not record.get("successfulTraceId")):
        raise InvalidWire("Missing compilation trace linkage")
    if bool(record.get("successfulTraceId")) != bool(stage.get("traceDigest")) or record.get("explorationAttemptId") and not stage.get("admissionDigest"):
        raise InvalidWire("Broken deferred stage linkage")
    if stage["stage"] == "interpretation" and any(stage.get(k) for k in ("admissionDigest", "traceDigest")) or stage["stage"] == "interpretation" and any(record.get(k) for k in ("explorationAttemptId", "compilerAttemptId")):
        raise InvalidWire("Interpretation stop claims downstream authority")


def validate_projection(item, envelope):
    from .protocol_v2 import parse_response
    import json
    _obj(item, {"reportProjectionVersion", "workflowVersion", "kind", "result", "replays", "reproducibility"}, {"authoritativeQa"})
    if item["reportProjectionVersion"] != "2" or item["workflowVersion"] != "deferred-action-v1" or item["kind"] != "available": raise InvalidWire("Wrong deferred projection")
    record = envelope["context"]["result"]
    parse_response(json.dumps(envelope).encode(), record["executionProfileRef"])
    if item["result"] != record or envelope["context"]["report"]["kind"] != "available" or not record.get("deferredReplay"):
        raise InvalidWire("Deferred projection correlation mismatch")
    replays = item["replays"]
    if type(replays) is not list or len(replays) != len(record["executionRunIds"]): raise InvalidWire("Invalid deferred replays")
    for index, run in enumerate(replays):
        _obj(run, {"executionRunId", "state", "assertionCount", "cleanup"})
        if run["executionRunId"] != record["executionRunIds"][index]: raise InvalidWire("Replay mismatch")
        _one(run["state"], {"completed_true", "completed_false", "completed_execution", "non_qa_stop"})
        _one(run["cleanup"], {"verified", "unverified"})
        if type(run["assertionCount"]) is not int or not 0 <= run["assertionCount"] <= 100: raise InvalidWire("Invalid assertion count")
    agreement, stage = item["reproducibility"], record["terminal"]["stage"]
    _one(agreement, {"agreed", "disagreed", "not_established"})
    if (agreement == "disagreed") != (stage == "reproducibility") or agreement == "agreed" and stage not in {"qa", "execution"}:
        raise InvalidWire("Agreement contradiction")
    if (stage == "qa") != ("authoritativeQa" in item): raise InvalidWire("QA contradiction")
    if stage == "qa":
        status = record["terminal"]["status"]
        expected = "completed_true" if status == "QA_ASSERTION_PASSED" else "completed_false"
        if item["authoritativeQa"] != status or agreement != "agreed" or len(replays) != 2 or any(r["cleanup"] != "verified" or not r["assertionCount"] or r["state"] != expected for r in replays):
            raise InvalidWire("QA projection mismatch")
    if stage == "execution" and (agreement != "agreed" or len(replays) != 2 or any(r["state"] != "completed_execution" or r["assertionCount"] != 0 or r["cleanup"] != "verified" for r in replays)):
        raise InvalidWire("Execution projection mismatch")
    return item

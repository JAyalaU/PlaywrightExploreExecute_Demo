"""Closed v2 fixture process for Python host supervision tests."""

import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
from tests.python.v2_fixtures import envelope, result  # noqa: E402

mode = os.environ["HOST_MOCK_MODE"]
request = json.loads(sys.stdin.buffer.read())
ref = request["request"]["executionProfileRef"]


def semantic(status, reason=None, **options):
    record = result(status, reason, **options)
    record["executionProfileRef"] = ref
    if record.get("resolvedSpecId"):
        record["semanticReplay"] = {
            "sourceSchemaVersion": "7", "sourceContractVersion": "3",
            "groundingVersion": "semantic_capability_discovery_v1",
            "traceVersion": "semantic_grounded_trace_v1", "compilerVersion": "5",
            "resolvedSchemaVersion": "10", "runnerVersion": "10", "replayPairVersion": "2",
            "orchestrationId": "pairone", "traceDigest": "a" * 64,
            "resolvedDigest": "b" * 64, "pairDigest": "c" * 64,
            "executionSessionIds": ["sessionone", "sessiontwo"][:len(record["executionRunIds"])],
            "runDigests": ["d" * 64, "e" * 64][:len(record["executionRunIds"])],
        }
    return envelope(record)


success = semantic("QA_ASSERTION_PASSED", trace=True, compiled=True, runs=2)
qa = semantic("QA_ASSERTION_FAILED", "URL_MISMATCH", trace=True, compiled=True, runs=2)
automation = semantic("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND")

if mode == "sleep":
    time.sleep(30)
elif mode == "pressure":
    sys.stderr.buffer.write(b"x" * 100_000)
    sys.stderr.buffer.flush()
    sys.stdout.buffer.write(b"y" * 100_000)
    sys.stdout.buffer.flush()
elif mode == "missing":
    pass
elif mode == "malformed":
    sys.stdout.write("{bad")
elif mode == "multiple":
    sys.stdout.write(json.dumps(success) + "\n" + json.dumps(success))
elif mode == "wrong_version":
    sys.stdout.write(json.dumps({**success, "protocolVersion": "1"}))
elif mode == "wrong_exit":
    sys.stdout.write(json.dumps(success))
    sys.exit(1)
elif mode == "provider_diagnostic":
    stopped = semantic("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND")
    stopped["context"]["result"]["terminal"] = {
        "stage": "environment", "status": "ENVIRONMENT_FAILED", "reason": "PROVIDER_ERROR"}
    stopped["stopKind"] = "environment_stop"
    del stopped["context"]["result"]["explorationAttemptId"]
    stopped["context"]["progress"] = {"stage": "not_started"}
    diagnostic = {"kind": "provider_failure",
                  "callId": "3e8df696-8909-41ef-8791-36c239056109",
                  "stage": "interpretation", "code": "PROVIDER_ERROR",
                  "source": "http_status", "httpStatus": 429, "elapsedMs": 81}
    sys.stderr.write("PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC=" + json.dumps(diagnostic) + "\n")
    sys.stdout.write(json.dumps(stopped))
    sys.exit(2)
else:
    response = success if mode == "success" else qa if mode == "qa" else automation
    sys.stdout.write(json.dumps(response))
    sys.exit(0 if mode == "success" else 1 if mode == "qa" else 2)

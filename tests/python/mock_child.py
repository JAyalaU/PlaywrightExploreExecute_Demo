"""Fixture process for P2-3C supervision tests; never used by production."""

import json
import os
import sys
import time

mode = os.environ["HOST_MOCK_MODE"]
raw = sys.stdin.buffer.read()
request = json.loads(raw)
ref = request["request"]["executionProfileRef"]
context = {
    "testSpecId": "local-1",
    "executionProfileRef": ref,
    "profileFingerprint": "a" * 64,
    "presentationMode": "headless",
    "observation": {"state": "no_intervention", "autonomousEligible": True, "eventIds": []},
    "progress": {
        "stage": "replayed", "explorationAttemptId": "attempt-1",
        "resolvedSpecId": "resolved-1", "executionRunIds": ["run-1", "run-2"],
    },
    "report": {"kind": "available", "testSpecId": "local-1"},
}
success = {"protocolVersion": "1", "kind": "success", "context": context,
           "terminal": {"phase": "execution", "status": "QA_ASSERTION_PASSED"}}
qa = {"protocolVersion": "1", "kind": "typed_stop", "stopKind": "qa_failure",
      "context": context,
      "terminal": {"phase": "execution", "status": "QA_ASSERTION_FAILED", "reason": "NO_MATCH"}}
automation = {"protocolVersion": "1", "kind": "typed_stop", "stopKind": "automation_stop",
              "context": context,
              "terminal": {"phase": "execution", "status": "LOCATOR_BINDING_FAILED", "reason": "NO_MATCH"}}

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
    sys.stdout.write(json.dumps({**success, "protocolVersion": "2"}))
elif mode == "wrong_exit":
    sys.stdout.write(json.dumps(success))
    sys.exit(1)
elif mode == "provider_diagnostic":
    stopped = {"protocolVersion": "1", "kind": "typed_stop", "stopKind": "automation_stop",
               "context": {**context, "progress": {"stage": "not_started"},
                           "report": {"kind": "unavailable"}},
               "terminal": {"phase": "interpretation", "status": "INTERPRETATION_FAILED",
                            "reason": "PROVIDER_ERROR"}}
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

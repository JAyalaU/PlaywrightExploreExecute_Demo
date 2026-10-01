"""Opt-in protected WP1-WP3 proof for the original Status Codes workflow."""

from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys_path = str(ROOT / "src")
import sys
if sys_path not in sys.path:
    sys.path.insert(0, sys_path)

from playwright_demo import call_node, call_report_projection  # noqa: E402
from playwright_demo.live_events import LiveEventBuffer  # noqa: E402

ENTRY = ROOT / "dist" / "subprocess" / "cli.js"
REPORT_PROJECTION = ROOT / "dist" / "subprocess" / "report-projection-cli.js"
PROOF_READER = ROOT / "scripts" / "read-semantic-locator-status-codes-proof.mjs"
TARGET = "https://the-internet.herokuapp.com/"
TASK = (
    "Go to https://the-internet.herokuapp.com/. Locate the link that says Status Codes and click it. "
    "Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes. "
    "Locate the link with text 200 and click it. "
    "Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes/200. "
    "Locate the here link in the sentence ending with go here and click it. "
    "Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes."
)
HEADLESS_CONFIG_ENV = "SEMANTIC_LOCATOR_STATUS_CODES_HEADLESS_CONFIG"


@unittest.skipUnless(os.environ.get("SEMANTIC_LOCATOR_STATUS_CODES_LIVE") == "1",
                     "Set SEMANTIC_LOCATOR_STATUS_CODES_LIVE=1 for the protected Status Codes provider gate")
class SemanticLocatorStatusCodesLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not all(path.is_file() for path in (ENTRY, REPORT_PROJECTION, PROOF_READER)):
            raise unittest.SkipTest("Run npm run build before the Status Codes provider gate")

    def test_protected_m7_projection_and_two_fresh_replays(self) -> None:
        config_path = os.environ.get(HEADLESS_CONFIG_ENV)
        self.assertTrue(config_path, f"Set {HEADLESS_CONFIG_ENV} to the freshly approved headless config")
        config_file = Path(config_path).resolve()
        self.assertTrue(config_file.is_file(), "The fresh headless approval config is missing")
        config = json.loads(config_file.read_text(encoding="utf-8"))

        approval = config["publicTargetApproval"]
        self.assertEqual(approval["targetUrl"], TARGET)
        profile_ref = approval["executionProfileRef"]
        profile = next((item for item in config["profiles"] if
                        item["id"] == profile_ref["id"] and item["version"] == profile_ref["version"]), None)
        self.assertIsNotNone(profile, "The approved profile is missing")
        self.assertEqual(profile["presentationMode"], "headless")
        policy_ref = profile["networkPolicyRef"]
        policy = next((item for item in config["networkPolicies"] if
                       item["id"] == policy_ref["id"] and item["version"] == policy_ref["version"]), None)
        self.assertIsNotNone(policy, "The approved network policy is missing")
        self.assertEqual(len(policy["destinations"]), 1)
        destination = policy["destinations"][0]
        self.assertEqual(destination["host"], "the-internet.herokuapp.com")
        self.assertEqual(destination["ports"], [443])
        self.assertTrue(destination["addresses"])

        request = {"protocolVersion": "1", "request": {
            "taskText": TASK,
            "targetUrl": TARGET,
            "executionProfileRef": profile_ref,
        }}
        events = LiveEventBuffer()
        outcome = call_node(request, node_entry=ENTRY, config_path=config_file,
                            deadline_ms=600_000, live_events=events).outcome
        self.assertEqual(outcome.get("kind"), "success", outcome)
        context = outcome["context"]
        self.assertEqual(context["executionProfileRef"], profile_ref)
        self.assertEqual(context["presentationMode"], "headless")
        self.assertEqual(context["observation"], {
            "state": "no_intervention", "autonomousEligible": True, "eventIds": [],
        })
        self.assertEqual(context["progress"]["stage"], "replayed")
        self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
        run_ids = context["progress"]["executionRunIds"]
        self.assertEqual(len(run_ids), 2)
        self.assertEqual(len(set(run_ids)), 2)
        self.assertEqual(context["report"], {"kind": "available", "testSpecId": context["testSpecId"]})

        state, omitted, live = events.snapshot()
        self.assertEqual(state, "live")
        self.assertEqual(omitted, 0)
        self.assertEqual(sum(event["kind"] == "step_decision_finished" for event in live),
                         sum(event["kind"] == "step_decision_started" for event in live))
        self.assertFalse(any(event["kind"] == "m7_decision_diagnostic" for event in live))
        self.assertFalse(any("developer-diagnostics" in json.dumps(event) or
                             "snapshotDigest" in json.dumps(event) for event in live))

        projection = call_report_projection(
            outcome, node_entry=REPORT_PROJECTION, config_path=config_file, deadline_ms=30_000,
        ).outcome
        self.assertEqual(projection.get("kind"), "available", projection)
        projection_json = json.dumps(projection)
        for private in ("developer-diagnostics", "snapshotDigest", "mcpGeneratedExpression",
                        "rawProviderOutput", "reasoning", "locatorExpression"):
            self.assertNotIn(private, projection_json)

        proof = subprocess.run(
            ["node", str(PROOF_READER), "--artifact-root", config["artifactRoot"],
             "--test-spec-id", context["testSpecId"],
             "--attempt-id", context["progress"]["explorationAttemptId"],
             "--resolved-spec-id", context["progress"]["resolvedSpecId"]],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(proof.returncode, 0, "Node-owned Status Codes proof reconstruction failed")
        safe = json.loads(proof.stdout)
        self.assertTrue(safe["sourceTaskMatches"])
        self.assertTrue(safe["completeResolvedSpec"])
        self.assertTrue(safe["expectedUrlSequenceMatches"])
        self.assertTrue(safe["step4SameNodeProjectionPreservesProvenance"])
        self.assertTrue(safe["step6HereClickHasAcceptedDeclarativeLocator"])
        self.assertTrue(safe["m7ProjectionDiagnosticPresent"])
        self.assertTrue(safe["m7DiagnosticFieldsClosed"])
        self.assertTrue(safe["diagnosticsPrivateFromStakeholderReport"])
        self.assertEqual(safe["m7DiagnosticCount"],
                         sum(event["kind"] == "step_decision_finished" for event in live))

        print("SEMANTIC_LOCATOR_STATUS_CODES_SAFE_EVIDENCE=" + json.dumps({
            "target": TARGET,
            "profile": profile_ref,
            "profileFingerprint": context["profileFingerprint"],
            "testSpecId": context["testSpecId"],
            "explorationAttemptId": context["progress"]["explorationAttemptId"],
            "resolvedSpecId": context["progress"]["resolvedSpecId"],
            "executionRunIds": run_ids,
            "step4ProjectionAndRawProvenanceVerified": safe["step4SameNodeProjectionPreservesProvenance"],
            "step6AcceptedLocator": safe["step6HereClickHasAcceptedDeclarativeLocator"],
            "diagnosticCount": safe["m7DiagnosticCount"],
            "diagnosticProjectionBranchPresent": safe["m7ProjectionDiagnosticPresent"],
            "diagnosticFieldsClosed": safe["m7DiagnosticFieldsClosed"],
            "diagnosticsAbsentFromEventsAndStakeholderProjection": True,
            "terminalStatus": outcome["terminal"]["status"],
            "headlessAutonomousEligible": context["observation"]["autonomousEligible"],
        }, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()

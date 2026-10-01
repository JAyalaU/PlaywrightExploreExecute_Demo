"""Credentialed replacement public acceptance through the production path."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo import call_node  # noqa: E402

ENTRY = ROOT / "dist" / "subprocess" / "cli.js"
REPORT_READER = ROOT / "dist" / "subprocess" / "public-web-live-report-reader.js"
CONFIG = ROOT / "config" / "public-challenging-dom.json"
PROFILE = {"id": "challenging-dom-public-headless", "version": "1"}
TARGET = "https://the-internet.herokuapp.com/challenging_dom"
TASK = (
    f"Go to {TARGET}. In the table row containing Iuvaret1, select the edit link. "
    f"Confirm that the URL is exactly {TARGET}#edit."
)
FINGERPRINT = "d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42"


@unittest.skipUnless(os.environ.get("PUBLIC_WEB_LIVE") == "1",
                     "Set PUBLIC_WEB_LIVE=1 for the credentialed public acceptance proof")
class PublicWebLiveAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not ENTRY.exists() or not REPORT_READER.exists():
            raise unittest.SkipTest("Run npm run build before the public live acceptance test")

    def test_real_provider_mcp_and_two_fresh_replays(self) -> None:
        self.assertTrue(os.environ.get("OPENAI_API_KEY"),
                        "OPENAI_API_KEY must be available to the trusted Node provider process")
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        self.assertEqual(config["profiles"][0]["id"], PROFILE["id"])
        self.assertEqual(config["profiles"][0]["version"], PROFILE["version"])
        self.assertEqual(config["networkPolicies"][0]["id"], "challenging-dom-public-egress")
        self.assertEqual(config["networkPolicies"][0]["version"], "1")
        self.assertEqual(config["publicTargetApproval"]["targetUrl"], TARGET)
        self.assertEqual(config["publicTargetApproval"]["profileFingerprint"], FINGERPRINT)

        request = {"protocolVersion": "1", "request": {
            "taskText": TASK,
            "targetUrl": TARGET,
            "executionProfileRef": PROFILE,
        }}
        result = call_node(request, node_entry=ENTRY, config_path=CONFIG,
                           deadline_ms=600_000)
        outcome = result.outcome
        self.assertEqual(outcome.get("kind"), "success", outcome)
        context = outcome["context"]
        self.assertEqual(context["executionProfileRef"], PROFILE)
        self.assertEqual(context["profileFingerprint"], FINGERPRINT)
        self.assertEqual(context["presentationMode"], "headless")
        self.assertEqual(context["observation"], {
            "state": "no_intervention", "autonomousEligible": True, "eventIds": [],
        })
        self.assertEqual(context["progress"]["stage"], "replayed")
        self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
        run_ids = context["progress"]["executionRunIds"]
        self.assertEqual(len(run_ids), 2)
        self.assertEqual(len(set(run_ids)), 2)
        self.assertEqual(context["report"], {
            "kind": "available", "testSpecId": context["testSpecId"],
        })

        # Report reconstruction reads Node-owned artifacts with no provider key.
        report_environment = dict(os.environ)
        report_environment.pop("OPENAI_API_KEY", None)
        reconstructed = subprocess.run(
            ["node", str(REPORT_READER), "--artifact-root", config["artifactRoot"],
             "--test-spec-id", context["testSpecId"], "--profile-fingerprint", FINGERPRINT],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            env=report_environment,
        )
        self.assertEqual(reconstructed.returncode, 0, "Node-owned report reconstruction failed")
        report = json.loads(reconstructed.stdout)
        self.assertTrue(report["taskMatches"])
        self.assertTrue(report["targetMatches"])
        self.assertTrue(report["profileMatches"])
        self.assertTrue(report["semanticRowLocatorAccepted"])
        self.assertTrue(report["expectedUrlMatches"])
        self.assertEqual(report["explorationAttemptIds"],
                         [context["progress"]["explorationAttemptId"]])
        self.assertEqual(report["resolvedSpecIds"], [context["progress"]["resolvedSpecId"]])
        self.assertEqual({run["executionRunId"] for run in report["runResults"]}, set(run_ids))
        self.assertEqual(len(report["runResults"]), 2)
        self.assertTrue(all(run["profileFingerprint"] == FINGERPRINT and
                            run["clickSucceeded"] and run["urlAssertionPassed"]
                            for run in report["runResults"]))

        print("PUBLIC_WEB_LIVE_ACCEPTANCE_SAFE_EVIDENCE=" + json.dumps({
            "targetUrl": TARGET,
            "taskOutcome": "accepted",
            "profile": PROFILE,
            "profileFingerprint": FINGERPRINT,
            "model": "gpt-5.6-terra",
            "reasoningEffort": "medium",
            "testSpecId": context["testSpecId"],
            "explorationAttemptId": context["progress"]["explorationAttemptId"],
            "resolvedSpecId": context["progress"]["resolvedSpecId"],
            "semanticRowLocatorQuality": "accepted",
            "executionRunIds": run_ids,
            "assertion": {"type": "assert_url", "expected": TARGET + "#edit",
                          "passedInBothRuns": True},
            "terminalStatus": outcome["terminal"]["status"],
            "reportReconstructed": True,
        }, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()

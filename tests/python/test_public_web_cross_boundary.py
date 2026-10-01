"""Credential-free replacement-target workflow through Python and test Node entry."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo import call_node  # noqa: E402

HARNESS = ROOT / "dist" / "subprocess" / "test-harness.js"
REPORT_READER = ROOT / "dist" / "subprocess" / "test-report-reader.js"
CONFIG = ROOT / "config" / "public-challenging-dom.json"
PROFILE = {"id": "challenging-dom-public-headless", "version": "1"}
TARGET = "https://the-internet.herokuapp.com/challenging_dom"
TASK = (
    "Go to https://the-internet.herokuapp.com/challenging_dom. In the table row "
    "containing Iuvaret1, select the edit link. Confirm that the URL is exactly "
    "https://the-internet.herokuapp.com/challenging_dom#edit."
)
EXPECTED_FINGERPRINT = "d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42"


class ReplacementPublicCrossBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not HARNESS.exists() or not REPORT_READER.exists():
            raise unittest.SkipTest("Run npm run build before replacement cross-boundary test")

    def test_replacement_task_uses_approved_profile_through_python_mcp_and_two_replays(self):
        configuration = json.loads(CONFIG.read_text(encoding="utf-8"))
        self.assertEqual(configuration["profiles"][0]["id"], PROFILE["id"])
        self.assertEqual(configuration["profiles"][0]["version"], PROFILE["version"])
        self.assertEqual(configuration["networkPolicies"][0]["id"], "challenging-dom-public-egress")
        self.assertEqual(configuration["networkPolicies"][0]["version"], "1")
        self.assertEqual(configuration["publicTargetApproval"]["targetUrl"], TARGET)
        self.assertEqual(configuration["publicTargetApproval"]["profileFingerprint"], EXPECTED_FINGERPRINT)

        request = {"protocolVersion": "1", "request": {
            "taskText": TASK,
            "targetUrl": TARGET,
            "executionProfileRef": PROFILE,
        }}
        with tempfile.TemporaryDirectory(prefix="qa-public-cross-boundary-") as temporary:
            artifact_root = Path(temporary) / "artifacts"
            configuration["artifactRoot"] = str(artifact_root)
            config_path = Path(temporary) / "trusted.json"
            config_path.write_text(json.dumps(configuration), encoding="utf-8")

            environment = dict(os.environ)
            environment.pop("OPENAI_API_KEY", None)
            result = call_node(
                request,
                node_entry=HARNESS,
                config_path=config_path,
                deadline_ms=180_000,
                environment=environment,
            )
            outcome = result.outcome
            self.assertEqual(outcome["kind"], "success", outcome)
            context = outcome["context"]
            self.assertEqual(context["executionProfileRef"], PROFILE)
            self.assertEqual(context["profileFingerprint"], EXPECTED_FINGERPRINT)
            self.assertEqual(context["presentationMode"], "headless")
            self.assertEqual(context["progress"]["stage"], "replayed")
            self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            run_ids = context["progress"]["executionRunIds"]
            self.assertEqual(len(run_ids), 2)
            self.assertEqual(len(set(run_ids)), 2)
            self.assertEqual(context["report"], {
                "kind": "available", "testSpecId": context["testSpecId"],
            })

            reconstructed = subprocess.run(
                ["node", str(REPORT_READER), "--artifact-root", str(artifact_root),
                 "--test-spec-id", context["testSpecId"]],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
                env=environment,
            )
            self.assertEqual(reconstructed.returncode, 0, reconstructed.stderr)
            report = json.loads(reconstructed.stdout)
            self.assertEqual(report["testSpecId"], context["testSpecId"])
            self.assertEqual(report["profileFingerprint"], EXPECTED_FINGERPRINT)
            self.assertEqual(len(report["explorationAttemptIds"]), 1)
            self.assertEqual(report["resolvedSpecIds"], [context["progress"]["resolvedSpecId"]])
            self.assertEqual(set(report["executionRunIds"]), set(run_ids))

            print("PUBLIC_WEB_CROSS_BOUNDARY_SAFE_EVIDENCE=" + json.dumps({
                "profile": PROFILE,
                "profileFingerprint": EXPECTED_FINGERPRINT,
                "testSpecId": context["testSpecId"],
                "explorationAttemptId": report["explorationAttemptIds"][0],
                "resolvedSpecId": context["progress"]["resolvedSpecId"],
                "executionRunIds": run_ids,
                "terminalStatus": outcome["terminal"]["status"],
                "reportReconstructed": True,
            }, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()

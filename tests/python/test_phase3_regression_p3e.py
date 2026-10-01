"""P3-E composition proof: Streamlit -> Python -> Node admission/engine/projection.

The engine child is the existing test-only injected-model harness. The admission
and report-projection exchanges use their real built Node entries, and browser
execution uses the approved isolated public profile.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import call_node  # noqa: E402

HARNESS = ROOT / "dist" / "subprocess" / "test-harness.js"
STREAMLIT_APP = ROOT / "src" / "playwright_demo" / "streamlit_app.py"
CONFIG_SOURCE = ROOT / "config" / "public-challenging-dom.json"
TARGET = "https://the-internet.herokuapp.com/challenging_dom"
TASK = (
    "Go to https://the-internet.herokuapp.com/challenging_dom. In the table row "
    "containing Iuvaret1, select the edit link. Confirm that the URL is exactly "
    "https://the-internet.herokuapp.com/challenging_dom#edit."
)
_CREATE_APPROVED_TEST_CONFIG = r"""
import { writeFile } from 'node:fs/promises';
import { inspectPublicUrl, approvePublicInspection } from './dist/profile/admission.js';
const [url, artifactRoot, output] = process.argv.slice(1);
const inspection = await inspectPublicUrl(url);
const bundle = await approvePublicInspection(inspection, inspection.canonicalUrl);
await writeFile(output, JSON.stringify({
  profiles: [bundle.profile], networkPolicies: [bundle.policy],
  publicTargetApproval: bundle.approval,
  evidencePolicy: { finalScreenshot: false, failureScreenshot: false,
    failureTrace: false, failureVideo: false, sensitiveBinaryApproved: false },
  artifactRoot, retentionDays: 7,
}), { flag: 'wx', mode: 0o600 });
"""


def _loopback_option_side_effect():
    import streamlit as st
    original = st.get_option
    return lambda name: "127.0.0.1" if name == "server.address" else original(name)


class Phase3RegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        entries = (
            HARNESS,
            ROOT / "dist" / "profile" / "admission-cli.js",
            ROOT / "dist" / "subprocess" / "report-projection-cli.js",
        )
        if not all(path.is_file() for path in entries):
            raise unittest.SkipTest("Run npm run build before P3-E composition tests")

    @unittest.skipUnless(os.environ.get("PUBLIC_BROWSER_P3E_RUNTIME") == "1",
                         "Opt-in protected-browser composition proof")
    def test_streamlit_to_node_admission_injected_engine_and_projection(self):
        with tempfile.TemporaryDirectory(prefix="p3e-ui-artifacts-") as temporary:
            root = Path(temporary)
            artifact_root = root / "artifacts"
            trusted_config = root / "trusted.json"
            # This disposable approval is a test fixture. Product approval
            # still requires the interactive operator command documented for A.
            approved = subprocess.run(
                ["node", "--input-type=module", "-e", _CREATE_APPROVED_TEST_CONFIG,
                 TARGET, str(artifact_root), str(trusted_config)],
                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(approved.returncode, 0, approved.stderr)
            configuration = json.loads(trusted_config.read_text(encoding="utf-8"))
            self.assertEqual(configuration["publicTargetApproval"]["targetUrl"], TARGET)
            profile_ref = configuration["publicTargetApproval"]["executionProfileRef"]
            fingerprint = configuration["publicTargetApproval"]["profileFingerprint"]

            # Preserve normal process variables required to launch Node, while
            # proving this offline path does not depend on an operator key.
            safe_environment = dict(os.environ)
            safe_environment.pop("OPENAI_API_KEY", None)
            safe_environment["PLAYWRIGHT_DEMO_TRUSTED_CONFIG"] = str(trusted_config)

            def injected_engine(request, **kwargs):
                self.assertEqual(set(request), {"protocolVersion", "request"})
                self.assertEqual(request["protocolVersion"], "1")
                self.assertEqual(set(request["request"]), {
                    "taskText", "targetUrl", "executionProfileRef",
                })
                self.assertEqual(request["request"], {
                    "taskText": TASK, "targetUrl": TARGET,
                    "executionProfileRef": profile_ref,
                })
                kwargs["node_entry"] = HARNESS
                kwargs["environment"] = safe_environment
                return call_node(request, **kwargs)

            with patch.dict(os.environ, safe_environment, clear=True), \
                 patch("streamlit.get_option", side_effect=_loopback_option_side_effect()), \
                 patch("playwright_demo.ui_workflow.call_node", side_effect=injected_engine):
                app = AppTest.from_file(str(STREAMLIT_APP)).run()
                app.text_input[0].set_value(TARGET)
                app.text_area[0].set_value(TASK)
                app.button[0].click().run(timeout=180)

            self.assertFalse(app.exception)
            status = app.session_state.playwright_demo_ui_status
            self.assertEqual(status.phase, "completed", status)
            self.assertFalse(status.host_error, status)
            self.assertIsNotNone(status.result, status)
            result = status.result
            self.assertEqual(result.kind, "engine")
            outcome = result.outcome
            self.assertEqual(outcome["kind"], "success", outcome)
            self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            context = outcome["context"]
            self.assertEqual(context["executionProfileRef"], profile_ref)
            self.assertEqual(context["profileFingerprint"], fingerprint)
            self.assertEqual(context["progress"]["stage"], "replayed")
            run_ids = context["progress"]["executionRunIds"]
            self.assertEqual(len(run_ids), 2)
            self.assertEqual(len(set(run_ids)), 2)
            self.assertEqual(result.projection["kind"], "available")
            self.assertTrue(result.projection["outcomes"])
            self.assertEqual(result.projection["outcomes"][-1]["status"], "QA_ASSERTION_PASSED")
            self.assertFalse(result.projection_failed)

            rendered = " ".join(
                item.value for item in [*app.success, *app.markdown, *app.caption]
            )
            self.assertIn("QA_ASSERTION_PASSED", rendered)
            self.assertIn("assert_url", rendered)
            self.assertIn("Profile fingerprint", rendered)
            self.assertNotIn(str(artifact_root), rendered)
            self.assertNotIn("OPENAI_API_KEY", rendered)

            print("P3_E_SAFE_EVIDENCE=" + json.dumps({
                "profile": profile_ref,
                "profileFingerprint": context["profileFingerprint"],
                "testSpecId": context["testSpecId"],
                "explorationAttemptId": context["progress"]["explorationAttemptId"],
                "resolvedSpecId": context["progress"]["resolvedSpecId"],
                "executionRunIds": run_ids,
                "terminalStatus": outcome["terminal"]["status"],
                "reportProjection": result.projection["kind"],
                "providerCredentialUsed": False,
            }, separators=(",", ":")))

    def test_streamlit_denied_private_url_never_reaches_engine(self):
        with patch("streamlit.get_option", side_effect=_loopback_option_side_effect()), \
             patch.dict(os.environ, {"PLAYWRIGHT_DEMO_TRUSTED_CONFIG": str(CONFIG_SOURCE)}), \
             patch("playwright_demo.ui_workflow.call_node") as engine:
            app = AppTest.from_file(str(STREAMLIT_APP)).run()
            app.text_input[0].set_value("http://127.0.0.1/")
            app.text_area[0].set_value("Check the page.")
            app.button[0].click().run(timeout=10)
            # Trusted-config runs use the live UI's background host worker.
            # Wait for its bounded admission result before asserting the final
            # denial message; a synchronous AppTest rerun can race that worker.
            active = app.session_state["playwright_demo_active_run"]
            self.assertTrue(active.done.wait(timeout=10), "admission worker did not finish")
            app.run(timeout=10)
        self.assertFalse(app.exception)
        self.assertIn("This URL has no matching trusted public-target approval. No test started.",
                      [item.value for item in app.warning])
        engine.assert_not_called()


    def test_projection_subprocess_pipes_close_after_success_and_timeout(self):
        from playwright_demo.report_projection import call_report_projection
        real_popen = subprocess.Popen
        with tempfile.TemporaryDirectory(prefix="p3e-projection-child-") as temporary:
            root = Path(temporary)
            for mode in ("success", "timeout"):
                with self.subTest(mode=mode):
                    child = root / f"{mode}.py"
                    if mode == "success":
                        child.write_text(
                            "import sys; sys.stdin.read(); "
                            "sys.stdout.write('{\\\"reportProjectionVersion\\\":\\\"1\\\","
                            "\\\"kind\\\":\\\"unavailable\\\","
                            "\\\"reason\\\":\\\"REPORT_NOT_FOUND\\\"}\\n')",
                            encoding="utf-8",
                        )
                    else:
                        child.write_text(
                            "import sys, time; sys.stdin.read(); time.sleep(10)",
                            encoding="utf-8",
                        )
                    launched = []

                    def record_child(*args, **kwargs):
                        process = real_popen(*args, **kwargs)
                        command = args[0] if args else kwargs.get("args")
                        if isinstance(command, (list, tuple)) and str(child) in command:
                            launched.append(process)
                        return process

                    with patch("playwright_demo.report_projection.subprocess.Popen",
                               side_effect=record_child):
                        result = call_report_projection(
                            {**_minimal_projection_result()}, node_entry=child,
                            config_path="trusted-test-config", node_executable=sys.executable,
                            deadline_ms=3_000 if mode == "success" else 100,
                            environment=dict(os.environ),
                        )
                    self.assertEqual(len(launched), 1)
                    process = launched[0]
                    self.assertIsNotNone(process.stdin)
                    self.assertIsNotNone(process.stdout)
                    self.assertIsNotNone(process.stderr)
                    self.assertTrue(process.stdin.closed)
                    self.assertTrue(process.stdout.closed)
                    self.assertTrue(process.stderr.closed)
                    if mode == "success":
                        self.assertEqual(result.outcome["kind"], "unavailable")
                    else:
                        self.assertEqual(result.outcome["code"], "DEADLINE_EXCEEDED")
                        self.assertIsNotNone(process.returncode)


def _minimal_projection_result():
    return {
        "protocolVersion": "1", "kind": "success", "context": {
            "testSpecId": "testp3b", "executionProfileRef": {"id": "p3b", "version": "1"},
            "profileFingerprint": "a" * 64, "presentationMode": "headless",
            "observation": {"state": "no_intervention", "autonomousEligible": True,
                            "eventIds": []},
            "progress": {"stage": "replayed", "explorationAttemptId": "attemptp3b",
                         "resolvedSpecId": "resolvedp3b", "executionRunIds": ["runone", "runtwo"]},
            "report": {"kind": "available", "testSpecId": "testp3b"},
        }, "terminal": {"phase": "execution", "status": "QA_ASSERTION_PASSED"},
    }


if __name__ == "__main__":
    unittest.main()

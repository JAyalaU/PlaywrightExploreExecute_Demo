"""P4-2C credential-free release gate for protected live images.

The exact-profile browser cases are opt-in because they start Docker. They use
the P2-3D injected-model harness; they never need provider credentials.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.live_events import LiveEventBuffer  # noqa: E402
from playwright_demo.live_images import LiveImageBuffer, InvalidImage  # noqa: E402
from playwright_demo.host import call_node  # noqa: E402

HARNESS = ROOT / "dist" / "subprocess" / "test-harness.js"
STREAMLIT_APP = ROOT / "src" / "playwright_demo" / "streamlit_app.py"
RUNTIME_ENABLED = os.environ.get("PUBLIC_BROWSER_P4_2_RUNTIME") == "1"
CONFIG_SOURCE_TEXT = os.environ.get("PUBLIC_BROWSER_P4_2_CONFIG")
CONFIG_SOURCE = Path(CONFIG_SOURCE_TEXT) if CONFIG_SOURCE_TEXT else None
TARGET = "https://the-internet.herokuapp.com/challenging_dom"
TASK = (
    "Go to https://the-internet.herokuapp.com/challenging_dom. In the table row "
    "containing Iuvaret1, select the edit link. Confirm that the URL is exactly "
    "https://the-internet.herokuapp.com/challenging_dom#edit."
)
PROFILE = {"id": "challenging-dom-public-headless", "version": "1"}


def _loopback_option_side_effect():
    import streamlit as st
    original = st.get_option
    return lambda name: "127.0.0.1" if name == "server.address" else original(name)


class P4LiveImageReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not HARNESS.is_file():
            raise unittest.SkipTest("Run npm run build before P4-2C release tests")
        if RUNTIME_ENABLED and (CONFIG_SOURCE is None or not CONFIG_SOURCE.is_file()):
            raise RuntimeError("P4-2C runtime proof requires PUBLIC_BROWSER_P4_2_CONFIG")

    def _config(self, root: Path, *, approved: bool) -> tuple[Path, dict]:
        assert CONFIG_SOURCE is not None
        config = json.loads(CONFIG_SOURCE.read_text(encoding="utf-8"))
        approval = config["publicTargetApproval"]
        self.assertEqual(approval["targetUrl"], TARGET)
        self.assertEqual(approval["admissionVersion"], "1")
        self.assertEqual(approval["executionProfileRef"]["id"], "admitted-public-9d69d0992851e3253020d15f26a8ee530d6d6d551616366f0285f3be33e780e0")
        fingerprint = approval["profileFingerprint"]
        config["artifactRoot"] = str(root / "artifacts")
        config["liveImagePolicy"] = {
            "liveImagePolicyVersion": "1",
            "captureApproved": approved,
            "displayApproved": approved,
        }
        path = root / ("trusted-enabled.json" if approved else "trusted-disabled.json")
        path.write_text(json.dumps(config), encoding="utf-8")
        return path, {"profileRef": approval["executionProfileRef"], "fingerprint": fingerprint}

    def _run_ui(self, trusted_path: Path, *, cancel_after_first_frame: bool = False,
                inject_receiver_failure: bool = False):
        environment = dict(os.environ)
        environment.pop("OPENAI_API_KEY", None)
        environment["PLAYWRIGHT_DEMO_TRUSTED_CONFIG"] = str(trusted_path)

        def injected_engine(request, **kwargs):
            self.assertEqual(request["protocolVersion"], "1")
            self.assertEqual(request["request"]["targetUrl"], TARGET)
            self.assertNotIn("OPENAI_API_KEY", kwargs.get("environment", environment))
            kwargs["node_entry"] = HARNESS
            kwargs["environment"] = environment
            return call_node(request, **kwargs)

        with patch.dict(os.environ, environment, clear=True), \
             patch("streamlit.get_option", side_effect=_loopback_option_side_effect()), \
             patch("playwright_demo.ui_workflow.call_node", side_effect=injected_engine):
            app = AppTest.from_file(str(STREAMLIT_APP)).run()
            app.text_input[0].set_value(TARGET)
            app.text_area[0].set_value(TASK)
            app.button[0].click().run(timeout=10)
            active = app.session_state.playwright_demo_active_run
            if cancel_after_first_frame:
                deadline = time.monotonic() + 30
                while active.images._count < 1 and not active.done.is_set() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertGreaterEqual(active.images._count, 1,
                                        "No protected image arrived before cancellation")
                active.cancel.set()
            self.assertTrue(active.done.wait(180), "P4-2C protected workflow did not finish")
            for _ in range(4):
                app.run(timeout=10)
                if app.session_state.playwright_demo_ui_status.phase == "completed":
                    break
        self.assertFalse(app.exception)
        return app, active

    def _assert_no_residual_containers(self) -> None:
        docker = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=public-browser-g1-", "--format", "{{.Names}} {{.Status}}"],
            capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(docker.returncode, 0, docker.stderr)
        self.assertEqual(docker.stdout.strip(), "")

    @unittest.skipUnless(RUNTIME_ENABLED, "Opt-in exact-profile protected-browser image proof")
    def test_protected_ui_capture_on_off_preserves_two_replay_qa_and_disposal(self):
        """Normal and disabled image paths use the real protected browser."""
        with tempfile.TemporaryDirectory(prefix="p4-2c-artifacts-") as temporary:
            root = Path(temporary)
            enabled_path, authority = self._config(root, approved=True)
            enabled_app, enabled_run = self._run_ui(enabled_path)
            self.assertEqual(enabled_app.session_state.playwright_demo_ui_status.phase, "completed")
            enabled_result = enabled_app.session_state.playwright_demo_ui_status.result
            self.assertEqual(enabled_result.kind, "engine")
            outcome = enabled_result.outcome
            self.assertEqual(outcome["kind"], "success", outcome)
            self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            self.assertEqual(outcome["context"]["profileFingerprint"], authority["fingerprint"])
            run_ids = outcome["context"]["progress"]["executionRunIds"]
            self.assertEqual(len(run_ids), 2)
            self.assertEqual(len(set(run_ids)), 2)
            self.assertEqual(enabled_result.projection["kind"], "available")
            self.assertEqual(enabled_run.events.snapshot()[0], "live")
            self.assertEqual(enabled_run.events.snapshot()[2][-1]["kind"], "terminal")
            self.assertEqual(enabled_run.images.snapshot()[0], "available")
            self.assertGreaterEqual(enabled_run.images._count, 1)
            header, frame = enabled_run.images._frames[-1]
            self.assertEqual(header["liveImageVersion"], "1")
            self.assertEqual(header["profileFingerprint"], authority["fingerprint"])
            self.assertLessEqual(header["width"], 800)
            self.assertLessEqual(header["height"], 600)
            self.assertLessEqual(len(frame), 128 * 1024)
            self.assertLessEqual(enabled_run.images._count, 32)
            self.assertLessEqual(enabled_run.images._total_bytes, 4 * 1024 * 1024)
            subheaders = [item.value for item in enabled_app.subheader]
            self.assertIn("Live browser image", subheaders)
            self.assertEqual([event["data"].get("status") for event in enabled_run.events.snapshot()[2]
                              if event["kind"] == "replay_finished"],
                             ["QA_ASSERTION_PASSED", "QA_ASSERTION_PASSED"])

            # The host starts the 60s expiry at channel closure. Advance only
            # this buffer's monotonic timestamp; do not sleep or make the suite flaky.
            enabled_run.images._ended -= 61
            self.assertEqual(enabled_run.images.snapshot(), ("closed", None, None))
            enabled_run.images.clear()
            self.assertEqual(len(enabled_run.images._frames), 0)

            disabled_path, _ = self._config(root, approved=False)
            disabled_app, disabled_run = self._run_ui(disabled_path)
            disabled_result = disabled_app.session_state.playwright_demo_ui_status.result
            self.assertEqual(disabled_result.outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            self.assertEqual(disabled_run.images.snapshot(), ("capture_disabled", None, None))
            self.assertEqual(disabled_run.images._count, 0)
            self.assertEqual([event["data"].get("status") for event in disabled_run.events.snapshot()[2]
                              if event["kind"] == "replay_finished"],
                             ["QA_ASSERTION_PASSED", "QA_ASSERTION_PASSED"])
            self.assertIn("Live browser image", [item.value for item in disabled_app.subheader])
            self._assert_no_residual_containers()

            print("P4_2_SAFE_EVIDENCE=" + json.dumps({
                "profile": authority["profileRef"], "profileFingerprint": authority["fingerprint"],
                "captureEnabledFrames": enabled_run.images._count,
                "captureDisabledFrames": disabled_run.images._count,
                "captureEnabledQa": outcome["terminal"]["status"],
                "captureDisabledQa": disabled_result.outcome["terminal"]["status"],
                "runIdsPerReplay": 2, "enabledImageState": "available",
                "disabledImageState": "capture_disabled", "expiryState": "closed",
                "residualContainers": False,
            }, separators=(",", ":")))

    @unittest.skipUnless(RUNTIME_ENABLED, "Opt-in protected-browser cancellation/cleanup proof")
    def test_cancellation_after_protected_frame_clears_bytes_and_disposes_container(self):
        with tempfile.TemporaryDirectory(prefix="p4-2c-cancel-") as temporary:
            trusted_path, _authority = self._config(Path(temporary), approved=True)
            _app, active = self._run_ui(trusted_path, cancel_after_first_frame=True)
            result = active.result
            self.assertIsNotNone(result)
            self.assertEqual(result.outcome["kind"], "process_failure")
            self.assertEqual(result.outcome["code"], "CANCELLED")
            self.assertEqual(result.outcome["cleanup"], "unverified")
            self.assertFalse(result.outcome["forcedTermination"])
            # A graceful child exit still does not prove cleanup to the host.
            # The channel is unavailable on cancellation and held bytes clear.
            self.assertEqual(active.images.snapshot(), ("temporarily_unavailable", None, None))
            self.assertEqual(len(active.images._frames), 0)
            self._assert_no_residual_containers()

    @unittest.skipUnless(RUNTIME_ENABLED, "Opt-in protected-browser image-receiver failure proof")
    def test_receiver_failure_withholds_images_but_preserves_qa_and_cleans_container(self):
        """A Python receiver fault exercises the real channel after browser launch."""
        original_add = LiveImageBuffer.add

        def fail_after_validating(buffer, header, data):
            original_add(buffer, header, data)
            raise InvalidImage("controlled release-test receiver failure")

        with tempfile.TemporaryDirectory(prefix="p4-2c-receiver-failure-") as temporary, \
             patch.object(LiveImageBuffer, "add", fail_after_validating):
            trusted_path, authority = self._config(Path(temporary), approved=True)
            app, active = self._run_ui(trusted_path)
            result = app.session_state.playwright_demo_ui_status.result
            self.assertEqual(result.outcome["kind"], "success")
            self.assertEqual(result.outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            self.assertEqual(result.outcome["context"]["profileFingerprint"], authority["fingerprint"])
            self.assertEqual(len(result.outcome["context"]["progress"]["executionRunIds"]), 2)
            self.assertEqual(active.images.snapshot()[0], "temporarily_unavailable")
            self.assertEqual(len(active.images._frames), 0)
            self.assertEqual([event["data"].get("status") for event in active.events.snapshot()[2]
                              if event["kind"] == "replay_finished"],
                             ["QA_ASSERTION_PASSED", "QA_ASSERTION_PASSED"])
            self._assert_no_residual_containers()


if __name__ == "__main__":
    unittest.main()

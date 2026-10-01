"""Opt-in credential-free Python->Node->headed Docker lifecycle proof."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import call_node  # noqa: E402
from playwright_demo.live_events import LiveEventBuffer  # noqa: E402
from playwright_demo.live_viewer import LiveViewerBuffer  # noqa: E402

TASK = ("Go to https://the-internet.herokuapp.com/challenging_dom. In the table row "
        "containing Iuvaret1, select the edit link. Confirm that the URL is exactly "
        "https://the-internet.herokuapp.com/challenging_dom#edit.")
URL = "https://the-internet.herokuapp.com/challenging_dom"


@unittest.skipUnless(os.environ.get("PUBLIC_BROWSER_P4_3B_RUNTIME") == "1", "Opt-in headed Docker proof")
class HeadedViewerCrossProcessTests(unittest.TestCase):
    def _config(self, root):
        config = Path(root, "trusted.json")
        output = subprocess.check_output([
            "node", str(ROOT / "dist/subprocess/test-headed-config.js"),
            str(Path(root, "artifacts")),
        ], cwd=ROOT, timeout=10)
        config.write_bytes(output)
        return config, json.loads(output)["publicTargetApproval"]["executionProfileRef"]

    def test_three_protected_owners_transition_and_final_qa_is_observational(self):
        with tempfile.TemporaryDirectory(prefix="p4-3b-") as root:
            config, ref = self._config(root)
            events = LiveEventBuffer()
            viewer = LiveViewerBuffer(events)
            result = call_node({"protocolVersion": "1", "request": {
                "targetUrl": URL, "taskText": TASK, "executionProfileRef": ref,
            }}, node_entry=ROOT / "dist/subprocess/test-harness.js", config_path=config,
                deadline_ms=120_000, live_events=events, live_viewer=viewer)
            self.assertEqual(result.outcome["kind"], "success", result.outcome)
            self.assertEqual(result.outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            self.assertEqual(result.outcome["context"]["observation"]["state"], "observational")
            self.assertFalse(result.outcome["context"]["observation"]["autonomousEligible"])
            self.assertEqual(events.snapshot()[0], "live")
            history = viewer.history()
            owners = [(kind, owner) for notice, kind, owner in history if notice == "ready"]
            self.assertEqual([kind for kind, _ in owners], ["attempt", "run", "run"])
            self.assertEqual(len(set(owners)), 3)
            self.assertEqual(len([notice for notice, _, _ in history if notice == "closed"]), 3)
            self.assertEqual(viewer.snapshot(), ("closed", None))
            self.assertEqual(len(result.outcome["context"]["progress"]["executionRunIds"]), 2)

    def test_cancellation_after_viewer_ready_revokes_and_disposes(self):
        with tempfile.TemporaryDirectory(prefix="p4-3b-cancel-") as root:
            config, ref = self._config(root)
            events = LiveEventBuffer(); viewer = LiveViewerBuffer(events)
            cancel = threading.Event(); seen = threading.Event()

            def cancel_after_ready():
                until = time.monotonic() + 30
                while time.monotonic() < until:
                    if viewer.snapshot()[0] == "available":
                        seen.set(); cancel.set(); return
                    time.sleep(0.02)

            monitor = threading.Thread(target=cancel_after_ready, daemon=True); monitor.start()
            result = call_node({"protocolVersion": "1", "request": {
                "targetUrl": URL, "taskText": TASK, "executionProfileRef": ref,
            }}, node_entry=ROOT / "dist/subprocess/test-harness.js", config_path=config,
                deadline_ms=120_000, live_events=events, live_viewer=viewer,
                cancel_event=cancel)
            monitor.join(timeout=1)
            self.assertTrue(seen.is_set(), "Viewer never became available before cancellation")
            self.assertEqual(result.outcome["kind"], "process_failure")
            self.assertEqual(result.outcome["code"], "CANCELLED")
            self.assertEqual(result.outcome["cleanup"], "unverified")
            # The host may use its reviewed forced fallback if graceful cleanup
            # exceeds the bound. Either path must revoke viewing and leave no
            # protected container; the typed cleanup status remains unverified.
            self.assertNotEqual(viewer.snapshot()[0], "available")
            self.assertEqual(subprocess.check_output([
                "docker", "ps", "-a", "--filter", "name=public-browser-g1-",
                "--format", "{{.ID}}"], timeout=10).strip(), b"")


if __name__ == "__main__": unittest.main()

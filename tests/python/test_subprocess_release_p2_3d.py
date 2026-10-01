"""P2-3D: credential-free Python-to-Node release coverage plus an opt-in live proof."""

from __future__ import annotations

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo import call_node  # noqa: E402

HARNESS = ROOT / "dist" / "subprocess" / "test-harness.js"
PRODUCTION = ROOT / "dist" / "subprocess" / "cli.js"
REPORT_READER = ROOT / "dist" / "subprocess" / "test-report-reader.js"

TASK = "Select Admin from the Account menu.\nAssert the Selection status contains Admin selected."


class _Page(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = b"""
        <button aria-label='Account menu' onclick=\"document.getElementById('menu').hidden=false\">Menu</button>
        <div id='menu' role='menu' hidden>
          <button role='menuitem' onclick=\"document.getElementById('status').textContent='Admin selected'\">Admin</button>
        </div>
        <p id='status' role='status' aria-label='Selection status'>Waiting</p>
        """
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


class _Fixture:
    def __enter__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Page)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/"
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


def _config(root: Path, port: int) -> Path:
    profile = {
        "profileSchemaVersion": "2", "browser": "chromium",
        "viewport": {"width": 900, "height": 600}, "locale": "en-US",
        "timeoutPolicy": {"actionMs": 5000, "navigationMs": 5000, "waits": {"default": 3000}},
        "networkPolicyRef": {"id": "local-policy", "version": "1"},
    }
    configuration = {
        "profiles": [
            {**profile, "id": "headless", "version": "2", "presentationMode": "headless"},
            {**profile, "id": "headed", "version": "2", "presentationMode": "headed"},
        ],
        "networkPolicies": [{"id": "local-policy", "version": "1", "destinations": [{
            "host": "127.0.0.1", "ports": [port], "addresses": ["127.0.0.1"],
        }]}],
        "evidencePolicy": {"finalScreenshot": False, "failureScreenshot": False,
                           "failureTrace": False, "failureVideo": False,
                           "sensitiveBinaryApproved": False},
        "artifactRoot": str(root / "artifacts"), "retentionDays": 7,
    }
    path = root / "trusted.json"
    path.write_text(json.dumps(configuration), encoding="utf-8")
    return path


def _request(url: str, profile: str, task: str | None = None) -> dict[str, object]:
    return {"protocolVersion": "1", "request": {
        "taskText": task or TASK,
        "targetUrl": url,
        "executionProfileRef": {"id": profile, "version": "2"},
    }}


class SubprocessReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not HARNESS.exists() or not PRODUCTION.exists():
            raise unittest.SkipTest("Run npm run build before P2-3D subprocess tests")

    def _call(self, request: dict[str, object], config: Path, *, production: bool = False,
              deadline_ms: int = 60_000, cancel_event: threading.Event | None = None):
        return call_node(request, node_entry=PRODUCTION if production else HARNESS,
                         config_path=config, deadline_ms=deadline_ms, cancel_event=cancel_event,
                         environment={**os.environ, "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", "")})

    def _read_report(self, root: Path, test_spec_id: str) -> dict[str, object]:
        completed = subprocess.run(
            ["node", str(REPORT_READER), "--artifact-root", str(root / "artifacts"),
             "--test-spec-id", test_spec_id],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_offline_shared_adapter_proves_headless_qa_and_automation_outcomes(self):
        with tempfile.TemporaryDirectory(prefix="qa-p2-3d-") as temporary, _Fixture() as site:
            root = Path(temporary)
            config = _config(root, site.server.server_port)
            success = self._call(_request(site.url, "headless"), config).outcome
            self.assertEqual(success["kind"], "success")
            context = success["context"]
            self.assertEqual(context["presentationMode"], "headless")
            self.assertEqual(context["observation"], {
                "state": "no_intervention", "autonomousEligible": True, "eventIds": [],
            })
            self.assertEqual(context["progress"]["stage"], "replayed")
            self.assertEqual(len(set(context["progress"]["executionRunIds"])), 2)
            self.assertEqual(context["report"], {"kind": "available", "testSpecId": context["testSpecId"]})
            reconstructed = self._read_report(root, context["report"]["testSpecId"])
            self.assertEqual(reconstructed["testSpecId"], context["testSpecId"])
            self.assertEqual(reconstructed["profileFingerprint"], context["profileFingerprint"])
            self.assertEqual(reconstructed["explorationAttemptIds"], [context["progress"]["explorationAttemptId"]])
            self.assertEqual(reconstructed["resolvedSpecIds"], [context["progress"]["resolvedSpecId"]])
            self.assertEqual(set(reconstructed["executionRunIds"]), set(context["progress"]["executionRunIds"]))
            self.assertTrue(reconstructed["hasDiscoveredPrerequisite"])

            qa = self._call(_request(site.url, "headless",
                "Select Admin from the Account menu.\nAssert the Selection status contains Not selected."), config).outcome
            self.assertEqual((qa["kind"], qa["stopKind"], qa["terminal"]["status"]),
                             ("typed_stop", "qa_failure", "QA_ASSERTION_FAILED"))
            self.assertEqual(qa["context"]["progress"]["stage"], "replayed")

            automation = self._call(_request(site.url, "headless",
                f"Select Missing.\nAssert URL is {site.url}"), config).outcome
            self.assertEqual((automation["kind"], automation["stopKind"]),
                             ("typed_stop", "automation_stop"))
            self.assertEqual(automation["terminal"]["status"], "TARGET_RESOLUTION_FAILED")
            self.assertEqual(automation["context"]["progress"]["stage"], "exploration")

            ambiguous = self._call(_request(site.url, "headless", "Ambiguous task."), config).outcome
            self.assertEqual((ambiguous["kind"], ambiguous["stopKind"]),
                             ("typed_stop", "automation_stop"))
            self.assertEqual(ambiguous["terminal"], {
                "phase": "interpretation", "status": "AMBIGUOUS_INSTRUCTION",
                "reason": "MATERIAL_AMBIGUITY",
            })
            self.assertEqual(ambiguous["context"]["progress"], {"stage": "not_started"})
            self.assertEqual(ambiguous["context"]["report"], {"kind": "unavailable"})

    def test_offline_harness_preserves_headed_observation_and_process_cancellation(self):
        with tempfile.TemporaryDirectory(prefix="qa-p2-3d-") as temporary, _Fixture() as site:
            root = Path(temporary)
            config = _config(root, site.server.server_port)
            headed = self._call(_request(site.url, "headed"), config).outcome
            self.assertEqual(headed["kind"], "success")
            self.assertEqual(headed["context"]["presentationMode"], "headed")
            observation = headed["context"]["observation"]
            self.assertEqual(observation["state"], "observational")
            self.assertEqual(observation["inputProvenance"], "unverified")
            self.assertFalse(observation["autonomousEligible"])
            self.assertIsInstance(observation["eventIds"], list)

            cancelled = threading.Event()
            timer = threading.Timer(0.25, cancelled.set)
            timer.start()
            try:
                result = self._call(_request(site.url, "headless", "Wait forever."), config,
                                    deadline_ms=20_000, cancel_event=cancelled).outcome
            finally:
                timer.join()
            self.assertEqual((result["kind"], result["code"], result["cleanup"]),
                             ("process_failure", "CANCELLED", "unverified"))

    def test_protocol_and_production_boundaries_deny_untrusted_authority_before_provider_work(self):
        with tempfile.TemporaryDirectory(prefix="qa-p2-3d-") as temporary, _Fixture() as site:
            root = Path(temporary)
            config = _config(root, site.server.server_port)
            denied = self._call(_request("http://127.0.0.1:1/", "headless"), config).outcome
            self.assertEqual(denied, {"protocolVersion": "1", "kind": "bridge_error",
                                      "code": "DESTINATION_DENIED", "cleanup": "not_started"})
            missing = self._call(_request(site.url, "unknown"), config).outcome
            self.assertEqual(missing["code"], "PROFILE_UNAVAILABLE")
            invalid = {**_request(site.url, "headless"), "request": {
                **_request(site.url, "headless")["request"], "model": "injected",
            }}
            with self.assertRaises(ValueError):
                self._call(invalid, config)

            # The production child has no model-selection switch. This denied
            # destination proves its real-only path reaches Node policy before
            # any provider call, so the offline gate never needs credentials.
            production = self._call(_request("http://127.0.0.1:1/", "headless"), config,
                                    production=True).outcome
            self.assertEqual(production, {"protocolVersion": "1", "kind": "bridge_error",
                                          "code": "DESTINATION_DENIED", "cleanup": "not_started"})

    @unittest.skipUnless(os.environ.get("P2_3_LIVE") == "1", "Set P2_3_LIVE=1 for the credentialed production proof")
    def test_live_production_entry_runs_real_provider_through_python_host(self):
        self.assertTrue(os.environ.get("OPENAI_API_KEY"), "OPENAI_API_KEY is required when P2_3_LIVE=1")
        with tempfile.TemporaryDirectory(prefix="qa-p2-3d-live-") as temporary, _Fixture() as site:
            root = Path(temporary)
            config = _config(root, site.server.server_port)
            result = self._call(_request(site.url, "headless"), config, production=True,
                                deadline_ms=300_000).outcome
            self.assertEqual(result["kind"], "success")
            context = result["context"]
            self.assertEqual(context["observation"], {
                "state": "no_intervention", "autonomousEligible": True, "eventIds": [],
            })
            self.assertEqual(context["progress"]["stage"], "replayed")
            self.assertEqual(len(set(context["progress"]["executionRunIds"])), 2)
            self.assertEqual(context["report"], {
                "kind": "available", "testSpecId": context["testSpecId"],
            })
            reconstructed = self._read_report(root, context["report"]["testSpecId"])
            self.assertEqual(reconstructed["testSpecId"], context["testSpecId"])
            self.assertEqual(reconstructed["profileFingerprint"], context["profileFingerprint"])
            self.assertEqual(reconstructed["explorationAttemptIds"], [context["progress"]["explorationAttemptId"]])
            self.assertEqual(reconstructed["resolvedSpecIds"], [context["progress"]["resolvedSpecId"]])
            self.assertEqual(set(reconstructed["executionRunIds"]), set(context["progress"]["executionRunIds"]))
            self.assertTrue(reconstructed["hasDiscoveredPrerequisite"])
            print("P2_3_LIVE_SAFE_EVIDENCE=" + json.dumps({
                "testSpecId": context["testSpecId"],
                "profileFingerprint": context["profileFingerprint"],
                "explorationAttemptId": context["progress"]["explorationAttemptId"],
                "resolvedSpecId": context["progress"]["resolvedSpecId"],
                "executionRunIds": context["progress"]["executionRunIds"],
                "report": context["report"],
                "hasDiscoveredPrerequisite": reconstructed["hasDiscoveredPrerequisite"],
            }, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()

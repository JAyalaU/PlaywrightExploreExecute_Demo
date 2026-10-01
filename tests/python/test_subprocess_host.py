"""P2-3C focused Python process-boundary tests."""

import os
import json
from pathlib import Path
import sys
import threading
import time
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo import call_node  # noqa: E402
from playwright_demo.host import _provider_diagnostic  # noqa: E402

MOCK = Path(__file__).with_name("mock_child.py")
REQUEST = {
    "protocolVersion": "1",
    "request": {
        "taskText": "Select Save.",
        "targetUrl": "http://127.0.0.1:4173/",
        "executionProfileRef": {"id": "desktop", "version": "2"},
    },
}


def run_mock(mode: str, **options):
    env = {**os.environ, "HOST_MOCK_MODE": mode}
    return call_node(REQUEST, node_executable=sys.executable, node_entry=MOCK,
                     config_path="unused.json", environment=env, **options)


class SubprocessHostTests(unittest.TestCase):
    def test_provider_diagnostic_accepts_only_closed_opt_in_record(self):
        value = {
            "kind": "provider_failure", "callId": "3e8df696-8909-41ef-8791-36c239056109",
            "stage": "interpretation", "code": "PROVIDER_ERROR", "source": "http_status",
            "httpStatus": 429, "elapsedMs": 81,
        }
        line = ("PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC=" + json.dumps(value) + "\n").encode()
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "1"}):
            self.assertEqual(_provider_diagnostic(bytearray(line)), value)
            for malicious in (
                {**value, "rawResponse": "secret"},
                {**value, "requestId": "req_abcdef123456"},
                {**value, "httpStatus": "429"},
            ):
                with self.subTest(malicious=malicious):
                    raw = ("PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC=" + json.dumps(malicious) + "\n").encode()
                    self.assertIsNone(_provider_diagnostic(bytearray(raw)))
            self.assertIsNone(_provider_diagnostic(bytearray(line + b"private child output\n")))
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "0"}):
            self.assertIsNone(_provider_diagnostic(bytearray(line)))

    def test_safe_provider_diagnostic_crosses_host_without_changing_typed_stop(self):
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "1"}):
            result = run_mock("provider_diagnostic")
        self.assertEqual(result.outcome["kind"], "typed_stop")
        self.assertEqual(result.outcome["terminal"]["reason"], "PROVIDER_ERROR")
        self.assertEqual(result.provider_diagnostic["httpStatus"], 429)
        self.assertNotIn("PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC", result.stderr)
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "0"}):
            disabled = run_mock("provider_diagnostic")
        self.assertEqual(disabled.outcome, result.outcome)
        self.assertIsNone(disabled.provider_diagnostic)

    def test_one_valid_exchange_and_typed_stops(self):
        self.assertEqual(run_mock("success").outcome["kind"], "success")
        qa = run_mock("qa").outcome
        self.assertEqual((qa["kind"], qa["stopKind"], qa["terminal"]["status"]),
                         ("typed_stop", "qa_failure", "QA_ASSERTION_FAILED"))
        runtime = run_mock("automation").outcome
        self.assertEqual((runtime["kind"], runtime["stopKind"], runtime["terminal"]["status"]),
                         ("typed_stop", "automation_stop", "LOCATOR_BINDING_FAILED"))

    def test_missing_malformed_multiple_version_and_exit_mismatch(self):
        expected = {
            "missing": "MISSING_RESPONSE", "malformed": "MALFORMED_RESPONSE",
            "multiple": "MULTIPLE_RESPONSE", "wrong_version": "MALFORMED_RESPONSE",
            "wrong_exit": "UNEXPECTED_EXIT",
        }
        for mode, code in expected.items():
            with self.subTest(mode=mode):
                self.assertEqual(run_mock(mode).outcome["code"], code)

    def test_launch_failure_and_request_boundary(self):
        result = call_node(REQUEST, node_executable="nonexistent-python-p2-3c",
                           node_entry=MOCK, config_path="unused")
        self.assertEqual(result.outcome["code"], "LAUNCH_FAILED")
        self.assertEqual(result.outcome["cleanup"], "not_started")
        invalid = {**REQUEST, "request": {**REQUEST["request"], "apiKey": "secret"}}
        with self.assertRaises(ValueError):
            call_node(invalid, node_executable=sys.executable,
                      node_entry=MOCK, config_path="unused")

    def test_concurrent_bounded_drains_do_not_deadlock(self):
        start = time.monotonic()
        result = run_mock("pressure", deadline_ms=5_000)
        self.assertEqual(result.outcome["code"], "OUTPUT_LIMIT_EXCEEDED")
        self.assertLessEqual(len(result.stderr.encode()), 16_384)
        self.assertNotIn("xxxx", result.stderr)
        self.assertLess(time.monotonic() - start, 5)

    def test_deadline_and_cancellation_reap_child(self):
        expired = run_mock("sleep", deadline_ms=300)
        self.assertEqual(expired.outcome["code"], "DEADLINE_EXCEEDED")
        self.assertEqual(expired.outcome["cleanup"], "unverified")
        if os.name == "nt":
            self.assertTrue(expired.outcome["forcedTermination"])
        event = threading.Event()
        timer = threading.Timer(0.3, event.set)
        timer.start()
        try:
            cancelled = run_mock("sleep", cancel_event=event, deadline_ms=5_000)
        finally:
            timer.join()
        self.assertEqual(cancelled.outcome["code"], "CANCELLED")
        self.assertEqual(cancelled.outcome["cleanup"], "unverified")

    @unittest.skipUnless(os.name == "nt", "Windows CTRL_BREAK_EVENT process-group proof")
    def test_windows_cancel_allows_graceful_cleanup_before_reaping(self):
        self._assert_windows_cancellation("graceful", forced=False)

    @unittest.skipUnless(os.name == "nt", "Windows forced process-tree fallback proof")
    def test_windows_cancel_forces_child_after_grace_expires(self):
        self._assert_windows_cancellation("ignore", forced=True)

    def _assert_windows_cancellation(self, mode: str, *, forced: bool) -> None:
        from playwright_demo import host

        with tempfile.TemporaryDirectory(prefix="host-cancel-") as temporary:
            marker = Path(temporary) / "child"
            cancel = threading.Event()
            result = []

            def invoke() -> None:
                result.append(call_node(
                    REQUEST, node_executable="node",
                    node_entry=Path(__file__).with_name("cancel_child.cjs"),
                    config_path="unused.json", cancel_event=cancel,
                    deadline_ms=15_000,
                    environment={**os.environ, "HOST_CANCEL_MARKER": str(marker),
                                 "HOST_CANCEL_MODE": mode},
                ))

            with patch.object(host, "_CANCEL_GRACE_SECONDS", 0.25 if forced else 5.0):
                worker = threading.Thread(target=invoke)
                worker.start()
                try:
                    deadline = time.monotonic() + 5
                    while not marker.with_suffix(".ready").exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(marker.with_suffix(".ready").exists(), "Child did not start")
                    cancel.set()
                    worker.join(timeout=10)
                    self.assertFalse(worker.is_alive(), "Child was not reaped")
                finally:
                    cancel.set()
                    worker.join(timeout=10)

            self.assertEqual(len(result), 1)
            outcome = result[0].outcome
            self.assertEqual((outcome["kind"], outcome["code"], outcome["cleanup"]),
                             ("process_failure", "CANCELLED", "unverified"))
            self.assertIs(outcome["forcedTermination"], forced)
            self.assertEqual(marker.with_suffix(".cleaned").exists(), not forced)

    def test_built_node_entry_uses_same_protocol_without_provider(self):
        built = ROOT / "dist" / "subprocess" / "cli.js"
        if not built.exists():
            self.skipTest("Run npm run build for built-entry integration")
        result = call_node(REQUEST, node_entry=built, config_path="missing.json")
        self.assertEqual(result.outcome, {
            "protocolVersion": "1", "kind": "bridge_error",
            "code": "INVALID_TRUSTED_CONFIGURATION", "cleanup": "not_started",
        })


if __name__ == "__main__":
    unittest.main()

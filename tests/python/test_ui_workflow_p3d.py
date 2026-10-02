"""P3-D composition and safe typed presentation without provider credentials."""

from pathlib import Path
from contextlib import redirect_stderr
from io import StringIO
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import HostCallResult  # noqa: E402
from playwright_demo.public_admission import (  # noqa: E402
    lookup_public_admission, parse_admission_response,
)
from playwright_demo.ui_shell import UiRequest  # noqa: E402
from playwright_demo.ui_workflow import UiFinalResult, run_ui_workflow  # noqa: E402

FP = "a" * 64
REF = {"id": "admitted-public-abc", "version": "1"}
APPROVED = {"admissionVersion": "1", "kind": "approved",
            "canonicalUrl": "https://public.example.org/", "executionProfileRef": REF,
            "profileFingerprint": FP}
SUCCESS = {"protocolVersion": "1", "kind": "success", "context": {
    "testSpecId": "testp3d", "executionProfileRef": REF, "profileFingerprint": FP,
    "presentationMode": "headless", "observation": {
        "state": "no_intervention", "autonomousEligible": True, "eventIds": []},
    "progress": {"stage": "replayed", "explorationAttemptId": "attemptp3d",
                 "resolvedSpecId": "resolvedp3d", "executionRunIds": ["runone", "runtwo"]},
    "report": {"kind": "available", "testSpecId": "testp3d"}},
    "terminal": {"phase": "execution", "status": "QA_ASSERTION_PASSED"}}
PROJECTION = {"reportProjectionVersion": "1", "kind": "available",
              "screenshot": "capture_disabled", "outcomes": [
                  {"phase": "execution", "status": "QA_ASSERTION_PASSED",
                   "assertionType": "assert_url", "expected": {"state": "withheld"},
                   "actual": {"state": "withheld"}}], "evidence": []}


def _entries(root: Path) -> None:
    for relative in ("dist/profile/admission-cli.js", "dist/subprocess/cli.js",
                     "dist/subprocess/report-projection-cli.js"):
        entry = root / relative
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.touch()


def _ui_with_result(result):
    from playwright_demo.ui_shell import render_shell
    render_shell(lambda _request: result)


class UiWorkflowTests(unittest.TestCase):
    def test_opt_in_trace_exposes_closed_provider_cause_without_request_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _entries(root)
            request = UiRequest("https://public.example.org/private-path", "private task text")
            stopped = {**SUCCESS, "kind": "typed_stop", "stopKind": "automation_stop",
                       "context": {**SUCCESS["context"], "progress": {"stage": "not_started"},
                                   "report": {"kind": "unavailable"}},
                       "terminal": {"phase": "interpretation", "status": "INTERPRETATION_FAILED",
                                    "reason": "PROVIDER_ERROR"}}
            provider = {"kind": "provider_failure",
                        "callId": "3e8df696-8909-41ef-8791-36c239056109",
                        "stage": "interpretation", "code": "PROVIDER_ERROR",
                        "source": "http_status", "httpStatus": 429, "elapsedMs": 83,
                        "requestId": "req_provider_private"}
            trace = StringIO()
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "1"}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(stopped, provider_diagnostic=provider)), \
                 redirect_stderr(trace):
                result = run_ui_workflow(request, config_path="trusted", build_root=root)
            self.assertEqual(result.outcome, stopped)
            self.assertIn('"event":"provider_failure"', trace.getvalue())
            self.assertIn('"httpStatus":"429"', trace.getvalue())
            self.assertIn('"status":"INTERPRETATION_FAILED"', trace.getvalue())
            for forbidden in ("private-path", "private task text", "public.example.org",
                              "trusted", "req_provider_private", "requestId"):
                self.assertNotIn(forbidden, trace.getvalue())
            trace = StringIO()
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_UI_DIAGNOSTICS": "0"}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(stopped, provider_diagnostic=provider)), \
                 redirect_stderr(trace):
                run_ui_workflow(request, config_path="trusted", build_root=root)
            self.assertEqual(trace.getvalue(), "")

    def test_real_admission_lookup_denies_legacy_profile_without_starting_engine(self):
        entry = ROOT / "dist" / "profile" / "admission-cli.js"
        if not entry.exists():
            self.skipTest("Run npm run build for built admission integration")
        result = lookup_public_admission(
            "https://the-internet.herokuapp.com/challenging_dom", node_entry=entry,
            config_path=ROOT / "config" / "public-challenging-dom.json")
        self.assertEqual(result, {"admissionVersion": "1", "kind": "denied"})

    def test_active_profile_selection_uses_operator_url_without_old_approval_match(self):
        entry = ROOT / "dist" / "profile" / "admission-cli.js"
        if not entry.exists():
            self.skipTest("Run npm run build for built profile selection integration")
        selected_url = "https://different.example.org/another/path"
        result = lookup_public_admission(
            selected_url, node_entry=entry,
            config_path=ROOT / "config" / "public-challenging-dom.json",
            selection_only=True)
        self.assertEqual(result["kind"], "approved")
        self.assertEqual(result["canonicalUrl"], selected_url)
        self.assertEqual(result["executionProfileRef"]["id"], "challenging-dom-public-headless")
        for invalid in ("not-a-url", "file:///tmp/page.html"):
            with self.subTest(invalid=invalid):
                denied = lookup_public_admission(
                    invalid, node_entry=entry,
                    config_path=ROOT / "config" / "public-challenging-dom.json",
                    selection_only=True)
                self.assertEqual(denied["kind"], "denied")

    def test_closed_admission_consumer_rejects_extra_fields_and_duplicate_keys(self):
        self.assertEqual(parse_admission_response(json.dumps(APPROVED).encode())["kind"],
                         "approved")
        for wire in (b'{"admissionVersion":"1","kind":"denied","pins":[]}',
                     b'{"admissionVersion":"1","kind":"denied","kind":"approved"}',
                     json.dumps({**APPROVED, "profileFingerprint": "secret"}).encode()):
            with self.subTest(wire=wire), self.assertRaises(ValueError):
                parse_admission_response(wire)

    def test_denied_and_unavailable_admission_never_start_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _entries(root)
            request = UiRequest("https://public.example.org/", "Check the page.")
            with patch("playwright_demo.ui_workflow.lookup_public_admission",
                       return_value={"admissionVersion": "1", "kind": "denied"}), \
                 patch("playwright_demo.ui_workflow.call_node") as engine:
                result = run_ui_workflow(request, config_path=root / "trusted.json", build_root=root)
                self.assertEqual(result.kind, "admission_denied")
                engine.assert_not_called()
            with patch("playwright_demo.ui_workflow.lookup_public_admission",
                       return_value={"admissionVersion": "1", "kind": "unavailable"}), \
                 patch("playwright_demo.ui_workflow.call_node") as engine:
                result = run_ui_workflow(request, config_path=root / "trusted.json", build_root=root)
                self.assertEqual(result.kind, "admission_unavailable")
                engine.assert_not_called()

    def test_approved_request_uses_v1_and_correlated_projection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _entries(root)
            request = UiRequest("https://public.example.org/", "Check the page.")
            with patch("playwright_demo.ui_workflow.lookup_public_admission",
                       return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(SUCCESS)) as engine, \
                 patch("playwright_demo.ui_workflow.call_report_projection",
                       return_value=HostCallResult(PROJECTION)) as projection:
                result = run_ui_workflow(request, config_path=root / "trusted.json", build_root=root)
            self.assertEqual(result.kind, "engine")
            self.assertEqual(result.projection, PROJECTION)
            self.assertEqual(engine.call_args.args[0], {"protocolVersion": "1", "request": {
                "taskText": "Check the page.", "targetUrl": APPROVED["canonicalUrl"],
                "executionProfileRef": REF}})
            self.assertEqual(projection.call_args.args[0], SUCCESS)
            self.assertEqual(engine.call_args.kwargs["config_path"], root / "trusted.json")

    def test_profile_mismatch_and_projection_failure_do_not_change_qa_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _entries(root)
            request = UiRequest("https://public.example.org/", "Check the page.")
            wrong = {**SUCCESS, "context": {**SUCCESS["context"], "profileFingerprint": "b" * 64}}
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(wrong)), \
                 patch("playwright_demo.ui_workflow.call_report_projection") as projection:
                self.assertEqual(run_ui_workflow(request, config_path="trusted", build_root=root).kind,
                                 "host_failure")
                projection.assert_not_called()
            failed_projection = HostCallResult({"kind": "process_failure", "code": "MALFORMED_RESPONSE",
                                                "cleanup": "unverified", "forcedTermination": False})
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(SUCCESS)), \
                 patch("playwright_demo.ui_workflow.call_report_projection",
                       return_value=failed_projection):
                result = run_ui_workflow(request, config_path="trusted", build_root=root)
            self.assertEqual(result.outcome, SUCCESS)
            self.assertTrue(result.projection_failed)
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=APPROVED), \
                 patch("playwright_demo.ui_workflow.call_node",
                       return_value=HostCallResult(SUCCESS)), \
                 patch("playwright_demo.ui_workflow.call_report_projection",
                       side_effect=ValueError("private artifact detail")):
                result = run_ui_workflow(request, config_path="trusted", build_root=root)
            self.assertEqual(result.outcome, SUCCESS)
            self.assertTrue(result.projection_failed)


class UiPresentationTests(unittest.TestCase):
    def test_streamlit_entry_uses_host_wiring_and_fails_closed_without_config(self):
        import streamlit as st
        script = ROOT / "src" / "playwright_demo" / "streamlit_app.py"
        original_get_option = st.get_option

        def option_for(name):
            return "127.0.0.1" if name == "server.address" else original_get_option(name)

        with patch("streamlit.get_option", side_effect=option_for), \
             patch.dict(os.environ, {"PLAYWRIGHT_DEMO_TRUSTED_CONFIG": ""}):
            app = AppTest.from_file(str(script)).run()
            app.text_input[0].set_value("https://public.example.org/")
            app.text_area[0].set_value("Check the page.")
            app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertIn("Trusted public-target approval is unavailable. No test started.",
                      [item.value for item in app.error])

    def _submitted(self, result):
        app = AppTest.from_function(_ui_with_result, args=(result,)).run()
        app.text_input[0].set_value("https://public.example.org/")
        app.text_area[0].set_value("Check the page.")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        return app

    def test_success_shows_typed_assertion_without_page_text_or_bytes(self):
        app = self._submitted(UiFinalResult("engine", SUCCESS, PROJECTION))
        rendered = " ".join(item.value for item in [*app.success, *app.markdown, *app.caption])
        self.assertIn("QA_ASSERTION_PASSED", rendered)
        self.assertIn("assert_url", rendered)
        self.assertIn("Autonomous eligible: True", rendered)
        self.assertNotIn("private page text", rendered)
        operation = {**SUCCESS, "terminal": {"phase": "execution",
                                              "status": "OPERATION_SUCCEEDED"}}
        operation_app = self._submitted(UiFinalResult("engine", operation))
        self.assertIn("Execution result: OPERATION_SUCCEEDED",
                      [item.value for item in operation_app.success])

    def test_projection_unavailable_does_not_replace_qa_result(self):
        app = self._submitted(UiFinalResult(
            "engine", SUCCESS, {"reportProjectionVersion": "1", "kind": "unavailable",
                                "reason": "REPORT_EXPIRED"}))
        rendered = " ".join(item.value for item in [*app.success, *app.warning, *app.markdown])
        self.assertIn("QA_ASSERTION_PASSED", rendered)
        self.assertIn("REPORT_EXPIRED", rendered)

    def test_restricted_screenshot_is_metadata_only(self):
        restricted = {**PROJECTION, "screenshot": "stored_restricted", "evidence": [
            {"evidenceId": "screenshotone", "owner": {"kind": "run", "id": "runone"},
             "mediaType": "image/png", "sensitivity": "restricted",
             "capturedAt": "2026-01-01T00:00:00.000Z", "byteLength": 1200}]}
        app = self._submitted(UiFinalResult("engine", SUCCESS, restricted))
        rendered = " ".join(item.value for item in [*app.caption, *app.markdown])
        self.assertIn("Screenshot bytes are restricted", rendered)
        self.assertIn("image/png", rendered)
        self.assertEqual(len(app.image), 0)

    def test_qa_stop_automation_stop_bridge_and_process_failure_are_distinct(self):
        qa = {**SUCCESS, "kind": "typed_stop", "stopKind": "qa_failure",
              "terminal": {"phase": "execution", "status": "QA_ASSERTION_FAILED"}}
        automation = {**SUCCESS, "kind": "typed_stop", "stopKind": "automation_stop",
                      "terminal": {"phase": "locator", "status": "LOCATOR_QUALITY_FAILED"}}
        cases = (
            (UiFinalResult("engine", qa), "QA assertion failed"),
            (UiFinalResult("engine", automation), "Automation stopped"),
            (UiFinalResult("engine", {"kind": "bridge_error", "code": "DESTINATION_DENIED",
                                      "cleanup": "not_started"}), "Node bridge error"),
            (UiFinalResult("engine", {"kind": "process_failure", "code": "DEADLINE_EXCEEDED",
                                      "cleanup": "unverified"}), "Host process failure"),
            (UiFinalResult("admission_denied"), "No test started"),
        )
        for result, marker in cases:
            with self.subTest(marker=marker):
                app = self._submitted(result)
                rendered = " ".join(item.value for item in [*app.error, *app.warning, *app.markdown])
                self.assertIn(marker, rendered)


if __name__ == "__main__":
    unittest.main()

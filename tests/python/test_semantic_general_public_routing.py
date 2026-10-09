"""Trusted semantic-general host/UI selection and v2 result projection."""

from __future__ import annotations

import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

from tests.python.v2_fixtures import FP, REF, envelope, result, parse
from playwright_demo.host import HostCallResult
from playwright_demo.wire_common import InvalidWire
from playwright_demo.ui_shell import UiRequest
from playwright_demo.ui_workflow import UiFinalResult, run_local_ui_request, run_ui_workflow


def semantic(status="QA_ASSERTION_PASSED", reason=None, **kwargs):
    record = result(status, reason, **kwargs)
    record["workflowVersion"] = "semantic-general-v1"
    if record.get("resolvedSpecId"):
        record["semanticReplay"] = {"sourceSchemaVersion": "7", "sourceContractVersion": "3",
            "groundingVersion": "semantic_capability_discovery_v1", "traceVersion": "semantic_grounded_trace_v1",
            "compilerVersion": "5", "resolvedSchemaVersion": "10", "runnerVersion": "10",
            "replayPairVersion": "2", "orchestrationId": "pairone", "traceDigest": "a" * 64,
            "resolvedDigest": "b" * 64, "pairDigest": "c" * 64,
            "executionSessionIds": ["sessionone", "sessiontwo"][:len(record["executionRunIds"])],
            "runDigests": ["d" * 64, "e" * 64][:len(record["executionRunIds"])]}
    return envelope(record)


class SemanticGeneralHostTests(unittest.TestCase):
    def test_ordinary_python_launch_selects_semantic_without_selectors(self):
        request = UiRequest("https://public.example.org/", "Test")
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_TRUSTED_CONFIG": "trusted"}, clear=True), \
             patch("playwright_demo.ui_workflow.run_ui_workflow",
                   return_value=UiFinalResult("admission_denied")) as workflow:
            run_local_ui_request(request)
        self.assertEqual(workflow.call_args.kwargs["workflow_version"], "semantic-general-v1")
        self.assertEqual(workflow.call_args.kwargs["config_path"], "trusted")
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_TRUSTED_CONFIG": "trusted",
                                  "PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "semantic-general-v1"}, clear=True), \
             patch("playwright_demo.ui_workflow.run_ui_workflow",
                   return_value=UiFinalResult("admission_denied")) as workflow:
            run_local_ui_request(request)
        self.assertEqual(workflow.call_args.kwargs["workflow_version"], "semantic-general-v1")

    def test_ordinary_python_launch_rejects_retired_routes_and_docker(self):
        request = UiRequest("https://public.example.org/", "Test")
        retired = ("legacy", "agentic-exploration-v1", "goal-directed-v1",
                   "structured-action-v1", "deferred-action-v1")
        for selected in retired:
            with self.subTest(workflow=selected), patch.dict(os.environ,
                    {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": selected}, clear=True), \
                 patch("playwright_demo.ui_workflow.run_ui_workflow") as workflow:
                with self.assertRaisesRegex(ValueError, "Unsupported trusted workflow selection"):
                    run_local_ui_request(request)
                workflow.assert_not_called()
        for backend in ("docker-isolated", "local-windows"):
            with self.subTest(backend=backend), patch.dict(os.environ,
                    {"PLAYWRIGHT_DEMO_BROWSER_BACKEND": backend}, clear=True), \
                 patch("playwright_demo.ui_workflow.run_ui_workflow") as workflow:
                with self.assertRaisesRegex(ValueError, "Unsupported trusted browser backend"):
                    run_local_ui_request(request)
                workflow.assert_not_called()

    def test_malformed_pacing_rejects_before_admission_or_engine(self):
        request = UiRequest("https://public.example.org/", "Test")
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_ACTION_PAUSE_MS": "-5"}), \
             patch("playwright_demo.ui_workflow.lookup_public_admission") as admission, \
             patch("playwright_demo.ui_workflow.call_node") as engine:
            with self.assertRaisesRegex(ValueError, "Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS"):
                run_ui_workflow(request, config_path="trusted", workflow_version="semantic-general-v1")
        admission.assert_not_called()
        engine.assert_not_called()

    def test_semantic_gate_is_not_required_for_product_route(self):
        request = UiRequest("https://public.example.org/", "Test")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/agentic-cli.js",
                             "dist/subprocess/report-projection-v2-cli.js"):
                file = root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE": ""}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission",
                       return_value={"admissionVersion": "1", "kind": "denied"}) as admission, \
                 patch("playwright_demo.ui_workflow.call_node") as engine:
                stop = run_ui_workflow(request, config_path="trusted", build_root=root)
            self.assertEqual(stop.kind, "admission_denied")
            admission.assert_called_once()
            engine.assert_not_called()

    def test_closed_workflow_gate_backend_and_live_view_pass_to_node(self):
        request = UiRequest("https://public.example.org/", "Test")
        accepted = semantic(trace=True, compiled=True, runs=2)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/agentic-cli.js",
                             "dist/subprocess/report-projection-v2-cli.js"):
                file = root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
            approval = {"kind": "approved", "admissionVersion": "1", "canonicalUrl": request.target_url,
                        "executionProfileRef": REF, "profileFingerprint": FP}
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_LIVE_VIEW": "1",
                                      "PLAYWRIGHT_DEMO_ACTION_PAUSE_MS": "750"}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approval), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(accepted)) as engine:
                final = run_ui_workflow(request, config_path="trusted", build_root=root,
                                        workflow_version="semantic-general-v1")
            self.assertEqual(final.kind, "engine")
            self.assertEqual(final.outcome["context"]["result"]["terminal"]["status"], "QA_ASSERTION_PASSED")
            arguments = engine.call_args.kwargs
            self.assertEqual(arguments["protocol_version"], "2")
            self.assertNotIn("environment", arguments)
            wrong = copy.deepcopy(accepted)
            wrong["context"]["result"]["workflowVersion"] = "deferred-action-v1"
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approval), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(wrong)):
                mismatch = run_ui_workflow(request, config_path="trusted", build_root=root,
                                           workflow_version="semantic-general-v1")
            self.assertEqual(mismatch.kind, "host_failure")

    def test_generalized_pass_and_non_qa_stop_parse_with_closed_v2_contract(self):
        success = semantic(trace=True, compiled=True, runs=2)
        stop = semantic("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND")
        self.assertEqual(parse(success)[1], 0)
        self.assertEqual(parse(stop)[1], 2)
        missing = copy.deepcopy(success)
        del missing["context"]["result"]["semanticReplay"]
        with self.assertRaises(InvalidWire): parse(missing)
        wrong_version = copy.deepcopy(success)
        wrong_version["context"]["result"]["semanticReplay"]["resolvedSchemaVersion"] = "9"
        with self.assertRaises(InvalidWire): parse(wrong_version)
        cross_route = copy.deepcopy(success)
        cross_route["context"]["result"]["workflowVersion"] = "agentic-exploration-v1"
        with self.assertRaises(InvalidWire): parse(cross_route)


def render(final):
    from playwright_demo.ui_shell import render_shell
    render_shell(lambda _: final)


class SemanticGeneralUiTests(unittest.TestCase):
    def test_trusted_demo_pacing_note_and_invalid_setting(self):
        from playwright_demo.demo_action_pacing import parse_demo_action_pause_ms
        self.assertEqual(parse_demo_action_pause_ms(None), 0)
        self.assertEqual(parse_demo_action_pause_ms("0"), 0)
        self.assertEqual(parse_demo_action_pause_ms("750"), 750)
        for raw in ("", "-1", "01", "1.5", "3001", "999999999999999999999"):
            with self.assertRaises(ValueError): parse_demo_action_pause_ms(raw)
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "semantic-general-v1",
                                     "PLAYWRIGHT_DEMO_ACTION_PAUSE_MS": "750"}):
            app = AppTest.from_function(render, args=(UiFinalResult("workflow_unavailable"),)).run()
        rendered = " ".join(item.value for item in app if
                            hasattr(item, "value") and isinstance(item.value, str))
        self.assertIn("Demo pacing: 750 ms after actions", rendered)
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "semantic-general-v1",
                                     "PLAYWRIGHT_DEMO_ACTION_PAUSE_MS": "invalid"}):
            app = AppTest.from_function(render, args=(UiFinalResult("workflow_unavailable"),)).run()
        rendered = " ".join(item.value for item in app if
                            hasattr(item, "value") and isinstance(item.value, str))
        self.assertIn("Invalid trusted demo pacing setting", rendered)
        self.assertNotIn("Demo pacing: invalid", rendered)

    def test_workflow_label_pass_and_non_qa_categories(self):
        cases = (
            (semantic(trace=True, compiled=True, runs=2), "QA passed"),
            (semantic("QA_ASSERTION_FAILED", "URL_MISMATCH", trace=True, compiled=True, runs=2), "QA failed"),
            (semantic("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND"), "Path not established"),
            (semantic("ENVIRONMENT_FAILED", "BROWSER_UNAVAILABLE"), "Environment/runtime failure"),
            (semantic("REPRODUCIBILITY_FAILED", "REPLAY_OUTCOMES_DISAGREE",
                      trace=True, compiled=True, runs=2), "Reproducibility failed"),
            (semantic("ENVIRONMENT_FAILED", "SESSION_CLEANUP_FAILED", cleanup="unverified"),
             "Cleanup: unverified"),
        )
        for wire, expected in cases:
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "semantic-general-v1"}):
                final = UiFinalResult("engine", outcome=wire, workflow_version="semantic-general-v1")
                app = AppTest.from_function(render, args=(final,)).run()
                app.text_input[0].set_value("https://public.example.org/")
                app.text_area[0].set_value("Test")
                app.button[0].click().run()
            rendered = " ".join(item.value for item in app if
                                hasattr(item, "value") and isinstance(item.value, str))
            self.assertIn("Trusted workflow: semantic-general-v1", rendered)
            self.assertNotIn("offline-review gate", rendered)
            self.assertIn(expected, rendered)
            self.assertIn("Workflow: semantic-general-v1", rendered)
            if expected not in {"QA passed", "QA failed"}: self.assertNotIn("QA failed", rendered)


if __name__ == "__main__": unittest.main()

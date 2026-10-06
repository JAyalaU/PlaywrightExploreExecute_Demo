"""Trusted semantic-general host/UI selection and v2 result projection."""

from __future__ import annotations

import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

from tests.python.test_agentic_external_v2 import FP, REF, envelope, result, parse
from playwright_demo.host import HostCallResult
from playwright_demo.protocol import InvalidWire
from playwright_demo.ui_shell import UiRequest
from playwright_demo.ui_workflow import UiFinalResult, run_ui_workflow


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
    def test_gate_rejects_before_admission_or_engine(self):
        request = UiRequest("https://public.example.org/", "Test")
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE": ""}), \
             patch("playwright_demo.ui_workflow.lookup_public_admission") as admission, \
             patch("playwright_demo.ui_workflow.call_node") as engine:
            stop = run_ui_workflow(request, config_path="trusted", workflow_version="semantic-general-v1")
        self.assertEqual(stop.kind, "workflow_unavailable")
        admission.assert_not_called()
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
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE": "offline-review",
                                      "PLAYWRIGHT_DEMO_BROWSER_BACKEND": "local-windows",
                                      "PLAYWRIGHT_DEMO_LIVE_VIEW": "1"}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approval), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(accepted)) as engine:
                final = run_ui_workflow(request, config_path="trusted", build_root=root,
                                        workflow_version="semantic-general-v1")
            self.assertEqual(final.kind, "engine")
            self.assertEqual(final.outcome["context"]["result"]["terminal"]["status"], "QA_ASSERTION_PASSED")
            arguments = engine.call_args.kwargs
            self.assertEqual(arguments["protocol_version"], "2")
            self.assertEqual(arguments["environment"]["PLAYWRIGHT_DEMO_WORKFLOW_VERSION"], "semantic-general-v1")
            self.assertEqual(arguments["environment"]["PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE"], "offline-review")
            self.assertEqual(arguments["environment"]["PLAYWRIGHT_DEMO_BROWSER_BACKEND"], "local-windows")
            self.assertEqual(arguments["environment"]["PLAYWRIGHT_DEMO_LIVE_VIEW"], "1")
            wrong = copy.deepcopy(accepted)
            wrong["context"]["result"]["workflowVersion"] = "deferred-action-v1"
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE": "offline-review"}), \
                 patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approval), \
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
            self.assertIn("Semantic generalization route", rendered)
            self.assertIn(expected, rendered)
            self.assertIn("Workflow: semantic-general-v1", rendered)
            if expected not in {"QA passed", "QA failed"}: self.assertNotIn("QA failed", rendered)


if __name__ == "__main__": unittest.main()

"""Closed agentic Python wire and UI boundaries, without provider credentials."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
import os
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import HostCallResult, call_node  # noqa: E402
from playwright_demo.protocol import InvalidWire  # noqa: E402
from playwright_demo.protocol_v2 import parse_response, request_bytes  # noqa: E402
from playwright_demo.report_projection_v2 import parse_report_projection  # noqa: E402
from playwright_demo.ui_shell import UiRequest, UiRun  # noqa: E402
from playwright_demo.ui_workflow import UiFinalResult, run_ui_workflow, run_local_ui_request  # noqa: E402

REF = {"id": "approved", "version": "1"}
FP = "a" * 64


def result(status="EXPLORATION_UNRESOLVED", reason="TARGET_NOT_FOUND", *,
           trace=False, compiled=False, runs=0, cleanup="verified"):
    stages = {
        "EXPLORATION_UNRESOLVED": "exploration", "EXPLORATION_UNSUPPORTED": "exploration",
        "COMPILATION_FAILED": "compilation", "COMPILATION_UNSUPPORTED": "compilation",
        "REPLAY_BINDING_FAILED": "replay", "REPLAY_WAIT_FAILED": "replay",
        "REPLAY_EXECUTION_FAILED": "replay", "REPRODUCIBILITY_FAILED": "reproducibility",
        "QA_ASSERTION_PASSED": "qa", "QA_ASSERTION_FAILED": "qa",
        "ENVIRONMENT_FAILED": "environment", "CANCELLED": "cancellation",
    }
    stage = stages[status]
    value = {"resultVersion": "2", "workflowVersion": "agentic-exploration-v1",
             "testSpecId": "testone", "executionProfileRef": REF,
             "profileFingerprint": FP, "presentationMode": "headless",
             "observation": "no_intervention", "executionRunIds": ["runone", "runtwo"][:runs],
             "terminal": {"stage": stage, "status": status}, "cleanup": cleanup}
    if reason: value["terminal"]["reason"] = reason
    if stage not in {"interpretation"}: value["explorationAttemptId"] = "attemptone"
    if trace or compiled or runs: value["successfulTraceId"] = "traceone"
    if compiled or runs: value["compilerAttemptId"] = "compilerone"
    if runs: value["resolvedSpecId"] = "resolvedone"
    return value


def envelope(record, report="unavailable"):
    p = {"stage": "not_started"}
    if "explorationAttemptId" in record:
        p = {"stage": "exploration", "explorationAttemptId": record["explorationAttemptId"]}
    if "successfulTraceId" in record:
        p = {"stage": "compilation", "explorationAttemptId": record["explorationAttemptId"],
             "successfulTraceId": record["successfulTraceId"]}
        if "compilerAttemptId" in record: p["compilerAttemptId"] = record["compilerAttemptId"]
    if "resolvedSpecId" in record:
        p = {"stage": "replay", "explorationAttemptId": record["explorationAttemptId"],
             "successfulTraceId": record["successfulTraceId"], "compilerAttemptId": record["compilerAttemptId"],
             "resolvedSpecId": record["resolvedSpecId"], "executionRunIds": record["executionRunIds"]}
    context = {"result": record, "progress": p, "report": {"kind": report}}
    if report == "available": context["report"]["testSpecId"] = record["testSpecId"]
    stage = record["terminal"]["stage"]
    if record["terminal"]["status"] == "QA_ASSERTION_PASSED":
        return {"protocolVersion": "2", "kind": "success", "context": context}
    stop = {"qa": "qa_failure", "environment": "environment_stop", "cancellation": "cancelled",
            "reproducibility": "reproducibility_stop"}.get(stage, "automation_stop")
    return {"protocolVersion": "2", "kind": "typed_stop", "stopKind": stop, "context": context}


def parse(value):
    return parse_response(json.dumps(value).encode(), REF)


class AgenticContractTests(unittest.TestCase):
    def test_every_reviewed_terminal_category(self):
        cases = [
            ("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND", {}),
            ("EXPLORATION_UNRESOLVED", "BUDGET_EXHAUSTED", {}),
            ("EXPLORATION_UNRESOLVED", "UNSAFE_RECOVERY", {}),
            ("EXPLORATION_UNSUPPORTED", "UNSUPPORTED_CAPABILITY", {}),
            ("COMPILATION_FAILED", "WEAK_IDENTITY", {"trace": True, "compiled": True}),
            ("COMPILATION_FAILED", "POSTCONDITION_MISMATCH", {"trace": True, "compiled": True}),
            ("COMPILATION_UNSUPPORTED", "UNSUPPORTED_CAPABILITY", {"trace": True, "compiled": True}),
            ("REPLAY_BINDING_FAILED", "NO_MATCH", {"trace": True, "compiled": True, "runs": 1}),
            ("REPLAY_WAIT_FAILED", "WAIT_CONDITION_TIMEOUT", {"trace": True, "compiled": True, "runs": 1}),
            ("REPLAY_EXECUTION_FAILED", "REPLAY_EXECUTION_FAILED", {"trace": True, "compiled": True, "runs": 1}),
            ("REPRODUCIBILITY_FAILED", "REPLAY_OUTCOMES_DISAGREE", {"trace": True, "compiled": True, "runs": 2}),
            ("QA_ASSERTION_PASSED", None, {"trace": True, "compiled": True, "runs": 2}),
            ("QA_ASSERTION_FAILED", "URL_MISMATCH", {"trace": True, "compiled": True, "runs": 2}),
            ("ENVIRONMENT_FAILED", "PROVIDER_ERROR", {}),
            ("ENVIRONMENT_FAILED", "SESSION_CLEANUP_FAILED", {"cleanup": "unverified"}),
            ("CANCELLED", "CANCELLED", {}),
        ]
        for status, reason, options in cases:
            with self.subTest(status=status, reason=reason):
                _, exit_code = parse(envelope(result(status, reason, **options)))
                self.assertEqual(exit_code, 0 if status == "QA_ASSERTION_PASSED" else
                                 1 if status == "QA_ASSERTION_FAILED" else
                                 130 if status == "CANCELLED" else 2)

    def test_cross_version_unknown_fields_and_wrong_stop_fail_closed(self):
        base = envelope(result())
        for change in (lambda x: x.update(protocolVersion="1"),
                       lambda x: x.update(privateTrace={"pageText": "secret"}),
                       lambda x: x.update(stopKind="qa_failure"),
                       lambda x: x["context"]["result"]["terminal"].update(reason="page text"),
                       lambda x: x["context"]["result"].update(executionProfileRef={"id": "wrong", "version": "1"})):
            invalid = copy.deepcopy(base); change(invalid)
            with self.assertRaises(InvalidWire): parse(invalid)
        with self.assertRaises(ValueError): request_bytes({"protocolVersion": "1", "request": {}})

    def test_report_projection_correlation_and_denial(self):
        wire = envelope(result("QA_ASSERTION_PASSED", None, trace=True, compiled=True, runs=2), "available")
        parse(wire)
        projection = {"reportProjectionVersion": "2", "kind": "available", "testSpecId": "testone",
            "executionProfileRef": REF, "profileFingerprint": FP, "explorationAttemptId": "attemptone",
            "successfulTraceId": "traceone", "compilerAttemptId": "compilerone", "resolvedSpecId": "resolvedone",
            "executionRunIds": ["runone", "runtwo"], "terminal": wire["context"]["result"]["terminal"],
            "stages": {"exploration": {"status": "completed"}, "compilation": {"status": "completed"},
                       "replay": {"status": "completed"}},
            "replays": [{"executionRunId": "runone", "state": "completed_pass"},
                        {"executionRunId": "runtwo", "state": "completed_pass"}],
            "reproducibility": "agreed", "authoritativeQa": "QA_ASSERTION_PASSED",
            "observation": "no_intervention", "cleanup": "verified", "outcomes": [], "evidence": [],
            "screenshot": "capture_disabled"}
        self.assertEqual(parse_report_projection(json.dumps(projection).encode(), wire)["kind"], "available")
        for change in (lambda x: x.update(reportProjectionVersion="1"),
                       lambda x: x.update(rawLocator="secret"),
                       lambda x: x.update(authoritativeQa="QA_ASSERTION_FAILED"),
                       lambda x: x["replays"][0].update(executionRunId="wrong")):
            invalid = copy.deepcopy(projection); change(invalid)
            with self.assertRaises(InvalidWire): parse_report_projection(json.dumps(invalid).encode(), wire)

    def test_trusted_selection_fails_before_v1_engine_and_v2_early_stop(self):
        request = UiRequest("https://public.example.org/", "Test")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/cli.js",
                             "dist/subprocess/report-projection-cli.js"):
                path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
            with patch("playwright_demo.ui_workflow.call_node") as node:
                denied = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="agentic-exploration-v1")
            self.assertEqual(denied.kind, "workflow_unavailable"); node.assert_not_called()
            for relative in ("dist/subprocess/agentic-cli.js", "dist/subprocess/report-projection-v2-cli.js"):
                (root / relative).touch()
            approved = {"kind": "approved", "admissionVersion": "1", "canonicalUrl": request.target_url,
                "executionProfileRef": REF, "profileFingerprint": FP}
            stopped = envelope(result())
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(stopped)) as node, \
                 patch("playwright_demo.ui_workflow.call_report_projection_v2") as projection:
                response = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="agentic-exploration-v1")
            self.assertEqual(response.outcome, stopped)
            self.assertIsNone(response.projection)
            self.assertEqual(node.call_args.kwargs["protocol_version"], "2")
            projection.assert_not_called()

    def test_goal_directed_workflow_selection_and_v2_version_correlation(self):
        request = UiRequest("https://public.example.org/", "Test")
        accepted = envelope(result())
        accepted["context"]["result"]["workflowVersion"] = "goal-directed-v1"
        parse(accepted)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/agentic-cli.js",
                             "dist/subprocess/report-projection-v2-cli.js"):
                path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
            approved = {"kind": "approved", "admissionVersion": "1", "canonicalUrl": request.target_url,
                "executionProfileRef": REF, "profileFingerprint": FP}
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(accepted)) as node:
                response = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="goal-directed-v1")
            self.assertEqual(response.kind, "engine")
            self.assertEqual(response.workflow_version, "goal-directed-v1")
            self.assertEqual(node.call_args.kwargs["protocol_version"], "2")
            self.assertEqual(node.call_args.kwargs["environment"]["PLAYWRIGHT_DEMO_WORKFLOW_VERSION"],
                             "goal-directed-v1")
            old_record = envelope(result())
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(old_record)):
                mismatch = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="goal-directed-v1")
            self.assertEqual(mismatch.kind, "host_failure")

    def test_structured_workflow_selection_uses_v2_host_and_fails_cross_version_closed(self):
        request = UiRequest("https://public.example.org/", "Test")
        accepted = envelope(result())
        accepted["context"]["result"]["workflowVersion"] = "structured-action-v1"
        parse(accepted)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/agentic-cli.js",
                             "dist/subprocess/report-projection-v2-cli.js"):
                file = root / relative; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
            approved = {"kind": "approved", "admissionVersion": "1", "canonicalUrl": request.target_url,
                "executionProfileRef": REF, "profileFingerprint": FP}
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(accepted)) as node:
                response = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="structured-action-v1")
            self.assertEqual(response.kind, "engine")
            self.assertEqual(response.workflow_version, "structured-action-v1")
            self.assertEqual(node.call_args.kwargs["protocol_version"], "2")
            self.assertEqual(node.call_args.kwargs["environment"]["PLAYWRIGHT_DEMO_WORKFLOW_VERSION"],
                             "structured-action-v1")
            old_record = envelope(result())
            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved), \
                 patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(old_record)):
                mismatch = run_ui_workflow(request, config_path="trusted", build_root=root,
                    workflow_version="structured-action-v1")
            self.assertEqual(mismatch.kind, "host_failure")

    def test_host_process_v2_exchange_and_cross_version_denial(self):
        request = {"protocolVersion": "2", "request": {"taskText": "Test", "targetUrl": "https://public.example.org/",
                   "executionProfileRef": REF}}
        with tempfile.TemporaryDirectory() as temp:
            entry = Path(temp) / "child.py"
            for response, accepted in ((envelope(result()), True),
                                       ({"protocolVersion": "1", "kind": "bridge_error",
                                         "code": "WORKFLOW_FAILED", "cleanup": "not_started"}, False)):
                entry.write_text("import json,sys\nsys.stdin.buffer.read()\n" +
                                 f"sys.stdout.write({json.dumps(json.dumps(response) + chr(10))})\n" +
                                 "sys.exit(2)\n", encoding="utf-8")
                result_call = call_node(request, node_entry=entry, config_path="unused",
                                        node_executable=sys.executable, protocol_version="2")
                self.assertEqual(result_call.outcome["kind"], "typed_stop" if accepted else "process_failure")
                if not accepted: self.assertEqual(result_call.outcome["code"], "MALFORMED_RESPONSE")

    def test_local_launch_selection_is_trusted_and_agentic_timeline_unavailable(self):
        request = UiRequest("https://public.example.org/", "Test")
        for selected in ("legacy", "agentic-exploration-v1", "goal-directed-v1", "structured-action-v1"):
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": selected,
                                      "PLAYWRIGHT_DEMO_TRUSTED_CONFIG": "trusted"}), \
                 patch("playwright_demo.ui_workflow.run_ui_workflow",
                       return_value=UiFinalResult("admission_denied")) as workflow:
                run_local_ui_request(request)
                self.assertEqual(workflow.call_args.kwargs["workflow_version"], selected)
                self.assertEqual(workflow.call_args.kwargs["config_path"], "trusted")
            if selected != "legacy":
                with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": selected}):
                    run = UiRun(request, lambda _: UiFinalResult("admission_denied"))
                    self.assertTrue(run.agentic)
                    self.assertEqual(run.events.snapshot()[0], "unavailable")


def _render_result(result):
    from playwright_demo.ui_shell import render_shell
    render_shell(lambda _: result)


class AgenticUiTests(unittest.TestCase):
    def test_trusted_workflow_is_visible_before_submission(self):
        for selected in ("agentic-exploration-v1", "goal-directed-v1", "structured-action-v1"):
            with self.subTest(workflow=selected), patch.dict(os.environ,
                    {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": selected}):
                app = AppTest.from_function(_render_result,
                                            args=(UiFinalResult("admission_denied"),)).run()
                rendered = " ".join(element.value for element in app if
                                    hasattr(element, "value") and isinstance(element.value, str))
                self.assertIn(f"Trusted workflow: {selected}", rendered)

    def test_typed_categories_do_not_confuse_qa(self):
        for status, reason, options, label in (
            ("EXPLORATION_UNRESOLVED", "TARGET_NOT_FOUND", {}, "Path not established"),
            ("COMPILATION_FAILED", "WEAK_IDENTITY", {"trace": True, "compiled": True}, "Compilation failed"),
            ("REPLAY_BINDING_FAILED", "NO_MATCH", {"trace": True, "compiled": True, "runs": 1}, "Replay failed"),
            ("REPRODUCIBILITY_FAILED", "REPLAY_OUTCOMES_DISAGREE", {"trace": True, "compiled": True, "runs": 2}, "Reproducibility failed"),
            ("QA_ASSERTION_PASSED", None, {"trace": True, "compiled": True, "runs": 2}, "QA passed"),
            ("QA_ASSERTION_FAILED", "URL_MISMATCH", {"trace": True, "compiled": True, "runs": 2}, "QA failed"),
            ("ENVIRONMENT_FAILED", "PROVIDER_ERROR", {}, "Environment/runtime failure"),
            ("ENVIRONMENT_FAILED", "SESSION_CLEANUP_FAILED", {"cleanup": "unverified"}, "Cleanup: unverified"),
            ("CANCELLED", "CANCELLED", {}, "Cancelled"),
        ):
            with self.subTest(status=status):
                final = UiFinalResult("engine", outcome=envelope(result(status, reason, **options)),
                                     workflow_version="agentic-exploration-v1")
                app = AppTest.from_function(_render_result, args=(final,)).run()
                app.text_input[0].set_value("https://public.example.org/")
                app.text_area[0].set_value("Test")
                app.button[0].click().run()
                rendered = " ".join(element.value for element in app if hasattr(element, "value") and
                                    isinstance(element.value, str))
                self.assertIn(label, rendered)
                self.assertIn("Workflow: agentic-exploration-v1", rendered)
                if status not in {"QA_ASSERTION_PASSED", "QA_ASSERTION_FAILED"}:
                    self.assertNotIn("QA failed", rendered)


if __name__ == "__main__": unittest.main()

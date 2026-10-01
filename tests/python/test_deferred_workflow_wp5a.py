"""Offline closed Python/host/UI boundary for the gated deferred workflow."""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo.protocol import InvalidWire
from playwright_demo.protocol_v2 import parse_response
from playwright_demo.report_projection_v2 import parse_report_projection
from playwright_demo.host import HostCallResult, call_node
from playwright_demo.ui_workflow import UiFinalResult, run_ui_workflow
from playwright_demo.ui_shell import UiRequest
from tests.python.test_agentic_external_v2 import result, envelope, REF, _render_result
from streamlit.testing.v1 import AppTest


def wire(status="QA_ASSERTION_PASSED"):
    value = result("QA_ASSERTION_PASSED", None, trace=True, compiled=True, runs=2)
    value["workflowVersion"] = "deferred-action-v1"
    value["deferredReplay"] = {"orchestrationVersion": "1", "orchestrationId": "pairone",
        "sourceSchemaVersion": "6", "sourceContractVersion": "2", "traceVersion": "5",
        "compilerVersion": "4", "resolvedSchemaVersion": "9", "runnerVersion": "9",
        **{key: "b" * 64 for key in ("sourceDigest", "admissionDigest", "traceDigest", "compilerDigest", "resolvedDigest", "orchestrationDigest")},
        "executionSessionIds": ["sessionone", "sessiontwo"], "runDigests": ["c" * 64, "d" * 64]}
    if status == "EXECUTION_REPRODUCED": value["terminal"] = {"stage": "execution", "status": status, "reason": "NO_ASSERTIONS"}
    elif status == "QA_ASSERTION_FAILED": value["terminal"] = {"stage": "qa", "status": status, "reason": "REDACTED_REASON"}
    elif status == "REPRODUCIBILITY_FAILED": value["terminal"] = {"stage": "reproducibility", "status": status, "reason": "REPLAY_OUTCOMES_DISAGREE"}
    return envelope(value, "available")


def projection(value):
    record = value["context"]["result"]
    stage = record["terminal"]["stage"]
    state = "completed_execution" if stage == "execution" else "completed_false" if record["terminal"]["status"] == "QA_ASSERTION_FAILED" else "completed_true"
    p = {"reportProjectionVersion": "2", "workflowVersion": "deferred-action-v1", "kind": "available", "result": record,
         "replays": [{"executionRunId": run, "state": state, "assertionCount": 0 if stage == "execution" else 1, "cleanup": "verified"} for run in record["executionRunIds"]],
         "reproducibility": "disagreed" if stage == "reproducibility" else "agreed"}
    if stage == "qa": p["authoritativeQa"] = record["terminal"]["status"]
    return p


class DeferredBoundaryTests(unittest.TestCase):
    def test_qa_false_disagreement_and_assertion_free_are_distinct(self):
        for status, exitcode in (("QA_ASSERTION_PASSED", 0), ("QA_ASSERTION_FAILED", 1), ("REPRODUCIBILITY_FAILED", 2), ("EXECUTION_REPRODUCED", 2)):
            value = wire(status)
            self.assertEqual(parse_response(json.dumps(value).encode(), REF)[1], exitcode)
            self.assertEqual(parse_report_projection(json.dumps(projection(value)).encode(), value)["kind"], "available")

    def test_closed_linkage_tamper_and_old_route_isolation(self):
        for change in (lambda r: r.pop("deferredReplay"), lambda r: r.update(workflowVersion="structured-action-v1"),
                       lambda r: r["deferredReplay"].update(runnerVersion="8"), lambda r: r["deferredReplay"].update(executionSessionIds=["same", "same"]),
                       lambda r: r["deferredReplay"].update(runDigests=[]), lambda r: r.update(privateSource="secret")):
            value = wire(); change(value["context"]["result"])
            with self.assertRaises(InvalidWire): parse_response(json.dumps(value).encode(), REF)
        value = wire("EXECUTION_REPRODUCED"); value["kind"] = "success"; value.pop("stopKind")
        with self.assertRaises(InvalidWire): parse_response(json.dumps(value).encode(), REF)

    def test_projection_rejects_private_or_contradictory_fields(self):
        value = wire("EXECUTION_REPRODUCED")
        for change in (lambda p: p.update(rawGuard="secret"), lambda p: p.update(authoritativeQa="QA_ASSERTION_PASSED"),
                       lambda p: p["replays"][0].update(actual="secret"), lambda p: p["replays"][0].update(assertionCount=True),
                       lambda p: p["result"].update(testSpecId="other"), lambda p: p.update(reportProjectionVersion="1")):
            p = copy.deepcopy(projection(value)); change(p)
            with self.assertRaises(InvalidWire): parse_report_projection(json.dumps(p).encode(), value)

    def test_closed_stage_stops_have_no_replay_authority(self):
        r = result(); r["workflowVersion"] = "deferred-action-v1"
        r["deferredStage"] = {"integrationVersion": "1", "sourceSchemaVersion": "6", "sourceContractVersion": "2", "stage": "grounding", "category": "unresolved", "code": "NON_UNIQUE", "sourceDigest": "b" * 64, "admissionDigest": "c" * 64}
        parse_response(json.dumps(envelope(r)).encode(), REF)
        for change in (lambda x: x["deferredStage"].pop("sourceDigest"), lambda x: x["deferredStage"].pop("admissionDigest"),
                       lambda x: x["deferredStage"].update(stage="interpretation"), lambda x: x["deferredStage"].update(traceDigest="d" * 64)):
            invalid = copy.deepcopy(r); change(invalid)
            with self.assertRaises(InvalidWire): parse_response(json.dumps(envelope(invalid)).encode(), REF)
        r["deferredStage"]["code"] = "private page text"
        with self.assertRaises(InvalidWire): parse_response(json.dumps(envelope(r)).encode(), REF)

    def test_stop_codes_match_node(self):
        import re
        from playwright_demo.deferred_stage_codes import STAGE_CODES
        source = (ROOT / "app/domain/deferred-workflow.ts").read_text().split("const digest")[0]
        self.assertEqual(STAGE_CODES, frozenset(re.findall(r"'([A-Z][A-Z_]+)'", source)))

    def test_gated_host_ui_selection_and_safe_projection(self):
        request = UiRequest("https://public.example.org/", "Select Option 1.")
        with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE": ""}), patch("playwright_demo.ui_workflow.lookup_public_admission") as admission:
            self.assertEqual(run_ui_workflow(request, config_path="trusted", workflow_version="deferred-action-v1").kind, "workflow_unavailable")
            admission.assert_not_called()
        value = wire("EXECUTION_REPRODUCED")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for relative in ("dist/profile/admission-cli.js", "dist/subprocess/agentic-cli.js",
                             "dist/subprocess/deferred-report-projection-cli.js", "dist/subprocess/report-projection-v2-cli.js"):
                p = root / relative; p.parent.mkdir(parents=True, exist_ok=True); p.touch()
            approval = {"kind": "approved", "admissionVersion": "1", "canonicalUrl": request.target_url, "executionProfileRef": REF, "profileFingerprint": "a" * 64}
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE": "offline-review"}), patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approval), patch("playwright_demo.ui_workflow.call_node", return_value=HostCallResult(value)) as child, patch("playwright_demo.ui_workflow.call_report_projection_v2", return_value=HostCallResult(projection(value))) as project:
                final = run_ui_workflow(request, config_path="trusted", build_root=root, workflow_version="deferred-action-v1")
                self.assertEqual(final.projection, projection(value))
                self.assertEqual(child.call_args.kwargs["environment"]["PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE"], "offline-review")
                self.assertEqual(child.call_args.kwargs["deadline_ms"], 1_200_000)
                self.assertEqual(project.call_args.kwargs["node_entry"].name, "deferred-report-projection-cli.js")
                run_ui_workflow(request, config_path="trusted", build_root=root,
                                workflow_version="deferred-action-v1", deadline_ms=120_000)
                self.assertEqual(child.call_args.kwargs["deadline_ms"], 120_000)
                run_ui_workflow(request, config_path="trusted", build_root=root,
                                workflow_version="structured-action-v1")
                self.assertEqual(child.call_args.kwargs["deadline_ms"], 300_000)
            entry = root / "child.py"
            entry.write_text("import sys\nsys.stdin.buffer.read()\nsys.stdout.write(" + repr(json.dumps(value)) + ")\nsys.exit(2)\n")
            response = call_node({"protocolVersion": "2", "request": {"taskText": request.task_text, "targetUrl": request.target_url, "executionProfileRef": REF}}, node_entry=entry, config_path="unused", node_executable=sys.executable, protocol_version="2")
            self.assertEqual(response.outcome["kind"], "typed_stop")

    def test_ui_assertion_free_is_non_qa_and_no_evidence_fields(self):
        value = wire("EXECUTION_REPRODUCED")
        final = UiFinalResult("engine", outcome=value, projection=projection(value), workflow_version="deferred-action-v1")
        app = AppTest.from_function(_render_result, args=(final,)).run()
        app.text_input[0].set_value("https://public.example.org/"); app.text_area[0].set_value("Test"); app.button[0].click().run()
        self.assertEqual(len(app.exception), 0)
        text = " ".join(e.value for e in app if hasattr(e, "value") and isinstance(e.value, str))
        self.assertIn("Execution reproduced without assertions; no QA verdict", text)
        self.assertNotIn("QA passed", text); self.assertNotIn("QA failed", text)
        self.assertNotIn("Screenshot:", text)


if __name__ == "__main__": unittest.main()

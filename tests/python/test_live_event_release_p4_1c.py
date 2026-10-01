"""P4-1C release gate for the Node -> loopback -> Python -> Streamlit event path.

The public browser proof is opt-in because it starts the Docker compartment and
uses the exact reviewed Challenging DOM profile. The injected Node harness has
fixed model adapters and never reads or needs OPENAI_API_KEY.
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
from playwright_demo.live_events import (  # noqa: E402
    MAX_BYTES, MAX_FRAME, InvalidEvent, LiveEventBuffer,
    parse_event_frame,
)

HARNESS = ROOT / "dist" / "subprocess" / "test-harness.js"
STREAMLIT_APP = ROOT / "src" / "playwright_demo" / "streamlit_app.py"
RUNTIME_ENABLED = os.environ.get("PUBLIC_BROWSER_P4_1_RUNTIME") == "1"
CONFIG_SOURCE_TEXT = os.environ.get("PUBLIC_BROWSER_P4_1_CONFIG")
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


def _base_event(buffer: LiveEventBuffer, sequence: int, kind: str,
                context: dict[str, object] | None, data: dict[str, object]) -> bytes:
    frame = {
        "eventStreamVersion": "1", "streamId": buffer.stream_id,
        "sequence": sequence, "occurredAt": "2026-09-23T00:00:00.000Z",
        "kind": kind, "context": context, "data": data,
    }
    return (json.dumps(frame, separators=(",", ":")) + "\n").encode()


def _identity_context() -> dict[str, object]:
    return {"testSpecId": "p4one", "executionProfileRef": PROFILE,
            "profileFingerprint": "a" * 64}


def _fake_child_source(mode: str) -> str:
    """Independent child for protocol edge tests; no Node/model/browser authority."""
    return f'''import json, os, socket, sys, time
sys.stdin.buffer.read()
host = socket.create_connection(("127.0.0.1", int(os.environ["PLAYWRIGHT_DEMO_EVENT_PORT"])))
stream = os.environ["PLAYWRIGHT_DEMO_EVENT_STREAM_ID"]
hello = {{"eventStreamVersion":"1","kind":"hello","streamId":stream,
         "capability":os.environ["PLAYWRIGHT_DEMO_EVENT_CAPABILITY"]}}
host.sendall((json.dumps(hello)+"\\n").encode())
reader = host.makefile("rb")
assert json.loads(reader.readline())["kind"] == "ready"
frame = {{"eventStreamVersion":"1","streamId":stream,"sequence":1,
 "occurredAt":"2026-09-23T00:00:00.000Z","kind":"workflow_started",
 "context":{{"testSpecId":"childtest","executionProfileRef":{{"id":"testprofile","version":"1"}},
 "profileFingerprint":"{"a" * 64}"}},"data":{{}}}}
host.sendall((json.dumps(frame)+"\\n").encode())
mode = {mode!r}
if mode == "malformed":
 host.sendall(b'{{"eventStreamVersion":"1","streamId":"'+stream.encode()+b'","sequence":2,"occurredAt":"2026-09-23T00:00:01.000Z","kind":"workflow_started","context":{{}},"data":{{"pageText":"private"}}}}\\n')
elif mode == "timeout":
 time.sleep(10)
else:
 host.close()
outcome = {{"protocolVersion":"1","kind":"bridge_error","code":"WORKFLOW_FAILED","cleanup":"not_started"}}
sys.stdout.write(json.dumps(outcome)+"\\n"); sys.stdout.flush(); sys.exit(64)
'''


class P4LiveEventReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        required = (HARNESS, ROOT / "dist" / "profile" / "admission-cli.js",
                    ROOT / "dist" / "subprocess" / "report-projection-cli.js")
        if not all(path.is_file() for path in required):
            raise unittest.SkipTest("Run npm run build before P4-1C event release tests")
        if RUNTIME_ENABLED and (CONFIG_SOURCE is None or not CONFIG_SOURCE.is_file()):
            raise RuntimeError("P4-1C runtime proof requires PUBLIC_BROWSER_P4_1_CONFIG")

    def test_python_accepts_truncation_marker_with_display_cap_and_terminal(self):
        buffer = LiveEventBuffer()
        context = _identity_context()
        sent = [_base_event(buffer, 1, "workflow_started", context, {})]
        buffer.add(sent[-1])
        for sequence in range(2, 255):
            sent.append(_base_event(buffer, sequence, "interpretation_started", context, {}))
            buffer.add(sent[-1])
        sent.append(_base_event(buffer, 255, "stream_truncated", context,
                                {"cause": "event_limit"}))
        buffer.add(sent[-1])
        sent.append(_base_event(buffer, 256, "terminal", None,
                                {"resultKind": "bridge_error", "code": "WORKFLOW_FAILED",
                                 "cleanup": "not_started"}))
        buffer.add(sent[-1])
        self.assertLessEqual(sum(map(len, sent)), MAX_BYTES)
        final = {"kind": "bridge_error", "code": "WORKFLOW_FAILED", "cleanup": "not_started"}
        buffer.reconcile(final)
        state, omitted, events = buffer.snapshot()
        self.assertEqual(state, "live")
        self.assertEqual(omitted, 128)
        self.assertEqual(len(events), 128)
        self.assertEqual(events[-2]["kind"], "stream_truncated")
        self.assertEqual(events[-1]["kind"], "terminal")
        self.assertLessEqual(max(len(_base_event(buffer, event["sequence"], event["kind"],
                                                  event["context"], event["data"]))
                                 for event in events), MAX_FRAME)

    def test_python_denies_stream_limit_overflow_and_malformed_payload(self):
        buffer = LiveEventBuffer()
        context = _identity_context()
        buffer.add(_base_event(buffer, 1, "workflow_started", context, {}))
        with self.assertRaises(InvalidEvent):
            buffer.add(_base_event(buffer, 3, "interpretation_started", context, {}))
        self.assertEqual(buffer.snapshot()[0], "unavailable")

        oversized = b"{" + b" " * MAX_FRAME + b"}\n"
        with self.assertRaises(InvalidEvent):
            parse_event_frame(oversized, buffer.stream_id)
        self.assertGreater(len(oversized), MAX_FRAME)
        self.assertLessEqual(MAX_BYTES, 256 * 1024)

    def test_malformed_authenticated_child_stream_does_not_change_v1_result(self):
        self._assert_fake_child("malformed", expected_code="WORKFLOW_FAILED", timeout_ms=5000)

    def test_disconnect_after_started_child_stream_does_not_change_v1_result(self):
        self._assert_fake_child("disconnect", expected_code="WORKFLOW_FAILED", timeout_ms=5000)

    def test_child_deadline_marks_only_timeline_unavailable_and_reaps_process(self):
        self._assert_fake_child("timeout", expected_code="DEADLINE_EXCEEDED", timeout_ms=300)

    def _assert_fake_child(self, mode: str, *, expected_code: str, timeout_ms: int) -> None:
        request = {"protocolVersion": "1", "request": {
            "taskText": "Check a page.", "targetUrl": "https://example.org/",
            "executionProfileRef": PROFILE,
        }}
        with tempfile.TemporaryDirectory(prefix="p4-event-child-") as temporary:
            child = Path(temporary) / "event_child.py"
            child.write_text(_fake_child_source(mode), encoding="utf-8")
            environment = dict(os.environ)
            environment.pop("OPENAI_API_KEY", None)
            buffer = LiveEventBuffer()
            result = call_node(request, node_entry=child,
                               config_path="trusted-event-test-config",
                               node_executable=sys.executable,
                               deadline_ms=timeout_ms, environment=environment,
                               live_events=buffer)
        if mode == "timeout":
            self.assertEqual(result.outcome["kind"], "process_failure")
            self.assertEqual(result.outcome["code"], expected_code)
            self.assertEqual(result.outcome["cleanup"], "unverified")
            self.assertEqual(buffer.snapshot()[0], "unavailable")
        else:
            self.assertEqual(result.outcome["kind"], "bridge_error", result.outcome)
            self.assertEqual(result.outcome["code"], expected_code)
            self.assertEqual(buffer.snapshot()[0], "unavailable")
            prior = buffer.snapshot()[2]
            self.assertEqual([event["kind"] for event in prior], ["workflow_started"])
            self.assertNotIn("pageText", json.dumps(prior))

    @unittest.skipUnless(RUNTIME_ENABLED, "Opt-in exact-profile protected-browser event proof")
    def test_streamlit_node_python_channel_exact_profile_success_and_report(self):
        """Full credential-free success through the UI and real protected browser."""
        with tempfile.TemporaryDirectory(prefix="p4-1c-artifacts-") as temporary:
            root = Path(temporary)
            assert CONFIG_SOURCE is not None
            config = json.loads(CONFIG_SOURCE.read_text(encoding="utf-8"))
            # Keep the production approval/profile/policy bit-for-bit; only the
            # trusted artifact root is redirected to disposable test storage.
            config["artifactRoot"] = str(root / "artifacts")
            trusted_config = root / "trusted.json"
            trusted_config.write_text(json.dumps(config), encoding="utf-8")
            approval = config["publicTargetApproval"]
            self.assertEqual(approval["targetUrl"], TARGET)
            self.assertEqual(approval["admissionVersion"], "1")
            self.assertTrue(approval["executionProfileRef"]["id"].startswith("admitted-public-"))
            profile_ref = approval["executionProfileRef"]
            fingerprint = approval["profileFingerprint"]
            environment = dict(os.environ)
            environment.pop("OPENAI_API_KEY", None)
            environment["PLAYWRIGHT_DEMO_TRUSTED_CONFIG"] = str(trusted_config)

            def injected_engine(request, **kwargs):
                self.assertEqual(request["protocolVersion"], "1")
                self.assertEqual(request["request"], {
                    "taskText": TASK, "targetUrl": TARGET,
                    "executionProfileRef": profile_ref,
                })
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
                self.assertTrue(active.done.wait(180), "P4-1C protected workflow did not finish")
                app.run(timeout=10)
                for _ in range(3):
                    if app.session_state.playwright_demo_ui_status.phase == "completed":
                        break
                    app.run(timeout=10)

            self.assertFalse(app.exception)
            status = app.session_state.playwright_demo_ui_status
            self.assertEqual(status.phase, "completed", status)
            self.assertFalse(status.host_error, status)
            result = status.result
            self.assertIsNotNone(result)
            self.assertEqual(result.kind, "engine")
            outcome = result.outcome
            failed_facts = [(event["sequence"], event["kind"], event["data"])
                            for event in active.events.snapshot()[2]]
            self.assertEqual(outcome["kind"], "success",
                             {"outcome": outcome, "safeEventFacts": failed_facts})
            self.assertEqual(outcome["terminal"]["status"], "QA_ASSERTION_PASSED")
            self.assertEqual(outcome["context"]["profileFingerprint"], fingerprint)
            self.assertEqual(outcome["context"]["progress"]["stage"], "replayed")
            run_ids = outcome["context"]["progress"]["executionRunIds"]
            self.assertEqual(len(run_ids), 2)
            self.assertEqual(len(set(run_ids)), 2)
            self.assertEqual(result.projection["kind"], "available")
            self.assertEqual(result.projection["outcomes"][-1]["status"], "QA_ASSERTION_PASSED")

            state, omitted, events = active.events.snapshot()
            self.assertEqual(state, "live")
            self.assertLessEqual(len(events), 128)
            self.assertGreaterEqual(omitted, 0)
            self.assertEqual([event["sequence"] for event in events],
                             list(range(events[0]["sequence"], events[0]["sequence"] + len(events))))
            self.assertEqual(events[0]["kind"], "workflow_started")
            self.assertEqual(events[-1]["kind"], "terminal")
            self.assertEqual(events[-1]["data"], {
                "resultKind": "success", "phase": "execution", "status": "QA_ASSERTION_PASSED",
            })
            terminal_context = events[-1]["context"]
            self.assertEqual(terminal_context["testSpecId"], outcome["context"]["testSpecId"])
            self.assertEqual(terminal_context["profileFingerprint"], fingerprint)
            self.assertEqual(terminal_context["executionProfileRef"], profile_ref)

            all_events = [event for event in events]
            kinds = [event["kind"] for event in all_events]
            self.assertIn("interpretation_started", kinds)
            self.assertIn("interpretation_finished", kinds)
            self.assertIn("exploration_started", kinds)
            self.assertIn("resolved_spec_ready", kinds)
            self.assertIn("replay_started", kinds)
            self.assertIn("replay_finished", kinds)
            self.assertIn("report_completed", kinds)
            self.assertEqual([event["data"]["ordinal"] for event in events
                              if event["kind"] == "replay_started"], [1, 2])
            self.assertEqual([event["data"]["status"] for event in events
                              if event["kind"] == "replay_finished"],
                             ["QA_ASSERTION_PASSED", "QA_ASSERTION_PASSED"])
            started = [event for event in events if event["kind"] == "mcp_tool_started"]
            finished = [event for event in events if event["kind"] == "mcp_tool_finished"]
            self.assertGreater(len(started), 0)
            self.assertEqual(len(started), len(finished))
            self.assertEqual({event["data"]["tool"] for event in started},
                             {event["data"]["tool"] for event in finished})
            self.assertTrue(all(event["data"]["outcome"] in {"completed", "failed"}
                                for event in finished))
            locators = [event for event in events if event["kind"] == "locator_assessed"]
            self.assertTrue(any(event["data"]["outcome"] == "rejected" and
                                event["data"]["basis"] == "mcp_generated" for event in locators), locators)
            self.assertTrue(any(event["data"]["outcome"] == "accepted" and
                                event["data"]["basis"] == "semantic_row_scope" for event in locators), locators)

            rendered = " ".join(item.value for item in [*app.markdown, *app.caption,
                                                           *app.success, *app.info])
            self.assertIn("Execution timeline", [item.value for item in app.subheader])
            self.assertIn("QA_ASSERTION_PASSED", rendered)
            self.assertNotIn("OPENAI_API_KEY", rendered)
            self.assertNotIn(str(root), rendered)
            event_payload = json.dumps(events)
            for prohibited in (TASK, "Iuvaret1", "https://", "__cf_chl_rt_tk", "locator expression"):
                self.assertNotIn(prohibited, event_payload)

            docker = subprocess.run(
                ["docker", "ps", "-a", "--filter", "name=public-browser-g1-", "--format", "{{.Names}} {{.Status}}"],
                capture_output=True, text=True, timeout=15, check=False,
            )
            self.assertEqual(docker.returncode, 0, docker.stderr)
            self.assertEqual(docker.stdout.strip(), "")
            print("P4_1_SAFE_EVIDENCE=" + json.dumps({
                "profile": profile_ref, "profileFingerprint": fingerprint,
                "testSpecId": outcome["context"]["testSpecId"],
                "explorationAttemptId": outcome["context"]["progress"]["explorationAttemptId"],
                "resolvedSpecId": outcome["context"]["progress"]["resolvedSpecId"],
                "executionRunIds": run_ids, "eventKinds": kinds,
                "eventCount": len(events), "omittedOlderEvents": omitted,
                "terminalStatus": events[-1]["data"]["status"],
                "reportProjection": result.projection["kind"], "residualContainers": False,
            }, separators=(",", ":")))


if __name__ == "__main__":
    unittest.main()

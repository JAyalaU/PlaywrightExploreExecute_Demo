"""P4-1B host-side closed channel and v1 compatibility regressions."""

from pathlib import Path
import json
import socket
import sys
import threading
import time
import unittest
from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import call_node  # noqa: E402
from playwright_demo.live_events import (  # noqa: E402
    EventChannel, InvalidEvent, LiveEventBuffer, parse_event_frame,
)
from playwright_demo.ui_workflow import UiFinalResult  # noqa: E402


def _live_ui_fixture():
    import json
    import time
    from playwright_demo.ui_shell import render_shell
    from playwright_demo.ui_workflow import UiFinalResult
    def execute(_request, *, live_events, cancel_event):
        terminal = {"eventStreamVersion": "1", "streamId": live_events.stream_id,
                    "sequence": 1, "occurredAt": "2026-09-23T00:00:00.000Z",
                    "kind": "terminal", "context": None,
                    "data": {"resultKind": "bridge_error", "code": "DESTINATION_DENIED",
                             "cleanup": "not_started"}}
        live_events.add((json.dumps(terminal) + "\n").encode())
        time.sleep(0.05)
        return UiFinalResult("engine", {"kind": "bridge_error",
                                        "code": "DESTINATION_DENIED", "cleanup": "not_started"})
    render_shell(execute, live=True)


def _inconsistent_live_ui_fixture():
    import json
    from playwright_demo.ui_shell import render_shell
    from playwright_demo.ui_workflow import UiFinalResult

    def execute(_request, *, live_events, cancel_event):
        event = {"eventStreamVersion": "1", "streamId": live_events.stream_id,
                 "sequence": 1, "occurredAt": "2026-09-23T00:00:00.000Z",
                 "kind": "terminal", "context": None,
                 "data": {"resultKind": "bridge_error", "code": "DESTINATION_DENIED",
                          "cleanup": "not_started"}}
        live_events.add((json.dumps(event) + "\n").encode())
        outcome = {"kind": "bridge_error", "code": "INVALID_TRUSTED_CONFIGURATION",
                   "cleanup": "not_started"}
        live_events.reconcile(outcome)
        return UiFinalResult("engine", outcome)

    render_shell(execute, live=True)

REF = {"id": "testprofile", "version": "1"}
REQUEST = {"protocolVersion": "1", "request": {
    "taskText": "Check a page.", "targetUrl": "https://example.org/",
    "executionProfileRef": REF}}


def _frame(buffer: LiveEventBuffer, **changes):
    value = {"eventStreamVersion": "1", "streamId": buffer.stream_id,
             "sequence": 1, "occurredAt": "2026-09-23T00:00:00.000Z",
             "kind": "workflow_started", "context": {
                 "testSpecId": "testone", "executionProfileRef": REF,
                 "profileFingerprint": "a" * 64}, "data": {}}
    value.update(changes)
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


class LiveEventTests(unittest.TestCase):
    def test_inconsistent_terminal_withholds_timeline_and_preserves_v1_result(self):
        buffer = LiveEventBuffer()
        terminal = {"eventStreamVersion": "1", "streamId": buffer.stream_id,
                    "sequence": 1, "occurredAt": "2026-09-23T00:00:00.000Z",
                    "kind": "terminal", "context": None,
                    "data": {"resultKind": "bridge_error", "code": "DESTINATION_DENIED",
                             "cleanup": "not_started"}}
        buffer.add((json.dumps(terminal) + "\n").encode())
        final = {"kind": "bridge_error", "code": "INVALID_TRUSTED_CONFIGURATION",
                 "cleanup": "not_started"}
        buffer.reconcile(final)
        self.assertEqual(buffer.snapshot(), ("inconsistent", 0, []))
        self.assertEqual(final["code"], "INVALID_TRUSTED_CONFIGURATION")

    def test_inconsistent_qa_preview_withholds_prior_events_without_reclassifying_qa(self):
        buffer = LiveEventBuffer()
        context = {"testSpecId": "testone", "executionProfileRef": REF,
                   "profileFingerprint": "a" * 64}
        buffer.add(_frame(buffer))
        preview = {"eventStreamVersion": "1", "streamId": buffer.stream_id,
                   "sequence": 2, "occurredAt": "2026-09-23T00:00:01.000Z",
                   "kind": "terminal", "context": context,
                   "data": {"resultKind": "success", "phase": "execution",
                            "status": "QA_ASSERTION_PASSED"}}
        buffer.add((json.dumps(preview) + "\n").encode())
        final = {"kind": "typed_stop", "stopKind": "qa_failure",
                 "terminal": {"phase": "execution", "status": "QA_ASSERTION_FAILED",
                              "reason": "URL_MISMATCH"},
                 "context": {**context, "progress": {"stage": "not_started"}}}
        buffer.reconcile(final)
        self.assertEqual(buffer.snapshot(), ("inconsistent", 0, []))
        self.assertEqual(final["terminal"]["status"], "QA_ASSERTION_FAILED")

    def test_streamlit_withholds_inconsistent_events_but_shows_final_v1_result(self):
        app = AppTest.from_function(_inconsistent_live_ui_fixture).run()
        app.text_input[0].set_value("https://example.org/")
        app.text_area[0].set_value("Check the page.")
        app.button[0].click().run()
        for _ in range(20):
            if app.session_state.playwright_demo_ui_status.phase == "completed":
                break
            time.sleep(0.05)
            app.run()
        self.assertFalse(app.exception)
        self.assertEqual(app.session_state.playwright_demo_ui_status.phase, "completed")
        self.assertEqual(app.session_state.playwright_demo_ui_status.result.outcome["code"],
                         "INVALID_TRUSTED_CONFIGURATION")
        visible = " ".join(item.value for item in app.markdown)
        warnings = " ".join(item.value for item in app.warning)
        errors = " ".join(item.value for item in app.error)
        self.assertIn("Live timeline inconsistent", warnings)
        self.assertIn("Node bridge error: INVALID_TRUSTED_CONFIGURATION", errors)
        self.assertNotIn("DESTINATION_DENIED", visible)
        self.assertNotIn("1. terminal", visible)

    def test_streamlit_live_shell_runs_once_and_renders_typed_result(self):
        app = AppTest.from_function(_live_ui_fixture).run()
        app.text_input[0].set_value("https://example.org/")
        app.text_area[0].set_value("Check the page.")
        app.button[0].click().run()
        time.sleep(0.1)
        app.run()
        self.assertFalse(app.exception)
        status = app.session_state.playwright_demo_ui_status
        self.assertEqual(status.phase, "completed")
        self.assertFalse(status.host_error, status)
        self.assertEqual(status.result.kind, "engine")
        self.assertIn("terminal", " ".join(item.value for item in app.markdown))
    def test_closed_parser_denies_arbitrary_page_text_and_duplicate_keys(self):
        buffer = LiveEventBuffer()
        parsed = parse_event_frame(_frame(buffer), buffer.stream_id)
        self.assertEqual(parsed["kind"], "workflow_started")
        for change in ({"pageText": "secret"}, {"eventStreamVersion": "2"},
                       {"kind": "raw_provider_output"}):
            with self.subTest(change=change), self.assertRaises(InvalidEvent):
                parse_event_frame(_frame(buffer, **change), buffer.stream_id)
        duplicate = _frame(buffer).replace(b'"sequence":1,', b'"sequence":1,"sequence":1,')
        with self.assertRaises(InvalidEvent):
            parse_event_frame(duplicate, buffer.stream_id)
        with self.assertRaises(InvalidEvent):
            parse_event_frame(_frame(buffer)[:-1] + b" " * 2048 + b"\n", buffer.stream_id)
        with self.assertRaises(InvalidEvent):
            parse_event_frame(_frame(buffer).replace(b'"data":{}', b'"data":{"pageText":"private"}'),
                              buffer.stream_id)

    def test_sequence_and_correlation_fail_closed(self):
        buffer = LiveEventBuffer()
        buffer.add(_frame(buffer))
        with self.assertRaises(InvalidEvent):
            buffer.add(_frame(buffer, sequence=3))
        self.assertEqual(buffer.snapshot()[0], "unavailable")

    def test_invalid_capability_never_gets_ready(self):
        buffer = LiveEventBuffer()
        channel = EventChannel(buffer)
        channel.start()
        try:
            with socket.create_connection(("127.0.0.1", channel.port), timeout=1) as peer:
                hello = {"eventStreamVersion": "1", "kind": "hello",
                         "streamId": buffer.stream_id, "capability": "0" * 64}
                peer.sendall((json.dumps(hello) + "\n").encode())
                self.assertEqual(peer.recv(4096), b"")
            self.assertEqual(buffer.snapshot()[0], "unavailable")
        finally:
            channel.close()

    def test_disconnect_after_valid_start_marks_only_timeline_unavailable(self):
        buffer = LiveEventBuffer()
        channel = EventChannel(buffer)
        channel.start()
        try:
            with socket.create_connection(("127.0.0.1", channel.port), timeout=1) as peer:
                hello = {"eventStreamVersion": "1", "kind": "hello",
                         "streamId": buffer.stream_id, "capability": channel.capability}
                peer.sendall((json.dumps(hello) + "\n").encode())
                ready = peer.recv(4096)
                self.assertIn(b'"ready"', ready)
                peer.sendall(_frame(buffer))
            channel.wait_for_eof()
            state, _, events = buffer.snapshot()
            self.assertEqual(state, "unavailable")
            self.assertEqual([event["kind"] for event in events], ["workflow_started"])
        finally:
            channel.close()

    def test_built_node_entry_keeps_single_v1_result_with_live_channel(self):
        entry = ROOT / "dist" / "subprocess" / "cli.js"
        if not entry.exists(): self.skipTest("Build Node before host integration")
        buffer = LiveEventBuffer()
        result = call_node(REQUEST, node_entry=entry,
                           config_path=ROOT / "missing-p4-1b-config.json",
                           live_events=buffer, deadline_ms=15_000)
        self.assertEqual(result.outcome["kind"], "bridge_error", result.outcome)
        self.assertEqual(result.outcome["code"], "INVALID_TRUSTED_CONFIGURATION")
        state, _, events = buffer.snapshot()
        self.assertEqual(state, "live")
        self.assertEqual([event["kind"] for event in events], ["terminal"])
        self.assertEqual(events[0]["data"]["resultKind"], "bridge_error")

    def test_injected_model_interpretation_stop_streams_before_final_v1_result(self):
        harness = ROOT / "dist" / "subprocess" / "test-harness.js"
        config = ROOT / "config" / "public-challenging-dom.json"
        if not harness.exists(): self.skipTest("Build Node before harness integration")
        request = {"protocolVersion": "1", "request": {
            "taskText": "Ambiguous task.",
            "targetUrl": "https://the-internet.herokuapp.com/challenging_dom",
            "executionProfileRef": {"id": "challenging-dom-public-headless", "version": "1"}}}
        buffer = LiveEventBuffer()
        result = call_node(request, node_entry=harness, config_path=config,
                           live_events=buffer, deadline_ms=30_000)
        self.assertEqual(result.outcome["kind"], "typed_stop", result.outcome)
        self.assertEqual(result.outcome["terminal"]["status"], "AMBIGUOUS_INSTRUCTION")
        state, omitted, events = buffer.snapshot()
        self.assertEqual(state, "live")
        self.assertEqual(omitted, 0)
        self.assertEqual([event["kind"] for event in events[:3]],
                         ["workflow_started", "interpretation_started", "interpretation_finished"])
        self.assertEqual(events[-1]["kind"], "terminal")
        self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))

    def test_existing_cancellation_path_reaps_child_and_interrupts_timeline(self):
        harness = ROOT / "dist" / "subprocess" / "test-harness.js"
        if not harness.exists(): self.skipTest("Build Node before cancellation integration")
        request = {"protocolVersion": "1", "request": {
            "taskText": "Wait forever.",
            "targetUrl": "https://the-internet.herokuapp.com/challenging_dom",
            "executionProfileRef": {"id": "challenging-dom-public-headless", "version": "1"}}}
        cancel = threading.Event()
        buffer = LiveEventBuffer()
        timer = threading.Timer(0.5, cancel.set)
        timer.start()
        try:
            result = call_node(request, node_entry=harness,
                               config_path=ROOT / "config" / "public-challenging-dom.json",
                               live_events=buffer, cancel_event=cancel, deadline_ms=10_000)
        finally:
            timer.cancel()
        self.assertEqual(result.outcome["kind"], "process_failure", result.outcome)
        self.assertEqual(result.outcome["code"], "CANCELLED")
        self.assertEqual(result.outcome["cleanup"], "unverified")


if __name__ == "__main__":
    unittest.main()

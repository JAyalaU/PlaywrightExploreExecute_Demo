"""Closed deferred live-view channel and local UI tests; no provider/browser."""

import json
import socket
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.deferred_live_viewer import (  # noqa: E402
    DeferredViewerBuffer, DeferredViewerChannel, InvalidViewerNotice,
)
from playwright_demo.ui_shell import _render_deferred_viewer, _render_live_viewer_fragment  # noqa: E402
from playwright_demo.ui_shell import UiRequest, UiRun, _active_run, _deferred_viewer_buffers  # noqa: E402
from playwright_demo.ui_workflow import UiFinalResult  # noqa: E402


def notice(buffer, sequence, kind, phase, owner, **change):
    value = {"deferredViewerVersion": "1", "streamId": buffer.stream_id,
             "sequence": sequence, "kind": kind, "phase": phase,
             "ownerId": owner, "testSpecId": "local-fixture"}
    if kind == "ready":
        value.update({"port": 15331, "path": "/rfb", "connectionCapability": "a" * 64,
                      "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()})
    value.update(change)
    return (json.dumps(value) + "\n").encode()


class DeferredViewerTests(unittest.TestCase):
    def test_four_real_owner_phases_clear_old_handle_and_finish(self):
        buffer = DeferredViewerBuffer()
        buffer.mark_connecting()
        owners = (("exploration", "exploration-one"), ("compilation", "compiler-one"),
                  ("replay_1", "run-one"), ("replay_2", "run-two"))
        sequence = 0
        for index, (phase, owner) in enumerate(owners):
            sequence += 1
            buffer.add(notice(buffer, sequence, "ready", phase, owner))
            state, current, handle = buffer.snapshot()
            self.assertEqual((state, current), ("available", phase))
            self.assertEqual(handle["owner"]["id"], owner)
            sequence += 1
            buffer.add(notice(buffer, sequence, "closed", phase, owner))
            self.assertEqual(buffer.snapshot(), ("closed", phase, None))
            if index < len(owners) - 1:
                sequence += 1
                buffer.add(notice(buffer, sequence, "transition", phase, owner))
                self.assertEqual(buffer.snapshot(), ("transitioning", phase, None))
        self.assertEqual([item[0] for item in buffer.history()].count("ready"), 4)

    def test_out_of_order_phase_and_unreviewed_fields_fail_closed(self):
        for change in ({"phase": "replay_1"}, {"path": "/control"},
                       {"pageText": "private"}, {"connectionCapability": "short"}):
            with self.subTest(change=change):
                buffer = DeferredViewerBuffer()
                frame = notice(buffer, 1, "ready", "exploration", "exploration-one")
                value = json.loads(frame)
                value.update(change)
                with self.assertRaises(InvalidViewerNotice):
                    buffer.add((json.dumps(value) + "\n").encode())
                self.assertEqual(buffer.snapshot()[0], "unavailable")

    def test_owner_transition_is_required(self):
        buffer = DeferredViewerBuffer()
        buffer.add(notice(buffer, 1, "ready", "exploration", "exploration-one"))
        buffer.add(notice(buffer, 2, "closed", "exploration", "exploration-one"))
        with self.assertRaises(InvalidViewerNotice):
            buffer.add(notice(buffer, 3, "ready", "compilation", "compiler-one"))
        self.assertEqual(buffer.snapshot()[0], "unavailable")

    def test_reconnect_rotates_the_current_phase_handle(self):
        buffer = DeferredViewerBuffer()
        buffer.add(notice(buffer, 1, "ready", "exploration", "exploration-one"))
        buffer.add(notice(buffer, 2, "ready", "exploration", "exploration-one",
                          connectionCapability="b" * 64))
        self.assertEqual(buffer.snapshot()[2]["connectionCapability"], "b" * 64)
        self.assertEqual(buffer.history()[-1], ("ready", "exploration", "exploration-one"))

    def test_expired_connection_token_does_not_close_established_view(self):
        buffer = DeferredViewerBuffer()
        buffer.add(notice(buffer, 1, "ready", "exploration", "exploration-one"))
        # The one-use token expires while an already-connected RFB stream lives.
        buffer._handle["expiresAt"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        self.assertEqual(buffer.snapshot()[0], "available")
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption"), \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_deferred_viewer(buffer)
        markup = html.call_args.args[0]
        self.assertIn("prior && prior.identity === identity", markup)
        self.assertIn("Date.now() >= Date.parse", markup)
        buffer.add(notice(buffer, 2, "ready", "exploration", "exploration-one",
                          connectionCapability="b" * 64))
        self.assertEqual(buffer.snapshot()[2]["connectionCapability"], "b" * 64)

    def test_authenticated_loopback_channel_consumes_only_current_notices(self):
        buffer = DeferredViewerBuffer()
        channel = DeferredViewerChannel(buffer)
        channel.start()
        try:
            with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
                peer.sendall((json.dumps({"deferredViewerVersion": "1", "kind": "hello",
                                         "streamId": buffer.stream_id,
                                         "capability": channel.capability}) + "\n").encode())
                peer.settimeout(2)
                self.assertEqual(json.loads(peer.makefile("rb").readline())["kind"], "ready")
                peer.sendall(notice(buffer, 1, "ready", "exploration", "exploration-one"))
                for _ in range(40):
                    if buffer.snapshot()[0] == "available": break
                    time.sleep(0.01)
                self.assertEqual(buffer.snapshot()[1], "exploration")
        finally:
            channel.close()
        self.assertEqual(buffer.snapshot()[2], None)

    def test_unexpected_channel_eof_revokes_a_live_handle(self):
        buffer = DeferredViewerBuffer()
        channel = DeferredViewerChannel(buffer)
        channel.start()
        try:
            with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
                peer.sendall((json.dumps({"deferredViewerVersion": "1", "kind": "hello",
                                         "streamId": buffer.stream_id,
                                         "capability": channel.capability}) + "\n").encode())
                peer.settimeout(2)
                self.assertEqual(json.loads(peer.makefile("rb").readline())["kind"], "ready")
                peer.sendall(notice(buffer, 1, "ready", "exploration", "exploration-one"))
                for _ in range(40):
                    if buffer.snapshot()[0] == "available": break
                    time.sleep(0.01)
            channel.wait_for_eof()
            self.assertEqual(buffer.snapshot(), ("unavailable", "exploration", None))
        finally:
            channel.close()

    def test_ui_reuses_view_only_client_and_withholds_it_after_close(self):
        buffer = DeferredViewerBuffer()
        buffer.add(notice(buffer, 1, "ready", "exploration", "exploration-one"))
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption") as caption, \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_deferred_viewer(buffer)
        self.assertIn("Current phase: Exploration", [call.args[0] for call in caption.call_args_list])
        self.assertIn("rfb.viewOnly = true", html.call_args.args[0])
        buffer.add(notice(buffer, 2, "closed", "exploration", "exploration-one"))
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption"), \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_deferred_viewer(buffer)
        self.assertNotIn("viewer." + "a" * 64, html.call_args.args[0])

    def test_trusted_deferred_panel_explains_headed_runtime_without_changing_result(self):
        with patch.dict("os.environ", {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "deferred-action-v1",
                                    "PLAYWRIGHT_DEMO_LIVE_VIEW": "1"}):
            run = UiRun(UiRequest("https://public.example.org/", "Check"), lambda _request: None)
        buffer = _deferred_viewer_buffers[run]
        buffer.add(notice(buffer, 1, "ready", "exploration", "exploration-one"))
        projection = {"qa": "unchanged"}
        run.result = projection
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption") as caption, \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_live_viewer_fragment.__wrapped__(run)
        captions = [call.args[0] for call in caption.call_args_list]
        note = next(value for value in captions if "presentationMode: headless" in value)
        self.assertIn("Chromium in headed mode", note)
        self.assertIn("accepted execution-profile metadata", note)
        self.assertIn("observational only", note)
        self.assertIn("does not affect QA authority", note)
        self.assertIn("Current phase: Exploration", captions)
        self.assertIn("rfb.viewOnly = true", html.call_args.args[0])
        self.assertIs(run.result, projection)
        self.assertEqual(projection, {"qa": "unchanged"})
        operator_text = " ".join(captions)
        for secret in ("a" * 64, "15331", "exploration-one", "/rfb", "container"):
            self.assertNotIn(secret, operator_text)

    def test_deferred_live_view_disabled_omits_runtime_note(self):
        with patch.dict("os.environ", {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "deferred-action-v1",
                                    "PLAYWRIGHT_DEMO_LIVE_VIEW": "0"}):
            run = UiRun(UiRequest("https://public.example.org/", "Check"), lambda _request: None)
        self.assertNotIn(run, _deferred_viewer_buffers)
        with patch("playwright_demo.ui_shell.st.subheader") as subheader, \
             patch("playwright_demo.ui_shell.st.caption") as caption:
            _render_live_viewer_fragment.__wrapped__(run)
        self.assertEqual(subheader.call_args.args[0], "Live browser view")
        self.assertEqual([call.args[0] for call in caption.call_args_list],
                         ["Live view disabled by trusted configuration."])

    def test_trusted_ui_flag_passes_private_viewer_and_closes_it(self):
        received = []
        def execute(_request, **kwargs):
            received.append(kwargs.get("deferred_viewer"))
            return UiFinalResult("admission_denied")
        with patch.dict("os.environ", {"PLAYWRIGHT_DEMO_WORKFLOW_VERSION": "deferred-action-v1",
                                    "PLAYWRIGHT_DEMO_LIVE_VIEW": "1"}):
            run = UiRun(UiRequest("https://public.example.org/", "Check"), execute)
            self.assertTrue(_active_run.acquire(blocking=False))
            run.start()
            run.thread.join(timeout=2)
            self.assertTrue(run.done.is_set())
            self.assertIs(received[0], _deferred_viewer_buffers[run])
            self.assertEqual(_deferred_viewer_buffers[run].snapshot()[0], "closed")


if __name__ == "__main__":
    unittest.main()

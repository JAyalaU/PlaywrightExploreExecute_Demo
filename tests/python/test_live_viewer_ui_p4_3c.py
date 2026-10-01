"""P4-3C UI/host boundary tests without a browser or provider."""

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.host import HostCallResult  # noqa: E402
from playwright_demo.live_events import LiveEventBuffer  # noqa: E402
from playwright_demo.live_viewer import LiveViewerBuffer  # noqa: E402
from playwright_demo.ui_shell import (  # noqa: E402
    UiRequest, UiRun, _active_run, _viewer_buffers,
    _render_live_viewer, _viewer_markup,
)
from playwright_demo.ui_workflow import UiFinalResult, run_ui_workflow  # noqa: E402


def entries(root):
    for relative in ("dist/profile/admission-cli.js", "dist/subprocess/cli.js",
                     "dist/subprocess/report-projection-cli.js"):
        entry = root / relative
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.touch()


def viewer_layout_app():
    from playwright_demo.ui_shell import render_shell
    render_shell(lambda _request: None, live=True)


class ViewerPresentationTests(unittest.TestCase):
    def test_live_view_remains_above_growing_timeline(self):
        app = AppTest.from_function(viewer_layout_app).run()
        app.session_state.playwright_demo_active_run = UiRun(
            UiRequest("https://public.example.org/", "Check"), lambda _request: None)
        app.run()
        self.assertFalse(app.exception)
        headings = [item.value for item in app.subheader]
        self.assertEqual(headings[:2], ["Live browser view", "Status"])

    def test_pinned_client_receives_capability_only_in_websocket_protocol(self):
        expiry = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
        handle = {"port": 15331, "path": "/rfb", "connectionCapability": "a" * 64,
                  "expiresAt": expiry, "owner": {"kind": "attempt", "id": "explore-one"}}
        html = _viewer_markup(handle)
        self.assertIn("/core/rfb.js", html)
        self.assertIn("['binary', \"viewer." + "a" * 64 + "\"]", html)
        self.assertIn("rfb.viewOnly = true", html)
        self.assertLess(html.index("window.__p4LiveViewer = current"),
                        html.index("import("))
        self.assertIn("if (prior && prior.identity === identity)", html)
        self.assertIn("anchor.replaceWith(prior.screen)", html)
        self.assertIn("if (current.cancelled || window.__p4LiveViewer !== current) return", html)
        self.assertNotIn("?", html)
        self.assertNotIn("#", html)
        self.assertNotIn("localStorage", html)
        self.assertNotIn("sessionStorage", html)

    def test_unreviewed_handle_fields_fail_closed_before_html(self):
        expiry = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
        normal = {"port": 15331, "path": "/rfb", "connectionCapability": "a" * 64,
                  "expiresAt": expiry, "owner": {"kind": "run", "id": "run-one"}}
        for changed in ({"path": "/control"}, {"port": 0},
                        {"owner": {"kind": "run", "id": "</script>"}},
                        {"expiresAt": expiry + "</script>"},
                        {"connectionCapability": "short"}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                _viewer_markup({**normal, **changed})

    def test_closed_viewer_withholds_client_and_does_not_change_qa(self):
        viewer = LiveViewerBuffer(LiveEventBuffer())
        viewer.close()
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption") as caption, \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_live_viewer(viewer)
        self.assertIn("Protected browser view closed.", [call.args[0] for call in caption.call_args_list])
        self.assertNotIn("viewer.", html.call_args.args[0])

    def test_connecting_state_has_no_viewer_capability(self):
        viewer = LiveViewerBuffer(LiveEventBuffer())
        viewer.mark_connecting()
        with patch("playwright_demo.ui_shell.st.subheader"), \
             patch("playwright_demo.ui_shell.st.caption") as caption, \
             patch("playwright_demo.ui_shell.st.html") as html:
            _render_live_viewer(viewer)
        self.assertIn("Connecting to the approved headed browser view.",
                      [call.args[0] for call in caption.call_args_list])
        self.assertNotIn("viewer.", html.call_args.args[0])

    def test_headless_or_denied_run_does_not_claim_a_viewer_was_closed(self):
        run = UiRun(UiRequest("https://public.example.org/", "Check"),
                    lambda _request, **_kwargs: UiFinalResult("admission_denied"))
        self.assertTrue(_active_run.acquire(blocking=False))
        run.start(); run.thread.join(timeout=2)
        self.assertTrue(run.done.is_set())
        self.assertEqual(_viewer_buffers[run].snapshot(), ("not_started", None))


class HeadedAdmissionCompositionTests(unittest.TestCase):
    def test_trusted_v2_approval_enables_viewer_channel_without_changing_subprocess_v1(self):
        request = UiRequest("https://public.example.org/", "Check the page")
        approved = {"admissionVersion": "2", "kind": "approved",
                    "canonicalUrl": request.target_url,
                    "executionProfileRef": {"id": "headed-one", "version": "1"},
                    "profileFingerprint": "a" * 64}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); entries(root)
            events = LiveEventBuffer(); viewer = LiveViewerBuffer(events)
            lookups = []

            def lookup(*args, **kwargs):
                lookups.append(kwargs.get("admission_version", "1"))
                return ({"admissionVersion": "1", "kind": "denied"}
                        if lookups[-1] == "1" else approved)

            def node(wire, **kwargs):
                self.assertEqual(wire["protocolVersion"], "1")
                self.assertIs(kwargs["live_viewer"], viewer)
                self.assertIs(kwargs["live_events"], events)
                self.assertEqual(viewer.snapshot(), ("connecting", None))
                return HostCallResult({"protocolVersion": "1", "kind": "process_failure",
                                       "code": "CANCELLED", "cleanup": "unverified"})

            with patch("playwright_demo.ui_workflow.lookup_public_admission", side_effect=lookup), \
                 patch("playwright_demo.ui_workflow.call_node", side_effect=node):
                result = run_ui_workflow(request, config_path="trusted", build_root=root,
                                         live_events=events, live_viewer=viewer)
            self.assertEqual(lookups, ["1", "2"])
            self.assertEqual(result.outcome["code"], "CANCELLED")

    def test_headless_v1_approval_never_receives_viewer_authority(self):
        request = UiRequest("https://public.example.org/", "Check the page")
        approved = {"admissionVersion": "1", "kind": "approved",
                    "canonicalUrl": request.target_url,
                    "executionProfileRef": {"id": "headless-one", "version": "1"},
                    "profileFingerprint": "a" * 64}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); entries(root)
            events = LiveEventBuffer(); viewer = LiveViewerBuffer(events)

            def node(_wire, **kwargs):
                self.assertIsNone(kwargs["live_viewer"])
                return HostCallResult({"protocolVersion": "1", "kind": "process_failure",
                                       "code": "CANCELLED", "cleanup": "unverified"})

            with patch("playwright_demo.ui_workflow.lookup_public_admission", return_value=approved) as lookup, \
                 patch("playwright_demo.ui_workflow.call_node", side_effect=node):
                result = run_ui_workflow(request, config_path="trusted", build_root=root,
                                         live_events=events, live_viewer=viewer)
            lookup.assert_called_once()
            self.assertEqual(result.outcome["code"], "CANCELLED")


if __name__ == "__main__":
    unittest.main()

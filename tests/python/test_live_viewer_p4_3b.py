"""Closed P4-G2 lifecycle denial tests; no browser or provider needed."""

import json
import socket
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.live_events import LiveEventBuffer  # noqa: E402
from playwright_demo.live_viewer import (  # noqa: E402
    InvalidViewerNotice, LiveViewerBuffer, ViewerChannel, parse_viewer_notice,
)

REF = {"id": "headed", "version": "1"}
FINGERPRINT = "a" * 64
OWNER = {"kind": "attempt", "id": "explore-one"}


def _event(events, sequence, kind, context):
    value = {"eventStreamVersion": "1", "streamId": events.stream_id,
             "sequence": sequence, "occurredAt": "2026-09-23T00:00:00.000Z",
             "kind": kind, "context": context, "data": {}}
    events.add((json.dumps(value) + "\n").encode())


def _ready(events, **changes):
    value = {"liveViewerVersion": "1", "streamId": events.stream_id,
             "sequence": 1, "sourceEventSequence": 2,
             "testSpecId": "local-one", "executionProfileRef": REF,
             "profileFingerprint": FINGERPRINT, "owner": OWNER,
             "kind": "ready", "port": 15230, "path": "/rfb",
             "connectionCapability": "b" * 64,
             "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()}
    value.update(changes)
    return (json.dumps(value) + "\n").encode()


def _started():
    events = LiveEventBuffer()
    base = {"testSpecId": "local-one", "executionProfileRef": REF,
            "profileFingerprint": FINGERPRINT}
    _event(events, 1, "workflow_started", base)
    _event(events, 2, "exploration_started", {**base, "explorationAttemptId": OWNER["id"]})
    return events


class LiveViewerTests(unittest.TestCase):
    def test_ready_is_ephemeral_and_event_correlated(self):
        events = _started()
        viewer = LiveViewerBuffer(events)
        viewer.add(_ready(events))
        state, handle = viewer.snapshot()
        self.assertEqual(state, "available")
        self.assertEqual(handle["owner"], OWNER)
        self.assertNotIn("testSpecId", handle)
        viewer.close()
        self.assertEqual(viewer.snapshot(), ("closed", None))

    def test_wrong_owner_future_event_and_injected_fields_fail_closed(self):
        for frame_change in ({"owner": {"kind": "run", "id": "run-one"}},
                             {"sourceEventSequence": 3}, {"profileFingerprint": "c" * 64},
                             {"pageText": "private"},
                             {"path": "/etc/passwd"}, {"connectionCapability": "short"}):
            with self.subTest(frame_change=frame_change):
                events = _started()
                viewer = LiveViewerBuffer(events)
                with self.assertRaises(InvalidViewerNotice): viewer.add(_ready(events, **frame_change))
                self.assertEqual(viewer.snapshot(), ("unavailable", None))

    def test_unavailable_event_timeline_denies_viewer_before_handle(self):
        events = _started()
        viewer = LiveViewerBuffer(events)
        events.mark_unavailable()
        with self.assertRaises(InvalidViewerNotice): viewer.add(_ready(events))
        self.assertEqual(viewer.snapshot(), ("unavailable", None))

    def test_wrong_version_and_expired_token_are_denied(self):
        events = _started()
        for change in ({"liveViewerVersion": "2"},
                       {"expiresAt": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}):
            with self.assertRaises(InvalidViewerNotice):
                parse_viewer_notice(_ready(events, **change), events.stream_id)

    def test_channel_rejects_wrong_capability_before_ready(self):
        events = LiveEventBuffer()
        viewer = LiveViewerBuffer(events)
        channel = ViewerChannel(viewer); channel.start()
        peer = socket.create_connection(("127.0.0.1", channel.port), timeout=2)
        peer.sendall((json.dumps({"liveViewerVersion": "1", "kind": "hello",
                                  "streamId": events.stream_id, "capability": "0" * 64}) + "\n").encode())
        self.assertEqual(peer.recv(1024), b"")
        peer.close(); time.sleep(0.05)
        self.assertEqual(viewer.snapshot(), ("unavailable", None))
        channel.close()


if __name__ == "__main__":
    unittest.main()

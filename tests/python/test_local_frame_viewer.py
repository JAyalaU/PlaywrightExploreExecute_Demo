"""Product frame-v2 channel and observational UI regression tests."""

import base64
import json
import socket
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from playwright_demo.local_frame_viewer import (  # noqa: E402
    InvalidViewerNotice, LocalFrameViewerBuffer, LocalFrameViewerChannel,
)
from playwright_demo.local_frame_ui import render_local_frame_viewer  # noqa: E402


def notice(buffer, sequence, kind, phase="exploration", owner="attempt-one", **change):
    value = {"deferredViewerVersion": "2", "viewerMode": "frame_stream",
             "streamId": buffer.stream_id, "sequence": sequence, "kind": kind,
             "phase": phase, "ownerId": owner, "testSpecId": "local-fixture"}
    if kind == "frame":
        image = b"\xff\xd8fixture\xff\xd9"
        value.update({"mimeType": "image/jpeg", "width": 8, "height": 6,
                      "byteCount": len(image), "imageBase64": base64.b64encode(image).decode()})
    value.update(change)
    return (json.dumps(value) + "\n").encode()


class LocalFrameViewerTests(unittest.TestCase):
    def test_authenticated_channel_and_bounded_jpeg(self):
        buffer = LocalFrameViewerBuffer()
        channel = LocalFrameViewerChannel(buffer)
        channel.start()
        try:
            with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
                peer.sendall((json.dumps({"deferredViewerVersion": "1", "kind": "hello",
                                         "streamId": buffer.stream_id,
                                         "capability": channel.capability}) + "\n").encode())
                peer.settimeout(2)
                self.assertEqual(json.loads(peer.makefile("rb").readline())["kind"], "ready")
                peer.sendall(notice(buffer, 1, "ready"))
                peer.sendall(notice(buffer, 2, "frame"))
                for _ in range(100):
                    if buffer.snapshot()[2] and buffer.snapshot()[2]["frame"] is not None: break
                    time.sleep(0.01)
                self.assertEqual(buffer.snapshot()[2]["frame"], b"\xff\xd8fixture\xff\xd9")
        finally:
            channel.close()
        self.assertIsNone(buffer.snapshot()[2])

    def test_phase_transition_clears_old_image_and_rejects_rfb(self):
        buffer = LocalFrameViewerBuffer()
        buffer.add(notice(buffer, 1, "ready"))
        buffer.add(notice(buffer, 2, "frame"))
        buffer.add(notice(buffer, 3, "closed"))
        buffer.add(notice(buffer, 4, "transition"))
        self.assertEqual(buffer.snapshot(), ("transitioning", "exploration", None))
        buffer.add(notice(buffer, 5, "ready", "compilation", "compiler-one"))
        self.assertIsNone(buffer.snapshot()[2]["frame"])
        with self.assertRaises(InvalidViewerNotice):
            buffer.add(notice(buffer, 6, "ready", "compilation", "compiler-one",
                              deferredViewerVersion="1", path="/rfb"))
        self.assertEqual(buffer.snapshot()[0], "unavailable")

    def test_render_failure_is_non_qa(self):
        buffer = LocalFrameViewerBuffer()
        buffer.add(notice(buffer, 1, "ready"))
        buffer.add(notice(buffer, 2, "frame"))
        st = MagicMock()
        st.image.side_effect = RuntimeError("display failure")
        result = {"terminal": {"status": "QA_ASSERTION_PASSED"}}
        render_local_frame_viewer(buffer, st)
        self.assertEqual(buffer.snapshot()[0], "unavailable")
        st.warning.assert_called_once()
        self.assertEqual(result["terminal"]["status"], "QA_ASSERTION_PASSED")


if __name__ == "__main__":
    unittest.main()

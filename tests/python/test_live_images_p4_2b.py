"""P4-2B image-only channel, denial and local inline rendering tests."""

import io
import base64
import json
import os
import socket
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.live_events import LiveEventBuffer  # noqa: E402
from playwright_demo.live_images import (  # noqa: E402
    ImageChannel, InvalidImage, LiveImageBuffer, parse_header,
)
from playwright_demo.ui_shell import _render_live_image  # noqa: E402

REF = {"id": "testprofile", "version": "1"}
FINGERPRINT = "a" * 64


def _event(buffer, sequence, kind, *, attempt=None):
    context = {"testSpecId": "testone", "executionProfileRef": REF,
               "profileFingerprint": FINGERPRINT}
    if attempt: context["explorationAttemptId"] = attempt
    value = {"eventStreamVersion": "1", "streamId": buffer.stream_id,
             "sequence": sequence, "occurredAt": "2026-09-23T00:00:00.000Z",
             "kind": kind, "context": context, "data": {}}
    buffer.add((json.dumps(value) + "\n").encode())


def _jpeg():
    stream = io.BytesIO()
    Image.new("RGB", (2, 3), "green").save(stream, format="JPEG")
    return stream.getvalue()


def _header(events, data, **changes):
    value = {"liveImageVersion": "1", "streamId": events.stream_id,
             "kind": "frame", "frameSequence": 1, "sourceEventSequence": 2,
             "testSpecId": "testone", "executionProfileRef": REF,
             "profileFingerprint": FINGERPRINT, "owner": {"kind": "attempt", "id": "exploreone"},
             "capturedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
             "mimeType": "image/jpeg", "width": 2, "height": 3, "byteCount": len(data)}
    value.update(changes)
    return value


class ImageChannelTests(unittest.TestCase):
    def setUp(self):
        self.events = LiveEventBuffer()
        _event(self.events, 1, "workflow_started")
        _event(self.events, 2, "exploration_started", attempt="exploreone")
        self.buffer = LiveImageBuffer(self.events)
        self.image = _jpeg()

    def test_valid_frame_inline_display_has_no_media_endpoint_and_expires(self):
        header = _header(self.events, self.image)
        parsed = parse_header((json.dumps(header) + "\n").encode(), self.events.stream_id)
        self.buffer.add(parsed, self.image)
        self.assertEqual(self.buffer.snapshot()[0], "available")
        with patch("playwright_demo.ui_shell.st.html") as html, patch("playwright_demo.ui_shell.st.caption"), \
                patch("playwright_demo.ui_shell.st.subheader"):
            _render_live_image(self.buffer)
        body = html.call_args.args[0]
        self.assertIn('src="data:image/jpeg;base64,', body)
        self.assertNotIn("/media/", body)
        self.assertNotIn("http:", body)
        self.assertNotIn("https:", body)
        self.buffer.end()
        self.assertIsNotNone(self.buffer._expiry_timer)
        self.buffer._ended -= 61
        self.assertEqual(self.buffer.snapshot(), ("closed", None, None))
        with patch("playwright_demo.ui_shell.st.html") as expired_html, \
                patch("playwright_demo.ui_shell.st.caption"), \
                patch("playwright_demo.ui_shell.st.subheader"):
            _render_live_image(self.buffer)
        expired_html.assert_not_called()

    def test_correlation_and_jpeg_denials(self):
        valid = _header(self.events, self.image)
        with self.assertRaises(InvalidImage):
            parse_header((json.dumps({**valid, "path": "C:/secret"}) + "\n").encode(), self.events.stream_id)
        with self.assertRaises(InvalidImage):
            parse_header((json.dumps({**valid, "streamId": "different"}) + "\n").encode(), self.events.stream_id)
        with self.assertRaises(InvalidImage):
            parse_header((json.dumps({**valid, "byteCount": 128 * 1024 + 1}) + "\n").encode(), self.events.stream_id)
        self.buffer.add(valid, self.image)
        with self.assertRaises(InvalidImage): self.buffer.add(valid, self.image)
        # The Node sender is allowed to drop a queued image under backpressure.
        self.buffer.add(_header(self.events, self.image, frameSequence=3), self.image)
        other = LiveImageBuffer(self.events)
        with self.assertRaises(InvalidImage): other.add(valid, b"not-jpeg")
        corrupted = self.image[:len(self.image) // 2] + b"\xff\xd9"
        corrupted_header = _header(self.events, corrupted)
        with self.assertRaises(InvalidImage):
            LiveImageBuffer(self.events).add(corrupted_header, corrupted)
        wrong_owner = LiveImageBuffer(self.events)
        with self.assertRaises(InvalidImage):
            wrong_owner.add(_header(self.events, self.image,
                                    owner={"kind": "attempt", "id": "unknown"}), self.image)
        self.assertEqual(wrong_owner.snapshot()[0], "not_captured")
        self.events.mark_unavailable()
        self.assertEqual(self.buffer.snapshot()[0], "temporarily_unavailable")

    def test_unestablished_owner_and_future_event_are_denied_before_storage(self):
        for changes in ({"owner": {"kind": "attempt", "id": "unknown"}},
                        {"owner": {"kind": "run", "id": "runone"}},
                        {"sourceEventSequence": 3},
                        {"profileFingerprint": "b" * 64}):
            with self.subTest(changes=changes):
                buffer = LiveImageBuffer(self.events)
                with self.assertRaisesRegex(InvalidImage, "event or owner not established"):
                    buffer.add(_header(self.events, self.image, **changes), self.image)
                self.assertEqual(buffer._count, 0)
                self.assertEqual(buffer._total_bytes, 0)
                self.assertEqual(len(buffer._frames), 0)
                self.assertEqual(buffer.snapshot(), ("not_captured", None, None))

    def test_display_revalidates_stored_frame_after_event_stream_becomes_unavailable(self):
        self.buffer.add(_header(self.events, self.image), self.image)
        self.assertEqual(self.buffer.snapshot()[0], "available")
        self.events.mark_unavailable()
        self.assertEqual(self.buffer.snapshot(), ("temporarily_unavailable", None, None))

    def test_single_use_loopback_authentication_and_state(self):
        channel = ImageChannel(self.buffer)
        self.assertEqual(channel.listener.getsockname()[0], "127.0.0.1")
        channel.start()
        with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
            hello = {"liveImageVersion": "1", "kind": "hello", "streamId": self.events.stream_id,
                     "capability": channel.capability}
            peer.sendall((json.dumps(hello) + "\n").encode())
            self.assertIn(b'"ready"', peer.recv(512))
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", channel.port), timeout=1)
            header = _header(self.events, self.image)
            peer.sendall((json.dumps(header) + "\n").encode() + self.image)
            peer.sendall((json.dumps({"liveImageVersion": "1", "streamId": self.events.stream_id,
                                      "kind": "state", "state": "closed"}) + "\n").encode())
            for _ in range(20):
                if self.buffer.snapshot()[0] == "available": break
                time.sleep(0.01)
            self.assertEqual(self.buffer.snapshot()[0], "available")
        channel.close()

    def test_wrong_capability_withholds_frames(self):
        channel = ImageChannel(self.buffer)
        channel.start()
        with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
            peer.sendall((json.dumps({"liveImageVersion": "1", "kind": "hello",
                                      "streamId": self.events.stream_id,
                                      "capability": "0" * 64}) + "\n").encode())
        channel._thread.join(timeout=1)
        self.assertEqual(self.buffer.snapshot()[0], "temporarily_unavailable")
        channel.close()

    def test_authenticated_channel_rejects_future_event_before_buffering_bytes(self):
        channel = ImageChannel(self.buffer)
        channel.start()
        with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
            peer.sendall((json.dumps({"liveImageVersion": "1", "kind": "hello",
                                      "streamId": self.events.stream_id,
                                      "capability": channel.capability}) + "\n").encode())
            self.assertIn(b'"ready"', peer.recv(512))
            header = _header(self.events, self.image, sourceEventSequence=3)
            peer.sendall((json.dumps(header) + "\n").encode() + self.image)
        channel._thread.join(timeout=1)
        self.assertEqual(self.buffer._count, 0)
        self.assertEqual(len(self.buffer._frames), 0)
        self.assertEqual(self.buffer.snapshot(), ("temporarily_unavailable", None, None))
        channel.close()

    def test_disabled_channel_sends_only_disabled_state(self):
        channel = ImageChannel(self.buffer)
        channel.start()
        with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
            peer.sendall((json.dumps({"liveImageVersion": "1", "kind": "hello",
                                      "streamId": self.events.stream_id,
                                      "capability": channel.capability}) + "\n").encode())
            self.assertIn(b'"ready"', peer.recv(512))
            peer.sendall((json.dumps({"liveImageVersion": "1", "streamId": self.events.stream_id,
                                      "kind": "state", "state": "capture_disabled"}) + "\n").encode())
        channel._thread.join(timeout=1)
        self.assertEqual(self.buffer.snapshot(), ("capture_disabled", None, None))
        channel.close()

    def test_unexpected_disconnect_invalidates_prior_frame(self):
        channel = ImageChannel(self.buffer)
        channel.start()
        with socket.create_connection(("127.0.0.1", channel.port), timeout=2) as peer:
            peer.sendall((json.dumps({"liveImageVersion": "1", "kind": "hello",
                                      "streamId": self.events.stream_id,
                                      "capability": channel.capability}) + "\n").encode())
            self.assertIn(b'"ready"', peer.recv(512))
            peer.sendall((json.dumps(_header(self.events, self.image)) + "\n").encode() + self.image)
            for _ in range(20):
                if self.buffer.snapshot()[0] == "available": break
                time.sleep(0.01)
        channel._thread.join(timeout=1)
        self.assertEqual(self.buffer.snapshot(), ("temporarily_unavailable", None, None))
        channel.close()

    def test_built_node_sender_crosses_authenticated_python_channel(self):
        module = ROOT / "dist" / "observability" / "image-channel.js"
        if not module.is_file(): self.skipTest("Run npm build before Node integration")
        channel = ImageChannel(self.buffer)
        channel.start()
        header = _header(self.events, self.image)
        script = ("import {connectImageChannel} from " + json.dumps(module.as_uri()) + ";"
                  "const channel=await connectImageChannel(process.env.PLAYWRIGHT_DEMO_IMAGE_STREAM_ID);"
                  "channel.policy({liveImagePolicyVersion:'1',captureApproved:true,displayApproved:true});"
                  "await channel.sink({...JSON.parse(process.env.TEST_IMAGE_HEADER),"
                  "bytes:Buffer.from(process.env.TEST_IMAGE_JPEG,'base64')});"
                  "await new Promise(resolve=>setTimeout(resolve,100));channel.close();")
        environment = dict(os.environ, PLAYWRIGHT_DEMO_IMAGE_PORT=str(channel.port),
                           PLAYWRIGHT_DEMO_IMAGE_STREAM_ID=self.events.stream_id,
                           PLAYWRIGHT_DEMO_IMAGE_CAPABILITY=channel.capability,
                           TEST_IMAGE_HEADER=json.dumps({key: value for key, value in header.items()
                                                         if key != "kind"}),
                           TEST_IMAGE_JPEG=base64.b64encode(self.image).decode())
        result = subprocess.run(["node", "--input-type=module", "-e", script],
                                cwd=ROOT, env=environment, capture_output=True, timeout=10)
        channel.wait_for_eof()
        channel.close()
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(self.buffer.snapshot()[0], "available")


if __name__ == "__main__": unittest.main()

"""P4-G1 restricted, ephemeral live-image exchange; never an artifact reader."""

from __future__ import annotations

import hmac
import io
import json
import re
import secrets
import socket
import struct
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from .live_events import LiveEventBuffer
from .protocol import _pairs_unique
from PIL import Image, UnidentifiedImageError

VERSION = "1"
MAX_HEADER = 2048
MAX_FRAME_BYTES = 128 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_FRAMES = 32
MAX_AGE_SECONDS = 60
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_FP = re.compile(r"^[a-f0-9]{64}$")
_STATES = frozenset({"capture_disabled", "not_captured", "temporarily_unavailable",
                     "limit_reached", "closed"})


class InvalidImage(ValueError):
    """An image cannot be admitted to the local display buffer."""


def _exact(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or value.keys() != keys:
        raise InvalidImage("Invalid image header")
    return value


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 6 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise InvalidImage("Invalid JPEG")
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xff: raise InvalidImage("Invalid JPEG marker")
        while offset < len(data) and data[offset] == 0xff: offset += 1
        if offset >= len(data): break
        marker = data[offset]; offset += 1
        if marker in (0xd9, 0xda): break
        if marker == 0x01 or 0xd0 <= marker <= 0xd7: continue
        if offset + 2 > len(data): break
        length = struct.unpack_from(">H", data, offset)[0]
        if length < 2 or offset + length > len(data): break
        if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
            if length < 7: break
            return struct.unpack_from(">HH", data, offset + 3)[::-1]
        offset += length
    raise InvalidImage("JPEG dimensions unavailable")


def parse_header(raw: bytes, stream_id: str) -> dict[str, Any]:
    if not raw.endswith(b"\n") or len(raw) > MAX_HEADER or b"\r" in raw or b"\n" in raw[:-1]:
        raise InvalidImage("Invalid image framing")
    try:
        header = json.loads(raw[:-1].decode("utf-8"), object_pairs_hook=_pairs_unique)
    except (UnicodeError, ValueError, TypeError) as error:
        raise InvalidImage("Invalid image JSON") from error
    if type(header) is not dict or header.get("liveImageVersion") != VERSION or header.get("streamId") != stream_id:
        raise InvalidImage("Invalid image version or stream")
    if header.get("kind") == "state":
        _exact(header, {"liveImageVersion", "streamId", "kind", "state"})
        if type(header["state"]) is not str or header["state"] not in _STATES:
            raise InvalidImage("Invalid image state")
        return header
    _exact(header, {"liveImageVersion", "streamId", "kind", "frameSequence",
                    "sourceEventSequence", "testSpecId", "executionProfileRef", "profileFingerprint",
                    "owner", "capturedAt", "mimeType", "width", "height", "byteCount"})
    if header["kind"] != "frame" or header["mimeType"] != "image/jpeg":
        raise InvalidImage("Invalid image kind")
    for key, maximum in (("frameSequence", MAX_FRAMES), ("sourceEventSequence", 256),
                         ("width", 800), ("height", 600), ("byteCount", MAX_FRAME_BYTES)):
        if type(header[key]) is not int or not 1 <= header[key] <= maximum:
            raise InvalidImage("Invalid image bound")
    ref = _exact(header["executionProfileRef"], {"id", "version"})
    owner = _exact(header["owner"], {"kind", "id"})
    for value in (header["testSpecId"], ref["id"], owner["id"]):
        if type(value) is not str or not _ID.fullmatch(value): raise InvalidImage("Invalid image ID")
    if (type(ref["version"]) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", ref["version"]) or
            type(header["profileFingerprint"]) is not str or not _FP.fullmatch(header["profileFingerprint"]) or
            owner["kind"] not in ("attempt", "run")):
        raise InvalidImage("Invalid image correlation")
    stamp = header["capturedAt"]
    if type(stamp) is not str or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", stamp):
        raise InvalidImage("Invalid capture time")
    try: captured = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError as error: raise InvalidImage("Invalid capture time") from error
    age = (datetime.now(timezone.utc) - captured).total_seconds()
    if age < -5 or age > 120: raise InvalidImage("Stale image")
    return header


class LiveImageBuffer:
    """Latest two host-held images, usable only with validated live-event correlation."""

    def __init__(self, events: LiveEventBuffer):
        self.events = events
        self._lock = threading.Lock()
        self._frames: deque[tuple[dict[str, Any], bytes]] = deque(maxlen=2)
        self._count = 0
        self._last_sequence = 0
        self._total_bytes = 0
        self._ended: float | None = None
        self._expiry_timer: threading.Timer | None = None
        self.state = "not_captured"

    def _correlated(self, header: dict[str, Any]) -> bool:
        event_state, _, events = self.events.snapshot()
        if event_state in ("waiting", "unavailable", "inconsistent"):
            return False
        source = header["sourceEventSequence"]
        if not any(event["sequence"] == source for event in events):
            return False
        identity = (header["testSpecId"], header["executionProfileRef"],
                    header["profileFingerprint"])
        owner = header["owner"]
        return any(
            event["context"] and
            (event["context"]["testSpecId"], event["context"]["executionProfileRef"],
             event["context"]["profileFingerprint"]) == identity and
            ((owner["kind"] == "attempt" and
              event["context"].get("explorationAttemptId") == owner["id"]) or
             (owner["kind"] == "run" and
              event["context"].get("executionRunId") == owner["id"]))
            for event in events if event["sequence"] <= source
        )

    def add(self, header: dict[str, Any], data: bytes) -> None:
        with self._lock:
            if self._ended is not None or self.state in ("capture_disabled", "closed", "temporarily_unavailable"):
                raise InvalidImage("Image stream closed")
            if header["frameSequence"] <= self._last_sequence or header["byteCount"] != len(data):
                raise InvalidImage("Image sequence or size mismatch")
            if not self._correlated(header):
                raise InvalidImage("Image event or owner not established")
            if _jpeg_dimensions(data) != (header["width"], header["height"]):
                raise InvalidImage("JPEG dimensions mismatch")
            try:
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != "JPEG" or image.size != (header["width"], header["height"]):
                        raise InvalidImage("Invalid JPEG image")
                    image.load()
            except (UnidentifiedImageError, OSError, ValueError) as error:
                raise InvalidImage("Invalid JPEG image") from error
            if self._total_bytes + len(data) > MAX_TOTAL_BYTES: raise InvalidImage("Image budget exceeded")
            self._count += 1
            self._last_sequence = header["frameSequence"]
            self._total_bytes += len(data)
            self._frames.append((header, data))
            self.state = "available"

    def set_state(self, state: str) -> None:
        if state not in _STATES: raise InvalidImage("Invalid image state")
        with self._lock:
            if state == "capture_disabled" and self._count: raise InvalidImage("Capture disabled after frames")
            if state == "not_captured" and self._count: raise InvalidImage("Invalid image reset")
            if state == "temporarily_unavailable": self._frames.clear()
            if state == "closed":
                self._ended = time.monotonic()
                if self.state not in ("capture_disabled", "limit_reached", "temporarily_unavailable"):
                    self.state = state
            else:
                self.state = state

    def end(self) -> None:
        with self._lock:
            if self._expiry_timer is None:
                self._ended = time.monotonic()
                self._expiry_timer = threading.Timer(MAX_AGE_SECONDS, self.clear)
                self._expiry_timer.daemon = True
                self._expiry_timer.start()

    def clear(self) -> None:
        with self._lock:
            if self._expiry_timer is not None:
                self._expiry_timer.cancel()
                self._expiry_timer = None
            self._frames.clear()
            self.state = "closed"
            self._ended = time.monotonic()

    def snapshot(self) -> tuple[str, dict[str, Any] | None, bytes | None]:
        with self._lock:
            if self._ended is not None and time.monotonic() - self._ended >= MAX_AGE_SECONDS:
                self._frames.clear()
                return "closed", None, None
            state = self.state
            latest = self._frames[-1] if self._frames else None
        event_state, _, _ = self.events.snapshot()
        if event_state in ("unavailable", "inconsistent"):
            return "temporarily_unavailable", None, None
        if state == "temporarily_unavailable": return state, None, None
        if latest is None: return state, None, None
        header, data = latest
        if not self._correlated(header): return "not_captured", None, None
        return ("limit_reached" if state == "limit_reached" else "available"), dict(header), data


class ImageChannel:
    """One authenticated 127.0.0.1 listener, separate from the event exchange."""

    def __init__(self, buffer: LiveImageBuffer):
        self.buffer = buffer
        self.stream_id = buffer.events.stream_id
        self.capability = secrets.token_hex(32)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.25)
        self.port = self.listener.getsockname()[1]
        self._closed = threading.Event()
        self._peer: socket.socket | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None: self._thread.start()

    def close(self) -> None:
        self._closed.set()
        try: self.listener.close()
        except OSError: pass
        if self._peer:
            try: self._peer.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            self._peer.close()
        self._thread.join(timeout=0.5)
        self.buffer.end()

    def wait_for_eof(self, seconds: float = 0.5) -> None:
        self._thread.join(timeout=seconds)
        if self._thread.is_alive(): self.buffer.set_state("temporarily_unavailable")

    def _readline(self, peer: socket.socket) -> bytes:
        data = bytearray()
        while not self._closed.is_set():
            byte = peer.recv(1)
            if not byte: raise EOFError
            data.extend(byte)
            if len(data) > MAX_HEADER: raise InvalidImage("Image header too large")
            if byte == b"\n": return bytes(data)
        raise EOFError

    def _readexact(self, peer: socket.socket, count: int) -> bytes:
        data = bytearray()
        while len(data) < count and not self._closed.is_set():
            chunk = peer.recv(min(count - len(data), 65536))
            if not chunk: raise InvalidImage("Truncated image")
            data.extend(chunk)
        if len(data) != count: raise InvalidImage("Truncated image")
        return bytes(data)

    def _run(self) -> None:
        authenticated = False
        try:
            deadline = time.monotonic() + 15
            while not self._closed.is_set() and time.monotonic() < deadline:
                try: peer, address = self.listener.accept()
                except socket.timeout: continue
                if address[0] != "127.0.0.1": peer.close(); continue
                peer.settimeout(5)
                self._peer = peer
                try:
                    explicit_closed = False
                    hello = json.loads(self._readline(peer)[:-1].decode(), object_pairs_hook=_pairs_unique)
                    _exact(hello, {"liveImageVersion", "kind", "streamId", "capability"})
                    if (hello["liveImageVersion"] != VERSION or hello["kind"] != "hello" or
                            hello["streamId"] != self.stream_id or type(hello["capability"]) is not str or
                            not hmac.compare_digest(hello["capability"], self.capability)):
                        raise InvalidImage("Image authentication denied")
                    authenticated = True
                    self.listener.close()
                    self.capability = ""
                    peer.sendall((json.dumps({"liveImageVersion": VERSION, "kind": "ready",
                                              "streamId": self.stream_id}) + "\n").encode())
                    peer.settimeout(None)
                    while not self._closed.is_set():
                        try: header = parse_header(self._readline(peer), self.stream_id)
                        except EOFError:
                            if not explicit_closed and self.buffer.snapshot()[0] != "capture_disabled":
                                raise InvalidImage("Image channel ended without closure")
                            break
                        if header["kind"] == "state":
                            self.buffer.set_state(header["state"])
                            if header["state"] == "closed":
                                explicit_closed = True
                                break
                        else:
                            self.buffer.add(header, self._readexact(peer, header["byteCount"]))
                finally: peer.close()
                break
            if not authenticated and not self._closed.is_set():
                self.buffer.set_state("temporarily_unavailable")
        except (OSError, UnicodeError, ValueError, TypeError, EOFError):
            if not self._closed.is_set():
                self.buffer.clear()
                self.buffer.set_state("temporarily_unavailable")
        finally:
            if not authenticated:
                try: self.listener.close()
                except OSError: pass

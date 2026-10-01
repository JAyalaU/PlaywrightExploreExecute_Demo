"""P4-G2 closed, authenticated viewer lifecycle; no RFB bytes enter Python."""

from __future__ import annotations

import hmac
import json
import re
import secrets
import socket
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .live_events import LiveEventBuffer

MAX_NOTICE = 2048
MAX_NOTICES = 32
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_FP = re.compile(r"^[a-f0-9]{64}$")
_TOKEN = re.compile(r"^[a-f0-9]{64}$")


class InvalidViewerNotice(ValueError):
    pass


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidViewerNotice("Duplicate viewer field")
        result[key] = value
    return result


def parse_viewer_notice(frame: bytes, stream_id: str) -> dict[str, Any]:
    if len(frame) > MAX_NOTICE or not frame.endswith(b"\n") or b"\n" in frame[:-1] or b"\r" in frame:
        raise InvalidViewerNotice("Invalid viewer frame")
    try:
        value = json.loads(frame[:-1].decode("utf-8"), object_pairs_hook=_unique)
    except (UnicodeError, ValueError, TypeError) as error:
        raise InvalidViewerNotice("Invalid viewer JSON") from error
    base = {"liveViewerVersion", "streamId", "sequence", "sourceEventSequence",
            "testSpecId", "executionProfileRef", "profileFingerprint", "owner", "kind"}
    if type(value) is not dict or value.get("kind") not in {"ready", "transition", "closed", "unavailable"}:
        raise InvalidViewerNotice("Unreviewed viewer kind")
    required = base | ({"port", "path", "connectionCapability", "expiresAt"} if value["kind"] == "ready" else set())
    if set(value) != required or value["liveViewerVersion"] != "1" or value["streamId"] != stream_id or \
            type(value["sequence"]) is not int or not 1 <= value["sequence"] <= MAX_NOTICES or \
            type(value["sourceEventSequence"]) is not int or not 1 <= value["sourceEventSequence"] <= 256 or \
            type(value["testSpecId"]) is not str or not _ID.fullmatch(value["testSpecId"]) or \
            type(value["profileFingerprint"]) is not str or not _FP.fullmatch(value["profileFingerprint"]):
        raise InvalidViewerNotice("Invalid viewer envelope")
    ref, owner = value["executionProfileRef"], value["owner"]
    if type(ref) is not dict or set(ref) != {"id", "version"} or \
            type(ref["id"]) is not str or not _ID.fullmatch(ref["id"]) or \
            type(ref["version"]) is not str or not _VERSION.fullmatch(ref["version"]) or \
            type(owner) is not dict or set(owner) != {"kind", "id"} or \
            owner["kind"] not in {"attempt", "run"} or type(owner["id"]) is not str or \
            not _ID.fullmatch(owner["id"]):
        raise InvalidViewerNotice("Invalid viewer correlation")
    if value["kind"] == "ready":
        if type(value["port"]) is not int or not 1 <= value["port"] <= 65535 or \
                value["path"] != "/rfb" or \
                type(value["connectionCapability"]) is not str or \
                not _TOKEN.fullmatch(value["connectionCapability"]) or \
                type(value["expiresAt"]) is not str:
            raise InvalidViewerNotice("Invalid viewer handle")
        try:
            expiry = datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
            remaining = (expiry - datetime.now(timezone.utc)).total_seconds()
            if not 0 < remaining <= 60.5: raise ValueError("Viewer token expiry out of bounds")
        except ValueError as error:
            raise InvalidViewerNotice("Invalid viewer expiry") from error
    return value


class LiveViewerBuffer:
    """Only an ephemeral current-owner handle; final QA remains subprocess-v1."""

    def __init__(self, events: LiveEventBuffer):
        self.events = events
        self._lock = threading.Lock()
        self.state = "not_started"
        self._sequence = 0
        self._owner: tuple[str, str] | None = None
        self._handle: dict[str, Any] | None = None
        self._history: list[tuple[str, str, str]] = []

    def add(self, frame: bytes) -> None:
        try:
            notice = parse_viewer_notice(frame, self.events.stream_id)
        except InvalidViewerNotice:
            self.mark_unavailable()
            raise
        with self._lock:
            if self.state == "unavailable" or notice["sequence"] != self._sequence + 1:
                self._unavailable(); raise InvalidViewerNotice("Viewer notice order invalid")
            self._sequence += 1
            state, _, events = self.events.snapshot()
            if state in {"unavailable", "inconsistent"}:
                self._unavailable(); raise InvalidViewerNotice("Event timeline unavailable")
            source = next((event for event in events if event["sequence"] == notice["sourceEventSequence"]), None)
            context = source["context"] if source else None
            if not context or any(context[key] != notice[key] for key in
                                  ("testSpecId", "executionProfileRef", "profileFingerprint")):
                self._unavailable(); raise InvalidViewerNotice("Viewer event correlation invalid")
            owner = (notice["owner"]["kind"], notice["owner"]["id"])
            owner_field = "explorationAttemptId" if owner[0] == "attempt" else "executionRunId"
            if context.get(owner_field) != owner[1]:
                self._unavailable(); raise InvalidViewerNotice("Viewer owner invalid")
            if notice["kind"] == "ready":
                if self._owner is not None and self._owner != owner and self.state != "transitioning":
                    self._unavailable(); raise InvalidViewerNotice("Viewer owner transition missing")
                self._owner = owner
                self._handle = {key: notice[key] for key in
                                ("port", "path", "connectionCapability", "expiresAt", "owner")}
                self.state = "available"
            elif notice["kind"] == "transition":
                if self._owner != owner or self.state not in {"available", "closed"}:
                    self._unavailable(); raise InvalidViewerNotice("Viewer transition invalid")
                self._handle = None; self.state = "transitioning"
            else:
                if self._owner != owner:
                    self._unavailable(); raise InvalidViewerNotice("Viewer close owner invalid")
                self._handle = None
                self.state = "closed" if notice["kind"] == "closed" else "unavailable"
            self._history.append((notice["kind"], owner[0], owner[1]))

    def _unavailable(self) -> None:
        self.state = "unavailable"; self._handle = None

    def mark_unavailable(self) -> None:
        with self._lock: self._unavailable()

    def mark_connecting(self) -> None:
        """The trusted host selected a headed approval; no handle exists yet."""
        with self._lock:
            if self.state == "not_started": self.state = "connecting"

    def snapshot(self) -> tuple[str, dict[str, Any] | None]:
        with self._lock:
            if self.events.snapshot()[0] in {"unavailable", "inconsistent"}:
                self._unavailable()
            if self._handle and datetime.fromisoformat(self._handle["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                self._handle = None; self.state = "unavailable"
            return self.state, dict(self._handle) if self._handle else None

    def close(self) -> None:
        with self._lock:
            self._handle = None
            if self.state != "unavailable": self.state = "closed"

    def history(self) -> list[tuple[str, str, str]]:
        with self._lock: return list(self._history)


class ViewerChannel:
    """Single-use authenticated IPv4 loopback connection for closed notices."""

    def __init__(self, buffer: LiveViewerBuffer):
        self.buffer = buffer
        self.capability = secrets.token_hex(32)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0)); self.listener.listen(1)
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
        self.buffer.close()

    def _line(self, peer: socket.socket) -> bytes:
        frame = bytearray()
        while not self._closed.is_set():
            char = peer.recv(1)
            if not char: raise InvalidViewerNotice("Viewer channel EOF")
            frame.extend(char)
            if len(frame) > MAX_NOTICE: raise InvalidViewerNotice("Viewer frame too large")
            if char == b"\n": return bytes(frame)
        raise InvalidViewerNotice("Viewer channel closed")

    def _run(self) -> None:
        authenticated = False
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not self._closed.is_set():
                try: peer, address = self.listener.accept()
                except socket.timeout: continue
                if address[0] != "127.0.0.1": peer.close(); continue
                self._peer = peer; peer.settimeout(5)
                try:
                    hello = json.loads(self._line(peer)[:-1].decode("utf-8"), object_pairs_hook=_unique)
                    if type(hello) is not dict or set(hello) != {"liveViewerVersion", "kind", "streamId", "capability"} or \
                            hello["liveViewerVersion"] != "1" or hello["kind"] != "hello" or \
                            hello["streamId"] != self.buffer.events.stream_id or \
                            type(hello["capability"]) is not str or \
                            not hmac.compare_digest(hello["capability"], self.capability):
                        raise InvalidViewerNotice("Viewer authentication denied")
                    authenticated = True; self.capability = ""; self.listener.close()
                    peer.sendall((json.dumps({"liveViewerVersion": "1", "kind": "ready",
                                              "streamId": self.buffer.events.stream_id}) + "\n").encode())
                    peer.settimeout(None)
                    while not self._closed.is_set():
                        try: frame = self._line(peer)
                        except InvalidViewerNotice as error:
                            if str(error) == "Viewer channel EOF":
                                if self.buffer.snapshot()[0] not in {"closed", "not_started"}:
                                    self.buffer.mark_unavailable()
                                break
                            raise
                        # Independent sockets can race; wait briefly for the referenced event.
                        try:
                            target = json.loads(frame[:-1].decode("utf-8"), object_pairs_hook=_unique)
                            source = target.get("sourceEventSequence") if type(target) is dict else None
                        except (UnicodeError, ValueError):
                            source = None
                        for _ in range(20):
                            if type(source) is int and any(event["sequence"] == source for event in self.buffer.events.snapshot()[2]): break
                            time.sleep(0.01)
                        self.buffer.add(frame)
                finally:
                    peer.close()
                return
            if not authenticated: self.buffer.mark_unavailable()
        except (OSError, UnicodeError, ValueError, TypeError):
            if not self._closed.is_set(): self.buffer.mark_unavailable()
        finally:
            if not authenticated:
                try: self.listener.close()
                except OSError: pass

    def wait_for_eof(self, seconds: float = 0.5) -> None:
        self._thread.join(timeout=seconds)
        if self._thread.is_alive(): self.buffer.mark_unavailable()

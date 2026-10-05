"""Private, view-only lifecycle channel for the active deferred PoC."""

from __future__ import annotations

import hmac
import json
import re
import secrets
import socket
import threading
from uuid import uuid4
from datetime import datetime, timezone
from typing import Any

from .live_viewer import InvalidViewerNotice, _unique

_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_TOKEN = re.compile(r"^[a-f0-9]{64}$")
_PHASES = ("exploration", "compilation", "replay_1", "replay_2")
_KINDS = {"ready", "transition", "closed", "unavailable"}
_MAX_FRAME = 2048


def parse_deferred_viewer_notice(frame: bytes, stream_id: str) -> dict[str, Any]:
    if len(frame) > _MAX_FRAME or not frame.endswith(b"\n") or b"\n" in frame[:-1] or b"\r" in frame:
        raise InvalidViewerNotice("Invalid deferred viewer frame")
    try:
        value = json.loads(frame[:-1].decode("utf-8"), object_pairs_hook=_unique)
    except (UnicodeError, ValueError, TypeError) as error:
        raise InvalidViewerNotice("Invalid deferred viewer JSON") from error
    base = {"deferredViewerVersion", "streamId", "sequence", "kind", "phase", "ownerId", "testSpecId"}
    if type(value) is not dict or value.get("kind") not in _KINDS:
        raise InvalidViewerNotice("Invalid deferred viewer kind")
    required = base | ({"port", "path", "connectionCapability", "expiresAt"} if value["kind"] == "ready" else set())
    if (set(value) != required or value["deferredViewerVersion"] != "1" or value["streamId"] != stream_id or
            type(value["sequence"]) is not int or not 1 <= value["sequence"] <= 64 or
            value["phase"] not in _PHASES or
            type(value["ownerId"]) is not str or not _ID.fullmatch(value["ownerId"]) or
            type(value["testSpecId"]) is not str or not _ID.fullmatch(value["testSpecId"])):
        raise InvalidViewerNotice("Invalid deferred viewer envelope")
    if value["kind"] == "ready":
        if (type(value["port"]) is not int or not 1 <= value["port"] <= 65535 or
                value["path"] != "/rfb" or type(value["connectionCapability"]) is not str or
                not _TOKEN.fullmatch(value["connectionCapability"]) or
                type(value["expiresAt"]) is not str):
            raise InvalidViewerNotice("Invalid deferred viewer handle")
        try:
            expiry = datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
            remaining = (expiry - datetime.now(timezone.utc)).total_seconds()
            if not 0 < remaining <= 60.5:
                raise ValueError("Expiry out of range")
        except ValueError as error:
            raise InvalidViewerNotice("Invalid deferred viewer expiry") from error
    return value


class DeferredViewerBuffer:
    """Volatile current-phase handle; never part of the public QA result."""

    def __init__(self):
        self._lock = threading.Lock()
        self.state = "not_started"
        self.phase: str | None = None
        self._stream_id = str(uuid4())
        self._sequence = 0
        self._test_spec_id: str | None = None
        self._owner_id: str | None = None
        self._handle: dict[str, Any] | None = None
        self._history: list[tuple[str, str, str]] = []

    @property
    def stream_id(self) -> str:
        return self._stream_id

    def add(self, frame: bytes) -> None:
        try:
            notice = parse_deferred_viewer_notice(frame, self._stream_id)
        except InvalidViewerNotice:
            self.mark_unavailable()
            raise
        with self._lock:
            phase = notice["phase"]
            if (self.state == "unavailable" or notice["sequence"] != self._sequence + 1 or
                    self._test_spec_id is not None and notice["testSpecId"] != self._test_spec_id or
                    self.phase is not None and _PHASES.index(phase) < _PHASES.index(self.phase) or
                    self.phase is not None and _PHASES.index(phase) > _PHASES.index(self.phase) + 1):
                self._unavailable()
                raise InvalidViewerNotice("Deferred viewer order invalid")
            kind, owner = notice["kind"], notice["ownerId"]
            if kind == "ready":
                first = self.phase is None and self.state in {"not_started", "connecting"} and phase == "exploration"
                next_phase = (self.state == "transitioning" and self.phase is not None and
                              _PHASES.index(phase) == _PHASES.index(self.phase) + 1)
                reconnect = self.state == "available" and self.phase == phase and self._owner_id == owner
                if not (first or next_phase or reconnect):
                    self._unavailable()
                    raise InvalidViewerNotice("Deferred viewer owner transition missing")
                self._handle = {key: notice[key] for key in
                                ("port", "path", "connectionCapability", "expiresAt")}
                self._handle["owner"] = {"kind": "run" if phase.startswith("replay_") else "attempt", "id": owner}
                self.state = "available"
            else:
                if self._owner_id != owner or self.phase != phase or self.state not in {"available", "transitioning", "closed"}:
                    self._unavailable()
                    raise InvalidViewerNotice("Deferred viewer owner invalid")
                self._handle = None
                self.state = "transitioning" if kind == "transition" else "closed" if kind == "closed" else "unavailable"
            self._sequence = notice["sequence"]
            self.phase = phase
            self._test_spec_id = notice["testSpecId"]
            self._owner_id = owner
            self._history.append((kind, phase, owner))

    def _unavailable(self) -> None:
        self.state = "unavailable"
        self._handle = None

    def mark_unavailable(self) -> None:
        with self._lock:
            self._unavailable()

    def mark_connecting(self) -> None:
        with self._lock:
            if self.state == "not_started":
                self.state = "connecting"

    def snapshot(self) -> tuple[str, str | None, dict[str, Any] | None]:
        with self._lock:
            # The expiry bounds a one-use *connection token*, not an already
            # established RFB connection. A later same-owner ready rotates it.
            return self.state, self.phase, dict(self._handle) if self._handle else None

    def history(self) -> list[tuple[str, str, str]]:
        with self._lock:
            return list(self._history)

    def close(self) -> None:
        with self._lock:
            self._handle = None
            if self.state != "unavailable":
                self.state = "closed"


class DeferredViewerChannel:
    """One authenticated loopback socket for bounded phase/handle notices."""

    def __init__(self, buffer: DeferredViewerBuffer):
        self.buffer = buffer
        self.capability = secrets.token_hex(32)
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(0.25)
        self.port = self.listener.getsockname()[1]
        self._closed = threading.Event()
        self._peer: socket.socket | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._closed.set()
        try: self.listener.close()
        except OSError: pass
        if self._peer:
            try: self._peer.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            self._peer.close()
        if self._thread.is_alive(): self._thread.join(timeout=0.5)
        self.buffer.close()

    def _line(self, peer: socket.socket) -> bytes:
        frame = bytearray()
        while not self._closed.is_set():
            char = peer.recv(1)
            if not char: raise InvalidViewerNotice("Viewer EOF")
            frame.extend(char)
            if len(frame) > _MAX_FRAME: raise InvalidViewerNotice("Viewer frame too large")
            if char == b"\n": return bytes(frame)
        raise InvalidViewerNotice("Viewer closed")

    def _run(self) -> None:
        authenticated = False
        try:
            for _ in range(60):
                if self._closed.is_set(): break
                try: peer, address = self.listener.accept()
                except socket.timeout: continue
                if address[0] != "127.0.0.1": peer.close(); continue
                self._peer = peer
                peer.settimeout(5)
                try:
                    hello = json.loads(self._line(peer)[:-1].decode("utf-8"), object_pairs_hook=_unique)
                    if (type(hello) is not dict or set(hello) != {"deferredViewerVersion", "kind", "streamId", "capability"} or
                            hello["deferredViewerVersion"] != "1" or hello["kind"] != "hello" or
                            hello["streamId"] != self.buffer.stream_id or type(hello["capability"]) is not str or
                            not hmac.compare_digest(hello["capability"], self.capability)):
                        raise InvalidViewerNotice("Viewer authentication denied")
                    authenticated = True
                    self.capability = ""
                    self.listener.close()
                    peer.sendall((json.dumps({"deferredViewerVersion": "1", "kind": "ready",
                                              "streamId": self.buffer.stream_id}) + "\n").encode())
                    peer.settimeout(None)
                    while not self._closed.is_set():
                        try: self.buffer.add(self._line(peer))
                        except InvalidViewerNotice as error:
                            if str(error) == "Viewer EOF":
                                if self.buffer.snapshot()[0] not in {"closed", "not_started"}:
                                    self.buffer.mark_unavailable()
                                break
                            raise
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
        if self._thread.is_alive(): self._thread.join(timeout=seconds)
        if self._thread.is_alive(): self.buffer.mark_unavailable()

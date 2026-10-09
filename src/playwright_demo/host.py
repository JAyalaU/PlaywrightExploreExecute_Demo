"""P2-3C host API: one bounded subprocess exchange with the Node engine."""

from __future__ import annotations

import os
import json
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, NotRequired, TypedDict

from .wire_common import (
    DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, MAX_RESPONSE_BYTES, MAX_STDERR_BYTES,
    InvalidWire,
)
from .protocol_v2 import parse_response, request_bytes
from .local_frame_viewer import LocalFrameViewerChannel as DeferredViewerChannel, LocalFrameViewerBuffer as DeferredViewerBuffer

FailureCode = Literal[
    "LAUNCH_FAILED", "MISSING_RESPONSE", "MALFORMED_RESPONSE",
    "MULTIPLE_RESPONSE", "OUTPUT_LIMIT_EXCEEDED", "UNEXPECTED_EXIT",
    "CANCELLED", "DEADLINE_EXCEEDED",
]
Cleanup = Literal["not_started", "verified", "unverified"]
Descendants = Literal["not_checked", "none_observed", "observed", "unavailable"]
_GRACE_SECONDS = 2.0
_CANCEL_GRACE_SECONDS = 10.0


class HostProcessFailure(TypedDict):
    kind: Literal["process_failure"]
    code: FailureCode
    cleanup: Cleanup
    forcedTermination: bool
    exitCode: NotRequired[int]


@dataclass(frozen=True)
class HostCallResult:
    """A validated Node outcome or a host failure; stderr content stays private."""

    outcome: dict[str, Any] | HostProcessFailure
    stderr: str = ""
    descendants: Descendants = "not_checked"
    provider_diagnostic: Mapping[str, Any] | None = None


_PROVIDER_DIAGNOSTIC_PREFIX = "PLAYWRIGHT_DEMO_PROVIDER_DIAGNOSTIC="
_PROVIDER_FAILURE_CODES = frozenset({
    "PROVIDER_CONFIGURATION_ERROR", "PROVIDER_INPUT_INVALID", "PROVIDER_ERROR",
    "PROVIDER_TIMEOUT", "PROVIDER_REFUSAL", "PROVIDER_INCOMPLETE",
    "PROVIDER_OUTPUT_INVALID", "PROVIDER_RESPONSE_TOO_LARGE",
})
_PROVIDER_SOURCES = frozenset({
    "configuration", "input", "http_status", "provider_response", "response_contract",
    "response_body", "transport_exception", "timeout",
})
_TRANSPORT_CODES = frozenset({
    "EACCES", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT",
    "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
})
_CALL_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate diagnostic field")
        value[key] = item
    return value


def _provider_diagnostic(data: bytearray) -> dict[str, Any] | None:
    """Accept only the closed, single-line Node diagnostic; never retain raw stderr."""
    if os.environ.get("PLAYWRIGHT_DEMO_UI_DIAGNOSTICS") != "1":
        return None
    try:
        line = data.decode("utf-8")
        if not line.endswith("\n") or line.count("\n") != 1 or not line.startswith(_PROVIDER_DIAGNOSTIC_PREFIX):
            return None
        value = json.loads(line[len(_PROVIDER_DIAGNOSTIC_PREFIX):], object_pairs_hook=_unique_pairs)
        if type(value) is not dict or set(value) - {
            "kind", "callId", "stage", "code", "source", "elapsedMs",
            "httpStatus", "transportCode",
        } or not {"kind", "callId", "stage", "code", "source", "elapsedMs"} <= set(value):
            return None
        if (value["kind"] != "provider_failure" or
                type(value["callId"]) is not str or not _CALL_ID.fullmatch(value["callId"]) or
                value["stage"] not in {"interpretation", "step_decision"} or
                value["code"] not in _PROVIDER_FAILURE_CODES or
                value["source"] not in _PROVIDER_SOURCES or
                type(value["elapsedMs"]) is not int or not 0 <= value["elapsedMs"] <= 1_000_000):
            return None
        if "httpStatus" in value and (type(value["httpStatus"]) is not int or
                                      not 100 <= value["httpStatus"] <= 599):
            return None
        if "transportCode" in value and value["transportCode"] not in _TRANSPORT_CODES:
            return None
        return value
    except (UnicodeError, ValueError, TypeError):
        return None


def _failure(code: FailureCode, *, cleanup: Cleanup = "unverified",
             forced: bool = False, exit_code: int | None = None,
             stderr: str = "", descendants: Descendants = "not_checked") -> HostCallResult:
    outcome: HostProcessFailure = {
        "kind": "process_failure", "code": code, "cleanup": cleanup,
        "forcedTermination": forced,
    }
    if type(exit_code) is int and 0 <= exit_code <= 255:
        outcome["exitCode"] = exit_code
    return HostCallResult(outcome, stderr, descendants)


class _Drain(threading.Thread):
    """Continue draining beyond the retention limit so a chatty child cannot deadlock."""

    def __init__(self, pipe: Any, limit: int):
        super().__init__(daemon=True)
        self.pipe = pipe
        self.limit = limit
        self.data = bytearray()
        self.overflow = False

    def run(self) -> None:
        try:
            while chunk := self.pipe.read(4096):
                remaining = self.limit - len(self.data)
                if len(chunk) > remaining:
                    self.overflow = True
                if remaining > 0:
                    self.data.extend(chunk[:remaining])
        except (OSError, ValueError):
            pass


def _stderr_summary(data: bytearray) -> str:
    return "" if not data else f"Child stderr emitted {len(data)} bytes (content withheld)"


def _descendants(pid: int) -> Descendants:
    # Linux /proc offers a best-effort parent check without a dependency.
    # Windows has no equivalent stdlib parent-PID API.
    if not sys.platform.startswith("linux"):
        return "unavailable"
    try:
        parents: dict[int, int] = {}
        for item in Path("/proc").iterdir():
            if item.name.isdigit():
                stat = (item / "stat").read_text()
                parents[int(item.name)] = int(stat.rsplit(")", 1)[1].split()[1])
        return "observed" if pid in parents.values() else "none_observed"
    except (OSError, ValueError, IndexError):
        return "unavailable"


def _stop_child(process: subprocess.Popen[bytes], *, graceful_cancel: bool = False) -> tuple[bool, Descendants]:
    if process.poll() is not None:
        return False, "not_checked"
    descendants = _descendants(process.pid)
    if os.name == "nt":
        # Node runs in its own process group and handles CTRL_BREAK_EVENT by
        # aborting the workflow. Give it time to close the protected browser
        # before the existing forced process-tree fallback.
        if graceful_cancel:
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
                process.wait(timeout=_CANCEL_GRACE_SECONDS)
                return False, descendants
            except (OSError, subprocess.TimeoutExpired):
                pass
            if process.poll() is not None:
                return False, descendants
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=_GRACE_SECONDS, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        if process.poll() is None:
            process.kill()
        process.wait()
        return True, descendants
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
    try:
        process.wait(timeout=_GRACE_SECONDS)
        return False, descendants
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired, ProcessLookupError):
            process.kill()
        process.wait()
        return True, descendants


def call_node(
    request: Mapping[str, Any], *, node_entry: str | Path, config_path: str | Path,
    node_executable: str | Path = "node", deadline_ms: int = DEFAULT_DEADLINE_MS,
    cancel_event: threading.Event | None = None,
    environment: Mapping[str, str] | None = None,
    deferred_viewer: DeferredViewerBuffer | None = None,
    protocol_version: Literal["2"] = "2",
) -> HostCallResult:
    """Invoke the built production entry and validate one v2 exchange.

    The executable, entry, config, environment and deadline are trusted host
    inputs. The task JSON cannot change model, profile policy or artifact root.
    """
    if type(deadline_ms) is not int or not 0 < deadline_ms <= MAX_DEADLINE_MS:
        raise ValueError("Invalid host deadline")
    if protocol_version != "2":
        raise ValueError("Unsupported trusted protocol selection")
    if request.get("protocolVersion") != protocol_version:
        raise ValueError("Selected protocol/request mismatch")
    if deferred_viewer is not None and os.environ.get("PLAYWRIGHT_DEMO_LIVE_VIEW") != "1":
        raise ValueError("Frame viewer requires trusted v2 live-view selection")
    data = request_bytes(request)
    if cancel_event is not None and cancel_event.is_set():
        return _failure("CANCELLED", cleanup="not_started")
    deferred_channel = DeferredViewerChannel(deferred_viewer) if deferred_viewer is not None else None
    if deferred_channel is not None: deferred_channel.start()
    child_env = dict(os.environ if environment is None else environment)
    if deferred_channel is not None:
        child_env.update({"PLAYWRIGHT_DEMO_DEFERRED_VIEWER_PORT": str(deferred_channel.port),
                          "PLAYWRIGHT_DEMO_DEFERRED_VIEWER_STREAM_ID": deferred_viewer.stream_id,
                          "PLAYWRIGHT_DEMO_DEFERRED_VIEWER_CAPABILITY": deferred_channel.capability})
    try:
        process = subprocess.Popen(
            [str(node_executable), str(node_entry), "--config", str(config_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env,
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
    except OSError:
        if deferred_channel is not None: deferred_channel.close()
        return _failure("LAUNCH_FAILED", cleanup="not_started")
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    stdout = _Drain(process.stdout, MAX_RESPONSE_BYTES)
    stderr = _Drain(process.stderr, MAX_STDERR_BYTES)
    stdout.start()
    stderr.start()

    def write_request() -> None:
        try:
            process.stdin.write(data)
            process.stdin.close()
        except (OSError, BrokenPipeError, ValueError):
            pass

    threading.Thread(target=write_request, daemon=True).start()
    deadline = time.monotonic() + deadline_ms / 1000
    failure: FailureCode | None = None
    while process.poll() is None:
        if cancel_event is not None and cancel_event.is_set():
            failure = "CANCELLED"
            break
        if stdout.overflow or stderr.overflow:
            failure = "OUTPUT_LIMIT_EXCEEDED"
            break
        if time.monotonic() >= deadline:
            failure = "DEADLINE_EXCEEDED"
            break
        time.sleep(min(0.02, max(0.0, deadline - time.monotonic())))
    if failure is not None:
        if deferred_channel is not None: deferred_channel.close()
        forced, descendants = _stop_child(process, graceful_cancel=failure == "CANCELLED")
        stdout.join(timeout=_GRACE_SECONDS)
        stderr.join(timeout=_GRACE_SECONDS)
        if not stdout.is_alive():
            process.stdout.close()
        if not stderr.is_alive():
            process.stderr.close()
        if not process.stdin.closed:
            process.stdin.close()
        return _failure(failure, cleanup="unverified", forced=forced,
                        exit_code=process.returncode,
                        stderr=_stderr_summary(stderr.data),
                        descendants=descendants)
    process.wait()
    if deferred_channel is not None:
        deferred_channel.wait_for_eof()
        deferred_channel.close()
    stdout.join(timeout=_GRACE_SECONDS)
    stderr.join(timeout=_GRACE_SECONDS)
    if not stdout.is_alive():
        process.stdout.close()
    if not stderr.is_alive():
        process.stderr.close()
    if not process.stdin.closed:
        process.stdin.close()
    diagnostic = _stderr_summary(stderr.data)
    if stdout.is_alive() or stderr.is_alive():
        process.stdout.close()
        process.stderr.close()
        return _failure("DEADLINE_EXCEEDED", exit_code=process.returncode, stderr=diagnostic)
    if stdout.overflow or stderr.overflow:
        return _failure("OUTPUT_LIMIT_EXCEEDED", exit_code=process.returncode, stderr=diagnostic)
    if not stdout.data:
        return _failure("MISSING_RESPONSE", exit_code=process.returncode, stderr=diagnostic)
    try:
        validated, expected_exit = parse_response(bytes(stdout.data), request["request"]["executionProfileRef"])
    except InvalidWire as error:
        code: FailureCode = "MULTIPLE_RESPONSE" if str(error) == "Multiple responses" else "MALFORMED_RESPONSE"
        return _failure(code, exit_code=process.returncode, stderr=diagnostic)
    if process.returncode != expected_exit:
        return _failure("UNEXPECTED_EXIT", exit_code=process.returncode, stderr=diagnostic)
    return HostCallResult(validated, diagnostic,
                          provider_diagnostic=_provider_diagnostic(stderr.data))

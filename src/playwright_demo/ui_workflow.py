"""P3-D composition of the three existing Node boundaries for the local UI."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

from .host import (
    _CALL_ID, _PROVIDER_FAILURE_CODES, _PROVIDER_SOURCES,
    _TRANSPORT_CODES, call_node,
)
from .live_events import LiveEventBuffer
from .live_images import LiveImageBuffer
from .live_viewer import LiveViewerBuffer
from .deferred_live_viewer import DeferredViewerBuffer
from .public_admission import lookup_public_admission
from .protocol import DEFAULT_DEADLINE_MS, REASONS, STATUSES
from .report_projection import call_report_projection
from .report_projection_v2 import call_report_projection as call_report_projection_v2
from .ui_shell import UiRequest

UiResultKind = Literal["admission_denied", "admission_unavailable", "engine", "host_failure", "workflow_unavailable"]
_DEFERRED_DEMO_HOST_DEADLINE_MS = 1_200_000
_SAFE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_PHASES = frozenset({"interpretation", "exploration", "locator", "execution"})
_KINDS = frozenset({"success", "typed_stop", "bridge_error", "process_failure"})
_EVENTS = frozenset({
    "submitted", "admission_unavailable", "admission_exception", "admission_denied",
    "admission_approved", "engine_started", "engine_exception", "provider_failure",
    "engine_finished", "correlation_mismatch", "projection_started",
    "projection_exception", "projection_unavailable", "projection_finished",
})


def _diagnostic(event: str, **fields: object) -> None:
    """Opt-in local trace of closed host events; never forward child diagnostics."""
    if os.environ.get("PLAYWRIGHT_DEMO_UI_DIAGNOSTICS") != "1" or event not in _EVENTS:
        return
    safe: dict[str, str] = {"event": event}
    for name, value in fields.items():
        if name == "kind" and type(value) is str and value in _KINDS:
            safe[name] = str(value)
        elif name == "phase" and type(value) is str and value in _PHASES:
            safe[name] = str(value)
        elif name == "status" and type(value) is str and value in STATUSES:
            safe[name] = str(value)
        elif name == "reason" and type(value) is str and value in REASONS:
            safe[name] = str(value)
        elif name == "testSpecId" and type(value) is str and _SAFE_ID.fullmatch(value):
            safe[name] = value
        elif name == "callId" and type(value) is str and _CALL_ID.fullmatch(value):
            safe[name] = value
        elif name == "providerStage" and type(value) is str and value in {"interpretation", "step_decision"}:
            safe[name] = str(value)
        elif name == "providerCode" and type(value) is str and value in _PROVIDER_FAILURE_CODES:
            safe[name] = value
        elif name == "source" and type(value) is str and value in _PROVIDER_SOURCES:
            safe[name] = value
        elif name == "httpStatus" and type(value) is int and 100 <= value <= 599:
            safe[name] = str(value)
        elif name == "transportCode" and type(value) is str and value in _TRANSPORT_CODES:
            safe[name] = value
        elif name == "elapsedMs" and type(value) is int and 0 <= value <= 1_000_000:
            safe[name] = str(value)
    try:
        sys.stderr.write("P3_UI_SAFE_DIAGNOSTIC=" + json.dumps(safe, separators=(",", ":")) + "\n")
    except (OSError, ValueError):
        pass


@dataclass(frozen=True)
class UiFinalResult:
    kind: UiResultKind
    outcome: Mapping[str, Any] | None = None
    projection: Mapping[str, Any] | None = None
    projection_failed: bool = False
    workflow_version: Literal["legacy", "agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1", "semantic-general-v1"] = "legacy"


def run_ui_workflow(request: UiRequest, *, config_path: str | Path | None,
                    build_root: Path | None = None, node_executable: str | Path = "node",
                    deadline_ms: int | None = None,
                    live_events: LiveEventBuffer | None = None,
                    live_images: LiveImageBuffer | None = None,
                    live_viewer: LiveViewerBuffer | None = None,
                    deferred_viewer: DeferredViewerBuffer | None = None,
                    cancel_event: threading.Event | None = None,
                    workflow_version: Literal["legacy", "agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1", "semantic-general-v1"] = "legacy") -> UiFinalResult:
    """Select trusted authority, execute one v1 request, then fetch safe metadata.

    The config and executable are host inputs. Form fields never select either.
    """
    if workflow_version not in {"legacy", "agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1", "semantic-general-v1"}:
        raise ValueError("Unsupported trusted workflow selection")
    if workflow_version == "deferred-action-v1" and os.environ.get("PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE") != "offline-review":
        return UiFinalResult("workflow_unavailable", workflow_version=workflow_version)
    if workflow_version == "semantic-general-v1" and os.environ.get("PLAYWRIGHT_DEMO_SEMANTIC_GENERALITY_GATE") != "offline-review":
        return UiFinalResult("workflow_unavailable", workflow_version=workflow_version)
    if deferred_viewer is not None and (workflow_version not in {"deferred-action-v1", "semantic-general-v1"} or
                                        os.environ.get("PLAYWRIGHT_DEMO_LIVE_VIEW") != "1"):
        raise ValueError("Deferred viewer requires trusted live-view selection")
    # Trusted workflow selection, not task/form input, chooses the gated demo default.
    # An explicit host deadline remains an operator/test override validated by call_node.
    host_deadline_ms = deadline_ms if deadline_ms is not None else (
        _DEFERRED_DEMO_HOST_DEADLINE_MS if workflow_version in {"deferred-action-v1", "semantic-general-v1"} else DEFAULT_DEADLINE_MS)
    _diagnostic("submitted")
    if not config_path:
        _diagnostic("admission_unavailable")
        return UiFinalResult("admission_unavailable")
    root = Path.cwd() if build_root is None else build_root
    admission_entry = root / "dist" / "profile" / "admission-cli.js"
    engine_entry = root / "dist" / "subprocess" / "cli.js"
    projection_entry = root / "dist" / "subprocess" / "report-projection-cli.js"
    if workflow_version in {"agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1", "semantic-general-v1"}:
        engine_entry = root / "dist" / "subprocess" / "agentic-cli.js"
        projection_entry = root / "dist" / "subprocess" / "report-projection-v2-cli.js"
        if workflow_version == "deferred-action-v1":
            projection_entry = root / "dist" / "subprocess" / "deferred-report-projection-cli.js"
    if not all(path.is_file() for path in (admission_entry, engine_entry, projection_entry)):
        _diagnostic("admission_unavailable")
        return UiFinalResult("workflow_unavailable" if workflow_version != "legacy" else "admission_unavailable",
                             workflow_version=workflow_version)
    agentic = workflow_version != "legacy"
    try:
        approval = lookup_public_admission(
            request.target_url, node_entry=admission_entry, config_path=config_path,
            node_executable=node_executable, selection_only=agentic)
        if not agentic and approval["kind"] == "denied":
            headed = lookup_public_admission(
                request.target_url, node_entry=admission_entry, config_path=config_path,
                node_executable=node_executable, admission_version="2")
            if headed["kind"] != "denied":
                approval = headed
    except Exception:
        _diagnostic("admission_exception")
        raise
    if approval["kind"] == "denied":
        _diagnostic("admission_denied")
        return UiFinalResult("admission_denied")
    if approval["kind"] != "approved":
        _diagnostic("admission_unavailable")
        return UiFinalResult("admission_unavailable")
    if approval["admissionVersion"] == "2" and live_viewer is not None:
        live_viewer.mark_connecting()
    if deferred_viewer is not None:
        deferred_viewer.mark_connecting()
    _diagnostic("admission_approved")
    if agentic:
        if live_events is not None: live_events.mark_unavailable()
        if live_images is not None: live_images.set_state("capture_disabled")
        if live_viewer is not None: live_viewer.close()
    wire = {"protocolVersion": "2" if agentic else "1", "request": {
        "taskText": request.task_text, "targetUrl": request.target_url if agentic else approval["canonicalUrl"],
        "executionProfileRef": approval["executionProfileRef"],
    }}
    _diagnostic("engine_started")
    try:
        options = {"protocol_version": "2", "deferred_viewer": deferred_viewer} if agentic else {
            "live_events": live_events, "live_images": live_images,
            "live_viewer": live_viewer if approval["admissionVersion"] == "2" else None}
        result = call_node(wire, node_entry=engine_entry, config_path=config_path,
                           node_executable=node_executable, deadline_ms=host_deadline_ms,
                           cancel_event=cancel_event,
                           **({"environment": {**os.environ, "PLAYWRIGHT_DEMO_WORKFLOW_VERSION": workflow_version}}
                              if agentic else {}), **options)
    except Exception:
        _diagnostic("engine_exception")
        raise
    outcome = result.outcome
    if agentic:
        return _agentic_result(outcome, approval, config_path, projection_entry, node_executable,
                               workflow_version)
    if result.provider_diagnostic is not None:
        provider = result.provider_diagnostic
        _diagnostic("provider_failure", callId=provider.get("callId"),
                    providerStage=provider.get("stage"), providerCode=provider.get("code"),
                    source=provider.get("source"), httpStatus=provider.get("httpStatus"),
                    transportCode=provider.get("transportCode"), elapsedMs=provider.get("elapsedMs"))
    terminal = outcome.get("terminal", {})
    context = outcome.get("context", {})
    _diagnostic("engine_finished", kind=outcome.get("kind"),
                phase=terminal.get("phase"), status=terminal.get("status"),
                reason=terminal.get("reason"), testSpecId=context.get("testSpecId"))
    if outcome["kind"] == "process_failure":
        return UiFinalResult("engine", outcome=outcome)
    if outcome["kind"] in {"success", "typed_stop"}:
        context = outcome["context"]
        if (context["executionProfileRef"] != approval["executionProfileRef"] or
                context["profileFingerprint"] != approval["profileFingerprint"]):
            _diagnostic("correlation_mismatch", testSpecId=context.get("testSpecId"))
            return UiFinalResult("host_failure")
        if context["report"]["kind"] == "available":
            _diagnostic("projection_started", testSpecId=context.get("testSpecId"))
            try:
                projection = call_report_projection(
                    outcome, node_entry=projection_entry, config_path=config_path,
                    node_executable=node_executable)
            except Exception:
                # Projection retrieval has no authority over the engine result.
                _diagnostic("projection_exception", testSpecId=context.get("testSpecId"))
                return UiFinalResult("engine", outcome=outcome, projection_failed=True)
            if projection.outcome["kind"] == "process_failure":
                _diagnostic("projection_unavailable", testSpecId=context.get("testSpecId"))
                return UiFinalResult("engine", outcome=outcome, projection_failed=True)
            _diagnostic("projection_finished", testSpecId=context.get("testSpecId"))
            return UiFinalResult("engine", outcome=outcome, projection=projection.outcome)
    return UiFinalResult("engine", outcome=outcome)


def run_local_ui_request(request: UiRequest, *, live_events: LiveEventBuffer | None = None,
                         live_images: LiveImageBuffer | None = None,
                         live_viewer: LiveViewerBuffer | None = None,
                         deferred_viewer: DeferredViewerBuffer | None = None,
                         cancel_event: threading.Event | None = None) -> UiFinalResult:
    """Guarded Streamlit entry: trusted launch environment chooses the config."""
    return run_ui_workflow(request, config_path=os.environ.get("PLAYWRIGHT_DEMO_TRUSTED_CONFIG"),
                           live_events=live_events, live_images=live_images,
                           live_viewer=live_viewer,
                           deferred_viewer=deferred_viewer,
                           cancel_event=cancel_event,
                           workflow_version=os.environ.get("PLAYWRIGHT_DEMO_WORKFLOW_VERSION", "legacy"))


def _agentic_result(outcome: Mapping[str, Any], approval: Mapping[str, Any],
                    config_path: str | Path, projection_entry: Path,
                    node_executable: str | Path, workflow_version: Literal["agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1", "semantic-general-v1"]) -> UiFinalResult:
    """Keep v2 terminal authoritative even if read-only projection fails."""
    if outcome["kind"] == "process_failure":
        return UiFinalResult("engine", outcome=outcome, workflow_version=workflow_version)
    if outcome["kind"] not in {"success", "typed_stop"}:
        return UiFinalResult("engine", outcome=outcome, workflow_version=workflow_version)
    record = outcome["context"]["result"]
    if record["workflowVersion"] != workflow_version:
        return UiFinalResult("host_failure", workflow_version=workflow_version)
    if (record["executionProfileRef"] != approval["executionProfileRef"] or
            record["profileFingerprint"] != approval["profileFingerprint"]):
        return UiFinalResult("host_failure", workflow_version=workflow_version)
    if outcome["context"]["report"]["kind"] != "available":
        return UiFinalResult("engine", outcome=outcome, workflow_version=workflow_version)
    try:
        projection = call_report_projection_v2(outcome, node_entry=projection_entry,
            config_path=config_path, node_executable=node_executable)
    except Exception:
        return UiFinalResult("engine", outcome=outcome, projection_failed=True,
                             workflow_version=workflow_version)
    if projection.outcome["kind"] == "process_failure":
        return UiFinalResult("engine", outcome=outcome, projection_failed=True,
                             workflow_version=workflow_version)
    return UiFinalResult("engine", outcome=outcome, projection=projection.outcome,
                         workflow_version=workflow_version)

"""Local Streamlit form and host-owned status shell.

The form collects untrusted task input. Admission, execution, and result
classification are supplied by later host integration, never by this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import inspect
import os
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Callable, Literal
import atexit
from urllib.parse import urlsplit
from weakref import WeakKeyDictionary

import streamlit as st
from .local_frame_viewer import LocalFrameViewerBuffer as DeferredViewerBuffer
from .local_frame_ui import render_local_frame_viewer
from .demo_action_pacing import parse_demo_action_pause_ms

if TYPE_CHECKING:
    from .ui_workflow import UiFinalResult


Phase = Literal["not_started", "prepared", "running", "completed"]


@dataclass(frozen=True)
class UiRequest:
    target_url: str
    task_text: str


@dataclass(frozen=True)
class UiStatus:
    phase: Phase = "not_started"
    request: UiRequest | None = None
    host_error: bool = False
    result: UiFinalResult | None = None


# One local operator and at most one active host call, including across tabs.
_active_run = Lock()
_STATE_KEY = "playwright_demo_ui_status"
_RUN_KEY = "playwright_demo_active_run"
_live_runs: set["UiRun"] = set()
# Viewer capabilities stay in this process's volatile host buffer, never in
# Streamlit session state or a reusable media endpoint.
_deferred_viewer_buffers: WeakKeyDictionary["UiRun", DeferredViewerBuffer] = WeakKeyDictionary()


class UiRun:
    """One active host invocation, independent of Streamlit rerender timing."""

    def __init__(self, request: UiRequest, execute: Callable[..., UiFinalResult | None]):
        self.request = request
        if os.environ.get("PLAYWRIGHT_DEMO_LIVE_VIEW") == "1":
            _deferred_viewer_buffers[self] = DeferredViewerBuffer("frame_stream")
        self.cancel = Event()
        self.done = Event()
        self.result: UiFinalResult | None = None
        self.failed = False
        self._execute = execute
        self.thread = Thread(target=self._run, daemon=True)

    def start(self) -> None:
        _live_runs.add(self)
        self.thread.start()

    def _run(self) -> None:
        try:
            arguments = {"cancel_event": self.cancel}
            signature = inspect.signature(self._execute)
            if self in _deferred_viewer_buffers and ("deferred_viewer" in signature.parameters or any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )):
                arguments["deferred_viewer"] = _deferred_viewer_buffers[self]
            self.result = self._execute(self.request, **arguments)
            if self.result is None or self.result.kind != "engine":
                if self in _deferred_viewer_buffers:
                    _deferred_viewer_buffers[self].close()
        except Exception:
            self.failed = True
        finally:
            # A final host result (or host exception) ends UI authorization,
            # even if the child lifecycle channel omitted its closed notice.
            if self in _deferred_viewer_buffers:
                _deferred_viewer_buffers[self].close()
            self.done.set()
            _live_runs.discard(self)
            _active_run.release()


def _shutdown_live_runs() -> None:
    for run in tuple(_live_runs): run.cancel.set()
    for run in tuple(_live_runs): run.thread.join(timeout=5)
    for run in tuple(_live_runs):
        if run in _deferred_viewer_buffers: _deferred_viewer_buffers[run].close()


atexit.register(_shutdown_live_runs)


@st.fragment(run_every="500ms")
def _render_live_viewer_fragment(run: UiRun) -> None:
    if run in _deferred_viewer_buffers:
        render_local_frame_viewer(_deferred_viewer_buffers[run], st)
    else:
        st.subheader("Live browser view")
        st.caption("Live view disabled by trusted configuration.")


@st.fragment(run_every="500ms")
def _render_live_run(run: UiRun) -> None:
    if run.done.is_set():
        status = UiStatus(phase="completed", request=run.request,
                          result=run.result, host_error=run.failed)
        st.session_state[_STATE_KEY] = status
        if run.failed:
            st.error("The host call did not complete. No QA result is available.")
        elif run.result is not None:
            st.info("The host returned a typed engine or process result.")
        else:
            st.info("The host returned a final result.")
    else:
        st.info("Host call is active. Final QA result is pending.")
        if st.button("Cancel active test", key="cancel_active_test"):
            run.cancel.set()
            st.warning("Cancellation requested. Waiting for child cleanup.")
    st.subheader("Execution timeline")
    st.caption("Agentic terminal timeline is unavailable pending reviewed correlation.")
    if run.done.is_set():
        st.subheader("Result")
        if run.result is not None: _render_result(run.result)
        elif run.failed: st.caption("No trusted final result is available.")


def validate_input(target_url: str, task_text: str) -> UiRequest:
    """Check the URL and task shape before invoking the selected workflow."""
    url = target_url.strip()
    task = task_text.strip()
    if not url or any(character.isspace() for character in url):
        raise ValueError("Enter an absolute HTTP or HTTPS URL.")
    try:
        parsed = urlsplit(url)
        valid_port = parsed.port is None or parsed.port > 0
    except ValueError:
        valid_port = False
        parsed = None
    if (parsed is None or parsed.scheme not in {"http", "https"}
            or not parsed.netloc or not parsed.hostname or not valid_port
            or parsed.username is not None or parsed.password is not None):
        raise ValueError("Enter an absolute HTTP or HTTPS URL.")
    if not task:
        raise ValueError("Enter a testing task.")
    return UiRequest(target_url=url, task_text=task)


def _status() -> UiStatus:
    current = st.session_state.get(_STATE_KEY)
    if not isinstance(current, UiStatus):
        current = UiStatus()
        st.session_state[_STATE_KEY] = current
    return current


def _render_result(result: UiFinalResult) -> None:
    if result.kind == "admission_denied":
        st.warning("This URL has no matching trusted public-target approval. No test started.")
        return
    if result.kind == "admission_unavailable":
        st.error("Trusted public-target approval is unavailable. No test started.")
        return
    if result.kind == "host_failure":
        st.error("The engine result did not match the approved profile. No trusted QA result is available.")
        return
    if result.kind == "workflow_unavailable":
        st.error("The trusted product workflow is unavailable. No test started.")
        return
    outcome = result.outcome
    if outcome is None:
        st.error("No trusted engine result is available.")
        return
    _render_agentic_result(result)


def _render_agentic_result(result: UiFinalResult) -> None:
    """Present only validated v2 terminal categories and bounded projection."""
    outcome = result.outcome
    assert outcome is not None
    if outcome["kind"] == "process_failure":
        st.error(f"Host process failure: {outcome['code']}")
        st.caption(f"Cleanup: {outcome['cleanup']}")
        return
    if outcome["kind"] == "bridge_error":
        st.error(f"Node bridge error: {outcome['code']}")
        st.caption(f"Cleanup: {outcome['cleanup']}")
        return
    record = outcome["context"]["result"]
    terminal = record["terminal"]
    stage = terminal["stage"]
    categories = {
        "interpretation": "Request could not be interpreted",
        "exploration": "Path not established",
        "compilation": "Compilation failed",
        "replay": "Replay failed",
        "reproducibility": "Reproducibility failed",
        "environment": "Environment/runtime failure",
        "cancellation": "Cancelled",
    }
    if stage == "qa":
        (st.success if terminal["status"] == "QA_ASSERTION_PASSED" else st.error)(
            "QA passed" if terminal["status"] == "QA_ASSERTION_PASSED" else "QA failed")
    else:
        st.warning(categories[stage])
    st.caption(f"Stage: {stage} · Status: {terminal['status']}")
    if "reason" in terminal: st.caption(f"Reason: {terminal['reason']}")
    if "semanticReplay" in record:
        st.caption("Semantic lineage: TestSpec v7, grounding v1, compiler v5, resolved v10, runner v10, replay pair v2")
    st.caption(f"Cleanup: {record['cleanup']}")
    if record["presentationMode"] == "headed":
        st.caption("Headed execution is observational. A separate fresh headless workflow establishes autonomous equivalence.")
    st.subheader("Correlation and provenance")
    st.write(f"Workflow: {record['workflowVersion']}")
    st.write(f"TestSpec: {record['testSpecId']}")
    st.write(f"Profile: {record['executionProfileRef']['id']}@{record['executionProfileRef']['version']}")
    st.write(f"Profile fingerprint: {record['profileFingerprint']}")
    for key, label in (("explorationAttemptId", "Exploration attempt"),
                       ("successfulTraceId", "Successful trace"),
                       ("compilerAttemptId", "Compiler attempt"),
                       ("resolvedSpecId", "Resolved spec")):
        if key in record: st.write(f"{label}: {record[key]}")
    for run_id in record["executionRunIds"]: st.write(f"Execution run: {run_id}")
    st.subheader("Report and evidence")
    projection = result.projection
    if result.projection_failed:
        st.warning("Safe report details could not be retrieved. The typed result above is unchanged.")
    elif projection is None or projection["kind"] == "unavailable":
        st.info("Safe report details are unavailable. The typed result above is unchanged.")
    else:
        for name in ("exploration", "compilation", "replay"):
            summary = projection["stages"][name]
            st.write(f"{name.capitalize()}: {summary['status']}")
            if "reason" in summary: st.caption(f"Reason: {summary['reason']}")
        for index, replay in enumerate(projection["replays"], 1):
            st.write(f"Replay {index}: {replay['state']}")
        st.write(f"Reproducibility: {projection['reproducibility']}")
        if "authoritativeQa" in projection:
            st.write(f"Authoritative QA: {projection['authoritativeQa']}")
        st.write(f"Screenshot: {projection['screenshot']}")
        st.caption(f"Authorized evidence descriptors: {len(projection['evidence'])}")
        if projection["screenshot"] == "stored_restricted":
            st.caption("Screenshot bytes are restricted and are not displayed.")


def render_shell(execute: Callable[..., UiFinalResult | None] | None = None,
                 *, live: bool = False) -> None:
    """Render the local shell; P3-D supplies the host callback.

    The callback is invoked only on a valid form submission while the global
    run lock is held. A Streamlit rerender cannot replay that submission.
    """
    st.title("UI test demo")
    st.caption("Local, single-operator workflow. Public targets require trusted approval.")
    selected_workflow = os.environ.get("PLAYWRIGHT_DEMO_WORKFLOW_VERSION")
    selected_backend = os.environ.get("PLAYWRIGHT_DEMO_BROWSER_BACKEND")
    route_invalid = selected_workflow not in {None, "", "semantic-general-v1"} or selected_backend not in {None, ""}
    if route_invalid:
        st.error("Invalid trusted product route or browser backend. No test can start.")
    else:
        st.caption("Trusted workflow: semantic-general-v1")
    pacing_invalid = False
    try:
        action_pause_ms = parse_demo_action_pause_ms(os.environ.get("PLAYWRIGHT_DEMO_ACTION_PAUSE_MS"))
    except ValueError:
        pacing_invalid = True
        st.error("Invalid trusted demo pacing setting. No test can start.")
    else:
        if action_pause_ms:
            st.caption(f"Demo pacing: {action_pause_ms} ms after actions")
    # Populate this slot after submission, but render it before the form and
    # the independently refreshing timeline so page growth cannot move it.
    live_view_slot = st.container()
    status = _status()

    with st.form("ui_test_request"):
        target_url = st.text_input("Public HTTP(S) URL", placeholder="https://example.org/")
        task_text = st.text_area("Testing task", placeholder="Describe the UI action and assertion.")
        submitted = st.form_submit_button("Start test", disabled=status.phase == "running" or
                                          route_invalid or pacing_invalid)

    if submitted:
        if status.phase == "running":
            st.warning("A run is already active.")
        else:
            try:
                request = validate_input(target_url, task_text)
            except ValueError as error:
                st.error(str(error))
            else:
                if execute is None:
                    status = UiStatus(phase="prepared", request=request)
                    st.session_state[_STATE_KEY] = status
                elif not _active_run.acquire(blocking=False):
                    st.warning("A run is already active in this local UI.")
                elif live:
                    run = UiRun(request, execute)
                    st.session_state[_RUN_KEY] = run
                    st.session_state[_STATE_KEY] = UiStatus(phase="running", request=request)
                    try:
                        run.start()
                    except Exception:
                        _active_run.release()
                        st.session_state[_RUN_KEY] = None
                        status = UiStatus(phase="completed", request=request, host_error=True)
                        st.session_state[_STATE_KEY] = status
                else:
                    status = UiStatus(phase="running", request=request)
                    st.session_state[_STATE_KEY] = status
                    try:
                        with st.spinner("Waiting for the host's final result..."):
                            final_result = execute(request)
                    except Exception:
                        # Do not render arbitrary child/provider exception text.
                        status = UiStatus(phase="completed", request=request, host_error=True)
                    else:
                        status = UiStatus(phase="completed", request=request, result=final_result)
                    finally:
                        st.session_state[_STATE_KEY] = status
                        _active_run.release()

    active = st.session_state.get(_RUN_KEY) if live else None
    if isinstance(active, UiRun):
        with live_view_slot:
            _render_live_viewer_fragment(active)
        st.subheader("Status")
        _render_live_run(active)
        return
    st.subheader("Status")
    if status.phase == "not_started":
        st.info("No test has started.")
    elif status.phase == "prepared":
        st.info("Request captured. No execution has started yet.")
    elif status.phase == "running":
        st.info("Host call is active. Waiting for its final result.")
    elif status.host_error:
        st.error("The host call did not complete. No QA result is available.")
    elif status.result is None:
        st.success("The host returned a final result.")
    elif status.result.kind == "engine" and status.result.outcome is not None:
        st.info("The host returned a typed engine or process result.")
    else:
        st.info("The host returned an admission or correlation result.")

    st.subheader("Result")
    if status.phase == "completed":
        if status.result is not None:
            _render_result(status.result)
        elif status.host_error:
            st.caption("No trusted final result is available.")
        else:
            st.caption("The host callback returned no typed result.")
    else:
        st.caption("No final result is available.")

"""Local Streamlit form and host-owned status shell.

The form collects untrusted task input. Admission, execution, and result
classification are supplied by later host integration, never by this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import inspect
import json
import os
import re
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Callable, Literal, Any
import atexit
from datetime import datetime, timezone
from urllib.parse import urlsplit
from weakref import WeakKeyDictionary

import streamlit as st
from .live_events import LiveEventBuffer
from .live_images import LiveImageBuffer
from .live_viewer import LiveViewerBuffer

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
_viewer_buffers: WeakKeyDictionary["UiRun", LiveViewerBuffer] = WeakKeyDictionary()
_VIEWER_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}$")
_VIEWER_TOKEN = re.compile(r"^[a-f0-9]{64}$")
_VIEWER_EXPIRY = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$")


class UiRun:
    """One active host invocation, independent of Streamlit rerender timing."""

    def __init__(self, request: UiRequest, execute: Callable[..., UiFinalResult | None]):
        self.request = request
        self.agentic = os.environ.get("PLAYWRIGHT_DEMO_WORKFLOW_VERSION") in {"agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1"}
        self.events = LiveEventBuffer()
        self.images = LiveImageBuffer(self.events)
        _viewer_buffers[self] = LiveViewerBuffer(self.events)
        if self.agentic:
            self.events.mark_unavailable()
            self.images.set_state("capture_disabled")
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
            arguments = {"live_events": self.events, "cancel_event": self.cancel}
            signature = inspect.signature(self._execute)
            if "live_images" in signature.parameters or any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            ):
                arguments["live_images"] = self.images
            if "live_viewer" in signature.parameters or any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            ):
                arguments["live_viewer"] = _viewer_buffers[self]
            self.result = self._execute(self.request, **arguments)
            if self.result is None or self.result.kind != "engine":
                self.images.set_state("capture_disabled")
                if _viewer_buffers[self].snapshot()[0] != "not_started":
                    _viewer_buffers[self].close()
        except Exception:
            self.failed = True
        finally:
            # A final host result (or host exception) ends UI authorization,
            # even if the child lifecycle channel omitted its closed notice.
            if _viewer_buffers[self].snapshot()[0] != "not_started":
                _viewer_buffers[self].close()
            self.done.set()
            _live_runs.discard(self)
            _active_run.release()


def _shutdown_live_runs() -> None:
    for run in tuple(_live_runs): run.cancel.set()
    for run in tuple(_live_runs): run.thread.join(timeout=5)
    for run in tuple(_live_runs): run.images.clear()
    for run in tuple(_live_runs): _viewer_buffers[run].close()


atexit.register(_shutdown_live_runs)


@st.fragment(run_every="500ms")
def _render_live_viewer_fragment(run: UiRun) -> None:
    _render_live_viewer(_viewer_buffers[run])


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
    if not run.agentic: _render_live_image(run.images)
    state, omitted, events = run.events.snapshot()
    st.subheader("Execution timeline")
    if run.agentic:
        st.caption("Agentic terminal timeline is unavailable pending reviewed correlation.")
    elif run.done.is_set() and run.result is not None and run.result.kind != "engine":
        st.caption("No engine execution timeline was started for this request.")
    elif state in {"unavailable", "inconsistent"}:
        st.warning(f"Live timeline {state}. The final typed result remains authoritative.")
    elif state == "waiting":
        st.caption("Waiting for validated Node events.")
    if not run.agentic and state != "inconsistent" and omitted:
        st.caption(f"{omitted} older validated events omitted from display.")
    for event in events if state != "inconsistent" and not run.agentic else ():
        data = event["data"]
        label = f"{event['sequence']}. {event['kind']}"
        for name in ("tool", "outcome", "status", "availability", "cause", "basis"):
            if name in data: label += f" · {data[name]}"
        if "reasons" in data and data["reasons"]:
            label += " · " + ", ".join(data["reasons"])
        st.write(label)
    if run.done.is_set():
        st.subheader("Result")
        if run.result is not None: _render_result(run.result)
        elif run.failed: st.caption("No trusted final result is available.")


def _render_live_image(images: LiveImageBuffer) -> None:
    image_state, header, image_bytes = images.snapshot()
    st.subheader("Live browser image")
    if image_state in {"available", "limit_reached"} and header is not None and image_bytes is not None:
        # st.html sends inline HTML in the local session delta. st.image would
        # create a reusable /media/ endpoint, violating P4-G1 expiry semantics.
        encoded = base64.b64encode(image_bytes).decode("ascii")
        owner = header["owner"]
        st.caption(f"{owner['kind']} {owner['id']} · {header['capturedAt']}")
        st.html(f'<img src="data:image/jpeg;base64,{encoded}" width="{header["width"]}" '
                f'height="{header["height"]}" alt="Restricted live browser image" />')
        if image_state == "limit_reached": st.caption("Live image capture limit reached.")
    elif image_state == "capture_disabled":
        st.caption("Live image capture is disabled by trusted configuration.")
    elif image_state == "not_captured":
        st.caption("Live image authorized; no validated frame is available yet.")
    elif image_state == "limit_reached":
        st.caption("Live image capture limit reached.")
    elif image_state == "closed":
        st.caption("Live image session closed or expired.")
    else:
        st.warning("Live image temporarily unavailable. The final QA result is unchanged.")


def _viewer_markup(handle: dict[str, Any]) -> str:
    """Build only a validated local, view-only client for the current owner."""
    owner = handle.get("owner")
    port, path = handle.get("port"), handle.get("path")
    token, expiry = handle.get("connectionCapability"), handle.get("expiresAt")
    if (type(owner) is not dict or set(owner) != {"kind", "id"} or
            owner["kind"] not in {"attempt", "run"} or
            type(owner["id"]) is not str or not _VIEWER_ID.fullmatch(owner["id"]) or
            type(port) is not int or not 1 <= port <= 65535 or path != "/rfb" or
            type(token) is not str or not _VIEWER_TOKEN.fullmatch(token) or
            type(expiry) is not str or not _VIEWER_EXPIRY.fullmatch(expiry)):
        raise ValueError("Invalid live viewer handle")
    remaining = (datetime.fromisoformat(expiry.replace("Z", "+00:00")) -
                 datetime.now(timezone.utc)).total_seconds()
    if not 0 < remaining <= 60.5:
        raise ValueError("Expired live viewer handle")
    # JSON quoting protects the module script even if this helper is called
    # outside the validated lifecycle channel in a test or future UI seam.
    identity = json.dumps(f"{owner['kind']}:{owner['id']}:{port}:{expiry}:{token}")
    asset = json.dumps(f"http://127.0.0.1:{port}/core/rfb.js")
    socket_url = json.dumps(f"ws://127.0.0.1:{port}/rfb")
    capability = json.dumps(f"viewer.{token}")
    expires = json.dumps(expiry)
    return f'''<div id="p4-viewer-anchor"></div><script>
      (() => {{
      const anchor = document.getElementById('p4-viewer-anchor');
      const identity = {identity};
      const prior = window.__p4LiveViewer;
      if (prior && prior.identity === identity) {{
        anchor.replaceWith(prior.screen);
      }} else {{
        if (prior) {{
          prior.cancelled = true;
          if (prior.rfb) prior.rfb.disconnect();
          if (prior.socket) prior.socket.close();
          prior.screen.remove();
        }}
        const screen = document.createElement('div');
        screen.style.maxWidth = '800px';
        screen.style.height = '500px';
        const status = document.createElement('p');
        status.textContent = 'Connecting to the protected browser view...';
        screen.appendChild(status);
        anchor.replaceWith(screen);
        // Register before the asynchronous module import. Fragment rerenders
        // must never spend this single-use WebSocket capability twice.
        const current = {{identity, screen, cancelled: false, socket: null, rfb: null}};
        window.__p4LiveViewer = current;
        import({asset}).then((module) => {{
          if (current.cancelled || window.__p4LiveViewer !== current) return;
          if (Date.now() >= Date.parse({expires})) {{
            status.textContent = 'Protected browser view unavailable.';
            return;
          }}
          const socket = new WebSocket({socket_url}, ['binary', {capability}]);
          current.socket = socket;
          const rfb = new module.default(screen, socket);
          current.rfb = rfb;
          rfb.viewOnly = true;
          rfb.scaleViewport = true;
          rfb.addEventListener('connect', () => {{ status.remove(); }});
          rfb.addEventListener('disconnect', () => {{
            if (!current.cancelled) status.textContent = 'Protected browser view disconnected.';
          }});
        }}).catch(() => {{
          if (!current.cancelled) status.textContent = 'Protected browser view unavailable.';
        }});
      }}
      }})();
    </script>'''


def _render_live_viewer(viewer: LiveViewerBuffer) -> None:
    state, handle = viewer.snapshot()
    st.subheader("Live browser view")
    if state == "available" and handle is not None:
        owner = handle["owner"]
        st.caption(f"View only: {owner['kind']} {owner['id']}. Browser input is disabled.")
        try:
            st.html(_viewer_markup(handle), unsafe_allow_javascript=True)
        except ValueError:
            viewer.mark_unavailable()
            st.warning("Live viewer unavailable. The final QA result is unchanged.")
    else:
        # A previous viewer must not remain visible as the next owner starts.
        st.html("<script>const p=window.__p4LiveViewer; if(p){p.cancelled=true;if(p.rfb)p.rfb.disconnect();if(p.socket)p.socket.close();p.screen.remove();delete window.__p4LiveViewer}</script>",
                unsafe_allow_javascript=True)
        if state == "not_started": st.caption("No headed viewer has started.")
        elif state == "connecting": st.caption("Connecting to the approved headed browser view.")
        elif state == "transitioning": st.caption("Protected browser session is transitioning.")
        elif state == "closed": st.caption("Protected browser view closed.")
        else: st.warning("Live viewer unavailable. The final QA result is unchanged.")


def validate_input(target_url: str, task_text: str) -> UiRequest:
    """Check form shape only; Node decides public-target admission."""
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
        raise ValueError("Enter an absolute HTTP or HTTPS URL without credentials.")
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
        st.error("The selected agentic workflow is unavailable in this build. No test started.")
        return
    outcome = result.outcome
    if outcome is None:
        st.error("No trusted engine result is available.")
        return
    if result.workflow_version in {"agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1"}:
        _render_agentic_result(result)
        return
    kind = outcome["kind"]
    if kind == "process_failure":
        st.error(f"Host process failure: {outcome['code']}")
        st.caption(f"Cleanup: {outcome['cleanup']}")
        return
    if kind == "bridge_error":
        st.error(f"Node bridge error: {outcome['code']}")
        st.caption(f"Cleanup: {outcome['cleanup']}")
        return
    terminal = outcome["terminal"]
    if kind == "success":
        label = "QA result" if terminal["status"] == "QA_ASSERTION_PASSED" else "Execution result"
        st.success(f"{label}: {terminal['status']}")
    elif outcome["stopKind"] == "qa_failure":
        st.error(f"QA assertion failed: {terminal['status']}")
    else:
        st.warning(f"Automation stopped: {terminal['status']}")
    st.caption(f"Phase: {terminal['phase']}")
    if "reason" in terminal:
        st.caption(f"Reason: {terminal['reason']}")
    context = outcome["context"]
    progress = context["progress"]
    st.subheader("Correlation and provenance")
    st.write(f"TestSpec: {context['testSpecId']}")
    st.write(f"Profile: {context['executionProfileRef']['id']}@{context['executionProfileRef']['version']}")
    st.write(f"Profile fingerprint: {context['profileFingerprint']}")
    st.write(f"Presentation: {context['presentationMode']}")
    st.write(f"Observation: {context['observation']['state']}")
    st.write(f"Autonomous eligible: {context['observation']['autonomousEligible']}")
    if context["presentationMode"] == "headed":
        st.caption("Headed execution is observational. A separate fresh headless workflow is required to establish autonomous equivalence.")
    if "explorationAttemptId" in progress:
        st.write(f"Exploration attempt: {progress['explorationAttemptId']}")
    if "resolvedSpecId" in progress:
        st.write(f"Resolved spec: {progress['resolvedSpecId']}")
    for run_id in progress.get("executionRunIds", []):
        st.write(f"Execution run: {run_id}")
    st.subheader("Report and evidence")
    if context["report"]["kind"] != "available":
        st.info("No stored report is available for this result.")
    elif result.projection_failed:
        st.warning("Safe report details could not be retrieved. The QA result above is unchanged.")
    elif result.projection is None:
        st.warning("Safe report details are unavailable. The QA result above is unchanged.")
    elif result.projection["kind"] == "unavailable":
        st.warning(f"Safe report details unavailable: {result.projection['reason']}. The QA result is unchanged.")
    else:
        projection = result.projection
        st.write(f"Screenshot: {projection['screenshot']}")
        for item in projection["outcomes"]:
            label = f"{item['phase']}: {item['status']}"
            if "assertionType" in item:
                label += f" ({item['assertionType']})"
            st.write(label)
            for key, title in (("executionRunId", "Run"), ("originStepId", "Origin step"),
                               ("executionStepId", "Execution step")):
                if key in item:
                    st.caption(f"{title}: {item[key]}")
            if "reason" in item:
                st.caption(f"Reason: {item['reason']}")
            for name in ("expected", "actual"):
                value = item[name]
                visible = value.get("value") if value["state"] == "displayable" else value["state"]
                st.caption(f"{name}: {visible}")
        st.caption(f"Authorized evidence descriptors: {len(projection['evidence'])}")
        for item in projection["evidence"]:
            st.write(f"{item['mediaType']} · {item['sensitivity']} · {item['byteLength']} bytes")
            st.caption(f"Evidence: {item['evidenceId']} · {item['owner']['kind']} {item['owner']['id']}"
                       f" · captured {item['capturedAt']}")
        if projection["screenshot"] == "stored_restricted":
            st.caption("Screenshot bytes are restricted and are not displayed.")


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
        "execution": "Execution reproduced without assertions; no QA verdict",
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
    if "deferredStage" in record:
        stop = record["deferredStage"]
        st.caption(f"Deferred stage: {stop['stage']} · Category: {stop['category']} · Code: {stop['code']}")
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
    elif record["workflowVersion"] == "deferred-action-v1":
        for index, replay in enumerate(projection["replays"], 1):
            st.write(f"Replay {index}: {replay['state']}")
            st.caption(f"Assertions: {replay['assertionCount']} ? Cleanup: {replay['cleanup']}")
        st.write(f"Reproducibility: {projection['reproducibility']}")
        if "authoritativeQa" in projection:
            st.write(f"Authoritative QA: {projection['authoritativeQa']}")
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
    selected_workflow = os.environ.get("PLAYWRIGHT_DEMO_WORKFLOW_VERSION", "legacy")
    st.caption(f"Trusted workflow: {selected_workflow}" if selected_workflow in
               {"legacy", "agentic-exploration-v1", "goal-directed-v1", "structured-action-v1", "deferred-action-v1"} else
               "Trusted workflow: invalid selection")
    if selected_workflow == "deferred-action-v1":
        st.caption("Deferred workflow is gated for offline review pending the independent release gate.")
    # Populate this slot after submission, but render it before the form and
    # the independently refreshing timeline so page growth cannot move it.
    live_view_slot = st.container()
    status = _status()

    with st.form("ui_test_request"):
        target_url = st.text_input("Public HTTP(S) URL", placeholder="https://example.org/")
        task_text = st.text_area("Testing task", placeholder="Describe the UI action and assertion.")
        submitted = st.form_submit_button("Start test", disabled=status.phase == "running")

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

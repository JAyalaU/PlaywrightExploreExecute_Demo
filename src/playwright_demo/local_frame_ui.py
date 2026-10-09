"""Observational frame-v2 UI for the local Chromium product path."""

from __future__ import annotations

from .local_frame_viewer import LocalFrameViewerBuffer


def render_local_frame_viewer(viewer: LocalFrameViewerBuffer, st) -> None:
    state, phase, handle = viewer.snapshot()
    st.subheader("Live browser view")
    st.caption("Frames come from the active local Chromium page. Viewing is observational only and does not affect QA authority.")
    labels = {"exploration": "Exploration", "compilation": "Compilation",
              "replay_1": "Replay 1", "replay_2": "Replay 2"}
    st.caption(f"Current phase: {labels.get(phase, 'Preparing')}" if state != "closed" else
               f"Completed phase: {labels.get(phase, 'Preparing')}")
    if state == "available":
        st.caption("View only. Automation controls this browser session.")
        if handle is not None and handle.get("frame") is not None:
            try:
                st.image(handle["frame"], caption="Current execution page")
            except Exception:
                viewer.mark_unavailable()
                st.warning("Live browser view unavailable. The final QA result is unchanged.")
        else:
            st.caption("Preparing image from the execution browser.")
    elif state in {"not_started", "connecting"}:
        st.caption("Waiting for the execution browser.")
    elif state == "transitioning":
        st.caption("Switching to the next workflow browser session.")
    elif state == "closed":
        st.caption("Live browser session closed.")
    else:
        st.warning("Live browser view unavailable. The final QA result is unchanged.")

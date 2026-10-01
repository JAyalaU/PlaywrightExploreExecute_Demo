"""Streamlit script entry for the supported guarded local launcher."""

import streamlit as st
import os

from playwright_demo.ui_shell import render_shell
from playwright_demo.ui_workflow import run_local_ui_request
from playwright_demo.project_env import load_project_env

load_project_env()


# A direct Streamlit invocation with an external bind cannot run the form.
# The supported launcher rejects that configuration before serving at all.
if st.get_option("server.address") != "127.0.0.1":
    st.error("This local UI requires the guarded loopback launcher.")
    st.stop()

render_shell(run_local_ui_request, live=bool(os.environ.get("PLAYWRIGHT_DEMO_TRUSTED_CONFIG")))

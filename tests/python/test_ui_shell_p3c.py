"""P3-C form and guarded-launch behavior without a Node child."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from playwright_demo.ui_launcher import (  # noqa: E402
    check_loopback_configuration, main, streamlit_command,
)
from playwright_demo.ui_shell import validate_input  # noqa: E402


def empty_shell():
    from playwright_demo.ui_shell import render_shell
    render_shell()


def shell_with_fake_host():
    import streamlit as st
    from playwright_demo.ui_shell import render_shell

    def fake_host(request):
        st.session_state["fake_calls"] = st.session_state.get("fake_calls", 0) + 1
        st.session_state["phase_during_call"] = st.session_state.playwright_demo_ui_status.phase

    render_shell(fake_host)


def shell_with_failing_host():
    from playwright_demo.ui_shell import render_shell

    def failing_host(request):
        raise RuntimeError("provider-private-detail")

    render_shell(failing_host)


class StreamlitShellTests(unittest.TestCase):
    def test_form_requires_http_url_and_nonempty_task_without_granting_authority(self):
        request = validate_input("  https://example.org/path?q=1  ", "  Check the page.  ")
        self.assertEqual((request.target_url, request.task_text),
                         ("https://example.org/path?q=1", "Check the page."))
        self.assertEqual(set(vars(request)), {"target_url", "task_text"})
        for url, task in (("", "Check."), ("file:///tmp/x", "Check."),
                          ("https://user:pass@example.org/", "Check."),
                          ("https://example.org/", "  ")):
            with self.subTest(url=url, task=task), self.assertRaises(ValueError):
                validate_input(url, task)

    def test_shell_captures_request_without_starting_a_child(self):
        app = AppTest.from_function(empty_shell).run()
        self.assertFalse(app.exception)
        self.assertIn("No test has started.", [item.value for item in app.info])
        app.text_input[0].set_value("https://example.org/")
        app.text_area[0].set_value("Assert a heading is visible.")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertIn("Request captured. No execution has started yet.",
                      [item.value for item in app.info])

    def test_injected_host_seam_runs_once_and_waits_for_final_return(self):
        app = AppTest.from_function(shell_with_fake_host).run()
        app.text_input[0].set_value("http://example.org/")
        app.text_area[0].set_value("Check the page.")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertEqual(app.session_state.fake_calls, 1)
        self.assertEqual(app.session_state.phase_during_call, "running")
        self.assertIn("The host returned a final result.",
                      [item.value for item in app.success])
        app.run()
        self.assertEqual(app.session_state.fake_calls, 1)

    def test_host_exception_is_not_rendered_as_qa_or_raw_diagnostic(self):
        app = AppTest.from_function(shell_with_failing_host).run()
        app.text_input[0].set_value("https://example.org/")
        app.text_area[0].set_value("Check the page.")
        app.button[0].click().run()
        self.assertFalse(app.exception)
        errors = [item.value for item in app.error]
        self.assertIn("The host call did not complete. No QA result is available.", errors)
        self.assertNotIn("provider-private-detail", str(errors))

    def test_streamlit_script_requires_loopback_before_rendering_form(self):
        import streamlit as st

        script = ROOT / "src" / "playwright_demo" / "streamlit_app.py"
        original_get_option = st.get_option

        def option_for(address):
            return lambda name: address if name == "server.address" else original_get_option(name)

        with patch("streamlit.get_option", side_effect=option_for("127.0.0.1")):
            allowed = AppTest.from_file(str(script)).run()
        self.assertFalse(allowed.exception)
        self.assertEqual(len(allowed.text_input), 1)
        with patch("streamlit.get_option", side_effect=option_for("0.0.0.0")):
            denied = AppTest.from_file(str(script)).run()
        self.assertFalse(denied.exception)
        self.assertEqual(len(denied.text_input), 0)
        self.assertIn("This local UI requires the guarded loopback launcher.",
                      [item.value for item in denied.error])


class LoopbackLaunchTests(unittest.TestCase):
    def test_fixed_launch_command_and_rejected_external_configuration(self):
        self.assertIn("--server.address=127.0.0.1", streamlit_command())
        self.assertIn("--server.allowedHosts=127.0.0.1", streamlit_command())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            cwd = root / "project"
            home.mkdir()
            cwd.mkdir()
            check_loopback_configuration(environment={}, working_directory=cwd,
                                         home_directory=home)
            for external in ("0.0.0.0", "::", "192.0.2.20", "localhost"):
                with self.subTest(external=external), self.assertRaises(ValueError):
                    check_loopback_configuration(
                        environment={"STREAMLIT_SERVER_ADDRESS": external},
                        working_directory=cwd, home_directory=home)
            config = cwd / ".streamlit" / "config.toml"
            config.parent.mkdir()
            config.write_text('[server]\naddress = "0.0.0.0"\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                check_loopback_configuration(environment={}, working_directory=cwd,
                                             home_directory=home)
            config.write_text('[server]\naddress = "127.0.0.1"\n', encoding="utf-8")
            check_loopback_configuration(environment={}, working_directory=cwd,
                                         home_directory=home)
            global_config = home / ".streamlit" / "config.toml"
            global_config.parent.mkdir()
            global_config.write_text('[server]\naddress = "0.0.0.0"\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                check_loopback_configuration(environment={}, working_directory=cwd,
                                             home_directory=home)

    def test_external_setting_fails_before_streamlit_process_starts(self):
        with patch("playwright_demo.ui_launcher.check_loopback_configuration",
                   side_effect=ValueError("external bind")) as check, \
             patch("playwright_demo.ui_launcher.subprocess.call") as launch:
            with self.assertRaises(SystemExit):
                main([])
            check.assert_called_once()
            launch.assert_not_called()
        with patch("playwright_demo.ui_launcher.check_loopback_configuration"), \
             patch("playwright_demo.ui_launcher.subprocess.call", return_value=0) as launch:
            self.assertEqual(main([]), 0)
            launch.assert_called_once_with(streamlit_command())


if __name__ == "__main__":
    unittest.main()

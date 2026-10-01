"""Local .env loading without touching the operator's real secret file."""

from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from playwright_demo.project_env import load_project_env
from playwright_demo import ui_launcher


class ProjectEnvTests(unittest.TestCase):
    def test_defaults_and_launch_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("# local defaults\nPLAYWRIGHT_DEMO_ENV_TEST_FIRST='from file'\n"
                            "PLAYWRIGHT_DEMO_ENV_TEST_SECOND=from-file\n", encoding="utf-8")
            with patch.dict(os.environ, {"PLAYWRIGHT_DEMO_ENV_TEST_SECOND": "from-launch"}):
                os.environ.pop("PLAYWRIGHT_DEMO_ENV_TEST_FIRST", None)
                try:
                    load_project_env(path)
                    self.assertEqual(os.environ["PLAYWRIGHT_DEMO_ENV_TEST_FIRST"], "from file")
                    self.assertEqual(os.environ["PLAYWRIGHT_DEMO_ENV_TEST_SECOND"], "from-launch")
                finally:
                    os.environ.pop("PLAYWRIGHT_DEMO_ENV_TEST_FIRST", None)

    def test_missing_file_is_optional(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            load_project_env(Path(directory) / ".env")

    def test_invalid_assignment_does_not_echo_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("not a name=private-test-value\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid project .env assignment"):
                load_project_env(path)

    def test_guarded_launcher_loads_defaults_before_starting_ui(self) -> None:
        calls: list[str] = []
        with patch.object(ui_launcher, "load_project_env", side_effect=lambda: calls.append("env")), \
             patch.object(ui_launcher, "check_loopback_configuration", side_effect=lambda: calls.append("guard")), \
             patch.object(ui_launcher.subprocess, "call", side_effect=lambda _cmd: calls.append("child") or 0):
            self.assertEqual(ui_launcher.main([]), 0)
        self.assertEqual(calls, ["env", "guard", "child"])


if __name__ == "__main__":
    unittest.main()

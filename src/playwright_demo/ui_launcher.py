"""Guarded loopback-only entry point for the local Streamlit PoC."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tomllib
from typing import Mapping, Sequence

from .project_env import load_project_env


_LOOPBACK = "127.0.0.1"


def _configured_address(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"Cannot validate Streamlit configuration: {path}") from error
    server = config.get("server", {})
    if not isinstance(server, dict):
        raise ValueError("Invalid Streamlit server configuration")
    address = server.get("address")
    if address is not None and not isinstance(address, str):
        raise ValueError("Invalid Streamlit server address")
    return address


def check_loopback_configuration(*, environment: Mapping[str, str] | None = None,
                                 working_directory: Path | None = None,
                                 home_directory: Path | None = None) -> None:
    """Reject conflicting bind settings before the Streamlit child exists."""
    env = os.environ if environment is None else environment
    address_values = [value for key, value in env.items()
                      if key.upper() == "STREAMLIT_SERVER_ADDRESS"]
    if any(value != _LOOPBACK for value in address_values):
        raise ValueError("Streamlit server address must be 127.0.0.1")
    cwd = Path.cwd() if working_directory is None else working_directory
    home = Path.home() if home_directory is None else home_directory
    for path in (home / ".streamlit" / "config.toml",
                 cwd / ".streamlit" / "config.toml"):
        address = _configured_address(path)
        if address is not None and address != _LOOPBACK:
            raise ValueError("Streamlit server address must be 127.0.0.1")


def streamlit_command() -> list[str]:
    script = Path(__file__).with_name("streamlit_app.py")
    return [
        sys.executable, "-m", "streamlit", "run", str(script),
        "--server.address=127.0.0.1", "--server.headless=true",
        "--server.allowedHosts=localhost", "--server.allowedHosts=127.0.0.1",
        "--server.enableCORS=true", "--server.enableXsrfProtection=true",
        "--server.enableStaticServing=false", "--browser.gatherUsageStats=false",
    ]


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        raise SystemExit("The local UI launcher accepts no binding or script arguments")
    load_project_env()
    try:
        check_loopback_configuration()
    except ValueError as error:
        raise SystemExit(str(error)) from error
    return subprocess.call(streamlit_command())


if __name__ == "__main__":
    raise SystemExit(main())

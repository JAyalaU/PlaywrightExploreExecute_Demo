"""Load local operator defaults before the guarded UI starts."""

from __future__ import annotations

import os
from pathlib import Path
import re


_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"


def load_project_env(path: Path = _ROOT_ENV) -> None:
    """Read simple dotenv assignments without replacing launch environment values."""
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        name, separator, value = stripped.partition("=")
        name = name.strip()
        if not separator or not _NAME.fullmatch(name):
            raise ValueError("Invalid project .env assignment")
        value = value.strip()
        if value.startswith(('"', "'")):
            quote = value[0]
            close = value.find(quote, 1)
            if close < 0 or value[close + 1:].strip() and not value[close + 1:].strip().startswith("#"):
                raise ValueError("Invalid project .env value")
            value = value[1:close]
        else:
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(name, value)

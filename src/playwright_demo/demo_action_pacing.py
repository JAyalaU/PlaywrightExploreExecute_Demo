"""Closed operator setting for presentation only."""

from __future__ import annotations

import re

MAX_DEMO_ACTION_PAUSE_MS = 3_000


def parse_demo_action_pause_ms(raw: str | None) -> int:
    if raw is None or raw == "0":
        return 0
    if not re.fullmatch(r"[1-9][0-9]*", raw, flags=re.ASCII):
        raise ValueError("Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS")
    value = int(raw)
    if value > MAX_DEMO_ACTION_PAUSE_MS:
        raise ValueError("Invalid PLAYWRIGHT_DEMO_ACTION_PAUSE_MS")
    return value

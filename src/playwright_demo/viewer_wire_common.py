"""Shared closed viewer frame parsing primitives."""

from __future__ import annotations

from typing import Any


class InvalidViewerNotice(ValueError):
    pass


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidViewerNotice("Duplicate viewer field")
        result[key] = value
    return result

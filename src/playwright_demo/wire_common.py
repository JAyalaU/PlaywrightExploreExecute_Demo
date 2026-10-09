"""Bounded transport primitives shared by the current Python host and v2 wire."""

from __future__ import annotations

import re
from typing import Any

MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 65_536
MAX_STDERR_BYTES = 16_384
DEFAULT_DEADLINE_MS = 300_000
MAX_DEADLINE_MS = 1_200_000

_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FP = re.compile(r"^[a-f0-9]{64}$")


class InvalidWire(ValueError):
    """The child response cannot be trusted as a Node result."""


def _obj(value: Any, required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if type(value) is not dict or not required <= value.keys() or value.keys() - required - optional:
        raise InvalidWire("Missing or unknown fields")
    return value


def _one(value: Any, choices: set[str] | frozenset[str]) -> None:
    if type(value) is not str or value not in choices:
        raise InvalidWire("Invalid enum")


def _id(value: Any, limit: int = 128) -> None:
    if type(value) is not str or len(value) > limit or not _ID.fullmatch(value):
        raise InvalidWire("Invalid identifier")


def _version(value: Any) -> None:
    if type(value) is not str or len(value) > 64 or not _VERSION.fullmatch(value):
        raise InvalidWire("Invalid profile version")


def _pairs_unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvalidWire("Duplicate JSON field")
        result[key] = value
    return result

"""Read-only P3-G0 admission lookup through Node's separate v1 exchange."""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from .host import _Drain, _stop_child

_MAX_WIRE = 8_192
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_FP = re.compile(r"^[a-f0-9]{64}$")


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate admission field")
        value[key] = item
    return value


def parse_admission_response(data: bytes) -> dict[str, Any]:
    """Accept only a closed lookup response; no policy material crosses to Python."""
    if not data or len(data) > _MAX_WIRE:
        raise ValueError("Invalid admission response size")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_pairs)
    except (UnicodeError, ValueError) as error:
        raise ValueError("Invalid admission response") from error
    if type(value) is not dict or value.get("admissionVersion") not in {"1", "2"}:
        raise ValueError("Invalid admission version")
    if value.get("kind") == "denied" and set(value) == {"admissionVersion", "kind"}:
        return value
    if value.get("kind") != "approved" or set(value) != {
        "admissionVersion", "kind", "canonicalUrl", "executionProfileRef", "profileFingerprint"
    }:
        raise ValueError("Invalid admission fields")
    ref = value["executionProfileRef"]
    if type(value["canonicalUrl"]) is not str:
        raise ValueError("Invalid admission URL")
    try:
        parsed_url = urlsplit(value["canonicalUrl"])
        valid_url = (parsed_url.scheme in {"http", "https"} and bool(parsed_url.netloc)
                     and bool(parsed_url.hostname))
    except ValueError:
        valid_url = False
    if (not valid_url or
            len(value["canonicalUrl"].encode("utf-8")) > 4096 or
            type(ref) is not dict or set(ref) != {"id", "version"} or
            type(ref["id"]) is not str or len(ref["id"]) > 128 or
            not _ID.fullmatch(ref["id"]) or type(ref["version"]) is not str or
            len(ref["version"]) > 64 or not _VERSION.fullmatch(ref["version"]) or
            type(value["profileFingerprint"]) is not str or
            not _FP.fullmatch(value["profileFingerprint"])):
        raise ValueError("Invalid admission approval")
    return value


def lookup_public_admission(
    target_url: str, *, node_entry: str | Path, config_path: str | Path,
    node_executable: str | Path = "node", deadline_ms: int = 10_000,
    environment: Mapping[str, str] | None = None,
    admission_version: str = "1",
    selection_only: bool = False,
) -> dict[str, Any]:
    """Return a legacy approval lookup or active PoC profile selection."""
    if admission_version not in {"1", "2"}:
        raise ValueError("Invalid admission version")
    if selection_only and admission_version != "1":
        raise ValueError("Profile selection uses the v1 wire shape")
    unavailable = {"admissionVersion": admission_version, "kind": "unavailable"}
    if type(deadline_ms) is not int or not 0 < deadline_ms <= 30_000:
        raise ValueError("Invalid admission deadline")
    if type(target_url) is not str:
        return unavailable
    data = json.dumps({"admissionVersion": admission_version, "kind": "lookup", "targetUrl": target_url},
                      separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
    if len(data) > _MAX_WIRE:
        return {"admissionVersion": admission_version, "kind": "denied"}
    try:
        process = subprocess.Popen(
            [str(node_executable), str(node_entry),
             "select" if selection_only else "lookup", str(config_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(environment) if environment is not None else None,
            start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
    except OSError:
        return unavailable
    assert process.stdin and process.stdout and process.stderr
    stdout, stderr = _Drain(process.stdout, _MAX_WIRE), _Drain(process.stderr, _MAX_WIRE)
    stdout.start()
    stderr.start()

    def write_request() -> None:
        try:
            process.stdin.write(data)
            process.stdin.close()
        except (OSError, ValueError):
            pass

    threading.Thread(target=write_request, daemon=True).start()
    timed_out = False
    try:
        process.wait(timeout=deadline_ms / 1000)
    except subprocess.TimeoutExpired:
        _stop_child(process)
        timed_out = True
    stdout.join(timeout=2)
    stderr.join(timeout=2)
    if not process.stdin.closed:
        process.stdin.close()
    if not stdout.is_alive():
        process.stdout.close()
    if not stderr.is_alive():
        process.stderr.close()
    if (timed_out or stdout.is_alive() or stderr.is_alive() or stdout.overflow or
            stderr.overflow or process.returncode != 0):
        return unavailable
    try:
        result = parse_admission_response(bytes(stdout.data))
        return result if result["admissionVersion"] == admission_version else unavailable
    except ValueError:
        return unavailable

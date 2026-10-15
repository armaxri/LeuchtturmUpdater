"""Tiny helper for Leuchtturm Updater script sources (protocol version 1).

Copy this file next to your script and import it. Standard library only, Python 3.8+.

Leuchtturm runs your script with one of these argument lists (the defaults; they can be
changed with "args" in the source settings):

    get_versions
    download_version --id <id> --version <version> --target-dir <dir>
    get_release_notes --id <id> --version <version>

and reads exactly one JSON document from stdout. Write logs to stderr with log(); they show
up in Leuchtturm's output channel. The full protocol is in docs/sources/script.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from typing import Any, Callable, Dict, List, NoReturn, Optional

PROTOCOL = 1
EXIT_ERROR = 1
EXIT_NOT_SUPPORTED = 3


def log(*parts: Any) -> None:
    """Writes a log line to stderr (forwarded to Leuchtturm's output channel)."""
    print(*parts, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    """Prints the single JSON response Leuchtturm reads from stdout."""
    document = {"protocol": PROTOCOL}
    document.update(payload)
    sys.stdout.write(json.dumps(document) + "\n")
    sys.stdout.flush()


def fail(message: str, detail: Optional[str] = None) -> NoReturn:
    """Reports an error. Leuchtturm shows `message` under Problems and logs `detail`."""
    payload: Dict[str, Any] = {"error": message}
    if detail:
        payload["detail"] = detail
    emit(payload)
    sys.exit(EXIT_ERROR)


def not_supported() -> NoReturn:
    """Exits with code 3: 'this action is not supported' (only meaningful for release notes)."""
    sys.exit(EXIT_NOT_SUPPORTED)


def ref() -> Dict[str, str]:
    """The `ref` values of the requested version, from LEUCHTTURM_REF_<KEY> (keys lowercased).

    The same values are also available as ${ref.<key>} in the "args" templates.
    """
    prefix = "LEUCHTTURM_REF_"
    return {k[len(prefix):].lower(): v for k, v in os.environ.items() if k.startswith(prefix)}


def sha256_file(path: str) -> str:
    """Hex SHA-256 of a file, for the optional "sha256" field."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Request:
    """The parsed command line: action plus id, version and target_dir where applicable."""

    def __init__(self, ns: argparse.Namespace) -> None:
        self.action: str = ns.action
        self.id: Optional[str] = getattr(ns, "id", None)
        self.version: Optional[str] = getattr(ns, "version", None)
        self.target_dir: Optional[str] = getattr(ns, "target_dir", None)


def parse_args(argv: Optional[List[str]] = None) -> Request:
    parser = argparse.ArgumentParser(description="Leuchtturm Updater script source")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("get_versions", help="list all available versions")
    download = sub.add_parser("download_version", help="download one version")
    download.add_argument("--id", required=True)
    download.add_argument("--version", required=True)
    download.add_argument("--target-dir", required=True)
    notes = sub.add_parser("get_release_notes", help="release notes of one version")
    notes.add_argument("--id", required=True)
    notes.add_argument("--version", required=True)
    return Request(parser.parse_args(argv))


Handler = Callable[[Request], Any]


def run(
    get_versions: Callable[[], List[Dict[str, Any]]],
    download_version: Handler,
    get_release_notes: Optional[Handler] = None,
    argv: Optional[List[str]] = None,
) -> None:
    """Parses the arguments, calls the matching handler and prints its result.

    - get_versions() returns the list of artifacts.
    - download_version(req) returns {"path": ...} or {"url": ..., "headers": {...}}.
    - get_release_notes(req) returns Markdown, or None if there are none.

    Any exception becomes an error response with the traceback as detail.
    """
    req = parse_args(argv)
    try:
        if req.action == "get_versions":
            emit({"artifacts": get_versions()})
        elif req.action == "download_version":
            emit(download_version(req))
        elif req.action == "get_release_notes":
            markdown = get_release_notes(req) if get_release_notes else None
            if markdown is None:
                not_supported()
            emit({"markdown": markdown})
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - report everything to Leuchtturm
        fail(str(exc) or type(exc).__name__, traceback.format_exc())

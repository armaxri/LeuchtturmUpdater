#!/usr/bin/env python3
"""The "hello world" of script sources: a hard-coded list, and a URL for each download.

Try it:
    python3 minimal_static.py get_versions | python3 -m json.tool
    python3 minimal_static.py download_version --id corp.hello --version 1.1.0 --target-dir /tmp
"""

import os

from _leuchtturm import log, run

# Where the .vsix files live. Set "env": { "ARTIFACT_HOST": "..." } in the source settings.
HOST = os.environ.get("ARTIFACT_HOST", "https://files.corp.example").rstrip("/")

RELEASES = {
    "1.1.0": "- Greets in more languages",
    "1.0.0": "- First release",
}


def get_versions():
    log(f"listing {len(RELEASES)} versions from {HOST}")
    return [
        {
            "id": "corp.hello",
            "displayName": "Corp Hello",
            "versions": [{"version": v, "releaseNotes": notes} for v, notes in RELEASES.items()],
        }
    ]


def download_version(req):
    # Leuchtturm downloads the URL itself, so this script stays tiny.
    return {"url": f"{HOST}/corp.hello-{req.version}.vsix"}


if __name__ == "__main__":
    run(get_versions, download_version)

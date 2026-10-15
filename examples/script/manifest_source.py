#!/usr/bin/env python3
"""Reads a versions.json manifest from a web server. Useful when a release pipeline already
writes such a file next to the .vsix files.

Manifest format:
    {
      "artifacts": [
        {
          "id": "corp.linter",
          "displayName": "Corp Linter",
          "versions": [
            { "version": "1.4.1", "url": "https://files.corp.example/corp.linter-1.4.1.vsix",
              "sha256": "…", "notes": "- Fix crash" }
          ]
        }
      ]
    }

Settings:
    "env": { "MANIFEST_URL": "https://files.corp.example/vscode/versions.json" }
"""

import json
import os
import urllib.parse
import urllib.request

from _leuchtturm import fail, log, ref, run


def get_versions():
    url = os.environ.get("MANIFEST_URL")
    if not url:
        fail("MANIFEST_URL is not set")
    with urllib.request.urlopen(url, timeout=30) as response:
        manifest = json.loads(response.read().decode("utf-8"))
    artifacts = []
    for entry in manifest.get("artifacts", []):
        versions = []
        for v in entry.get("versions", []):
            item = {"version": v["version"], "ref": {"url": urllib.parse.urljoin(url, v["url"])}}
            if v.get("sha256"):
                item["sha256"] = v["sha256"]
            if v.get("notes"):
                item["releaseNotes"] = v["notes"]
            versions.append(item)
        artifact = {"id": entry["id"], "versions": versions}
        if entry.get("displayName"):
            artifact["displayName"] = entry["displayName"]
        artifacts.append(artifact)
    log(f"manifest lists {len(artifacts)} artifact(s)")
    return artifacts


def download_version(req):
    return {"url": ref()["url"]}


if __name__ == "__main__":
    run(get_versions, download_version)

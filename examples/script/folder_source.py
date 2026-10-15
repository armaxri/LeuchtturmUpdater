#!/usr/bin/env python3
"""Scans a folder (or mounted share) for .vsix files and returns local paths on download.

Shows the "path" download response and the optional "sha256" field.

Settings:
    "env": { "VSIX_FOLDER": "/Volumes/tools/vsix" }

Try it:
    VSIX_FOLDER=~/vsix python3 folder_source.py get_versions | python3 -m json.tool
"""

import os
import re
import shutil

from _leuchtturm import fail, log, ref, run, sha256_file

PATTERN = re.compile(r"^(?P<id>[\w-]+\.[\w-]+)-(?P<version>\d+\.\d+\.\d+(?:-[\w.]+)?)\.vsix$", re.I)


def folder():
    path = os.path.expanduser(os.environ.get("VSIX_FOLDER", ""))
    if not path:
        fail("VSIX_FOLDER is not set", 'Add "env": { "VSIX_FOLDER": "..." } to the source settings.')
    if not os.path.isdir(path):
        fail(f"Folder not found: {path}")
    return path


def get_versions():
    root = folder()
    artifacts = {}
    for name in sorted(os.listdir(root)):
        match = PATTERN.match(name)
        if not match:
            continue
        file = os.path.join(root, name)
        artifact = artifacts.setdefault(match["id"], {"id": match["id"], "versions": []})
        version = {"version": match["version"], "sha256": sha256_file(file), "ref": {"file": name}}
        notes = os.path.join(root, name[: -len(".vsix")] + ".md")
        if os.path.isfile(notes):
            with open(notes, encoding="utf-8") as f:
                version["releaseNotes"] = f.read()
        artifact["versions"].append(version)
    log(f"found {sum(len(a['versions']) for a in artifacts.values())} file(s) in {root}")
    return list(artifacts.values())


def download_version(req):
    # `ref` holds what get_versions stored for this version.
    source = os.path.join(folder(), ref()["file"])
    target = os.path.join(req.target_dir, os.path.basename(source))
    shutil.copyfile(source, target)  # copy, so a share changing mid-install does no harm
    return {"path": target}


if __name__ == "__main__":
    run(get_versions, download_version)

#!/usr/bin/env python3
"""Reads successful builds from the Jenkins JSON API, for a Jenkins that needs a login.
Shows how a script handles the login itself (Leuchtturm never sees credentials) and how
`ref` carries the build number from listing to download.

The login comes from your environment: JENKINS_USER and JENKINS_TOKEN (an API token from
your Jenkins user page). Set them where VS Code picks them up, e.g. in your shell profile.
Or replace `credentials()` with whatever your company uses (a keyring, a token file, ...).

Settings:
    "env": {
        "JENKINS_URL": "https://jenkins.corp.example",
        "JENKINS_JOB": "corp-linter"
    }
"""

import base64
import json
import os
import re
import shutil
import urllib.error
import urllib.request

from _leuchtturm import fail, log, ref, run

PATTERN = re.compile(r"^(?P<id>[\w-]+\.[\w-]+)-(?P<version>\d+\.\d+\.\d+(?:-[\w.]+)?)\.vsix$")


def config():
    try:
        base = os.environ["JENKINS_URL"].rstrip("/")
        job = os.environ["JENKINS_JOB"]
    except KeyError as missing:
        fail(f"Environment variable {missing} is not set")
    return base, job


def credentials():
    """User name and API token, or None for a Jenkins that allows anonymous reading."""
    user, token = os.environ.get("JENKINS_USER"), os.environ.get("JENKINS_TOKEN")
    return (user, token) if user and token else None


def open_url(url, timeout=30):
    headers = {}
    login = credentials()
    if login:
        basic = base64.b64encode(f"{login[0]}:{login[1]}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def get(url):
    try:
        with open_url(url) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        hint = " (check JENKINS_USER/JENKINS_TOKEN)" if err.code in (401, 403) else ""
        fail(f"HTTP {err.code} from Jenkins{hint}", url)


def get_versions():
    base, job = config()
    tree = "builds[number,result,artifacts[fileName,relativePath]]{0,20}"
    data = json.loads(get(f"{base}/job/{job}/api/json?tree={tree}"))
    artifacts = {}
    for build in data.get("builds", []):
        if build.get("result") != "SUCCESS":
            continue
        for item in build.get("artifacts", []):
            match = PATTERN.match(item["fileName"])
            if not match:
                continue
            artifact = artifacts.setdefault(match["id"], {"id": match["id"], "versions": []})
            if any(v["version"] == match["version"] for v in artifact["versions"]):
                continue  # newest build first: keep the first one
            artifact["versions"].append(
                {
                    "version": match["version"],
                    "ref": {"build": str(build["number"]), "path": item["relativePath"]},
                }
            )
    log(f"{len(artifacts)} artifact(s) in job {job}")
    return list(artifacts.values())


def download_version(req):
    base, job = config()
    r = ref()
    # The download needs the login too, so the script fetches the file itself and answers
    # with its path.
    url = f"{base}/job/{job}/{r['build']}/artifact/{r['path']}"
    target = os.path.join(req.target_dir, os.path.basename(r["path"]))
    try:
        with open_url(url, timeout=300) as response, open(target, "wb") as out:
            shutil.copyfileobj(response, out)
    except urllib.error.HTTPError as err:
        fail(f"HTTP {err.code} from Jenkins while downloading", url)
    return {"path": target}


def get_release_notes(req):
    base, job = config()
    url = f"{base}/job/{job}/{ref()['build']}/artifact/CHANGELOG.md"
    try:
        with open_url(url) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None  # no CHANGELOG.md in this build: "not supported"
        raise


if __name__ == "__main__":
    run(get_versions, download_version, get_release_notes)

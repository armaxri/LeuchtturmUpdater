#!/usr/bin/env python3
"""Reads successful builds from the Jenkins JSON API. Shows credentials from environment
variables and how `ref` carries the build number from listing to download.

Settings (store the token with "Leuchtturm: Store Credential…"):
    "env": {
        "JENKINS_URL": "https://jenkins.corp.example",
        "JENKINS_JOB": "corp-linter",
        "JENKINS_USER": "ci-reader",
        "JENKINS_TOKEN": "${secret:jenkins}"
    }
"""

import base64
import json
import os
import re
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


def auth_header():
    user, token = os.environ.get("JENKINS_USER"), os.environ.get("JENKINS_TOKEN")
    if not user or not token:
        return {}
    basic = base64.b64encode(f"{user}:{token}".encode()).decode()
    return {"Authorization": f"Basic {basic}"}


def get(url):
    request = urllib.request.Request(url, headers=auth_header())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
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
    # Return the URL plus headers; Leuchtturm downloads it and masks the header in its log.
    return {"url": f"{base}/job/{job}/{r['build']}/artifact/{r['path']}", "headers": auth_header()}


def get_release_notes(req):
    base, job = config()
    url = f"{base}/job/{job}/{ref()['build']}/artifact/CHANGELOG.md"
    request = urllib.request.Request(url, headers=auth_header())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None  # no CHANGELOG.md in this build: "not supported"
        raise


if __name__ == "__main__":
    run(get_versions, download_version, get_release_notes)

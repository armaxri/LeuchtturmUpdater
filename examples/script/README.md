# Script source examples

Python 3.8+, standard library only. Each script imports `_leuchtturm.py` (copy it next to your
own script). The protocol is described in [`docs/sources/script.md`](../../docs/sources/script.md).

| Script               | Shows                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `minimal_static.py`  | The smallest possible source: a hard-coded list, downloads by URL.                                      |
| `folder_source.py`   | Scanning a folder or share, `path` downloads, `sha256`, release notes from `.md` files.                 |
| `jenkins_source.py`  | A Jenkins that needs a login: the script signs in and downloads itself, `ref` carries the build number. |
| `manifest_source.py` | A `versions.json` manifest on a web server.                                                             |
| `_leuchtturm.py`     | Helper: argument parsing, `emit()`, `fail()`, `not_supported()`, `ref()`, `sha256_file()`.              |

## Try them on the command line

```sh
cd examples/script

python3 minimal_static.py get_versions | python3 -m json.tool
python3 minimal_static.py download_version --id corp.hello --version 1.1.0 --target-dir /tmp

VSIX_FOLDER=~/vsix python3 folder_source.py get_versions | python3 -m json.tool

JENKINS_URL=https://jenkins.corp.example JENKINS_JOB=corp-linter \
JENKINS_USER=me JENKINS_TOKEN=… python3 jenkins_source.py get_versions

MANIFEST_URL=https://files.corp.example/vscode/versions.json python3 manifest_source.py get_versions

# ref values are passed as environment variables:
LEUCHTTURM_REF_FILE=corp.a-1.0.0.vsix VSIX_FOLDER=~/vsix \
  python3 folder_source.py download_version --id corp.a --version 1.0.0 --target-dir /tmp
```

On Windows, use `py` instead of `python3`.

## Settings

```jsonc
// User settings (settings.json)
"leuchtturm.script.enabled": true,
"leuchtturm.sources": {
  "folder": {
    "type": "script",
    "command": "python3",
    "script": "~/leuchtturm/folder_source.py",
    "env": { "VSIX_FOLDER": "/Volumes/tools/vsix" }
  },
  "jenkins": {
    "type": "script",
    "command": "python3",
    "script": "~/leuchtturm/jenkins_source.py",
    "env": {
      "JENKINS_URL": "https://jenkins.corp.example",
      "JENKINS_JOB": "corp-linter"
    }
  }
}
```

`jenkins_source.py` reads `JENKINS_USER` and `JENKINS_TOKEN` from your environment (scripts
get your normal environment), so Leuchtturm never sees them. Swap that part for whatever your
company uses. The first run of each script asks for your approval. More snippets: [`examples/settings/script.jsonc`](../settings/script.jsonc).

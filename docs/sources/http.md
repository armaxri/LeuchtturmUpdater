# `http` source: Jenkins, web servers, Artifactory, GitLab …

**The easy way:** run **Leuchtturm: Add Source…** (the **+** in the Leuchtturm view) and paste
the link where you download the extension: a Jenkins job, its _Last Successful Artifacts_ page,
a single artifact link, or any web page that lists `.vsix` files. Leuchtturm recognises what it
is, shows the extensions and versions it found, and writes the configuration below for you.
Read on if you want to adjust it or write it by hand.

The `http` source is for servers that need **no login**. Leuchtturm does not handle
credentials, certificates or custom headers. For a server that needs a login, use a
[`script` source](script.md): your script signs in and downloads, Leuchtturm runs it.

The `http` source works in three steps:

1. **Index request**: fetch a page or API response that lists the available files.
2. **Matcher**: find every version in that response, with a regex, a JSONPath, or both.
3. **Download request**: build the download URL from the values the matcher captured.

```jsonc
// User settings (settings.json)
"leuchtturm.sources": {
  "jenkins-linter": {
    "type": "http",
    "index": { "url": "https://jenkins.corp.example/job/corp-linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}" },
    "match": {
      "jsonPath": "$.builds[*].artifacts[*]",
      "where": { "result": "SUCCESS" },
      "field": "fileName",
      "regex": "^(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix$"
    },
    "download": { "url": "https://jenkins.corp.example/job/corp-linter/${number}/artifact/${relativePath}" },
    "releaseNotes": { "url": "https://jenkins.corp.example/job/corp-linter/${number}/artifact/CHANGELOG.md" }
  }
}
```

Run **Leuchtturm: Test Source…** to see what was matched.

## Options

| Field                           | Description                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `index.url`                     | URL of the listing. `${env:NAME}` works here.                                                                            |
| `index.method`                  | `GET` (default), `POST` or `HEAD`.                                                                                       |
| `index.body`                    | Request body (templated like the URL).                                                                                   |
| `match.regex`                   | Regex with named groups. `version` is required, and `id` unless `match.id` is set. Every match in the body is collected. |
| `match.flags`                   | Regex flags, default `g`. `g` is always added.                                                                           |
| `match.jsonPath`                | For JSON responses: selects items, e.g. `$.builds[*].artifacts[*]`. See below.                                           |
| `match.field`                   | jsonPath mode: the field `regex` runs on. Default `value` (for plain string items).                                      |
| `match.where`                   | Only keep matches whose groups or fields have these exact values, e.g. `{ "result": "SUCCESS" }`.                        |
| `match.id`                      | Fixed extension ID, for listings that only contain versions.                                                             |
| `download.url`                  | Download URL. Every captured group, `${id}` and `${version}` are available.                                              |
| `releaseNotes.url`              | Optional release notes URL (templated like `download.url`). Fetched when you click _Release notes_.                      |
| `timeout`                       | Seconds for the index request (default `leuchtturm.http.timeout`). Downloads get ten times as long, at least 5 minutes.  |
| `include`, `exclude`, `enabled` | As for every source.                                                                                                     |

`auth`, `headers`, `ca` and `strictSSL` are not supported: a source that sets them shows a
problem that points to script sources. HTTPS works with the certificates VS Code trusts, which
include the ones installed on your computer, so an internal company CA that your IT installed
works without any setting.

### How matching works

**Regex mode** (`regex` only): the regex runs over the whole response body. Each match's named
groups become one record. The first match of an `(id, version)` wins, so a listing sorted
newest-first picks the newest build of a version.

**JSONPath mode** (`jsonPath`, optionally with `regex`): each selected item becomes one record
holding the item's scalar fields **and those of its parent objects**. For
`$.builds[*].artifacts[*]`, the record of an artifact contains `fileName` and
`relativePath`, plus `number` and `result` from its build. If `regex` is set, it runs on
`field` and its named groups are added. Supported JSONPath syntax: `$`, `.key`, `['key']`,
`[0]`, `[-1]`, `[*]`, `.*` and `..key` (any depth).

Every record must end up with a valid semver `version` and an `id` (or `match.id`). Records
that don't are listed with the reason by _Test Source_.

### Templates

All captured groups and fields are available as `${name}` in `download.url` and
`releaseNotes.url`, together with `${id}`, `${version}`, `${env:NAME}`, `${userHome}` and
`${platform}`. An unknown variable is a
configuration error, never an empty string. In regex mode, Leuchtturm checks the template
against the regex's group names when the settings are loaded.

### Servers that need a login

Leuchtturm sends no credentials. When a server answers with _401_ or _403_, or redirects to a
login page, the source shows a problem saying that the server needs a login, and _Add Source_
says so right away. Ask whoever runs the server for a script that signs in, lists the
extensions and downloads them (or write one; [`examples/script/jenkins_source.py`](../../examples/script/jenkins_source.py)
is a starting point for Jenkins), and add it as a [`script` source](script.md).

## Debugging with Test Source

**Leuchtturm: Test Source…** prints, for one source:

- the request and the HTTP status (`401`/`403` say that the server needs a login),
- the first 2 KB of the response body,
- every match with all its groups, and the download URL resolved from them,
- every candidate that was skipped, and why.

## Recipes

### Jenkins, JSON API with a regex

The original variant from the spec: one regex over the raw JSON. It works because Jenkins
returns compact JSON in a fixed field order.

```jsonc
"jenkins-linter": {
  "type": "http",
  "index": { "url": "https://jenkins.corp.example/job/corp-linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}" },
  "match": {
    "regex": "\"number\":(?<build>\\d+),\"result\":\"SUCCESS\",\"artifacts\":\\[\\{\"fileName\":\"(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix\",\"relativePath\":\"(?<path>[^\"]+)\""
  },
  "download": { "url": "https://jenkins.corp.example/job/corp-linter/${build}/artifact/${path}" }
}
```

The JSONPath variant at the top of this page is easier to read and does not depend on field
order; prefer it.

### Jenkins, artifact directory listing (HTML)

When the API is not reachable, use the HTML page of a build's artifacts:

```jsonc
"jenkins-html": {
  "type": "http",
  "index": { "url": "https://jenkins.corp.example/job/corp-linter/lastSuccessfulBuild/artifact/dist/" },
  "match": { "regex": "href=\"(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)\"" },
  "download": { "url": "https://jenkins.corp.example/job/corp-linter/lastSuccessfulBuild/artifact/dist/${file}" }
}
```

This only sees the last successful build, so older versions cannot be installed from it.

### Apache or nginx directory listing (autoindex)

```jsonc
"web": {
  "type": "http",
  "index": { "url": "https://files.corp.example/vscode/" },
  "match": { "regex": "href=\"(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)\\.vsix)\"" },
  "download": { "url": "https://files.corp.example/vscode/${file}" }
}
```

### Artifactory folder (storage API, anonymous read access)

```jsonc
"artifactory": {
  "type": "http",
  "index": { "url": "https://artifactory.corp.example/artifactory/api/storage/vscode-local/extensions" },
  "match": {
    "jsonPath": "$.children[*]",
    "where": { "folder": "false" },
    "field": "uri",
    "regex": "^/(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)$"
  },
  "download": { "url": "https://artifactory.corp.example/artifactory/vscode-local/extensions/${file}" }
}
```

### GitLab generic packages (public project)

One package per extension, named after the extension ID. Because GitLab's own `id` field is the
numeric package ID, set `match.id`:

```jsonc
"gitlab-linter": {
  "type": "http",
  "index": {
    "url": "https://gitlab.corp.example/api/v4/projects/1234/packages?package_type=generic&package_name=corp.linter&order_by=version&sort=desc"
  },
  "match": { "jsonPath": "$[*]", "where": { "status": "default" }, "id": "corp.linter" },
  "download": {
    "url": "https://gitlab.corp.example/api/v4/projects/1234/packages/generic/corp.linter/${version}/corp.linter-${version}.vsix"
  }
}
```

Each package item has a `version` field, so no regex is needed.

### Gitea / Forgejo generic packages

```jsonc
"gitea-linter": {
  "type": "http",
  "index": { "url": "https://gitea.corp.example/api/v1/packages/tools?type=generic&q=corp.linter" },
  "match": { "jsonPath": "$[*]", "where": { "name": "corp.linter" }, "id": "corp.linter" },
  "download": { "url": "https://gitea.corp.example/api/packages/tools/generic/corp.linter/${version}/corp.linter-${version}.vsix" }
}
```

## Limits

- Proxies are handled by VS Code, see [Proxies](../configuration.md#proxies).
- Pagination: only the first page of an API response is read. Ask for enough items in the
  index URL (`{0,20}` for Jenkins, `per_page=100` for GitLab).

More complete snippets are in [`examples/settings/http.jsonc`](../../examples/settings/http.jsonc).

# `http` source: Jenkins, web servers, Artifactory, GitLab …

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
    "auth": { "basic": { "user": "ci-reader", "password": "${secret:jenkins}" } },
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

Then run **Leuchtturm: Store Credential…**, pick `jenkins` and enter the password or API
token. Finally run **Leuchtturm: Test Source…** to see what was matched.

## Options

| Field                           | Description                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.url`                     | URL of the listing. `${env:NAME}` and `${secret:NAME}` work here.                                                                                                     |
| `index.method`                  | `GET` (default), `POST` or `HEAD`.                                                                                                                                    |
| `index.headers`, `index.body`   | Extra headers and request body (templated like the URL).                                                                                                              |
| `match.regex`                   | Regex with named groups. `version` is required, and `id` unless `match.id` is set. Every match in the body is collected.                                              |
| `match.flags`                   | Regex flags, default `g`. `g` is always added.                                                                                                                        |
| `match.jsonPath`                | For JSON responses: selects items, e.g. `$.builds[*].artifacts[*]`. See below.                                                                                        |
| `match.field`                   | jsonPath mode: the field `regex` runs on. Default `value` (for plain string items).                                                                                   |
| `match.where`                   | Only keep matches whose groups or fields have these exact values, e.g. `{ "result": "SUCCESS" }`.                                                                     |
| `match.id`                      | Fixed extension ID, for listings that only contain versions.                                                                                                          |
| `download.url`                  | Download URL. Every captured group, `${id}` and `${version}` are available.                                                                                           |
| `download.headers`              | Extra headers for the download (templated).                                                                                                                           |
| `releaseNotes.url`              | Optional release notes URL (templated like `download.url`). Fetched with the source's credentials when you click _Release notes_.                                     |
| `auth`                          | `{ "basic": { "user": "…", "password": "…" } }` or `{ "bearer": "…" }`. Sent with every request of this source, unless a request sets its own `Authorization` header. |
| `ca`                            | Path to an extra trusted CA certificate (PEM), for servers with an internal CA.                                                                                       |
| `strictSSL`                     | `true` by default. `false` turns off certificate checks; Leuchtturm then shows a warning in the log and in the tooltip. Prefer `ca`.                                  |
| `timeout`                       | Seconds for the index request (default `leuchtturm.http.timeout`). Downloads get ten times as long, at least 5 minutes.                                               |
| `include`, `exclude`, `enabled` | As for every source.                                                                                                                                                  |

`strictSSL` and `ca` may also be written inside `index`, as in older examples.

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

All captured groups and fields are available as `${name}` in `download.url`,
`download.headers` and `releaseNotes.url`, together with `${id}`, `${version}`,
`${env:NAME}`, `${secret:NAME}`, `${userHome}` and `${platform}`. An unknown variable is a
configuration error, never an empty string. In regex mode, Leuchtturm checks the template
against the regex's group names when the settings are loaded.

### Credentials

Never put passwords or tokens into `settings.json`. Use `${secret:NAME}` and store the value
with **Leuchtturm: Store Credential…**. It goes into VS Code's secret storage, which is
encrypted by the operating system's keychain. `${env:NAME}` works too, for example in CI.

Leuchtturm masks stored secrets, `Authorization` headers and URL passwords in every log line.
When a redirect leads to a different host, the `Authorization` header is dropped.

## Debugging with Test Source

**Leuchtturm: Test Source…** prints, for one source:

- the request and the HTTP status (`401`/`403` come with "check credentials"),
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
  "auth": { "basic": { "user": "ci-reader", "password": "${secret:jenkins}" } },
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
  "auth": { "basic": { "user": "ci-reader", "password": "${secret:jenkins}" } },
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
  "download": { "url": "https://files.corp.example/vscode/${file}" },
  "ca": "~/certs/corp-root-ca.pem"
}
```

### Artifactory folder (storage API)

```jsonc
"artifactory": {
  "type": "http",
  "index": { "url": "https://artifactory.corp.example/artifactory/api/storage/vscode-local/extensions" },
  "auth": { "bearer": "${secret:artifactory}" },
  "match": {
    "jsonPath": "$.children[*]",
    "where": { "folder": "false" },
    "field": "uri",
    "regex": "^/(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)$"
  },
  "download": { "url": "https://artifactory.corp.example/artifactory/vscode-local/extensions/${file}" }
}
```

### GitLab generic packages

One package per extension, named after the extension ID. Because GitLab's own `id` field is the
numeric package ID, set `match.id`:

```jsonc
"gitlab-linter": {
  "type": "http",
  "index": {
    "url": "https://gitlab.corp.example/api/v4/projects/1234/packages?package_type=generic&package_name=corp.linter&order_by=version&sort=desc",
    "headers": { "PRIVATE-TOKEN": "${secret:gitlab}" }
  },
  "match": { "jsonPath": "$[*]", "where": { "status": "default" }, "id": "corp.linter" },
  "download": {
    "url": "https://gitlab.corp.example/api/v4/projects/1234/packages/generic/corp.linter/${version}/corp.linter-${version}.vsix",
    "headers": { "PRIVATE-TOKEN": "${secret:gitlab}" }
  }
}
```

Each package item has a `version` field, so no regex is needed.

### Gitea / Forgejo generic packages

```jsonc
"gitea-linter": {
  "type": "http",
  "index": { "url": "https://gitea.corp.example/api/v1/packages/tools?type=generic&q=corp.linter" },
  "auth": { "bearer": "${secret:gitea}" },
  "match": { "jsonPath": "$[*]", "where": { "name": "corp.linter" }, "id": "corp.linter" },
  "download": { "url": "https://gitea.corp.example/api/packages/tools/generic/corp.linter/${version}/corp.linter-${version}.vsix" }
}
```

## Limits

- Proxies: `http.proxy` is not applied yet (planned for milestone M6).
- Pagination: only the first page of an API response is read. Ask for enough items in the
  index URL (`{0,20}` for Jenkins, `per_page=100` for GitLab).

More complete snippets are in [`examples/settings/http.jsonc`](../../examples/settings/http.jsonc).

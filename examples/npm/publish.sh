#!/bin/sh
# Wraps a .vsix into an npm package and publishes it, the way Leuchtturm's `npm` source expects:
# exactly one .vsix at the package root, and "vscodeExtension" in package.json.
#
# Usage:
#   ./publish.sh dist/corp.linter-1.4.1.vsix https://nexus.corp.example/repository/npm-internal/
#
# Environment:
#   PACKAGE_SCOPE   npm scope for the package name (default: @corp-vscode)
#   PACK_ONLY=1     only run `npm pack` into the current directory, do not publish
#
# Authentication is whatever npm uses: an `.npmrc` with `//host/path/:_authToken=…`, or
# NPM_CONFIG_USERCONFIG pointing at one (typical in CI).
set -eu

VSIX=${1:?usage: publish.sh <file.vsix> [registry-url]}
REGISTRY=${2:-}
SCOPE=${PACKAGE_SCOPE:-@corp-vscode}

FILE=$(basename "$VSIX")
# corp.linter-1.4.1.vsix → id corp.linter, version 1.4.1 (prereleases like 2.0.0-beta.1 work too)
ID=$(printf '%s' "$FILE" | sed -nE 's/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)-([0-9]+\.[0-9]+\.[0-9]+.*)\.vsix$/\1/p')
VERSION=$(printf '%s' "$FILE" | sed -nE 's/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)-([0-9]+\.[0-9]+\.[0-9]+.*)\.vsix$/\2/p')
if [ -z "$ID" ] || [ -z "$VERSION" ]; then
  echo "Cannot read id and version from $FILE (expected publisher.name-1.2.3.vsix, as vsce names it)" >&2
  exit 1
fi
NAME="$SCOPE/${ID#*.}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$VSIX" "$WORK/$FILE"
cat > "$WORK/package.json" <<JSON
{
  "name": "$NAME",
  "version": "$VERSION",
  "description": "VS Code extension $ID, packaged for Leuchtturm Updater",
  "vscodeExtension": "$ID",
  "files": ["$FILE"]
}
JSON

if [ "${PACK_ONLY:-}" = "1" ]; then
  npm pack "$WORK" --pack-destination "$(pwd)"
elif [ -n "$REGISTRY" ]; then
  npm publish "$WORK" --registry "$REGISTRY"
else
  npm publish "$WORK"
fi

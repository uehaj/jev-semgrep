#!/bin/sh
# Release: bump the version, push the tag to GitHub, publish to npm, create a GitHub Release.
#   sh scripts/release.sh patch|minor|major|<x.y.z>
# Preconditions: on main, clean working tree, HEAD == origin/main, tests pass.
# npm publish does 2FA in the browser, so run this from an interactive terminal (not via `!`).
set -eu
cd "$(dirname "$0")/.."
bump=${1:?usage: release.sh patch|minor|major|x.y.z}

[ "$(git branch --show-current)" = main ] || { echo "release: run this on the main branch" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: working tree has uncommitted changes" >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release: HEAD differs from origin/main (pull or push first)" >&2; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "release: not logged in to npm (npm login)" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "release: not logged in to GitHub (gh auth login)" >&2; exit 1; }

npm test

npm version "$bump" -m "v%s" >/dev/null
ver=$(node -p "require('./package.json').version")
git push --follow-tags
npm publish --access public
gh release create "v$ver" --title "v$ver" --generate-notes

echo "released v$ver"
echo "verify: npm view @uehaj/semgrep version  /  npx @uehaj/semgrep@$ver --help"

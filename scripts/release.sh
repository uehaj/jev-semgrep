#!/bin/sh
# Release: bump the version, push the tag to GitHub, publish to npm, create a GitHub Release.
#   sh scripts/release.sh patch|minor|major|<x.y.z>
#   sh scripts/release.sh next|<x.y.z-next.N>   # prerelease, published under the npm "next" dist-tag;
#                                                 the first prerelease needs an explicit x.y.z-next.N,
#                                                 since "npm version prerelease" only bumps the patch
# Preconditions: on main, clean working tree, HEAD == origin/main, tests pass.
# npm publish does 2FA in the browser, so run this from an interactive terminal (not via `!`).
set -eu
cd "$(dirname "$0")/.."
bump=${1:?usage: release.sh patch|minor|major|x.y.z|next|x.y.z-next.N}
[ "$bump" != next ] || case $(node -p "require('./package.json').version") in *-*) ;; *) echo "release: 'next' bumps an existing prerelease; the first one needs x.y.z-next.N (e.g. 0.5.0-next.0)" >&2; exit 1 ;; esac

[ "$(git branch --show-current)" = main ] || { echo "release: run this on the main branch" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: working tree has uncommitted changes" >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release: HEAD differs from origin/main (pull or push first)" >&2; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "release: not logged in to npm (npm login)" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "release: not logged in to GitHub (gh auth login)" >&2; exit 1; }

npm test

pre=
case "$bump" in
  next) npm version prerelease --preid next -m "v%s" >/dev/null; pre=1 ;;
  *-next.*) npm version "$bump" -m "v%s" >/dev/null; pre=1 ;;
  *) npm version "$bump" -m "v%s" >/dev/null ;;
esac
ver=$(node -p "require('./package.json').version")
git push --follow-tags
if [ -n "$pre" ]; then
  npm publish --access public --tag next
  gh release create "v$ver" --title "v$ver" --generate-notes --prerelease
else
  npm publish --access public
  gh release create "v$ver" --title "v$ver" --generate-notes
fi

echo "released v$ver"
echo "verify: npm view @uehaj/sys1grep version  /  npx @uehaj/sys1grep@$ver --help"

#!/bin/sh
# Record that a PR was reviewed: post the review as a PR comment, then set the status "review" on the PR's head
# commit, linked to that comment. The main branch ruleset requires that status, so a push after the review
# needs a new review before the merge.
# Usage: scripts/reviewed.sh PR codex|code-review FILE [SUMMARY]
#   FILE     the review and what was done about it, posted as it is
#   SUMMARY  the status line on the PR, cut to the 140 characters GitHub allows (default: "<by> review addressed")
set -eu
[ $# -ge 3 ] || { echo "usage: scripts/reviewed.sh PR codex|code-review FILE [SUMMARY]" >&2; exit 2; }
pr=$1 by=$2 file=$3 summary=${4:-"$2 review addressed"}
case $by in codex|code-review) ;; *) echo "reviewed: by is codex or code-review, not '$by'" >&2; exit 2 ;; esac
[ -s "$file" ] || { echo "reviewed: $file is empty or missing" >&2; exit 2; }
sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
# What was reviewed is the local tree; it must be what the PR holds.
[ "$(git rev-parse HEAD)" = "$sha" ] || { echo "reviewed: HEAD is not PR #$pr's head $sha (push, or check out the PR)" >&2; exit 1; }
url=$({ printf 'Review (%s) of %s\n\n' "$by" "$sha"; cat "$file"; } | gh pr comment "$pr" --body-file -)
gh api "repos/{owner}/{repo}/statuses/$sha" -f state=success -f context=review \
  -f description="$(node -p "process.argv[1].match(/^.{0,140}/su)[0]" "$by: $summary")" -f target_url="$url" >/dev/null
echo "PR #$pr $sha: review recorded, $url"

#!/bin/bash
# Does a sys1grep skill fire when it should, and what does a run cost? Runs `claude -p` (Sonnet) on four questions about
# a generated 6,000-line log, once per skill variant, and leaves the JSON results for score.mjs.
#
#   CLAUDE_CONFIG_DIR=~/.claude-skill-eval tests/skill-eval/run.sh OUT cur=path/to/SKILL.md new=path/to/SKILL.md
#
# CLAUDE_CONFIG_DIR is a config folder kept for this, logged in once (`CLAUDE_CONFIG_DIR=... claude`, then /login) and
# marked with an empty `.skill-eval` file: each variant is installed there as skills/sys1grep, and removed at the end.
# The skill's sys1grep commands (npx -y @uehaj/sys1grep@..., node sys1grep.mjs, bare sys1grep) are rewritten to this
# checkout's sys1grep.mjs, so the variants differ only in their wording.
#
# REPS=2 by default. PREFLIGHT=1 runs one question once per variant and prints what Claude called, including denied
# calls: run it first, since a denied or misrouted call wastes a full run. About $0.06 a run.
set -u
[ $# -ge 2 ] || { sed -n '5p' "$0" >&2; exit 2; }
CFG=${CLAUDE_CONFIG_DIR:?set CLAUDE_CONFIG_DIR to a config folder kept for this}
[ -e "$CFG/.skill-eval" ] || { echo "run.sh: $CFG has no .skill-eval marker; refusing to replace its skills/sys1grep" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd); shift
REPS=${REPS:-2}; QS="h1 q1 c5 c2"; [ "${PREFLIGHT:-}" = 1 ] && { REPS=1; QS=h1; }
mkdir -p "$OUT/results" "$OUT/runs"
node "$HERE/gen-inbox.mjs" "$OUT" > /dev/null

L='最後に「行: 番号, 番号, ...」の 1 行で答えてください。'
question() {
  case $1 in
    h1) echo 'inbox.log の WARN の行から、どんなことが言えますか。' ;;
    q1) echo "inbox.log から、ネットワークや外部サービスへの接続の障害を示している行をすべて、行番号付きで挙げてください。$L" ;;
    c5) echo "inbox.log で、顧客が返金を求めている行の行番号を挙げてください。$L" ;;
    c2) echo 'inbox.log の ERROR の行は全部で何行ありますか。' ;;  # shell pipes answer it: the skill should not fire
  esac
}
use_skill() { # SKILL.md
  /bin/rm -rf "$CFG/skills/sys1grep"; mkdir -p "$CFG/skills/sys1grep"
  sed -E -e 's#git sys1grep#GIT_SYS1GREP#g' \
    -e "s#npx -y @uehaj/sys1grep@[^ \`]*#node $REPO/sys1grep.mjs#g" -e "s#node sys1grep\\.mjs#node $REPO/sys1grep.mjs#g" \
    -e "s#(^|[[:space:]\`(|])sys1grep ([-a-z])#\\1node $REPO/sys1grep.mjs \\2#g" -e 's#GIT_SYS1GREP#git sys1grep#g' \
    "$1" > "$CFG/skills/sys1grep/SKILL.md"
}
one() { # arm q rep
  local d=$OUT/runs/$1-$2-$3
  /bin/rm -rf "$d"; mkdir -p "$d"; /bin/cp "$OUT/inbox.log" "$d/"
  (cd "$d" && question $2 | claude -p --model sonnet --output-format json --setting-sources user --strict-mcp-config \
    --allowedTools 'Read,Grep,Glob,Skill,Bash(node:*),Bash(grep:*),Bash(sort:*),Bash(uniq:*),Bash(wc:*),Bash(head:*),Bash(tail:*),Bash(awk:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(echo:*)' \
    > "$OUT/results/$1-$2-$3.json" 2> "$OUT/results/$1-$2-$3.err")
}
for arg; do
  arm=${arg%%=*}; use_skill "${arg#*=}"; echo "== $arm: $(sed -n 3p "$CFG/skills/sys1grep/SKILL.md" | cut -c1-60)"
  for q in $QS; do for r in $(seq "$REPS"); do one "$arm" "$q" "$r" & done; done; wait
done
/bin/rm -rf "$CFG/skills/sys1grep"
[ "${PREFLIGHT:-}" = 1 ] && SHOW=1 node "$HERE/score.mjs" "$OUT"
true

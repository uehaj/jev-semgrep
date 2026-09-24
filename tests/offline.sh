#!/bin/sh
# Offline self-check against tests/fake-jev.mjs: no API key, no network, the same answer every run.
# The fake scores a line 0.9 when it contains the meaning verbatim ("@N" in the line sets N instead), else 0.05,
# so these checks are about semgrep itself: the expression, output shapes, options, requests and exit codes.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
node fake-jev.mjs >"$tmp/port" &
fake=$!
trap 'kill $fake 2>/dev/null; wait $fake 2>/dev/null || true; rm -rf "$tmp"' EXIT
while [ ! -s "$tmp/port" ]; do sleep 0.05; done
base="http://127.0.0.1:$(cat "$tmp/port")"
# No key from the environment, and a HOME and cwd without .env, so nothing real is read or sent
E="env -u SEMGREP_API_KEY -u TYPESAFE_API_KEY -u SEMGREP_MODEL -u NO_COLOR -u LC_ALL -u LC_MESSAGES HOME=$tmp SEMGREP_OPTS="
J="$E SEMGREP_URL=$base/v1 node ../semgrep.mjs"
stat() { curl -s "$base" | node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
reset() { curl -s "$base/reset" >/dev/null; }
nums() { cut -d: -f1 | tr '\n' ' '; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# eq ACTUAL EXPECTED DESCRIPTION
eq() { [ "$1" = "$2" ] || fail "$3: got '$1', want '$2'"; }
# code EXPECTED DESCRIPTION -- COMMAND...: the exit status of COMMAND
code() { want=$1 what=$2; shift 3; set +e; "$@" >/dev/null 2>&1; got=$?; set -e; eq "$got" "$want" "$what (exit)"; }

F="$tmp/a.txt"
printf '%s\n' 'cat' 'dog' '' 'cat dog' 'bird @0.4' 'fish @0.6' 'the line answers: owl' 'owl' >"$F"
# 1 cat / 2 dog / 3 (blank, never sent) / 4 cat dog / 5 bird @0.4 / 6 fish @0.6 / 7 the line answers: owl / 8 owl

# expression
eq "$($J -n -e cat "$F" | nums)" "1 4 " "-e"
eq "$($J -n -e cat -e dog "$F" | nums)" "1 2 4 " "-e -e is OR"
eq "$($J -n -e cat -a dog "$F" | nums)" "4 " "-a is AND"
eq "$($J -n -e cat -v dog "$F" | nums)" "1 " "-v is AND NOT"
eq "$($J -n -v cat "$F" | nums)" "2 3 5 6 7 8 " "a bare -v, blank line included"
eq "$($J -n -e cat -e '!dog' "$F" | nums)" "1 3 4 5 6 7 8 " "! negates one meaning"
eq "$($J -n -e cat -a '!dog' "$F" | nums)" "1 " "-a '!X' is -v X"
code 2 "-a first" -- $J -a cat "$F"
code 2 "empty meaning" -- $J -e '' "$F"
code 2 "no meaning" -- $J -n "$F"

# -Q X is -e "the line answers: X", sent once when both are given
eq "$($J -n -Q owl "$F" | nums)" "7 " "-Q"
eq "$($J -n --question owl "$F" | nums)" "7 " "--question"
eq "$($J -p --color=never -Q owl -e 'the line answers: owl' "$F")" "$(printf 'the line answers: owl\t[0.90]')" "-Q and its -e are one meaning"
eq "$($J -n -Q owl -e cat "$F" | nums)" "1 4 7 " "-Q OR -e"
eq "$($J -n -e owl -v 'the line answers: owl' "$F" | nums)" "8 " "-e owl without the -Q line"

# exit status and output shapes
code 0 "a match" -- $J -e cat "$F"
code 1 "no match" -- $J -e zebra "$F"
code 2 "unreadable file" -- $J -e zebra "$F" "$tmp/none"
eq "$($J -c -e cat "$F")" "2" "-c"
eq "$($J -c -e zebra "$F")" "0" "-c without a match"
eq "$($J -l -e cat "$F" "$F")" "$(printf '%s\n' "$F" "$F")" "-l, one name per file"
eq "$($J -n -e cat "$F" "$F" | head -1)" "$F:1:cat" "file prefix with two files"

# context: -A and -B alone, groups apart are split by --, blank lines count as context
eq "$($J -n -A 1 -e fish "$F" | tr '\n' '|')" "6:fish @0.6|7-the line answers: owl|" "-A"
eq "$($J -n -B 1 -e fish "$F" | tr '\n' '|')" "5-bird @0.4|6:fish @0.6|" "-B"
eq "$($J -n -A 1 -e cat "$F" | tr '\n' '|')" "1:cat|2-dog|--|4:cat dog|5-bird @0.4|" "-A groups"
eq "$($J -n -B 1 -e cat "$F" | tr '\n' '|')" "1:cat|--|3-|4:cat dog|" "-B groups, blank context"
eq "$($J -n -C 1 -e fish "$F" | tr '\n' '|')" "5-bird @0.4|6:fish @0.6|7-the line answers: owl|" "-C"

# --level and -t / -T: bird is 0.4, fish is 0.6
eq "$($J -n -e bird "$F" | nums)" "" "normal: 0.4 is below 0.5"
eq "$($J -n --level loose -e bird "$F" | nums)" "5 " "loose: 0.4 is above 0.3"
eq "$($J -n -e fish "$F" | nums)" "6 " "normal: 0.6 is above 0.5"
eq "$($J -n --level strict -e fish "$F" | nums)" "" "strict: 0.6 is below 0.7"
eq "$($J -n -v fish "$F" | cut -d: -f1 | grep -cx 6 || true)" "0" "normal: not fish needs below 0.5"
eq "$($J -n --level loose -v fish "$F" | cut -d: -f1 | grep -cx 6 || true)" "1" "loose: not fish needs below 0.7"
eq "$($J -n --level strict -v bird "$F" | cut -d: -f1 | grep -cx 5 || true)" "0" "strict: not bird needs below 0.3"
eq "$($J -n --level strict -t 0.5 -e fish "$F" | nums)" "6 " "-t overrides --level"
eq "$($J -n -T 0.7 -v fish "$F" | cut -d: -f1 | grep -cx 6 || true)" "1" "-T overrides --level"
eq "$($J -n -t 0.7 -T 0.3 -e bird -e '!bird' "$F" | cut -d: -f1 | grep -cx 5 || true)" "0" "0.4 is neither bird nor not bird"
code 2 "--level bogus" -- $J --level bogus -e cat "$F"
code 2 "-t above 1" -- $J -t 1.5 -e cat "$F"

# -p prints each meaning's probability, in meaning order
eq "$($J -n -p --color=never -e cat -e dog "$F" | tr '\n' '|')" "$(printf '1:cat\t[0.90 0.05]|2:dog\t[0.05 0.90]|4:cat dog\t[0.90 0.90]|')" "-p"

# --color: grep's colors; -p green at or above -t, red below -T, yellow between
esc=$(printf '\033')
eq "$($J -n --color=always -e cat "$F" | head -1)" "${esc}[32m1${esc}[0m${esc}[36m:${esc}[0mcat" "--color=always line number"
eq "$($J -n --color=always -e cat "$F" "$F" | head -1)" "${esc}[35m$F${esc}[0m${esc}[36m:${esc}[0m${esc}[32m1${esc}[0m${esc}[36m:${esc}[0mcat" "--color=always file name"
line5=$($J -p --color=always --level strict -e '!cat' -e bird "$F" | grep bird)
case $line5 in *"${esc}[31m0.05${esc}[0m ${esc}[33m0.40${esc}[0m"*) ;; *) fail "-p colors: $line5" ;; esac
case $($J -p --color=always -e cat "$F" | head -1) in *"${esc}[32m0.90"*) ;; *) fail "-p green" ;; esac
case $($J -n --color -e cat "$F") in *"$esc"*) fail "--color (auto) colors a pipe" ;; esac
case $($J -n -e cat "$F") in *"$esc"*) fail "default colors a pipe" ;; esac
code 2 "--color=bogus" -- $J --color=bogus -e cat "$F"

# --chunk: lines per request (7 lines are sent; the blank one is not)
reset; $J -e cat "$F" >/dev/null; eq "$(stat count)" "1" "default chunk: one request"
reset; $J --chunk 2 -e cat "$F" >/dev/null; eq "$(stat count)" "4" "--chunk 2: 4 requests"
reset; $J --chunk 1 -e cat "$F" >/dev/null; eq "$(stat count)" "7" "--chunk 1: 7 requests"
reset; $J --chunk 1 -e cat -e dog -Q owl "$F" >/dev/null; eq "$(stat count)" "7" "meanings share a request"
code 2 "--chunk 0" -- $J --chunk 0 -e cat "$F"

# -j: requests in flight at once (each takes 30ms at the fake)
reset; $J --chunk 1 -j 1 -e cat "$F" >/dev/null; eq "$(stat max)" "1" "-j 1"
reset; $J --chunk 1 -j 3 -e cat "$F" >/dev/null; eq "$(stat max)" "3" "-j 3"
reset; $J --chunk 1 -e cat "$F" >/dev/null; eq "$(stat max)" "7" "default -j 8, 7 requests"
code 2 "-j 0" -- $J -j 0 -e cat "$F"

# -q / --quiet: prints nothing, stops at the first match, a match wins over an error
eq "$($J -q -e cat "$F" 2>&1)" "" "-q prints nothing"
code 0 "-q match" -- $J -q -e cat "$F"
code 1 "-q no match" -- $J --quiet -e zebra "$F"
code 0 "-q match and an unreadable file" -- $J -q -e cat "$F" "$tmp/none"
code 2 "-q no match and an unreadable file" -- $J -q -e zebra "$F" "$tmp/none"
reset; $J -q --chunk 1 -j 1 -e cat "$F"; eq "$(stat count)" "1" "-q stops after the first match"
reset; $J -q --chunk 1 -j 1 -e zebra "$F" || true; eq "$(stat count)" "7" "-q without a match sends every line"
reset; $J -q -v cat "$F"; eq "$(stat count)" "0" "-q, a bare -v matches the blank line before any request"

# SEMGREP_URL: a compatible endpoint; the key goes there as a bearer token, no key means no header
reset; $J -e cat "$F" >/dev/null; eq "$(stat auth)" "null" "no key, no authorization header"
reset; $E SEMGREP_URL=$base/v1 SEMGREP_API_KEY=k1 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat auth)" "Bearer k1" "SEMGREP_API_KEY"
reset; $E SEMGREP_URL=$base/v1 TYPESAFE_API_KEY=k2 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat auth)" "Bearer k2" "TYPESAFE_API_KEY fallback"
code 2 "SEMGREP_URL not a URL" -- $E SEMGREP_URL=nope node ../semgrep.mjs -e cat "$F"
code 2 "the TypeSafe default needs a key" -- $E node ../semgrep.mjs -e cat "$F"

# git semgrep: tracked files only, pathspecs relative to the current directory, never stdin
R="$tmp/repo" GS="$E SEMGREP_URL=$base/v1 node $PWD/../git-semgrep.mjs" SG="$PWD/../semgrep.mjs"
mkdir -p "$R/sub" "$tmp/plain"
printf 'cat\n' >"$R/a.txt"; printf 'cat\n' >"$R/sub/b.txt"; printf 'cat\n' >"$R/ignored.txt"; printf 'cat\n' >"$R/.env.sample"
echo ignored.txt >"$R/.gitignore"
(cd "$R" && git init -q && git add a.txt sub/b.txt .gitignore .env.sample)
eq "$(cd "$R" && $GS -l -e cat | tr '\n' ' ')" "a.txt sub/b.txt " "git semgrep: tracked files, not ignored ones or the skip list"
eq "$(cd "$R/sub" && $GS -l -e cat)" "b.txt" "git semgrep: under the current directory"
eq "$(cd "$R" && $GS -n -e cat a.txt)" "a.txt:1:cat" "git semgrep: pathspec, file name even for one file"
code 1 "git semgrep: never stdin" -- sh -c "cd '$R' && echo cat | $GS -e cat -- nothing"
printf 'cat\n' >"$R/-"; (cd "$R" && git add -- -)
eq "$(cd "$R" && echo dog | $GS -l -e cat -- -)" "./-" "git semgrep: a tracked file named -, not stdin"
blob=$(cd "$R" && echo cat | git hash-object -w --stdin); printf 'cat\n' >"$R/c.txt"
(cd "$R" && printf '100644 %s %s\tc.txt\n' "$blob" 1 "$blob" 2 "$blob" 3 | git update-index --index-info)
eq "$(cd "$R" && $GS -c -e cat -- c.txt)" "c.txt:1" "git semgrep: a conflicted file once, not once per stage"
code 2 "git semgrep: outside a repository" -- sh -c "cd '$tmp/plain' && $GS -e cat"
# more than execFileSync's default 1 MiB of paths; empty files send nothing
mkdir "$R/many"
(cd "$R" && node -e 'for (let i = 0; i < 20000; i++) require("fs").writeFileSync(`many/${"x".repeat(60)}${i}`, "")' && git add many)
code 1 "git semgrep: over 1 MiB of paths" -- sh -c "cd '$R' && $GS -e cat -- many"
# SEMGREP_GIT in ./.env does not turn plain semgrep into git semgrep
printf 'SEMGREP_GIT=1\n' >"$tmp/plain/.env"
eq "$(cd "$tmp/plain" && echo cat | $E SEMGREP_URL=$base/v1 node "$SG" -e cat)" "cat" "SEMGREP_GIT in .env"

# --help: exit 0, Japanese by locale, lists the options
code 0 "--help" -- $E LANG=C node ../semgrep.mjs --help
eq "$($E LANG=C node ../semgrep.mjs -h | head -1 | cut -c1-14)" "usage: semgrep" "-h"
for o in '-Q, --question' '-q, --quiet' '--level=LEVEL' '--chunk=LINES' '-j N' '--color'; do
  $E LANG=C node ../semgrep.mjs --help | grep -q -- "$o" || fail "--help lacks $o"
done
$E LANG=C node ../semgrep.mjs --help | grep -q 'grep by meaning' || fail "--help in English"
$E LANG=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "--help in Japanese"
$E LANG=C LC_MESSAGES=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "LC_MESSAGES"
echo OK

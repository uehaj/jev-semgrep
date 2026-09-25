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
i=0; while [ ! -s "$tmp/port" ]; do i=$((i + 1)); [ $i -lt 200 ] || { echo "FAIL: fake-jev did not start" >&2; exit 1; }; sleep 0.05; done
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
reset
eq "$($J -p --color=never -Q owl -e 'the line answers: owl' "$F")" "$(printf 'the line answers: owl\t[0.90 0.90]')" "-p: a column per term"
eq "$(stat asked)" "7" "-Q and its -e are one question per line"
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

# --dry-run: the files and requests on stdout, nothing sent, exit 0 even with no match; --verbose: the same on stderr
reset; out=$($J --dry-run --chunk 4 -e cat -v '!dog' "$F"); eq "$(stat count)" "0" "--dry-run sends nothing"
eq "$(echo "$out" | grep -c '^semgrep: request .* \[judge\]')" "2" "--dry-run lists each request"
echo "$out" | grep -q "^semgrep: file $F: 8 lines, 7 to send" || fail "--dry-run lists the file"
echo "$out" | grep -q '4× Does line Lnnn match the meaning: "cat"?' || fail "--dry-run groups questions"
code 0 "--dry-run, no match" -- $J --dry-run -e nothing "$F"
reset; eq "$($J --dry-run -q -v cat "$F" | tail -1 | cut -d, -f1)" "semgrep: dry run: 1 request" "--dry-run ignores -q"
reset; eq "$($J --verbose -n -e cat "$F" 2>/dev/null | nums)" "1 4 " "--verbose keeps stdout"
eq "$(stat count)" "1" "--verbose sends"
eq "$($J --verbose -e cat "$F" 2>&1 >/dev/null | grep -c '^semgrep: request 1 \[judge\]')" "1" "--verbose on stderr"

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
reset; $J -q -e '/dog/' -e zebra "$F"; eq "$(stat count)" "0" "-q, a regex term matches before any request"
reset; $J -q --chunk 1 -j 1 -e '/cat/' -a cat "$F"; eq "$(stat count)" "1" "-q stops at the first regex-guarded match"
code 1 "-Q is never a regex" -- $J -q -Q '/cat/' "$F"

# --dedup with regex terms (#25). The fake scores the pre-question 0.05, so every kind folds; each meaning costs 5 questions.
printf '%s\n' 'cat 03:12 at 03:12' 'cat 03:12 at 14:40' >"$tmp/cap"
reset; eq "$($J -n --dedup -e '/ at (?<t>\d\d:\d\d)/' -a 'cat $<t>' "$tmp/cap" | nums)" "1 " "--dedup: a referenced capture splits a template"
eq "$(stat asked)" "7" "--dedup: one pre-question for the unexpanded meaning, one question per capture value"
printf '%s\n' 'usage 95% cat' 'usage 10% cat' >"$tmp/use"
reset; eq "$($J -n --dedup -e '/usage 9\d%/' -e dog "$tmp/use" | nums)" "1 " "--dedup: a regex term is matched per line, not per template"
eq "$(stat asked)" "6" "--dedup: those two lines are still one group for the meaning"
reset; eq "$($J -c --dedup -e '/cat/' "$F")" "2" "--dedup, regex terms only"
eq "$(stat count)" "0" "--dedup, regex terms only: no requests, no pre-question"

# SEMGREP_URL: a compatible endpoint; the key goes there as a bearer token, no key means no header
reset; $J -e cat "$F" >/dev/null; eq "$(stat auth)" "null" "no key, no authorization header"
reset; $E SEMGREP_URL=$base/v1 SEMGREP_API_KEY=k1 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat auth)" "Bearer k1" "SEMGREP_API_KEY"
reset; $E SEMGREP_URL=$base/v1 TYPESAFE_API_KEY=k2 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat auth)" "Bearer k2" "TYPESAFE_API_KEY fallback"
code 2 "SEMGREP_URL not a URL" -- $E SEMGREP_URL=nope node ../semgrep.mjs -e cat "$F"
code 2 "the TypeSafe default needs a key" -- $E node ../semgrep.mjs -e cat "$F"
# --sys1-*: each overrides its environment variable
reset; $E SEMGREP_URL=nope node ../semgrep.mjs --sys1-url=$base/v1 -e cat "$F" >/dev/null; eq "$(stat count)" "1" "--sys1-url over SEMGREP_URL"
code 2 "--sys1-url not a URL" -- $J --sys1-url=nope -e cat "$F"
reset; $E SEMGREP_URL=$base/v1 SEMGREP_API_KEY=k1 node ../semgrep.mjs --sys1-api-key=k3 -e cat "$F" >/dev/null; eq "$(stat auth)" "Bearer k3" "--sys1-api-key over SEMGREP_API_KEY"
code 1 "--sys1-api-key satisfies the TypeSafe default" -- $E node ../semgrep.mjs --sys1-api-key=k3 -e cat </dev/null
reset; $E SEMGREP_URL=$base/v1 SEMGREP_MODEL=m1 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat model)" "m1" "SEMGREP_MODEL"
reset; $E SEMGREP_URL=$base/v1 SEMGREP_MODEL=m1 node ../semgrep.mjs --sys1-model=m2 -e cat "$F" >/dev/null; eq "$(stat model)" "m2" "--sys1-model over SEMGREP_MODEL"
reset; $E SEMGREP_URL=$base/v1 SEMGREP_OPTS=--sys1-model=m3 node ../semgrep.mjs -e cat "$F" >/dev/null; eq "$(stat model)" "m3" "--sys1-model in SEMGREP_OPTS"
# ./.env is never read (an untrusted checkout could redirect the key); ~/.config/semgrep/.env is
mkdir -p "$tmp/checkout" "$tmp/.config/semgrep"
printf 'SEMGREP_URL=%s/v1\nSEMGREP_OPTS=-c\n' "$base" >"$tmp/checkout/.env"
reset; code 2 "./.env is not read" -- sh -c "cd '$tmp/checkout' && $E node '$PWD/../semgrep.mjs' -e cat '$F'"
eq "$(stat count)" "0" "./.env sends nothing"
printf 'SEMGREP_URL=%s/v1\n' "$base" >"$tmp/.config/semgrep/.env"
reset; eq "$(cd "$tmp/checkout" && $E node "$OLDPWD/../semgrep.mjs" -n -e cat "$F" | nums)" "1 4 " "~/.config/semgrep/.env is read"
rm "$tmp/.config/semgrep/.env"
# -r and git semgrep skip files that usually hold secrets, whatever their case
mkdir -p "$tmp/sec/.kube" "$tmp/sec/.docker"
for f in .envrc .env-local .env_prod .ENV .netrc .npmrc .pypirc .pgpass .git-credentials id_rsa_work x.JKS .kube/config .docker/config.json ok.txt; do printf 'cat\n' >"$tmp/sec/$f"; done
eq "$($J -r -l -e cat "$tmp/sec")" "$tmp/sec/ok.txt" "-r skips credential files"

# the response and the error body come from whatever server SEMGREP_URL names
printf 'cat @drop\n' >"$tmp/drop"
code 2 "a missing answer is an error, not 0 (which would make -v match)" -- $J -v cat "$tmp/drop"
printf 'cat @err\n' >"$tmp/err"
err=$($J -e cat "$tmp/err" 2>&1 >/dev/null || true)
eq "$(printf '%s' "$err" | grep -c "$(printf '\033')")" "0" "an error body loses its escape sequences"
[ ${#err} -lt 500 ] || fail "an error body is cut short (got ${#err} chars)"
printf 'x @err\ncat\n' >"$tmp/errthen"
code 0 "-q: a later match wins over a failed request" -- $J -q --chunk 1 -j 1 -e cat "$tmp/errthen"
code 2 "without -q a failed request is still an error" -- $J --chunk 1 -j 1 -e cat "$tmp/errthen"
reset; $J -q --dedup -e '/cat/' -e zebra "$F"; eq "$(stat count)" "0" "-q decides a regex match before --dedup's pre-question"
# a directory without -r, or one that can't be read, is reported and the rest is still searched (grep)
mkdir -p "$tmp/d" "$tmp/r/sub"; printf 'cat\n' >"$tmp/r/a.txt"; chmod 000 "$tmp/r/sub"
code 2 "a directory without -r" -- $J -e cat "$tmp/d" "$F"
eq "$($J -e cat "$tmp/d" "$F" 2>/dev/null | wc -l | tr -d ' ')" "2" "a directory without -r skips only itself"
eq "$($J -r -c -e cat "$tmp/r" 2>/dev/null)" "$tmp/r/a.txt:1" "-r skips an unreadable directory"
code 2 "-r with an unreadable directory" -- $J -r -e cat "$tmp/r"
chmod 755 "$tmp/r/sub"
# option values: checked before anything is sent
code 0 "-o -n without --sentence" -- $J -o -n -e cat "$F"
code 2 "-A takes a whole number" -- $J -A 1.5 -e cat "$F"
reset; code 2 "--color=bogus" -- $J --color=bogus -e cat "$F"; eq "$(stat count)" "0" "--color is checked before any request"
# a key over plain http gets a warning, except to this machine
$E SEMGREP_URL=http://example.invalid/v1 SEMGREP_API_KEY=k node ../semgrep.mjs -e cat /dev/null 2>&1 | grep -q 'over plain http' || fail "plain http warning"
eq "$($E SEMGREP_URL=$base/v1 SEMGREP_API_KEY=k node ../semgrep.mjs -e cat "$F" 2>&1 >/dev/null)" "" "no warning for 127.0.0.1"
# -z: NUL ends a record, so a binary is told by its other control bytes; a named binary is reported
printf '\177ELF\001\002\003cat\000' >"$tmp/bin.dat"
reset; eq "$($J -z -e cat "$tmp/bin.dat" 2>&1)" "semgrep: $tmp/bin.dat: binary file skipped" "-z skips a binary"
eq "$(stat count)" "0" "-z sends nothing from a binary"
# --sentence=jev with regex terms only asks nothing: the rules join the lines
printf '猫がいる\n犬もいる\n' >"$tmp/ja"   # unpunctuated Japanese: the breaks --sentence=jev would ask about
reset; $J --sentence -c -e '/猫/' "$tmp/ja" >/dev/null; eq "$(stat count)" "0" "--sentence with regex terms only sends nothing"

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
for o in '-Q, --question' '-q, --quiet' '--level=LEVEL' '--chunk=LINES' '-j N' '--color' '--sys1-api-key' '--dry-run' '--verbose'; do
  $E LANG=C node ../semgrep.mjs --help | grep -q -- "$o" || fail "--help lacks $o"
done
$E LANG=C node ../semgrep.mjs --help | grep -q 'grep by meaning' || fail "--help in English"
$E LANG=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "--help in Japanese"
$E LANG=C LC_MESSAGES=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "LC_MESSAGES"
echo OK

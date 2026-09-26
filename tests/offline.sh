#!/bin/sh
# Offline self-check against tests/fake-jev.mjs: no API key, no network, the same answer every run.
# The fake scores a line 0.9 when it contains the meaning verbatim ("@N" in the line sets N instead), else 0.05,
# so these checks are about semgrep itself: the expression, output shapes, options, requests and exit codes.
set -e
unset FORCE_COLOR # node would color the numbers it prints (the fake's port, the counts read back)
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
# -H / --no-filename: file names on one file, none on several; the later one wins; -c follows
eq "$($J -H -n -e cat "$F" | head -1)" "$F:1:cat" "-H on one file"
eq "$($J --with-filename -c -e cat "$F")" "$F:2" "--with-filename with -c"
eq "$($J --no-filename -n -e cat "$F" "$F" | head -1)" "1:cat" "--no-filename on two files"
eq "$($J --no-filename -c -e cat "$F" "$F" | tr '\n' ' ')" "2 2 " "--no-filename with -c"
eq "$($J -H --no-filename -e cat "$F" | head -1)" "cat" "--no-filename after -H wins"
eq "$($J --no-filename -H -e cat "$F" | head -1)" "$F:cat" "-H after --no-filename wins"
eq "$($E SEMGREP_URL=$base/v1 SEMGREP_OPTS=-H node ../semgrep.mjs -e cat "$F" | head -1)" "$F:cat" "-H in SEMGREP_OPTS"
eq "$($E SEMGREP_URL=$base/v1 SEMGREP_OPTS=-H node ../semgrep.mjs --no-filename -e cat "$F" | head -1)" "cat" "--no-filename overrides SEMGREP_OPTS"
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
$J --dry-run -e cat "$F" | tail -1 | grep -Eq ' chars, ~[0-9]+ input tokens; nothing sent$' || fail "--dry-run estimates tokens, no price for SEMGREP_URL"
$E SEMGREP_API_KEY=unused node ../semgrep.mjs --dry-run -e cat "$F" | tail -1 | grep -Eq ' chars, ~[0-9]+ input tokens, ~\$0\.[0-9]{6}; nothing sent$' || fail "--dry-run estimates the price for TypeSafe"
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
# a PDF is binary even when its first NUL is past 8 KB; UTF-16 with a BOM is text, though it is full of NULs
printf '%%PDF-1.5\ncat\n' >"$tmp/doc.pdf"
reset; eq "$($J -e cat "$tmp/doc.pdf" 2>&1)" "semgrep: $tmp/doc.pdf: binary file skipped" "a PDF is skipped"
eq "$(stat count)" "0" "nothing is sent from a PDF"
node -e 'const le = Buffer.from("﻿cat\ndog\n", "utf16le"); require("fs").writeFileSync(process.argv[1], le); require("fs").writeFileSync(process.argv[2], Buffer.from(le).swap16())' "$tmp/le.txt" "$tmp/be.txt"
eq "$($J -n -e cat "$tmp/le.txt")" "1:cat" "UTF-16LE is read"
eq "$($J -n -e dog "$tmp/be.txt")" "2:dog" "UTF-16BE is read"
eq "$($J -z -c -e cat "$tmp/le.txt")" "1" "-z with UTF-16: no NUL character, so the file is one record, as in UTF-8"
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

# -r leaves out what git ignores; a file or directory named on the command line is searched even so
I="$tmp/ign" JI="$E SEMGREP_URL=$base/v1 node $SG"
mkdir -p "$I/dist/sub" "$I/src/build"
for f in a.txt x.log dist/d.txt dist/sub/e.txt src/s.txt src/t.log src/build/b.txt; do printf 'cat\n' >"$I/$f"; done
printf 'dist/\n*.log\nbuild/\n' >"$I/.gitignore"
(cd "$I" && git init -q && git add .gitignore a.txt)
eq "$(cd "$I" && $JI -r -l -e cat | tr '\n' ' ')" "./a.txt ./src/s.txt " "-r skips ignored files and directories"
eq "$(cd "$I" && $JI -r -l -e cat src)" "src/s.txt" "-r on a subdirectory, the root's .gitignore applies"
eq "$(cd "$I/src" && $JI -r -l -e cat)" "./s.txt" "-r from a subdirectory"
eq "$(cd "$I" && $JI -r -l -e cat dist | tr '\n' ' ')" "dist/d.txt dist/sub/e.txt " "-r on an ignored directory, named: searched"
eq "$(cd "$I" && $JI -l -e cat x.log src/t.log | tr '\n' ' ')" "x.log src/t.log " "ignored files, named: searched"
(cd "$I" && git add -f src/t.log)
eq "$(cd "$I" && $JI -r -l -e cat src | tr '\n' ' ')" "src/s.txt src/t.log " "-r searches a tracked file that matches .gitignore"
mkdir "$tmp/norepo"; printf "cat\n" >"$tmp/norepo/x.log"; printf "*.log\n" >"$tmp/norepo/.gitignore"
eq "$($JI -r -l -e cat "$tmp/norepo")" "$tmp/norepo/x.log" "-r outside a repository: .gitignore has no effect"

# --include / --exclude / --changed-within pick what -r finds and git semgrep lists; a named file is always searched
P="$tmp/pick"
mkdir -p "$P/sub"
for f in a.md b.txt c.min.js d.js sub/e.md old.md; do printf 'cat\n' >"$P/$f"; done
touch -t 202001010000 "$P/old.md"
eq "$($JI -r -l --include='*.md' -e cat "$P" | tr '\n' ' ')" "$P/a.md $P/old.md $P/sub/e.md " "--include"
eq "$($JI -r -l --include='*.md' --include='*.txt' -e cat "$P" | tr '\n' ' ')" "$P/a.md $P/b.txt $P/old.md $P/sub/e.md " "--include twice"
eq "$($JI -r -l --include='*.js' --exclude='*.min.js' -e cat "$P" | tr '\n' ' ')" "$P/d.js " "--exclude"
eq "$($JI -r -l --include='*.md' --changed-within=7d -e cat "$P" | tr '\n' ' ')" "$P/a.md $P/sub/e.md " "--changed-within a duration"
eq "$($JI -r -l --include='*.md' --changed-within=2019-12-31 -e cat "$P" | grep -c .)" "3" "--changed-within a date"
eq "$($JI -l --include='*.txt' --changed-within=1d -e cat "$P/old.md")" "$P/old.md" "a named file is searched whatever the filters"
code 2 "--changed-within, not a duration or a date" -- $JI -r --changed-within=soon -e cat "$P"
code 2 "--changed-within, a day its month lacks (Date() would roll 02-30 over to 03-02)" -- $JI -r --changed-within=2026-02-30 -e cat "$P"
$JI -r -l --changed-within=2999-01-01 -e cat "$P" 2>&1 >/dev/null | grep -q "is in the future" || fail "--changed-within in the future warns"
$JI -r --include="[abc" -e cat "$P" 2>&1 | grep -q "^semgrep: --include: .\[abc. is not a valid glob" || fail "a malformed glob names the option"
code 2 "--changed-within, a bare number is not a year" -- $JI -r --changed-within=7 -e cat "$P"
eq "$($JI -r -l --include='*.md' --changed-within=today -e cat "$P" | tr '\n' ' ')" "$P/a.md $P/sub/e.md " "--changed-within=today"
eq "$($JI -r -l --include='*.md' --changed-within=this-week -e cat "$P" | grep -c .)" "2" "--changed-within=this-week"
# auto-scope: Jev is asked once per meaning which kinds of file it restricts its matches to (the fake says yes to
# "@s:KEY" in the meaning); the files -r finds are narrowed per term; named files never
S="$tmp/scope"; mkdir -p "$S/sub"; PY='Python で cat @s:l_python'; T='昨日変えた cat @s:t_yesterday @s:t_day30'; PT='cat @s:l_python @s:t_yesterday'
for f in a.py old.py sub/c.py; do printf '%s\n' "$PY" "$T" "$PT" >"$S/$f"; done
printf '%s\n' "$PY" dog "$T" "$PT" >"$S/b.js"; touch -t 202001010000 "$S/old.py"
eq "$($JI -r -l -e "$PY" "$S" 2>/dev/null | tr '\n' ' ')" "$S/a.py $S/old.py $S/sub/c.py " "scope: a language"
eq "$($JI -r -l -e "$PY" "$S" 2>&1 >/dev/null | tr '\n' '|')" 'semgrep: scope: *.py *.pyi *.pyw (from "Python files: 0.90")|semgrep: scope: 3 of 4 files|' "scope: reported on stderr"
eq "$($JI -r -l --no-auto-scope -e "$PY" "$S" 2>&1 | grep -c .)" "4" "--no-auto-scope"
eq "$($E SEMGREP_URL=$base/v1 SEMGREP_OPTS=--no-auto-scope node $SG -r -l --auto-scope -e "$PY" "$S" 2>/dev/null | grep -c .)" "3" "--auto-scope undoes SEMGREP_OPTS"
eq "$($JI -r -l -e 'Python で cat' "$S" 2>&1 | grep -c 'semgrep: scope:' || true)" "0" "no scope when Jev says no"
eq "$($JI -r -l -e "$T" "$S" 2>/dev/null | tr '\n' ' ')" "$S/a.py $S/b.js $S/sub/c.py " "scope: a time span, by mtime"
eq "$($JI -r -l -e "$T" "$S" 2>&1 >/dev/null | grep -c 'since .* (from "what was changed yesterday: 0.90")')" "1" "scope: the narrowest span"
eq "$($JI -r -l -e 'cat @s:l_javascript @s:l_typescript' "$S" 2>&1 >/dev/null | head -1)" 'semgrep: scope: *.js *.mjs *.cjs *.jsx | *.ts *.mts *.cts *.tsx (from "JavaScript files: 0.90", "TypeScript files: 0.90")' "scope: two languages are alternatives"
eq "$($JI -r -l -e "$PT" "$S" 2>/dev/null | tr '\n' ' ')" "$S/a.py $S/sub/c.py " "scope: categories intersect"
eq "$($JI -r --dry-run -e "$T" -e dog "$S" | grep -c '\[scope\]')" "2" "scope: one question request per meaning"
eq "$($JI --dry-run -e "$T" "$S/a.py" | grep -c '\[scope\]' || true)" "0" "scope: no question for named files only"
eq "$($JI -r --no-auto-scope --dry-run -e "$T" "$S" | grep -c '\[scope\]' || true)" "0" "scope: no question with --no-auto-scope"
# --verbose: each candidate answered 0.2 or more, ✓ applied with the files it alone keeps, · not applied and why
V=$($JI -r -l --verbose -e 'cat @s:l_python @s:r_test=0.4 @s:t_yesterday @s:t_day30' "$S" 2>&1 >/dev/null || true)
echo "$V" | grep -q '^semgrep: scope "cat @s:l_python' || fail "--verbose: a header per meaning: $V"
echo "$V" | grep -qE '^semgrep:   ✓ Python files \(\*\.py \*\.pyi \*\.pyw\) +0\.90  keeps 3 of 4 files$' || fail "--verbose: an applied candidate and its count: $V"
echo "$V" | grep -qE '^semgrep:   · test code \(.*\) +0\.40  \(below 0\.6, not applied\)$' || fail "--verbose: a candidate below 0.6: $V"
echo "$V" | grep -qE '^semgrep:   ✓ what was changed yesterday .*keeps [0-9]+ of 4 files$' || fail "--verbose: the narrowest span applied: $V"
echo "$V" | grep -qE '^semgrep:   · what was changed within the last 30 days .*\(a narrower span applied\)$' || fail "--verbose: a wider span not applied: $V"
eq "$($JI -r -l --dry-run --verbose -e 'cat @s:l_python' "$S" 2>&1 | grep -c '^semgrep:   [✓·]' || true)" "0" "--verbose: no candidate lines with --dry-run"
# git: time by commit (not the mtime a checkout sets), states and authors; not asked outside a repository
G="$tmp/gitscope"; mkdir -p "$G"
GM='cat @s:t_yesterday|cat @s:a_a_x|cat @s:g_mine|cat @s:g_mine @s:a_b_x|cat @s:g_uncommitted|cat @s:g_staged|cat @s:g_untracked|cat @s:g_branch|cat @s:g_unpushed'
for f in old new feat dirty staged untr; do printf '%s\n' "$GM" | tr '|' '\n' >"$G/$f.txt"; done
(cd "$G" && git init -q -b main && git config user.email b@x && git config user.name Bob && git config core.hooksPath /dev/null \
  && git add old.txt dirty.txt && GIT_AUTHOR_DATE=2020-01-01T00:00 GIT_COMMITTER_DATE=2020-01-01T00:00 git commit -q --author='Alice <a@x>' -m old \
  && git add new.txt && git commit -q -m new && git checkout -q -b feat && git add feat.txt && git commit -q -m feat \
  && echo more >>dirty.txt && git add staged.txt)
gs() { $JI -r -l -e "cat @s:$1" "$G" 2>/dev/null | sed "s|$G/||" | tr '\n' ' '; }
eq "$(gs t_yesterday)" "dirty.txt feat.txt new.txt staged.txt untr.txt " "git scope: time by commit, old.txt's fresh mtime aside"
eq "$(gs a_a_x)" "dirty.txt old.txt " "git scope: an author"
eq "$(gs g_mine)" "dirty.txt feat.txt new.txt staged.txt untr.txt " "git scope: mine, uncommitted files included"
eq "$(gs 'g_mine @s:a_b_x')" "dirty.txt feat.txt new.txt staged.txt untr.txt " "git scope: mine and my name as an author are alternatives"
eq "$(gs g_uncommitted)" "dirty.txt staged.txt untr.txt " "git scope: uncommitted"
eq "$(gs g_staged)" "staged.txt " "git scope: staged"
eq "$(gs g_untracked)" "untr.txt " "git scope: untracked"
eq "$(gs g_branch)" "dirty.txt feat.txt staged.txt untr.txt " "git scope: this branch"
eq "$(gs g_unpushed)" "dirty.txt feat.txt new.txt old.txt " "git scope: unpushed, no remote"
eq "$(cd "$G" && $GS -l -e 'cat @s:g_staged' 2>/dev/null | tr '\n' ' ')" "staged.txt " "git scope: git semgrep"
eq "$($JI -r -l -e 'cat @s:g_staged' "$S" 2>&1 | grep -c 'semgrep: scope:' || true)" "0" "git scope: not asked outside a repository"
# places: by path; several are alternatives
W="$tmp/roles"; mkdir -p "$W/tests" "$W/src" "$W/docs"; RT='cat @s:r_test'; RR='cat @s:r_readme @s:r_changelog'; RC='cat @s:r_code'
for f in tests/x.js src/y.js README.md docs/guide.txt app.log; do printf '%s\n' "$RT" "$RR" "$RC" >"$W/$f"; done
eq "$($JI -r -l -e "$RT" "$W" 2>/dev/null | tr '\n' ' ')" "$W/tests/x.js " "scope: test files"
eq "$($JI -r -l -e "$RR" "$W" 2>/dev/null | tr '\n' ' ')" "$W/README.md " "scope: README or CHANGELOG"
eq "$($JI -r -l -e "$RC" "$W" 2>/dev/null | tr '\n' ' ')" "$W/app.log $W/src/y.js $W/tests/x.js " "scope: code is what is not a document"
eq "$($JI -r -n -e "$PY" -e dog "$S" 2>/dev/null | grep -c "^$S/b.js:2:dog")" "1" "scope: another term still searches the file"
eq "$($JI -r -n -e "$PY" -e dog "$S" 2>/dev/null | grep -c "^$S/b.js:1:")" "0" "scope: the scoped term does not hold in it"
eq "$($JI -r -n -e "$PY" -a '!昨日変えた cat' "$S" 2>/dev/null | grep -c "^$S/b.js:1:")" "0" "scope: within an AND term"
eq "$($JI -l -e "$PY" "$S/b.js")" "$S/b.js" "scope: a named file is searched"
eq "$($JI -r -q -e "$PY" "$S" 2>&1)" "" "scope: -q prints nothing"
eq "$($JI -r -p --color=never -e "$PY" "$S" 2>/dev/null | head -1)" "$(printf '%s\t[0.90]' "$S/a.py:$PY")" "scope: no column in -p"
eq "$($JI -r -l --include='*.md' --changed-within=this-month -e cat "$P" | grep -c .)" "2" "--changed-within=this-month"
eq "$($JI -r -l --include='*.md' --changed-within=2019-12-31T12:00Z -e cat "$P" | grep -c .)" "3" "--changed-within an ISO date-time"
(cd "$P" && git init -q && git add .)
eq "$(cd "$P" && $GS -l --include='*.md' --changed-within=7d -e cat | tr '\n' ' ')" "a.md sub/e.md " "git semgrep with --include and --changed-within"
eq "$(cd "$P" && $GS -l --include='*.md' -e cat b.txt a.md | tr '\n' ' ')" "a.md " "git semgrep: pathspecs are filtered too"
$JI -r -l --include='sub/*.md' -e cat "$P" 2>&1 >/dev/null | grep -q "has a /, but globs match the file name only" || fail "--include with a / warns"

# -i without a terminal is an error; from SEMGREP_OPTS it says so. notty: a new session has no controlling terminal
notty() { perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$@"; }
code 2 "-i without a terminal" -- notty $JI -i -e cat "$P/a.md"
notty $E SEMGREP_OPTS=-i SEMGREP_URL=$base/v1 node ../semgrep.mjs -e cat "$P/a.md" 2>&1 | grep -q 'SEMGREP_OPTS= semgrep' || fail "-i from SEMGREP_OPTS names it"
# -i: shows the dry run on the terminal and sends nothing before the answer; y searches, anything else exits 1
if script --version >/dev/null 2>&1; then onpty() { script -qec "$1" /dev/null; }; else onpty() { script -q /dev/null sh -c "$1"; }; fi
# The answer is typed once the prompt is on the terminal (script(1) forwards input at once, then sends EOF, which
# would come first). asking CMD ANSWER: run CMD on a pty, answer when "[y/N]" shows (10 s at most), print what showed.
asking() {
  : >"$tmp/pty"
  { i=0; until grep -q 'y/N' "$tmp/pty" || [ $i -ge 100 ]; do sleep 0.1; i=$((i + 1)); done; printf '%s\n' "$2"; sleep 1; } \
    | onpty "$1; echo rc=\$?" >"$tmp/pty"
  cat "$tmp/pty"
}
reset; out=$(asking "$JI -i -l -e cat '$P/a.md'" n)
eq "$(stat count)" "0" "-i, n: nothing sent"
echo "$out" | grep -q "semgrep: file $P/a.md: 1 lines, 1 to send" || fail "-i shows the files: $out"
echo "$out" | grep -q 'rc=1' || fail "-i, n: exit 1: $out"
reset; out=$(asking "$JI -i -r -l -e '$PY' '$S'" n)
eq "$(stat count)" "0" "-i: the scope question waits for the answer too"
reset; out=$(asking "$JI -i -l -e cat '$P/a.md'" y)
eq "$(stat count)" "1" "-i, y: searched: $out"
echo "$out" | grep -q 'rc=0' || fail "-i, y: exit 0: $out"
reset; out=$(asking "printf 'cat\\\\n' | $JI -i -c -e cat" y)
echo "$out" | grep -q '^1' || fail "-i with stdin: the data still reaches the search: $out"
# a file name cannot redraw the question: control characters show as \xNN
X="$tmp/esc"; mkdir -p "$X"; printf 'cat\n' >"$X/$(printf 'evil\033[2Kx.txt')"
reset; out=$(asking "$JI -i -r -l -e cat '$X'" n)
case "$out" in *"$(printf '\033')"*) fail "-i shows an escape sequence from a file name";; esac
printf '%s\n' "$out" | grep -q 'evil\\x1b\[2Kx.txt' || fail "-i shows the file name with a backslash-x1b"
$JI --dry-run -r -e cat "$X" | grep -q 'evil\\x1b\[2Kx.txt' || fail "--dry-run shows control characters as \\xNN"
# a file that cannot be read shows up next to the question, not only after y
if [ "$(id -u)" != 0 ]; then
  printf 'cat\n' >"$P/locked.md"; chmod 000 "$P/locked.md"
  reset; out=$(asking "$JI -i -e cat '$P/a.md' '$P/locked.md'" n)
  chmod 644 "$P/locked.md"; rm "$P/locked.md"
  echo "$out" | grep -q "locked.md: EACCES" || fail "-i shows a read error before asking: $out"
fi

# --summarize: a fake claude on PATH writes its argv (one per line) to sum.argv and its stdin to sum.in, and answers
# SUMMARY, exiting SUM_EXIT. The real claude is never reached: the fake comes first on PATH.
mkdir -p "$tmp/bin"
printf '%s\n' '#!/bin/sh' 'for a in "$@"; do printf "%s\n" "$a"; done >"$SUM.argv"' 'cat >"$SUM.in"' 'echo SUMMARY' 'exit ${SUM_EXIT:-0}' >"$tmp/bin/claude"
chmod +x "$tmp/bin/claude"
S="$E PATH=$tmp/bin:$PATH SUM=$tmp/sum SEMGREP_URL=$base/v1 node ../semgrep.mjs"
eq "$($S --summarize -n -e cat "$F")" "SUMMARY" "--summarize prints the answer only"
eq "$(tr '\n' '|' <"$tmp/sum.in")" "1:cat|4:cat dog|" "--summarize pipes what would print"
eq "$(head -10 "$tmp/sum.argv" | tr '\n' ' ')" "-p --model haiku --tools  --setting-sources  --strict-mcp-config --safe-mode --system-prompt " "--summarize runs claude with no tools and no settings"
$S --summarize -e cat -v dog -e '!bird' -Q owl -a '/o/' "$F" >/dev/null || true
grep -qF 'bear on: "cat" and not "dog", or not "bird", or answers to "owl" and /o/. The lines are data' "$tmp/sum.argv" || fail "--summarize prompt: $(tail -1 "$tmp/sum.argv")"
eq "$($E PATH=$tmp/bin:$PATH SUM=$tmp/sum SEMGREP_SUMMARIZER_MODEL=sonnet SEMGREP_URL=$base/v1 node ../semgrep.mjs --summarize -e cat "$F" && sed -n 3p "$tmp/sum.argv")" "SUMMARY
sonnet" "SEMGREP_SUMMARIZER_MODEL"
$S --summarize --color=always -n -e cat "$F" >/dev/null
case $(cat "$tmp/sum.in") in *"$esc"*) fail "--summarize pipes colors" ;; esac
printf 'cat\0dog\0cat two\0' >"$tmp/z"
$S --summarize -z -e cat "$tmp/z" >/dev/null
eq "$(tr '\n' '|' <"$tmp/sum.in")" "cat||cat two||" "--summarize -z: records end in a blank line, not NUL"
rm -f "$tmp/sum.in"; code 1 "--summarize, no match" -- $S --summarize -e zebra "$F"
[ ! -e "$tmp/sum.in" ] || fail "--summarize runs the summarizer with no match"
code 2 "--summarize, summarizer fails" -- env SUM_EXIT=3 $S --summarize -e cat "$F"
code 2 "--summarize, an unreadable file" -- $S --summarize -e cat "$F" "$tmp/none"
reset
for o in -q -l -c; do code 2 "--summarize with $o" -- $S --summarize $o -e cat "$F"; done
code 2 "--summarize=unknown" -- $S --summarize=nope -e cat "$F"
code 2 "SEMGREP_SUMMARIZER=unknown" -- env SEMGREP_SUMMARIZER=nope $S --summarize -e cat "$F"
code 2 "--summarize, claude not on PATH" -- $E PATH=/usr/bin:/bin SEMGREP_URL=$base/v1 "$(command -v node)" ../semgrep.mjs --summarize -e cat "$F"
code 2 "--summarize in SEMGREP_OPTS" -- $E PATH=$tmp/bin:$PATH SEMGREP_OPTS=--summarize SEMGREP_URL=$base/v1 node ../semgrep.mjs -e cat "$F"
eq "$(stat count)" "0" "--summarize errors send nothing"
rm -f "$tmp/sum.in"; $S --summarize --dry-run -e cat "$F" | grep -q '^semgrep: summarize: claude -p --model haiku --tools "" .*--system-prompt "Summarize' || fail "--dry-run shows the summarizer"
[ ! -e "$tmp/sum.in" ] || fail "--dry-run runs the summarizer"
out=$(asking "$S -i --summarize -e cat '$F'" n)
echo "$out" | grep -q 'then the matching lines to claude? \[y/N\]' || fail "-i says the lines go to the summarizer: $out"

# the spinner (#89): on a terminal, one line on stderr while waiting, erased before the output; never when not a terminal
printf 'cat @slow\ndog\n' >"$tmp/slow.txt"
eq "$($J -e cat "$tmp/slow.txt" 2>&1 >/dev/null | od -c | grep -c '\\r' || true)" "0" "no spinner when stderr is not a terminal"
out=$(onpty "$J --chunk 1 -j 1 -e cat '$tmp/slow.txt'" </dev/null | od -An -c | tr -d ' \n')
case $out in *'semgrep:0of2requests'*) ;; *) fail "spinner: the count of requests: $out" ;; esac
case $out in *'033[Kcat@slow'*) ;; *) fail "spinner: erased before the first line: $out" ;; esac
out=$(onpty "$J -q -e cat '$tmp/slow.txt'" </dev/null | od -An -c | tr -d ' \n')
case $out in *requests*) fail "spinner with -q: $out" ;; esac
out=$(onpty "$J --verbose -e cat '$tmp/slow.txt'" </dev/null | od -An -c | tr -d ' \n')
case $out in *'of1requests'*) fail "spinner with --verbose: $out" ;; esac
out=$(onpty "TERM=dumb $J -e cat '$tmp/slow.txt'" </dev/null | od -An -c | tr -d ' \n')
case $out in *'of1requests'*) fail "spinner with TERM=dumb: $out" ;; esac
# --summarize: the spinner says so while the TOOL runs, and is erased before its first byte
printf '%s\n' '#!/bin/sh' 'cat >/dev/null' 'sleep 0.5' 'echo SUMMARY' >"$tmp/bin/claude"
out=$(onpty "PATH=$tmp/bin:\$PATH $J --summarize -e cat '$F'" </dev/null | od -An -c | tr -d ' \n')
case $out in *'summarizingwithclaude'*'033[KSUMMARY'*) ;; *) fail "spinner while summarizing: $out" ;; esac
# --help: exit 0, Japanese by locale, lists the options
code 0 "--help" -- $E LANG=C node ../semgrep.mjs --help
eq "$($E LANG=C node ../semgrep.mjs -h | head -1 | cut -c1-14)" "usage: semgrep" "-h"
for o in '-Q, --question' '-q, --quiet' '--level=LEVEL' '--chunk=LINES' '-j N' '--color' '--sys1-api-key' '--dry-run' '--verbose' '-H, --with-filename' '--no-filename' '--summarize'; do
  $E LANG=C node ../semgrep.mjs --help | grep -q -- "$o" || fail "--help lacks $o"
done
$E LANG=C node ../semgrep.mjs --help | grep -q 'grep by meaning' || fail "--help in English"

# --version: the version in package.json, exit 0, before any check that needs a key or a meaning
v=$(node -p "require('../package.json').version")
eq "$($E node ../semgrep.mjs --version)" "semgrep $v" "--version"
eq "$($E node ../semgrep.mjs -V)" "semgrep $v" "-V"
code 0 "--version with no key" -- $E node ../semgrep.mjs --version
$E LANG=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "--help in Japanese"
$E LANG=C LC_MESSAGES=ja_JP.UTF-8 node ../semgrep.mjs --help | grep -q '何も表示せず' || fail "LC_MESSAGES"
echo OK

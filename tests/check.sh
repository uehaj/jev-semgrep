#!/bin/sh
# Self-check: OR / AND / no-match against fixture.txt behave as expected.
# Lines near the threshold (5, 28) drift by about ±0.05 between runs, so only clear positives and negatives are asserted.
set -e
cd "$(dirname "$0")"
# API key comes from the environment or from .env at the repo root
J="node --env-file-if-exists=../.env ../semgrep.mjs"

# SEMGREP_OPTS, offline: empty input sends nothing
SEMGREP_OPTS='--level bogus' $J -e x </dev/null 2>&1 | grep -qx 'semgrep: --level must be one of loose, normal, strict'
SEMGREP_OPTS='--level bogus' $J --level strict -e x </dev/null 2>/dev/null || [ $? = 1 ]   # the command line wins
SEMGREP_OPTS='-n' $J --no-n -e x </dev/null 2>/dev/null || [ $? = 1 ]                     # --no-X clears a default
for bad in '-e refund' 'file.txt' '--' '--nope'; do
  SEMGREP_OPTS="$bad" $J -e x </dev/null 2>&1 | grep -q '^semgrep: SEMGREP_OPTS: '
done
out=$($J -n -e 'ネットワークやリモート接続の障害' -e 'customer is asking for a refund' fixture.txt 2>/dev/null | cut -d: -f1)
for n in 4 6 7 13 30; do echo "$out" | grep -qx "$n"; done
for n in 1 8 11 15 26; do ! echo "$out" | grep -qx "$n"; done
[ "$($J -n -e 'ネットワークやリモート接続の障害' -a 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 " ]
[ "$($J -n -e 'ネットワークやリモート接続の障害' -v 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | grep -cx 5)" = 0 ]
$J -n -v 'a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1 | grep -qx 11
out=$($J -n -e 'customer is asking for a refund' -e '!a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1)
for n in 7 11 20; do echo "$out" | grep -qx "$n"; done
! echo "$out" | grep -qx 4
if $J -e 'recipe for cooking pasta' fixture.txt 2>/dev/null; then exit 1; fi

# output shapes of -l / -c / -r / -C
[ "$($J -l -e 'customer is asking for a refund' fixture.txt 2>/dev/null)" = "fixture.txt" ]
[ "$($J -c -e 'customer is asking for a refund' fixture.txt 2>/dev/null)" = "1" ]
$J -r -l -e 'customer is asking for a refund' . 2>/dev/null | grep -qx './fixture.txt'
$J -n -C 1 -e 'customer is asking for a refund' fixture.txt 2>/dev/null | grep -qx '6-2026-09-19 08:02:35 ERROR timeout after 5000ms waiting for payment-gateway'
if $J -t 1.5 -e x fixture.txt 2>/dev/null; then exit 1; fi
if $J -C=1 -e x fixture.txt 2>/dev/null; then exit 1; fi
# -c prints 0 for files without a match
[ "$($J -c -e 'customer is asking for a refund' fixture.txt contrast.txt 2>/dev/null | tr '\n' ' ')" = "fixture.txt:1 contrast.txt:2 " ]
[ "$(printf 'x\n\ny\n' | $J -c -e 'about cats' 2>/dev/null)" = "0" ]
# blank lines match -v and never -e
[ "$(printf 'the cat sleeps\n\nthe dog barks\n' | $J -v 'about cats' 2>/dev/null | wc -l | tr -d ' ')" = "2" ]
# an empty meaning is an error
if $J -e '' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi

# -z: one NUL-terminated record is one unit of judgement, and matching records are NUL-terminated too.
# The first record only reads as a refund request when both of its lines are judged together.
z_in() { printf 'the package arrived\nand I want my money back for it\0the sky is blue today\0'; }
[ "$(z_in | $J -z -n -e 'the customer is asking for a refund' 2>/dev/null | tr '\0' '\n' | head -1)" = "1:the package arrived" ]
[ "$(z_in | $J -z -c -e 'the customer is asking for a refund' 2>/dev/null)" = "1" ]
# the unit really is the record: two records in, two judged (-t 0 matches everything, so this is deterministic)
[ "$(z_in | $J -z -c -t 0 -e 'anything at all' 2>/dev/null)" = "2" ]
# the same text separated by newlines is three lines, not two records
[ "$(printf 'the package arrived\nand I want my money back for it\nthe sky is blue today\n' | $J -c -t 0 -e 'anything at all' 2>/dev/null)" = "3" ]
# without -z, NUL-separated input is binary and is skipped rather than judged
[ -z "$(z_in | $J -c -e 'the customer is asking for a refund' 2>/dev/null)" ]
# matching records end with NUL
z_in | $J -z -e 'the customer is asking for a refund' 2>/dev/null | od -An -c | grep -q '\\0'
# --sentence judges sentences but prints the original lines they touch
[ "$($J -n --sentence -e 'the author admits they made a mistake' prose.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 " ]
# -o prints the sentence itself, joined, numbered by its first line; Japanese joins without a space
[ "$($J -n -o --sentence -e 'the author admits they made a mistake' prose.txt 2>/dev/null)" = "1:I should have checked the input before shipping, and that was my mistake." ]
[ "$($J -n -o --sentence -e 'customer is asking for a refund' prose.txt 2>/dev/null)" = "8:先週買った掃除機が初日から動かないので返金してほしいです。" ]
# --sentence=jev keeps unpunctuated Japanese entries apart, so the refund requests match as they do per line
[ "$($J -n --sentence -e 'the customer is asking for a refund' corpus.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "14 18 " ]

# -e '/regex/': matched locally, no Jev involved. NOKEY proves it: no key, no .env, still runs.
NOKEY="env -u TYPESAFE_API_KEY -u SEMGREP_API_KEY -u SEMGREP_URL HOME=/nonexistent-semgrep-test-home"
[ "$($NOKEY $J -n -e '/ERROR|FATAL/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 6 13 28 " ]
[ -z "$(printf 'TIMEOUT here\nfine\n' | $NOKEY $J -e '/timeout/' 2>/dev/null)" ]           # without -i, case matters
[ "$(printf 'TIMEOUT here\nfine\n' | $NOKEY $J -e '/timeout/i' 2>/dev/null)" = "TIMEOUT here" ]  # flags
[ "$($NOKEY $J -n -v '/ERROR/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 5 7 8 9 10 11 12 14 15 16 17 18 19 20 21 22 23 24 25 26 27 29 30 " ]
[ "$($NOKEY $J -n -e '!/ERROR/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 5 7 8 9 10 11 12 14 15 16 17 18 19 20 21 22 23 24 25 26 27 29 30 " ]
[ "$($NOKEY $J -n -e '/ERROR/' -e '/lookup/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 6 13 14 28 " ]  # OR
[ "$($NOKEY $J -n -e '/ERROR/' -a '/timeout/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "6 " ]           # AND
[ "$($NOKEY $J -n -e '/ERROR/' -v '/timeout/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 13 28 " ]     # AND NOT
# a regex with no closing / is still a meaning: with no key this errors on "SEMGREP_API_KEY is not set", a real regex term wouldn't
$NOKEY $J -e '/etc 以下のファイルを変更している' fixture.txt 2>&1 >/dev/null | grep -qx 'semgrep: SEMGREP_API_KEY is not set. Put it in ./.env or ~/.config/semgrep/.env'
# an invalid pattern exits 2, one line, like grep
if $NOKEY $J -e '/(/' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# $<name> naming no group, and naming a negated regex's group, are errors -- caught before any request
if $NOKEY $J -e '/(?<t>\d+)/' -a '$<nope>' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
if $NOKEY $J -e A -v '/(?<t>\d+)/' -a '$<t>' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# so is $1 when only a negated regex has a group 1
if $NOKEY $J -e '!/(x)/' -a '$1 is valid' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# -p over a term whose regex failed: its meaning is 0.00, not a crash (it read the failed match's captures).
# Nothing is sent: the only line fails /A/. SEMGREP_URL only gets past the missing-key check.
[ "$(printf 'B\n' | $NOKEY SEMGREP_URL=http://127.0.0.1:1 $J -p -e '/A/' -a 'a meaning' -e '/B/' 2>/dev/null)" = "$(printf 'B\t[0.00 0.00 1.00]')" ]
# --sentence=rules (no extra Jev calls) and -z apply regex terms per unit
[ "$($NOKEY $J -n --sentence=rules -e '/mistake/i' prose.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 " ]
[ "$(printf 'usage 95%%\0usage 10%%\0' | $NOKEY $J -z -c -e '/usage 9\d%/' 2>/dev/null)" = "1" ]
# -p shows 1.00 / 0.00 for a regex term, no request needed
[ "$($NOKEY $J -p -e '/ERROR/' fixture.txt 2>/dev/null | grep -c '\[1.00\]')" = "4" ]
[ "$($NOKEY $J -c -p -t 0 -e '/nope-never-matches/' fixture.txt 2>/dev/null)" = "0" ]

# With the API, via a local mock that logs each request's questions and answers everything noul:1: exact
# prefilter and capture behaviour, without real cost or nondeterminism.
MOCKLOG=/tmp/semgrep-mock.$$.jsonl
node mock-jev.mjs "$MOCKLOG" > /tmp/semgrep-mockport.$$ 2>/tmp/semgrep-mockerr.$$ &
MOCKPID=$!
trap 'kill $MOCKPID 2>/dev/null; rm -f "$MOCKLOG" /tmp/semgrep-mockport.$$ /tmp/semgrep-mockerr.$$' EXIT
for _ in 1 2 3 4 5; do [ -s /tmp/semgrep-mockport.$$ ] && break; sleep 0.1; done
MOCKPORT=$(cat /tmp/semgrep-mockport.$$)
MOCK="env -u TYPESAFE_API_KEY -u SEMGREP_API_KEY SEMGREP_URL=http://127.0.0.1:$MOCKPORT"

# only units matching /re/ are sent; sent count is exactly the units asked (noul:1 makes every ask a hit)
[ "$($MOCK $J -c -e '/ERROR/' -a 'anything' fixture.txt 2>/dev/null)" = "4" ]

# captures expand into the question; $$, $&, and a literal $9 (no such group) all come through
printf '2026-09-19 03:12 alert fired\n' > /tmp/semgrep-cap.$$.txt
$MOCK $J -e '/(?<t>\d\d:\d\d)/' -a '$<t> が深夜（0時〜5時）であり、$$ $& $9' /tmp/semgrep-cap.$$.txt >/dev/null 2>&1
grep -q '03:12 が深夜（0時〜5時）であり、\$ 03:12 \$9' "$MOCKLOG"
rm -f /tmp/semgrep-cap.$$.txt
: > "$MOCKLOG"

# a unit is asked only the meanings of surviving terms: a non-matching line gets TERMB only, never TERMA
printf 'has re in it\nplain line\n' > /tmp/semgrep-ab.$$.txt
$MOCK $J -t 0 -e '/re/' -a TERMA -e TERMB /tmp/semgrep-ab.$$.txt >/dev/null 2>&1
[ "$(grep -o TERMA "$MOCKLOG" | wc -l | tr -d ' ')" = "1" ]   # only the line containing "re" was asked TERMA
[ "$(grep -o TERMB "$MOCKLOG" | wc -l | tr -d ' ')" = "2" ]   # TERMB has no regex guard, asked for every line
rm -f /tmp/semgrep-ab.$$.txt
: > "$MOCKLOG"

# with only a regex term and no meaning, nothing is ever sent, even reachable via the mock
printf 'has re in it\n' > /tmp/semgrep-only.$$.txt
$MOCK $J -e '/re/' /tmp/semgrep-only.$$.txt >/dev/null 2>&1
[ ! -s "$MOCKLOG" ]
rm -f /tmp/semgrep-only.$$.txt

kill $MOCKPID 2>/dev/null
wait $MOCKPID 2>/dev/null || true
trap - EXIT
rm -f "$MOCKLOG" /tmp/semgrep-mockport.$$ /tmp/semgrep-mockerr.$$
echo OK

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
for n in 1 8 11 15 26; do if echo "$out" | grep -qx "$n"; then exit 1; fi; done
[ "$($J -n -e 'ネットワークやリモート接続の障害' -a 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 " ]
[ "$($J -n -e 'ネットワークやリモート接続の障害' -v 'a retry is happening or was attempted' fixture.txt 2>/dev/null | cut -d: -f1 | grep -cx 5)" = 0 ]
$J -n -v 'a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1 | grep -qx 11
out=$($J -n -e 'customer is asking for a refund' -e '!a timestamped server log line' fixture.txt 2>/dev/null | cut -d: -f1)
for n in 7 11 20; do echo "$out" | grep -qx "$n"; done
if echo "$out" | grep -qx 4; then exit 1; fi
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

# --dedup. The summary line ("… (N sent of M) …") is only printed to a terminal, so run under script(1).
# util-linux script answers --version and takes the command with -c; BSD script takes it as arguments.
if script --version >/dev/null 2>&1; then onpty() { script -qec "$1" /dev/null </dev/null; }; else onpty() { script -q /dev/null sh -c "$1" </dev/null; }; fi
sent() { onpty "$J --dedup $* 2>&1 >/dev/null" | grep -o '[0-9]* sent of [0-9]*'; }
ids() { printf 'worker request 3fa9c1e27b failed: connection reset\nworker request 88d0e41a5c failed: connection reset\nworker request 0b7f2a9e13 failed: connection reset\nworker started\n'; }
disk() { printf 'disk usage 95%%\ndisk usage 12%%\ndisk usage 97%%\n'; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ids > "$T/ids"; disk > "$T/disk"
printf 'backup finished at 09:00\nbackup finished at 23:30\nbackup finished at 10:15\n' > "$T/time"
printf 'fetch /admin/config via https://example.org\nfetch https://example.org via /admin/config\n' > "$T/swap"
printf 'GET https://example.com/admin/users\nGET https://example.com/public/index\nGET https://evil.example.net/public/index\n' > "$T/url"
printf 'the same line\nthe same line\nthe same line\n' > "$T/same"
printf '{"url":"https://example.com/a","status":"failed"}\n{"url":"https://example.com/b","status":"success"}\n' > "$T/json"
# identical lines are one group whatever the meaning
[ "$(sent -e "'about cats'" "$T/same")" = "1 sent of 3" ]
# ids carry no meaning for a failure: the three failures fold into one, and each member gets the answer
[ "$(sent -e "'a request failed'" "$T/ids")" = "2 sent of 4" ]
[ "$($J --dedup -c -e 'a request failed' "$T/ids" 2>/dev/null)" = "3" ]
# every line is still printed, with its own original text rather than the representative's or the mask
[ "$($J --dedup -c -t 0 -e 'anything at all' "$T/ids" 2>/dev/null)" = "4" ]
$J --dedup -n -e 'a request failed' "$T/ids" 2>/dev/null | grep -qx '2:worker request 88d0e41a5c failed: connection reset'
# (placeholders start with a NUL, so a leaked mask would show one; "! … | grep" would never stop set -e)
if $J --dedup -e 'a request failed' "$T/ids" 2>/dev/null | od -An -c | grep -q '\\0'; then exit 1; fi
# a meaning that reads the number keeps numbers apart (#19)
[ "$(sent -e "'disk usage is above 90%'" "$T/disk")" = "3 sent of 3" ]
[ "$($J --dedup -n -e 'disk usage is above 90%' "$T/disk" 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 3 " ]
# a meaning that reads the time keeps times apart
[ "$(sent -e "'happened at night'" "$T/time")" = "3 sent of 3" ]
[ "$($J --dedup -n -e 'happened at night' "$T/time" 2>/dev/null | cut -d: -f1)" = "2" ]
# a kept kind is safe from the folded ones: the host is kept, and the path mask must not reach into the URL
# (it did, and folded evil.example.net into example.com)
[ "$(sent -e "'the request is sent to example.com'" "$T/url")" = "3 sent of 3" ]
[ "$($J --dedup -n -e 'the request is sent to example.com' "$T/url" 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 " ]
# kept values stay tied to their place: a URL and a path in swapped places are two groups
# (they were one, and the second line took the first one's match)
[ "$(sent -e "'the line fetches /admin/config from https://example.org'" "$T/swap")" = "2 sent of 2" ]
[ "$($J --dedup -n -e 'the line fetches /admin/config from https://example.org' "$T/swap" 2>/dev/null | cut -d: -f1)" = "1" ]
# a URL mask stops at the quote: in jsonl it swallowed the fields after it, and failed and success were one group
[ "$(sent -e "'the request failed'" "$T/json")" = "2 sent of 2" ]
[ "$($J --dedup -n -e 'the request failed' "$T/json" 2>/dev/null | cut -d: -f1)" = "1" ]
# the per-meaning question runs under -j too, and several meanings still combine
[ "$($J --dedup -j 1 -c -e 'a request failed' -e 'disk usage is above 90%' "$T/ids" "$T/disk" 2>/dev/null | tr '\n' ' ')" = "$T/ids:3 $T/disk:2 " ]
# The grouping key itself, offline: which lines share a key once Jev has named the kinds to keep.
# (Through the API these hide behind Jev's answer: when it keeps numbers too, the bugs below never show.)
node --input-type=module -e "
const src = (await import('node:fs')).readFileSync('../semgrep.mjs', 'utf8');
const { MASK, templateKey } = new Function(src.slice(src.indexOf('const DATE ='), src.indexOf('// Regex terms are never folded')) + 'return { MASK, templateKey };')();
const key = (t, keep) => templateKey(t, MASK.filter(([k]) => keep.includes(k)), MASK.filter(([k]) => !keep.includes(k)));
const check = (a, b, keep, same) => { if ((key(a, keep) === key(b, keep)) !== same) { console.error('dedup key:', a, '|', b, keep); process.exit(1); } };
check('value 12', 'value 99', [], true);
check('value 12', 'value <num>', [], false);                          // text that looks like a placeholder is not one
check('user May failed to log in', 'user Jan failed to log in', [], false); // a month name without a day is not a date
check('Thu Sep 10 20:33:51 done', 'Fri Oct 17 21:00:00 done', [], true);   // syslog dates still fold
check('Thu Sep 10 20:33:51 done', 'Thu Sep 17 20:33:51 done', ['time'], false); // a kept date keeps its day
check('primary https://a/500 secondary https://a/fixed', 'primary https://a/fixed secondary https://a/500', ['num'], false); // the URL mask kept the mark
"
# scripts/dedup-measure.mjs uses the same masks (it slices them out of semgrep.mjs, so this breaks if they move)
node ../scripts/dedup-measure.mjs "$T/ids" | tail -1 | grep -q " | 4 | 2 | "   # 4 lines, 2 templates
# empty input asks nothing
[ "$(printf '' | $J --dedup -c -e 'about cats' 2>/dev/null)" = "0" ]
# with --sentence the unit is a sentence, and sentences fold like lines
printf 'The job 3fa9c1e27b failed. The job 88d0e41a5c failed.\n' > "$T/sent"
[ "$(sent --sentence=rules -e "'a job failed'" "$T/sent")" = "1 sent of 2" ]
# -e '/regex/': matched locally, no Jev involved. NOKEY proves it: no key, no .env, still runs.
# $NJ skips $J's --env-file (a ../.env would bring the key back), SEMGREP_OPTS= drops the user's defaults.
NOKEY="env -u TYPESAFE_API_KEY -u SEMGREP_API_KEY -u SEMGREP_URL SEMGREP_OPTS= HOME=/nonexistent-semgrep-test-home"
NJ="node ../semgrep.mjs"
[ "$($NOKEY $NJ -n -e '/ERROR|FATAL/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 6 13 28 " ]
[ -z "$(printf 'TIMEOUT here\nfine\n' | $NOKEY $NJ -e '/timeout/' 2>/dev/null)" ]           # without -i, case matters
[ "$(printf 'TIMEOUT here\nfine\n' | $NOKEY $NJ -e '/timeout/i' 2>/dev/null)" = "TIMEOUT here" ]  # flags
[ "$($NOKEY $NJ -n -v '/ERROR/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 5 7 8 9 10 11 12 14 15 16 17 18 19 20 21 22 23 24 25 26 27 29 30 " ]
[ "$($NOKEY $NJ -n -e '!/ERROR/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 5 7 8 9 10 11 12 14 15 16 17 18 19 20 21 22 23 24 25 26 27 29 30 " ]
[ "$($NOKEY $NJ -n -e '/ERROR/' -e '/lookup/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 6 13 14 28 " ]  # OR
[ "$($NOKEY $NJ -n -e '/ERROR/' -a '/timeout/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "6 " ]           # AND
[ "$($NOKEY $NJ -n -e '/ERROR/' -v '/timeout/' fixture.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "4 13 28 " ]     # AND NOT
# a regex with no closing / is still a meaning: with no key this errors on "SEMGREP_API_KEY is not set", a real regex term wouldn't
$NOKEY $NJ -e '/etc 以下のファイルを変更している' fixture.txt 2>&1 >/dev/null | grep -qx 'semgrep: SEMGREP_API_KEY is not set. Put it in ./.env or ~/.config/semgrep/.env'
# an invalid pattern exits 2, one line, like grep
if $NOKEY $NJ -e '/(/' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
[ "$($NOKEY $NJ -e '/(/' fixture.txt 2>&1 | wc -l | tr -d ' ')" = "1" ]
# $<name> naming no group, and naming a negated regex's group, are errors -- caught before any request
if $NOKEY $NJ -e '/(?<t>\d+)/' -a '$<nope>' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
if $NOKEY $NJ -e A -v '/(?<t>\d+)/' -a '$<t>' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# so is $1 when only a negated regex has a group 1
if $NOKEY $NJ -e '!/(x)/' -a '$1 is valid' fixture.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# -p over a term whose regex failed: its meaning is 0.00, not a crash (it read the failed match's captures).
# Nothing is sent: the only line fails /A/. SEMGREP_URL only gets past the missing-key check.
[ "$(printf 'B\n' | $NOKEY SEMGREP_URL=http://127.0.0.1:1 $NJ -p -e '/A/' -a 'a meaning' -e '/B/' 2>/dev/null)" = "$(printf 'B\t[0.00 0.00 1.00]')" ]
# --sentence=rules (no extra Jev calls) and -z apply regex terms per unit
[ "$($NOKEY $NJ -n --sentence=rules -e '/mistake/i' prose.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 2 3 " ]
[ "$(printf 'usage 95%%\0usage 10%%\0' | $NOKEY $NJ -z -c -e '/usage 9\d%/' 2>/dev/null)" = "1" ]
# -p shows 1.00 / 0.00 for a regex term, no request needed
[ "$($NOKEY $NJ -p -e '/ERROR/' fixture.txt 2>/dev/null | grep -c '\[1.00\]')" = "4" ]
[ "$(printf 'plain\n' | $NOKEY $NJ -p -v '/ERROR/' 2>/dev/null)" = "$(printf 'plain\t[0.00]')" ]

# Nothing is sent where no term can hold: SEMGREP_URL points at a closed port, so any request would fail with exit 2.
DEAD="$NOKEY SEMGREP_URL=http://127.0.0.1:1 $NJ"
[ "$(printf 'plain line\n' | $DEAD -c -e '/re/' -a 'anything' 2>/dev/null || echo "exit $?")" = "$(printf '0\nexit 1')" ]  # 1: no match, 2 would be a failed request
[ "$(printf 'has re in it\n' | $DEAD -c -e '/re/' 2>/dev/null)" = "1" ]

# Captures, offline: the expansion function itself ($<name>, $$, $&, $n with two digits or one, $9 with no group).
node --input-type=module -e "
const src = (await import('node:fs')).readFileSync('../semgrep.mjs', 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const expandCaptures = new Function(cut('const SUBST =', 'for (const term of expr)') + cut('function expandCaptures', '// asksByUnit') + 'return expandCaptures;')();
const m = /(?<t>\d\d:\d\d) (\w+)/.exec('at 03:12 alert fired');
const eq = (text, want) => { const got = expandCaptures(text, [m]); if (got !== want) { console.error('expand:', text, '->', got); process.exit(1); } };
eq('\$<t> が深夜である', '03:12 が深夜である');
eq('\$\$ \$& \$9', '\$ 03:12 alert \$9');
eq('\$2 \$20 \$02', 'alert alert0 alert');
eq('\$100 以上の請求', '03:12' + '00 以上の請求');
"

# With the API: the stderr summary (printed only to a terminal, hence script(1)) counts the units sent.
sent() { onpty "$J $* 2>&1 >/dev/null" | grep -o '([0-9]* sent)'; }
[ "$(sent -e "'/ERROR/'" -a "'a network or remote connection failure'" fixture.txt)" = "(4 sent)" ]   # only the 4 ERROR lines
[ "$(sent -e "'/ERROR/'" -a "'a network or remote connection failure'" -e "'customer is asking for a refund'" fixture.txt)" = "(30 sent)" ]  # the second term has no regex
# a line without the regex is asked only the other term: A is true of both lines (line 2 alone scores 0.96),
# yet line 2 does not match through it
printf 'the invoice was paid on time\nthe weather is sunny today\n' > "$T/ab"
[ "$($J -n -e '/invoice/' -a 'the line is a complete English sentence' -e 'the line is about cooking' "$T/ab" 2>/dev/null | cut -d: -f1)" = "1" ]
# the captured value reaches Jev: 03:12 is at night, 14:40 is not, though the meaning's text is the same
printf '2026-09-19 03:12 alert fired\n2026-09-19 14:40 alert fired\n' > "$T/night"
[ "$($J -n -e '/(?<t>\d\d:\d\d)/' -a '$<t> is between midnight and 5 a.m.' "$T/night" 2>/dev/null | cut -d: -f1)" = "1" ]

# -Q / --question: -e "the line answers: X", lines that answer X, not lines asking it (#22).
# A fact need matches the line stating it (1), not one asking for it (2) or an on-topic non-answer (3, 4).
[ "$($J -n -Q "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 " ]
[ "$($J -n --question "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 " ]
# A yes/no need matches both a confirming (5) and a DENYING (6) line; asking (7) and an on-topic
# non-answer (8) do not match, even though the asking line is close to the proposition.
[ "$($J -n -Q 'whether the server is down' intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 6 " ]
# -Q combines with -v like -e: the denial (6) answers the need, and -v takes it out (-Q 0.88, "the server is healthy" 0.99)
[ "$($J -n -Q 'whether the server is down' -v 'the server is healthy' intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 " ]
# -e and -Q OR together, each branch bringing a line the other does not: 4 is sunny, 1 names the cat
[ "$($J -n -e 'the weather is sunny' -Q "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 4 " ]
# an answer split over two lines is one sentence with --sentence
[ "$(printf '名前は\nタマである\n' | $J --sentence=rules -o -Q '猫の名前' 2>/dev/null)" = "名前はタマである" ]
# -Q needs its argument
if $J -Q '' intent.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# SEMGREP_OPTS rejects -Q / --question, like -e / -a / -v
SEMGREP_OPTS='-Q x' $J -e y </dev/null 2>&1 | grep -q '^semgrep: SEMGREP_OPTS: '

# -q / --quiet: nothing on stdout, the answer is the exit status; a match wins over an unreadable file (grep -q)
[ -z "$($J -q -Q "the cat's name" intent.txt 2>/dev/null)" ]
$J --quiet -e 'the weather is sunny' intent.txt 2>/dev/null
if $J -q -e 'a volcano is erupting' intent.txt 2>/dev/null; then exit 1; elif [ $? -ne 1 ]; then exit 1; fi
$J -q -Q "the cat's name" intent.txt no-such-file 2>/dev/null
echo OK

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

# -k / --i-want-to-know: matches lines that answer a need, not lines it holds true of (#22).
# A fact need matches the line stating it (1), not one asking for it (2) or an on-topic non-answer (3, 4).
[ "$($J -n -k "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 " ]
[ "$($J -n --i-want-to-know "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 " ]
# A yes/no need matches both a confirming (5) and a DENYING (6) line; asking (7) and an on-topic
# non-answer (8) do not match, even though the asking line is close to the proposition.
[ "$($J -n -k 'whether the server is down' intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 6 " ]
# -k combines with -v like -e: the denial (6) answers the need, and -v takes it out (0.01 against 0.92)
[ "$($J -n -k 'whether the server is down' -v 'the server is healthy' intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "5 " ]
# -e and -k OR together, each branch bringing a line the other does not: 4 is sunny, 1 names the cat
[ "$($J -n -e 'the weather is sunny' -k "the cat's name" intent.txt 2>/dev/null | cut -d: -f1 | tr '\n' ' ')" = "1 4 " ]
# an answer split over two lines is one sentence with --sentence
[ "$(printf '名前は\nタマである\n' | $J --sentence=rules -o -k '猫の名前' 2>/dev/null)" = "名前はタマである" ]
# -k needs its argument
if $J -k '' intent.txt >/dev/null 2>&1; then exit 1; elif [ $? -ne 2 ]; then exit 1; fi
# SEMGREP_OPTS rejects -k / --i-want-to-know, like -e / -a / -v
SEMGREP_OPTS='-k x' $J -e y </dev/null 2>&1 | grep -q '^semgrep: SEMGREP_OPTS: '
echo OK

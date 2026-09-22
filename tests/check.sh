#!/bin/sh
# Self-check: OR / AND / no-match against fixture.txt behave as expected.
# Lines near the threshold (5, 28) drift by about ±0.05 between runs, so only clear positives and negatives are asserted.
set -e
cd "$(dirname "$0")"
# API key comes from .env at the repo root (override with SEMGREP_ENV)
export SEMGREP_ENV="${SEMGREP_ENV:-$PWD/../.env}"
J="node ../semgrep.mjs"
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
echo OK

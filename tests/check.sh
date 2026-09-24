#!/bin/sh
# Self-check: OR / AND / no-match against fixture.txt behave as expected.
# Lines near the threshold (5, 28) drift by about ±0.05 between runs, so only clear positives and negatives are asserted.
set -e
cd "$(dirname "$0")"
# API key comes from the environment or from .env at the repo root
J="node --env-file-if-exists=../.env ../semgrep.mjs"
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

# --dedup. The summary line ("… (N sent of M) …") is only printed to a terminal, so run under script(1).
# util-linux script answers --version and takes the command with -c; BSD script takes it as arguments.
if script --version >/dev/null 2>&1; then onpty() { script -qec "$1" /dev/null; }; else onpty() { script -q /dev/null sh -c "$1"; }; fi
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
! $J --dedup -e 'a request failed' "$T/ids" 2>/dev/null | grep -q '<'
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
# empty input asks nothing
[ "$(printf '' | $J --dedup -c -e 'about cats' 2>/dev/null)" = "0" ]
echo OK

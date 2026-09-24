# semgrep — grep by meaning

[日本語版はこちら](README.ja.md)

Background and design notes (Japanese): [Jevのキラーアプリ、「意味で探す grep」を作った](https://zenn.dev/uehaj/articles/jev-semgrep-grep-by-meaning) on Zenn.

A grep that finds lines by **what they mean**, not by regular expressions.
Matching is done by **Jev**, the System One model from [TypeSafe AI](https://typesafe.ai/).
Jev does not generate text. It answers typed questions with probabilities, so for every line
semgrep asks "does this line match the meaning *network failure*?", gets a probability back,
and applies a threshold.

```sh
./semgrep -n -e "customer is angry or frustrated" tickets.txt
```

- Zero dependencies. One file, Node.js 20.12+ and `fetch`.
- Fast. 30 lines go into one request, requests run 8 at a time. A 210-line file finishes in under a second.
- Meanings combine with AND / OR / NOT.
- **Language-agnostic.** The meaning and the text can each be in any language. A Japanese meaning finds French, Russian, Chinese and Korean lines alike. No translation step, same speed, same cost.

## Search across languages

The meaning and the text do not have to share a language. Jev compares concepts, not words,
so one query finds matching lines in every language the file contains.

An **English** meaning finds **Japanese** lines. None of the hits contain "angry" or "frustrated", and two of them are in Japanese:

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
```

A **Japanese** meaning finds **English** lines, with the same confidence as the Japanese ones:

```sh
$ ./semgrep -n -p -e "返金の要求" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.95]
```

It is not a Japanese/English feature. `tests/multi.txt` holds refund requests and thank-you notes in French,
Russian, German, Spanish, Chinese and Korean. One Japanese meaning finds all six refund requests; a Russian
meaning does the same:

```sh
$ ./semgrep -n -p -e "顧客が返金を求めている" tests/multi.txt
1:Je veux être remboursé, le produit est arrivé cassé.	[0.98]
3:Я требую вернуть деньги, товар не работает.	[0.97]
5:Ich möchte mein Geld zurück, das Gerät ist defekt.	[0.97]
7:Quiero un reembolso, el paquete llegó vacío.	[0.97]
9:我要求退款，商品坏了。	[0.97]
11:환불해 주세요. 제품이 고장났어요.	[0.97]

$ ./semgrep -n -p -e "клиент требует возврат денег" tests/multi.txt
1:Je veux être remboursé, le produit est arrivé cassé.	[0.94]
3:Я требую вернуть деньги, товар не работает.	[0.97]
5:Ich möchte mein Geld zurück, das Gerät ist defekt.	[0.92]
7:Quiero un reembolso, el paquete llegó vacío.	[0.89]
9:我要求退款，商品坏了。	[0.92]
11:환불해 주세요. 제품이 고장났어요.	[0.89]
```

This makes semgrep useful for mixed-language logs and ticket dumps, and for teams whose members
query in different languages. One caveat: TypeSafe documents English as the most accurate language,
and in our tests Japanese meanings wobble a little more near the threshold. When a query is borderline,
phrasing the meaning in English is the safer choice.

## How this differs from vector search

If all you want is "lines about X", embedding similarity gives you the same lines. semgrep differs in
*what* it judges: not how close a line is to a topic, but whether a **proposition** holds for that line.
Jev reads the line and the question together (a cross-encoder shape), so who did what, negation, and
"asked for" versus "already done" all change the answer. An embedding of the line is fixed before it
ever sees your query, so it can only measure topical closeness.

All six lines below are "about a refund". Only two are a customer asking for one:

```sh
$ ./semgrep -n -p -t 0 -e "customer is asking for a refund" tests/contrast.txt
1:返金してほしい。商品が壊れていた	[0.98]
2:返金処理が完了しましたのでご確認ください	[0.10]
3:当社の返金ポリシーは購入後30日以内です	[0.10]
4:The manager denied the refund request yesterday	[0.17]
5:I demand a full refund immediately	[0.94]
6:Refunds are processed within 5 business days	[0.08]
```

Because each meaning yields an independent probability, **logical AND and NOT are plain boolean
operations**, not a trick with set differences or "negative queries":

```sh
# about a refund, but NOT a customer asking for one → completed, policy, denied, timelines
$ ./semgrep -n -e "about a refund" -v "the customer is asking for a refund" tests/contrast.txt
2:返金処理が完了しましたのでご確認ください
3:当社の返金ポリシーは購入後30日以内です
4:The manager denied the refund request yesterday
6:Refunds are processed within 5 business days

# angry AND it is the customer, not the staff
$ ./semgrep -n -e "someone is angry" -a "the customer, not the staff, is the one acting" tests/contrast.txt
5:I demand a full refund immediately
8:顧客が怒って電話を切った
```

Line 7, `カスタマーサポート担当者が怒って電話を切った` (the *support agent* hung up angrily), scores 0.05
on the second meaning and is excluded. Cosine similarity between lines 7 and 8 is close to 1.

Two more practical consequences. The probabilities are calibrated, so one threshold (0.5) works across
queries, where cosine scores need top-k or per-query tuning. And there is no index to build: semgrep reads
the files in front of you. The flip side is that every query pays for the whole corpus again, so for
repeated queries over a large, fixed corpus a vector index is cheaper and faster.

## Install

Two ways to use it: as a command-line tool (this section), or as a Claude Code skill
(see [Use it from Claude Code](#use-it-from-claude-code) below). The skill falls back to `npx @uehaj/semgrep`,
so if you only use it through Claude Code you can skip the install here entirely and just set the API key.

Requires Node.js 20.12 or later. No other dependencies.

```sh
npm install -g @uehaj/semgrep
semgrep --help
```

To try it without installing, run it through `npx` (the first run downloads the package, later runs use the cache):

```sh
npx @uehaj/semgrep -n -e "customer is angry or frustrated" tickets.txt
```

Then give it an API key from the [TypeSafe console](https://console.typesafe.ai/). Any one of these works:

```sh
export SEMGREP_API_KEY=your-key                       # environment variable
echo 'SEMGREP_API_KEY=your-key' > ~/.config/semgrep/.env    # per user (mkdir -p first)
echo 'SEMGREP_API_KEY=your-key' > .env                # per project, read from the current directory
```

Variables already in the environment win; otherwise the first of `./.env` and `~/.config/semgrep/.env` fills them in.
`TYPESAFE_API_KEY` is accepted too when `SEMGREP_API_KEY` is not set.

### Default options

`SEMGREP_OPTS` holds options to apply on every call, read like the settings above. It is split on spaces and put in
front of the command line, so the command line wins: a later value counts, and `--no-X` turns a default flag off.

```sh
export SEMGREP_OPTS='--level strict -j 8 -n'
semgrep -e "payment failed" app.log                  # strict, 8 at once, line numbers
semgrep --level loose --no-n -e "payment failed" app.log
```

A script calling semgrep would pick these up too (grep dropped `GREP_OPTIONS` for that reason). Call it as
`SEMGREP_OPTS= semgrep ...` in scripts.

### Other endpoints

The API is configured by exactly three settings: `SEMGREP_API_KEY` (or `TYPESAFE_API_KEY`), `SEMGREP_URL` and `SEMGREP_MODEL`.
Any endpoint that speaks TypeSafe's `POST /v1/systemone` works. The key is sent to `SEMGREP_URL` as is, so set the
two together.

```sh
# OpenRouter
SEMGREP_URL=https://openrouter.ai/api/v1/systemone SEMGREP_API_KEY=sk-or-... semgrep -e ...
# Vercel AI Gateway
SEMGREP_URL=https://ai-gateway.vercel.sh/typesafe/v1/systemone SEMGREP_MODEL=typesafe-ai/jev SEMGREP_API_KEY=vck_... semgrep -e ...
# A compatible server that needs no key: no Authorization header is sent
SEMGREP_URL=http://localhost:8000/v1/systemone semgrep -e ...
```

The summary line shows the cost the endpoint reports (`usage.cost`), or for TypeSafe itself an estimate at list
price marked `~`.

From source: `git clone https://github.com/uehaj/jev-semgrep.git && cd jev-semgrep && npm install -g .`,
or run it in place with `node semgrep.mjs ...`.

> The name collides with the static-analysis tool [Semgrep](https://semgrep.dev/). Rename one of them if you use both.

## Examples

All examples run against [`tests/corpus.txt`](tests/corpus.txt), a 51-line mix of server logs,
support tickets in English and Japanese, source code, SQL and small talk.

### Find lines by a concept, in any language

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
5/51 lines, 2 requests, 3225 input tokens
```

None of these lines contain the words "angry" or "frustrated". The Japanese lines were found by an English meaning.

### OR: two meanings, and see the probabilities with `-p`

```sh
$ ./semgrep -n -p -e "返金の要求" -e "配送先の変更依頼" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97 0.02]
17:ユーザー高橋さんからの問い合わせ: 配送先の住所を変更したいのですが	[0.01 0.96]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.96 0.01]
22:Can I change the delivery address for order #8821?	[0.02 0.96]
4/51 lines, 2 requests, 4602 input tokens
```

The bracket shows one probability per meaning, in the order given. Use it to pick a threshold.

With `--color` (on by default in a terminal) the probabilities are colored against the thresholds:
green at or above `-t`, red below `-T`, yellow in between. Line numbers and file names use grep's colors.

![colored output: line numbers in green, probabilities in green or red](docs/color.svg)

### AND NOT: network errors, excluding retries

```sh
$ ./semgrep -n -e "network or remote connection failure" -v "a retry is happening or was attempted" tests/corpus.txt
4:2026-09-19 08:02:30 ERROR connection reset by peer while calling payment-gateway
6:2026-09-19 08:02:35 ERROR timeout after 5000ms waiting for payment-gateway
9:2026-09-19 08:10:44 ERROR DNS lookup failed for api.example.com
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
13:network unreachable: no route to host 10.0.0.5
30:except ConnectionError as e:
31:    logger.error("upstream unreachable: %s", e)
7/51 lines, 2 requests, 5112 input tokens
```

Line 5, `retrying payment-gateway request (attempt 2/3)`, is a network failure but is dropped by `-v`.

### Mixed: (finance AND negative) OR weather

```sh
$ ./semgrep -n -e "about economy, finance or markets" -a "the news is negative or a decline" -e "about weather" tests/corpus.txt
36:今日の天気は晴れ、最高気温は28度です
43:Stock prices fell 3% after the earnings report missed expectations.
48:明日は雨の予報なので傘を持っていきます
3/51 lines, 2 requests, 5673 input tokens
```

`The central bank raised interest rates` is about finance but not a decline, so it is out.

### Strictness presets

```sh
$ ./semgrep --level strict -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.

$ ./semgrep --level loose -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.
```

`strict` keeps only what the model is sure about. `loose` also pulls in the expired certificate and the suspicious-billing ticket.

### Recursive search and file names only

```sh
$ ./semgrep -r -n -e "customer is asking for a refund" docs/
docs/tickets/a.txt:7:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
docs/tickets/sub/b.txt:1:The customer wants a refund for the broken lamp.

$ ./semgrep -rl -e "customer is asking for a refund" docs/
docs/tickets/a.txt
docs/tickets/sub/b.txt
```

`-r` walks directories in sorted order and skips `.git`, `node_modules`, `.ssh`, `.aws`, `.gnupg`, binary files
(a NUL byte in the first 8 KB) and files that usually hold secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
`id_rsa` and friends). **Every line that is searched is sent to the TypeSafe API**, so point `-r` at a directory
you mean to scan. A file named explicitly on the command line is always searched, even if it matches the skip list. `-l` prints each
matching file once, in the order matches are found, and works with or without `-r`. `-c` prints the number of
matching lines per file instead.

### Everything that is *not* something

```sh
./semgrep -v "a timestamped server log line" mixed.txt   # like grep -v
./semgrep -e "source code or SQL" -v "SQL" src.txt       # code, but not SQL
cat app.log | ./semgrep -e "the deploy failed or was rolled back"
```

### Records that span several lines (`-z`)

The unit of judgement is a line. That is right for logs and source, and wrong when one record spans
several lines. `-z` makes the unit a NUL-terminated record instead, exactly as in `grep -z`, so it pairs
with the tools that already emit records: `git log -z`, `find -print0`, `xargs -0`.

A proposition like "this commit changes user-visible behaviour" is true of a whole commit, not of any one
line in it:

```sh
$ git log -z --format='%h %s %b' | ./semgrep -z -n -e "the change alters user-visible behaviour" -v "documentation only"
7:21120e9 Revert "feat: ship the /semgrep Claude Code skill" ...
8:51ae333 feat: ship the /semgrep Claude Code skill
```

Matching records are printed NUL-terminated too, so pipe them through `tr '\0' '\n'` to read them.
File names (`-l`) and counts (`-c`) stay on newlines, as they do in grep. With `-z`, `-n` numbers records,
`-A` / `-B` / `-C` count neighbouring records, and `--chunk` counts records per request.

### One sentence at a time (`--sentence`)

`--sentence` judges each sentence instead of each line. The output is still lines, as in grep: every line a
matching sentence touches is printed, and on a terminal the sentence itself is in grep's match color.
Wrapped lines are joined before splitting, so a sentence that runs over several lines is judged as one.
[`tests/prose.txt`](tests/prose.txt) wraps an English paragraph and a Japanese one:

```sh
$ ./semgrep -n --sentence -e "the author admits they made a mistake" tests/prose.txt
1:I should have checked the input
2:before shipping, and that was my
3:mistake. Next time I will add a test
```

The sentence starts on line 1 and ends at `mistake.` on line 3; only that part is colored, not
`Next time I will add a test`, which is judged separately and does not match.

`-o` prints only the matching sentences, one per line, as `grep -o` prints only the matching part.
`-n` then gives the line where the sentence starts. Japanese is joined without a space, as are Chinese,
Thai, Lao, Khmer, Myanmar and Tibetan, which do not put spaces between words:

```sh
$ ./semgrep -n -o --sentence -e "the author admits they made a mistake" -e "customer is asking for a refund" tests/prose.txt
1:I should have checked the input before shipping, and that was my mistake.
8:先週買った掃除機が初日から動かないので返金してほしいです。
```

Without `-o`, `-c` counts lines and `-A` / `-B` / `-C` count lines, as usual. With `-o` they count sentences.
With `-z`, each record is split on its own and matching records are printed whole.

Jev finds a matching sentence inside a long line on its own, so `--sentence` is not needed for accuracy.
Use it to see which sentence matched, to get the sentences with `-o`, and when AND should hold within one
sentence: the expression is evaluated per sentence. For the same reason `-v X` alone prints every line
with at least one sentence that is not X; to find lines that are not X as a whole, leave `--sentence` off.

Japanese and Chinese entries often end without `。`: a chat message, a support ticket, a memo line. Joining
them would glue separate entries into one "sentence". So by default (`--sentence`, the same as
`--sentence=jev`) semgrep asks Jev about each unpunctuated break next to a script written without word
spaces: "does this line break end a sentence or entry, or is it a wrap inside a sentence?" It sends 30 lines
per request with one yes/no per break, and keeps the lines apart when the answer is 0.7 or more. On
[`tests/corpus.txt`](tests/corpus.txt) this keeps the four one-line Japanese tickets apart, so
`--sentence` finds the same refund requests (lines 14 and 18) as a line-by-line search, where the rules alone
merged the tickets and missed line 18. The extra requests cost about as much as one more meaning; use
`--sentence=rules` to skip them. Breaks between English lines are never asked: joining them keeps a space,
and the full stop still ends the sentence.

Where a newline cannot be inside a sentence, lines are not joined: at a blank line, next to brackets or
`;` (JSON, code), and before a line starting with `-` `*` `+` `#` `>` `"` or a digit (list items,
headings, quotes, numbers, timestamps). So JSONL keeps one line per record and each line is split on its
own. Sentences are cut by `Intl.Segmenter` ([Unicode UAX #29](https://unicode.org/reports/tr29/)),
which splits at `.` `!` `?` `。` `！` `？` but also after abbreviations such as `Mr.`. Logs are not prose:
consecutive log lines that start with a letter, such as `WARN ...` after `ERROR ...`, get joined.

## Use it from Claude Code

There is a Claude Code skill that runs semgrep for you: describe what you are looking for in plain words
and it builds the expression, runs the search and reports `file:line` hits. It is published in the
[`uehaj/uehaj-marketplace`](https://github.com/uehaj/uehaj-marketplace) marketplace as the `uehaj` plugin.

```sh
claude plugin marketplace add uehaj/uehaj-marketplace
claude plugin install uehaj@uehaj-marketplace
```

No separate install of the command-line tool is needed: the skill uses `semgrep` from your PATH if present,
otherwise `npx @uehaj/semgrep`. Only the API key has to be set (see [Install](#install)).

Then, inside Claude Code:

```
/uehaj:semgrep customer is asking for a refund tickets/*.txt
/uehaj:semgrep 未テストのまま入った修正 git log --oneline -200
```

Claude Code installs plugins, not single skills. If you want just this one skill, the
[skills CLI](https://skills.sh/) copies it into `~/.claude/skills/` and it is invoked as `/semgrep`:

```sh
npx skills add uehaj/uehaj-marketplace --skill semgrep -a claude-code -g
```

The skill writes the meaning in English, picks `-e` / `-a` / `-v` for AND / OR / NOT, adds `-n`, narrows large
directories to files worth paying for, and re-runs with `--level loose` or `strict` when the first result looks off.
The API key and endpoint are read the same way as on the command line (`SEMGREP_API_KEY`, `./.env`, `~/.config/semgrep/.env`).

## Usage

```
usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]

  -e MEANING   lines matching this meaning (several -e are OR'd)
  -a MEANING   AND onto the preceding -e term.      -e A -a B -e C  =  (A and B) or C
  -v MEANING   AND NOT onto the preceding -e term.  -e A -v B       =  A and not B
               At the front it is a bare negation.  -v B            =  not B  (like grep -v)
  !MEANING     a leading ! negates just that meaning, in -e / -a / -v alike
               -e A -e '!B'  =  A or not B.   -a '!C' is the same as -v C
  --level=LEVEL strictness preset, sets both thresholds (default normal)
                 loose  : -t 0.3 -T 0.7  catch more, accept some noise
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  only confident matches
  -t THRESH    positive threshold: match when probability >= THRESH (overrides --level)
  -T THRESH    negative threshold: "not X" when probability < THRESH (overrides --level)
               with -t 0.6 -T 0.3 a line at 0.3..0.6 matches neither X nor not-X
  -r           recurse into directories (current directory when FILE is omitted);
               skips .git, node_modules and binary files
  -l           print only the names of files with a match, not the lines
  -A NUM       print NUM lines of trailing context after each match (context lines use - as separator)
  -B NUM       print NUM lines of leading context before each match
  -C NUM       print NUM lines of context before and after (-A NUM -B NUM)
  -c           print only a count of matching lines per file (like grep -c)
  --chunk=LINES lines per request (default 30)
  -j N         concurrent requests (default 8)
  -n           print line numbers
  --sentence[=HOW] judge each sentence instead of each line; HOW is jev (default) or rules (see "One sentence at a time" above)
  -o           with --sentence, print only the matching sentences
  -p           print each meaning's probability at the end of the line
  --color[=WHEN] auto (default: color when stdout is a terminal) / always / never; bare --color means auto
               file and line number use grep's colors; with -p, probabilities are
               green at or above the positive threshold, red below the negative one,
               yellow in between. NO_COLOR is honored
  -h, --help   this help (Japanese when LANG / LC_ALL / LC_MESSAGES starts with ja)
```

Without FILE, stdin is read. With several files, output is prefixed with `file:`.
Exit codes follow grep: 0 matched, 1 no match, 2 error (bad arguments, unreadable file, API failure).

### Expression grammar

`-e` starts an OR term. `-a` and `-v` extend the previous term with AND and AND NOT.
A leading `!` on a meaning negates just that meaning (quote it, `!` is history expansion in most shells).

| command | means |
|---|---|
| `-e A -e B` | A or B |
| `-e A -a B` | A and B |
| `-e A -v B` | A and not B |
| `-e A -a B -v C -e D` | (A and B and not C) or D |
| `-e A -e '!B'` | A or not B |
| `-v B` | not B |

## How it works

1. Non-blank lines are cut into chunks of 30 lines (with a character cap).
2. Each chunk goes into `state` as an object `{"L000": "line 1", "L001": "line 2", ...}`,
   and one `noul` (yes/no probability) question per line × meaning goes into the same request.
3. Up to 8 requests run concurrently. Output is printed in file order.
4. Per line, each meaning's probability is thresholded to a boolean and the AND / OR / NOT expression is evaluated.

Batching does not change the probabilities compared with one line per request
(30 lines in one request take about 0.2 s, one line at a time about 7 s).
Very large chunks start losing lines near the threshold, hence the default of 30.
Probabilities drift by about ±0.05 between runs. Use `-p` when tuning thresholds.

Pricing is $0.042 per million input tokens (September 2026). A 30-line chunk with two meanings is about
3,000 tokens. Throughput is bounded by the rate limit of 1,200 requests per minute, roughly 36,000 lines
per minute at the defaults.

## Tests

`tests/` holds an LLM-as-judge test. Each of the 10 cases in `tests/cases.json` runs against
`tests/corpus.txt` (51 lines). Claude (`claude -p`) decides which lines truly match each meaning;
the runner evaluates the boolean expression on those verdicts and compares with semgrep's output,
reporting precision and recall. It also sweeps `-t` × `-T` in 0.05 steps and reports the best pair.

```sh
node --no-warnings tests/judge.mts [--model sonnet] [--rejudge]
```

Judge verdicts are cached in `tests/verdicts.json`; later runs do not call the judge.
The result is written to `tests/report.md`. Latest: precision 0.94, recall 0.98.

## Limits

- Every searched line is sent to api.typesafe.ai. Do not run it over files you would not upload there.
- Blank lines are not sent; they count as probability 0 for every meaning, so `-v X` prints them and `-e X` never does.
- Lines are truncated to 2,000 characters before sending.
- The maximum number of questions per request is undocumented; 420 worked.
- 429 / 529 are retried up to 6 times with exponential backoff.
- Accuracy is best in English. Japanese works but is noisier.

## License

MIT

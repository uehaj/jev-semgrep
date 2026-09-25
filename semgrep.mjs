#!/usr/bin/env node
// semgrep: grep by meaning, scored line by line with Jev (TypeSafe System One).
//   semgrep -e "network failure" -a "already retried" -e "customer wants a refund" FILE...
//   semgrep -Q "why the job failed" FILE...   # -Q X is -e "the line answers: X": answering lines, not asking ones
//   -e / -Q terms are OR'd; -a / -v attach AND / AND NOT to the preceding term: (A and B and not C) or D.
//   A leading ! negates just that meaning: -e A -e '!B' is A or not B.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Errors are one line plus exit code 2, like grep. No stack traces.
const die = (msg, hint = true) => { console.error(`semgrep: ${msg}${hint ? "\nTry 'semgrep --help' for more information." : ''}`); process.exit(2); };
process.on('uncaughtException', e => die(e.message));

// Settings come from the environment; ~/.config/semgrep/.env fills in what it lacks. Never ./.env: the current
// directory may be an untrusted checkout, and its .env could point SEMGREP_URL at a server that collects the key.
const userEnv = `${homedir()}/.config/semgrep/.env`;
if (existsSync(userEnv)) process.loadEnvFile(userEnv); // never overrides variables already set
const { SEMGREP_URL, SEMGREP_MODEL, SEMGREP_API_KEY, TYPESAFE_API_KEY, SEMGREP_OPTS = '' } = process.env;

// A bare --color means --color=auto (as in grep); parseArgs cannot express an optional value, so fill it in first.
// --no-filename is grep's name for --no-with-filename.
const fill = a => (a === '--color' ? '--color=auto' : a === '--sentence' ? '--sentence=jev' : a === '--null-data' ? '-z' : a === '--no-filename' ? '--no-with-filename' : a);
const OPTIONS = {
  e: { type: 'string', multiple: true },
  a: { type: 'string', multiple: true },
  v: { type: 'string', multiple: true },
  question: { type: 'string', multiple: true, short: 'Q' },
  level: { type: 'string', default: 'normal' }, // strictness preset: loose / normal / strict
  r: { type: 'boolean', default: false }, // recurse into directories
  l: { type: 'boolean', default: false }, // print only matching file names
  'with-filename': { type: 'boolean', short: 'H' }, // prefix file names even for one file; --no-filename: never
  t: { type: 'string' }, // positive threshold: match when p >= t (default from preset)
  T: { type: 'string' }, // negative threshold: "not X" when p < T (default from preset)
  chunk: { type: 'string', default: '30' }, // lines per request
  c: { type: 'boolean', default: false }, // count of matching lines per file (grep -c)
  quiet: { type: 'boolean', short: 'q', default: false }, // print nothing, exit status only (grep -q)
  j: { type: 'string', default: '8' }, // concurrent requests
  A: { type: 'string' }, // N lines of trailing context
  B: { type: 'string' }, // N lines of leading context
  C: { type: 'string' }, // N lines of context on both sides
  n: { type: 'boolean', default: false }, // line numbers
  z: { type: 'boolean', default: false }, // records are NUL-terminated, on input and output (grep -z)
  sentence: { type: 'string' }, // the unit of judgement is a sentence; jev / rules decide where wrapped lines join
  o: { type: 'boolean', default: false }, // with --sentence, print only the matching sentences (grep -o)
  p: { type: 'boolean', default: false }, // print each meaning's probability
  dedup: { type: 'boolean', default: false }, // judge one representative per template, reuse its answer
  'dry-run': { type: 'boolean', default: false }, // print the files and requests, send nothing
  verbose: { type: 'boolean', default: false }, // print the files and requests to stderr while searching
  interactive: { type: 'boolean', short: 'i', default: false }, // show what --dry-run would send, search on a yes
  // which files -r finds and git semgrep lists; with -r a file named on the command line is always searched
  include: { type: 'string', multiple: true }, // only names matching one of these globs
  exclude: { type: 'string', multiple: true }, // not names matching one of these globs
  'changed-within': { type: 'string' }, // only files modified within 30m / 2h / 7d / 2w, since a date, today, ...
  scope: { type: 'boolean', default: true }, // narrow those files by what a meaning says about them; --no-scope: don't
  color: { type: 'string', default: 'auto' }, // auto / always / never
  // the API settings, each overriding its environment variable
  'sys1-model': { type: 'string' }, // SEMGREP_MODEL
  'sys1-url': { type: 'string' }, // SEMGREP_URL
  'sys1-api-key': { type: 'string' }, // SEMGREP_API_KEY / TYPESAFE_API_KEY
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
};
// SEMGREP_OPTS holds default options only: no meanings, no files, no --. It goes in front of the arguments, so the
// command line wins (a later value counts; --no-X clears a flag).
const defaults = SEMGREP_OPTS.split(/\s+/).filter(Boolean).map(fill);
let optsInteractive = false; // -i from SEMGREP_OPTS: a script without a terminal is told where it came from
try {
  const { tokens: t } = parseArgs({ args: defaults, options: OPTIONS, allowPositionals: true, allowNegative: true, tokens: true });
  optsInteractive = t.some(k => k.name === 'interactive' && !k.rawName.startsWith('--no-'));
  const bad = t.find(k => k.kind !== 'option' || ['e', 'a', 'v', 'question'].includes(k.name));
  if (bad) die(`SEMGREP_OPTS: ${bad.kind === 'option' ? `${bad.name.length > 1 ? '--' : '-'}${bad.name} is not allowed (meanings go on the command line)` : `'${bad.value ?? '--'}' is not an option`}`);
} catch (e) { die(`SEMGREP_OPTS: ${e.message}`); }
const { values: opt, positionals: files, tokens } = parseArgs({
  args: [...defaults, ...process.argv.slice(2).map(fill)],
  options: OPTIONS,
  allowPositionals: true,
  allowNegative: true,
  tokens: true,
});
// --help: Japanese when the locale starts with ja, English otherwise
const HELP_EN = `usage: semgrep [OPTION]... -e MEANING|-Q QUESTION [-a MEANING] [-v MEANING]... [FILE...]
grep by meaning, powered by Jev (TypeSafe System One). Reads stdin when FILE is omitted.
As git semgrep, FILE arguments are pathspecs and every tracked file is searched, like git grep.

  -e MEANING   lines matching this meaning (several -e are OR'd)
  -Q, --question QUESTION  lines that answer QUESTION, not lines asking it; the same as
               -e "the line answers: QUESTION". "why the job failed" matches "the disk was full",
               "whether the server is down" matches a denial too. Combines with -e / -a / -v / ! like -e
  -a MEANING   AND onto the preceding -e/-Q term.      -e A -a B -e C  =  (A and B) or C
  -v MEANING   AND NOT onto the preceding -e/-Q term.  -e A -v B       =  A and not B
               At the front it is a bare negation.  -v B            =  not B  (like grep -v)
  !MEANING     a leading ! negates just that meaning, in -e / -Q / -a / -v alike
               -e A -e '!B'  =  A or not B.   -a '!C' is the same as -v C
  /RE/FLAGS    a regex term (first and last char /, JS flags dgimsuvy): matched locally, no
               request. Prefilters its AND term: only units it holds for ask that term's meanings
                 -e '/ERROR|FATAL/'  -a '/timeout/i'  -v '/^DEBUG/'   !/RE/ negates it, as above
               named/numbered groups pass to that term's meanings as $<name>, $1-$99, $&, $$
               (ECMAScript's replace patterns). $<name> naming no group, or a negated regex's
               group, is an error; prefer $<name> and single quotes ($1 doesn't survive double
               quotes in sh/bash/zsh). A meaning that really starts and ends with / needs a
               leading space to not be read as a regex
  --level=LEVEL strictness preset, sets both thresholds (default normal)
                 loose  : -t 0.3 -T 0.7  catch more, accept some noise
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  only confident matches
  -t THRESH    positive threshold: match when probability >= THRESH (overrides --level)
  -T THRESH    negative threshold: "not X" when probability < THRESH (overrides --level)
               with -t 0.6 -T 0.3 a line at 0.3..0.6 matches neither X nor not-X
  -r           recurse into directories (current directory when FILE is omitted). Skips .git,
               node_modules, .ssh/.aws/.gnupg/.kube/.docker, binary files and likely secrets (.env*,
               .netrc, .npmrc, .git-credentials, *.pem, *.key, id_rsa*...). Every searched line is sent
               to the TypeSafe API. Inside a git repository, what git ignores (.gitignore) is skipped
               too; a file or directory named on the command line is searched even so
  --include=GLOB, --exclude=GLOB  with -r and git semgrep, only files whose name matches GLOB (* ? [...]),
               or not; both can be repeated. With -r a file named on the command line is always
               searched; git semgrep's pathspecs are filtered like the rest.
               * also matches a leading dot (*.md matches .notes.md), as in rg --glob
  --changed-within=WHEN  with -r and git semgrep, only files modified within WHEN: 30m, 2h, 7d, 2w;
               since a date or time (2026-09-01 is local midnight, 2026-09-01T09:00, ...Z); or today,
               this-week (from Monday) or this-month, in local time. By mtime, not git history
  --no-scope   do not narrow the files -r and git semgrep find by what a meaning says about them. By default
               a meaning that names a language or format ("in Python", "Python で", "YAML files") searches
               only those files (*.py *.pyi *.pyw), and one that says when the code changed ("changed
               yesterday", "先週追加した") only files changed since then (in a repository: committed since
               then, or uncommitted and modified since). git also answers who and what state: "code I
               wrote", "Alice さんが書いた", "未コミットの", "staged", "untracked", "on this branch",
               "not yet pushed". Only wording that makes it a
               necessary condition counts: not "Python のような書き方", "port it to Go" or "SQL のクエリ" (SQL
               sits inside other code). A place does too: test code ("テストコードで", "in the tests"),
               migrations, the README, the CHANGELOG, documents ("ドキュメントに"; *.md *.rst *.txt docs/),
               code (what is not a document) and logs ("ログファイルに"; *.log logs/), by path conventions.
               Per term: -e A -e B still searches B in the files A leaves out.
               Each scope goes to stderr as semgrep: scope: ...; files named on the command line are never
               narrowed
  -l           print only the names of files with a match, not the lines
  -H, --with-filename  prefix each line (and -c count) with its file name, even for a single file
  --no-filename  never prefix file names, even with several files, -r or git semgrep
  -A NUM       print NUM lines of trailing context after each match (context lines use - as separator)
  -B NUM       print NUM lines of leading context before each match
  -C NUM       print NUM lines of context before and after (-A NUM -B NUM)
  -c           print only a count of matching lines per file (like grep -c)
  -q, --quiet  print nothing, stop at the first match; exit 0 on a match, even after an error (like grep -q)
  --chunk=LINES lines per request (default 30)
               Lines in one request are each other's context, so a small chunk changes verdicts
               on ambiguous lines, not just speed
  -j N         concurrent requests (default 8)
  -n           print line numbers
  -z, --null-data  the unit of judgement is a NUL-terminated record, not a line, so a record may span
               several lines. Matching records are printed NUL-terminated too (as in grep -z); file names
               and counts stay on newlines. -n numbers records, -A/-B/-C count records, --chunk counts
               records. Pairs with tools that already emit records: git log -z, find -print0, xargs -0
                 git log -z --format='%h %s %b' | semgrep -z -e "the change alters user-visible behaviour"
  --sentence[=HOW] judge each sentence instead of each line. Output is still the lines a matching sentence
               touches, with the sentence in the match color. Wrapped lines are joined before splitting,
               except at a blank line, next to brackets or ; (JSON, code), or before a line starting with
               - * + # > " or a digit (list, heading, quote, number). Scripts without spaces between words
               (Japanese, Chinese, Thai, Lao, Khmer, Myanmar, Tibetan) join without one. HOW:
                 jev (default): also ask Jev about unpunctuated breaks next to those scripts, where entries
                   often end without 。. One extra request per 30 lines that have such breaks
                 rules: the rules only, no extra requests
               The expression is evaluated per sentence. With -z each record is split on its own
               Sentences sent together (--chunk) read each other as context, so a verdict can shift with
               where the chunks fall, and a sentence next to a match can match too
  -o           with --sentence, print only the matching sentences, one per line; -n gives the line where the
               sentence starts, -c and -A/-B/-C count sentences
  -p           print each meaning's probability at the end of the line (for tuning thresholds)
  --dry-run    send nothing; print to stdout the endpoint, each file searched (units, and how many would be
               sent) and each request with its questions, grouped by wording (line ids read Lnnn).
               The --dedup and --sentence questions are answered no, so their counts are an estimate
  --verbose    print the same to stderr while searching, and the summary line even when not a terminal
  -i, --interactive  first show what --dry-run would send (files, lines, requests) and ask on the
               terminal; search only on y. Nothing is sent before the answer; no terminal is an error
  --dedup      judge one line per template instead of every line. Lines that differ only in ids, hashes,
               numbers, dates and times, paths and URLs share a template; one of them is sent and its answer
               is reused for the rest. Which of those may be folded depends on the meaning: a number decides
               "disk usage above 90%", a time decides "happened at night". Jev is asked first, one small
               request per meaning, and the kinds that could change a match are kept apart. Built for
               machine-generated logs, where it can cut the cost by a factor of 30 or more; prose has no
               shared skeleton and barely folds, and a meaning that reads a value folds little.
               With -z or --sentence the unit that folds is the record or the sentence
  --color[=WHEN] auto (default: color when stdout is a terminal) / always / never; bare --color means auto
               file and line number use grep's colors; with -p, probabilities are green at or above
               the positive threshold, red below the negative one, yellow in between. NO_COLOR is honored
  --sys1-model=ID, --sys1-url=URL, --sys1-api-key=KEY
               the API settings, overriding SEMGREP_MODEL, SEMGREP_URL, SEMGREP_API_KEY below.
               A key on the command line shows up in ps and shell history; prefer ~/.config/semgrep/.env
  -h, --help   this help (Japanese when LANG / LC_ALL / LC_MESSAGES starts with ja)
  -V, --version  print the version and exit

Exit status: 0 matched / 1 no match / 2 error

Environment (read from the environment, else from ~/.config/semgrep/.env; ./.env is never read):
  SEMGREP_API_KEY    API key. Falls back to TYPESAFE_API_KEY. Get one at https://console.typesafe.ai/
  SEMGREP_URL        endpoint (default https://api.typesafe.ai/v1/systemone). Any TypeSafe-compatible
                     /v1/systemone works, e.g. https://openrouter.ai/api/v1/systemone
  SEMGREP_MODEL      model id (default jev-latest)
  SEMGREP_OPTS       default options, split on spaces and put before the command line, which wins;
                     --no-X turns a boolean flag off (--color takes --color=never). Options only: no
                     meanings, files or --. e.g. SEMGREP_OPTS='--level strict -n'. Scripts: SEMGREP_OPTS= semgrep
  The key goes to SEMGREP_URL, whatever it is. With SEMGREP_URL set and no key, no auth header is sent.
  e.g.  mkdir -p ~/.config/semgrep && echo 'SEMGREP_API_KEY=your-key' > ~/.config/semgrep/.env`;
const HELP_JA = `usage: semgrep [OPTION]... -e MEANING|-Q QUESTION [-a MEANING] [-v MEANING]... [FILE...]
jev (TypeSafe System One) で意味的にマッチする行を探す grep。FILE 省略時は stdin。
git semgrep として呼ぶと git grep と同じく FILE は pathspec になり、追跡中のファイルを全部探す。

  -e MEANING   この意味に合う行 (複数指定は OR)
  -Q, --question QUESTION  QUESTION に答えている行 (尋ねている行ではない)。-e "the line answers: QUESTION"
               と同じ。「ジョブはなぜ失敗したか」は「ディスクが満杯だった」に一致し、「サーバが落ちているか」は
               否定の答えにも一致する。-e / -a / -v / ! とは -e と同じように組み合わせられる
  -a MEANING   直前の -e/-Q 項に AND で連結。-e A -a B -e C は (A and B) or C
  -v MEANING   直前の -e/-Q 項に AND NOT で連結。-e A -v B は A and not B
               先頭に置けば単独の否定。-v B は not B (grep -v 相当)
  !MEANING     -e / -Q / -a / -v のどこでも、先頭に ! を付けるとその意味だけ否定
               -e A -e '!B' は A or not B。-a '!C' は -v C と同じ
  /RE/FLAGS    正規表現項 (先頭と末尾が /、フラグは JS の dgimsuvy)。ローカルで判定しリクエストなし。
               同じ AND 項の絞り込みになり、これが当たった行だけその項の意味を尋ねる
                 -e '/ERROR|FATAL/'  -a '/timeout/i'  -v '/^DEBUG/'   !/RE/ は上と同じく否定
               名前付き・番号付きグループは同じ項の意味に $<name>, $1-$99, $&, $$ として渡る
               (ECMAScript の置換パターン)。$<name> が存在しないグループを指す、または否定した
               正規表現のグループを指すのはエラー。$<name> と単一引用符を推奨 ($1 は sh/bash/zsh
               のダブルクォート内で生き残らない)。/ で始まり / で終わる本物の意味は、正規表現と
               誤認されないよう先頭にスペースを置く
  --level=LEVEL 厳しさ。肯定と否定の閾値をまとめて決める (既定 normal)
                 loose  : -t 0.3 -T 0.7  多少あやしくても拾う
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  確信のある行だけ拾う
  -t THRESH    肯定条件の閾値。確率 >= THRESH で一致 (--level より優先)
  -T THRESH    否定条件の閾値。確率 < THRESH で「〜でない」と判定 (--level より優先)
               -t 0.6 -T 0.3 なら 0.3〜0.6 の曖昧な行はどちらにも当たらない
  -r           ディレクトリを再帰的に探す (FILE 省略時はカレント)。.git、node_modules、
               .ssh/.aws/.gnupg/.kube/.docker、バイナリ、秘密情報らしいファイル (.env*, .netrc, .npmrc,
               .git-credentials, *.pem, *.key, id_rsa*...) は飛ばす。git リポジトリの中では
               git が無視するもの (.gitignore) も飛ばす。コマンドラインで指定したファイル・ディレクトリは
               それでも探す。検索した行はすべて TypeSafe の API に送られる
  --include=GLOB, --exclude=GLOB  -r と git semgrep で、名前が GLOB (* ? [...]) に合うファイルだけ
               (または合わないものだけ) を探す。複数指定可。-r ではコマンドラインで指定したファイルは
               必ず探す。git semgrep の pathspec は他と同じく絞り込む。
               * は先頭のドットにも合う (*.md は .notes.md にも合う。rg --glob と同じ)
  --changed-within=WHEN  -r と git semgrep で、WHEN 以内に更新したファイルだけを探す。30m / 2h / 7d / 2w、
               日付か日時以降 (2026-09-01 はその日のローカル時刻 0 時、2026-09-01T09:00、...Z)、
               または today / this-week (月曜から) / this-month (ローカル時刻)。git の履歴ではなく mtime で見る
  --no-scope   意味の文面からファイルを絞り込まない。既定では -r と git semgrep で見つけたファイルを、
               言語・形式を指定する意味 (「Python で」「in Python」「YAML ファイル」) ならそのファイル
               (*.py *.pyi *.pyw) に、変更時期を指定する意味 (「昨日変えた」「changed last week」) ならそれ以降に
               変えたファイル (リポジトリでは、それ以降のコミットがあるか、未コミットでそれ以降に更新したもの)
               に絞る。作者と状態も git で絞る: 「自分が書いた」「Alice さんが書いた」「未コミットの」「ステージした」
               「未追跡の」「このブランチで」「未プッシュの」。必要条件になる言い方だけが対象で、「Python のような書き方」「Go に移植」
               「SQL のクエリ」(SQL は他の言語のコードの中にもある) は絞らない。置き場所も同じで、テストコード
               (「テストコードで」「in the tests」)、マイグレーション、README、CHANGELOG、文書 (「ドキュメントに」。
               *.md *.rst *.txt docs/)、コード (文書以外)、ログ (「ログファイルに」。*.log logs/) をパスの慣習で絞る。
               項ごとに効くので、-e A -e B は
               A が除いたファイルでも B を探す。絞り込みは semgrep: scope: ... として stderr に出す。
               コマンドラインで指定したファイルは絞らない
  -l           一致した行ではなくファイル名だけを表示
  -H, --with-filename  1 ファイルだけでも、各行 (と -c の件数) の前にファイル名を付ける
  --no-filename  複数ファイル・-r・git semgrep でもファイル名を付けない
  -A NUM       一致行の後ろ NUM 行も表示 (grep と同じ。文脈行の区切りは - )
  -B NUM       一致行の前 NUM 行も表示
  -C NUM       前後 NUM 行を表示 (-A NUM -B NUM)
  -c           一致した行数だけをファイルごとに表示 (grep -c 相当)
  -q, --quiet  何も表示せず、最初の一致で止まる。一致があればエラーがあっても終了コード 0 (grep -q 相当)
  --chunk=LINES 1 リクエストにまとめる行数 (既定 30)
               同じリクエストの行は互いの文脈になるので、小さくすると速さだけでなく曖昧な行の
               判定も変わる
  -j N         同時リクエスト数 (既定 8)
  -n           行番号を付ける
  -z, --null-data  判定の単位を行ではなく NUL 終端のレコードにする。1 レコードが複数行でもよい。
               一致したレコードも NUL 終端で出力する (grep -z と同じ)。ファイル名と件数は改行のまま。
               -n はレコード番号、-A/-B/-C は前後のレコード数、--chunk はレコード数を数える。
               レコードを出すツールとそのまま繋がる: git log -z、find -print0、xargs -0
                 git log -z --format='%h %s %b' | semgrep -z -e "ユーザーに見える振る舞いを変えている"
  --sentence[=HOW] 行ではなく文ごとに判定する。出力は当たった文がかかる元の行のままで、文の部分を色で
               強調する。文に分ける前に折り返した行をつなぐ。ただし空行、括弧や ; (JSON やコード)、
               - * + # > " や数字で始まる行 (箇条書き・見出し・引用・番号) の前ではつながない。単語の間に
               空白を置かない文字 (日本語・中国語・タイ語・ラオ語・クメール語・ミャンマー語・チベット語)
               は空白なしでつなぐ。HOW:
                 jev (既定): 上の文字に接する句点の無い改行を Jev にも聞く。句点で終わらない 1 行 1 件の
                   データをつながないため。そうした改行がある 30 行ごとにリクエストが 1 つ増える
                 rules: 規則だけで決める。追加のリクエストなし
               式は文ごとに評価する。-z ではレコードごとに文に分け、当たったレコードを出す
               一緒に送る文 (--chunk) は互いを文脈として読むので、区切りの位置で判定が変わることがあり、
               当たった文の隣の文もつられて当たることがある
  -o           --sentence と併用し、当たった文だけを 1 行ずつ出す。-n は文が始まる行、-c と
               -A/-B/-C は文の数で数える
  -p           各意味の確率を行末に表示 (閾値調整用)
  --dry-run    何も送らず、送信先・検索するファイル (単位の数と送る数)・各リクエストとその質問を stdout に
               表示する。質問は文面ごとにまとめて数える (行の ID は Lnnn と表示)。--dedup と --sentence の
               事前の問い合わせは no と答えたものとして数えるので、その場合の数は目安
  --verbose    同じ表示を検索しながら stderr に出す。端末でなくても最後の集計行を出す
  -i, --interactive  まず --dry-run と同じ内容 (ファイル・行数・リクエスト数) を見せて端末で聞き、
               y のときだけ検索する。答えるまで何も送らない。端末が無ければエラー
  --dedup      全行ではなくテンプレートごとに 1 行だけ判定する。ID・ハッシュ・数値・日付と時刻・パス・
               URL だけが違う行は同じテンプレートとみなし、代表 1 行を送ってその答えを残りにも使う。
               どれをまとめてよいかは意味による。「ディスク使用率が 90% を超えている」なら数値が、
               「夜間に起きた」なら時刻が答えを決める。そこで意味ごとに小さなリクエストを 1 つ送って
               Jev に聞き、答えを変えうる種類はまとめない。機械が吐くログ向けで、費用が 30 分の 1
               以下になることもある。散文には共通の骨格がないのでほとんど縮まず、値を読む意味もあまり
               縮まない。-z や --sentence ではレコードや文を単位にまとめる
  --color[=WHEN] 色付け。auto (端末なら付ける、既定) / always / never。=WHEN 省略時は auto
               ファイル名・行番号は grep と同じ配色。-p の確率は閾値以上を緑、
               否定側の閾値未満を赤、あいだを黄で表示。NO_COLOR にも従う
  --sys1-model=ID, --sys1-url=URL, --sys1-api-key=KEY
               API の設定。下の SEMGREP_MODEL / SEMGREP_URL / SEMGREP_API_KEY より優先。
               コマンドラインのキーは ps やシェル履歴に残るので、なるべく ~/.config/semgrep/.env に書く
  -h, --help   このヘルプ (LANG / LC_ALL / LC_MESSAGES が ja 以外なら英語)
  -V, --version  バージョンを表示して終了

終了コード: 一致あり 0 / なし 1 / エラー 2 (引数・読めないファイル・API 障害)

環境変数 (環境、無ければ ~/.config/semgrep/.env から読む。./.env は読まない):
  SEMGREP_API_KEY    API キー。無ければ TYPESAFE_API_KEY。取得は https://console.typesafe.ai/
  SEMGREP_URL        送信先 (既定 https://api.typesafe.ai/v1/systemone)。TypeSafe 互換の
                     /v1/systemone なら可。例 https://openrouter.ai/api/v1/systemone
  SEMGREP_MODEL      モデル名 (既定 jev-latest)
  SEMGREP_OPTS       既定のオプション。空白で区切ってコマンドラインの前に置くので、コマンドラインが
                     優先する。--no-X で真偽のフラグを消せる (--color は --color=never)。書けるのは
                     オプションだけで、意味・ファイル・-- は書けない。例 SEMGREP_OPTS='--level strict -n'。
                     スクリプトからは SEMGREP_OPTS= semgrep と空にして呼ぶ
  キーは SEMGREP_URL の先へそのまま送られる。SEMGREP_URL 指定時にキーが無ければ認証ヘッダを付けない。
  例:  mkdir -p ~/.config/semgrep && echo 'SEMGREP_API_KEY=your-key' > ~/.config/semgrep/.env`;
if (opt.version) {
  console.log(`semgrep ${JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version}`);
  process.exit(0);
}
if (opt.help) {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  console.log(locale.startsWith('ja') ? HELP_JA : HELP_EN);
  process.exit(0);
}

const customUrl = opt['sys1-url'] || SEMGREP_URL;
const apiUrl = customUrl || 'https://api.typesafe.ai/v1/systemone';
const apiHost = (() => { try { return new URL(apiUrl).host; } catch { die(`not a URL: ${apiUrl} (--sys1-url / SEMGREP_URL)`); } })();
const model = opt['sys1-model'] || SEMGREP_MODEL || 'jev-latest';
const credential = opt['sys1-api-key'] || SEMGREP_API_KEY || TYPESAFE_API_KEY;
if (credential && new URL(apiUrl).protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(apiHost))
  console.error(`semgrep: warning: the API key goes to ${apiHost} over plain http`);
// --dry-run prints the files and the requests that would be sent, to stdout, and sends nothing. --verbose prints
// the same to stderr while searching. -q's early exits would cut the list short, so --dry-run turns -q off.
const dry = opt['dry-run'];
if (dry) opt.quiet = false;
// File names and file contents come from whatever is searched, maybe an untrusted checkout: the lines about them
// show control characters as \xNN, so an escape sequence cannot redraw what -i asks about.
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const trace = dry ? s => console.log(`semgrep: ${safe(s)}`) : opt.verbose ? s => console.error(`semgrep: ${safe(s)}`) : null;
trace?.(`endpoint ${apiHost}${new URL(apiUrl).pathname}, model ${model}`);

// Expression: a list of AND terms joined by OR. Each literal is a meaning { kind:'m', text, not } or a
// regex { kind:'r', re, names, count, not }, matched locally. A leading ! negates just that literal.
// /pattern/flags (first and last char /, JS flags) is a regex term; anything else is a meaning.
const RE_SHAPE = /^\/(.*)\/([dgimsuvy]*)$/s;
function compileRegex(pattern, flags) {
  let re, probe;
  try { re = new RegExp(pattern, flags); probe = new RegExp(`${pattern}|`, flags).exec(''); }
  catch (e) { die(`invalid regex '/${pattern}/${flags}': ${e.message}`, false); } // one line, like grep: the pattern is the problem, not the usage
  return { re, names: new Set(Object.keys(probe.groups ?? {})), count: probe.length - 1 };
}
const expr = [];
for (const tk of tokens) {
  if (tk.kind !== 'option' || !['e', 'a', 'v', 'question'].includes(tk.name)) continue;
  if (tk.name === 'a' && expr.length === 0) die('-a needs a preceding -e');
  const bang = tk.value.startsWith('!'); // per-literal negation: "!MEANING" / "!/re/"
  const bare = bang ? tk.value.slice(1) : tk.value;
  if (!bare.trim()) die(`${tk.name.length > 1 ? '--' : '-'}${tk.name}: MEANING must not be empty`);
  const not = bang !== (tk.name === 'v');
  const shape = tk.name !== 'question' && RE_SHAPE.exec(bare); // -Q is always a question, never a regex
  const lit = shape ? { kind: 'r', not, ...compileRegex(shape[1], shape[2]) }
    : { kind: 'm', not, text: tk.name === 'question' ? `the line answers: ${bare}` : bare };
  if (tk.name === 'e' || tk.name === 'question' || expr.length === 0) expr.push([lit]);
  else expr.at(-1).push(lit);
}
if (!expr.length) die('no -e MEANING or -Q QUESTION given');
// Captures: $<name>, $1-$99, $&, $$ (ECMAScript's GetSubstitution), scoped to one AND term's non-negated
// regexes. Deviation from ECMAScript: $<name> naming no group is an error, not an empty string. A group of
// a negated regex can't be referenced either. $n naming no group stays literal, as in ECMAScript.
const SUBST = /\$(?:(\$)|(&)|<([^>]*)>|(\d{1,2}))/g;
const numRef = (num, count) => (num.length === 2 && +num >= 1 && +num <= count ? +num : +num[0] >= 1 && +num[0] <= count ? +num[0] : 0);
for (const term of expr) {
  const posNames = new Set(), negNames = new Set();
  let posCount = 0, negCount = 0;
  for (const lit of term) if (lit.kind === 'r') {
    for (const n of lit.names) (lit.not ? negNames : posNames).add(n);
    if (lit.not) negCount += lit.count; else posCount += lit.count;
  }
  for (const lit of term) if (lit.kind === 'm') for (const m of lit.text.matchAll(SUBST)) {
    const [all, , , name, num] = m;
    // $n resolves as in expandCaptures: two digits if in range, else the first digit. Naming only a negated group is an error.
    if (num) { if (!numRef(num, posCount) && numRef(num, negCount)) die(`${all}: refers to a negated regex's group`); continue; }
    if (name === undefined || posNames.has(name)) continue;
    die(negNames.has(name) ? `$<${name}>: refers to a negated regex's group` : `$<${name}>: no such capture group`);
  }
}
const hasMeanings = expr.some(term => term.some(lit => lit.kind === 'm'));
// A compatible local server may need no key; the TypeSafe default always does. Regex-only queries never call the API.
// --sentence=jev asks Jev where wrapped lines join; with regex terms only, nothing else is sent, so the rules decide.
if (opt.sentence === 'jev' && !hasMeanings) opt.sentence = 'rules';
if (hasMeanings && !credential && !customUrl) die('SEMGREP_API_KEY is not set. Export it or put it in ~/.config/semgrep/.env');

const levels = { loose: [0.3, 0.7], normal: [0.5, 0.5], strict: [0.7, 0.3] };
const level = levels[opt.level];
if (!level) die(`--level must be one of ${Object.keys(levels).join(', ')}`);
const tPos = opt.t === undefined ? level[0] : Number(opt.t);
const tNeg = opt.T === undefined ? level[1] : Number(opt.T);
const chunkLines = Number(opt.chunk);
// Validate numeric options. parseArgs turns -C=10 into the value "=10", so reject that here.
for (const [k, label] of [['t', '-t'], ['T', '-T'], ['chunk', '--chunk'], ['j', '-j'], ['A', '-A'], ['B', '-B'], ['C', '-C']])
  if (opt[k] !== undefined && !(k === 't' || k === 'T' ? /^\d+(\.\d+)?$/ : /^\d+$/).test(opt[k])) die(`${label}: invalid number '${opt[k]}' (write ${label} 10 or ${label}10, not ${label}=10)`);
if (chunkLines < 1) die('--chunk must be at least 1');
if (tPos < 0 || tPos > 1 || tNeg < 0 || tNeg > 1) die('-t / -T must be between 0 and 1');
if (Number(opt.j) < 1) die('-j must be at least 1');
if (opt.sentence !== undefined && !['jev', 'rules'].includes(opt.sentence)) die('--sentence must be jev or rules');
if (!['auto', 'always', 'never'].includes(opt.color)) die('--color must be auto, always or never');
// --include / --exclude: shell globs (* ? [...] [!...]) matched against the file name, as in grep.
// * also matches a leading dot, as in rg --glob (not as in the shell).
const globRe = o => g => {
  try { return new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`); }
  catch { die(`--${o}: '${g}' is not a valid glob (an unclosed [ ?)`); }
};
const includes = (opt.include ?? []).map(globRe('include')), excludes = (opt.exclude ?? []).map(globRe('exclude'));
for (const [o, gs] of [['include', opt.include], ['exclude', opt.exclude]]) for (const g of gs ?? [])
  if (g.includes('/')) console.error(`semgrep: warning: --${o}='${g}' has a /, but globs match the file name only, not the path, so it matches no file`);
// --changed-within: a duration back from now, a date or ISO date-time, or today / this-week / this-month (local).
// Only these forms: Date() alone reads '7' as the year 2001, which would select every file. A bare date is local
// midnight (Date() would read it as UTC).
const since = (w => {
  if (w === undefined) return null;
  const d = w.match(/^(\d+)([mhdw])$/);
  if (d) return Date.now() - d[1] * { m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[d[2]];
  const now = new Date(), day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (w === 'today') return day.getTime();
  if (w === 'this-week') return day.setDate(day.getDate() - (day.getDay() + 6) % 7); // back to Monday
  if (w === 'this-month') return day.setDate(1);
  let t = /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/.test(w) ? new Date(w.length === 10 ? `${w}T00:00` : w).getTime() : NaN;
  // Date() rolls 2026-02-30 over to March 2 instead of failing: the day must exist in its month.
  const [y, mo, dd] = w.slice(0, 10).split('-').map(Number), u = new Date(Date.UTC(y, mo - 1, dd));
  if (u.getUTCFullYear() !== y || u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== dd) t = NaN;
  if (isNaN(t)) die(`--changed-within: '${w}' is not a duration (30m, 2h, 7d, 2w), a date (2026-09-01, 2026-09-01T09:00), today, this-week or this-month`);
  if (t > Date.now()) console.error(`semgrep: warning: --changed-within=${w} is in the future, so no file found by -r or git semgrep is new enough`);
  return t;
})(opt['changed-within']);
const wanted = (path, st) => {
  const name = path.split('/').at(-1);
  return (!includes.length || includes.some(re => re.test(name))) && !excludes.some(re => re.test(name)) && (since === null || st.mtimeMs >= since);
};

// Auto-scope (#43): a meaning that says when its file changed, or what language or format the file is in, can only
// match in such files, so the files -r and git semgrep find are narrowed before anything is sent. Only wording that
// makes it a necessary condition counts ("in Python", "Python で", "Python files"; not "Python のような書き方" or "port
// it to Python"): a wrong scope loses matches without a trace. Each scope is a literal of its meaning's AND term, so
// -e A -e B still searches B in the files A's scope leaves out. Files named on the command line and stdin are never
// narrowed, as with --include. --no-scope turns it off.
// Extensions and file names after GitHub Linguist's languages.yml (MIT), cut down to common languages and formats.
const LANGS = [ // [name pattern, globs, embedded]; a name that already says file or script needs no anchor around it.
  // An embedded format often sits inside another language's code (SQL in strings, HTML in templates and JSX), so it
  // scopes only when it names the file: "SQL ファイル", "HTML files", not "SQL のクエリ".
  ['python|パイソン', '*.py *.pyi *.pyw'],
  ['javascript|js|node\\.?js|ジャバスクリプト', '*.js *.mjs *.cjs *.jsx'],
  ['typescript|ts|タイプスクリプト', '*.ts *.mts *.cts *.tsx'],
  ['go|golang|ゴー', '*.go'],
  ['rust', '*.rs'],
  ['java|ジャバ', '*.java'],
  ['kotlin|コトリン', '*.kt *.kts'],
  ['ruby|ルビー', '*.rb *.rake Gemfile Rakefile'],
  ['php', '*.php'],
  ['c', '*.c *.h'],
  ['c\\+\\+|cpp', '*.cpp *.cc *.cxx *.hpp *.hh *.hxx *.h'],
  ['c#|csharp', '*.cs'],
  ['swift', '*.swift'],
  ['scala', '*.scala *.sc'],
  ['r', '*.r *.R *.Rmd'],
  ['(?:shell|bash|sh|zsh) ?scripts?|(?:シェル|bash|sh|zsh) ?スクリプト', '*.sh *.bash *.zsh'], // not "シェルで実行": code that runs a shell
  ['sql', '*.sql', true],
  ['html', '*.html *.htm', true],
  ['css', '*.css *.scss *.sass *.less', true],
  ['markdown|md|マークダウン', '*.md *.markdown *.mdx'],
  ['yaml|yml', '*.yaml *.yml'],
  ['json', '*.json *.jsonc *.json5 *.jsonl *.ndjson', true],
  ['toml', '*.toml'],
  ['xml', '*.xml', true],
  ['dockerfiles?', 'Dockerfile Dockerfile.* *.dockerfile Containerfile'],
  ['makefiles?', 'Makefile makefile GNUmakefile *.mk'],
];
// Around the name: "in [the|our|my] X" before it, or after it (言語 allowed in between) で (not でも / でない), の plus a
// word for a file or its code, or a word for a file. The name is not part of a word, a hyphenated one ("non-Python",
// "Go-style") included, and not after not / except / other than or like / as.
const LANG_BEFORE = String.raw`(?<!(?:not|except|than|like|as|besides|of)\s+)\b(?:in|written in)\s+(?:the\s+|our\s+|my\s+|a\s+)?`;
const LANG_AFTER = String.raw`(?:\s*言語)?\s*(?:で(?![もな]|はな)|の(?:コード|ファイル|スクリプト|ソース|実装|プログラム|中|なか|記述|設定|文書|ドキュメント|定義|クラス|メソッド|テスト)|(?:コード|ファイル|スクリプト|ソース|プログラム)|\s(?:source\s+)?(?:code|files?|scripts?|sources?|programs?|codebase|services?|projects?|configs?|configuration|documents?|docs|implementations?)\b)`;
const FILE_AFTER = String.raw`\s*(?:の?ファイル|\sfiles?\b)`;
// "Rust or Kotlin implementations", "JavaScript か TypeScript で", "in Go and Rust": the anchor covers every name in the list.
const ANY = String.raw`(?<![\w+#.-])(?:${LANGS.map(([name]) => name).join('|')})(?![\w+#-]|'s)(?:\s*言語)?`;
const AND = String.raw`\s*(?:,|、|/|・|\bor\b|\band\b|か|や|と)\s*`;
const langRes = LANGS.map(([name, globs, embedded]) => {
  const n = String.raw`(?<![\w+#.-])(?:${name})(?![\w+#-]|'s)`;
  const re = /scripts?|スクリプト|files\?/.test(name) ? n : embedded ? `${n}(?:${AND}${ANY})*(?=${FILE_AFTER})`
    : `${LANG_BEFORE}(?:${ANY}${AND})*${n}|${n}(?:${AND}${ANY})*(?=${LANG_AFTER})`;
  return [new RegExp(re, 'i'), globs.split(' ')];
});
const EXT_RE = /(?<![\w.])\*?\.([a-z0-9]{1,10})(?=\s*(?:ファイル|files?\b|で|の中))/gi; // ".py ファイル", "*.go files"
function langScope(text) {
  const words = [], globs = new Set();
  for (const [re, gs] of langRes) { const m = re.exec(text); if (m) { words.push(m[0].trim()); gs.forEach(g => globs.add(g)); } }
  for (const [w, ext] of text.matchAll(EXT_RE)) {
    words.push(w);
    (langRes.find(([, gs]) => gs.includes(`*.${ext}`))?.[1] ?? [`*.${ext}`]).forEach(g => globs.add(g));
  }
  if (!globs.size) return null;
  const res = [...globs].map(globRe('scope'));
  return { label: [...globs].join(' '), words, test: f => res.some(re => re.test(f.split('/').at(-1))) };
}
// Path role (#48): where a kind of file lives, by the conventions of JS, Python, Go, Java, Ruby, Rust and PHP. The
// phrase must say the match is in such a file ("テストコードで", "in the tests", "README に"), not that the code
// does something with one ("テストしている", "README を生成する"), and not that it may be there too ("テストでも",
// "README にも"). Several roles in one meaning are alternatives
// ("README か CHANGELOG に"). Each pattern is tested on the path; a directory in it that only looks like a role
// ("/home/me/tests/proj/") admits more files, never fewer.
const DOC_EXT = String.raw`\.(?:md|markdown|mdx|rst|adoc|asciidoc|txt|org|tex|textile)$`;
const ROLES = [ // [name, phrase, path pattern, what the path pattern is (for the report), bare noun]
  // Rust keeps unit tests in the file they test (#[cfg(test)]), so every *.rs is a test file too.
  ['test', /テスト(?:コード|ファイル|ケース|スイート)|テスト(?:で(?![きもな]|はな)|の中|内で(?![きもな]|はな))|\b(?:in|within|inside)\s+(?:the\s+|our\s+|my\s+)?(?:unit\s+|integration\s+|e2e\s+)?tests\b|\btest\s+(?:code|files?|suites?|cases?)\b|\bspec\s+files?\b/i,
    /(?:^|\/)(?:tests?|__tests__|specs?|testing|e2e)\/|(?:^|\/)test_[^/]*\.py$|_test\.\w+$|\.(?:test|spec)\.\w+$|Tests?\.(?:java|kt|cs|php|swift)$|_spec\.rb$|(?:^|\/)conftest\.py$|\.rs$/,
    'tests/ test/ __tests__/ spec/ e2e/ test_*.py *_test.* *.test.* *.spec.* *Test.java *_spec.rb *.rs', /テスト|tests?/i],
  ['migration', /マイグレーション(?:ファイル|スクリプト|で|の中|のコード)|\bmigrations?\s+(?:files?|scripts?|code)\b|\bin\s+(?:the\s+|our\s+)?(?:db\s+|database\s+)?migrations\b/i,
    /migrat|(?:^|\/)V\d+(?:_\d+)*__[^/]*\.sql$/i, '*migrat* V*__*.sql', /マイグレーション|migrations?/i],
  ['readme', /README\s*(?:に(?!も)|で(?![きもな]|はな)|の中|の記述|の(?!生成|作成))|\bthe\s+README\s+(?:says?|mentions?|explains?|describes?|file)\b|\bin\s+(?:the\s+|our\s+)?README\b|\bREADME\s+files?\b/i,
    /(?:^|\/)README[^/]*$/i, 'README*', /README/i],
  ['changelog', /(?:CHANGELOG|変更履歴|更新履歴)\s*(?:に(?!も)|で(?![きもな]|はな)|の中|の記述|の(?!生成|作成))|\bin\s+(?:the\s+|our\s+)?changelog\b|\bchangelog\s+(?:entr(?:y|ies)|files?|says|mentions)\b/i,
    /(?:^|\/)(?:CHANGELOG|CHANGES|HISTORY|NEWS)[^/]*$/i, 'CHANGELOG* CHANGES* HISTORY* NEWS*', /CHANGELOG|変更履歴|更新履歴/i],
  ['docs', /(?:ドキュメント|文書|仕様書|設計書|マニュアル)\s*(?:に(?!も)|で(?![きもな]|はな)|の中)|\bin\s+(?:the\s+|our\s+)?(?:docs|documentation|documents|specs?|specifications?|manuals?)\b|\b(?:the\s+)?documentation\s+(?:says|mentions)\b/i,
    new RegExp(`${DOC_EXT}|(?:^|/)(?:docs?|documentation|manual)/`, 'i'), '*.md *.rst *.adoc *.txt ... docs/ doc/', /ドキュメント|文書|仕様書|設計書|マニュアル|docs|documentation/i],
  // Code is what is not a document: a dictionary of languages would lose the ones it lacks.
  ['code', /(?:実装|ソースコード|コード)\s*(?:の中|内で(?![きもな]|はな))|実装で(?![きもな]|はな)|\bin\s+(?:the\s+|our\s+)?(?:code|codebase|source(?:\s+code)?|implementation)\b/i,
    new RegExp(`^(?!.*(?:${DOC_EXT}|(?:^|/)(?:docs?|documentation)/))`, 'i'), 'not *.md *.rst *.adoc *.txt ... docs/ doc/', /実装|コード|code/i],
  ['log', /ログファイル|ログ(?:に(?:出て|残って|記録され|出力され)|の中[でに])|\bin\s+(?:the\s+|our\s+)?logs?\b(?!\s+(?:message|call|statement|level)s?\b)|\blog\s+files?\b/i,
    /\.(?:log|out|err)(?:\.\d+)?$|(?:^|\/)(?:logs?|var\/log)\//i, '*.log *.log.N *.out *.err logs/ log/', /ログ|logs?/i],
];
// "README か CHANGELOG に", "in the docs or the README": a bare noun listed next to a matched phrase shares it.
const AND_WORD = String.raw`\s*(?:,|、|/|・|\bor\b|\band\b|か|や|と|または|もしくは)\s*(?:the\s+|our\s+)?`;
function roleScope(text) {
  const hit = ROLES.map(([name, phrase, path, what]) => [name, phrase.exec(text), path, what]).filter(r => r[1]);
  if (!hit.length) return null;
  let lo = Math.min(...hit.map(r => r[1].index)), hi = Math.max(...hit.map(r => r[1].index + r[1][0].length));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, , path, what, noun] of ROLES) {
      if (hit.some(r => r[0] === name)) continue;
      const before = [...text.slice(0, lo).matchAll(new RegExp(`(?:${noun.source})${AND_WORD}$`, 'gi'))][0];
      const after = new RegExp(`^${AND_WORD}(?:${noun.source})`, 'i').exec(text.slice(hi));
      if (before) { hit.push([name, before, path, what]); lo = before.index; grew = true; }
      else if (after) { hit.push([name, after, path, what]); hi += after[0].length; grew = true; }
    }
  }
  // "in the tests and fixtures": something else listed with them may live anywhere, so no scope
  if (/^\s*(?:\/|\bor\b|\band\b|か|や|と|または|もしくは)\s*(?:the\s+|our\s+)?[\p{L}\p{N}]/iu.test(text.slice(hi))
    || /[\p{L}\p{N}]\s*(?:\/|\bor\b|\band\b|か|や|と|または|もしくは)\s*(?:the\s+|our\s+)?$/iu.test(text.slice(0, lo).replace(/\b(?:in|within|inside)\s*$/i, ''))) return null;
  return { label: hit.map(([name, , , what]) => `${name} files: ${what}`).join(' | '), words: hit.map(r => r[1][0].trim()), test: f => hit.some(([, , path]) => path.test(f)) };
}
// git (#46): inside a repository, git says which files changed since a time, who wrote them and what is uncommitted,
// staged, untracked, changed on this branch or not pushed. One git process per repository and question, over the
// whole tree: `git log -1 -- FILE` per file took 50 ms a file on a 6,400-file repository (5 minutes), `git log
// --since` over the tree 15 ms. Files, not lines: `git blame` took 93 ms a file, and which lines changed is #49.
// Outside a repository, without git, or when git fails, a git scope admits every file (a time falls back to the mtime).
const repoOf = (memo => function repo(dir) {
  if (!memo.has(dir)) memo.set(dir, existsSync(`${dir}/.git`) ? dir : dirname(dir) === dir ? null : repo(dirname(dir)));
  return memo.get(dir);
})(new Map());
const gitMemo = new Map(); // repository + args -> Set of absolute paths, or null when git failed
function gitPaths(top, ...args) {
  const key = [top, ...args].join('\0');
  if (!gitMemo.has(key)) {
    let paths = null;
    try { paths = new Set(execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] }).split(/[\0\n]/).filter(Boolean).map(p => resolve(top, p))); } catch {}
    gitMemo.set(key, paths);
  }
  return gitMemo.get(key);
}
const gitOut = (top, ...args) => { try { return execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const union = (...sets) => (sets.some(x => !x) ? null : new Set(sets.flatMap(x => [...x])));
const untracked = top => gitPaths(top, 'ls-files', '-z', '--others', '--exclude-standard');
const uncommitted = top => union(gitPaths(top, 'diff', '--name-only', '-z', 'HEAD'), untracked(top)); // worktree and index against HEAD
// The branch's own changes: from where it left the default branch (origin/HEAD, else main or master) to the worktree.
function branchChanges(top) {
  const base = [gitOut(top, 'rev-parse', '--abbrev-ref', 'origin/HEAD'), 'main', 'master', 'origin/main', 'origin/master'].find(b => b && gitOut(top, 'rev-parse', '--verify', '-q', b));
  const fork = base && gitOut(top, 'merge-base', 'HEAD', base);
  if (!fork || fork === gitOut(top, 'rev-parse', 'HEAD')) return null; // on the default branch itself: no branch of its own
  return union(gitPaths(top, 'diff', '--name-only', '-z', fork), untracked(top));
}
// Commits not on the upstream; without one, commits on no remote branch.
const unpushed = top => gitPaths(top, 'log', '--format=', '--name-only', '-z', '@{upstream}..HEAD') ?? gitPaths(top, 'log', '--format=', '--name-only', '-z', 'HEAD', '--not', '--remotes');
// Author: every file a commit of theirs touched, by git's --author (a regex on "Name <email>", mailmap applied, any
// case). An author with no commit at all (「田中さん」 against romanized names) gives no scope rather than no files.
// ponytail: a file renamed after they wrote it is missed; `git log --follow` per file if that matters.
function byAuthor(top, who) {
  const me = who === null, pat = me ? gitOut(top, 'config', 'user.email') || gitOut(top, 'config', 'user.name') : who;
  if (!pat) return null;
  const files = gitPaths(top, 'log', '--use-mailmap', '-i', `--author=${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, '--format=', '--name-only', '-z');
  return !files?.size ? null : me ? union(files, uncommitted(top)) : files;
}
const GIT_STATES = [ // [name, phrase, files of a repository]
  ['uncommitted', /未コミット|コミット(?:して|され)(?:い)?ない|作業中の(?:変更|ファイル)|\buncommitted\b|\bworking(?:\s+tree)?\s+changes\b|\bnot\s+(?:yet\s+)?committed\b/i, uncommitted],
  ['staged', /ステージ(?:した|済み|され|ング)|インデックスに(?:入れ|追加)|\bstaged\b/i, top => gitPaths(top, 'diff', '--name-only', '-z', '--cached')],
  ['untracked', /未追跡|(?:git|ギット)\s*に(?:まだ)?(?:入れて|追加して|add\s*して)(?:い)?ない|まだ\s*(?:git\s*)?add\s*して(?:い)?ない|\buntracked\b|\bnot\s+(?:yet\s+)?(?:added\s+to|tracked\s+by|in)\s+git\b/i, untracked],
  ['branch', /(?:この|今の|現在の)ブランチで|\b(?:on|in)\s+(?:this|the\s+current|my)\s+branch\b|\bthis\s+branch's\b/i, branchChanges],
  ['unpushed', /未プッシュ|(?:プッシュ|push)して(?:い)?ない|\bunpushed\b|\bnot\s+(?:yet\s+)?pushed\b/i, unpushed],
];
const AUTHOR = [ // -> the author named, or '' for me
  [/([\p{Script=Han}\p{Script=Katakana}ー\w.-]{1,20})\s?(?:さん|氏|くん|君)が[^、。]{0,6}?(?:書|作|実装|入れ|追加|変更|変え|修正|コミット)/u, m => m[1]],
  [/(?:自分|私|僕|俺|わたし)(?:が[^、。]{0,6}?(?:書|作|実装|入れ|追加|変え|変更|修正|コミット)|の(?:コミット|変更))/, () => ''],
  [/\b(?:written|authored|added|committed|changed|touched|made|introduced)\s+by\s+(me|myself|[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?)/, m => (/^(me|myself)$/.test(m[1]) ? '' : m[1])],
  [/\bI\s+(?:wrote|added|committed|changed|touched|authored|introduced)\b|\bmy\s+(?:own\s+)?commits\b/i, () => ''],
];
// A git scope admits a file when its repository's set holds it; no repository or no answer from git admits it.
const inGit = files => f => { const abs = resolve(f), top = repoOf(dirname(abs)), set = top && files(top); return !set || set.has(abs); };
function gitScopes(text) {
  const out = GIT_STATES.map(([name, phrase, files]) => { const m = phrase.exec(text); return m && { label: `git-${name} files`, words: [m[0]], test: inGit(files) }; });
  for (const [re, who] of AUTHOR) {
    const m = re.exec(text);
    if (!m) continue;
    // "Alice さんが書いたような", "like code written by Alice": a likeness says nothing about who wrote the file
    if (/^\p{Script=Hiragana}{0,3}(?:よう|みたい|風|っぽ)/u.test(text.slice(m.index + m[0].length))
      || /\b(?:like|style\s+of|similar\s+to)\s+(?:\S+\s+){0,3}$/i.test(text.slice(0, m.index))) break;
    const name = who(m);
    out.push({ label: `git-author files: by ${name || 'me (user.email)'}`, words: [m[0]], test: inGit(top => byAuthor(top, name || null)) });
    break;
  }
  return out.filter(Boolean);
}
// Time: a date or span next to a verb of change ("昨日変えた", "先週追加した", "changed yesterday", "last week's
// commits"), so a date the line itself talks about ("9月20日のリリース", "logs from yesterday") is not taken. Resolved
// in local time to [from, to). A file changed in it was modified at or after from; the mtime cannot say more, since
// a later change moves it. In a repository a committed file needs a commit at or after from instead: a checkout
// sets every mtime to now, and a commit comes after the edit it records. The committer date, as git log --since
// reads it: a rebase or cherry-pick moves it later, never earlier. No upper bound either: "yesterday's change"
// may be committed today. Uncommitted files go by their mtime. "Before" / "until" and 最近 / recently give no scope.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const UNIT_MS = { 分: 6e4, minute: 6e4, 時間: 36e5, hour: 36e5, 日: 864e5, day: 864e5, 週: 6048e5, 週間: 6048e5, week: 6048e5, か月: 2592e6, month: 2592e6 };
const TIME_WORDS = [ // [pattern, (match, midnight today) -> [from, to]]; the first pattern that matches wins
  [/一昨日|おととい|the day before yesterday/i, (m, d) => [d - 2 * 864e5, d - 864e5]],
  [/昨日|きのう|yesterday/i, (m, d) => [d - 864e5, d]],
  [/今日|本日|きょう|今朝|today|this morning/i, (m, d) => [d, d + 864e5]],
  [/(先々週|先週|今週|last week|this week)/i, (m, d) => {
    const mon = d - ((new Date(d).getDay() + 6) % 7) * 864e5, back = { 先々週: 2, 先週: 1, 'last week': 1 }[m[1].toLowerCase()] ?? 0;
    return [mon - back * 6048e5, mon - (back - 1) * 6048e5];
  }],
  [/(先月|今月|last month|this month)/i, (m, d) => { const t = new Date(d), back = /先|last/i.test(m[1]) ? 1 : 0; return [new Date(t.getFullYear(), t.getMonth() - back, 1).getTime(), new Date(t.getFullYear(), t.getMonth() - back + 1, 1).getTime()]; }],
  [/(去年|昨年|今年|last year|this year)/i, (m, d) => { const y = new Date(d).getFullYear() - (/今|this/i.test(m[1]) ? 0 : 1); return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()]; }],
  [/(?:ここ|過去|直近)\s*(\d+)\s*(分|時間|日|週間?|か月|ヶ月|カ月|ヵ月)|(\d+)\s*(分|時間|日|週間?|か月|ヶ月|カ月|ヵ月)\s*(?:以内|の間)|(?:last|past|within)\s+(?:the\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minute|hour|day|week|month)s?/i,
    m => { const n = m[1] ?? m[3] ?? m[5], u = (m[2] ?? m[4] ?? m[6]).replace(/[ヶカヵ]月/, 'か月').toLowerCase(); return [Date.now() - (NUMS[n.toLowerCase()] ?? +n) * UNIT_MS[u], Infinity]; }],
  [/(\d+)\s*日前|(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago/i, (m, d) => { const n = m[1] ?? m[2]; return [d - (NUMS[n.toLowerCase()] ?? +n) * 864e5, Infinity]; }],
  // A date, or a month; with 以降 / から / since / after it opens to now. Without a year it is the latest one not in the future.
  [new RegExp(String.raw`(?:(?:since|after|from)\s+)?(?:(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?![-/\d])|(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?|(?:in\s+)?\b(${MONTHS.join('|')})[a-z]*\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b)?(?:,?\s+(\d{4}))?)(\s*(?:以降|から|より後))?`, 'i'),
    (m, d) => {
      const y = +(m[1] ?? m[4] ?? m[9] ?? 0), mo = +(m[2] ?? m[5] ?? MONTHS.indexOf(m[7]?.slice(0, 3).toLowerCase()) + 1) - 1, day = +(m[3] ?? m[6] ?? m[8] ?? 0);
      const at = yy => day ? [new Date(yy, mo, day).getTime(), new Date(yy, mo, day + 1).getTime()] : [new Date(yy, mo, 1).getTime(), new Date(yy, mo + 1, 1).getTime()];
      let r = at(y || new Date(d).getFullYear());
      if (!y && r[0] > Date.now()) r = at(new Date(d).getFullYear() - 1);
      return /^(since|after|from)/i.test(m[0]) || m[10] ? [r[0], Infinity] : r;
    }],
];
const CHANGE_JA = '(?:変え|変わ|変更|修正|直し|直さ|追加|足し|足さ|書い|書か|書き(?:直|換|替|足|加)|編集|更新|コミット|入れ|入っ|いじ|触っ|改修|リファクタ|削除|消し|消さ|作っ|作ら|作成|マージ|プッシュ)';
const CHANGE_EN = String.raw`\b(?:chang|modif|edit|add|touch|commit|writ|wrote|updat|fix|refactor|introduc|remov|delet|creat|merg|push)\w*`;
function timeScope(text) {
  for (const [re, span] of TIME_WORDS) {
    const m = re.exec(text);
    if (!m) continue;
    const t = m[0].trim(), before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
    // before / until: the mtime is the last change, so a file changed before a date may have changed since
    if (/(以前|まで|より前)/.test(after.slice(0, 4)) || /\b(before|until|prior to)\s*$/i.test(before)) return null;
    const near = new RegExp(`^[^、。,.!?]{0,8}?${CHANGE_JA}`).test(after) || new RegExp(`^(?:'s)?\\s+(?:changes|commits|edits)\\b`, 'i').test(after)
      || new RegExp(`${CHANGE_EN}(?:\\s+\\S+){0,3}?\\s+$`, 'i').test(before);
    if (!near) return null;
    const [from] = span(m, new Date().setHours(0, 0, 0, 0));
    const fmt = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 6e4).toISOString().slice(0, 16).replace('T', ' ');
    const since = top => gitPaths(top, 'log', `--since=${new Date(from).toISOString()}`, '--format=', '--name-only', '-z');
    return { label: `changed since ${fmt(from)} (git commits; the mtime for files git does not have committed)`, words: [t], test: (f, st) => {
      const abs = resolve(f), top = repoOf(dirname(abs)), committed = top && since(top), open = top && uncommitted(top);
      return !committed || !open ? st.mtimeMs >= from : committed.has(abs) || (open.has(abs) && st.mtimeMs >= from);
    } };
  }
  return null;
}
// Each scope goes into its meaning's AND term as { kind: 's', label, words, test(file, stat) }; negated meanings say
// what a line is not, which says nothing about its file.
const named = f => f === '-' || (!asGit && files.includes(f)); // stdin, or named on the command line: never narrowed
if (opt.scope) for (const term of expr) for (const lit of term.filter(l => l.kind === 'm' && !l.not))
  for (const sc of [langScope(lit.text), roleScope(lit.text), timeScope(lit.text), ...gitScopes(lit.text)]) if (sc) {
    const seen = new Map(); // file -> admitted
    term.push({ kind: 's', ...sc, admits: f => named(f) || (seen.has(f) ? seen.get(f) : seen.set(f, sc.test(f, statSync(f))).get(f)) });
  }
const admitted = (term, file) => term.every(lit => lit.kind !== 's' || lit.admits(file));

// The unit of judgement. Without -z it is a line; with -z it is a NUL-terminated record, which may
// span several lines. Everything downstream works on an array of units, so only the terminator changes.
const SEP = opt.z ? '\0' : '\n';
// How much of one unit is sent. A line rarely reaches 2000 characters; a commit message with its body does.
const MAX_UNIT_CHARS = opt.z ? 8000 : 2000;

// With -r, expand directories. Line contents go to an external API, so recursion skips .git / node_modules
// and files that usually hold secrets (.env*, credential files, keys, .ssh/.aws/.gnupg/.kube/.docker). A file named
// explicitly is still sent. Case-insensitive: macOS file systems are, so .ENV is .env there.
const SKIP_DIRS = ['.git', 'node_modules', '.ssh', '.aws', '.gnupg', '.kube', '.docker'];
const SKIP_FILE = /^\.env|^\.(netrc|npmrc|pypirc|pgpass|git-credentials)$|\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)/i;
let hadError = false;
const warned = []; // what warn printed, so -i does not repeat it from its dry run
const warn = (file, e) => { const m = `semgrep: ${safe(file)}: ${safe(e.message)}`; warned.push(m); console.error(m); hadError = true; };
// -r also leaves out what git ignores (.gitignore, .git/info/exclude, the global excludes file), in one git call per
// directory named on the command line. Paths come back relative to it; an ignored directory comes back whole, as
// "dir/", so it is never walked. A directory that is itself ignored was named on purpose and is searched in full.
function gitIgnored(dir) {
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['check-ignore', '-q', '.']); return new Set(); } catch {} // exit 0: dir itself is ignored
  try { return new Set(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').map(p => p.replace(/\/$/, ''))); }
  catch { return new Set(); } // not in a repository, or no git: nothing is ignored
}
function expand(path, rel = '', ignored) {
  let st;
  try { st = statSync(path); } catch (e) { warn(path, e); return []; }
  if (!st.isDirectory()) return rel && !wanted(path, st) ? [] : [path]; // rel is empty for a name on the command line
  if (!opt.r) { warn(path, { message: 'Is a directory (use -r)' }); return []; }
  ignored ??= gitIgnored(path);
  let ents;
  try { ents = readdirSync(path, { withFileTypes: true }); } catch (e) { warn(path, e); return []; }
  return ents
    .filter(d => !d.isSymbolicLink() && !(d.isDirectory() ? SKIP_DIRS.includes(d.name) : SKIP_FILE.test(d.name)))
    .filter(d => !ignored.has(rel + d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(d => expand(path.endsWith('/') ? path + d.name : `${path}/${d.name}`, `${rel}${d.name}/`, ignored)); // not path.join(): it would drop the leading ./
}
// As git semgrep, FILE arguments are pathspecs and the files are the tracked ones, like git grep. The skip list
// still applies, since these files were not named one by one. Deleted files, submodules and symlinks are left out.
const asGit = globalThis.SEMGREP_GIT === true; // set by git-semgrep.mjs
const lsFiles = () => {
  try { return execFileSync('git', ['ls-files', '-z', '--', ...files], { encoding: 'utf8', maxBuffer: Infinity }); }
  catch (e) { if (e.status == null) die(`git ls-files: ${e.message}`); process.exit(2); } // git exited non-zero: it has said why
};
const gitFiles = () => [...new Set(lsFiles().split('\0'))] // a conflicted file is listed once per stage
  .filter(p => {
    if (!p || p.split('/').some(d => SKIP_DIRS.includes(d)) || SKIP_FILE.test(p.split('/').at(-1))) return false;
    const st = lstatSync(p, { throwIfNoEntry: false });
    return st?.isFile() && wanted(p, st);
  })
  .map(p => (p === '-' ? './-' : p)); // a tracked file named -, not stdin
const found = asGit ? gitFiles()
  : (files.length ? files : [opt.r ? '.' : '-']).flatMap(f => (f === '-' ? [f] : expand(f)));
// A file no term admits is not read. Each scope is reported when it can narrow something (not with named files only),
// with -q silent; the -i dry run does not repeat it.
const targets = found.filter(f => expr.some(term => admitted(term, f)));
if (!opt.quiet && found.some(f => !named(f))) {
  const scoped = [...new Set(expr.flat().filter(lit => lit.kind === 's').map(lit => `semgrep: scope: ${safe(lit.label)} (from ${lit.words.map(w => `"${safe(w)}"`).join(', ')})`))];
  if (scoped.length) scoped.push(`semgrep: scope: ${targets.length} of ${found.length} files`);
  for (const m of scoped) { console.error(m); warned.push(m); }
}
// Standard input is read once: -i hands it to its dry run, and the search reads it again from here.
const stdinBuf = targets.includes('-') ? readFileSync(0) : null;
// -i: run this same command once with --dry-run, show its files and totals on the terminal, and search only on a yes.
// Nothing is sent before the answer. The answer comes from /dev/tty, so stdin can still carry the data.
if (opt.interactive && !dry) {
  let tty;
  try { tty = openSync('/dev/tty', 'r+'); } catch { die(`-i needs a terminal to ask on${optsInteractive ? ' (-i is in SEMGREP_OPTS; from a script, run SEMGREP_OPTS= semgrep ...)' : ''}`, !optsInteractive); }
  const plan = spawnSync(process.execPath, [...process.execArgv, process.argv[1], '--dry-run', ...process.argv.slice(2)], { input: stdinBuf ?? '', encoding: 'utf8', maxBuffer: Infinity });
  if (plan.status !== 0 && plan.status !== 2) { process.stderr.write(plan.stderr); process.exit(2); } // 2: a file could not be read
  // A file that could not be read shows up only while reading, in the dry run: say so next to the question. What
  // this process already printed (the file list's warnings, the option warnings) is not repeated.
  const errors = plan.stderr.split('\n').filter(l => l.startsWith('semgrep: ') && !l.startsWith('semgrep: warning: ') && !warned.includes(l));
  const shown = [...plan.stdout.split('\n').filter(l => /^semgrep: (file |dry run: )/.test(l)), ...errors].map(safe);
  if (!/^semgrep: dry run: 0 requests/.test(shown.findLast(l => l.startsWith('semgrep: dry run: ')))) {
    writeSync(tty, `${shown.join('\n')}\nSearch, sending the above? [y/N] `);
    const buf = Buffer.alloc(256);
    if (!/^\s*y(es)?\s*$/i.test(buf.toString('utf8', 0, readSync(tty, buf)))) { console.error('semgrep: nothing sent'); process.exit(1); }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let usedTokens = 0, usedCost = 0, requestCount = 0;
let traced = 0, tracedQuestions = 0, tracedChars = 0;
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// --dry-run / --verbose: one line per request, then its questions grouped by wording (line ids read Lnnn).
// --dry-run answers every question no (0), which also decides what --dedup folds and where --sentence joins.
function show(state, questions, label) {
  const count = new Map();
  for (const q of Object.values(questions)) { const k = q.instructions.replace(/\bL\d{3}\b/g, 'Lnnn'); count.set(k, (count.get(k) ?? 0) + 1); }
  const n = Object.keys(questions).length, chars = Object.values(state).join('').length;
  trace(`request ${++traced} ${label}, ${n} question${n === 1 ? '' : 's'}, ${chars} chars`);
  [...count].slice(0, 3).forEach(([q, k]) => trace(`  ${String(k).padStart(3)}× ${cut(q, 100)}`));
  if (count.size > 3) trace(`       (+${count.size - 3} more)`);
  tracedQuestions += n; tracedChars += chars;
}
// One request with retries: 429 / 529 / 5xx, connection errors and timeouts back off exponentially.
async function post(state, questions, label) {
  if (trace) show(state, questions, label);
  if (dry) return Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0 }]));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(credential && { authorization: `Bearer ${credential}` }) },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt < 6) { await sleep(500 * 2 ** attempt); continue; }
      throw new Error(`${apiHost}: ${e.cause?.message ?? e.message}`);
    }
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 6) { await sleep(500 * 2 ** attempt); continue; }
    // The body comes from whatever server SEMGREP_URL names: short, and without terminal control characters.
    if (!res.ok) throw new Error(`${apiHost} ${res.status}: ${(await res.text()).slice(0, 300).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`);
    const { answers, usage = {} } = await res.json();
    // A missing or malformed answer would read as 0 and make every "not X" hold, so it is an error instead.
    for (const k of Object.keys(questions)) {
      const p = answers?.[k]?.noul;
      if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error(`${apiHost}: the response has no answer for ${k}`);
    }
    requestCount++;
    usedTokens += usage.input_tokens ?? 0;
    usedCost += typeof usage.cost === 'number' ? usage.cost : 0;
    return answers;
  }
}
// Run up to -j requests at once.
let running = 0;
const waiters = [];
const acquire = () => (running++ < Number(opt.j) ? Promise.resolve() : new Promise(r => waiters.push(r)));
const release = () => (running--, waiters.shift()?.());
const pooled = async fn => { await acquire(); try { return await fn(); } finally { release(); } };

// --sentence: the unit is a sentence. Lines are joined as wrapped prose, except where a newline cannot be inside
// a sentence: at a blank line, next to structure characters (JSON, code), or before a list item, heading, quote or
// number. Each joined piece is then split by Intl.Segmenter (Unicode UAX #29 sentence boundaries).
const SENTENCES = new Intl.Segmenter(undefined, { granularity: 'sentence' });
// Scripts written without spaces between words: joining their wrapped lines must not add one
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}ー、。]/u;
const hardBreak = (prev, next) => !prev || !next || /[{}\[\]<>|;]$/.test(prev) || /^[{}\[\]<>|"\-*+#>\d]/.test(next)
  || /[{}\[\];]$/.test(next); // a line ending like code is not a continuation of prose either
// lines -> [{ text, spans }]. A span [unit, from, to] is where the sentence lies in the original units: the unit
// is the 1-based line (or record) number from unitOf, from/to are character offsets inside it (baseOf shifts a
// line's offset inside its record with -z). Output maps matching sentences back to these units.
function toSentences(lines, unitOf, baseOf, split = new Set()) { // split: breaks Jev judged to end an entry
  const out = [];
  let text = '', marks = []; // marks: { o: offset in text, unit, base: offset in the unit, len }
  const flush = () => {
    for (const seg of SENTENCES.segment(text)) {
      const t = seg.segment.trim();
      if (!t) continue;
      const start = seg.index + seg.segment.length - seg.segment.trimStart().length, end = start + t.length;
      const spans = [];
      for (const m of marks) {
        const a = Math.max(start, m.o), b = Math.min(end, m.o + m.len);
        if (a < b) spans.push([m.unit, m.base + a - m.o, m.base + b - m.o]);
      }
      out.push({ text: t, spans });
    }
    text = ''; marks = [];
  };
  lines.forEach((line, i) => {
    const prev = text.trimEnd(), next = line.trim();
    const mark = { unit: unitOf(i), base: baseOf(i) + line.length - line.trimStart().length, len: next.length };
    if (hardBreak(prev, next) || split.has(i)) { flush(); if (next) { text = next; marks.push({ ...mark, o: 0 }); } return; }
    text = prev + (CJK.test(prev.at(-1)) && CJK.test(next[0]) ? '' : ' '); // no space for scripts without word spaces
    marks.push({ ...mark, o: text.length });
    text += next;
  });
  flush();
  return out;
}

// Where the rules would join, a break still needs judging if a script without word spaces touches it and the line
// does not end a sentence: in Japanese or Chinese, entries often end without 。, and joining leaves no trace of the
// break. A line starting with closing punctuation continues the previous one (kinsoku), and so does a line
// ending in 、. With --sentence=jev such breaks are asked, 30 lines per request, a yes/no per break. A break needs
// p >= 0.7: real breaks measured 0.81 and up, while wraps a person made at a phrase boundary reach 0.5 to 0.6.
const CLOSING = /^[。、，．」』）】〕！？]/;
const needsJudging = (prev, next) => prev && next && !hardBreak(prev, next) && !/[。！？!?、，]$/.test(prev) && !CLOSING.test(next)
  && (CJK.test(prev.at(-1)) || CJK.test(next[0]));
const BREAK_ABOUT = 'A line break either ends a sentence or a separate entry (a new message, item or sentence starts on the next line), or it is only a wrap in the middle of a sentence (the sentence continues on the next line).';
async function judgeBreaks(lines, file) { // -> Set of i where the break before lines[i] ends a sentence or entry
  const ask = [];
  for (let i = 1; i < lines.length; i++) if (needsJudging(lines[i - 1].trim(), lines[i].trim())) ask.push(i);
  const split = new Set();
  const id = k => `L${String(k).padStart(3, '0')}`;
  const jobs = [];
  for (let s = 0; s < lines.length - 1; s += 29) { // windows of 30 lines sharing one line, so every break is inside one
    const qs = ask.filter(i => i > s && i < s + 30);
    if (!qs.length) continue;
    const state = Object.fromEntries(lines.slice(s, s + 30).map((l, k) => [id(k), l.slice(0, MAX_UNIT_CHARS)]));
    const questions = Object.fromEntries(qs.map(i => [`b${i}`, { type: 'noul', instructions: `${BREAK_ABOUT} Does the line break between ${id(i - 1 - s)} and ${id(i - s)} end a sentence or entry (rather than being a wrap inside a sentence)?` }]));
    jobs.push(pooled(() => post(state, questions, `[breaks] ${file}:${s + 1}-${Math.min(s + 30, lines.length)}`)).then(a => qs.forEach(i => { if (a[`b${i}`].noul >= 0.7) split.add(i); })));
  }
  await Promise.all(jobs);
  return split;
}

const sources = new Map(); // file -> the units printed (lines or records; sentences with -o); includes blank lines
const spansOf = new Map(); // file -> spans of each sentence (--sentence only)
const allLines = []; // { file, no, text }; includes blank lines; what the expression is evaluated over
const read = new Map(); // file -> units as read (lines, or records with -z)
for (const file of targets) {
  let buf;
  try { buf = file === '-' ? stdinBuf : readFileSync(file); } catch (e) { warn(file, e); continue; }
  // UTF-16 with a BOM is text though every ASCII character carries a NUL, so it skips the binary sniff.
  const utf16 = { fffe: 'utf-16le', feff: 'utf-16be' }[buf.subarray(0, 2).toString('hex')]; // its encoding, or undefined
  // With -z a NUL is the record terminator, so the binary sniff looks for other control bytes (ELF, images, archives).
  // A PDF often opens with XML metadata, its first NUL past 8 KB, so it is told by its magic.
  const head = buf.subarray(0, 8192);
  const binary = head.subarray(0, 5).toString('latin1') === '%PDF-' || (opt.z ? /[\x01-\x08\x0e-\x1a\x1c-\x1f]/.test(head.toString('latin1')) : head.includes(0));
  if (!utf16 && binary) {
    if (files.includes(file)) console.error(`semgrep: ${file}: binary file skipped`); // named on the command line: say so
    continue;
  }
  const src = (utf16 ? new TextDecoder(utf16).decode(buf) : buf.toString('utf8')).split(SEP);
  if (src.at(-1) === '') src.pop();
  read.set(file, src);
}
// Each run of lines that may join: the whole file, or each record with -z. starts: offset of each line in its unit.
const runsOf = src => (opt.z
  ? src.map((rec, r) => { const ls = rec.split('\n'), starts = [0]; for (const l of ls) starts.push(starts.at(-1) + l.length + 1); return { lines: ls, unitOf: () => r + 1, baseOf: i => starts[i] }; })
  : [{ lines: src, unitOf: i => i + 1, baseOf: () => 0 }]);
const runsByFile = new Map([...read].map(([file, src]) => [file, opt.sentence ? runsOf(src) : []]));
const splits = new Map(); // run -> Set of breaks Jev judged to end an entry
if (opt.sentence === 'jev')
  await Promise.all([...runsByFile].flatMap(([file, runs]) => runs.map(run => judgeBreaks(run.lines, file).then(sp => splits.set(run, sp)))));
for (const [file, src] of read) {
  sources.set(file, src);
  let units = src;
  if (opt.sentence) {
    // With -z a record is a hard boundary, and lines inside it are joined like any wrapped prose.
    const sentences = runsByFile.get(file).flatMap(run => toSentences(run.lines, run.unitOf, run.baseOf, splits.get(run)));
    spansOf.set(file, sentences.map(u => u.spans));
    if (opt.o) sources.set(file, sentences.map(u => u.text));
    units = sentences.map(u => u.text);
  }
  units.forEach((text, i) => allLines.push({ file, no: i + 1, text }));
}
// Local regex evaluation + prefilter: a term is only asked its meanings for a unit once every regex
// literal in the term already holds; captures from the term's own non-negated regexes are then expanded
// into the meaning text (ECMAScript's GetSubstitution, see SUBST above). A unit no term can hold for, and
// blank/whitespace-only units, are never sent (blank units count as probability 0 for every meaning).
const execAt = (lit, text) => { lit.re.lastIndex = 0; return lit.re.exec(text); }; // reset: /re/g or /re/y would else carry state across units
function regexPart(term, { text, file }) { // -> { ok, matches }: matches are the non-negated regexes' exec results
  let ok = admitted(term, file); // a scope left this file out: the term cannot hold in it
  const matches = [];
  for (const lit of term) {
    if (lit.kind !== 'r') continue;
    const m = execAt(lit, text);
    if ((m !== null) === lit.not) ok = false;
    if (!lit.not) matches.push(m);
  }
  return { ok, matches };
}
// A capture is text from the searched file, placed inside the quoted meaning: cap it and escape its quotes.
const quoteSafe = s => (s ?? '').slice(0, 200).replace(/["\\]/g, '\\$&');
function expandCaptures(text, matches) {
  const named = new Map(), positional = [];
  for (const m of matches) {
    for (let i = 1; i < m.length; i++) positional.push(quoteSafe(m[i]));
    if (m.groups) for (const [k, v] of Object.entries(m.groups)) named.set(k, quoteSafe(v));
  }
  const whole = quoteSafe(matches[0]?.[0]);
  return text.replace(SUBST, (all, dollar, amp, name, num) => {
    if (dollar) return '$';
    if (amp) return whole;
    if (name !== undefined) return named.get(name) ?? '';
    const n = numRef(num, positional.length);
    return n ? positional[n - 1] + (num.length === 2 && +num === n ? '' : num.slice(1)) : `$${num}`; // $02 is group 2; $20 is group 2 then "0"
  });
}
// asksByUnit: unit -> Map(expanded meaning text -> probability, null until answered)
const asksByUnit = new Map();
for (const l of allLines) {
  const asks = new Map();
  if (l.text.trim()) for (const term of expr) {
    const { ok, matches } = regexPart(term, l);
    if (ok) for (const lit of term) if (lit.kind === 'm') asks.set(expandCaptures(lit.text, matches), null);
  }
  asksByUnit.set(l, asks);
}
const lines = allLines.filter(l => asksByUnit.get(l).size);
const unitName = opt.sentence ? 'sentences' : opt.z ? 'records' : 'lines';
if (trace) for (const file of read.keys()) {
  const units = allLines.filter(l => l.file === file);
  trace(`file ${file}: ${units.length} ${unitName}, ${units.filter(l => asksByUnit.get(l).size).length} to send`);
}
// -q stops at the first match, like grep -q. Known before any request, --dedup's included: unsent units (blank, or
// no term's regexes hold; their meanings score 0) and regex-only terms.
// ponytail: process.exit may drop a warning still buffered for a stderr pipe; the exit status is what -q promises
const regexOnly = term => term.every(lit => lit.kind === 'r');
if (opt.quiet && allLines.some(l => expr.some(term => (!asksByUnit.get(l).size || regexOnly(term)) && termHolds(term, l)))) process.exit(0);

// --dedup: machine-generated logs repeat one skeleton with a different id or number in it. Mask the parts
// whose value carries no meaning, group by the result, and judge one member per group. The mask is only
// the grouping key: what gets sent is the representative's ORIGINAL text. Whether a value carries meaning
// depends on the meaning: a number decides "disk usage above 90%", a time decides "happened at night". So
// Jev is asked first, once per run, which kinds of value could change a match, and those are left unmasked.
// Measured on install.log (#19): reusing answers across different values got 2 of 11, 14 of 60 and 22 of 44
// right for such meanings; the question named the right kinds for all seven meanings tried, at 0.7.
// Placeholders and the marks for kept values start with a NUL, which no unit contains (a NUL makes a file
// binary, and ends a record with -z), so no text in a line can pass for one ("value <num>" is not "value 12").
const DATE = String.raw`\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? +)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2}\b(?:,? +\d{4}\b)?`;
const MASK = [ // [kind, pattern, placeholder, what Jev is told the kind is]
  ['url', /https?:\/\/[^\s"'<>\0]+/g, '\0u', 'a URL'], // stops at quotes (jsonl has no spaces) and at a kept value's mark
  ['path', /(?:\/[\w.@+-]+){2,}/g, '\0p', 'a file path'],
  // A month or weekday name is a date only next to a day of the month (syslog's "Thu Sep 10"), so "user May" stays a name.
  ['time', new RegExp(String.raw`${DATE}|\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?(?:Z|[+-]\d\d(?::?\d\d)?)?|\b\d{1,2}:\d\d(?::\d\d(?:\.\d+)?)?\b`, 'g'), '\0t', 'a date or a time of day'],
  ['hex', /\b(?=[0-9a-f]{7,}\b)(?=[0-9a-f]*[a-f])[0-9a-f]*\d[0-9a-f]*\b/gi, '\0h', 'a hex id or hash'], // needs a digit and a letter: not words spelled in a-f, not long decimals (sizes, counts)
  ['num', /\b\d[\d.,:_-]*\b/g, '\0n', 'a number'],
];
// Take the kept values out first, so a folded kind cannot mask them (a time's digits as a number), and key on them.
// Each leaves a numbered mark (NUL + a private-use character) so values stay tied to their place.
const templateKey = (text, kept, fold) => {
  const vals = [];
  const rest = kept.reduce((s, [, re]) => s.replace(re, v => `\0${String.fromCharCode(0xe000 + vals.push(v))}`), text);
  return [fold.reduce((s, [, re, to]) => s.replace(re, to), rest), ...vals].join('\0');
};
// Regex terms are never folded: they and the prefilter already ran on every original unit (asksByUnit, #25).
// The key adds the unit's expanded questions, so units whose referenced captures differ, or whose regexes left
// different terms standing, are judged apart. A member shares its representative's answers (the same Map).
let sent = lines;
if (opt.dedup && lines.length) {
  // Asked with the unexpanded meaning, for meanings only; a regex-only expression sends nothing and gets here with no lines.
  const meanings = [...new Set(expr.flat().filter(lit => lit.kind === 'm').map(lit => lit.text))];
  // One request per meaning, the meaning as the only state: this is the form measured in #19. Keeping a kind that
  // could be folded only costs savings; folding one that matters gives wrong answers, so the threshold leans to keeping.
  const keep = await Promise.all(meanings.map(text => pooled(() => post({ meaning: text }, Object.fromEntries(MASK.map(([kind, , , what]) => [kind, {
    type: 'noul',
    instructions: `Log lines are grouped when they differ only in ${what}. Could the value of ${what} in a log line change whether that line matches the meaning "${text}"?`,
  }])), `[dedup] "${cut(text, 40)}"`)).then(a => MASK.filter(([kind]) => a[kind].noul >= 0.7).map(([kind]) => kind))));
  const kept = MASK.filter(([kind]) => keep.flat().includes(kind));
  const fold = MASK.filter(([kind]) => !keep.flat().includes(kind));
  const rep = new Map();
  for (const l of lines) {
    const key = [templateKey(l.text, kept, fold), ...asksByUnit.get(l).keys()].join('\0\0');
    if (!rep.has(key)) rep.set(key, l);
    else asksByUnit.set(l, asksByUnit.get(rep.get(key)));
  }
  sent = [...rep.values()];
}

// Chunk by line count and by characters. The API caps state + longest question at 32k tokens.
const chunks = [];
for (let i = 0; i < sent.length; ) {
  const chunk = [];
  let chars = 0;
  while (i < sent.length && chunk.length < chunkLines && chars < 20000) {
    chars += sent[i].text.length;
    chunk.push(sent[i++]);
  }
  chunks.push(chunk);
}

async function evaluate(chunk) {
  const id = i => `L${String(i).padStart(3, '0')}`;
  const state = Object.fromEntries(chunk.map((l, i) => [id(i), l.text.slice(0, MAX_UNIT_CHARS)]));
  const keys = chunk.map(l => [...asksByUnit.get(l).keys()]);
  const questions = {};
  chunk.forEach((_, i) => keys[i].forEach((text, k) => {
    questions[`${id(i)}_${k}`] = { type: 'noul', instructions: `Does line ${id(i)} match the meaning: "${text}"?` };
  }));
  const [a, b] = [chunk[0], chunk.at(-1)];
  const answers = await post(state, questions, `[judge] ${a.file}:${a.no}-${a.file === b.file ? '' : `${b.file}:`}${b.no}, ${chunk.length} ${unitName}`);
  chunk.forEach((l, i) => keys[i].forEach((text, k) => asksByUnit.get(l).set(text, answers[`${id(i)}_${k}`].noul)));
}
const isHit = l => expr.some(term => termHolds(term, l));
// -q: a failed request is reported and the rest still run, since a later match means exit 0 (grep -q).
await Promise.all(chunks.map(chunk => pooled(() => evaluate(chunk).then(() => {
  if (opt.quiet && chunk.some(isHit)) process.exit(0);
}, e => { if (!opt.quiet) throw e; console.error(`semgrep: ${e.message}`); hadError = true; }))));

const color = opt.color === 'always' || (opt.color === 'auto' && process.stdout.isTTY && !process.env.NO_COLOR);
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const paintProb = x => paint(x >= tPos ? 32 : x < tNeg ? 31 : 33, x.toFixed(2));
// -p: one column per literal, in the order it was written. Regex: 1.00/0.00 for whether it matched.
// Meaning: the answer, or 0 if no surviving term of this unit ever asked it.
function displayRow(l) {
  const out = [];
  for (const term of expr) {
    const { ok, matches } = regexPart(term, l); // a failed term was never asked, and its matches hold nulls
    for (const lit of term) if (lit.kind !== 's') out.push(lit.kind === 'r' ? (execAt(lit, l.text) ? 1 : 0) : ok ? (asksByUnit.get(l).get(expandCaptures(lit.text, matches)) ?? 0) : 0);
  }
  return out;
}
// A term holds when its regex literals all hold and every meaning literal cleared its threshold.
function termHolds(term, l) {
  const { ok, matches } = regexPart(term, l);
  if (!ok) return false;
  const asks = asksByUnit.get(l);
  for (const lit of term) if (lit.kind === 'm') {
    const p = asks.get(expandCaptures(lit.text, matches)) ?? 0;
    if (lit.not ? !(p < tNeg) : !(p >= tPos)) return false;
  }
  return true;
}
// Collect matches as file -> (line number -> matching unit), then print in file and line order with context.
const hits = new Map();
let matched = 0;
for (const l of allLines) {
  if (!isHit(l)) continue;
  matched++;
  if (!hits.has(l.file)) hits.set(l.file, new Map());
  hits.get(l.file).set(l.no, l);
}
// --sentence without -o prints the original lines (or records) a matching sentence touches, like grep prints
// lines. A unit keeps the probabilities of its first matching sentence; ranges mark the matching text in it.
const ranges = new Map(); // file -> (unit -> [[from, to]])
if (opt.sentence && !opt.o) for (const [file, h] of hits) {
  const spans = spansOf.get(file), units = new Map(), marked = new Map();
  for (const [k, p] of [...h].sort((a, b) => a[0] - b[0])) for (const [u, a, b] of spans[k - 1]) {
    if (!units.has(u)) units.set(u, p);
    marked.set(u, [...(marked.get(u) ?? []), [a, b]]);
  }
  hits.set(file, units);
  ranges.set(file, marked);
}
// Wrap the matching ranges in grep's match color (bold red), merging overlaps.
const highlight = (text, rs) => {
  if (!color || !rs) return text;
  let out = '', at = 0;
  for (const [a, b] of rs.sort((x, y) => x[0] - y[0])) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    out += text.slice(at, from) + paint('01;31', text.slice(from, b));
    at = b;
  }
  return out + text.slice(at);
};
const startNo = (file, k) => (opt.o && opt.sentence ? spansOf.get(file)[k - 1][0][0] : k); // -o: the unit where the sentence starts

const after = Number(opt.A ?? opt.C ?? 0), before = Number(opt.B ?? opt.C ?? 0);
// grep -r and git grep prefix file names even for a single file; -H / --no-filename decide it outright, the later one winning.
const multi = opt['with-filename'] ?? (opt.r || asGit || targets.length > 1);
let lastPrinted = null; // [file, line number]; used to print -- between context groups
for (const file of opt.quiet || dry ? [] : targets) {
  if (!sources.has(file)) continue;
  const h = hits.get(file);
  if (opt.c) { console.log((multi ? paint(35, file) + paint(36, ':') : '') + (h?.size ?? 0)); continue; }
  if (!h) continue;
  if (opt.l) { console.log(paint(35, file)); continue; }
  const src = sources.get(file);
  let last = 0; // last line number already printed for this file
  for (const no of [...h.keys()].sort((a, b) => a - b)) {
    const from = Math.max(no - before, last + 1), to = Math.min(no + after, src.length);
    if ((after || before) && lastPrinted && (lastPrinted[0] !== file || from > last + 1)) console.log(paint(36, '--'));
    for (let k = from; k <= to; k++) {
      const p = h.get(k);
      const sep = paint(36, p ? ':' : '-');
      const prefix = (multi ? paint(35, file) + sep : '') + (opt.n ? paint(32, startNo(file, k)) + sep : '');
      const tail = opt.p && p ? `\t[${displayRow(p).map(paintProb).join(' ')}]` : '';
      // Only data records carry the NUL terminator, as in grep -z; file names and counts stay on newlines.
      process.stdout.write(prefix + highlight(src[k - 1], ranges.get(file)?.get(k)) + tail + SEP);
    }
    last = Math.max(last, to);
    lastPrinted = [file, to];
  }
}
// Summary only when interactive; grep prints nothing to stderr when scripted.
if (dry) {
  const assumed = [opt.dedup && '--dedup', opt.sentence === 'jev' && '--sentence'].filter(Boolean);
  trace(`dry run: ${traced} request${traced === 1 ? '' : 's'}, ${sent.length} of ${allLines.length} ${unitName} to send, ${tracedQuestions} questions, ${tracedChars} chars; nothing sent${assumed.length ? ` (${assumed.join(' and ')} questions assumed no)` : ''}`);
} else if ((process.stderr.isTTY || opt.verbose) && !opt.quiet) {
  // The API's own usage.cost when reported (OpenRouter does); else an estimate at Jev's list price, only for TypeSafe itself.
  const cost = usedCost > 0 ? `, $${usedCost.toFixed(6)}` : customUrl ? '' : `, ~$${(usedTokens * 0.042 / 1e6).toFixed(6)}`;
  console.error(`${matched}/${allLines.length} ${unitName} (${sent.length} sent${opt.dedup ? ` of ${lines.length}` : ''}), ${requestCount} requests, ${usedTokens} input tokens${cost}`);
}
// process.exit() can drop buffered stdout when piped, so set exitCode instead.
process.exitCode = dry ? (hadError ? 2 : 0) : matched && opt.quiet ? 0 : hadError ? 2 : matched ? 0 : 1; // -q: a match wins over an error

#!/usr/bin/env node
// semgrep: grep by meaning, scored line by line with Jev (TypeSafe System One).
//   semgrep -e "network failure" -a "already retried" -e "customer wants a refund" FILE...
//   semgrep -Q "why the job failed" FILE...   # -Q X is -e "the line answers: X": answering lines, not asking ones
//   -e / -Q terms are OR'd; -a / -v attach AND / AND NOT to the preceding term: (A and B and not C) or D.
//   A leading ! negates just that meaning: -e A -e '!B' is A or not B.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

// Errors are one line plus exit code 2, like grep. No stack traces.
const die = (msg, hint = true) => { console.error(`semgrep: ${msg}${hint ? "\nTry 'semgrep --help' for more information." : ''}`); process.exit(2); };
process.on('uncaughtException', e => die(e.message));

// Settings come from the environment; the first .env found fills in what the environment lacks.
const found = ['.env', `${homedir()}/.config/semgrep/.env`].find(existsSync);
if (found) process.loadEnvFile(found); // never overrides variables already set
const { SEMGREP_URL, SEMGREP_MODEL, SEMGREP_API_KEY, TYPESAFE_API_KEY, SEMGREP_OPTS = '' } = process.env;

// A bare --color means --color=auto (as in grep); parseArgs cannot express an optional value, so fill it in first.
const fill = a => (a === '--color' ? '--color=auto' : a === '--sentence' ? '--sentence=jev' : a === '--null-data' ? '-z' : a);
const OPTIONS = {
  e: { type: 'string', multiple: true },
  a: { type: 'string', multiple: true },
  v: { type: 'string', multiple: true },
  question: { type: 'string', multiple: true, short: 'Q' },
  level: { type: 'string', default: 'normal' }, // strictness preset: loose / normal / strict
  r: { type: 'boolean', default: false }, // recurse into directories
  l: { type: 'boolean', default: false }, // print only matching file names
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
  color: { type: 'string', default: 'auto' }, // auto / always / never
  // the API settings, each overriding its environment variable
  'sys1-model': { type: 'string' }, // SEMGREP_MODEL
  'sys1-url': { type: 'string' }, // SEMGREP_URL
  'sys1-api-key': { type: 'string' }, // SEMGREP_API_KEY / TYPESAFE_API_KEY
  help: { type: 'boolean', short: 'h', default: false },
};
// SEMGREP_OPTS holds default options only: no meanings, no files, no --. It goes in front of the arguments, so the
// command line wins (a later value counts; --no-X clears a flag).
const defaults = SEMGREP_OPTS.split(/\s+/).filter(Boolean).map(fill);
try {
  const { tokens: t } = parseArgs({ args: defaults, options: OPTIONS, allowPositionals: true, allowNegative: true, tokens: true });
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
               node_modules, .ssh/.aws/.gnupg, binary files and likely secrets (.env*, *.pem, *.key,
               id_rsa...). Every searched line is sent to the TypeSafe API
  -l           print only the names of files with a match, not the lines
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
               A key on the command line shows up in ps and shell history; prefer .env
  -h, --help   this help (Japanese when LANG / LC_ALL / LC_MESSAGES starts with ja)

Exit status: 0 matched / 1 no match / 2 error

Environment (read from the environment, else from ./.env, else from ~/.config/semgrep/.env):
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
               .ssh/.aws/.gnupg、バイナリ、秘密情報らしいファイル (.env*, *.pem, *.key, id_rsa...) は
               飛ばす。検索した行はすべて TypeSafe の API に送られる
  -l           一致した行ではなくファイル名だけを表示
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
               コマンドラインのキーは ps やシェル履歴に残るので、なるべく .env に書く
  -h, --help   このヘルプ (LANG / LC_ALL / LC_MESSAGES が ja 以外なら英語)

終了コード: 一致あり 0 / なし 1 / エラー 2 (引数・読めないファイル・API 障害)

環境変数 (環境、無ければ ./.env、無ければ ~/.config/semgrep/.env から読む):
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
if ((hasMeanings || opt.sentence === 'jev') && !credential && !customUrl) die('SEMGREP_API_KEY is not set. Put it in ./.env or ~/.config/semgrep/.env');

const levels = { loose: [0.3, 0.7], normal: [0.5, 0.5], strict: [0.7, 0.3] };
const level = levels[opt.level];
if (!level) die(`--level must be one of ${Object.keys(levels).join(', ')}`);
const tPos = opt.t === undefined ? level[0] : Number(opt.t);
const tNeg = opt.T === undefined ? level[1] : Number(opt.T);
const chunkLines = Number(opt.chunk);
// Validate numeric options. parseArgs turns -C=10 into the value "=10", so reject that here.
for (const [k, label] of [['t', '-t'], ['T', '-T'], ['chunk', '--chunk'], ['j', '-j'], ['A', '-A'], ['B', '-B'], ['C', '-C']])
  if (opt[k] !== undefined && !/^\d+(\.\d+)?$/.test(opt[k])) die(`${label}: invalid number '${opt[k]}' (write ${label} 10 or ${label}10, not ${label}=10)`);
if (chunkLines < 1) die('--chunk must be at least 1');
if (tPos < 0 || tPos > 1 || tNeg < 0 || tNeg > 1) die('-t / -T must be between 0 and 1');
if (Number(opt.j) < 1) die('-j must be at least 1');
if (opt.sentence !== undefined && !['jev', 'rules'].includes(opt.sentence)) die('--sentence must be jev or rules');

// The unit of judgement. Without -z it is a line; with -z it is a NUL-terminated record, which may
// span several lines. Everything downstream works on an array of units, so only the terminator changes.
const SEP = opt.z ? '\0' : '\n';
// How much of one unit is sent. A line rarely reaches 2000 characters; a commit message with its body does.
const MAX_UNIT_CHARS = opt.z ? 8000 : 2000;

// With -r, expand directories. Line contents go to an external API, so recursion skips .git / node_modules
// and files that usually hold secrets (.env*, keys, .ssh/.aws/.gnupg). A file named explicitly is still sent.
const SKIP_DIRS = ['.git', 'node_modules', '.ssh', '.aws', '.gnupg'];
const SKIP_FILE = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/;
let hadError = false;
const warn = (file, e) => { console.error(`semgrep: ${file}: ${e.message}`); hadError = true; };
function expand(path) {
  let st;
  try { st = statSync(path); } catch (e) { warn(path, e); return []; }
  if (!st.isDirectory()) return [path];
  if (!opt.r) die(`${path}: Is a directory (use -r)`);
  return readdirSync(path, { withFileTypes: true })
    .filter(d => !d.isSymbolicLink() && !(d.isDirectory() ? SKIP_DIRS.includes(d.name) : SKIP_FILE.test(d.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(d => expand(path.endsWith('/') ? path + d.name : `${path}/${d.name}`)); // not path.join(): it would drop the leading ./
}
const targets = (files.length ? files : [opt.r ? '.' : '-']).flatMap(f => (f === '-' ? [f] : expand(f)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let usedTokens = 0, usedCost = 0, requestCount = 0;
// One request with retries: 429 / 529 / 5xx, connection errors and timeouts back off exponentially.
async function post(state, questions) {
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
    if (!res.ok) throw new Error(`${apiHost} ${res.status}: ${await res.text()}`);
    const { answers, usage = {} } = await res.json();
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
async function judgeBreaks(lines) { // -> Set of i where the break before lines[i] ends a sentence or entry
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
    jobs.push(pooled(() => post(state, questions)).then(a => qs.forEach(i => { if (a[`b${i}`].noul >= 0.7) split.add(i); })));
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
  try { buf = readFileSync(file === '-' ? 0 : file); } catch (e) { warn(file, e); continue; }
  // With -z a NUL is the record terminator, so the binary sniff would reject exactly the input we want.
  if (!opt.z && buf.subarray(0, 8192).includes(0)) continue;
  const src = buf.toString('utf8').split(SEP);
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
  await Promise.all([...runsByFile.values()].flat().map(run => judgeBreaks(run.lines).then(sp => splits.set(run, sp))));
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
function regexPart(term, text) { // -> { ok, matches }: matches are the non-negated regexes' exec results
  let ok = true;
  const matches = [];
  for (const lit of term) {
    if (lit.kind !== 'r') continue;
    const m = execAt(lit, text);
    if ((m !== null) === lit.not) ok = false;
    if (!lit.not) matches.push(m);
  }
  return { ok, matches };
}
function expandCaptures(text, matches) {
  const named = new Map(), positional = [];
  for (const m of matches) {
    for (let i = 1; i < m.length; i++) positional.push(m[i] ?? '');
    if (m.groups) for (const [k, v] of Object.entries(m.groups)) named.set(k, v ?? '');
  }
  const whole = matches[0]?.[0] ?? '';
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
    const { ok, matches } = regexPart(term, l.text);
    if (ok) for (const lit of term) if (lit.kind === 'm') asks.set(expandCaptures(lit.text, matches), null);
  }
  asksByUnit.set(l, asks);
}
const lines = allLines.filter(l => asksByUnit.get(l).size);

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
  }])))).then(a => MASK.filter(([kind]) => a[kind].noul >= 0.7).map(([kind]) => kind))));
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
  const answers = await post(state, questions);
  chunk.forEach((l, i) => keys[i].forEach((text, k) => asksByUnit.get(l).set(text, answers[`${id(i)}_${k}`].noul)));
}
const isHit = l => expr.some(term => termHolds(term, l));
// -q stops at the first match, like grep -q. Known before any request: unsent units (blank, or no term's regexes
// hold; their meanings score 0) and regex-only terms.
// ponytail: process.exit may drop a warning still buffered for a stderr pipe; the exit status is what -q promises
const regexOnly = term => term.every(lit => lit.kind === 'r');
if (opt.quiet && allLines.some(l => expr.some(term => (!asksByUnit.get(l).size || regexOnly(term)) && termHolds(term, l)))) process.exit(0);
await Promise.all(chunks.map(chunk => pooled(() => evaluate(chunk).then(() => {
  if (opt.quiet && chunk.some(isHit)) process.exit(0);
}))));

const color = opt.color === 'always' || (opt.color === 'auto' && process.stdout.isTTY && !process.env.NO_COLOR);
if (!['auto', 'always', 'never'].includes(opt.color)) die('--color must be auto, always or never');
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const paintProb = x => paint(x >= tPos ? 32 : x < tNeg ? 31 : 33, x.toFixed(2));
// -p: one column per literal, in the order it was written. Regex: 1.00/0.00 for whether it matched.
// Meaning: the answer, or 0 if no surviving term of this unit ever asked it.
function displayRow(l) {
  const out = [];
  for (const term of expr) {
    const { ok, matches } = regexPart(term, l.text); // a failed term was never asked, and its matches hold nulls
    for (const lit of term) out.push(lit.kind === 'r' ? (execAt(lit, l.text) ? 1 : 0) : ok ? (asksByUnit.get(l).get(expandCaptures(lit.text, matches)) ?? 0) : 0);
  }
  return out;
}
// A term holds when its regex literals all hold and every meaning literal cleared its threshold.
function termHolds(term, l) {
  const { ok, matches } = regexPart(term, l.text);
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
const startNo = (file, k) => (opt.o ? spansOf.get(file)[k - 1][0][0] : k); // -o: the unit where the sentence starts

const after = Number(opt.A ?? opt.C ?? 0), before = Number(opt.B ?? opt.C ?? 0);
const multi = opt.r || targets.length > 1; // grep -r prefixes file names even for a single file
let lastPrinted = null; // [file, line number]; used to print -- between context groups
for (const file of opt.quiet ? [] : targets) {
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
if (process.stderr.isTTY && !opt.quiet) {
  // The API's own usage.cost when reported (OpenRouter does); else an estimate at Jev's list price, only for TypeSafe itself.
  const cost = usedCost > 0 ? `, $${usedCost.toFixed(6)}` : customUrl ? '' : `, ~$${(usedTokens * 0.042 / 1e6).toFixed(6)}`;
  console.error(`${matched}/${allLines.length} ${opt.sentence ? 'sentences' : opt.z ? 'records' : 'lines'} (${sent.length} sent${opt.dedup ? ` of ${lines.length}` : ''}), ${requestCount} requests, ${usedTokens} input tokens${cost}`);
}
// process.exit() can drop buffered stdout when piped, so set exitCode instead.
process.exitCode = hadError ? 2 : matched ? 0 : 1; // -q exited 0 at its first match, even after an error

#!/usr/bin/env node
// semgrep: grep by meaning, scored line by line with Jev (TypeSafe System One).
//   semgrep -e "network failure" -a "already retried" -e "customer wants a refund" FILE...
//   -e terms are OR'd; -a / -v attach AND / AND NOT to the preceding -e term: (A and B and not C) or D.
//   A leading ! negates just that meaning: -e A -e '!B' is A or not B.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

// Errors are one line plus exit code 2, like grep. No stack traces.
const die = msg => { console.error(`semgrep: ${msg}\nTry 'semgrep --help' for more information.`); process.exit(2); };
process.on('uncaughtException', e => die(e.message));

// A bare --color means --color=auto (as in grep). parseArgs cannot express an optional value, so fill it in first.
const argv = process.argv.slice(2).map(a => (a === '--color' ? '--color=auto' : a === '--null-data' ? '-z' : a));
const { values: opt, positionals: files, tokens } = parseArgs({
  args: argv,
  allowPositionals: true,
  tokens: true,
  options: {
    e: { type: 'string', multiple: true },
    a: { type: 'string', multiple: true },
    v: { type: 'string', multiple: true },
    level: { type: 'string', default: 'normal' }, // strictness preset: loose / normal / strict
    r: { type: 'boolean', default: false }, // recurse into directories
    l: { type: 'boolean', default: false }, // print only matching file names
    t: { type: 'string' }, // positive threshold: match when p >= t (default from preset)
    T: { type: 'string' }, // negative threshold: "not X" when p < T (default from preset)
    chunk: { type: 'string', default: '30' }, // lines per request
    c: { type: 'boolean', default: false }, // count of matching lines per file (grep -c)
    j: { type: 'string', default: '8' }, // concurrent requests
    A: { type: 'string' }, // N lines of trailing context
    B: { type: 'string' }, // N lines of leading context
    C: { type: 'string' }, // N lines of context on both sides
    n: { type: 'boolean', default: false }, // line numbers
    z: { type: 'boolean', default: false }, // records are NUL-terminated, on input and output (grep -z)
    p: { type: 'boolean', default: false }, // print each meaning's probability
    color: { type: 'string', default: 'auto' }, // auto / always / never
    help: { type: 'boolean', short: 'h', default: false },
  },
});
// --help: Japanese when the locale starts with ja, English otherwise
const HELP_EN = `usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]
grep by meaning, powered by Jev (TypeSafe System One). Reads stdin when FILE is omitted.

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
  -r           recurse into directories (current directory when FILE is omitted). Skips .git,
               node_modules, .ssh/.aws/.gnupg, binary files and likely secrets (.env*, *.pem, *.key,
               id_rsa...). Every searched line is sent to the TypeSafe API
  -l           print only the names of files with a match, not the lines
  -A NUM       print NUM lines of trailing context after each match (context lines use - as separator)
  -B NUM       print NUM lines of leading context before each match
  -C NUM       print NUM lines of context before and after (-A NUM -B NUM)
  -c           print only a count of matching lines per file (like grep -c)
  --chunk=LINES lines per request (default 30)
  -j N         concurrent requests (default 8)
  -n           print line numbers
  -z, --null-data  the unit of judgement is a NUL-terminated record, not a line, so a record may span
               several lines. Matching records are printed NUL-terminated too (as in grep -z); file names
               and counts stay on newlines. -n numbers records, -A/-B/-C count records, --chunk counts
               records. Pairs with tools that already emit records: git log -z, find -print0, xargs -0
                 git log -z --format='%h %s %b' | semgrep -z -e "the change alters user-visible behaviour"
  -p           print each meaning's probability at the end of the line (for tuning thresholds)
  --color[=WHEN] auto (default: color when stdout is a terminal) / always / never; bare --color means auto
               file and line number use grep's colors; with -p, probabilities are green at or above
               the positive threshold, red below the negative one, yellow in between. NO_COLOR is honored
  -h, --help   this help (Japanese when LANG / LC_ALL / LC_MESSAGES starts with ja)

Exit status: 0 matched / 1 no match / 2 error

API key (TypeSafe / Jev):
  Get a key at https://console.typesafe.ai/ and provide it one of these ways, searched in this order:
    export TYPESAFE_API_KEY=your-key                         environment variable
    SEMGREP_ENV=/path/to/.env semgrep ...                    any .env file
    ./.env                                                   current directory (per project)
    ~/.config/semgrep/.env                                   per user
  The .env file is one line:  TYPESAFE_API_KEY=your-key
  e.g.  mkdir -p ~/.config/semgrep && echo 'TYPESAFE_API_KEY=your-key' > ~/.config/semgrep/.env`;
const HELP_JA = `usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]
jev (TypeSafe System One) で意味的にマッチする行を探す grep。FILE 省略時は stdin。

  -e MEANING   この意味に合う行 (複数指定は OR)
  -a MEANING   直前の -e 項に AND で連結。-e A -a B -e C は (A and B) or C
  -v MEANING   直前の -e 項に AND NOT で連結。-e A -v B は A and not B
               先頭に置けば単独の否定。-v B は not B (grep -v 相当)
  !MEANING     -e / -a / -v のどこでも、先頭に ! を付けるとその意味だけ否定
               -e A -e '!B' は A or not B。-a '!C' は -v C と同じ
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
  --chunk=LINES 1 リクエストにまとめる行数 (既定 30)
  -j N         同時リクエスト数 (既定 8)
  -n           行番号を付ける
  -z, --null-data  判定の単位を行ではなく NUL 終端のレコードにする。1 レコードが複数行でもよい。
               一致したレコードも NUL 終端で出力する (grep -z と同じ)。ファイル名と件数は改行のまま。
               -n はレコード番号、-A/-B/-C は前後のレコード数、--chunk はレコード数を数える。
               レコードを出すツールとそのまま繋がる: git log -z、find -print0、xargs -0
                 git log -z --format='%h %s %b' | semgrep -z -e "ユーザーに見える振る舞いを変えている"
  -p           各意味の確率を行末に表示 (閾値調整用)
  --color[=WHEN] 色付け。auto (端末なら付ける、既定) / always / never。=WHEN 省略時は auto
               ファイル名・行番号は grep と同じ配色。-p の確率は閾値以上を緑、
               否定側の閾値未満を赤、あいだを黄で表示。NO_COLOR にも従う
  -h, --help   このヘルプ (LANG / LC_ALL / LC_MESSAGES が ja 以外なら英語)

終了コード: 一致あり 0 / なし 1 / エラー 2 (引数・読めないファイル・API 障害)

API キーの設定 (TypeSafe / Jev):
  https://console.typesafe.ai/ でキーを取得し、次のいずれかで渡す。上から順に探す。
    export TYPESAFE_API_KEY=your-key                         環境変数
    SEMGREP_ENV=/path/to/.env semgrep ...                    任意の .env ファイル
    ./.env                                                   カレントディレクトリ (プロジェクト単位)
    ~/.config/semgrep/.env                                   ユーザー単位
  .env の中身は 1 行:  TYPESAFE_API_KEY=your-key
  例:  mkdir -p ~/.config/semgrep && echo 'TYPESAFE_API_KEY=your-key' > ~/.config/semgrep/.env`;
if (opt.help) {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  console.log(locale.startsWith('ja') ? HELP_JA : HELP_EN);
  process.exit(0);
}

// API key: if not in the environment, look for a .env file in order
if (!process.env.TYPESAFE_API_KEY && !process.env.OPENROUTER_API_KEY) {
  const candidates = [process.env.SEMGREP_ENV, '.env', `${homedir()}/.config/semgrep/.env`];
  const found = candidates.find(f => f && existsSync(f));
  if (found) process.loadEnvFile(found);
}
const apiKey = process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY;
if (!apiKey) die('TYPESAFE_API_KEY is not set. Put it in ./.env or ~/.config/semgrep/.env');

// Expression: a list of AND terms joined by OR. Each literal is [meaning index, negated]. meanings holds each distinct meaning once.
const expr = [];
const meanings = [];
for (const tk of tokens) {
  if (tk.kind !== 'option' || !['e', 'a', 'v'].includes(tk.name)) continue;
  if (tk.name === 'a' && expr.length === 0) die('-a needs a preceding -e');
  const not = tk.value.startsWith('!'); // per-meaning negation: "!MEANING"
  const text = not ? tk.value.slice(1) : tk.value;
  if (!text.trim()) die(`-${tk.name}: MEANING must not be empty`);
  let m = meanings.indexOf(text);
  if (m < 0) m = meanings.push(text) - 1;
  const lit = [m, not !== (tk.name === 'v')];
  if (tk.name === 'e' || expr.length === 0) expr.push([lit]);
  else expr.at(-1).push(lit);
}
if (!meanings.length) die('no -e MEANING given');
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
const sources = new Map(); // file -> all lines (for context output; includes blank lines)
const allLines = []; // { file, no, text }; includes blank lines; what the expression is evaluated over
for (const file of targets) {
  let buf;
  try { buf = readFileSync(file === '-' ? 0 : file); } catch (e) { warn(file, e); continue; }
  // With -z a NUL is the record terminator, so the binary sniff would reject exactly the input we want.
  if (!opt.z && buf.subarray(0, 8192).includes(0)) continue;
  const src = buf.toString('utf8').split(SEP);
  if (src.at(-1) === '') src.pop();
  sources.set(file, src);
  src.forEach((text, i) => allLines.push({ file, no: i + 1, text }));
}
// Blank and whitespace-only lines are not sent; they count as probability 0 for every meaning (never match -e, always match -v).
const lines = allLines.filter(l => l.text.trim());

// Chunk by line count and by characters. The API caps state + longest question at 32k tokens.
const chunks = [];
for (let i = 0; i < lines.length; ) {
  const chunk = [];
  let chars = 0;
  while (i < lines.length && chunk.length < chunkLines && chars < 20000) {
    chars += lines[i].text.length;
    chunk.push(lines[i++]);
  }
  chunks.push(chunk);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let usedTokens = 0;
let usedCost = 0;

async function evaluate(chunk) {
  const id = i => `L${String(i).padStart(3, '0')}`;
  const state = Object.fromEntries(chunk.map((l, i) => [id(i), l.text.slice(0, MAX_UNIT_CHARS)]));
  const questions = {};
  chunk.forEach((_, i) => meanings.forEach((text, m) => {
    questions[`${id(i)}_${m}`] = { type: 'noul', instructions: `Does line ${id(i)} match the meaning: "${text}"?` };
  }));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const url = process.env.SEMGREP_URL || 'https://api.typesafe.ai/v1/systemone';
      const model = process.env.SEMGREP_MODEL || 'jev-latest';
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt < 6) { await sleep(500 * 2 ** attempt); continue; } // retry on connection errors and timeouts too
      throw new Error(`typesafe: ${e.cause?.message ?? e.message}`);
    }
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 6) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`typesafe ${res.status}: ${await res.text()}`);
    const { answers, usage } = await res.json();
    usedTokens += usage.input_tokens;
    usedCost += typeof usage.cost === 'number' ? usage.cost : 0;
    return chunk.map((_, i) => meanings.map((_, m) => answers[`${id(i)}_${m}`].noul));
  }
}

// Run up to -j requests at once; results are consumed in chunk order.
let running = 0;
const waiters = [];
const acquire = () => (running++ < Number(opt.j) ? Promise.resolve() : new Promise(r => waiters.push(r)));
const release = () => (running--, waiters.shift()?.());
const results = chunks.map(async chunk => {
  await acquire();
  try { return await evaluate(chunk); } finally { release(); }
});

const color = opt.color === 'always' || (opt.color === 'auto' && process.stdout.isTTY && !process.env.NO_COLOR);
if (!['auto', 'always', 'never'].includes(opt.color)) die('--color must be auto, always or never');
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const paintProb = x => paint(x >= tPos ? 32 : x < tNeg ? 31 : 33, x.toFixed(2));

// Collect matches as file -> (line number -> probabilities), then print in file and line order with context.
const probOf = new Map(); // line object -> probability per meaning
for (const [ci, result] of results.entries()) {
  const probs = await result;
  chunks[ci].forEach((l, i) => probOf.set(l, probs[i]));
}
const zeros = meanings.map(() => 0);
const hits = new Map();
let matched = 0;
for (const l of allLines) {
  const p = probOf.get(l) ?? zeros;
  if (!expr.some(term => term.every(([m, not]) => (not ? p[m] < tNeg : p[m] >= tPos)))) continue;
  matched++;
  if (!hits.has(l.file)) hits.set(l.file, new Map());
  hits.get(l.file).set(l.no, p);
}

const after = Number(opt.A ?? opt.C ?? 0), before = Number(opt.B ?? opt.C ?? 0);
const multi = opt.r || targets.length > 1; // grep -r prefixes file names even for a single file
let lastPrinted = null; // [file, line number]; used to print -- between context groups
for (const file of targets) {
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
      const prefix = (multi ? paint(35, file) + sep : '') + (opt.n ? paint(32, k) + sep : '');
      const tail = opt.p && p ? `\t[${p.map(paintProb).join(' ')}]` : '';
      // Only data records carry the NUL terminator, as in grep -z; file names and counts stay on newlines.
      process.stdout.write(prefix + src[k - 1] + tail + SEP);
    }
    last = Math.max(last, to);
    lastPrinted = [file, to];
  }
}
// Summary only when interactive; grep prints nothing to stderr when scripted.
if (process.stderr.isTTY) {
  const cost = usedCost > 0 ? usedCost : usedTokens * (Number(process.env.SEMGREP_PRICE_PER_M) || 0.042) / 1e6;
  console.error(`${matched}/${allLines.length} ${opt.z ? 'records' : 'lines'} (${lines.length} sent), ${chunks.length} requests, ${usedTokens} input tokens, $${cost.toFixed(6)}`);
}
// process.exit() can drop buffered stdout when piped, so set exitCode instead.
process.exitCode = hadError ? 2 : matched ? 0 : 1;

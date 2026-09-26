// LLM-as-judge: for each case in cases.json, Claude (claude -p) decides which lines truly match each meaning.
// Those verdicts are the ground truth. We then sweep the thresholds (-t positive / -T negative) over sys1grep's
// per-line probabilities and report the best pair. The boolean expression is evaluated here on the per-meaning
// verdicts; the judge never sees the expression. Verdicts are cached in verdicts.json keyed by meaning text; --rejudge rebuilds.
//   npm run judge [-- --model MODEL] [--rejudge]   (Node 23.6+ runs .mts as is; the key comes from the environment,
//   ~/.config/sys1grep/.env, or ./.env passed by the npm script with --env-file: sys1grep itself never reads ./.env)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
  model: { type: 'string', default: 'sonnet' },
  rejudge: { type: 'boolean', default: false },
} });
const dir = new URL('.', import.meta.url).pathname;
const corpus = readFileSync(`${dir}corpus.txt`, 'utf8').split('\n').filter(l => l.trim());
const cases: { name: string; args: string[] }[] = JSON.parse(readFileSync(`${dir}cases.json`, 'utf8'));
const cachePath = `${dir}verdicts.json`;
const cache: Record<string, number[]> = !opt.rejudge && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

type Lit = [string, boolean];
function parseExpr(args: string[]): { expr: Lit[][]; meanings: string[] } {
  const expr: Lit[][] = [];
  const meanings: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], raw = args[i + 1];
    const not = raw.startsWith('!'), text = not ? raw.slice(1) : raw;
    if (!meanings.includes(text)) meanings.push(text);
    const lit: Lit = [text, not !== (flag === '-v')];
    if (flag === '-e' || !expr.length) expr.push([lit]); else expr.at(-1)!.push(lit);
  }
  return { expr, meanings };
}

function judge(meanings: string[]) {
  const todo = meanings.filter(m => !cache[m]);
  if (!todo.length) return;
  const numbered = corpus.map((l, i) => `${i + 1}: ${l}`).join('\n');
  const prompt = `You are grading a semantic grep. For EACH meaning below, list the line numbers of the text whose content matches that meaning. Judge by meaning, not keywords; a line in Japanese can match an English meaning and vice versa. Be strict: only clear matches.

Meanings:
${todo.map((m, i) => `M${i}: ${m}`).join('\n')}

Text:
${numbered}

Answer with ONLY a JSON object mapping "M0", "M1", ... to arrays of line numbers, e.g. {"M0":[3,9],"M1":[]}.`;
  const out = execFileSync('claude', ['-p', '--model', opt.model!, '--output-format', 'json'], { input: prompt, encoding: 'utf8', maxBuffer: 1 << 24 });
  const text: string = JSON.parse(out).result;
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  todo.forEach((m, i) => { cache[m] = json[`M${i}`] ?? []; });
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
}

// Run sys1grep once with a zero threshold to get every line's probabilities; the threshold sweep never calls the API.
function probabilities(meanings: string[]): Map<number, number[]> {
  // Listing every meaning as a positive -e with -t 0 prints every line, and -p gives the probability per meaning.
  const out = execFileSync('node', [`${dir}../sys1grep.mjs`, '-n', '-p', '-t', '0', ...meanings.flatMap(m => ['-e', m]), `${dir}corpus.txt`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return new Map(out.split('\n').filter(Boolean).map(l => {
    const [, no, probs] = l.match(/^(\d+):.*\t\[(.*)\]$/)!;
    return [Number(no), probs.split(' ').map(Number)];
  }));
}

type Prepared = { c: typeof cases[0]; expr: Lit[][]; meanings: string[]; probs: Map<number, number[]>; expected: Set<number> };
const prepared: Prepared[] = cases.map(c => {
  const { expr, meanings } = parseExpr(c.args);
  judge(meanings);
  const verdict = Object.fromEntries(meanings.map(m => [m, new Set(cache[m])]));
  const expected = new Set(corpus.map((_, i) => i + 1)
    .filter(n => expr.some(term => term.every(([m, not]) => verdict[m].has(n) !== not))));
  return { c, expr, meanings, probs: probabilities(meanings), expected };
});

function matches(x: Prepared, n: number, tPos: number, tNeg: number) {
  const p = x.probs.get(n)!;
  return x.expr.some(term => term.every(([m, not]) => (not ? p[x.meanings.indexOf(m)] < tNeg : p[x.meanings.indexOf(m)] >= tPos)));
}
function score(tPos: number, tNeg: number, subset = prepared) {
  let tp = 0, fp = 0, fn = 0;
  for (const x of subset) for (let n = 1; n <= corpus.length; n++) {
    if (!x.probs.has(n)) continue;
    const a = matches(x, n, tPos, tNeg), e = x.expected.has(n);
    if (a && e) tp++; else if (a) fp++; else if (e) fn++;
  }
  const P = tp / (tp + fp || 1), R = tp / (tp + fn || 1);
  return { tp, fp, fn, P, R, F1: (2 * P * R) / (P + R || 1) };
}

const grid = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
const sweep = grid.flatMap(tPos => grid.map(tNeg => ({ tPos, tNeg, ...score(tPos, tNeg) })))
  .sort((a, b) => b.F1 - a.F1 || Math.abs(a.tPos - 0.5) + Math.abs(a.tNeg - 0.5) - Math.abs(b.tPos - 0.5) - Math.abs(b.tNeg - 0.5));
const best = sweep[0], base = score(0.5, 0.5);
const fmt = (s: ReturnType<typeof score>) => `P ${s.P.toFixed(2)} R ${s.R.toFixed(2)} F1 ${s.F1.toFixed(3)} (TP ${s.tp} / FP ${s.fp} / FN ${s.fn})`;

const rows = prepared.map(x => {
  const s = score(best.tPos, best.tNeg, [x]);
  const actual = [...x.probs.keys()].filter(n => matches(x, n, best.tPos, best.tNeg));
  const fp = actual.filter(n => !x.expected.has(n)), fn = [...x.expected].filter(n => !actual.includes(n));
  const show = (ns: number[]) => ns.map(n => `  - L${n}: ${corpus[n - 1]}`).join('\n');
  return `| ${x.c.name} | \`${x.c.args.join(' ')}\` | ${x.expected.size} | ${actual.length} | ${s.P.toFixed(2)} | ${s.R.toFixed(2)} |`
    + (fp.length ? `\n\n  sys1grep のみ (judge は不一致):\n${show(fp)}\n` : '')
    + (fn.length ? `\n\n  judge のみ (sys1grep は見逃し):\n${show(fn)}\n` : '');
});

const report = `# sys1grep LLM-as-judge report

judge: claude -p --model ${opt.model} / corpus: ${corpus.length} lines / cases: ${cases.length} / ${new Date().toISOString().slice(0, 10)}

## 閾値の最適化 (肯定 -t × 否定 -T、0.05 刻み)

- 既定 -t 0.5 -T 0.5: ${fmt(base)}
- 最良 -t ${best.tPos} -T ${best.tNeg}: ${fmt(best)}

上位 8 組:

| -t | -T | P | R | F1 |
|---|---|---|---|---|
${sweep.slice(0, 8).map(s => `| ${s.tPos} | ${s.tNeg} | ${s.P.toFixed(2)} | ${s.R.toFixed(2)} | ${s.F1.toFixed(3)} |`).join('\n')}

## ケース別 (最良の閾値で評価)

| case | args | judge | sys1grep | P | R |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
writeFileSync(`${dir}report.md`, report);
console.log(report);

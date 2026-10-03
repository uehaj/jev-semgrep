// --dedup=auto against real Jev (#152): for every row of a corpus (FILE<TAB>MEANING) runs sys1grep under never, auto and
// always, and reports what must hold before auto becomes the default: the same matching lines as never, what it cost,
// whether the local estimate decided well, and whether the decision and the result stay put between runs.
//   node tests/dedup-eval.mjs [FILE.tsv...]   a table per corpus (default: both)
//   --dry                                     send nothing: the estimates, and what a real run would send (to approve the cost)
//   --runs=N                                  runs per mode (default 2; never runs max(N, 2) times and is its own control)
// Rows live in tests/dedup-corpus.tsv (tune on it) and tests/dedup-holdout.tsv (written blind; never tune on it, and
// read its tables, do not pick k from them); the files a TSV names sit in tests/<name without .tsv and -corpus>/.
// Needs the API key unless --dry. A real run bills about 3.4M input tokens (~$0.14) on the corpus, about 7.1M (~$0.30)
// on the holdout; --dry prices it from sys1grep's own fit, which ran about 30% under what Jev billed.
//
// "Differs" is against never's answer, not against the truth: where auto and never differ, neither is known right
// (a fold dropping a stack frame that never had included is not a hit hidden). Jev's probabilities also drift, so the
// control is the lines that flip between runs of never, and, on a row where auto decided not to fold (its request is
// then never's own), between auto's runs too. Only a difference beyond that control is shown as invented / hidden,
// and the table prints the control's size next to it: a difference no larger than the control is not a finding.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const runs = Number(args.find(a => a.startsWith('--runs='))?.slice(7) ?? 2);
if (!Number.isInteger(runs) || runs < 1) { console.error('dedup-eval: --runs must be a whole number, 1 or more'); process.exit(2); }
const tsvs = args.filter(a => !a.startsWith('--'));
const outFile = args.find(a => a.startsWith('--out='))?.slice(6); // every run's lines, tokens and requests as JSON
const raw = [];
const corpora = (tsvs.length ? tsvs : [`${here}dedup-corpus.tsv`, `${here}dedup-holdout.tsv`])
  .map(f => [f.split('/').at(-1), f.replace(/(-corpus)?\.tsv$/, '/'), readFileSync(f, 'utf8').trim().split('\n').map(l => l.split('\t'))]);
const QUESTION_COST = 650; // sys1grep's own figure for --dedup's question, per meaning
const KS = [1, 1.5, 2, 3];
const run = promisify(execFile);
const env = { ...process.env, SYS1GREP_OPTS: '' };

// dryRun: --dry-run, which sends nothing and prints its plan on stdout
async function once(mode, file, meaning, dryRun = false) {
  const argv = [`${here}../sys1grep.mjs`, '--verbose', '-n', `--dedup=${mode}`, ...(dryRun ? ['--dry-run'] : []), '-e', meaning, file];
  let out = '', err = '';
  try { ({ stdout: out, stderr: err } = await run(process.execPath, argv, { env, maxBuffer: 1 << 26 })); }
  catch (e) { if (e.code !== 1) return { error: `exit ${e.code}: ${String(e.stderr).trim().split('\n').at(-1)}` }; ({ stdout: out, stderr: err } = e); } // 1: no match
  if (dryRun) err = out;
  const d = err.match(/^sys1grep: dedup: (\d+) units fold to at most (\d+) templates \(~(\d+) requests, ~(\d+) tokens saved\): (on|off)/m);
  const s = err.match(/in (\d+) requests?, (\d+) input tokens?/);
  const q = err.match(/^sys1grep: dry run: (\d+) requests?, .*~(\d+) input tokens/m);
  return {
    lines: new Set(out.split('\n').filter(Boolean).map(l => +l.split(':')[0])),
    est: d && { units: +d[1], templates: +d[2], requests: +d[3], saved: +d[4], on: d[5] === 'on' },
    kept: err.match(/^sys1grep: dedup: kept apart .*: (.*)$/m)?.[1] ?? err.match(/^sys1grep: dedup: (\d+ templates agreed, \d+ split; \d+ units) sent again$/m)?.[1] ?? '',
    requests: +(s?.[1] ?? q?.[1] ?? 0), tokens: +(s?.[2] ?? q?.[2] ?? 0),
  };
}
const diff = (a, b) => [[...a].filter(x => !b.has(x)), [...b].filter(x => !a.has(x))]; // [only in a, only in b]
const pool = async (items, n, f) => { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await f(items[j]); } })); return out; };
const same = rs => rs.every(r => [...r.lines].sort().join() === [...rs[0].lines].sort().join());

let failed = 0, planned = { requests: 0, tokens: 0 };
for (const [name, dir, rows] of corpora) {
  const results = await pool(rows, 6, async ([f, meaning]) => {
    const file = dir + f;
    if (dry) return { f, meaning, never: await once('never', file, meaning, true), auto: await once('auto', file, meaning, true) };
    const modes = { never: Math.max(runs, 2), auto: runs, always: runs };
    const r = {};
    for (const [m, n] of Object.entries(modes)) r[m] = await Promise.all(Array.from({ length: n }, () => once(m, file, meaning)));
    return { f, meaning, r, dryAuto: await once('auto', file, meaning, true) }; // the decision is local: this must agree with the real runs
  });
  console.log(`## ${name} (${rows.length} rows${dry ? ', dry: nothing sent' : `, ${runs} runs per mode`})\n`);
  if (dry) {
    console.log('| file | meaning | units | templates | saved | auto decides | never: requests / ~tokens |\n|---|---|---|---|---|---|---|');
    for (const { f, meaning, never, auto } of results) {
      if (never.error || auto.error || !never.est) { console.log(`| ${f} | ${meaning} | error: ${never.error ?? auto.error ?? 'no plan'} |`); failed++; continue; }
      const e = never.est;
      console.log(`| ${f} | ${meaning} | ${e.units} | ${e.templates} | ${e.saved} | ${auto.est.on ? 'fold' : 'no fold'} | ${never.requests} / ${never.tokens} |`);
      const k = Math.max(runs, 2) + 2 * runs; // never's size for every run, whatever the mode
      planned.requests += never.requests * k; planned.tokens += never.tokens * k;
    }
    console.log('');
    continue;
  }
  raw.push({ corpus: name, rows: results.map(x => ({ ...x, r: x.r && Object.fromEntries(Object.entries(x.r).map(([m, rs]) => [m, rs.map(y => ({ ...y, lines: y.lines && [...y.lines] }))])), dryAuto: undefined })) });
  const errors = results.flatMap(x => Object.values(x.r).flat().filter(y => y.error).map(y => `${x.f}  ${x.meaning}: ${y.error}`));
  const ok = results.filter(x => Object.values(x.r).flat().every(y => !y.error) && !x.dryAuto.error);
  failed += results.length - ok.length;
  console.log('| file | meaning | never | auto | folds | invented / hidden (control) | req never → auto | tokens never → auto | stable |\n|---|---|---|---|---|---|---|---|---|');
  const sweep = KS.map(() => ({ tp: 0, fp: 0, fn: 0, tn: 0, wrong: 0 }));
  const bad = [], dearer = [], missed = [], flaps = [], dryMismatch = [];
  for (const { f, meaning, r, dryAuto } of ok) {
    const folds = r.auto.map(x => x.est?.on), folded = folds.some(Boolean);
    const [n0, ...n] = r.never;
    const control = folded ? n : [...n, ...r.auto]; // auto that did not fold asked never's own question
    const noisy = new Set(control.flatMap(x => diff(n0.lines, x.lines).flat()));
    const [invented, hidden] = (folded ? diff(r.auto[0].lines, n0.lines) : [[], []]).map(l => l.filter(x => !noisy.has(x)));
    const tok = m => Math.round(r[m].reduce((t, x) => t + x.tokens, 0) / r[m].length), req = m => Math.round(r[m].reduce((t, x) => t + x.requests, 0) / r[m].length);
    const stable = new Set(folds).size === 1 && (!folded || (same(r.auto) && new Set(r.auto.map(x => x.kept)).size === 1));
    console.log(`| ${f} | ${meaning} | ${n0.lines.size} | ${r.auto[0].lines.size} | ${folds.every(Boolean) ? 'yes' : folded ? 'sometimes' : 'no'} | ${invented.length} / ${hidden.length} (${noisy.size}) | ${req('never')} → ${req('auto')} | ${tok('never')} → ${tok('auto')} | ${stable ? 'yes' : 'NO'} |`);
    const row = `${f}  ${meaning}`;
    if (invented.length || hidden.length) bad.push(`${row}: invented ${invented.join(',') || '-'}; hidden ${hidden.join(',') || '-'} (control ${noisy.size})`);
    if (tok('auto') > tok('never')) dearer.push(`${row}: ${tok('never')} → ${tok('auto')} tokens`);
    if (!folded && tok('always') < tok('never')) missed.push(`${row}: auto stayed off, always ${tok('always')} < never ${tok('never')}`);
    if (!stable) flaps.push(`${row}: folds ${folds.join('/')}, kept ${[...new Set(r.auto.map(x => x.kept))].map(k => `[${k}]`).join(' ')}, results ${same(r.auto) ? 'same' : 'differ'}`);
    if (dryAuto.est?.on !== r.auto[0].est?.on) dryMismatch.push(row);
    const cheaper = tok('always') < tok('never'), exact = same([...r.always, n0]), e = r.auto[0].est;
    KS.forEach((k, i) => { const s = sweep[i], on = e.saved >= k * QUESTION_COST; s[on ? (cheaper ? 'tp' : 'fp') : (cheaper ? 'fn' : 'tn')]++; if (on && !exact) s.wrong++; });
  }
  const list = (title, a) => console.log(`\n${title}: ${a.length || 'none'}${a.map(x => `\n- ${x}`).join('')}`);
  list(`Failed runs (their rows are left out of everything below; ${ok.length} of ${rows.length} rows counted)`, errors);
  list('Result differences beyond the control', bad);
  list('auto cost more than never', dearer);
  list('would have paid, auto stayed off', missed);
  list('not stable across runs (decision, kept kinds, or result where it folded)', flaps);
  list('--dry-run decision differs from the real run (a check on the code: the estimate is local)', dryMismatch);
  console.log('\n| k (fold when saved >= k × question) | folds, cheaper | folds, dearer | stays off, cheaper | stays off, dearer | folds, and always differs from never (no control: noise included) |\n|---|---|---|---|---|---|');
  KS.forEach((k, i) => console.log(`| ${k} | ${sweep[i].tp} | ${sweep[i].fp} | ${sweep[i].fn} | ${sweep[i].tn} | ${sweep[i].wrong} |`));
  console.log('');
}
if (outFile) writeFileSync(outFile, JSON.stringify(raw));
if (dry) console.log(`A real run (--runs=${runs}) sends about ${planned.requests} requests, ~${planned.tokens} input tokens (~$${(planned.tokens * 0.042 / 1e6).toFixed(2)}): never's size for every run, an estimate, and it ran ~30% under what Jev billed.`);
if (failed) process.exit(1);

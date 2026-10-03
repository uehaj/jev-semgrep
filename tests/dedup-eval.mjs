// --dedup=auto against real Jev (#152): for every row of a corpus (FILE<TAB>MEANING) runs sys1grep under never, auto and
// always, and reports what must hold before auto becomes the default: the same matching lines as never, what it cost,
// whether the local estimate decided well, and whether the decision and the result stay put between runs.
//   node tests/dedup-eval.mjs [FILE.tsv...]   a table per corpus (default: both)
//   --dry                                     send nothing: the estimates, and what a real run would send (to approve the cost)
//   --runs=N                                  runs per mode (default 2; never runs N times and is its own control)
// Rows live in tests/dedup-corpus.tsv (tune on it) and tests/dedup-holdout.tsv (written blind; never tune on it); the files
// a TSV names sit in tests/<name without .tsv and -corpus>/. Needs the API key unless --dry; costs requests, see --dry first.
//
// Jev's probabilities drift, so two runs of never are the control: a line that flips between them is noise, and only a
// line auto adds or drops beyond those counts as folding's doing ("invented" / "hidden").
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const runs = Number(args.find(a => a.startsWith('--runs='))?.slice(7) ?? 2);
const tsvs = args.filter(a => !a.startsWith('--'));
const corpora = (tsvs.length ? tsvs : [`${here}dedup-corpus.tsv`, `${here}dedup-holdout.tsv`])
  .map(f => [f.split('/').at(-1), f.replace(/(-corpus)?\.tsv$/, '/'), readFileSync(f, 'utf8').trim().split('\n').map(l => l.split('\t'))]);
const QUESTION_COST = 650; // sys1grep's own figure for --dedup's question, per meaning
const KS = [1, 1.5, 2, 3];
const run = promisify(execFile);
const env = { ...process.env, SYS1GREP_OPTS: '' };

async function once(mode, file, meaning) {
  const argv = [`${here}../sys1grep.mjs`, '--verbose', '-n', `--dedup=${mode}`, ...(dry ? ['--dry-run'] : []), '-e', meaning, file];
  let out = '', err = '';
  try { ({ stdout: out, stderr: err } = await run(process.execPath, argv, { env, maxBuffer: 1 << 26 })); }
  catch (e) { if (e.code !== 1) return null; ({ stdout: out, stderr: err } = e); } // 1: no match
  if (dry) err = out; // --dry-run prints its plan on stdout
  const d = err.match(/^sys1grep: dedup: (\d+) units fold to at most (\d+) templates \(~(\d+) requests, ~(\d+) tokens saved\): (on|off)/m);
  const s = err.match(/in (\d+) requests?, (\d+) input tokens?/);
  const q = err.match(/^sys1grep: dry run: (\d+) requests?, .*~(\d+) input tokens/m);
  return {
    lines: new Set(out.split('\n').filter(Boolean).map(l => +l.split(':')[0])),
    est: d && { units: +d[1], templates: +d[2], requests: +d[3], saved: +d[4], on: d[5] === 'on' },
    kept: err.match(/^sys1grep: dedup: kept apart .*: (.*)$/m)?.[1] ?? '',
    asked: (err.match(/^sys1grep: request \d+ \[dedup\]/gm) ?? []).length,
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
    const modes = { never: Math.max(runs, 2), auto: runs, always: runs };
    const r = {};
    for (const [m, n] of Object.entries(modes)) r[m] = await Promise.all(Array.from({ length: dry ? 1 : n }, () => once(m, file, meaning)));
    return { f, meaning, r, dryAuto: dry ? null : await once('auto', file, meaning).catch(() => null) };
  });
  console.log(`## ${name} (${rows.length} rows${dry ? ', dry: nothing sent' : `, ${runs} runs per mode`})\n`);
  if (dry) {
    console.log('| file | meaning | units | templates | saved | pays at k=2 | never: requests / ~tokens |\n|---|---|---|---|---|---|---|');
    for (const { f, meaning, r } of results) {
      const n = r.never[0], e = n?.est;
      if (!e) { console.log(`| ${f} | ${meaning} | error |`); failed++; continue; }
      console.log(`| ${f} | ${meaning} | ${e.units} | ${e.templates} | ${e.saved} | ${e.saved >= 2 * QUESTION_COST ? 'yes' : 'no'} | ${n.requests} / ${n.tokens} |`);
      planned.requests += n.requests * (Math.max(runs, 2) + 2 * runs) ; planned.tokens += n.tokens * (Math.max(runs, 2) + 2 * runs); // never's size stands in for all three modes
    }
    console.log('');
    continue;
  }
  const ok = results.filter(x => Object.values(x.r).flat().every(Boolean));
  failed += results.length - ok.length;
  console.log('| file | meaning | never | auto | folds | invented / hidden | req never → auto | tokens never → auto | stable |\n|---|---|---|---|---|---|---|---|---|');
  const sweep = KS.map(() => ({ tp: 0, fp: 0, fn: 0, tn: 0, wrong: 0 }));
  const bad = [], dearer = [], missed = [], flaps = [], dryMismatch = [];
  for (const { f, meaning, r, dryAuto } of ok) {
    const [n0, ...n] = r.never, noisy = new Set(n.flatMap(x => diff(n0.lines, x.lines).flat()));
    const [inv0, hid0] = diff(r.auto[0].lines, n0.lines).map(l => l.filter(x => !noisy.has(x))); // inv0: auto only
    const [invented, hidden] = [inv0, hid0];
    const tok = m => Math.round(r[m].reduce((t, x) => t + x.tokens, 0) / r[m].length), req = m => Math.round(r[m].reduce((t, x) => t + x.requests, 0) / r[m].length);
    const folds = r.auto.map(x => x.est?.on), stable = [new Set(folds).size === 1, same(r.auto), new Set(r.auto.map(x => x.kept)).size === 1].every(Boolean);
    console.log(`| ${f} | ${meaning} | ${n0.lines.size} | ${r.auto[0].lines.size} | ${folds.every(Boolean) ? 'yes' : folds.some(Boolean) ? 'sometimes' : 'no'} | ${invented.length} / ${hidden.length} | ${req('never')} → ${req('auto')} | ${tok('never')} → ${tok('auto')} | ${stable ? 'yes' : 'NO'} |`);
    const row = `${f}  ${meaning}`;
    if (invented.length || hidden.length) bad.push(`${row}: invented ${invented.join(',') || '-'}; hidden ${hidden.join(',') || '-'}${noisy.size ? ` (noise lines ${[...noisy].join(',')})` : ''}`);
    if (tok('auto') > tok('never')) dearer.push(`${row}: ${tok('never')} → ${tok('auto')} tokens`);
    if (!folds.some(Boolean) && tok('always') < tok('never')) missed.push(`${row}: auto stayed off, always ${tok('always')} < never ${tok('never')}`);
    if (!stable) flaps.push(`${row}: folds ${folds.join('/')}, kept ${[...new Set(r.auto.map(x => x.kept))].map(k => `[${k}]`).join(' ')}, results ${same(r.auto) ? 'same' : 'differ'}`);
    if (dryAuto?.est && dryAuto.est.on !== r.auto[0].est?.on) dryMismatch.push(row);
    const cheaper = tok('always') < tok('never'), exact = same([...r.always, n0]), e = r.auto[0].est;
    KS.forEach((k, i) => { const s = sweep[i], on = e.saved >= k * QUESTION_COST; s[on ? (cheaper ? 'tp' : 'fp') : (cheaper ? 'fn' : 'tn')]++; if (on && !exact) s.wrong++; });
  }
  const list = (title, a) => console.log(`\n${title}: ${a.length || 'none'}${a.map(x => `\n- ${x}`).join('')}`);
  list('Result differences beyond never/never noise', bad);
  list('auto cost more than never', dearer);
  list('would have paid, auto stayed off', missed);
  list('not stable across runs', flaps);
  list('--dry-run decision differs from the real run', dryMismatch);
  console.log('\n| k (fold when saved >= k × question) | folds, cheaper | folds, dearer | stays off, cheaper | stays off, dearer | folds with a result difference vs always |\n|---|---|---|---|---|---|');
  KS.forEach((k, i) => console.log(`| ${k} | ${sweep[i].tp} | ${sweep[i].fp} | ${sweep[i].fn} | ${sweep[i].tn} | ${sweep[i].wrong} |`));
  console.log('');
}
if (dry) console.log(`A real run (--runs=${runs}) sends about ${planned.requests} requests, ~${planned.tokens} input tokens (~$${(planned.tokens * 0.042 / 1e6).toFixed(2)}); never's size stands in for auto and always, so it is an upper bound.`);
if (failed) process.exit(1);

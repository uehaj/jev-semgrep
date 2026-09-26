// Auto-scope accuracy (#44): runs semgrep -r --verbose on every row of a corpus (EXPECTED<TAB>QUESTION) against real
// Jev, reads the candidates --verbose lists with Jev's answers, and scores them against the expected scopes at several thresholds.
// Each row sends one request, the scope question: the directory searched is a small repository whose files hold
// only blank lines, which are never sent.
//   node tests/scope-eval.mjs [FILE.tsv...]   a table per corpus (default: both), the rows that differ at 0.6 (semgrep's threshold)
//   --at=0.6                                  list the rows that differ at another threshold
// Needs the API key (as semgrep reads it) and costs one small request per row. Both corpora were written blind by
// separate agents. Tune on scope-corpus.tsv only; scope-holdout.tsv gives the honest number.
//
// Scoring is per category, as semgrep combines them. A category Jev says yes to but the row does not expect narrows
// what it should not: "wrong", which loses matches without a trace. Where the row expects something in that
// category, the yes answers are alternatives, so they are safe when they include it, or a superset of it: source code
// (whatever is not documentation) holds test code, migrations and logs; uncommitted holds staged and untracked; this
// branch holds uncommitted. A code-only scope the row did not expect is counted apart ("code"): it loses only matches
// inside documentation, and the corpora rarely label it. The span of a time and the identity of an author are not
// checked: any yes counts when the row expects one.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const here = new URL('.', import.meta.url).pathname;
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const at = Number(process.argv.find(a => a.startsWith('--at='))?.slice(5) ?? 0.6);
const corpora = (files.length ? files : [`${here}scope-corpus.tsv`, `${here}scope-holdout.tsv`])
  .map(f => [f.split('/').at(-1), readFileSync(f, 'utf8').trim().split('\n').map(l => l.split('\t'))]);
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
// A candidate key -> [group, label]
const LANG = { cpp: 'cpp', cs: 'csharp', shellscript: 'shell' };
function group(key) {
  const [kind, name] = [key[0], key.slice(2)];
  if (kind === 'l') return ['lang', LANG[name] ?? name];
  if (kind === 'r') return ['place', name];
  if (kind === 't') return ['time', 'time'];
  if (kind === 'a' || key === 'g_mine') return ['author', 'author'];
  return [`git:${name}`, name];
}
// A candidate as --verbose names it ("Python files (*.py …)", "test code (test files: …)") -> a key group() reads
const NAMES = [[/^what was changed /, 't_'], [/^code written by me /, 'g_mine'], [/^code written by /, 'a_'],
  [/^files with uncommitted /, 'g_uncommitted'], [/^files with staged /, 'g_staged'], [/^untracked files/, 'g_untracked'],
  [/^files changed on the current git branch/, 'g_branch'], [/^files changed in commits not yet pushed/, 'g_unpushed'],
  [/^test code /, 'r_test'], [/^database migration files /, 'r_migration'], [/^the README /, 'r_readme'], [/^the changelog /, 'r_changelog'],
  [/^documentation /, 'r_docs'], [/^source code /, 'r_code'], [/^log files /, 'r_log']];
const keyOf = name => NAMES.find(([re]) => re.test(name))?.[1]
  ?? `l_${name.replace(/ files \(.*$/, '').toLowerCase().replace(/\+/g, 'p').replace(/#/g, 's').replace(/\W/g, '')}`;
// An expected label -> [group, alternatives]
function expected(label) {
  const [kind, rest] = label.split(':');
  if (kind === 'lang') return ['lang', rest.split('|')];
  if (kind === 'role') return ['place', [rest]];
  if (kind === 'time') return ['time', ['time']];
  if (rest === 'author') return ['author', ['author']];
  return [`git:${rest}`, [rest]];
}
const covers = (grp, got, want) => want.some(w => got.has(w)) || (grp === 'place' && got.has('code') && want.some(w => ['test', 'migration', 'log'].includes(w)));
const SUPERSET = { 'git:staged': ['git:uncommitted', 'git:branch'], 'git:untracked': ['git:uncommitted', 'git:branch'], 'git:uncommitted': ['git:branch'] };
// One row at one threshold -> { wrong: [...], missed: [...], code: bool }
function score(answers, exp, t) {
  const got = new Map(); // group -> Set of labels
  for (const [k, p] of answers) if (p >= t) { const [g, l] = group(k); got.set(g, (got.get(g) ?? new Set()).add(l)); }
  const want = new Map(exp === 'none' ? [] : exp.split(',').map(expected));
  const wrong = [], missed = [];
  let code = false;
  for (const [g, ls] of got) {
    if (want.has(g)) { if (!covers(g, ls, want.get(g))) wrong.push(`${g}:${[...ls]}`); continue; }
    if ((SUPERSET[g] ?? []).some(x => want.has(x)) || Object.entries(SUPERSET).some(([sub, sups]) => sups.includes(g) && want.has(sub))) continue;
    if (g === 'place' && [...ls].every(l => l === 'code')) { code = true; continue; }
    wrong.push(`${g}:${[...ls]}`);
  }
  for (const [g, ws] of want) if (!got.has(g) && !(SUPERSET[g] ?? []).some(x => got.has(x))) missed.push(`${g}:${ws.join('|')}`);
  return { wrong, missed, code };
}

const dir = mkdtempSync(`${tmpdir()}/scope-eval-`);
// A repository git can answer for: a commit by 田中 on main, one by user.email on a branch, no hooks.
const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'ignore' });
writeFileSync(`${dir}/x.txt`, '\n'); // scopes are asked only when -r finds a file; a blank line is never sent
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'Me');
git('add', 'x.txt'); git('commit', '-q', '--author=田中 <tanaka@x>', '-m', 'a');
git('checkout', '-q', '-b', 'feat'); writeFileSync(`${dir}/y.txt`, '\n'); git('add', 'y.txt'); git('commit', '-q', '-m', 'b');
const env = { ...process.env, SEMGREP_OPTS: '' };
const run = promisify(execFile);
let failed = 0;
for (const [name, rows] of corpora) {
  // Eight rows at once. A row whose request failed is counted apart, not as "none".
  const answers = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      const i = next++;
      let err;
      try { err = (await run(process.execPath, [`${here}../semgrep.mjs`, '--verbose', '-r', '-e', rows[i][1], dir], { env })).stderr; }
      catch (e) { err = e.code === 1 ? e.stderr : null; } // 1: no match, which every row is (the files are blank)
      // --verbose names each candidate answered 0.2 or more: `semgrep:   ✓ Python files (*.py …)  0.93  keeps …`
      const lines = err?.split('\n');
      answers[i] = lines?.some(l => l.startsWith('semgrep: scope "')) ? lines.map(l => l.match(/^semgrep: {3}[✓·] (.+?) +(\d\.\d\d) {2}/)).filter(Boolean).map(m => [keyOf(m[1]), +m[2]]) : null;
    }
  }));
  failed += answers.filter(a => a === null).length;
  console.log(`## ${name} (${rows.length} rows${answers.includes(null) ? `, ${answers.filter(a => a === null).length} failed` : ''})\n`);
  console.log('| threshold | wrong | code only | missed | exact |\n|---|---|---|---|---|');
  for (const t of THRESHOLDS) {
    const s = rows.map(([exp], i) => answers[i] && score(answers[i], exp, t)).filter(Boolean);
    console.log(`| ${t} | ${s.filter(x => x.wrong.length).length} | ${s.filter(x => x.code && !x.wrong.length).length} | ${s.filter(x => x.missed.length).length} | ${s.filter(x => !x.wrong.length && !x.missed.length).length} |`);
  }
  console.log(`\nAt ${at}:\n`);
  rows.forEach(([exp, q], i) => {
    if (!answers[i]) return console.log(`ERROR   ${q}`);
    const { wrong, missed } = score(answers[i], exp, at);
    if (wrong.length || missed.length) console.log(`${wrong.length ? 'WRONG ' : 'missed'}  want ${exp.padEnd(20)} ${wrong.length ? `extra ${wrong.join(' ')}` : `lacks ${missed.join(' ')}`}  | ${q}  [${answers[i].slice(0, 4).map(([k, p]) => `${k}=${p}`).join(' ')}]`);
  });
  console.log('');
}
rmSync(dir, { recursive: true });
if (failed) process.exit(1);

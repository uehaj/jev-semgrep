// Auto-scope accuracy (#44): runs semgrep --dry-run on every row of a corpus (EXPECTED<TAB>QUESTION) and compares
// the scopes it reports with the expected ones. Sends nothing: --dry-run on a small repository.
//   node tests/scope-eval.mjs [FILE.tsv]           per-label table and the rows that differ (default: both corpora)
//   node tests/scope-eval.mjs --check [FILE.tsv]   exit 1 if any row applies a scope it should not (a lost match)
// scope-corpus.tsv was written blind to the rules and then used to tune them; scope-holdout.tsv was written blind
// after the tuning and never tuned against, so its numbers are the honest ones.
// A wrong scope loses matches without a trace, so "wrong" is the number that matters; a missed one only costs requests.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = new URL('.', import.meta.url).pathname;
const given = process.argv.slice(2).filter(a => !a.startsWith('--'));
const corpus = (given.length ? given : [`${here}scope-corpus.tsv`, `${here}scope-holdout.tsv`]).flatMap(f => readFileSync(f, 'utf8').trim().split('\n').map(l => l.split('\t')));
// The first glob of each language in semgrep.mjs's LANGS names it
const LANG = { '*.py': 'python', '*.js': 'javascript', '*.ts': 'typescript', '*.go': 'go', '*.rs': 'rust', '*.java': 'java', '*.kt': 'kotlin', '*.rb': 'ruby', '*.php': 'php', '*.c': 'c', '*.cpp': 'cpp', '*.cs': 'csharp', '*.swift': 'swift', '*.scala': 'scala', '*.r': 'r', '*.sh': 'shell', '*.sql': 'sql', '*.html': 'html', '*.css': 'css', '*.md': 'markdown', '*.yaml': 'yaml', '*.json': 'json', '*.toml': 'toml', '*.xml': 'xml', Dockerfile: 'dockerfile', Makefile: 'makefile' };
// A scope line -> its labels. A language scope lists every language it admits.
function labels(line) {
  const what = line.replace(/^semgrep: scope: /, '').replace(/ \(from .*\)$/, '');
  if (/^\d+ of \d+ files$/.test(what)) return [];
  if (/^(modified|changed) /.test(what)) return ['time'];
  const m = what.match(/^([\w-]+) files\b/);
  if (m) return [`${m[1].startsWith('git-') ? 'git' : 'role'}:${m[1].replace(/^git-/, '')}`];
  const langs = what.split(' ').map(g => LANG[g]).filter(Boolean);
  return langs.length ? [`lang:${[...new Set(langs)].sort().join('|')}`] : [`?:${what}`];
}
const dir = mkdtempSync(`${tmpdir()}/scope-eval-`);
// A repository git can answer for: a commit by 田中 on main, one by user.email on a branch, no hooks. A git scope
// git could not answer (no repository, an author with no commit, "this branch" on main) is not reported.
writeFileSync(`${dir}/x.txt`, 'x\n'); // scopes are reported only when -r finds a file
const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'Me');
git('add', 'x.txt'); git('commit', '-q', '--author=田中 <tanaka@x>', '-m', 'a');
git('checkout', '-q', '-b', 'feat'); writeFileSync(`${dir}/y.txt`, 'y\n'); git('add', 'y.txt'); git('commit', '-q', '-m', 'b');
const env = { ...process.env, SEMGREP_URL: 'http://127.0.0.1:1/v1', SEMGREP_OPTS: '', SEMGREP_API_KEY: '', TYPESAFE_API_KEY: '' };
const stats = new Map(), diff = [];
let wrongRows = 0, missedRows = 0;
const bump = (label, k) => { const s = stats.get(label) ?? { tp: 0, fp: 0, fn: 0 }; s[k]++; stats.set(label, s); };
// A language scope is right when it admits every language expected; admitting more costs requests, not matches.
const covers = (got, want) => want.split(':')[0] === got.split(':')[0] && (got === want || (got.startsWith('lang:') && want.slice(5).split('|').every(l => got.slice(5).split('|').includes(l))));
for (const [expected, q] of corpus) {
  const out = spawnSync(process.execPath, [`${here}../semgrep.mjs`, '--dry-run', '-r', '-e', q, dir], { env, encoding: 'utf8' }).stderr;
  const got = out.split('\n').filter(l => l.startsWith('semgrep: scope: ')).flatMap(labels);
  const want = expected === 'none' ? [] : expected.split(',');
  const wrong = got.filter(g => !want.some(w => covers(g, w))), missed = want.filter(w => !got.some(g => covers(g, w)));
  for (const w of want) bump(w.split(':')[0] === 'lang' ? 'lang' : w, missed.includes(w) ? 'fn' : 'tp');
  for (const g of wrong) bump(g.startsWith('lang:') ? 'lang' : g, 'fp');
  if (wrong.length) wrongRows++;
  if (missed.length) missedRows++;
  if (wrong.length || missed.length) diff.push(`${wrong.length ? 'WRONG ' : 'missed'}  want ${expected.padEnd(18)} got ${(got.join(',') || 'none').padEnd(18)} ${q}`);
}
rmSync(dir, { recursive: true });
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
console.log('| scope | expected | found | wrong | precision | recall |\n|---|---|---|---|---|---|');
for (const [label, { tp, fp, fn }] of [...stats].sort()) console.log(`| ${label} | ${tp + fn} | ${tp} | ${fp} | ${pct(tp, tp + fp)} | ${pct(tp, tp + fn)} |`);
console.log(`\n${corpus.length} rows: ${wrongRows} apply a wrong scope (lost matches), ${missedRows} miss one (no saving)\n`);
console.log(diff.join('\n'));
if (process.argv.includes('--check') && wrongRows) process.exit(1);

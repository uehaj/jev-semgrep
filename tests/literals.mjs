// Required literals (#80): every line a regex matches must contain one of its literals, folded as rg -i folds
// (Unicode simple case folding, which 'iu' is), so rg -F never drops a line the JS regex would match.
// Fixed cases, then random regexes and lines from a fixed seed. Exits 1 with the first counterexample.
import { readFileSync, writeFileSync } from 'node:fs';
import { requiredLiterals, prefilterLiterals } from '../literals.mjs';

const fail = msg => { console.error(`FAIL: ${msg}`); process.exit(1); };
const esc = s => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const holds = (lits, icase, text) => lits.some(l => new RegExp(esc(l), icase ? 'iu' : 'u').test(text));
function check(re, text) {
  const lits = requiredLiterals(re);
  re.lastIndex = 0;
  if (lits && re.test(text) && !holds(lits, re.flags.includes('i'), text))
    fail(`${re} matches ${JSON.stringify(text)}, which contains none of ${JSON.stringify(lits)}`);
  return lits;
}

// What the issue promises
const eq = (re, want) => { const got = JSON.stringify(requiredLiterals(re)); if (got !== JSON.stringify(want)) fail(`${re}: ${got}, not ${JSON.stringify(want)}`); };
eq(/timeout/i, ['timeout']);
eq(/ERROR|FATAL/, ['ERROR', 'FATAL']);
eq(/user (?<id>\d+) logged in/, [' logged in']);
eq(/colou?r/, ['colo']);
eq(/\d{3}-\d{4}/, null);
eq(/caf\b/, ['caf']);
eq(/a\/b\.c/, ['a/b.c']);
eq(/(ERROR|WARN)NG/, null); // NG is too short, and the group is opaque
eq(/abc|/, null); // the empty alternative matches everywhere
eq(/x(?:y|z)+longer/, ['longer']); // a | inside a group does not split
eq(/[)|]abc/, ['abc']); // nor a ) or | inside a class
eq(/\x41BCD/, ['BCD']); // an escape's hex digits are not text
eq(/\u{1F600}abcd/u, ['abcd']);
eq(/(a)\12345/, null); // a backreference swallows its digits
eq(/abc+?d/, ['abc']); // lazy: +? keeps the c, then the run ends
eq(/abcd??e/, ['abc']); // ?? is optional, the second ? only makes it lazy
eq(/abc{2}d/, ['abc']);
eq(/abcd{0,2}/, ['abc']);
eq(/abcx{0,99999999999999999999999}def/, ['abc']); // a long {n,m} is still a quantifier, not text
eq(/écoles/i, ['coles']); // non-ASCII under i ends the run
eq(/écoles/, ['écoles']);
eq(/abc/v, null);
// The lines #70 found rg dropping: literals keep them
for (const [re, text] of [[/caf\b/, 'café'], [/caf\W/, 'café'], [/abc\sd/, 'abc﻿d'], [/abc.d/, 'abc�d'],
  [/foo$/m, 'foo\r'], [/^foo/m, 'x foo'], [/[a&&b]xyz/, '&xyz'], [/[[:alpha:]]xyz/, ':]xyz'], [/kelvin/i, 'Kelvin']])
  if (!requiredLiterals(re) || !re.test(text) || !holds(requiredLiterals(re), re.flags.includes('i'), text)) fail(`${re} on ${JSON.stringify(text)}`);

// prefilterLiterals: one pick per OR term; a term without a non-negated regex leaves no prefilter
const r = (re, not = false) => ({ kind: 'r', re, not });
const m = { kind: 'm', text: 'a meaning' };
const pf = e => JSON.stringify(prefilterLiterals(e));
if (pf([[r(/timeout/i), m], [r(/ERROR|FATAL/)]]) !== '{"literals":["timeout","ERROR","FATAL"],"icase":true}') fail(`prefilterLiterals: ${pf([[r(/timeout/i), m], [r(/ERROR|FATAL/)]])}`);
if (pf([[r(/ab/), r(/longest/)]]) !== '{"literals":["longest"],"icase":false}') fail('prefilterLiterals picks the longest');
if (pf([[r(/timeout/)], [m]]) !== 'null') fail('a meaning-only term leaves no prefilter');
if (pf([[r(/timeout/, true), m]]) !== 'null') fail('a negated regex is no prefilter');

// What each regex term in offline.sh gives, against tests/literals.expected, so a change in selectivity shows up
// in review. After an intended change: UPDATE_LITERALS=1 node tests/literals.mjs, and commit the file.
const dir = new URL('.', import.meta.url);
const terms = [...new Set([...readFileSync(new URL('offline.sh', dir), 'utf8').matchAll(/(?:^|\s)-[eav]\s+(['"])!?(\/.*?\/[dgimsuvy]*)\1/gm)].map(m => m[2]))].sort();
const got = terms.map(t => { const [, p, f] = /^\/(.*)\/(\w*)$/s.exec(t); return `${t}\t${JSON.stringify(requiredLiterals(new RegExp(p, f)))}`; }).join('\n') + '\n';
const expected = new URL('literals.expected', dir);
if (process.env.UPDATE_LITERALS) writeFileSync(expected, got);
else if (got !== readFileSync(expected, 'utf8')) fail(`the literals of offline.sh's regex terms changed; if intended, UPDATE_LITERALS=1 node tests/literals.mjs\n${got}`);

// Random regexes and lines, fixed seed (mulberry32)
let seed = 70;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const pick = xs => xs[Math.floor(rand() * xs.length)];
const CHARS = ['a', 'b', 'c', 'A', 'é', 'É', 'k', 'K', 'K', 's', 'ſ', ' ', '-', '.', '\r', '1', '﻿', '&', ':'];
const ATOMS = ['a', 'b', 'c', 'ab', 'abc', 'é', 'k', 's', ' ', '-', '\\.', '\\-', '\\d', '\\w', '\\W', '\\s', '\\b', '\\B', '.', '^', '$',
  '[ab]', '[^a]', '[a&&b]', '[\\]a]', '\\x61', '\\u0061', '\\1', '(?=a)', '(?!b)'];
const WORDS = ['abc', 'cab', 'kab', 'ssa', 'éab', 'a.b', 'a\\.b', 'K-a'];
const QUANT = ['', '', '', '?', '*', '+', '{2}', '{0,2}', '{1,}', '??', '*?', '+?', '{0,99999999999999999999999}', '{1,99999999999999999999999}'];
function gen(depth) {
  // A group takes only ?: a repeated group of repeated atoms backtracks exponentially on a line that almost matches
  const seq = () => Array.from({ length: 1 + Math.floor(rand() * 5) }, () => (depth < 2 && rand() < 0.15
    ? `(${pick(['', '?:', `?<g${depth}>`])}${gen(depth + 1)})${pick(['', '?', '??'])}`
    : (rand() < 0.4 ? pick(WORDS) : pick(ATOMS)) + pick(QUANT))).join('');
  return Array.from({ length: rand() < 0.3 ? 2 : 1 }, seq).join('|');
}
let tested = 0, withLits = 0;
for (let n = 0; n < 4000; n++) {
  let re;
  try { re = new RegExp(gen(0), pick(['', 'i', 'm', 's', 'u', 'iu', 'im'])); } catch { continue; }
  const lits = requiredLiterals(re);
  if (lits) withLits++;
  for (let k = 0; k < 300; k++) {
    // Mostly the pieces the regexes are made of, so that many lines match
    const text = Array.from({ length: Math.floor(rand() * 10) }, () => (rand() < 0.4 ? pick(CHARS) : pick(WORDS).replace('\\', ''))).join('');
    check(re, text);
    re.lastIndex = 0;
    if (lits && re.test(text)) tested++;
  }
}
if (withLits < 200 || tested < 2000) fail(`too few cases exercised: ${withLits} regexes with literals, ${tested} matching lines`);
console.log(`literals: ${withLits} regexes with literals, ${tested} matching lines checked`);

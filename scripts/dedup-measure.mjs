#!/usr/bin/env node
// How far --dedup folds a file, offline: no API calls. Uses sys1grep.mjs's own masks and grouping key, so the
// numbers follow the code. Bytes are what would be sent: each representative's original text, cut at 2,000
// characters as sys1grep cuts it, against every non-blank line.
//   node scripts/dedup-measure.mjs [--keep=num,time,...] FILE...
// --keep names the kinds Jev would keep apart for a meaning (url, path, time, hex, num); by default all fold.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const keep = (args.find(a => a.startsWith('--keep='))?.slice(7) ?? '').split(',').filter(Boolean);
const files = args.filter(a => !a.startsWith('--keep='));
if (!files.length) { console.error('usage: dedup-measure.mjs [--keep=num,time,...] FILE...'); process.exit(2); }

const src = readFileSync(new URL('../sys1grep.mjs', import.meta.url), 'utf8');
const { MASK, templateKey } = new Function(`${src.slice(src.indexOf('const DATE ='), src.indexOf('// Regex terms are never folded'))}return { MASK, templateKey };`)();
const bad = keep.filter(k => !MASK.some(([kind]) => kind === k));
if (bad.length) { console.error(`unknown kind: ${bad.join(', ')} (kinds: ${MASK.map(([k]) => k).join(', ')})`); process.exit(2); }
const kept = MASK.filter(([k]) => keep.includes(k)), fold = MASK.filter(([k]) => !keep.includes(k));

const bytes = s => Buffer.byteLength(s.slice(0, 2000));
console.log('| file | lines | templates | bytes sent |\n| --- | ---: | ---: | ---: |');
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const rep = new Map();
  for (const l of lines) { const k = templateKey(l, kept, fold); if (!rep.has(k)) rep.set(k, l); }
  const all = lines.reduce((n, l) => n + bytes(l), 0), sent = [...rep.values()].reduce((n, l) => n + bytes(l), 0);
  console.log(`| \`${file}\` | ${lines.length.toLocaleString('en')} | ${rep.size.toLocaleString('en')} | ${(100 * sent / all).toFixed(1)}% |`);
}

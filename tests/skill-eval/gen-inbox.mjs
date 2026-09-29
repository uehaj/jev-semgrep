// inbox.log for run.sh: ~6,000 benign log and ticket lines (EN/JA) with the 51 lines of tests/corpus.txt planted at fixed
// places. Deterministic: the same file every run (score.mjs's answer lines depend on it).  usage: node gen-inbox.mjs DIR
import { readFileSync, writeFileSync } from 'node:fs';
const corpus = readFileSync(new URL('../corpus.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
let seed = 42;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = a => a[rnd(a.length)];
const users = ['田中', '伊藤', '渡辺', '中村', '小林', '加藤', 'Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];
const items = ['マグカップ', 'ノートPC スタンド', 'キーボード', 'USB ケーブル', 'desk lamp', 'backpack', 'monitor arm', 'water bottle'];
const T = [
  () => `INFO  GET /api/orders/${rnd(90000)} 200 ${rnd(80) + 5}ms`,
  () => `INFO  cache hit ratio ${(80 + rnd(20))}% for key orders:${rnd(999)}`,
  () => `INFO  user ${pick(users)} signed in`,
  () => `INFO  order #${rnd(90000)} placed (${pick(items)} x${rnd(4) + 1})`,
  () => `INFO  invoice ${rnd(90000)} generated`,
  () => `DEBUG worker ${rnd(16)} picked job ${rnd(100000)} from queue default`,
  () => `INFO  scheduled report "weekly-sales" sent to ${rnd(40) + 2} recipients`,
  () => `WARN  deprecated field "legacy_id" used by client v${rnd(3) + 1}.${rnd(10)}`,
  () => `INFO  metrics flushed: ${rnd(5000)} points`,
  () => `ERROR validation failed for order #${rnd(90000)}: field "email" is not a valid address`,
  () => `ERROR payment declined for order #${rnd(90000)}: insufficient funds`,
  () => `ERROR template "receipt.html" failed to render: missing variable "tax_total"`,
  () => `ERROR invoice ${rnd(90000)} total mismatch: expected ${rnd(900)}.00, got ${rnd(900)}.50`,
  () => `INFO  connection pool size set to ${rnd(40) + 10}`,
  () => `INFO  websocket connection opened by user ${pick(users)}`,
  () => `ユーザー${pick(users)}さんからの問い合わせ: ${pick(items)}の在庫はいつ入りますか`,
  () => `ユーザー${pick(users)}さんからの問い合わせ: 営業時間を教えてください`,
  () => `ユーザー${pick(users)}さんからの問い合わせ: ${pick(items)}の色違いはありますか`,
  () => `ユーザー${pick(users)}さんからの問い合わせ: 領収書の宛名を会社名にできますか`,
  () => `${pick(users)}: Do you ship ${pick(items)} to Canada?`,
  () => `${pick(users)}: What sizes does the ${pick(items)} come in?`,
  () => `${pick(users)}: Can I add a gift message to my order?`,
  () => `${pick(users)}: Is there a student discount?`,
];
const N = 6000, at = corpus.map((_, i) => Math.round(((i + 1) * N) / (corpus.length + 1)) + rnd(40) - 20);
const out = [], truth = {};
let k = 0;
for (let n = 0; out.length < N + corpus.length; n++) {
  if (k < corpus.length && n >= at[k]) { out.push(corpus[k]); truth[k + 1] = out.length; k++; continue; }
  out.push(`2026-09-${String(10 + rnd(18)).padStart(2, '0')} ${String(rnd(24)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')} ${pick(T)()}`);
}
writeFileSync(`${process.argv[2] ?? '.'}/inbox.log`, out.join('\n') + '\n');
console.log(`inbox.log: ${out.length} lines; corpus planted: ${Object.keys(truth).length}`);

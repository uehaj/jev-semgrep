// Turns sys1grep's colored output (ANSI SGR codes) into a static terminal-like SVG for the README.
//   sys1grep --color=always ... | node scripts/ansi-svg.mjs '$ sys1grep ... \' '    ...' > docs/NAME.svg
// The arguments are the command shown above the output, one line each.
import { readFileSync } from 'node:fs';

const FG = '#cdd6f4', SGR = { 31: '#ff6b6b', 32: '#8ce99a', 33: '#ffd43b', 35: '#f5a3f5', 36: '#66d9e8', '01;31': '#ff5c7a', '01;33': '#ffd43b' };
const LH = 20, X = 16, CELL = 7.83; // 13px monospace
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wide = ch => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
const cells = s => [...s].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0);

const lines = [...process.argv.slice(2).map(l => [[l, FG]]), ...readFileSync(0, 'utf8').replace(/\n$/, '').split('\n').map(line => {
  const spans = [];
  let code = null;
  for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
    const m = part.match(/^\x1b\[([\d;]*)m$/);
    if (m) code = m[1] === '0' || m[1] === '' ? null : m[1];
    else if (part) spans.push([part, SGR[code] ?? FG, code?.startsWith('01;')]);
  }
  return spans;
})];
const W = Math.ceil(X * 2 + CELL * Math.max(...lines.map(l => cells(l.map(s => s[0]).join(''))))), H = lines.length * LH + 20;
process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
<rect width="100%" height="100%" rx="6" fill="#1e1e2e"/>
${lines.map((spans, i) => `<text x="${X}" y="${29 + i * LH}" xml:space="preserve">${spans.map(([t, c, b]) => `<tspan fill="${c}"${b ? ' font-weight="700"' : ''}>${esc(t)}</tspan>`).join('')}</text>`).join('\n')}
</svg>
`);

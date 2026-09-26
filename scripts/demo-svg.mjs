// Renders a few scenes of the landing page (docs/index.html) as an animated SVG for the README, which cannot run
// the page itself (GitHub strips scripts and iframes). The scenes' outputs are the page's, i.e. real runs.
//   node scripts/demo-svg.mjs > docs/demo.svg
import { readFileSync } from 'node:fs';

const PICK = ['Ask in one language, find every language', 'Propositions, not topics', '-Q finds the answer'];
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const from = html.indexOf('const S = [');
const S = new Function(`return ${html.slice(from + 'const S = '.length, html.indexOf('\n];', from) + 3)}`)();
const scenes = PICK.map(h => S.find(s => s.h === h) ?? (() => { throw new Error(`no scene: ${h}`); })());

const W = 920, LH = 20, TOP = 44, X = 18, COLS = 110; // COLS: monospace cells that fit in W at 13px
const C = { fg: '#cdd6f4', mute: '#6c7086', green: '#8ce99a', red: '#ff6b6b', cyan: '#66d9e8', title: '#ffffff' };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plain = s => s.replace(/<\/?[mu]>/g, '');
const cells = ch => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1);
const cut = (s, n) => { let w = 0, out = ''; for (const ch of s) { if ((w += cells(ch)) > n) return out + '…'; out += ch; } return out; };
const wrap = (s, n) => { const out = []; let line = ''; for (const word of s.split(' ')) { if (line && [...(line + ' ' + word)].reduce((a, c) => a + cells(c), 0) > n) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word; } return [...out, line]; };

// A scene is a list of lines; a line is a list of [text, color, bold?] spans.
function linesOf(s) {
  const lines = [[[s.h, C.title, 1]], ...wrap(s.c, COLS).map(t => [[t, C.mute]]), []];
  for (const st of s.steps ?? [{ cmd: s.cmd, rows: s.rows }]) {
    lines.push([['$ ', C.mute], [cut(st.cmd, COLS - 2), C.fg]]);
    for (const [n, text, p, keep] of st.rows) {
      if (!keep && !s.bars) continue; // what sys1grep prints: only matches, unless -t 0 shows every line
      const prob = p == null ? [] : [[`  [${p.toFixed(2)}]`, p >= 0.5 ? C.green : C.red]];
      lines.push([[String(n), C.green], [':', C.cyan], [cut(plain(text), COLS - 12), C.fg], ...prob]);
    }
    lines.push([]);
  }
  if (s.note) lines.push(...wrap(s.note, COLS).map(t => [[t, C.mute]]));
  return lines;
}

// Timing: each line appears 0.35 s after the one before it, the scene then holds, and the next replaces it.
const STEP = 0.35, HOLD = 5;
const plan = scenes.map(linesOf);
let t = 0;
const timed = plan.map(lines => { const start = t; t += lines.length * STEP + HOLD; return { start, end: t, lines }; });
const D = t, pct = x => ((x / D) * 100).toFixed(3);
const H = TOP + Math.max(...plan.map(l => l.length)) * LH + 16;

let css = '', body = '', k = 0;
timed.forEach(({ start, end, lines }, i) => lines.forEach((spans, j) => {
  if (!spans.length) return;
  const a = start + j * STEP, id = `l${k++}`;
  css += `.${id}{animation:${id} ${D}s linear infinite}@keyframes ${id}{0%,${pct(a)}%{opacity:0}${pct(a + 0.15)}%,${pct(end - 0.3)}%{opacity:1}${pct(end)}%,100%{opacity:0}}\n`;
  body += `<text class="a ${id}${i ? '' : ' s0'}" x="${X}" y="${TOP + j * LH}" xml:space="preserve">${spans.map(([s, c, b]) => `<tspan fill="${c}"${b ? ' font-weight="700" font-family="system-ui,sans-serif" font-size="15"' : ''}>${esc(s)}</tspan>`).join('')}</text>\n`;
}));

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
<title>sys1grep demo: ${scenes.map(s => s.h).join(' / ')}</title>
<style>
.a{opacity:0}
${css}@media (prefers-reduced-motion:reduce){.a{animation:none}.s0{opacity:1}}
</style>
<rect width="100%" height="100%" rx="10" fill="#1e1e2e"/>
<rect width="100%" height="28" rx="10" fill="#181825"/><rect y="18" width="100%" height="10" fill="#181825"/>
<circle cx="18" cy="14" r="5" fill="#ff5f57"/><circle cx="36" cy="14" r="5" fill="#febc2e"/><circle cx="54" cy="14" r="5" fill="#28c840"/>
<text x="74" y="18" fill="${C.mute}" font-size="12">sys1grep — real runs · full demo: uehaj.github.io/sys1grep</text>
${body}</svg>
`);

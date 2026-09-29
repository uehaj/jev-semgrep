// Score a run.sh output folder: per run and per variant x question. `fired` means the skill was read or sys1grep ran;
// on c2 it should not. A run with a denied tool call, or a Read outside its own folder, is marked invalid: it did not
// test the wording.  usage: node tests/skill-eval/score.mjs OUT   (SHOW=1 also prints every tool call)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const OUT = resolve(process.argv[2] ?? '.');
const HOME = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'projects');
// Answer lines of gen-inbox.mjs's inbox.log.
const H1 = [/legacy_id/, /slow query|遅いクエリ|3200|3\.2\s*秒/, /91\s*%|ディスク/], Q1 = [459, 705, 1027, 1282, 1505, 3590], C5 = [1604, 2058];
const said = s => [...(s.match(/^行[:：]\s*([\d,\s、]+)/gm) ?? [])].at(-1)?.match(/\d+/g)?.map(Number) ?? [];
const rows = [];
for (const f of readdirSync(join(OUT, 'results')).filter(f => f.endsWith('.json')).sort()) {
  const [arm, q, rep] = f.replace('.json', '').split('-');
  let r; try { r = JSON.parse(readFileSync(join(OUT, 'results', f), 'utf8')); } catch { rows.push({ arm, q, rep, score: 'no result' }); continue; }
  let score;
  if (q === 'h1') score = `${H1.filter(re => re.test(r.result)).length}/3`;
  else if (q === 'c2') score = /1,?071/.test(r.result) ? '1/1' : '0/1';
  else { const t = q === 'q1' ? Q1 : C5, s = said(r.result), hit = s.filter(n => t.includes(n)).length; score = `R ${hit}/${t.length} P ${hit}/${s.length}`; }
  const dir = join(OUT, 'runs', `${arm}-${q}-${rep}`);
  const p = join(HOME, dir.replace(/[^a-zA-Z0-9]/g, '-'), `${r.session_id}.jsonl`);
  const c = { skill: 0, sys1grep: 0, summarize: 0, grep: 0, read: 0, outside: 0 };
  if (existsSync(p)) for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
    const content = JSON.parse(l).message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_use') {
      const cmd = b.input.command ?? '';
      if (process.env.SHOW) console.log(`${arm}-${q}-${rep} ${b.name}: ${(cmd || b.input.pattern || b.input.file_path || b.input.skill || '').replace(/\s+/g, ' ').slice(0, 200)}`);
      c.skill += b.name === 'Skill'; c.grep += b.name === 'Grep'; c.read += b.name === 'Read';
      if (b.name === 'Read' && !resolve(b.input.file_path).startsWith(dir)) c.outside++;
      if (/sys1grep/.test(cmd)) c.sys1grep++; if (/--summarize/.test(cmd)) c.summarize++;
    }
  } else c.skill = '?';
  const denied = r.permission_denials?.length ?? 0;
  if (process.env.SHOW) for (const d of r.permission_denials ?? []) console.log(`${arm}-${q}-${rep} DENIED ${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 200)}`);
  rows.push({ arm, q, rep, score, invalid: denied || c.outside ? `denied ${denied}, outside ${c.outside}` : '', turns: r.num_turns,
    cost: +r.total_cost_usd.toFixed(3), ...c });
}
console.table(rows);
const by = {};
for (const x of rows.filter(x => !x.invalid && x.cost != null)) (by[`${x.arm} ${x.q}`] ??= []).push(x);
console.table(Object.entries(by).map(([k, v]) => ({ k, cost: +(v.reduce((s, x) => s + x.cost, 0) / v.length).toFixed(3),
  fired: `${v.filter(x => x.skill || x.sys1grep).length}/${v.length}`, scores: v.map(x => x.score).join(' | ') })));

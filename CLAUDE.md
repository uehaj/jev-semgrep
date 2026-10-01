# sys1grep

## Tests

| command | what | needs |
|---|---|---|
| `npm run test:offline` | `tests/offline.sh`: sys1grep against a fake Jev (`tests/fake-jev.mjs`). Expression, output shapes, `-A/-B/-C`, `--level`/`-t`/`-T`, `-p`, `--color`, `--chunk`, `-j`, `-q` (including the stop at the first match), `-Q`, auto-scope and `--no-auto-scope`, `--from` / `--to` (hops, `--reverse`, `--edges`, the refusals), `SYS1GREP_URL` and the auth header, `--help` | node, curl. No key, no network, same result every run, ~15s |
| `npm test` | `test:offline`, then `tests/check.sh`: the same options against real Jev on the fixtures | `SYS1GREP_API_KEY` (env, `./.env` or `~/.config/sys1grep/.env`); sends the fixtures to Jev, costs a little |
| `npm run scope-eval` | `tests/scope-eval.mjs`: auto-scope against real Jev on `tests/scope-corpus.tsv` (tune on this) and `tests/scope-holdout.tsv` (never tune on it): wrong / missed scopes per threshold, and the rows that differ | the key above; one small request per row (160), about 20 s |
| `npm run skill-eval -- OUT a=A/SKILL.md b=B/SKILL.md` | `tests/skill-eval/run.sh`: whether a sys1grep skill wording fires when it should (and not on a line count), and the cost per run, `claude -p` Sonnet on four questions about a generated 6,000-line log; score with `node tests/skill-eval/score.mjs OUT`. Run with `PREFLIGHT=1` first: it flags denied calls, which void a run | `CLAUDE_CONFIG_DIR` set to a logged-in config folder holding an empty `.skill-eval` file (its `skills/sys1grep` is replaced); about $0.06 a run, 16 per pair |
| `npm run judge` | `tests/judge.mts`: accuracy (P / R / F1 over a threshold sweep) against Claude's verdicts, written to `tests/report.md` | the key above and `claude -p`; slow, not pass/fail |

Run `npm run test:offline` after every change to `sys1grep.mjs`; run `npm test` before a push.

- The fake scores a line 0.9 when it contains the meaning verbatim, `N` when the line also carries `@N`, else 0.05.
  It understands the judging question (`Does line L000 match the meaning: "…"?`) and the auto-scope question
  (`Does the meaning "…" restrict its matches to …?`: 0.9 when the meaning carries `@s:KEY` for that question's
  key, e.g. `@s:l_python`) and the rank question (`Is result R000 relevant to: …?`: `N` when the result carries
  `@rN`, else 0.5); change them together.
- `offline.sh` unsets the key variables and points `HOME` at a temp dir, so no real key reaches the fake.
- Tune auto-scope (question wording, threshold) on `scope-corpus.tsv` only. Once you have tuned on
  `scope-holdout.tsv`, write a new holdout blind (without reading the code or the corpora).
- `check.sh` asserts only clear positives and negatives: Jev's probabilities drift by about ±0.05 between runs.
  A failure there can be the model, not the code; if `test:offline` passes, rerun and look at `-p` first.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for uehaj/sys1grep, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# semgrep

## Tests

| command | what | needs |
|---|---|---|
| `npm run test:offline` | `tests/offline.sh`: semgrep against a fake Jev (`tests/fake-jev.mjs`). Expression, output shapes, `-A/-B/-C`, `--level`/`-t`/`-T`, `-p`, `--color`, `--chunk`, `-j`, `-q` (including the stop at the first match), `-Q`, auto-scope and `--no-scope`, `SEMGREP_URL` and the auth header, `--help` | node, curl. No key, no network, same result every run, ~15s |
| `npm test` | `test:offline`, then `tests/check.sh`: the same options against real Jev on the fixtures | `SEMGREP_API_KEY` (env, `./.env` or `~/.config/semgrep/.env`); sends the fixtures to Jev, costs a little |
| `npm run scope-eval` | `tests/scope-eval.mjs`: auto-scope against `tests/scope-corpus.tsv` (tuned on) and `tests/scope-holdout.tsv` (never tuned on): per-label precision / recall, and the rows that apply a wrong scope | node. `--dry-run` only, sends nothing |
| `npm run judge` | `tests/judge.mts`: accuracy (P / R / F1 over a threshold sweep) against Claude's verdicts, written to `tests/report.md` | the key above and `claude -p`; slow, not pass/fail |

Run `npm run test:offline` after every change to `semgrep.mjs`; run `npm test` before a push.

- The fake scores a line 0.9 when it contains the meaning verbatim, `N` when the line also carries `@N`, else 0.05.
  It only understands the judging question (`Does line L000 match the meaning: "…"?`); change both together.
- `offline.sh` unsets the key variables and points `HOME` at a temp dir, so no real key reaches the fake.
- `offline.sh` runs `scope-eval --check`: no corpus row may apply a scope it should not. Don't tune the rules on
  `scope-holdout.tsv`; once you have, write a new holdout blind (without reading the rules or the corpora).
- `check.sh` asserts only clear positives and negatives: Jev's probabilities drift by about ±0.05 between runs.
  A failure there can be the model, not the code; if `test:offline` passes, rerun and look at `-p` first.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for uehaj/jev-semgrep, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# Changelog

All notable changes to `@uehaj/semgrep`. The format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) (until 1.0, option changes bump minor).

## [Unreleased]

### Security
- **Breaking:** `./.env` in the current directory is no longer read; only the environment and
  `~/.config/semgrep/.env` are. A `.env` committed to an untrusted repository could set `SEMGREP_URL` and send
  the API key and the searched text to another server. Load a per-project file explicitly with `node --env-file`.

## [0.3.0] - 2026-09-24

_(first npm release since 0.2.0: also carries 0.2.2, which was tagged but never published)_

### Added
- `-z` / `--null-data`: the unit of judgement becomes a NUL-terminated record instead of a line, so a
  record may span several lines. Matching records are printed NUL-terminated too, as in `grep -z`; file
  names and counts stay on newlines. `-n` numbers records, `-A`/`-B`/`-C` count records, `--chunk` counts
  records. Pairs directly with `git log -z`, `find -print0` and `xargs -0`, removing the two `tr` calls
  previously needed to flatten a record onto one line (#6).
- Other endpoints: `SEMGREP_URL` and `SEMGREP_MODEL` point semgrep at any TypeSafe-compatible `/v1/systemone`
  (OpenRouter, Vercel AI Gateway, a local server). Based on #4 by @nedzen.
- The summary line shows cost: the endpoint's `usage.cost` when reported, else for TypeSafe an estimate marked `~`.

### Changed
- The API key is now `SEMGREP_API_KEY`; `TYPESAFE_API_KEY` still works when it is not set. The key is sent to
  `SEMGREP_URL` as is; with `SEMGREP_URL` set and no key, no Authorization header is sent.
- **Breaking:** `SEMGREP_ENV` is gone. `./.env` then `~/.config/semgrep/.env` are still read.
- Network errors name the endpoint's host instead of `typesafe`.

## [0.2.2] - 2026-09-20

_(tagged only; not published to npm. Its changes reached npm in 0.3.0)_

_(includes what was briefly tagged v0.2.1; that tag was never published and has been removed)_

### Changed
- README: install section now presents the two ways to use it (command-line tool, Claude Code skill),
  and notes that the skill falls back to `npx` so no install is needed for skill-only use.
- README: "Use it from Claude Code" section for the `/uehaj:semgrep` skill (`uehaj/skills` marketplace),
  including single-skill install via the skills CLI.
- README: cross-lingual section now shows French, Russian, German, Spanish, Chinese and Korean, not just Japanese and English.
- Source comments translated to English.
- Added `RELEASING.md` and `scripts/release.sh` (`npm run release <bump>`).

### Added
- `tests/multi.txt`, `tests/fairy*.txt`, `tests/guild*.txt` corpora.

### Fixed
- `tests/judge.mts` no longer depends on `-T 1.01`, which the new range check rejects.
- `-c` prints `0` for files without a match, like grep.
- `-r` prefixes file names even when only one file is searched, like `grep -r`.
- Unreadable files are reported and skipped; the rest of the input is still searched; exit code is 2.
- Empty meanings (`-e ''`) are rejected.
- Help text: exit code 2 covers all errors, not only bad arguments.

### Changed
- `-r` skips `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`-style keys and `.ssh` / `.aws` / `.gnupg`,
  since every searched line is sent to the TypeSafe API. A file named explicitly is still searched.
- Blank lines are not sent to the API; they count as probability 0 for every meaning, so `-v X` prints them
  and `-e X` never does (grep -v semantics).
- The stderr summary line is printed only when stderr is a terminal.
- `docs/` is included in the npm package so the README image resolves.

## [0.2.0] - 2026-09-19

### Changed
- **Breaking:** `-c` now means "count matching lines per file" (grep -c). Lines per request moved to `--chunk=LINES`.
- `-t` / `-T` must be between 0 and 1.
- `-r` keeps the leading `./` in file names.

### Fixed
- Output no longer truncated when stdout is a pipe (`process.exitCode` instead of `process.exit()`).
- `--chunk 0` and `-j 0` no longer hang.
- `fetch` has a 60 s timeout; connection errors and 5xx are retried with backoff like 429 / 529.
- `-r` skips symbolic links (no infinite loops).
- `-C=10` and similar are rejected with a clear message instead of silently matching nothing.

### Added
- `tests/check.sh` covers `-l`, `-c`, `-r`, `-C`, out-of-range thresholds and `-C=1`.

## [0.1.1] - 2026-09-19

### Added
- `--help` in English, or Japanese when `LC_ALL` / `LC_MESSAGES` / `LANG` starts with `ja`.
- README: `npx @uehaj/semgrep` usage.

## [0.1.0] - 2026-09-19

First release as `@uehaj/semgrep`.

### Added
- Semantic grep: one `noul` question per line and meaning against TypeSafe Jev, 30 lines per request, 8 requests in parallel.
- Expression grammar: `-e` (OR), `-a` (AND), `-v` (AND NOT), `!MEANING` for per-meaning negation.
- Thresholds: `-t` (positive), `-T` (negative), presets `--level loose|normal|strict`.
- grep-compatible options: `-n`, `-r`, `-l`, `-A` / `-B` / `-C`, `--color[=WHEN]` (honors `NO_COLOR`).
- `-p` prints each meaning's probability, colored against the thresholds.
- API key lookup: `TYPESAFE_API_KEY`, `$SEMGREP_ENV`, `./.env`, `~/.config/semgrep/.env`.
- Errors are one line plus exit code 2, no stack traces.
- LLM-as-judge test (`tests/judge.mts`) with threshold sweep; self-check (`tests/check.sh`).

[Unreleased]: https://github.com/uehaj/jev-semgrep/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/uehaj/jev-semgrep/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/uehaj/jev-semgrep/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/uehaj/jev-semgrep/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/uehaj/jev-semgrep/compare/40b0d5d...v0.1.1
[0.1.0]: https://github.com/uehaj/jev-semgrep/commits/40b0d5d

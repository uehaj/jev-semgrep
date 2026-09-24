#!/usr/bin/env node
// git semgrep: semgrep over the files git tracks, as git grep does. git runs git-semgrep from PATH.
globalThis.SEMGREP_GIT = true; // not an environment variable: ./.env could set that for plain semgrep
await import('./semgrep.mjs');

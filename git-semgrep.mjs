#!/usr/bin/env node
// git semgrep: semgrep over the files git tracks, as git grep does. git runs git-semgrep from PATH.
process.env.SEMGREP_GIT = '1';
await import('./semgrep.mjs');

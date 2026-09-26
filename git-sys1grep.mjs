#!/usr/bin/env node
// git sys1grep: sys1grep over the files git tracks, as git grep does. git runs git-sys1grep from PATH.
globalThis.SYS1GREP_GIT = true; // not an environment variable: ./.env could set that for plain sys1grep
await import('./sys1grep.mjs');

# sys1grep

grep by meaning: lines are judged by Jev against meanings written in natural language. `git sys1grep` searches what git knows about, as `git grep` does.

## Language

### Where to search (git sys1grep)

**Working tree**:
The checked-out files of a repository; what `git sys1grep` searches by default.
_Avoid_: worktree files, local files

**Index**:
The staged contents (blobs registered for the next commit); searched with `--cached`, whether or not the file still exists in the working tree.
_Avoid_: staging area, cache

**Tree**:
A revision named on the command line (branch, tag, commit, `@{u}`) whose contents are searched instead of the working tree. Results carry the name as typed (`@{u}:path`), never the resolved one.
_Avoid_: revision, ref, snapshot

**Target**:
One regular file or blob that is searched: from the working tree, the index or a tree. Symlinks and submodules are never targets.
_Avoid_: source (the code uses `sources` for the units printed)

### What is judged, and multi-step matching

**Unit**:
What Jev judges in one question and what is printed for a match: a line, a record (`-z`), a sentence, or a function (`--unit=function`).
_Avoid_: chunk (a chunk is a batch of units sent in one request, `--chunk`), block

**Multi-step matching**:
A search that matches a Start, walks Edges from it one Hop at a time, and matches an End among the Units it reaches (`--from`, `--to`, `--hops`). Jev judges the Start and the End; no score decides the route.
_Avoid_: trace, chaining, explain (a closed loop in which an LLM chose the next search)

**Start**:
The Units that match the `--from` expression. They are Hop 0.
_Avoid_: seed, root, source

**End**:
The Units among those reached that match the `--to` expression.
_Avoid_: target (a Target is a searched file or blob), sink, goal

**Edge**:
One directed link from one Unit to another: a call by default (caller to callee), or a line of `--edges=FILE`. `--reverse` walks Edges backwards.
_Avoid_: call (only one kind of Edge), reference, arc

**Hop**:
The shortest number of Edges from any Start to a Unit. `--hops` selects Units by it: `N` exactly, `M..N` with both ends included, `M..` with no upper bound.
_Avoid_: step, depth, round, level (`--level` is the strict/loose threshold)

**Path**:
The Units from a Start to an End along Edges, printed with each Unit's Hop.
_Avoid_: chain, trail

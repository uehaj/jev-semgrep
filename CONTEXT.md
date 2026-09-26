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

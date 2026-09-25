---
id: 012-git-through-the-git-binary
title: "ADR-012: Git operations run the git binary, not a linked library"
summary: Why every git operation shells out to the user's `git` rather than
  linking libgit2, what that guarantees about hooks, configuration and
  worktrees, and the parsing cost it accepts.
related:
  - 007-workspace-is-one-directory
  - 008-tauri-v2-on-arch-kde
  - standards-code
---

# ADR-012: Git operations run the git binary, not a linked library

## Context

The git panel needs status, diffs, staging of files and hunks, commits,
history, blame, branches and worktrees. Two implementations are available to a
Rust backend: link libgit2 through the `git2` crate, or run the `git` binary
already on the machine and parse its output.

Key forces:

- **Hooks have to run.** A commit made from the panel is expected to behave as
  one made in the terminal, including a hook refusing it and its output
  reaching the user.
- **The user's configuration is extensive.** Credential helpers, commit
  signing, `core.hooksPath`, sparse checkouts, `worktree.guessRemote`, and
  every alias and default git honours.
- **Worktrees are central** (`007-workspace-is-one-directory`), and their
  semantics — prune, lock, the common directory — are git's to define.
- **git is already a dependency.** The file tree asks `git check-ignore` which
  paths are ignored and `git ls-files` which files exist, so that the tree never
  disagrees with `git status`.

## Decision

Every git operation runs the `git` binary with `-C <workspace>` and parses its
output: porcelain v2 for status, `for-each-ref` for branches, `worktree list
--porcelain` for worktrees, `--line-porcelain` for blame, and `%x1f`-separated
formats for logs. Hunks are staged by piping a one-hunk patch to
`git apply --cached`. No git library is linked.

Every invocation sets `GIT_OPTIONAL_LOCKS=0`. A `git status` otherwise takes
and drops `index.lock` inside the git directory the watcher watches, the
watcher reports the change, and the refresh it starts runs `git status` again,
five times a second for every repository. A shell prompt or an agent runs
`git status` without that setting, so the watcher also drops every `*.lock`
path inside a git directory: a real change to the index, `HEAD` or a ref ends
in a rename to its final name, which it still reports. The workspace summary
behind the selector and the status bar reads `rev-parse` and `for-each-ref`
with `%(upstream:track)`, never `status`, so refreshing it walks no working
tree. A stash is named by its commit, not
its `stash@{N}` position: `git_stash_apply` and `git_stash_drop` look the
position up again in `stash list`, and refuse a stash that is gone, since a
stash pushed or dropped from a terminal renumbers the ones below it.

## Rationale

- Hooks run, signing happens, credential helpers are consulted, and every
  refusal git makes arrives verbatim as the error the user sees.
- Worktree behaviour is git's own, so a worktree created here is
  indistinguishable from one created in the terminal.
- The porcelain formats are stable interfaces git documents for scripts.
- One process per operation costs milliseconds, and no operation here is on a
  keystroke path.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **libgit2 through `git2`** | No process spawns and typed results, and it runs no hooks, reads only part of the configuration, has its own credential handling, and lags git on worktree features — so the panel would behave differently from the terminal beside it. |
| **A mix: libgit2 for reads, the binary for writes** | Faster reads, and two implementations of every path concept whose answers can differ. |

## Consequences

**Easier:**
- Any git feature is reachable by adding one argument list and one parser.
- Nothing about the repository is cached outside git, so the terminal and the
  panel cannot disagree.

**Harder:**
- Every result is text to parse, and a porcelain format change is a defect
  here rather than a compile error.
- A repository with tens of thousands of untracked files makes `status` slow,
  as it does in the terminal.

## Constraints imposed

- **`GIT_TERMINAL_PROMPT=0` on every invocation**, so an operation that would
  ask for credentials fails with a message instead of hanging.
- **Refusals are surfaced, never forced.** A checkout, branch delete or
  worktree removal that git declines returns git's text; forcing is a separate,
  confirmed action.
- **Ignored, tracked and untracked are git's answers**, taken from
  `check-ignore`, `ls-files` and `status`, never recomputed.

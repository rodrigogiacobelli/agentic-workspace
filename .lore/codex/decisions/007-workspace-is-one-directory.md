---
id: 007-workspace-is-one-directory
title: "ADR-007: A workspace is exactly one directory"
summary: Why a workspace maps to a single directory rather than a named set of
  roots, why the list is curated by hand rather than discovered by scanning, and
  how that makes a git worktree an ordinary workspace.
related:
  - vision-agentic-workspace
  - 002-backend-owned-terminal-sessions
  - 004-central-settings-store
---

# ADR-007: A workspace is exactly one directory

## Context

The workspace is the unit everything else hangs from — file tree, editor tabs,
terminals, git context, settings. Its definition decides how much of the rest
of the product is ambiguous.

Key forces:

- **Every subsystem needs one unambiguous root.** A terminal starts somewhere,
  a search runs somewhere, a relative asset path resolves against something.
- **Git operates on one repository at a time.** Branch, status, history and
  worktree commands need a single repository to act on.
- **A project is often a worktree** of another project, living at a different
  path and carrying a different branch.

## Decision

A workspace is exactly one directory. The list is curated by hand: a directory
becomes a workspace when the user adds it, and stops being one when the user
removes it.

A git worktree is not a special case. It is a directory, so it is a workspace
like any other.

## Rationale

- Every subsystem gets one root with no disambiguation rule — no "which root
  does this terminal start in", no "which repository does this commit go to".
- A curated list is a list of projects being worked on. A scan is a list of
  directories on disk, most of which are not.
- Making a worktree an ordinary workspace means branch-per-workspace works with
  no additional concept: two branches of one project are two workspaces, each
  with its own terminals and its own documents.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A workspace holds several roots** | Suits a repository split into services, and makes every root-relative operation ambiguous: which root a new terminal starts in, which repository the git panel acts on, what an asset path is relative to. |
| **Auto-discover a projects directory** | Removes the setup step, and lists every repository on disk whether or not it is being worked on, while missing anything outside the scanned root. |
| **A workspace is a git repository** | Matches the common case, and excludes directories that are not repositories — notes, documents, scratch directories — which are ordinary things to want open. |

## Consequences

**Easier:**
- Terminals, search, asset paths and git all resolve against one root.
- Branch-per-workspace needs no new concept; a worktree is added like any
  other directory.

**Harder:**
- Working across two repositories at once means two workspaces and a switch.
- A directory that is not a git repository has to degrade cleanly everywhere
  git appears.
- Worktree deletion has to account for a workspace being open inside it.

## Constraints imposed

- **Creating a worktree offers to open it as a workspace**, and a workspace
  inside a worktree is labelled so its parent project and branch are both
  legible.
- **Deleting a worktree that holds an open workspace is refused until
  confirmed**, naming the running processes and any uncommitted work in it.
- **A non-repository workspace is a supported state.** The git panel says so
  and offers to initialise; nothing else changes behaviour.

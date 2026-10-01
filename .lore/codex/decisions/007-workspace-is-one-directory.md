---
id: 007-workspace-is-one-directory
title: 'ADR-007: A workspace is exactly one directory'
summary: Why a workspace maps to a single directory rather than a named set of roots,
  why the roots are curated by hand rather than discovered by scanning, and how that
  makes a git worktree, and a repository found directly inside a root, an ordinary
  workspace whose family shares one terminal list.
related:
- vision-agentic-workspace
- 002-backend-owned-terminal-sessions
- 004-central-settings-store
- 012-git-through-the-git-binary
- 015-views-and-citations
- 020-workspace-family
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

A workspace is exactly one directory. The roots are curated by hand: a
directory becomes a root when the user adds it, and stops being one when the
user removes it. The repositories directly inside a root's folder are found by
one directory listing and become workspaces of their own, the root's children
(WS-12). A root, its children and the worktrees of either open as workspaces
make a workspace family, and the family shares one terminal list
(`020-workspace-family`). Every member of a family is one directory.

A git worktree is not a special case. It is a directory, so it is a workspace
like any other, listed under its repository's row whenever that repository is
open, however it was opened.

## Rationale

- Every subsystem gets one root with no disambiguation rule — no "which
  repository does this commit go to", no "which folder does this search run
  in". Where a new terminal starts is the one choice a family adds, and a
  setting makes it: the family's root, or the workspace on screen (TERM-17,
  TERM-18).
- A curated list of roots is a list of projects being worked on. A scan of a
  disk or of a projects directory is a list of directories, most of which are
  not; one listing of a folder the user added, one level deep, lists what the
  user keeps there (WS-12, WS-15a).
- Making a worktree an ordinary workspace means branch-per-workspace works with
  no additional concept: two branches of one project are two workspaces, each
  with its own documents, Explorer and Source Control, in one family that
  shares its terminals (TERM-16).

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A workspace holds several roots** | Suits a repository split into services, and makes every root-relative operation ambiguous: which root a new terminal starts in, which repository the git panel acts on, what an asset path is relative to. |
| **Auto-discover a projects directory** | Removes the setup step, and lists every repository on disk whether or not it is being worked on, while missing anything outside the scanned root. The one listing a family gets reads a folder the user added, one level deep (`020-workspace-family`). |
| **A workspace is a git repository** | Matches the common case, and excludes directories that are not repositories — notes, documents, scratch directories — which are ordinary things to want open. |

## Consequences

**Easier:**
- Search, asset paths, the Explorer and git all resolve against one directory.
- Branch-per-workspace needs no new concept; a worktree is added like any
  other directory.

**Harder:**
- Working across two repositories at once means two workspaces and a switch;
  inside one family, the switch keeps the same terminals on screen.
- A directory that is not a git repository has to degrade cleanly everywhere
  git appears.
- Worktree deletion has to account for a workspace being open inside it, and
  for shells of any family running inside it.

## Constraints imposed

- **Creating a worktree offers to open it as a workspace**, and a workspace
  inside a worktree is labelled so its parent project and branch are both
  legible.
- **Deleting a worktree asks first**, naming the workspace open on it, every
  terminal of any family whose shell's directory is inside it, and any
  uncommitted work in it; confirming closes those terminals before git removes
  the worktree (TERM-22).
- **A non-repository workspace is a supported state.** Source Control's panels
  say so and Commit offers to initialise; nothing else changes behaviour.
- **A document reaches past its directory only into its worktree family.** A
  linked worktree's documents render files from its main checkout, and a main
  checkout's from its linked worktrees (`015-views-and-citations`). A file
  from the worktree family opens in the open workspace that holds it, a member
  of the workspace family on screen before an entry of another family on the
  same folder (CITE-23). Terminals are the one other reach: a new terminal
  starts at the family's root unless `terminalOpenIn` says otherwise, and a
  path printed in a family shell opens in the member of the family holding it
  (TERM-17, TERM-24). Every other operation keeps to the one directory.

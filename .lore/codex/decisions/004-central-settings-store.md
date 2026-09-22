---
id: 004-central-settings-store
title: 'ADR-004: Settings live in a central store, never in the user''s repos'
summary: Why per-project settings are keyed by path in the application's own store
  under the XDG data directory instead of a dotfile at the project root, and what
  that costs in portability.
related:
- vision-agentic-workspace
- 007-workspace-is-one-directory
- standards-repository
- 014-one-layout-tree
---

# ADR-004: Settings live in a central store, never in the user's repos

## Context

Several settings are per project: which folder receives pasted assets, a theme
override, notification behaviour, the editor group layout. They have to be
stored somewhere keyed to the project.

Key forces:

- **The projects opened are other people's repositories** as often as they are
  the user's own. Writing into them has consequences beyond this application.
- **A new file at a project root is not free.** It is either committed, and
  imposed on everyone working in that repository, or ignored, which means
  editing that repository's `.gitignore`.
- **Settings here are one person's preferences**, not project policy. Where
  pasted screenshots land is a habit, not a rule a repository needs to carry.

## Decision

All settings — global and per project — live in the application's own store
under `~/.local/share/<app-id>/`, with per-project settings keyed by absolute
path. The application writes nothing inside any workspace directory.

## Rationale

- A workspace can be added and removed with no trace left in the directory it
  pointed at.
- It cannot produce a spurious `git status` entry, a stray commit, or a
  `.gitignore` edit in a repository the user does not own.
- One store is one thing to back up, inspect and reset.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A committed file at the project root** | Travels with the repository and is readable by an agent, but imposes one person's editor preferences on every contributor and adds a file to repositories the user may not own. |
| **An ignored file at the project root** | Keeps settings next to the project without committing them, but still writes into someone else's repository and requires editing its `.gitignore`. |
| **Central by default, repo file overrides** | Covers both, but doubles the lookup path and the failure modes for a benefit nobody has asked for. |

## Consequences

**Easier:**
- Opening any directory as a workspace is a read-only act with respect to that
  directory.
- Removing a workspace leaves nothing behind.

**Harder:**
- Settings do not travel with a repository, to another machine, or to another
  person.
- Entries are keyed by absolute path, so moving a project orphans its settings
  until the workspace is relocated.
- Two worktrees of one project are two keys and share nothing.

## Constraints imposed

- **The store is at `~/.local/share/<app-id>/`**, alongside session state.
- **A corrupt or newer-versioned store is moved aside, never deleted**, and the
  application starts with an empty workspace list and says what happened.
- **Nothing is written into a workspace directory** other than a file the user
  explicitly creates — a saved document, or an asset pasted into one.

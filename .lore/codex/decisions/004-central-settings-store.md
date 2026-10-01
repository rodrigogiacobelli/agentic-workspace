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
- 019-credentials-through-the-secret-service
- 020-workspace-family
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
path. The application writes nothing inside any workspace directory. Two
workspace entries on one folder — a root the user added and a child a scan
found there (`020-workspace-family`) — share that folder's one entry. The
global settings in `settings.json` include `terminalOpenIn`, where a new
terminal starts (TERM-17, TERM-18), and `confirmDelete`, whether a trash from
the file tree asks first (SET-05).

Credentials follow the same rule without their secrets
(`019-credentials-through-the-secret-service`). `settings.json` lists the SSH
keys — by the path of the key file in `~/.ssh` — and the commit identities, and
each workspace's entry names the key and the identity it uses and whether its
terminals carry them; a passphrase lives in the desktop's Secret Service and
nowhere in the store. Only the backend's credential commands change those
fields. The frontend sends the whole settings object back on every change, so
`update_settings` copies `credentials` and every workspace's `sshKey`,
`identity` and `terminalCredentials` from the backend's current value over
whatever arrives, and a settings write holds the lock from the change through
the file write and the emit, so the last writer's state is the one on disk and
the one the windows hear last.

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
- Two worktrees of one project are two keys and share nothing, with one
  exception: a linked worktree whose SSH key or commit identity is unset takes
  its repository's. Its theme and clipboard folder are its own. So are its
  notifications and terminal option, which govern no shell while it is a
  member of a family: the family's shells follow the root's
  (`020-workspace-family`).
- Two entries on one folder cannot hold different settings: a choice made on
  either one's Workspace page applies to both.

## Constraints imposed

- **The store is at `~/.local/share/<app-id>/`**, alongside session state.
- **A corrupt or newer-versioned store is moved aside, never deleted**, and the
  application starts with an empty workspace list and says what happened. An
  unreadable `settings.json` is moved aside the same way, to
  `settings.json.unreadable-<seconds>`. The Workspace window says either in a
  dialog that stays until the user presses *OK*, never in a toast (NTF-04),
  and for `settings.json` the dialog says that every workspace's SSH key,
  commit identity and terminal credentials were reset with it.
- **No secret is written to the store.** A field that would hold one does not
  exist.
- **Nothing is written into a workspace directory** other than a file the user
  explicitly creates — a saved document, or an asset pasted into one.

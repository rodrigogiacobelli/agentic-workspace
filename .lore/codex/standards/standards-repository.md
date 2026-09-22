---
id: standards-repository
title: Repository standard
summary: Where files belong in this repository — the git-ignored working
  directory for throwaway output, the clean-worktree rule, the split between
  docs/, the codex and CLAUDE.md, and the commit conventions.
related:
  - standards-testing
  - 004-central-settings-store
---

# Repository standard

## Throwaway files go in `working/`

`working/` at the repository root holds everything transient: scratch scripts,
experiment output, one-off analysis, screenshots, draft text, downloaded
samples. The root `.gitignore` excludes `**/working/**`, so nothing in it is
ever committed.

Nothing transient is written anywhere else — not at the repository root, not in
`docs/`, not beside source.

## The worktree is left clean

A piece of work ends with `git status` clean: no untracked scratch files, no
half-applied edits, no commented-out blocks kept for later. Work kept for later
belongs in a commit on a branch, in `working/`, or in a Lore mission.

## Where knowledge belongs

Four locations, and each holds one thing:

| Location | Holds | Test |
|---|---|---|
| `README.md` | What the product is, for someone who has not seen it | Would a stranger need it? |
| `docs/acceptance-criteria.md` | Specified behaviour, as Given / When / Then with stable ids | Is it a behaviour someone could verify? |
| `.lore/codex/` | What is true about the system, and why it is shaped that way | Would deleting it lose information? |
| `CLAUDE.md` | How to work in this repository | Is it an instruction to the reader rather than a fact about the system? |

The codex holds no duplicate of the other three. A codex document that needs a
behaviour cites its acceptance-criteria id.

`.lore/codex/conceptual/` and `.lore/codex/technical/` hold facts about a
running system. They stay empty until there is one.

## Acceptance criteria ids are stable

An id in `docs/acceptance-criteria.md` — `ED-07`, `BR-08`, `PLT-04` — is a
permanent handle. Criteria are added with new ids and removed by deletion. An
existing id is never reassigned to a different behaviour, because commits,
missions and codex documents cite it.

## Commits

- One commit is one coherent change.
- The subject line says what the change does, in the imperative, under 72
  characters.
- The body says why, where the reason is not obvious from the diff.
- A commit implementing specified behaviour cites its criterion ids.
- Generated files, dependency lock files and source changes are separate
  commits where they can be separated.

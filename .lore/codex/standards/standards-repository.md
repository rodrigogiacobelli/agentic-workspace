---
id: standards-repository
title: Repository standard
summary: Where files belong in this repository — the two destinations for written
  material, the git-ignored working directory that holds everything transient, the
  clean-worktree rule, the stability of acceptance-criteria ids, and the commit conventions.
related:
- standards-testing
- 004-central-settings-store
---

# Repository standard

## Two destinations, and no third

Written material goes to one of two places:

| Destination | Holds | Version controlled |
|---|---|---|
| `.lore/codex/` | Documentation — what is true about the system, and why it is shaped that way | Yes |
| `working/` | Everything else — transient, in-flight, throwaway | No |

There is no `docs/` directory. Two files sit at the repository root as
fixtures: `README.md`, which describes the product to someone who has not seen
it, and `CLAUDE.md`, which says how to work here.

A file that is neither codex documentation nor one of those two fixtures
belongs in `working/`.

## `working/` is git-ignored

`working/` holds scratch scripts, experiment output, one-off analysis,
screenshots, drafts, downloaded samples, and the in-flight specification. The
root `.gitignore` excludes `**/working/**`, so nothing in it is committed and
nothing in it survives a fresh clone.

Nothing transient is written anywhere else — not at the repository root, not
beside source.

## The worktree is left clean

A piece of work ends with `git status` clean: no untracked scratch files, no
half-applied edits, no commented-out blocks kept for later. Work kept for later
belongs in a commit on a branch, in `working/`, or in a Lore mission.

## The specification is in-flight, the codex is durable

`working/acceptance-criteria.md` holds specified behaviour as Given / When /
Then criteria, each with a stable id and a priority. It describes a system that
does not exist, which is why it sits outside the codex: the codex records what
is true today, and `.lore/codex/conceptual/` and `.lore/codex/technical/` stay
empty until there is a running system to describe.

As behaviour is built, its facts move into those layers. The specification
shrinks as the codex grows.

## Acceptance-criteria ids are permanent handles

An id — `ED-07`, `BR-08`, `PLT-04` — is cited from commit messages, Lore
missions and codex documents. Criteria are added with new ids and removed by
deletion. An existing id is never reassigned to a different behaviour, because
a citation elsewhere would then point at something it never described.

## Commits

- One commit is one coherent change.
- The subject line says what the change does, in the imperative, under 72
  characters.
- The body says why, where the reason is not obvious from the diff.
- A commit implementing specified behaviour cites its criterion ids.
- Generated files, dependency lock files and source changes are separate
  commits where they can be separated.

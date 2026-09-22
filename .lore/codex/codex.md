---
id: codex
title: Codex
summary: The single bootstrap doc a fresh-project agent reads to learn what Lore
  is, the entities it tracks, the documentation system on top, and where to go
  for deeper guidance. Read this before any other file under .lore/.
---

# Codex

This file describes the **codex** — Lore's typed documentation graph under `.lore/codex/`. It tells you how the codex is organised, how to read and write docs, and what NOT to put in it. For Lore itself (what the entities are, how to run missions), see `.lore/docs/LORE-AGENT.md` (or your project's agent doc).

Everything is reachable from the CLI — every command group accepts `--help`.

## The codex

`.lore/codex/` is a graph of typed markdown docs. Every doc has frontmatter (`id`, `title`, `summary`, optional `related`, optional `binds`, optional `rites`) and a body. `lore health --scope codex` enforces this — no other fields, unless the project declares them in an add-only overlay at `.lore/custom-schemas/<kind>.yaml` (the `update-custom-schema` skill). Overlays cover canonical docs and `sources/` only; `transient/` docs always validate against the packaged schema. `lore health --scope voice` audits the prose inside those bodies against the codex voice rules (`lore artifact show codex-voice`).

Docs live under subdirectories that scope intent. The set below is what `lore init` *expects* a fresh project to use; the dirs are created on demand by `lore codex new --group <subdir>`.

| Directory       | Purpose                                                                       |
|-----------------|-------------------------------------------------------------------------------|
| `decisions/`    | ADRs — why a choice was made and what alternatives were rejected              |
| `standards/`    | how-to-comply rules for code, design, conventions                             |
| `technical/`    | how the system is built, stored, served (incl. `technical/<domain>/ref/`)     |
| `conceptual/`   | what the system looks like from the outside — entities, relationships, flows  |
| `vision/`       | product direction, long-arc goals                                             |
| `operations/`   | dev, deploy, run, runbooks                                                    |
| `sources/`      | verbatim upstream snapshots (Jira, transcripts) — safe to delete after distil |
| `transient/`    | in-flight work products — safe to delete after the feature ships; packaged schema only |

`codex.md` and `glossary.yaml` live at `.lore/codex/` root, not under a subdir. Other subdirs (`constraints/`, `personas/`, `integrations/`, `security/`) are optional — create them on first use via `lore codex new --group <subdir>`.

## The Three Content Classes

Every codex file belongs to exactly one of three classes, defined by its top-level directory and by one question: **what happens when you delete it?**

| Class    | Directory                                                                                   | Deletion test                                                                                       |
|----------|---------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Stable   | `decisions/`, `standards/`, `technical/`, `conceptual/`, `vision/`, `operations/`           | Deleting any file LOSES information. Never safe.                                                    |
| In-Flight | `transient/`                                                                               | Safe to delete **after** the in-flight feature ships and its facts have been folded into stable docs. Packaged schema only — no custom-schema overlay. |
| Sources  | `sources/<system>/<id>.md`                                                                  | Safe to delete **at any time**. Every fact worth keeping already lives in a stable doc.             |

## Reading the codex

| Verb                            | Use                                                                          |
|---------------------------------|------------------------------------------------------------------------------|
| `lore codex list`               | the index — start here                                                       |
| `lore codex show <id> [<id>...]`| read one or many; auto-attaches matched glossary terms                       |
| `lore codex search <keyword>`   | full-text search across id / title / summary / body                          |
| `lore codex map <id>`           | bidirectional traversal of `related`, depth-1 by default                     |
| `lore codex chaos <id>`         | random-walk discovery; `--threshold 30..100` required                        |

Prefer batching IDs in one `show` call over multiple calls. For deeper investigation patterns, read the `retrieve-memory` skill.

## Writing the codex

Three CRUD verbs and the field-edit flags:

```
lore codex new <name> --group <subdir> -f <file>
lore codex edit <name> --set KEY=VALUE
lore codex edit <name> --add KEY=VALUE        # list-typed fields (related, binds)
lore codex edit <name> --unset KEY
lore codex edit <name> --remove KEY=VALUE     # list-typed fields
lore codex edit <name> -f <file>              # replace body from a file
lore codex delete <name>
```

Frontmatter is exactly `id`, `title`, `summary`, optional `related`, optional `binds`, optional `rites`. `lore health --scope codex` rejects extras — except keys the project declares in a `.lore/custom-schemas/<kind>.yaml` overlay, which do not apply under `transient/`. `lore health --scope voice` audits what you write in the body.

Do not write codex files by hand with `cat >` or an editor — drive every change through the CLI so frontmatter normalisation and validation run. For the full discovery → classify → dedup → apply → verify workflow, read the `store-memory` skill.

### Voice

Every canonical codex doc speaks with one voice: present tense about current state, written for a reader who arrives cold with no conversation behind them. The rules live in one file:

```
lore artifact show codex-voice
```

Read it before writing or editing any doc under `.lore/codex/`. It holds the ten rules, the two tests that settle a borderline sentence, and the per-layer table naming which rules bind which layer — `decisions/` and `transient/` get different tense budgets, `sources/` is exempt, `vision/` is skipped.

Then check your work:

```
lore health --scope voice
```

It pattern-matches the mechanical rules and reports each hit as a warning. The scope never changes the exit code, and four of the ten rules need judgment no pattern supplies — a clean run is not a pass. Read those four yourself before you close a doc.

## The glossary

`.lore/codex/glossary.yaml` is the project's controlled vocabulary — small, project-specific terms only. Entities and named workflows do NOT belong; they live in their own codex docs.

```
lore glossary list / search / show
lore glossary new <keyword> --definition "<text>"
lore glossary edit <keyword> --set KEY=VALUE
lore glossary delete <keyword>
```

Before adding a term, run `lore artifact show glossary-design` — it is the three-question gate that keeps the glossary lean.

## The impacts engine — codex ↔ code bindings

A codex doc may declare `binds: [<path-or-glob>, ...]` in its frontmatter. Each entry is either a literal repo-root-relative path or a glob (recursive `**` supported). `lore impacts <path>` returns the codex docs governing a file; `lore impacts <codex-id>` returns the files a doc governs.

Use cases: read governing docs before editing a file; assess a doc's reach across the repo. Absolute paths, `..` segments, and empty strings are rejected by the schema and surfaced by `lore health --scope schemas`.

For workflow details — when to populate `binds:`, glob semantics, examples — read the `store-memory` skill.

### Linking a codex doc to the rites it governs

A **rite** is procedural memory — how to do or diagnose a recurring task — stored as YAML under `.lore/rites/main/`, a sibling of the codex. See `.lore/docs/LORE-AGENT.md` for the entity descriptions, and `lore artifact show rite-design` for authoring.

A codex doc may declare `rites: [<rite-id>, ...]` — the ids of the rites that this doc governs. This is the **codex→rite edge**: the link lives only on the codex side, and rites never link back (no `related`, no `binds` on a rite). The one-way direction is fixed by ADR-014 (`decisions-014-link-direction`) — the stable codex doc owns the pointer because a change to it can force a change to the rites built on it. Each entry is a plain rite id slug, not a path or glob. `lore health --scope codex` validates every `rites:` id resolves to an existing rite.

## Sources layer

Files at `sources/<system>/<id>.md` hold raw upstream material — Jira tickets, meeting transcripts, chat threads, pasted documents — captured verbatim as point-in-time snapshots. Sources are never canonical; every fact worth keeping must be propagated into a stable doc before the source becomes deletable.

### Sources layout

Files live at `sources/<system>/<id>.md` where `<system>` is a free-form slug (e.g. `jira`, `slack`, `meetings`) and `<id>` is unique within that system. Example: `sources/jira/KONE-23335.md`.

### Sources frontmatter rule

Source files carry exactly four fields: `id`, `title`, `summary`, `related`. All four are required. `related` is non-empty and lists every canonical codex doc the source caused to change.

### Verbatim rule

Source bodies are preserved verbatim. Light reformatting is permitted only when the upstream format is structurally unreadable (e.g. Atlassian ADF → markdown).

### One-way linking

Sources MUST link outward. Canonical docs MUST NOT include a source ID in their `related` list — `lore health` rejects this as `canonical_links_to_source`.

### Refresh rule

Re-ingestion overwrites the snapshot file. No history file. Previous content lives only in git history.

For the ingest-and-distil workflow, and for re-pulling an existing snapshot and propagating the diff, use the `store-memory` skill.

## Reference docs (`ref-*`)

Reference docs capture **intent around** concrete technical artifacts — DB tables, API endpoints, models, events, jobs — without mirroring schema. Schema lives in the source of truth (DDL, OpenAPI, ORM); the codex never owns it.

**Location.** `<technical-domain>/ref/` — e.g. `technical/database/ref/`, `technical/api/ref/`.

**ID convention.** `ref-<system>-<concept>`. Examples:

- `ref-orders_db-checkout` — covers `orders`, `line_items`, `shipments`
- `ref-billing_db-ledger` — covers `entries`, `accounts`, `postings`
- `ref-orders_db-line_items` — single-entity doc when one entity carries intent its cluster does not

**Granularity.** One doc per logical cluster, not per entity. Go finer only when one entity carries intent that does not belong to its cluster.

**Discoverability rule (enforced).** Cluster docs MUST name every covered entity verbatim in the body — the conventional `**Covers:**` line is the canonical place — so `lore codex search <entity_name>` lands on the cluster doc.

## What NOT to put in the codex

- Git history, commit messages, or who changed what — use `git log`
- Debugging notes or fix recipes — put the fix in code, context in the commit message
- PR summaries or activity logs — these are ephemeral
- In-progress task state or mission notes — use Lore's task entities
- Anything already captured in `AGENTS.md` or `CLAUDE.md`
- Duplicate facts — if a fact exists in one file, link to it via `related`; do not repeat it
- Changelog narration — what a doc said before, or what a release altered; a stable doc states what is true now, and `CHANGELOG.md` plus `git log` hold the rest
- Promises of work not yet built — those belong in `transient/` or in a task entity, never in a stable layer

## Naming conventions

- ADRs: numbered sequentially — `001-title.md`, `002-title.md`.
- Relationship files: both entities in alphabetical order, double-dash separator — `user--task.md`, not `task--user.md`.

## Skills that deepen this guide

| Skill                  | When to use it                                                          |
|------------------------|--------------------------------------------------------------------------|
| `retrieve-memory`      | research a question or map a domain, across the codex and the rites      |
| `store-memory`         | record a fact, a procedure, or an upstream source into project memory    |
| `update-doctrine`      | create or edit a doctrine and its mission files                          |
| `update-watcher`       | create or edit a watcher                                                 |
| `update-artifact`      | create or edit a template artifact                                       |
| `update-custom-schema` | create or edit a custom-frontmatter overlay                              |
| `start-quest`          | turn a doctrine into a quest + missions                                  |
| `inquest`              | audit finished work for a missed requirement                             |
| `sync-codex-guide`     | reconcile this guide against the freshly seeded template after an upgrade |

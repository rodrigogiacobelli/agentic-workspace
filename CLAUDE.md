<!-- lore:begin -->
# Lore

Lore is your project task manager.

```bash
lore --help
Usage: lore [OPTIONS] [COMMAND] [ARGS]...

  Lore — Agent Task Manager.

  Lore organises agent work into two core entity types:

  Quest   — a body of work (feature, fix, or refactor).
  Mission — a single executable task assigned to an agent.

  Supporting entities:

  Doctrine — workflow templates that guide how missions are executed.
  Codex    — project documentation, searchable and graph-traversable.
  Rite     — procedural memory: how to do or diagnose a recurring task.
  Artifact — reusable template files referenced by stable ID.
  Watcher  — definitions for agents that monitor and react to project state.

  A directory holding several Lore projects is itself a Lore project: it reads
  any of them with --project <name> or --project all, and exports documents
  down to named descendants, which see them origin-qualified as
  <project>:<id>.

  Run any command group with --help for details on that concept.

Options:
  --version       Show the version and exit.
  --json          Output as JSON.
  --project NAME  Read another project in this tree: a project name, 'all' for
                  the whole subtree, or 'self' for this project only. Read
                  commands only.
  --help          Show this message and exit.

Commands:
  stats     Show aggregate statistics across all quests and missions.
  oracle    Generate human-readable markdown reports in .lore/reports/.
  init      Initialize a Lore project in the current directory.
  new       Create quests and missions.
  claim     Claim one or more missions (open -> in_progress).
  done      Close one or more missions or quests.
  block     Mark a mission as blocked with a reason.
  unblock   Unblock a blocked mission, returning it to open status.
  ready     Show the highest priority unblocked mission(s), sorted by...
  needs     Declare dependencies between missions using colon-pair syntax.
  unneed    Remove dependencies between missions using colon-pair syntax.
  list      List quests.
  missions  List missions across all quests, or scoped to one quest.
  doctrine  Manage doctrines — a directory of prose for a standard body...
  edit      Edit a quest or mission.
  delete    Delete a quest or mission.
  show      Show details of a quest or mission.
  rite      Manage rites — procedural memory ("how to do or diagnose...
  codex     Access project documentation — a set of typed markdown files...
  index     Route into the codex by cluster — .lore/index/ holds one...
  impacts   Surface codex<->code bindings.
  glossary  Access the project glossary — the controlled vocabulary at...
  artifact  Access project artifacts — reusable template files stored in...
  board     Manage board messages for quests and missions.
  watcher   Manage watcher definitions stored in .lore/watchers/.
  health    Audit the file-based entity types plus the schemas, bindings,...
```

## Entities

Lore organises agent work and project knowledge around the entities below. The primary CLI verb is listed parenthetically; run `lore <verb> --help` for flags. Codex layout and codex commands are documented separately in `.lore/codex/codex.md`.

### Quest

A body of work — a feature, a fix, or a refactor — that holds one or more Missions. A Quest has a title, summary, priority, and status (`open`, `in_progress`, `done`, `blocked`). Quests are the unit a human sees on a board; Missions are what agents execute. (`lore new quest` / `lore list` / `lore show` / `lore done`)

*Example:* "Add OAuth login" is a Quest whose Missions are "design the auth flow", "implement the endpoint", "write E2E tests".

### Mission

A single executable task assigned to one agent. Each Mission has a type (`agent`, `constable`, or `human`), a status, a priority, a description, acceptance criteria, and an optional doctrine mission reference. Mission *type* drives orchestrator dispatch: `agent` missions are claimed and handed to a worker agent; `constable` missions are inline orchestrator chores; `human` missions are left for the human. (`lore new mission` / `lore claim` / `lore ready` / `lore done` / `lore block` / `lore unblock`)

*Example:* "Write the failing E2E test for the new /login endpoint" is an `agent` Mission inside the OAuth Quest.

A Mission reaches its reusable instructions through `-D <doctrine-id>/<mission-id>`. `lore show <mission-id>` resolves that reference and prints the doctrine mission's body under `--- Mission Instructions ---`, so a worker gets its feature-specific description and its reusable instructions in one call.

### Doctrine

A directory of prose under `.lore/doctrines/` describing a standard body of work: `<doctrine-id>.design.md` for the orchestrator, and one `missions/<mission-id>.md` for each worker. The design document encodes the *shape* of the work — which missions, in which order, of which type, feeding which. Each mission file is one worker's whole brief: the role it adopts, how it works, its hard rules, its inputs, its steps, its done criteria, and what it hands on. Lore parses none of it; an orchestrator reads the design prose and decides the order itself, and `/start-quest` turns a doctrine into a Quest's Missions. (`lore doctrine list` / `lore doctrine show` / `lore doctrine show --mission` / `lore doctrine new` / `lore doctrine edit` / `lore doctrine delete`)

*Example:* The `feature-implementation` doctrine generates Scout → PRD → Tech Spec → Stories → Dev cycle Missions for any new feature.

### Codex

Typed markdown docs under `.lore/codex/` describing facts about the system as it exists today. Every doc has frontmatter (`id`, `title`, `summary`, optional `related`, optional `binds`, optional `rites`) and a markdown body — plus any project-local custom fields declared in a `.lore/custom-schemas/<kind>.yaml` overlay, which apply to canonical docs and `sources/` but never to `transient/`. The codex is a graph: `related` links connect docs both ways. A codex doc links to the rites it governs via `rites:` — the edge runs codex→rite only, never the reverse. See `.lore/codex/codex.md` for the layout, three content classes, impacts engine, and naming rules. (`lore codex list` / `lore codex search` / `lore codex show` / `lore codex new` / `lore codex edit` / `lore codex delete` / `lore codex map` / `lore codex chaos`)

### Glossary

Controlled vocabulary at `.lore/codex/glossary.yaml` — small, project-specific terms only. Auto-surfaced when terms appear in `lore codex show` output. Not for entities (they have codex docs) and not for named workflows (they have workflow docs). (`lore glossary list` / `lore glossary search` / `lore glossary show` / `lore glossary new` / `lore glossary edit` / `lore glossary delete`)

*Example:* "Constable" — a project-invented label for a Mission type the orchestrator handles inline — qualifies.

### Rite

Procedural memory — "how to do or diagnose recurring task X" — stored as YAML under `.lore/rites/`, a sibling of the codex. Where the codex holds *semantic* knowledge (what is true), a rite holds *procedural* knowledge (what to do, step by step). Two shapes: a **main rite** (`main/`) is a node-graph of steps — each node either a `do:` action or a `use:` of a shared step, routed by `then`/`if`/`goto` and terminating in typed `conclusions:` — and a **shared step** (`shared/`) is a pure, single-exit procedure (`id`/`title`/`summary`/`do` only, no branching, no trigger) that main rites pull in by bare id with `use:`. Discovery is recursive; a rite's subfolder becomes a cosmetic `group` for display/filter only, and its `id:` is globally unique like the codex. Agents find a rite by reading `lore rite list` and picking the matching trigger themselves — Lore never matches a situation. Rites link to nothing; a codex doc points at the rites it governs via its `rites:` field (codex→rite, never the reverse — ADR-014). (`lore rite list` (GROUP column, `--filter`) / `lore rite show` (inlines shared steps) / `lore rite search` / `lore rite new --group` / `lore rite edit` / `lore rite delete`)

*Example:* A `refund-customer` main rite branches on order age and reason, `use:`-ing a shared `verify-payment-method` step, and ends in `refund-issued` / `escalate-to-human` conclusions.

### Artifact

Reusable template files referenced by stable ID under `.lore/artifacts/`. Agents `lore artifact show <id>` to pull a template (a PR-review checklist, a glossary-design gate, an ADR skeleton) into their working context. (`lore artifact list` / `lore artifact show` / `lore artifact new` / `lore artifact edit` / `lore artifact delete`)

*Example:* `glossary-design` is the three-question gate every glossary edit must pass.

### Watcher

A reactive-agent definition stored under `.lore/watchers/`. Declares a project-state condition and a doctrine that runs when the condition fires. (`lore watcher list` / `lore watcher show` / `lore watcher new` / `lore watcher edit` / `lore watcher delete`)

*Example:* A `pr-ready` watcher could run a `code-review` doctrine whenever a Mission transitions to `done`.

### Board message

A piece of state attached to a Quest or Mission — a note, a question, a hand-off. Plain text addressed to the next agent or to the human. (`lore board add` / `lore board list` / `lore board delete`)

*Example:* "Blocked on schema migration approval — pinging the human" attached to a Mission.

### Dependency

A `needs` edge between two Missions: Mission A `needs` Mission B means B must reach `done` before A can leave the `open` queue. Shown in `lore ready` ordering. (`lore needs` / `lore unneed`)

*Example:* The "implement endpoint" Mission `needs` the "design auth flow" Mission.

## Roles

You are either the orchestrator (dispatching missions) or a worker (executing one).

### Orchestrator

- `lore ready` → next available mission. Dispatch by type:
  - **`agent`** — claim (`lore claim <id>`), spawn worker agent with the mission ID
  - **`constable`** — claim and handle inline (commit, housekeeping, etc.)
  - **`human`** — do NOT claim, leave for human
- Start a new quest from a doctrine via `/start-quest`.
- Use the relevant skill (table below): the `update-*` skills author a doctrine, watcher, artifact or custom schema — creating or editing as the request requires — and `store-memory` / `retrieve-memory` write and read project memory.

Default doctrines shipped via `lore init`:

| Doctrine                      | What it does                                                                                  |
|-------------------------------|-----------------------------------------------------------------------------------------------|
| `feature-implementation`      | Full E2E spec pipeline — Scout, PRD (crazy + draft + final), Tech Spec, Stories. Four phases. |
| `quick-feature-implementation`| Streamlined spec pipeline — single scout, no crazy phases, single commit at the end.          |
| `tdd-implementation`          | Strict Red-Green-Refactor cycle for one dev-ready story. Hard boundaries between each mission.|
| `update-changelog`            | Single-mission changelog update after a merge to `develop`. Triggered by the changelog watcher.|

### Worker

- You have a mission ID. Run `lore show <id>` — returns description, acceptance criteria, and the doctrine mission instructions in one call.
- Execute. Run `lore done <id>` when finished. Run `lore block <id> "<reason>"` if stuck.
- Do not create quests or missions. Do not claim unassigned work.

## Knowing the project

Read project state before you act. Project memory has two surfaces — the codex
holds what is true, the rites hold how to do or diagnose a recurring task — and
`retrieve-memory` walks both in one pass.

**`lore index search <kw>` is the cheapest first call on a codex you have not
read, in every access mode.** One answer is a named cluster of related documents
with their paths, rather than one document. It stays on the CLI even when you
otherwise use your own file tools — like `lore codex map` and `lore impacts`, it
computes something no file read reproduces, re-fingerprinting the codex and
rebuilding the render before it matches, so `.lore/index/` read by hand answers
from the last build instead of from now. A `no index authored for this project`
refusal means this project has no index yet; the `update-index` skill authors
one, and `lore index build` regenerates the render.

- **Codex** — grep `.lore/codex/**/*.md` and read `.lore/codex/<layer>/<id>.md`
  with your own file tool. Write documents there yourself;
  `lore health --scope codex schemas` validates the result.
- **Rites** — read and write `.lore/rites/main/**/*.yaml` and
  `.lore/rites/shared/**/*.yaml` directly; `lore health --scope rites` validates
  the graph afterwards.
- **Glossary** — `.lore/codex/glossary.yaml`, one file with a schema;
  `lore health --scope glossary` validates it.

Three things reading files gives up, which are now yours to do: glossary terms
are not attached to what you read, a rite's `use:` steps are not inlined, and a
document's group is its directory rather than anything in its id.

These four reach past what a file tool can reproduce, so they stay on the CLI
whichever way your project reads the rest:

- **`lore codex map <id>`** — bidirectional traversal of related documents.
- **`lore codex chaos <id> --threshold <30-100>`** — serendipitous discovery.
- **`lore impacts <path>`** — which codex documents govern this file. Run before
  editing code. **`lore impacts <codex-id>`** — which files a document binds.
  Run when assessing a document's reach.
- **`lore health`** — audit codex, rites, schemas, bindings, glossary, the codex
  index, voice and the skills `lore init` installed. Run after structural
  changes. It writes no report file unless `health-report-retention` in
  `.lore/config.toml` is `"latest"` or `"all"`.

Everything else — artifacts, doctrines, watchers, quests, missions and board
messages — is reached by id through the Lore CLI in every mode. Those commands
run validation, mission-index assembly and content splicing that no file read
reproduces.

## Available skills

Skills are installed into this project. Each is a folder holding a `SKILL.md`
you read before doing the job it names.

| Skill | What it does | Where |
|---|---|---|
| `inquest` | Audit finished work against its original intent and trace a missed requirement to the link in the chain that dropped it | `.claude/skills/inquest/` |
| `retrieve-memory` | Answer a question from project memory, consulting both the codex for what is true and the rites for how to do or diagnose something | `.claude/skills/retrieve-memory/` |
| `start-quest` | Read a doctrine, create a quest and its missions, ask before dispatching | `.claude/skills/start-quest/` |
| `store-memory` | Record knowledge into project memory — a codex document, a rite, or a source snapshot — creating, editing or deleting as the request requires | `.claude/skills/store-memory/` |
| `sync-codex-guide` | Reconcile this project's customized .lore/codex/codex.md against the freshly seeded template after a lore upgrade | `.claude/skills/sync-codex-guide/` |
| `update-artifact` | Create or edit an artifact — a reusable template, checklist or policy file | `.claude/skills/update-artifact/` |
| `update-custom-schema` | Create or edit a custom-schema overlay that adds project-specific codex frontmatter fields | `.claude/skills/update-custom-schema/` |
| `update-doctrine` | Create or edit a doctrine — its design document, its mission files, and the artifacts they need | `.claude/skills/update-doctrine/` |
| `update-index` | Author and refresh the codex index — write the slug, name and summary for each cluster of documents Lore has partitioned, so `lore index search` can route a cold read to the right group | `.claude/skills/update-index/` |
| `update-watcher` | Create or edit a watcher — the project-state condition it fires on and what it runs | `.claude/skills/update-watcher/` |
<!-- lore:end -->

<!-- project:begin -->
# Agentic Workspace

A native Linux desktop app for running several agent-driven projects at once.
Two OS windows — a file tree and markdown editor, and a tabbed terminal — over a
workspace switcher that keeps every project's terminals alive in the background.

**Nothing is built yet.** This repository holds a specification and the
decisions behind it. Treat any claim about running code as false until you have
read the code.

## Where things are

| Path | What |
|---|---|
| `.lore/codex/vision/` | What the product is for |
| `.lore/codex/decisions/` | ADRs. Read the relevant one before changing a settled shape |
| `.lore/codex/standards/` | The rules code has to comply with |
| `README.md` | The outward-facing description |
| `CLAUDE.md` | This file. How to work here |
| `working/` | Throwaway, git-ignored. Holds `acceptance-criteria.md`, the in-flight spec |

**Documentation goes to the codex. Everything else is throwaway and goes to
`working/`.** There is no `docs/` directory and no third location.

`working/acceptance-criteria.md` is the in-flight specification: every
behaviour as Given/When/Then with an id and a P0/P1/P2 priority. Cite ids
(`ED-07`, `BR-08`) when you discuss behaviour. It is not version controlled —
as behaviour is built, its facts move into codex documents, which are.

`.lore/codex/conceptual/` and `.lore/codex/technical/` are deliberately empty.
The codex records what is true today, and no system exists yet. Write those
layers as the code lands, not before.

## Working rules

**Throwaway files go in `working/`.** Scratch scripts, experiment output,
one-off analysis, anything you would otherwise drop in `/tmp` and want to keep
for the session. It is git-ignored. Never leave scratch files at the repository
root or beside source.

**Leave the worktree clean.** No stray files, no commented-out blocks, no
half-applied edits at the end of a piece of work.

**Go easy on tests.** This is an explicit project rule, not a default. Test the
logic that is genuinely hard to get right and cheap to test in isolation — path
resolution, the markdown block splice, ignore-pattern matching, theme parsing.
Do not test the framework, the getters, or the UI wiring. A test that needs a
compositor, a real PTY or a model is `#[ignore]`d and run deliberately. Read
`standards-testing` before adding a test file.

**Prefer editing over adding.** A new document, module or abstraction needs a
reason that a change to an existing one does not satisfy.

## Platform

Arch Linux / CachyOS, KDE Plasma, Wayland. The user's shell is **fish** — bash
syntax fails there, so `source ~/.cargo/env.fish`, not `~/.cargo/env`.

`standards-linux-desktop` holds the platform rules that fail *silently* when
broken — the app-id chain, the WebKitGTK NVIDIA workaround, window placement
under Wayland, the AppImage strip flag, the Cargo `rust-version` floor. Read it
before touching windowing, packaging or desktop integration.

## Voice

Prose in this repository — codex documents, the README, the spec — is written
for a reader arriving cold. Present tense about current state, a named actor for
every behaviour, no sales register, no hedges. `lore artifact show codex-voice`
is the full rule set, and `lore health --scope voice` checks the mechanical
half.
<!-- project:end -->

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

Eight milestones run. The first three: workspaces, both windows, backend-owned
terminals, the file tree, session restore, the three-mode markdown editor with
clipboard assets and external-change handling, git with branches and worktrees,
and the two agent signals. The next four: app-drawn window chrome over a
tray-resident process, preview tabs, the layout tree that drives both editor
splits and panel docking, custom views, `@` citations with *Quote to AI*, the
typing helpers, and the operations document. The eighth: modes — Editor and
Source Control in the Workspace window, Terminal in its own — each owning its
panels, its working area and its dock tree (`017-modes`). The Rust backend is
`src-tauri/src/`, the React frontend is `src/`, the editor is `src/editor/`.
Mermaid, the grammar importer and HTML preview are not built; treat any claim
about them as false until you have read the code. The second in-flight
specification is `working/acceptance-criteria-2.md`: the first one is frozen and
the ids continue its groups, so a citation of `ED-07` or `BR-08` still resolves.

## Where things are

| Path | What |
|---|---|
| `.lore/codex/vision/` | What the product is for |
| `.lore/codex/decisions/` | ADRs. Read the relevant one before changing a settled shape |
| `.lore/codex/standards/` | The rules code has to comply with |
| `src-tauri/src/` | Rust backend: PTYs, session store, tree, watches |
| `src/` | React frontend: the two window shells, terminal and editor registries |
| `README.md` | The outward-facing description, build steps and key bindings |
| `CLAUDE.md` | This file. How to work here |
| `working/` | Throwaway, git-ignored. Holds `acceptance-criteria.md` and `acceptance-criteria-2.md`, the in-flight specs |

**Documentation goes to the codex. Everything else is throwaway and goes to
`working/`.** There is no `docs/` directory and no third location.

`working/acceptance-criteria.md` and `working/acceptance-criteria-2.md` are the
in-flight specifications: every behaviour as Given/When/Then with an id and a
P0/P1/P2 priority. Cite ids (`ED-07`, `DOCK-08`) when you discuss behaviour.
Neither is version controlled — as behaviour is built, its facts move into
codex documents, which are.

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

## Minimalism

Code written here walks **ponytail**'s decision ladder
(<https://github.com/DietrichGebert/ponytail>) before anything new is written:

1. Does this need to exist? — no: skip it (YAGNI)
2. Already in this codebase? — reuse it, don't rewrite
3. Stdlib does it? — use it
4. Native platform feature? — use it
5. Installed dependency? — use it
6. One line? — one line
7. Only then: the minimum that works

Lazy, not negligent. Trust-boundary validation, data-loss handling, security
and accessibility survive every rung — step 1 does not delete them and step 7
does not thin them out.

Steps 3 to 5 carry the most weight on a Tauri v2 app split across a Rust
backend and a web frontend: reach for `std` or the browser's own platform API,
then for a Tauri plugin, then for a crate or package already in `Cargo.toml`
or `package.json`, before adding a dependency. `lore index search <kw>` and
`lore impacts <path>` answer step 2 — they find what the project already holds.

The plugin is not installed; the ladder is the rule either way. Installing it
adds `/ponytail-review` (over-engineering in the current diff),
`/ponytail-audit` (the same over the whole repository) and
`/ponytail [lite|full|ultra|off]` (intensity, `full` by default). The human
installs it, as two separate prompts:

```
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```

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

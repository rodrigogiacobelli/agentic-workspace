---
id: 015-views-and-citations
title: 'ADR-015: Views are flat shortcuts and citations are root-relative'
summary: Why a custom view is an ordered list of workspace-relative paths rather than
  a structure of its own, why a citation is `@` plus a path from the workspace root,
  and what the one application-wide link setting decides.
related:
- 003-source-markdown-is-canonical
- 011-live-preview-over-codemirror
- 007-workspace-is-one-directory
binds:
- src/editor/citation.ts
- src/components/FileTree.tsx
---

# ADR-015: Views are flat shortcuts and citations are root-relative

## Context

The Files panel showed the workspace exactly as it sits on disk, so the four
files an agent needed for one task were four places in a tree. A path written
into a document was a markdown link relative to that document, which is what a
renderer resolves and not what an agent resolves.

Key forces:

- **An agent resolves a path from the repository root.** A link relative to
  the note reads correctly in a renderer and sends the agent to the wrong
  directory.
- **The files one task needs are scattered.** A spec, a module, a test and a
  config sit in four branches of the tree and get reached one expansion at a
  time.
- **A file has one home.** A grouping that copies or moves files creates a
  second place for a file to be, and a second thing to keep in step with the
  disk.
- **The workspace is the boundary** (`007-workspace-is-one-directory`). A
  grouping that reaches outside it turns one directory into several.
- **Markdown is canonical** (`003-source-markdown-is-canonical`). Whatever the
  rendered pane draws has to be bytes already in the file, unchanged by being
  drawn (CITE-09).

## Decision

**A view is a named, ordered list of paths.** `View` in
`src-tauri/src/state.rs` holds an id, a name and `entries` —
workspace-relative paths in the order the user put them. Views hang off the
workspace, so they belong to it and return with it after a restart (VIEW-01,
VIEW-09). `session::view_add` sends the path through `tree::resolve`, which
rejects anything that is not a normal relative path inside the workspace root,
and rejects the root itself. `tree::stat_entries` reports each entry's name,
whether it is a directory, whether git ignores it and whether it exists, so
`FileTree` draws an entry whose file is gone struck through in the danger
colour rather than dropping it from the list (VIEW-08).

`FileTree` draws a view's entries at depth zero whatever their depth on disk,
and expands a directory entry through the same `list_dir` the tree itself uses,
with the same rows, the same git letters and the same filter (VIEW-03, VIEW-04,
VIEW-05, VIEW-11). The context menu over a view's root offers no *New file* and
no *New folder* (VIEW-06). *Remove from view* takes the entry out of the list
(VIEW-07); `view_delete` deletes the list and leaves every file it named
(VIEW-10). Dragging one root row onto another reorders the list (VIEW-12).

**A citation is `@` followed by a path from the workspace root.**
`src/editor/citation.ts` defines it as a `@lezer/markdown` inline node.
`citationEnd` refuses an `@` preceded by a word character, an `@`, a dot or a
slash, runs to the first whitespace or closing punctuation, trims a trailing
`.,:;!?`, and takes the result only when it holds a slash or a dot — so an
email address, a CSS at-rule and a bare handle parse as they did before
(CITE-10), while a scoped package name such as `@anthropic-ai/sdk` reads as a
citation of a path that does not exist and is drawn as missing. The older
`@/path` form, which the specification chose, is still read; the slash was
dropped because `@path` is what the owner types to an agent. In the rendered pane a citation whose
cursor is elsewhere is replaced by the media itself when the cited path is an
image, audio or video, and by a chip otherwise; a chip whose path does not
exist is drawn in the danger colour (CITE-06, CITE-07, CITE-11). Clicking a
chip opens the file (CITE-08). The node is a decoration over the source text,
so moving the cursor into it shows the `@path` that is in the file (CITE-09).

**One application-wide setting decides what paste and drop write.**
`asset_links` in the settings is `markdown` or `citation` (CITE-03). It decides
the text `Doc.insertLink` writes after an asset is stored, and nothing else:
`save_asset` and `import_asset` put the file in the workspace's clipboard
folder either way (CITE-04). *Quote to AI* in the Files panel writes a citation
whatever the setting says, for a tree row or a view row alike (CITE-05,
CITE-12), one per line in tree order for a `Ctrl`-click selection of several
(CITE-13).

## Rationale

- A view's entries are the paths themselves, so there is no second name space
  to reconcile with a disk that moves, and every file operation works inside a
  view unchanged.
- A path from the workspace root is the path the agent in the terminal beside
  the editor can act on without translating it.
- Keeping a citation a markdown inline node puts it under the rule
  `011-live-preview-over-codemirror` sets for every other construct: decorated
  in place, never re-serialised.
- One application-wide setting matches the single thing it decides — how this
  person prefers a path written — rather than a property of any project.
- Rejecting a path outside the workspace keeps a view inside the boundary
  `007-workspace-is-one-directory` draws, and keeps a citation's root fixed.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Virtual folders inside a view** | Lets a view group its entries under names of its own, and it is a second tree to name, order, persist and reconcile against a disk that moves underneath it. |
| **Citations relative to the note** | Needs no new syntax and matches markdown links, and an agent then has to resolve the path from the note's directory rather than the repository root — which is the one thing the citation exists to avoid. |
| **A per-workspace link setting** | Sits beside `clipboardDir` and the theme override, and the choice is a writing habit that does not change between projects, so it would be set once per workspace forever. |

## Consequences

**Easier:**
- A view costs one list of strings in the session; making one and deleting one
  touch no file on disk.
- Every tree behaviour reaches a view: preview on a single click, permanence
  on a double click, drag into an editor group, git status letters, filter.
- A citation and a markdown link coexist in one document, and the parser tells
  them apart.
- A missing view entry and a missing citation both say so on screen instead of
  disappearing.

**Harder:**
- A file renamed on disk leaves its view entries and its citations pointing at
  nothing; neither is rewritten.
- Whether a cited path exists is a backend round trip, so a chip is drawn
  before its missing mark is known and gains it when the answer arrives.
- One file appears twice in a view when the list holds both it and a directory
  above it.
- A view belongs to one workspace. A second worktree of the same project is a
  separate workspace with its own views.

## Constraints imposed

- **A view entry is a workspace-relative path.** `view_add` rejects an
  absolute path, a `..` segment, a path outside the root, and the root itself.
- **Nothing is created at a view's root.** The root is a list of shortcuts, not
  a directory.
- **A citation names the workspace root and nothing else.** No absolute path,
  no parent segment, no other workspace.
- **The link setting never moves a file.** A stored asset lands in the
  workspace's clipboard folder whichever form the document gets.
- **Quote to AI writes a citation**, whatever `asset_links` says.

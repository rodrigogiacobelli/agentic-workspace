---
id: 015-views-and-citations
title: 'ADR-015: Views are flat shortcuts and citations are root-relative'
summary: Why a custom view is an ordered list of workspace-relative paths with its
  own open folders rather than a structure of its own, why a citation is `@` plus a
  path from the workspace root, the one order every path a document writes resolves
  in, the worktree family a document reaches beyond its own directory, where a cited
  image is drawn as the image and where as a chip that previews it on hover, why a
  chip opens a permanent tab while a link opens a preview, how each tree panel keeps
  its own selection and follows the document in front, and what the one
  application-wide link setting decides.
related:
- 003-source-markdown-is-canonical
- 011-live-preview-over-codemirror
- 007-workspace-is-one-directory
- 014-one-layout-tree
- 020-workspace-family
- standards-linux-desktop
binds:
- src/editor/citation.ts
- src/components/FileTree.tsx
- src/treeSelection.ts
- src/components/WorkspaceWindow.tsx
- src/editor/document.ts
- src/editor/preview.ts
- src-tauri/src/tree.rs
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
- **Agents write absolute paths.** A QA report an agent wrote in a worktree
  cited 27 screenshots as `@/home/…/working/screenshots/…png`. The leading
  slash read as the root-relative form, every screenshot was looked for as
  `home/…` inside the workspace, and every one showed as missing.
- **A worktree and its main checkout are one project.** A worktree's notes
  cite files in the main checkout, and a main checkout's notes cite what an
  agent produced in a worktree, which git may have put anywhere on disk.
- **Nothing else on disk is the document's business.** Rendering whatever
  absolute path a document names turns any Markdown file into a way to read
  any file the user can read.
- **A cited image in prose is not a figure.** Drawn as the image wherever it
  stood, the same report's `Setup:` line became 27 full-size screenshots in a
  row, a citation in the middle of a sentence dropped a screenshot into it, and
  one in a table cell overflowed its column.
- **A chip opened a preview tab.** A chip in a note that was itself the
  group's preview tab put the cited file in the note's slot, and the note was
  gone. The owner reads the screenshots a report cites side by side, and asked
  for each to open in a tab of its own.
- **The two tree panels shared one selection.** The Explorer and the Custom
  panel had one lead row between them. A `Ctrl`+click could not take a row
  back out, a row taken out stayed highlighted while Delete left it out, and
  Shift+click and the arrow keys did nothing. What a selection holds is what
  Delete sends to the trash.
- **The tree did not follow the editor.** Nothing selected the document in
  front in the tree, and *Reveal in Explorer* did not give the tree the
  keyboard.
- **Views shared the Explorer's open folders.** One list,
  `Workspace.expanded`, held the open folders of the Explorer and of every
  view, so a folder opened in a view opened in the Explorer too.

## Decision

**A view is a named, ordered list of paths.** `View` in
`src-tauri/src/state.rs` holds an id, a name, `entries` — workspace-relative
paths in the order the user put them — and `expanded`, the folders the Custom
panel draws open in that view. Views hang off the workspace, so they belong to
it and return with it after a restart (VIEW-01, VIEW-09). `session::view_add`
sends every path it is given through `tree::resolve`, which rejects anything
that is not a normal relative path inside the workspace root. `tree::resolve`
accepts the root itself, and `view_add` then rejects it. One path refused
refuses them all, before the view changes.
`tree::stat_entries` reports each entry's name, whether it is a directory,
whether git ignores it and whether it exists, so `FileTree` draws an entry
whose file is gone struck through in the danger colour rather than dropping it
from the list (VIEW-08).

`FileTree` draws a view's entries at depth zero whatever their depth on disk,
and expands a directory entry through the same `list_dir` the tree itself uses,
with the same rows, the same git letters and the same filter (VIEW-03, VIEW-04,
VIEW-05, VIEW-11). Each view opens and folds folders in its own `expanded`,
apart from the Explorer's `Workspace.expanded`: `session::set_expanded` takes
the view it acts in, and `session::relocate` renames a moved folder in every
one of those lists (TREE-20). The context menu over a view's root offers no
*New file* and no *New folder* (VIEW-06). *Send to view* adds the selection in
tree order, less what the view holds already, and *Remove from view* takes
every selected entry out, each as one change and one publish (VIEW-07,
TREE-28). Delete on a row that is one of the view's entries takes the entry
out of the view with no question and touches no file; a row drawn beneath an
entry goes to the trash as it would from the Explorer, and an entry drawn
missing is never sent to the trash (TREE-25a). `view_delete` deletes the list
and leaves every file it named (VIEW-10). Dragging one root row onto another
reorders the list (VIEW-12).

**Each tree panel keeps its own selection.** The Explorer and the Custom
panel each hold a set of highlighted paths, a lead row and an anchor, kept in
memory per workspace under `<workspace>:tree:<explorer|custom>:selection`
and never saved; a click, a key
or a follow in one never changes the other's. The rules are pure functions in
`src/treeSelection.ts`. `Ctrl`+click takes a row in or out, and a row taken
out passes the lead to the nearest selected row above it, else below it, else
to none (`toggle`, TREE-22). Shift+click and Shift+↑/↓ select the drawn rows
from the anchor to the row, and `Ctrl`+Shift+click adds a second range
(`extend`, TREE-23, TREE-23a, TREE-24a). ↑, ↓, Home and End select one row
alone; → unfolds a folder and then steps into it, ← folds it and then steps to
its parent; `Ctrl`+A selects every row the panel draws (TREE-24 to TREE-24d).
None of these opens a file. A view names each row `<entry>\0<path>`, so a
range runs from the copy clicked of a file the view draws twice, and a lead
whose copy is folded away stands for the first copy still drawn.
`Ctrl`+Shift+E brings the Explorer forward with the keyboard on its lead,
where Enter opens a file as a permanent tab or folds and unfolds a folder
(TREE-24e).

Every action takes the rows its panel highlights and draws, each path once
and in tree order: Delete, cut, copy, a drag and *Quote to AI* alike
(TREE-22a). Delete, cut, copy and a drag leave out a row inside a folder that
is taken itself, which carries it (`outermost`, TREE-26a). F2, *Rename* and
*Duplicate* are off while several rows are selected, and *New file*,
*New folder* and `Ctrl`+V use the lead's folder. `selection.deleting` weighs
what Delete takes: under a filter, a folder row taken with a row beneath it
stands for the matches drawn there and is not trashed itself, so the files the
filter hides stay. The trash question is app-drawn, names up to five rows, and
is asked only while the `confirmDelete` setting is on; its *Don't ask again*
turns the setting off (SET-05, SET-05a). `tree::trash_entries` sends the rows
to the desktop trash one at a time and answers the ones that failed, which
show as one notice, a line each (TREE-25, TREE-25b). The selection then moves
to the row after the last one removed, else to the row before the first
(`afterRemoval`).

**The trees follow the document in front.** `WorkspaceView` keeps the id of
the Editor area's front tab under `<workspace>:tree:front` and calls
`followFront` when that id changes — a preview opened, a group clicked, a tab
closed — and not when a move or a rename keeps the tab and changes its path
(TREE-18, TREE-18a). Each panel that draws the path selects it alone and
scrolls it into view once the row has a box, so a panel behind another tab
follows too (TREE-18b). `selection.draws` decides what a panel draws: every
folder above the path open in that panel's own list, up to a top-level folder
in the Explorer or up to one of the view's entries in a view, or, under a
filter, a match the filter shows (TREE-19, TREE-20). A panel that does not
draw the path keeps its selection, and so does one that highlights several
rows it still draws (TREE-21), and every panel does when the tab in front is
detached. Only rows still drawn count as several — under a filter they are
counted in one pass — and a follow skipped over a stale multi-selection is
retried once the panel draws again. The follow never opens a folder, never
brings a panel forward and never moves the keyboard. After a restart the
trees select nothing until the document in front changes.

**Show in Explorer puts the file in front of the reader.** The button at the
left end of every editor header row, a breadcrumb's *Reveal in Explorer* and
a folder chip all call `revealInTree`, which clears an Explorer filter that
hides the path and selects the path alone, the anchor with it. The Workspace
window then opens every folder above the path in one `set_expanded`, brings
the Explorer forward wherever it is docked — where it was last docked, when
it was hidden — and gives it the keyboard (ED-59, ED-59a, ED-59b). It acts on
the Explorer alone.

**A citation is `@` followed by a path from the workspace root.**
`src/editor/citation.ts` defines it as a `@lezer/markdown` inline node.
`citationEnd` refuses an `@` preceded by a word character, an `@`, a dot or a
slash, runs to the first whitespace, closing punctuation or `<` — so
`@/a.png<br>@/b.png` is two citations (CITE-16) — trims a trailing
`.,:;!?`, and takes the result only when it holds a slash or a dot — so an
email address, a CSS at-rule and a bare handle parse as they did before
(CITE-10), while a scoped package name such as `@anthropic-ai/sdk` reads as a
citation of a path that does not exist and is drawn as missing. The older
`@/path` form, which the specification chose, is still read; the slash was
dropped because `@path` is what the owner types to an agent. `citedPath`
gives the path exactly as written, leading slash included, and the resolution
order below decides what it names. The node is a decoration over the source
text, so the file keeps the `@path` byte for byte (CITE-09). Rich mode never
shows the `@path`: `src/editor/rich.ts` makes the citation one object, which
one arrow press steps over and one deletion removes whole. Source mode shows
the `@path` as the file holds it.

**Every path a document writes resolves in one order.** A citation's path, a
Markdown image's target and a Markdown link's target all go through
`Doc.resolve` in `src/editor/document.ts`, which returns a `Resolved`
(`src/editor/preview.ts`):

| Step | The path… | `Doc.resolve` reads it as |
|---|---|---|
| 1 | is absolute and lies inside the workspace's directory | that file, from the workspace root (CITE-14, AST-10) |
| 2 | is absolute and lies inside the workspace's worktree family | that file, by its absolute path (CITE-17) |
| 3 | starts with `/` | the same path read from the workspace root: the older `@/path` form, and GitHub's `/path` (CITE-15, AST-11) |
| 4 | is anything else | outside: missing, and never requested (CITE-20) |

A relative citation is read from the workspace root, and a relative link or
image from its note's directory. The absolute path either produces goes
through steps 1, 2 and 4, and a `..` that climbs above the workspace root
keeps climbing instead of stopping at the root, so a worktree's note can climb
into its main checkout and any other climb leads outside. A `file:` URL names
an absolute path and goes through steps 1, 2 and 4. A path under step 3 that
names no file fails to load, so an absolute path elsewhere on disk and a
root-relative path that does not exist both read as missing, and nothing
outside the boundary is requested to tell them apart. The order gives each
path one location at most: the missing placeholder shows the path as written
and takes `Resolved.tip` as its tooltip, which names that location or says the
path leads outside the workspace (AST-12).

**A document reaches its worktree family.** `tree::family` in the backend and
`family` in `document.ts` read it from the repository summary the session
carries. A linked worktree reaches its main checkout and none of the other
linked worktrees, even those git put inside the main checkout; a main checkout
reaches each of its linked worktrees wherever it sits. `tree::stat_entries`
takes an absolute path and looks at it only when `tree::reaches` places it
inside the workspace or its family. A click on a chip, or a `Ctrl`+click on a
link, opens a family file in the deepest open workspace that holds it,
switching to that workspace; when no open workspace holds it, `Doc` shows a
notice naming the path and opens nothing (CITE-17). Two open entries on one
folder — a repository found inside a root's folder, and the same repository
added by hand (`020-workspace-family`) — hold the same files at the same
depth. The Workspace window's `workspaces()` hook lists the workspace family
on screen first, and `Doc.home` keeps that order among entries of one depth,
so the file opens in the entry of the note's own workspace family (CITE-23).
A worktree folder is open as one entry at most, so a chip for a file in a
worktree open under another workspace family switches to that entry. The
workspace family decides only where a click lands: what a document may load
is the worktree family's, through `tree::family`, `tree::reaches`,
`stat_entries` and the asset scope, whatever family a workspace belongs to.
Only an `http:`, `https:`, `mailto:` or
`tel:` link reaches the system opener; every other link opens through
`Doc.resolve`, which reads an `asset:` or any other scheme as outside. The
asset protocol serves only the directories
of open workspaces and their families (AST-14, `standards-linux-desktop`).

**A cited image is the image on a line of its own, and a chip anywhere
else.** In the rendered pane, `preview.ts` replaces a citation of an image,
audio or video with the media itself only when `citationsOnly` finds that its
line holds nothing but citations and whitespace. A quote mark or a list marker
opening the line counts as block markup, so `- @shot.png` and `> @shot.png`
draw the image; a word, a heading mark, a task box or a `<br>` on the line
makes every citation on it a chip (CITE-18). A citation in a table cell is
always a chip, and so is a citation of any other file (CITE-07).
`chipElement` in `citation.ts` builds every chip, in prose and in a table cell
alike: the Files panel's icon for the file from `fileIcon`, the file's name,
and the danger colour when the path does not exist (CITE-11), with
`Resolved.tip` as a missing chip's tooltip.

**A chip opens its file in a permanent tab, and a link opens a preview.** A
click on a chip asks `stat_entries` about its path at that moment, since the
drawn answer may not have landed and a folder cited without its slash reads
as a file. A path that is not there gives the notice `<path as written> does
not exist`, and a folder is shown in the Explorer of the workspace holding it
as *Show in Explorer* shows it; neither opens a tab (CITE-22c). For a file,
`Doc.open` turns the note permanent through `pin_editor`, so a note that is
the group's preview tab stays open (CITE-22a), then opens the file in the
group clicked as a permanent tab, or brings its tab there to the front as a
permanent one (CITE-22, CITE-22b). A `Ctrl`+click on a Markdown link opens a
preview tab (CITE-08, CITE-22d), and turns the note permanent first only when
that preview opens in the note's own workspace, where it would take the
note's slot.

**An image chip previews its image on hover.** When the pointer rests on an
image chip for 300 ms, `citation.ts` shows the image in the window's one
preview layer, scaled to fit 720 × 540 px and half the window's width and
height, whichever is smaller, never past its own size, with the file's name
and its pixel size under it (CITE-19). The layer opens below the chip, or above
it when there is no room below, and `place` in `src/tooltip.ts` keeps it inside
the window, as it does the tooltip. It takes no pointer events and never takes
focus. It closes when the pointer leaves the chip, on any key, press or scroll,
and when the window loses focus; the key goes on to wherever it was going. A
chip whose file is missing previews the missing placeholder and
`Resolved.tip` in place of the image. An image chip carries no tooltip, so the
preview is the one thing its hover shows. Audio, video and every other chip
have no preview.

**One application-wide setting decides what paste and drop write.**
`asset_links` in the settings is `markdown` or `citation` (CITE-03). It decides
the text `Doc.insertLink` writes, and nothing else: after an asset is stored,
where `save_asset` and `import_asset` put the file in the workspace's
clipboard folder either way (CITE-04); and for an Explorer or view entry
dropped on the centre of a Markdown document (TREE-16), where
`Doc.insertReference` writes, at the drop point, `@docs/spec.md` — `@docs/`
for a folder — under `citation`, and a link relative to the note —
`[spec](docs/spec.md)`, `[docs](docs/)` — under `markdown`, one per line for
several entries. A dropped entry is already in the workspace, so nothing is
copied. *Quote to AI* in Explorer or Custom writes a citation
whatever the setting says, for a tree row or a view row alike (CITE-05,
CITE-12), one per line in tree order for a selection of several (CITE-13,
TREE-22a).

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
- Reading an absolute path inside the workspace renders an agent's document
  as the agent wrote it, with no rewrite of the file, and trying it before the
  root-relative reading leaves every older `@/path` naming what it named.
- A worktree and its main checkout are the one pair of directories whose
  documents cite each other as a matter of course. Widening the boundary to
  that pair, in the direction git relates them, keeps every other directory
  out.
- A path the order puts outside is never requested, not even to see whether
  it exists, so no document can learn what is on disk beyond its boundary.
- A line that holds only citations is where an author places a figure. A chip
  everywhere else keeps a line of prose that cites a row of screenshots one
  line tall and a table column its own width, and the hover preview shows the
  picture when the reader asks for it.
- A chip names a file the reader is meant to look at beside the note, often
  several in a row. A preview slot hands each one the note's own place, and
  the note with it; a permanent tab per chip keeps the note and every file it
  cited open together. A link is browsing, and keeps the preview a tree click
  gives.
- A selection is what Delete, a move and a copy take, so it belongs to the
  panel that draws it and is drawn exactly: a highlighted row is a row an
  action takes, and a row only the other panel draws is never taken. The
  rules sit apart from the drawing, as pure functions, because a wrong answer
  is a file trashed without a question once `confirmDelete` is off.
- A follow selects and never unfolds, so the folders a reader folded stay as
  they were, and a panel that does not draw the file is left alone. *Show in
  Explorer* is the reader asking, and it does unfold.
- A view that keeps its own open folders arranges itself without moving the
  Explorer, and each panel follows against what it draws.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Virtual folders inside a view** | Lets a view group its entries under names of its own, and it is a second tree to name, order, persist and reconcile against a disk that moves underneath it. |
| **Citations relative to the note** | Needs no new syntax and matches markdown links, and an agent then has to resolve the path from the note's directory rather than the repository root — which is the one thing the citation exists to avoid. |
| **Render any absolute path** | Draws every path an agent writes, and turns any Markdown file into a way to read, stat or open any file the user can read. |
| **Every worktree of a repository reaches every other** | Makes the family symmetric, and lets one branch's documents render another branch's work in progress, which is not how git relates two linked worktrees. |
| **Every cited image drawn as the image** | Shows every screenshot without a hover, and turns a line of prose citing a row of them into a wall of images, a sentence into a sentence split by a picture, and a table cell into overflow. |
| **A per-workspace link setting** | Sits beside `clipboardDir` and the theme override, and the choice is a writing habit that does not change between projects, so it would be set once per workspace forever. |
| **Chips open a preview tab, as links do** | Keeps one rule for every click, and a chip in a note that is itself the preview tab replaces the note with the file it cites, so a row of screenshots is read one at a time with the note gone. |
| **One selection for both tree panels** | Keeps one lead for the copy-path key, and lets an action in one panel take a row only the other draws, and a row taken out in one stay highlighted in the other. |
| **One list of open folders for the Explorer and every view** | Needs no new field, and folds a folder in every panel when the reader folds it in one, so no panel can follow on its own. |
| **The follow opens the folders above the file** | Shows the document in front after every tab change, and undoes every fold the reader made each time a tab comes forward. |

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
- An agent's report renders with the absolute paths it wrote, and its
  placeholder names where a missing file was looked for.
- Several files cited in one note open side by side, and the note stays.
- Delete, a move, a copy and *Quote to AI* take exactly the rows the panel
  highlights.
- The tree shows where the document in front lives without being asked, and
  *Show in Explorer* reaches a file behind folded folders, a filter or a
  hidden Explorer in one click.

**Harder:**
- A file renamed on disk leaves its view entries and its citations pointing at
  nothing; neither is rewritten.
- Whether a cited path exists is a backend round trip, so a chip is drawn
  before its missing mark is known and gains it when the answer arrives.
- One file appears twice in a view when the list holds both it and a directory
  above it.
- A view belongs to one workspace. A second worktree of the same project is a
  separate workspace with its own views.
- An absolute path elsewhere on disk and a root-relative path that names no
  file look the same: both are missing.
- A family file's existence is looked up again when the workspace's own
  directory changes, not when the family member's does.
- An image cited inside a sentence or a table shows only while the pointer
  rests on its chip.
- A chip click waits for one `stat_entries` round trip, which runs
  `git check-ignore` for a path that is there, before its tab opens.
- v0.4.0 has no `View.expanded`: a session it wrote opens every view with its
  folders shut, and it drops the field when it saves a session.
- A file a view draws twice is highlighted at both copies.
- After a restart the trees select nothing until the document in front
  changes.

## Constraints imposed

- **A view entry is a workspace-relative path.** `view_add` rejects an
  absolute path, a `..` segment, a path outside the root, and the root itself.
- **Nothing is created at a view's root.** The root is a list of shortcuts, not
  a directory.
- **A document names its workspace and its worktree family, and nothing
  else.** A citation, an image or a link that `Doc.resolve` puts outside is
  drawn as missing and is never loaded, stat'ed, opened in the application or
  handed to the system opener.
- **A link that climbs above the workspace root is never clamped to it.** It
  keeps climbing, into the worktree family or out of the boundary.
- **The link setting never moves a file.** A stored asset lands in the
  workspace's clipboard folder whichever form the document gets.
- **Every citation the application writes is `@path`**, never the older
  `@/path`: *Quote to AI*, a pasted or dropped asset, and a dropped tree entry
  alike.
- **Quote to AI writes a citation**, whatever `asset_links` says.
- **A chip opens a permanent tab and a link opens a preview.** Neither opens
  a tab for a folder or for a file that is not there.
- **The workspace family never widens what a document may load.** Only the
  worktree family does.
- **Each tree panel acts on its own selection.** No action takes a row its
  panel does not highlight and draw.
- **Delete in a view never trashes a view entry.** The entry leaves the view;
  only a row drawn beneath an entry goes to the trash.
- **Nothing sends the workspace's own folder to the trash.**
  `tree::trash_entries` refuses a path that resolves to it.
- **A follow never opens a folder, brings a panel forward or moves the
  keyboard.**

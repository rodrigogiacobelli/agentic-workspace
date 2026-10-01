---
id: 014-one-layout-tree
title: 'ADR-014: One layout tree serves the editor groups and the panels'
summary: Why one recursive tree of rows and columns arranges both the editor groups
  and the movable panels, why the editor tree belongs to the workspace while the panel
  tree belongs to the application, and what a preview tab is.
related:
- 010-react-frontend
- 004-central-settings-store
- 017-modes
- 015-views-and-citations
- standards-linux-desktop
- standards-code
binds:
- src-tauri/src/state.rs
- src-tauri/src/session.rs
- src/components/SplitTree.tsx
- src/components/dock.ts
- src/components/EditorArea.tsx
- src/components/tabs.tsx
- src/dropRoute.ts
- src/editor/document.ts
---

# ADR-014: One layout tree serves the editor groups and the panels

## Context

Editor groups arranged themselves as two columns sharing one number,
`split_ratio`, and the Files, Search, Git and Outline panels sat in a fixed
left sidebar. Neither arrangement could hold a third column, a region under
the editor, or two stacks in one sidebar.

Key forces:

- **Two surfaces, one gesture.** A tab dropped on an editor group's edge and a
  panel dropped on a sidebar's edge are the same act, and a fixed split
  answers neither.
- **Depth is open-ended.** The criteria ask for regions on all four edges of
  any region, at any depth (DOCK-02 to DOCK-05, ED-36).
- **The two layouts answer to different owners.** An editor split holds
  specific files, so it belongs to the workspace (ED-40); panel placement is
  furniture and follows the person across every project (DOCK-08).
- **The backend has no stake in where a panel sits.** Which panels exist, what
  a hidden one returns to, which region is active — every rule is frontend
  code.
- **A single click should not leave ten tabs behind.** Reading down a file
  tree or a git status list opens files that are glanced at and abandoned.

## Decision

One recursive tree serves both: a leaf, or a split naming a `direction` —
`row` for left to right, `column` for top to bottom — its `children`, and
their `sizes`, which sum to one.

**Editor groups.** `Layout` in `src-tauri/src/state.rs` holds the tree, per
workspace in the session (ED-40). An `Area` holds a working area's groups, its
active group and its layout: a workspace has the Editor's at its top level and
Source Control's under `review` (`017-modes`), and every rule below holds in
each. `Layout::split_leaf` puts a new group beside
a leaf; when the enclosing split already runs in the requested direction the
group joins it as a sibling, so a third column is a third child of one row
rather than a row nested in a row. `Layout::remove_leaf` gives a removed leaf's
space to its sibling and collapses a split left with one child.
`Area::ensure_groups` rebuilds a tree that disagrees with the group list,
and `Area::prune_groups` drops a group left empty unless it is the last
(ED-38). `session::drop_editor` turns an edge into a direction and a side;
`set_layout_sizes` records one split's sizes after a divider is dragged
(ED-39), and it and `split_editor` name the area they act on.

**Panels.** `PanelLayout` in `src/types.ts` carries the same tree plus the
panels hidden from it and the leaf each hidden panel left, so a hotkey returns
one where it was (DOCK-09, DOCK-10). Each docked mode has its own
(`017-modes`): `settings.rs` stores `panel_layout` as `{ editor, scm }`, a
`serde_json::Value` the backend writes and reads back without interpreting,
keyed to the application rather than a workspace (DOCK-08).
`src/components/dock.ts` owns every rule over it: `normalizeAll` and
`normalize` repair the trees read from the store, `dropPanel` moves a panel,
`hidePanel` and `showPanel` take one out and put it back, and a null value, or
a mode left out, resets that tree to `defaultLayout(mode)` (DOCK-11).

**One renderer, one drop mechanism.** `SplitTree` in
`src/components/SplitTree.tsx` renders either tree, with a divider between
adjacent children that resizes them against each other and reports the new
sizes on release (ED-39, DOCK-07). `useDropZone` turns an element into a target
with five zones: four edges in a quarter-width band and a centre. An edge drop
splits (ED-36, DOCK-02, DOCK-04, DOCK-05); a centre drop moves the tab into the
group or tabs the panel into the region (ED-37, DOCK-03). The working area is
the work leaf of the panel tree, which `normalize` guarantees: emptied regions
collapse around it (DOCK-06), and it is never removed and never becomes a tab
in a region. A panel dropped on its centre, or on its tab strip, becomes one of
its tabs (`017-modes`).

**A tab is dragged by the pointer.** An editor tab, and a terminal tab in the
Terminal window, move by the page's own drag on pointer events — `dragTab` in
`src/components/tabs.tsx` — because a native drag image cannot move the tabs
beside it (TAB-09 to TAB-15). The pressed tab stays in its strip, hidden, and
a copy of it follows the pointer. The strip under the pointer opens a gap at
the slot the pointer picks: before a tab over its left half, after it over its
right half. The strip the tab left closes its place. Over a group's working
area `dragTab` places the pointer with `zoneAt`, the geometry `useDropZone`
uses, and the group draws the same overlay; the centre of the tab's own group
is no target. A release on a slot reorders the group (`reorder_editors`) or
moves the tab into another group at that index (`move_editor`), a release on a
zone calls `drop_editor`. A release over nothing, Escape, the window losing
focus, the tab losing pointer capture, or a pointer move with the button up
puts the tab back. The strips keep their marks until the session update
carrying the move is drawn: every strip calls `settleTabDrag` in a layout
effect when its tabs change, and once the tab's own strip, or the strip it
lands in, holds different tabs, `dragTab` takes the marks off before that
frame is painted. It takes them off regardless 250 ms after the backend
answers, or one second after it sends the move when the backend does not
answer.

**A tree drag goes through the drop router.** A row dragged out of the
Explorer or a custom view carries `text/uri-list` only when it is one entry,
so that another application can take the file (TREE-15); a multi-selection
carries none. WebKitGTK hides every custom MIME type from the drop side of a
drag holding a `file://` URI, and wry takes such a drop and reports it as
Tauri's native drop, after `dragend` and `dragleave` have reached the page
(`standards-linux-desktop`). So `src/dropRoute.ts` records the drag at
`dragstart` (`startTreeDrag`), and a target reads it from `treeDrag()`, never
from `dataTransfer`. In its `dragover` a target calls `offerDrop` with a
closure that captures everything the drop needs — zone, directory, point, and
whether a Markdown centre inserts — and the first offer in an event wins, so a
row beats the tree around it. `takeDrop` runs the last offer once, from a DOM
`drop` or from the native drop of a session that began in this page, with
Ctrl as GDK's keymap reports it (`windows::drop_modifiers`); `onDropEnd` tells
every target to clear its marks. `nativeSession` tells a native session begun
in this page from one another application started, whose files are copied in
or inserted instead. MIME checks remain for the native drags that never carry
a URI: panels and workspaces. `useDropZone` takes tree
drags through its `tree` option: an edge splits the group and opens the first
file there, the centre opens it — except over a Markdown document in the
Editor, where the centre writes a reference to each dragged entry at the drop
point and draws no centre overlay, the document's drop cursor showing where
it lands (`015-views-and-citations`).

**Preview tabs.** `EditorTab.preview` marks a tab opened by a single click or
by a link. `place_tab` puts a preview tab in the group's existing preview slot
rather than appending, so a group holds one (ED-29, ED-30, ED-34). `pin_editor`
clears the mark when the file is edited, double-clicked or dragged (ED-31,
ED-32, ED-33), when a chip in the tab opens a file (CITE-22a), and when a
Markdown link in the tab opens a preview in the tab's own workspace, where
that preview would take the tab's slot (CITE-22d); `Doc.open` in
`src/editor/document.ts` pins the note before it opens the file, and a link
that opens in another workspace leaves the note a preview. A chip opens its
file as a permanent tab in the group it was clicked in (CITE-22).
`open_file` asked for a permanent tab of a
file the active group already shows brings that tab forward and clears its
mark, so a chip for a file open there as the preview makes it permanent
(CITE-22b). A chip for a folder, or for a file that is not there, opens no tab
and pins nothing (CITE-22c). The mark is a field of the tab, so it survives a
restart (ED-35). A preview tab's label is italic. In Source Control's working
area a diff opened from the Commit panel's status list is a preview tab; a
diff opened from a commit is permanent.

## Rationale

- Two features that feel identical under the hand are one mechanism in the
  code: one tree, one renderer, one drop-zone hook, two callers.
- The tree expresses every arrangement the criteria describe at any depth, and
  the same-direction join keeps three columns three columns instead of a row
  inside a row inside a row.
- Splitting ownership matches what each tree holds: files belong to a project,
  furniture belongs to the person.
- An opaque `panel_layout` means adding a panel, a zone or a rule is a frontend
  change with no backend type to follow it.
- A preview mark on the tab needs no second store and no reconciliation: it is
  saved, restored and published with everything else about the tab.
- A note is read beside the files it cites. Pinning the note before a chip
  opens a file, or before a link opens a preview in the note's own workspace,
  keeps the note in its group rather than handing its preview slot to the file
  it cites; a chip's file opening as a permanent tab lets a reader open a
  note's chips one after another.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A fixed two-column split with one ratio** | One number in the session and nothing to normalise, and it holds no third column, no region below the editor and no nested stack — and the panels would still need a mechanism of their own. |
| **A docking library** | Delivers drop zones, dividers and persistence, and it brings a second layout model, a second drag implementation and a React dependency to keep aligned, for a tree the criteria already describe in full. |
| **The panel layout in the session** | Puts both trees in one store, and it makes panel placement a property of the project, so switching workspace rearranges the furniture (DOCK-08). |

## Consequences

**Easier:**
- A new drop target is a call to `useDropZone`; a new arrangement is a change
  to a tree, not to a renderer.
- The editor groups and the panels resize, persist and collapse by the same
  rules, so a fix to one is a fix to both.
- Browsing a tree or a status list leaves one tab behind rather than one per
  file looked at.

**Harder:**
- Every edit to either tree has to restore the invariants: `Layout::normalize`
  and `dock.ts`'s `collapse` renormalise sizes and fold one-child splits after
  each one.
- A tree read from a store can disagree with what it names — a group that no
  longer exists, a panel listed twice — so both sides repair before rendering.
- The backend cannot validate `panel_layout`: a malformed tree is caught by
  `normalize` in the frontend or not at all.
- The work leaf is a special case in the panel tree, exempt from the removal,
  tabbing and hiding every region is subject to.
- Opening a note's chips leaves a permanent tab for each file, which the
  reader closes by hand; within a note, only a Markdown link keeps the one-tab
  browsing a preview gives.

## Constraints imposed

- **Sizes are fractions of their parent and sum to one.** Every edit ends in a
  renormalisation.
- **The work leaf survives every edit.** `normalize` reinstates it if a stored
  layout arrives without one.
- **A group appears exactly once in its area's layout and once in its area's
  group list.** `Area::ensure_groups` rebuilds the layout as a single row when
  the two disagree.
- **A tab keeps its id when it moves**, so its editor state and undo history
  travel with it between groups.
- **A group holds at most one preview tab**, and a tab that moves between
  groups arrives permanent.
- **A tree drag's target decides in its dragover.** Nothing reads component
  state or `dataTransfer` at drop time; the drop runs the offer the last
  dragover made.

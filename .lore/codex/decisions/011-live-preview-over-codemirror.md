---
id: 011-live-preview-over-codemirror
title: 'ADR-011: The rich editor is CodeMirror rendering markdown in place'
summary: Why the rendered, editable markdown view is one CodeMirror 6 document decorated
  in place rather than a second document model such as ProseMirror, how that makes
  the byte-splice guarantee hold by construction, and what it gives up in rendering
  freedom.
related:
- 003-source-markdown-is-canonical
- 010-react-frontend
- standards-code
- 015-views-and-citations
---

# ADR-011: The rich editor is CodeMirror rendering markdown in place

## Context

`003-source-markdown-is-canonical` requires that an edit made in the rendered
view rewrites only the bytes of the block it touched, that undo spans both
views, and that a construct the editor cannot reproduce is refused rather than
approximated. Source mode already needs a code editor with line numbers, find
and replace, and syntax highlighting for five grammars.

Key forces:

- **Two document models are the risk.** A rich editor built on its own tree
  (ProseMirror, and Milkdown over it) parses markdown in and serialises markdown
  out. Keeping source byte ranges attached to nodes through arbitrary edits,
  and serialising a sub-tree back into exactly the bytes that block should
  hold, is the whole difficulty of the feature and has no established library
  answer.
- **One document model has no splice problem.** If the rendered view edits the
  source text directly, there is no second representation to reconcile: an
  edit changes the bytes the user typed over and nothing else.
- **The rendering wanted is what Typora and Obsidian do.** Prose in a
  proportional face, headings sized, emphasis and link syntax hidden until the
  cursor enters them, images shown under their line, tables and frontmatter
  drawn as tables when the cursor is elsewhere.
- **CodeMirror 6 is already the source editor.** Its decoration system
  replaces ranges with widgets, hides ranges, and styles ranges, driven by the
  same syntax tree that highlights the source.

## Decision

The rendered view is a **CodeMirror 6 view over the same document** as the
source view, with an extension that decorates the markdown syntax tree in
place: syntax marks are hidden except around the cursor, headings and emphasis
are styled, and images, audio, tables, task boxes, rules and frontmatter are
replaced by widgets while the cursor is outside them. Only a focused view
reveals syntax, so the rendered side of a split draws every line while the
source side is edited. An image, audio or video whose line holds the cursor
stays drawn after its revealed source rather than disappearing into it.

Split mode is two views over one document. Every change made in either view
is forwarded to the other, and only the source view carries the undo history,
so one history holds the edits of both views in order.

Widgets that edit — a task checkbox, a frontmatter value — write the specific
bytes they stand for. No widget re-serialises anything larger than the text
it replaces.

## Rationale

- The byte-splice guarantee holds by construction: there is no serialiser, so
  nothing outside the edited text can change.
- Undo, cursor mapping between modes, and live sync between panes are all
  properties of one shared document rather than features to build.
- An unrepresentable construct does not exist: anything the decorator does not
  recognise is shown as source and edited as source.
- The parse that drives highlighting is the parse that drives rendering, so
  the two never disagree.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **ProseMirror, via Milkdown or directly** | The most faithful WYSIWYG rendering, and it carries a second document model whose serialiser has to reproduce bytes it never saw; the round trip through remark is equivalent markdown, not identical, and the splice bookkeeping is unproven. |
| **A contenteditable HTML view with a custom serialiser** | Full rendering freedom, and everything the other option carries plus a serialiser written from scratch. |
| **Rendered pane read-only** | Removes the problem, and removes the product's defining capability. |

## Consequences

**Easier:**
- One document, one history, one parse, one place to style.
- A rendered construct is opted into one at a time; source is the fallback
  for everything else.

**Harder:**
- Rendering is bound to the line structure of the source: a table is a widget
  or source text, never a freeform grid; a paragraph wraps where the source
  wraps only when the source is hard-wrapped.
- Widgets that edit have to compute the exact bytes they stand for.
- Two views over one document forward every change, and a change annotated
  as forwarded has to be excluded from forwarding back.

## Constraints imposed

- **The source view owns the history.** The rendered view has none; its undo
  keys act on the source view.
- **A forwarded change is annotated** and never forwarded again.
- **A widget edits the text it replaces and nothing else.**

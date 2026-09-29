---
id: 011-live-preview-over-codemirror
title: 'ADR-011: The rich editor is CodeMirror rendering markdown in place'
summary: Why the rendered, editable markdown view is one CodeMirror 6 document decorated
  in place rather than a second document model such as ProseMirror, how that makes
  the byte-splice guarantee hold by construction, how the view hides the syntax for
  good and keeps the caret out of it, and what it gives up in rendering freedom.
related:
- 003-source-markdown-is-canonical
- 010-react-frontend
- standards-code
- 015-views-and-citations
binds:
- src/editor/preview.ts
- src/editor/rich.ts
- src/editor/format.ts
- src/editor/toolbar.ts
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
- **The rendering wanted is a word processor's.** The first rendered view
  worked as Typora and Obsidian do: it showed the syntax of the line holding
  the caret. A click turned the line into Markdown and moved the text under the
  pointer, and headings' top margins, which CodeMirror's height map does not
  count, put the caret one or two lines below a click (FIX-20). Rich mode is
  meant to edit as LibreOffice Writer or Google Docs does, with the caret never
  meeting a Markdown character.
- **CodeMirror 6 is already the source editor.** Its decoration system
  replaces ranges with widgets, hides ranges, and styles ranges, driven by the
  same syntax tree that highlights the source, and its atomic ranges keep the
  caret out of a range.

## Decision

The rendered view is a **CodeMirror 6 view over the same document** as the
source view, with an extension that decorates the markdown syntax tree in
place. It never shows Markdown syntax — not on the caret's line, not in a
selection, not in a table or frontmatter, and the same whether or not it has
focus. Headings and emphasis are styled; heading, quote, emphasis,
strikethrough, code-span and link syntax is hidden; a bullet and a task box are
drawn in place of their marks; images, audio, video, citations, rules,
frontmatter and code fences are replaced by widgets. An image, audio or video
is drawn as the media when it is a Markdown image, or a citation on a line of
its own (`015-views-and-citations`); a cited file anywhere else is a chip. A
rule is an inline box the width of its line, not a block: a block inside a
line puts CodeMirror's spacers on empty lines of their own either side of it,
and ArrowDown stops on the one below for good.

A table is drawn from its own lines and edited in its cells. Each row is one
CodeMirror line drawn as a table row, and each cell's text is a mark drawn as a
table cell; the pipes and the spaces around each cell are hidden syntax, and
the delimiter row is folded into the header row's line. The rows sit in a
CodeMirror block wrapper, a box of their own, so the browser lays them out as
one table. CodeMirror draws only the rows near the viewport, and the browser
sizes a table's columns from the rows it is given, so the rendered view sizes
them itself: `TableColumns` in `preview.ts` lays every row of a table out off
screen, in the page's own styles, for each column's narrowest and widest
layout, and holds every drawn cell at its column's width with an equal
`min-width` and `max-width` (`standards-linux-desktop`). The widths are CSS's
automatic table layout over all the rows: each column's widest layout when
they all fit the box, its narrowest when even those do not, and otherwise its
narrowest plus a share of the room left in proportion to how much wider it
could be. A column keeps its width whichever rows are drawn. A table is
measured when it is first drawn, again once edits to it, an image loading in
it or news of a cited file have settled for 400 ms, keeping its widths
meanwhile, and again when the fonts change; a new width of the box shares the
room out again without measuring. The syntax hidden after each cell is a cell
of no width, a box the
row's height at the start of the next cell: CodeMirror's hit-testing and
vertical motion find a row's top and bottom, and which cell lies under the
pointer, from those boxes. Every row has one after each cell, so they make
columns of no width. The syntax before the first cell, which a row may lack,
and CodeMirror's spacers are taken out of the flow and make no column. None of
them can be an absolutely positioned box the row's height, because WebKitGTK
never sizes one by its table row (`standards-linux-desktop`). The cell marks
are outer decorations, so no other mark splits a cell in two. The table is laid out as
VSCode's Markdown preview lays it out: a bold header row over a rule, a thin
rule between body rows, no vertical rules and no outer box, cells padded 5 px
by 10 px and centred vertically, and a column's `:---:` or `---:` alignment
honoured, in the active theme's colours. The box scrolls sideways when the
table is wider than the pane; its inline-size containment keeps the table's
width out of the document's, so the document never scrolls sideways. The
containment is `contain: inline-size` rather than a query container, which
WebKitGTK lets move the scroller back as CodeMirror redraws the rows inside
it (`standards-linux-desktop`). The cells
do not inherit CodeMirror's `overflow-wrap: anywhere`, which lets the browser
size every column down to one letter, so no column is narrower than its
longest word. A cell's text is decorated as a paragraph's is: emphasis, inline
code, links, a citation as a chip, and an image scaled to the cell's width.
`<br>`, in any letter case and with or without a closing slash, is a line break
drawn as one object: a `<br>` inside a wrapper with no box, so a click or a
vertical move past the end of the line it ends stays on that line. An empty anchor, `<a id="…"></a>` or `<a name="…"></a>`,
draws nothing in any renderer, so it hides as one piece of syntax, in a cell or
anywhere else. Any other inline HTML tag shows as dim source. A click on
a chip in a cell opens the file, and a Ctrl+click on a link follows it, without
moving the caret; any other click puts the caret in the text of the cell under
the pointer.

The rendered view draws headings in the text colour, with a full-width rule
under `#` and `##`; the source view keeps the theme's heading colour. Inline
code, in a paragraph and in a table cell, sits on a rounded background mixed
from the theme's code background and a tenth of its text colour, so it stands
apart from the page in every theme.

Split mode is two views over one document. Every change made in either view
is forwarded to the other, and only the source view carries the undo history,
so one history holds the edits of both views in order. In rich mode the source
view also takes the rendered view's caret, with each edit and each move, so an
undo puts the caret back where the edit was; the two panes of a split each
keep their own caret.

Widgets that edit — a task checkbox, a frontmatter value, a code block's
language label — write the specific bytes they stand for. No widget
re-serialises anything larger than the text it replaces.

### Hidden syntax and the caret

`src/editor/rich.ts` works out, from the syntax tree alone, what the rendered
view hides, where its caret may stand and which bytes each of its keys
changes; `src/editor/preview.ts` draws what it describes and binds the keys.

- **Pieces and runs.** Each piece of syntax on a line — a heading's `#`s and
  the space after them, a quote's `>`, emphasis, strikethrough and code-span
  marks, a link's `[` and `](…)`, an autolink's angle brackets, the backslash
  of an escape or a hard break, a list marker, a task box, a line's
  indentation — is a piece, and pieces are atomic ranges
  (`EditorView.atomicRanges`): the pointer, a drag and CodeMirror's own motion
  never leave the caret inside one. Pieces that touch form a run, which is one
  place on screen however many positions it spans.
- **Motion.** An arrow press moves one visible character — a character, an
  object, or a line break with the hidden lines beside it — and never spends a
  press crossing a run. Ctrl+arrows move by word over the visible text.
  ArrowUp and ArrowDown move one visual line, and a caret they put down keeps
  the column they are heading for when the view moves it off hidden syntax.
- **Objects.** An image, a citation and a rule are objects: one arrow press
  steps over one, Backspace after it or Delete before it deletes all its
  bytes, and a click on an image selects it, drawn with an outline, so Delete
  removes it. A click on a chip opens its file.
- **Where typed text goes (RICH-03).** Each run has one typing position, and a
  caret that the pointer, a key or the other view puts in a run moves to it.
  Typed text joins the visible text before the caret and takes its
  formatting, so at the end of bold it goes inside the closing `**`. With
  nothing visible before it on the line, it takes the formatting of the text
  after it. It always goes after a block's marks, and never inside a link at
  either end of the link's text. A caret an edit leaves at another position of
  its run stays there while text typed there leaves every construct whole:
  after a word typed as `**word**` the caret stands after the closing marks,
  and the next word is plain. A keystroke the page reports on the far side of
  a hidden mark is written at the caret.
- **Deletion.** Backspace and Delete take visible text. Deleting all of a
  construct's text deletes its syntax with it, so no `****` or `[](…)` is left
  behind; a deletion that covers only part of a construct keeps the
  construct's syntax, and so does text typed, pasted, cut or dragged away over
  such a selection. A closing mark after whitespace no longer closes, nor an
  opening mark before it, so the whitespace a deletion leaves against the
  inside of a kept mark comes out of it: deleting `and` from `**bold and**`
  leaves `**bold**`. The whitespace goes when whitespace or a line's edge
  stands outside the mark; the mark moves in over it when a word does, and
  for Backspace or Delete of one character, which takes one visible
  character and leaves the space. `mended` in `rich.ts` then checks every
  deletion, and text typed over one, that touches syntax against a fresh
  parse of the text blocks it touches; a construct whose marks would still
  show as text loses them and keeps its text. A deletion that covers a code
  block or frontmatter only in part keeps its fence lines and the line breaks
  that join them to the text, so the rest of the document never turns into
  code. Backspace at the start of a block belongs to `backspaceBlock` in
  `format.ts`, which runs first; the rendered view's Backspace and Delete run
  next, ahead of the Markdown keymap's Backspace, which takes only hidden
  marks.
- **Typing over a selection.** Text typed or pasted over a selection replaces
  the visible text it covers: a selection starting before a line's block
  marks keeps them, one covering exactly a word's text keeps the word's
  formatting, and a selection of whole lines, as a triple click makes it,
  keeps the paragraph break after its last line. Pasted or dropped text that
  holds a line break closes the formatting it lands inside before its first
  line break and reopens it after its last, as Enter does. Dropped text lands
  where the caret could stand, without the syntax of any construct it lands
  inside, whose formatting it takes: `**and**` dropped into bold lands as
  `and`, and inside a code span only visible text lands. A drop that would
  still leave a mark showing lands as plain text. A word dragged out from
  between two spaces takes one of them with it.
- **Table cells (RICH-11).** A cell's text is edited as text, so typing,
  selection, undo and the character formatting commands work in a cell as in
  a paragraph, and an edit changes that cell's bytes and no other. The pipe
  between two cells, with the spaces beside it, is a piece the caret stands on
  either side of and never inside: a run never spans it, one arrow press
  crosses it, and a caret at the end of a cell's text is drawn, and typed at,
  before its position, so neither the caret nor the next letter crosses into
  the next cell. An empty cell's first space is one place for the caret, and a
  cell with nothing between its pipes is drawn by a widget. Spaces typed at
  the end of a cell are drawn in it and hold the caret until a word follows
  them. Tab and Shift+Tab move to the end of the next or previous cell's text,
  row after row, and stay put at the table's first and last cells; Enter moves
  to the same column of the next row, and from the last row to the line below
  the table; Home and End move to the edges of the cell's text; Shift+Enter
  writes `<br>`. Text typed, pasted or dropped into a cell, or written there by
  a command, is written as the cell can hold it: a pipe as `\|`, a line break
  as `<br>`; a deletion that leaves a backslash just before the cell's pipe
  escapes it. Backspace and Delete stop at a cell's edges. A deletion across
  cells takes their text and keeps every pipe it reaches, the delimiter row,
  the line breaks between rows and the blank lines that set the table apart;
  one that covers the whole table takes it whole.

### Blank lines, code and source boxes

- **Paragraphs (RICH-19).** A run of blank lines between two blocks is hidden:
  it folds into the line above it, or into the widget above it, and the line
  after it opens with paragraph spacing. The caret crosses it in one step. A
  blank line holding the caret stays drawn: it is an empty paragraph being
  typed into. Enter at the end of a paragraph or heading writes one blank line
  and starts a new paragraph; in the middle it splits the block, closing and
  reopening any formatting the split falls inside, and a split heading stays a
  heading of its level on both sides: an ATX heading's second half takes its
  `#`s, and a setext heading's first half a copy of its underline, wherever
  in its lines the split falls. A split never falls between an opening mark
  and its text, and never inside an autolink, which it leaves whole at its
  nearer edge. At the start of a line inside a paragraph, the line break before it
  becomes the paragraph break; at the start of the block, Enter opens an empty
  paragraph above. Whitespace at the cut goes. The second half stays a
  paragraph: indentation that would open a code block goes, a mark that
  would open a list, a link definition or an HTML block is escaped (`2\.`,
  `\[`, `\<`), and a split that neither saves is written as a hard break,
  its new line escaped alike; one the hard break cannot save either writes
  nothing. Enter in an empty paragraph writes nothing, since Markdown holds no empty
  paragraphs, and Backspace there removes it. Shift+Enter writes a hard break
  as a trailing backslash, indented to stay in its quote or list item. In a
  list or a quote Enter continues it, as in the source view, and text typed on
  an empty line directly under a list item or a quote gets a blank line before
  it, so it starts a paragraph rather than continuing the item.
- **Code blocks (RICH-13).** A fenced code block is a box without its fences.
  The opening fence is drawn as the box's top, with the info string as a small
  label whose edits write only the info string's bytes; the closing fence is
  the box's bottom; the lines between are edited as code and keep the
  highlighting of the fence's language. An arrow past the box's last line
  leaves it. A fence being typed shows as typed until Enter, which writes the
  closing fence — and, at the end of the document, a line after it — and puts
  the caret inside.
- **Source boxes (RICH-15).** An HTML block, an HTML comment, a link reference
  definition, a footnote definition and any other construct the renderer does
  not draw shows its source in a separate monospace box and is edited there as
  plain text.

### Formatting commands and the toolbar

Rich mode formats text through commands. `src/editor/format.ts` holds one per
piece of formatting — bold, italic, strikethrough, inline code, body text and
headings 1 to 3, bulleted, numbered and checklist items, quotes, fenced code
blocks and links — and each reads the document's syntax tree and returns one
transaction. The transaction writes the syntax of the construct it formats,
and only what else that syntax needs to read as meant: a backslash before a
plain delimiter, a blank line before a list item, a mark closed and reopened
across a line it cuts, a hard break's `\` that would show. It never changes
visible text anywhere else:

- `toggleMark` formats the selection, or the word holding the caret as rich
  mode shows it, hidden syntax and all, with `**`, `*`, `~~`, or a backtick
  fence one longer than any backtick run inside; a code span takes the
  emphasis and link syntax inside it away and keeps the text. Text that
  carries the formatting throughout loses it; text that carries it in part
  gets one run over the whole. A range that starts or ends inside a link's
  destination, a code span, a citation or emphasis it only partly covers widens
  to take that construct in, so no marker it writes cuts another construct.
  Punctuation at either end of the range that stands against a letter outside
  it stays outside the run, since CommonMark's flanking rules let no marker
  open or close there. Where a marker still cannot open or close — a
  construct taken in is glued to a letter — or would stop the mark of a
  construct beside it opening or closing as it did, that end of the run moves
  out over the rest of its word; a code span instead takes the construct whose
  mark it would stand against in whole, and drops its formatting with the rest
  of what it holds, escapes' backslashes included. In a table cell a code span
  keeps the backslash of each `\|`: GFM drops it inside the code there, and
  without it the pipe would end the cell. `lineSyntax` hides that backslash
  as it hides an escape's, so the cell shows the `|` GitHub shows; outside a
  table the backslash stays, as GFM reads it there. Taking formatting off part
  of a run closes the run before the part and reopens it after, outside the
  whitespace at each cut; a construct nested in the run that the part reaches
  into loses the formatting whole, and the same formatting nested in the run
  is dropped. A `_` run that cannot close or reopen at a cut is written with
  `*`. With the caret between words the format is pending instead:
  `pendingField` holds it until the caret moves, and `typeWithPending` writes
  the next text typed there inside the markers.
- `setHeading` writes or removes only the `#`s. A setext heading becomes an ATX
  heading when its level changes, since its underline is what carries the level.
- `toggleList` and `toggleQuote` act on each selected line, since rich mode
  draws each line of a paragraph as a line of its own: a hard-wrapped
  paragraph's lines each become an item, and turning the items back gives the
  same lines. An item already of the kind keeps its bytes. A bullet is written
  `-`, a checklist item `- [ ]`, and a numbered item counts from 1. A heading
  keeps its `#`s after a bullet or a number, as GFM holds a heading in a list
  item; a checklist item holds only text, so a heading made one drops them.
  The list an item leaves, or changes kind in, stays whole: `toggleList`
  writes a blank line before a next item that could not start a list after it
  — a numbered item not counting from 1, or an empty one — and before text
  taken out of a list when an item stands above it, which would otherwise
  read either as the other's text.
- A line that `setHeading` or `toggleList` cuts out of a paragraph takes the
  `\` of the hard break at the cut with it, as that backslash would show.
  Formatting across the cut — emphasis, strikethrough, a code span, a link's
  text — closes at the end of the line above and reopens at the start of the
  line below, as Enter splits a paragraph (`lineCut`), so
  `**an important\nphrase**` cut there becomes `**an important**` and
  `- **phrase**`. What cannot close and reopen, such as an image or an HTML
  tag across the break, leaves the command doing nothing.
- `toggleCodeBlock` fences whole lines. In a list item or a quote the fences
  go inside it, after its marker, and every line carries the item's
  indentation or the quote's `>`; a table row or a checklist item takes none.
- `backspaceBlock` handles Backspace at the start of a heading, list item,
  checklist item or quote by removing that block's syntax, the innermost first,
  and at the start of a plain paragraph by deleting the blank lines between it
  and the text block above, which joins the two. A list item's text gets a
  blank line before it when a line of text stands above, and before a next
  item that could not follow a paragraph, so it becomes a paragraph of its own.
  A heading holds one line, so a paragraph of several lines joined to one
  gives it its first line, and the rest stays a paragraph, cut as `setHeading`
  cuts one.
- `insertLink` writes `[text](target)`, percent-encoding the characters that
  end a destination, a pipe and a backslash, and escaping a bracket in the
  text, or in a table a pipe, so neither ends the link or its cell, and a
  backtick run that nothing after it in the text closes, which would open a
  code span past the link's end. `updateLink` rewrites
  only a link's text or destination, written the same way, and `removeLink`
  deletes its brackets and destination and keeps its text.
- Code, frontmatter and the source boxes take no formatting and no link:
  `toggleMark`, `insertLink`, the paragraph styles and the list commands do
  nothing there, and Ctrl+K opens no popover (`linkable`).

The character formatting commands — `toggleMark`, `typeWithPending`,
`insertLink`, `updateLink` and `removeLink` — check their changes against the
parser before they return them, since a marker's meaning depends on every
delimiter around it and no rule written against the syntax tree foresees them
all. `checked` in `format.ts` parses each text block the changes touch, before
and after them, with the document's own Markdown parser (`language.parser`),
the block's text standing alone: a paragraph's lines, a heading's, a checklist
item's or a table cell's text, with its quote marks blanked. It compares the
two readings character by character, and passes the changes only when the
visible text is the same, no block starts or ends — a `~~~` or three backticks
at a line's start opens a code fence over the rest of the document — every
construct outside the run the command writes or cuts is as it was, and the
text the command formats carries the construct throughout, or none of it,
past punctuation a marker cannot open or close by. A link whose text or
target the link popover writes afresh passes when every visible character in
its place reads as a link to that target. A code span may drop what it holds,
and a new link a bare address in its text; text may become a bare address or
an emoji's code with nothing written for it. In a table cell, `checked` also
counts the cells of the row before and after the changes, as the GFM parser
splits them at each pipe no backslash escapes, and fails a change that would
split or join a cell. At a caret outside every text block, `insertLink`
writes a link only on a line of prose holding no text, and only when a fresh
parse reads it as a paragraph of its own: it refuses one that the paragraph
or list item above would take in as a line, or that a `---` below would make
a heading. When the check fails,
`checked` escapes, with a backslash, each plain `*`, `_`, `~`, backtick or
bracket the changes turned into syntax and each plain one of the markers' own
characters in or beside the run, and checks again, at most three times while
it finds more to escape. When it still fails the command returns no
transaction and the document stays as it was; text typed with pending
formatting that fails is typed plainly, and the link popover stays open with
a line saying nothing was written.

The block commands — `setHeading`, `toggleList`, `toggleQuote` and
`backspaceBlock` — are checked by `blockChecked`, since what they write at a
line's start can change how the text after it reads. It parses the document
after the changes, reusing the old syntax tree wherever the changes do not
reach, and passes them only when every visible character of the text blocks
they touch, and of the lines on either side, reads the same and under the
same inline constructs as before. A block's syntax may change; its text and
formatting may not, so a next item read as text, a `**` left without its
pair, or a backtick that would pair across a join fails, and the command
does nothing.

`checked` parses the texts of all the blocks a command touches as one text,
a blank line apart, once before the changes and once for each try; with the
escape fallback that is at most four tries, five parses in all. A text that
parses into anything but text blocks, such as a fence, is read again alone.
Nothing else is parsed. `toggleMark` on a word or a sentence takes under a
millisecond with the check, in a document of 850 lines or of 8,500. Bold over
a whole 8,500-line document, 13,000 changes in 5,000 text blocks, takes about
200 to 240 ms, about a third of it in the two parses, and a 17,000-line
document takes about twice that. `blockChecked` reparses only where the
changes reach: a heading, list or quote command on one line takes under half
a millisecond in the 850-line document and about 2.5 ms in the 8,500-line
one.

Every command's transaction carries `isolateHistory`, and `Doc` forwards that
annotation with the change into the source view, whose history therefore holds
each command as one entry: one Ctrl+Z undoes one command.

`src/editor/toolbar.ts` binds the commands in the rendered view only. The
toolbar is a CodeMirror top panel, so source mode and the source side of a
split have none; the link popover is a CodeMirror tooltip. The shortcuts are a
keydown handler at the highest precedence that matches the physical key
(`KeyboardEvent.code`) with Ctrl held, ahead of CodeMirror's default keymap,
which binds Ctrl+I to selecting the parent syntax node. A press on the toolbar
is never a focus change, so the selection stays in the text, and each control
reads its pressed state from `formatState`, which reads the tree as far as it
is parsed and never forces more.

Copying from the rendered view puts two forms on the clipboard.
`clipboardContent` makes the plain text the selection's Markdown, standing
alone: a selection starting where a line's text starts takes the line's block
syntax, and one starting or ending inside emphasis, a code span or a link gains
the syntax it cut off. It builds the HTML by walking the syntax tree over the
same range. Every piece of document text is escaped, no markup from the
document passes through, and a link keeps its target only when that target is
a web or mail address. A drag out of the rendered view carries `dragText`
instead of the raw slice CodeMirror would carry: the same inline syntax closed
and reopened where the selection cuts through emphasis, a code span or a link,
so `ld** an` dragged out of `**bold** and` drops as `**ld** an`, and no block
syntax, since the drop lands inside a line. A copy, a cut and a drag carry the
same text otherwise: part of a web address, an autolink or an HTML tag is that
part, since a cut or a drag removes only that much (`deletion`), and carrying
the whole would write the rest twice. `toolbar.ts` supplies it through
`EditorView.clipboardOutputFilter` for text equal to the selection's source,
which a drag's is and CodeMirror's own copy of a caret's line is not.

## Rationale

- The byte-splice guarantee holds by construction: there is no serialiser, so
  nothing outside the edited text can change.
- Undo, cursor mapping between modes, and live sync between panes are all
  properties of one shared document rather than features to build.
- An unrepresentable construct does not exist: anything the decorator does not
  recognise is shown as source, in a box of its own, and edited as source.
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
- Rendering is bound to the line structure of the source: a table row is one
  line, so a line break inside a cell is a `<br>` and a table is never a
  freeform grid; a paragraph wraps where the source wraps only when the source
  is hard-wrapped.
- CodeMirror draws only the lines near the viewport, so a table's columns are
  sized apart from the rows drawn: every row of the table is laid out a second
  time, off screen, when the table is first drawn and after an edit to it
  settles, about 35 ms for a table of 200 rows.
- CodeMirror also draws the lines holding the selection's ends when they lie
  outside the viewport. The rendered view decorates those lines as well as the
  visible ones; a heading drawn plain there would change height each time it
  crossed the viewport's edge, and move the text beside it.
- A caret beside a hidden table pipe belongs to one cell only by the side it
  is drawn on, so the rendered view sets that side on every caret it leaves
  there.
- Widgets that edit have to compute the exact bytes they stand for.
- CodeMirror's own motion and deletion treat hidden syntax as text: they stop
  inside it and delete it by the character. The rendered view binds its own
  arrows, deletion and Enter, and filters every caret it is given.
- An empty paragraph exists only while the caret is in it. The blank lines one
  leaves behind when the caret moves on stay in the file, folded into the
  paragraph spacing.
- Two views over one document forward every change, and a change annotated
  as forwarded has to be excluded from forwarding back.

## Constraints imposed

- **The source view owns the history.** The rendered view has none; its undo
  keys act on the source view.
- **A forwarded change is annotated** and never forwarded again.
- **A widget edits the text it replaces and nothing else.**
- **A widget never hands document text to the page as HTML.** A document is
  untrusted input: a widget builds its DOM node by node and sets text as text.
- **The rendered view never shows syntax.** Each piece of syntax is hidden,
  drawn as a glyph, or shown in a source box, and the caret never stands
  inside one.
- **Every key the rendered view binds is one splice.** It changes only the
  bytes of the construct it touches, in one transaction, so one undo takes it
  back.
- **A character formatting command writes what the parser reads as promised,
  or nothing.** Its changes pass `checked` before it returns them; a command
  that fails the check returns no transaction.
- **No vertical margin in the rendered view.** A line's or a block widget's
  vertical space is padding or a border. CodeMirror's height map does not count
  margins, and a click lands below the line under the pointer by as much as
  the margins above it add up to (FIX-20).

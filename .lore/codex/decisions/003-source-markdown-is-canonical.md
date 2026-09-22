---
id: 003-source-markdown-is-canonical
title: 'ADR-003: Source markdown is canonical; rich edits splice byte ranges'
summary: Why an edit made in the rendered pane rewrites only the byte range of the
  block it touched instead of re-serialising the document, what that protects, and
  the constraint it puts on the editor's document model.
related:
- vision-agentic-workspace
- standards-code
- 011-live-preview-over-codemirror
---

# ADR-003: Source markdown is canonical; rich edits splice byte ranges

## Context

The editor renders markdown as rich text and lets the rendered side be edited.
Every such editor must answer one question: when the user edits the rendered
representation, what is written to the file?

The documents this product is built for are hand-formatted and version
controlled — specifications, agent instructions, codex documents. They carry
deliberate choices a markdown serialiser does not preserve: which emphasis
character, which bullet character, where lines wrap, how a table is padded, how
YAML frontmatter is laid out.

Key forces:

- **A round-trip through a document model is lossy.** Parsing markdown to a
  tree and serialising it back produces *equivalent* markdown, not *identical*
  markdown.
- **Files are shared with agents and with git.** A whole-file rewrite makes a
  one-word change indistinguishable from a reformat, in review and in any diff.
- **The same file is edited from both sides.** A person edits in the editor and
  an agent edits on disk, so a change has to be attributable to what caused it.

## Decision

The markdown text on disk is the canonical representation. The rendered view is
derived from it.

Every block in the rendered view carries the byte range of the source text it
came from. An edit in the rendered view re-serialises only the affected block
and splices that byte range. An edit spanning several blocks splices the
smallest enclosing range. Every byte outside the spliced range is left
untouched.

## Rationale

- It makes the guarantee checkable and absolute: edit one paragraph, and the
  rest of the file is byte-identical. A style configuration only narrows the
  damage, it does not remove it.
- Markdown parsers already report source positions for every node, so the
  ranges needed are a product of parsing rather than extra bookkeeping.
- It removes a configuration surface entirely. With nothing reformatted, there
  is no house style to agree on.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Re-serialise the whole document with a style config** | Far simpler, and yields consistent formatting. But the first rich edit to any existing file rewrites it wholesale, and no configuration reproduces a human's wrap points. |
| **Rendered view canonical, file as an export** | Gives the rich editor full freedom, but the file stops being the source of truth — which is untenable when an agent edits the same file directly. |
| **Rendered view read-only** | Sidesteps the problem, and is what a conventional markdown preview does. It also removes the product's distinguishing capability. |

## Consequences

**Easier:**
- A change to a document is attributable to the edit that caused it.
- Frontmatter, hand-wrapped prose and deliberate formatting survive editing.
- No markdown style settings exist to configure or argue about.

**Harder:**
- The document model must track source positions through edits, not only at
  parse time.
- A construct the serialiser cannot reproduce faithfully has to be detected and
  refused in the rendered view rather than written incorrectly.
- Splice ranges must be recomputed or invalidated when the file changes
  underneath the buffer.

## Constraints imposed

- **An unrepresentable edit is refused, not approximated.** Where the rendered
  view cannot round-trip a construct, it declines the edit and directs the user
  to source mode.
- **Undo spans both representations.** Edits made in the source pane and the
  rendered pane share one history.
- **Saving is atomic** — write to a temporary file in the same directory, then
  rename — because an agent may read the file while it is being written.

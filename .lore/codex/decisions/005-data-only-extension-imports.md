---
id: 005-data-only-extension-imports
title: "ADR-005: Import theme and grammar data, never run extension code"
summary: Why colour themes and TextMate grammars are read as data out of
  VSCode extension packages while no extension host exists, what that buys in
  compatibility, and the fidelity limit it accepts in return.
related:
  - vision-agentic-workspace
  - 006-no-language-intelligence
  - standards-code
---

# ADR-005: Import theme and grammar data, never run extension code

## Context

A large body of editor customisation exists as VSCode extensions. Two kinds of
it are wanted here: colour themes, and syntax grammars for languages outside the
built-in set.

A VSCode colour theme is a JSON file with two halves. The `colors` half names
workbench surfaces — `editor.background`, `sideBar.border`, `terminal.ansiRed`
— and is plain data. The `tokenColors` half assigns colours to TextMate scopes,
which only an editor built on TextMate grammars consumes directly.

Key forces:

- **Both artifacts are data**, distributed inside a `.vsix`, which is a zip
  archive. Neither needs code to execute in order to be read.
- **An extension host is a large, permanent commitment** — an API surface, a
  sandbox, a versioning contract, and a security boundary.
- **Third-party code would run with the application's authority**, which
  includes the user's repositories and every terminal session in them.

## Decision

Two narrow importers read data out of theme and grammar files, including from
inside a `.vsix`. No extension host exists and no third-party code is executed.

`colors` keys map directly onto application surfaces. `tokenColors` scopes map
onto the editor's highlight tags through a documented translation table.
`semanticTokenColors` is ignored rather than approximated.

## Rationale

- It delivers the part of the ecosystem that is actually wanted — the way an
  editor looks — at the cost of reading two file formats.
- Reading data has a bounded failure mode: a malformed file fails to import.
  Running code does not.
- Ignoring what cannot be translated faithfully is preferable to approximating
  it, because an approximation is indistinguishable from a bug.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A full extension host** | Unlocks the ecosystem, and is a product in itself — sandboxing, an API contract, a marketplace, and third-party code holding the application's authority over the user's repositories. |
| **Built-in themes only** | No parsing, no fidelity gap, and every theme intentional. It also refuses a reasonable request for a theme the user already uses. |
| **Adopt a VSCode-derived editor component** | Consumes VSCode themes and grammars natively at full fidelity, and is built for code rather than for rich-text markdown editing, which is this editor's primary job. |

## Consequences

**Easier:**
- A theme the user already has can be imported and recognisably applied.
- Language coverage can grow without the built-in grammar set growing.

**Harder:**
- Scope-to-tag translation is imperfect, and its gaps have to be reported to
  the user rather than left to look like defects.
- Every imported file is untrusted input and must be validated before use.
- A pathological grammar pattern must not be able to hang the editor.

## Constraints imposed

- **No imported artifact executes.** Themes and grammars are parsed as data.
- **Unmappable scopes are reported.** An import that could not translate part
  of a theme says so, and names what it fell back to.
- **A failed import changes nothing.** The active theme and grammar set survive
  a malformed, truncated or hostile file.

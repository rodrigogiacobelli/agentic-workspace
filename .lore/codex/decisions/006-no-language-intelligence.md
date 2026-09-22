---
id: 006-no-language-intelligence
title: "ADR-006: No language servers; five built-in grammars"
summary: Why the editor carries no language server, autocomplete or diagnostics,
  why syntax highlighting ships for markdown, HTML, JSON, TOML and YAML alone,
  and how a file outside that set behaves.
related:
  - vision-agentic-workspace
  - 005-data-only-extension-imports
---

# ADR-006: No language servers; five built-in grammars

## Context

The editor opens whatever is in the project, including source files. How much
it should understand about them is a scope question that decides the size of
the product.

Key forces:

- **The work here is prose.** Specifications, notes, agent instructions and
  documentation are what gets read and written; code is largely written by the
  agent running in the terminal.
- **Language intelligence is unbounded work.** A language server per language,
  a protocol client, indexing, and a UI for completion, diagnostics, hovers and
  renames — each with per-language behaviour.
- **An IDE already exists on this machine.** Nothing here replaces one, and
  competing with one means losing.

## Decision

The editor provides no language server, autocomplete, diagnostics, go-to
definition, rename or debugger.

Syntax highlighting ships for **markdown, HTML, JSON, TOML and YAML**, and for
fenced code blocks in markdown using the same set. Any other file opens fully
editable as plain monospace text, with no highlighting, no warning and no error.

## Rationale

- The five grammars cover what this product's documents and configuration are
  written in, which is where the reading and editing happens.
- An unknown language being an ordinary case, rather than a degraded one, keeps
  every file openable without a per-language gate.
- Coverage beyond the five is reachable through grammar import
  (`005-data-only-extension-imports`) without the built-in set growing.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Full language-server support** | Makes source editing pleasant, and is effectively building an IDE — the larger part of the product's work, for the part of the work the agent does. |
| **Ship many built-in grammars** | Cheaper than language servers and broadens highlighting, but each grammar is maintenance, and the marginal ones are exactly the ones import exists for. |
| **Markdown only, other files read-only** | Sharpens the product's focus, but editing a `.gitignore` or a config file is routine and being unable to do it is an obstruction. |

## Consequences

**Easier:**
- Opening a file needs no language detection to succeed.
- The scope-to-tag translation for imported themes has five grammars to satisfy
  rather than fifty.

**Harder:**
- This application's own Rust and TypeScript sources are edited in it without
  highlighting until grammar import exists.
- A file whose extension misnames its language needs a manual override.

## Constraints imposed

- **An unknown language is not an error state.** No warning, no banner, no
  degraded mode — plain text is a first-class way to open a file.
- **Language can be overridden per path**, and the override is remembered.
- **Fenced code blocks use the same grammar set** as files, selected by the
  fence's info string.

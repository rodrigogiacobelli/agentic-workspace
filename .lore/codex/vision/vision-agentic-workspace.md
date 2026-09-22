---
id: vision-agentic-workspace
title: Agentic Workspace — product vision
summary: What Agentic Workspace is for — holding several agent-driven projects
  open at once so switching between them costs nothing, the switching cost that
  motivates it, the shape that answers it, and the boundaries that keep it from
  becoming an IDE.
related:
  - 001-two-os-windows
  - 002-backend-owned-terminal-sessions
  - 007-workspace-is-one-directory
  - 006-no-language-intelligence
binds:
  - docs/acceptance-criteria.md
  - README.md
---

# Agentic Workspace — product vision

Agentic Workspace is a Linux desktop application for working on several
agent-driven projects at once. Its purpose is to make switching between them
cost nothing.

## The cost it removes

Working with a coding agent produces a per-project arrangement: an agent running
in one terminal, a dev server in another, a shell for git in a third, and a set
of documents open beside them. The arrangement takes a minute to build and holds
the state of the session.

A general-purpose editor and a terminal emulator do not hold that arrangement
per project. Moving to a second project means opening more windows and leaving
the first project's windows behind, or closing them and rebuilding later.
Neither scales past two projects. The agent left running in the first project is
behind a stack of windows, still working, with nothing reporting that it
finished.

The cost is therefore two things at once: rebuilding the arrangement, and losing
sight of work that continues without supervision.

## The shape that answers it

**A workspace is one directory**, and it owns the whole arrangement for that
project — file tree, open documents, terminals, git context. Switching workspace
swaps all of it in one action.

**Terminals outlive the switch.** A workspace moved to the background keeps its
processes running and keeps collecting their output. Returning to it shows the
terminals as they would have been had they stayed on screen.

**The application reports unsupervised work.** A background workspace whose
terminal produces output is marked, and a background terminal that goes quiet
after being busy raises a notification — the two observable signs that an agent
has finished or is waiting for an answer.

**Documents are the primary surface.** Most of the work is reading and writing
markdown — specifications, notes, agent instructions, project documentation —
so the editor renders and edits markdown as rich text rather than treating it as
source code with a preview attached.

## Boundaries

Three boundaries keep the product from expanding into an IDE, and each is a
recorded decision rather than a matter of scheduling:

- **No language intelligence.** No language servers, no autocomplete, no
  diagnostics, no debugger (`006-no-language-intelligence`). Writing code is the
  agent's work.
- **No extension host.** Two narrow importers read data — colour themes and
  TextMate grammars — and neither executes third-party code
  (`005-data-only-extension-imports`).
- **One desktop.** Arch Linux and KDE Plasma under Wayland are the target
  (`008-tauri-v2-on-arch-kde`). Other Linux desktops are best-effort.

## Where the detail lives

`docs/acceptance-criteria.md` holds every specified behaviour as a Given / When
/ Then criterion with a stable id and a priority. The `decisions/` layer holds
the reasoning behind each settled shape. This document holds neither — it states
what the product is for.

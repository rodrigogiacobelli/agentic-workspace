---
id: standards-code
title: Code standard
summary: The conventions binding this application's Rust backend and web
  frontend — where state lives, how errors reach the user, how status is
  published, how files are written, and what the backend owns that a view
  cannot.
related:
  - 008-tauri-v2-on-arch-kde
  - standards-motion
  - 003-source-markdown-is-canonical
  - standards-testing
  - standards-linux-desktop
---

# Code standard

## The backend owns everything that outlives a view

Processes, filesystem watches, git state, session state and settings live in
the Rust backend. The webview is replaceable: it may be reloaded, resized,
unmounted on a workspace switch, or crash. Anything it owns is lost when that
happens.

The frontend owns presentation and nothing else.

## One state object, held by the framework

Shared state lives in one object held by Tauri's manager, reached from a
command rather than passed around. Each field carries its own lock, and a lock
is held for the shortest scope that is correct — clone what is needed and drop
the guard before doing work that blocks.

## Status is published, never polled

A status change has exactly one function that broadcasts it, and that function
updates every surface showing it. No other code writes those surfaces, so they
cannot disagree with each other.

A frontend asking "what is the status now" on a timer is a defect. State
reaches the frontend as an event.

## Errors carry their whole chain

Every command returns `Result<T, String>`, formatted from the underlying error
with `{:#}` so the full chain reaches the user rather than its outermost
sentence. A background failure has no command to return through and is emitted
as an event, surfacing the same way.

No command path uses `unwrap` or `expect` on a fallible operation. A panic in a
command takes down more than the operation.

## Files are written atomically

A save writes to a temporary file in the same directory and renames it into
place, preserving mode and ownership. An agent may read a file while the editor
is writing it, and a partial read of a half-written file is silent corruption.

Renaming within the same directory is what makes the replacement atomic; a
temporary file elsewhere crosses a filesystem boundary and loses that property.

## The IPC contract is written down once

The set of commands and events between the backend and the frontend is declared
in one place on each side, and the frontend's type declarations mirror the
backend's. A command invoked from anywhere other than that layer is a defect.

## Untrusted input is validated at the boundary

Imported themes and grammars (`005-data-only-extension-imports`), files on
disk, and terminal output are untrusted. Each is validated where it enters, and
a malformed one fails that operation without affecting application state.

## Comments explain why

Code says what it does. A comment carries the reason a reader cannot recover
from the code — a platform quirk, a rejected alternative, an ordering that
matters. A comment restating the line below it is removed.

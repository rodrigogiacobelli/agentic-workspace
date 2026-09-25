---
id: 009-xterm-and-portable-pty
title: "ADR-009: xterm.js draws terminals; portable-pty owns them"
summary: Why the terminal is xterm.js in the webview over a portable-pty
  session in the Rust backend, why a detached terminal keeps its view instance
  alive rather than being re-created from a replay, and what the backend's
  bounded output buffer is for.
related:
  - 002-backend-owned-terminal-sessions
  - 016-terminal-output-and-renderer
  - 008-tauri-v2-on-arch-kde
  - 010-react-frontend
  - standards-code
---

# ADR-009: xterm.js draws terminals; portable-pty owns them

## Context

`002-backend-owned-terminal-sessions` settles that the Rust backend owns every
pseudoterminal. It leaves open which component allocates the pseudoterminal,
which component draws it, and how a terminal that is out of sight — its
workspace in the background, or its window hidden — reaches the screen again
with everything it printed.

Key forces:

- **Emulation fidelity is the whole requirement.** `claude`, `tmux`, `vim` and
  `htop` have to behave as they do in Konsole: alternate screen, 24-bit colour,
  mouse reporting, bracketed paste, resize.
- **A terminal emulator is a large body of escape-sequence handling.** Writing
  one is a product in itself; a wrong one corrupts the display silently.
- **The webview is replaceable.** It may be reloaded during development or
  crash, and the process behind the terminal must not notice.
- **Output arrives while no view is looking.** A background workspace's
  terminal prints for an hour, and the user expects to see all of it, scrolled
  to the bottom, when they return.

## Decision

The frontend draws terminals with **xterm.js** (`@xterm/xterm`), one instance
per terminal tab, with the fit and search addons; which renderer draws the
cells is `016-terminal-output-and-renderer`. The backend allocates
and supervises pseudoterminals with **portable-pty**, spawning the user's login
shell with a controlling terminal, and streams raw output bytes to the view
over a Tauri channel.

A terminal's xterm.js instance **stays alive across a workspace switch**. The
view for a background workspace is removed from the document but not disposed,
so its buffer keeps receiving output and its renderer draws nothing until the
element is shown again. Switching back re-attaches the element, refits it to
the window, and resizes the pseudoterminal.

The backend keeps a **bounded ring buffer** of each session's most recent
output. It exists for the one case where no xterm.js instance survives — the
webview reloaded or crashed — and is replayed into a fresh instance on
re-attach. It is not the mechanism a workspace switch relies on.

## Rationale

- xterm.js is the emulator behind VS Code's terminal and is exercised daily by
  every TUI the product has to host. Its fidelity is the requirement met, not
  approximated.
- portable-pty is the pseudoterminal layer of WezTerm, gives a reader, a
  writer, resize and the child's pid, and nothing else. The child's pid is what
  `/proc/<pid>/cwd` needs.
- Keeping view instances alive makes a switch a DOM re-parent rather than a
  parse of a megabyte of replayed bytes, which is what the 150 ms switch budget
  allows. xterm.js pauses its renderer while its element is off screen, so a
  hidden terminal costs parsing and buffering, not drawing.
- A replay from a bounded buffer can start mid-sequence or mid-alternate-screen,
  which is why it is the fallback and not the design: a fresh instance receives
  the tail of the buffer and a resize, and a full-screen program redraws on the
  resulting `SIGWINCH`.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **A Rust-side emulator holding the screen state** (`alacritty_terminal`, `vt100`) | Makes the backend the source of truth for the screen and survives any frontend failure, and requires serialising a full screen model to the view on every attach while still running xterm.js to draw it — two emulators for one terminal. |
| **Re-create the view from a replay on every switch** | One mechanism instead of two, and a switch would parse the whole buffer each time; a replay cut mid-sequence corrupts the display until the next redraw. |
| **A native GTK terminal widget (VTE) beside the webview** | Best fidelity and no JavaScript, and it cannot be embedded in a webview, so the Terminal window would be a different toolkit from the rest of the application. |
| **Delegate to `tmux`** | Real detach and re-attach for free, and a multiplexer becomes a hard dependency with its own key bindings and its own session state outside the application. |

## Consequences

**Easier:**
- A workspace switch does not touch the pseudoterminal or the emulator state.
- Title tracking, selection, search and bracketed paste are xterm.js features
  rather than application code.

**Harder:**
- Every open terminal tab holds an xterm.js instance and its scrollback in the
  Terminal window's memory until the tab closes, whatever workspace is on
  screen.
- The Terminal window is hidden, not closed, so that its instances survive;
  the application decides when hiding becomes quitting.
- The backend's ring buffer is bounded and has to be trimmed at a line
  boundary so a replay starts on a sane byte.

## Constraints imposed

- **Output crosses the boundary as opaque bytes.** No layer interprets terminal
  output on the way past, and the view decodes what the channel carries;
  `016-terminal-output-and-renderer` settles how a message is framed and
  encoded for that crossing.
- **Attaching is atomic.** The backend hands over the buffered tail and
  installs the live channel under one lock, so no byte is delivered twice or
  dropped between the two.
- **A hidden terminal is fitted before it is shown.** Re-attaching resizes the
  pseudoterminal to the visible window, and the program inside receives
  `SIGWINCH`.

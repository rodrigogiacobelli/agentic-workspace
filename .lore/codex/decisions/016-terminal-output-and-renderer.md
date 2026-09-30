---
id: 016-terminal-output-and-renderer
title: 'ADR-016: Terminal output is batched and acknowledged, and the renderer follows the GPU'
summary: Why output leaving a pseudoterminal is accumulated on a window and sent
  base64 under tauri's JSON threshold rather than one raw message per read, why
  the view acknowledges what it has parsed, and why a terminal draws into the
  DOM unless the webview reaches the GPU.
related:
- 009-xterm-and-portable-pty
- 008-tauri-v2-on-arch-kde
- standards-linux-desktop
binds:
- src-tauri/src/pty.rs
- src/terminals.ts
rites:
- diagnose-terminal-input-latency
---

# ADR-016: Terminal output is batched and acknowledged, and the renderer follows the GPU

## Context

`009-xterm-and-portable-pty` settles that the backend owns the pseudoterminal
and xterm.js draws it, and that output crosses between them over a Tauri
channel. It leaves open how much output one message carries, what stops a
program writing faster than the terminal draws, and which of xterm.js's
renderers is used.

Typing in a terminal stalled for about a second a keystroke. Four forces
decided the shape of the answer:

- **A read of a pseudoterminal returns the moment one byte is there.** A
  program that draws a screen out of short escape sequences produces hundreds
  of reads a second. Measured on this product, a thirty-frame-a-second redraw
  carrying 21 KB/s arrived as 981 reads a second averaging 22 bytes.
- **Every channel message costs the GTK main thread.** That thread also
  delivers key presses. A round trip that takes 1 ms on an idle application
  took 2294 ms at the 95th percentile while a flood of small messages ran.
- **Tauri picks the delivery path by payload size.** A raw body of 1024 bytes
  or more is parked for the page to fetch back over a second round trip; a JSON
  body stays on the direct path up to 8192. The view refuses to hand a message
  to the terminal until every earlier one has arrived, so one message on the
  slower path holds up every message behind it.
- **A WebGL canvas needs a GPU path to be worth having.** Without WebKitGTK's
  DMA-BUF renderer the canvas is presented through software
  (`standards-linux-desktop`).

## Decision

Output **accumulates on a 5 ms window** before it leaves the backend. The
window is armed by the first byte to arrive and is never extended, so no byte
waits longer than the window however hard the program writes. That window is
the terminal on screen's — `AppState.foreground`, the active terminal of the
active workspace. Every other terminal accumulates on a **250 ms window** that
ends early once 64 KiB is waiting, and `pty::show` wakes a terminal's flusher
the moment it comes on screen.

Each message travels as **base64 in a JSON body, capped at 6000 bytes** of
terminal output, which encodes to 8002 characters and stays under tauri's
direct-delivery threshold. Every message therefore takes the same path, in
order.

The view **acknowledges what it has parsed**, from xterm.js's own write
callback rather than on arrival, once per 5000 characters. The reader stops
taking bytes from the pseudoterminal past 100 000 outstanding characters and
resumes below 5000, so the kernel's buffer fills and the writing program
blocks.

A terminal **draws into the DOM unless the `terminalGpu` setting asks for
WebGL**. Until 2026-09-30 `auto` took WebGL wherever the webview reached the
GPU; that day the application turned GPU compositing on for NVIDIA under
Wayland and for every other driver, and WebGL's keystroke-to-pixel latency on
that path has not been measured, so `auto` draws into the DOM. A WebGL context
that fails or is lost drops every later terminal to the DOM for the life of
the process.

## Rationale

- The fault is message count, not byte rate. Batching turns the redraw above
  into 29 messages a second carrying the same bytes, and a flood from 34 419
  messages a second into 194, with the 95th percentile round trip at 4 ms.
- Base64 costs a third more characters and buys a single delivery path. Raw
  bytes would put every batched message on the fetch path, which is two round
  trips and reintroduces the head-of-line wait the batching removed.
- Acknowledging from the parse callback makes the signal mean the terminal has
  caught up. Acknowledging on arrival would count bytes the emulator has not
  looked at, and the backlog it is meant to bound would grow behind it.
- The renderer that repaints a canvas for every character is the faster of the
  two only where that canvas reaches the GPU. Where it does not, drawing the
  same cells into the DOM costs less, by enough to decide whether a keystroke
  appears at once or a second later.
- The window, the watermarks and the acknowledgement size are VSCode's, which
  runs the same emulator over the same problem.
- Nobody reads a terminal that is not on screen, so its output has no latency
  to protect: the long window turns an agent's redraws in a background
  workspace from up to two hundred messages a second into four, with the same
  bytes in the same order.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **One message per read, as before** | Nothing to write, and it is the fault: the message rate, not the byte rate, is what the main thread cannot absorb. |
| **Batch, but keep raw bytes** | No encoding cost, and every batched message exceeds the raw threshold and takes the fetch path, where one slow message blocks the ones behind it. |
| **Split output into sub-kilobyte raw messages to stay on the direct path** | Keeps raw bytes, and multiplies the message count, which is the cost being removed. |
| **A WebSocket from the page to a Rust server** | Costs the GTK main thread nothing, since WebKit's network process carries it, and it needs a server, a port, a widened content policy and an authentication scheme of its own for a stream that already has a working transport. |
| **A predicted local echo, drawn before the shell answers** | Hides latency the application cannot remove, and it draws characters the shell has not accepted; VSCode ships its own turned off, and the latency here was never in the round trip. |
| **Always WebGL, the faster renderer on paper** | One renderer to reason about, and on a webview with no GPU path it is the slower one, silently: the addon loads and reports success. |
| **Always DOM** | One renderer again, and it gives up the GPU on the machines that have one. |

## Consequences

**Easier:**
- A terminal printing without pause costs the main thread a bounded number of
  messages a second rather than one per read.
- A program writing faster than the terminal draws is slowed by the kernel
  rather than by a queue inside the application.

**Harder:**
- Output is delayed by up to the window, which a keystroke's echo pays. A
  terminal not on screen delivers output, and so raises its attention badge,
  up to 250 ms late.
- Two threads serve each pseudoterminal — one reading, one flushing — and a
  hangup has to release a reader parked at the high-water mark.
- The encoding is a contract between `pty.rs` and `terminals.ts`, and the size
  cap is derived from a threshold inside tauri.

## Constraints imposed

- **A message never exceeds the direct-delivery threshold.** Raising the cap
  past 6000 bytes of output puts terminal traffic back on the fetch path.
- **The acknowledgement size stays at or below the low-water mark.** A larger
  one leaves the reader parked with an acknowledgement that never arrives.
- **GPU drawing is asked for, not assumed.** A terminal reads the setting
  before choosing, and the answer is settled before the emulator opens, so one
  terminal never draws its first frame with one renderer and the rest with
  another.

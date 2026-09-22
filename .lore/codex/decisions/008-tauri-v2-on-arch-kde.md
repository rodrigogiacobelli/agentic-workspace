---
id: 008-tauri-v2-on-arch-kde
title: "ADR-008: Tauri v2 with a Rust backend, targeting Arch and KDE"
summary: Why the application is built as a Tauri v2 shell over a Rust backend
  for one Linux desktop rather than as an Electron app or a native GTK or Qt
  program, and the WebKitGTK and Wayland costs that choice carries.
related:
  - vision-agentic-workspace
  - 001-two-os-windows
  - standards-linux-desktop
  - standards-code
---

# ADR-008: Tauri v2 with a Rust backend, targeting Arch and KDE

## Context

The application needs a backend that owns PTYs, filesystem watches, git and
persistent state, and a frontend capable of a rich text editor and a terminal
emulator. It targets one machine: Arch Linux and CachyOS, KDE Plasma, Wayland.

Key forces:

- **The backend work is systems work.** Pseudoterminals, process supervision,
  inotify watches, and reaping children on exit.
- **The frontend work is document rendering.** The editor components that do
  rich-text markdown editing and terminal emulation well are web components.
- **A single target removes a large class of work.** Cross-platform windowing,
  packaging and desktop integration is a cost this product does not have to
  pay.
- **The WebKitGTK and Wayland combination has known, silent failure modes**,
  established while building `local-transcribe`.

## Decision

Build as a Tauri v2 application: a Rust backend owning processes, filesystem
and state, and a web frontend owning presentation, rendered in WebKitGTK.
Target Arch Linux and CachyOS on KDE Plasma under Wayland. Other Linux desktops
are best-effort; other operating systems are out of scope.

## Rationale

- Rust suits the backend's actual work, and the language's process and
  concurrency handling is what a terminal multiplexer needs.
- The editor and terminal components that meet the requirement are web
  components, so a webview frontend is where the work is smallest.
- A precedent exists on this exact hardware and desktop: `local-transcribe`
  runs the same stack, and its platform traps are already documented.
- Tauri's process footprint and bundle size are a fraction of Electron's, and
  the application is expected to stay running with many projects open.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Electron** | Ships a known-good Chromium, avoiding the WebKitGTK traps entirely, at the cost of a much larger resident footprint for an always-running application, and a Node backend less suited to process supervision. |
| **Native GTK or Qt** | Best desktop integration and no webview, and the rich-text markdown editing and terminal emulation would have to be built from far lower primitives. |
| **A terminal user interface** | Runs anywhere and needs no compositor, and cannot render images, audio or rich text — all of which the editor requires. |
| **Cross-platform from the start** | Widens the audience, and multiplies the windowing, packaging and desktop-integration work for a product with one known user on one known desktop. |

## Consequences

**Easier:**
- Backend and frontend are separated by a typed command boundary rather than
  by a process boundary.
- Platform behaviour has one target to be correct on.

**Harder:**
- WebKitGTK's failure modes under Wayland are inherited, including the
  NVIDIA DMA-BUF crash that kills the process before a window appears.
- Window placement, global shortcuts and task-bar identity are all compositor
  concerns under Wayland, each with a silent failure mode.
- Packaging for AppImage carries toolchain quirks unrelated to the application.

## Constraints imposed

- **`standards-linux-desktop` is binding.** Every platform rule there fails
  silently when broken, which is why they are written as rules rather than as
  notes.
- **The `rust-version` floor in `Cargo.toml` must be at or above what every
  dependency requires.** A floor set too low makes Cargo resolve an older major
  version of a dependency with no error.
- **The backend owns everything that outlives a view** — processes, watches,
  state — because the webview is replaceable and may be reloaded or crash.

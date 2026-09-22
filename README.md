# Agentic Workspace

A native Linux desktop app for running several agent-driven projects at once —
without losing the one you just switched away from.

> **Status: specification.** The design is settled and written down; no code
> exists yet. [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) is
> the spec, and `.lore/codex/` holds the decisions behind it.

---

## The problem

Start `claude` in project X. Start a dev server beside it. Open the project's
docs, read, edit, prompt the agent again. Now switch to project Y and do the
same.

With an editor and a terminal emulator, that switch costs you the setup. Windows
pile up, terminals get closed, and you rebuild the same arrangement every time
you come back. The agent you left running in X is somewhere behind eleven other
windows, and you have no idea whether it finished.

## The idea

A **workspace** is one directory, and it owns everything about that project: its
file tree, its open documents, its terminals. Switching workspace swaps all of
it at once. The terminals you left behind keep running — same processes, same
output, just out of sight — and they are exactly as you left them when you come
back.

```
  ┌─ Workspace window ──────────┐   ┌─ Terminal window ───────────┐
  │ agentic-workspace      ▾    │   │ agentic-workspace      ▾    │
  ├─────────┬───────────────────┤   ├─────────────────────────────┤
  │ docs/   │ # Rite Design     │   │ [claude] [server] [git] +   │
  │  ac.md  │                   │   │                             │
  │ README  │ A rite is proce…  │   │ > refactor the parser       │
  │ .lore/  │                   │   │ ✓ edited src/parse.rs       │
  └─────────┴───────────────────┘   └─────────────────────────────┘
       ↑ switch either window, both follow
```

## What it does

**Two windows.** A Workspace window (file tree and editor) and a Terminal
window, each a real OS window you can put on its own monitor or virtual desktop.
Both always show the same project; a hotkey raises the other.

**Terminals that survive the switch.** Tabbed, full-fidelity terminals — good
enough for `claude`, `tmux` and `vim`. Switch away and they keep running. Come
back and everything they printed is there. Quit for the day and tomorrow the
tabs return with their working directories, ready for you to relaunch.

**A markdown editor that edits both sides.** Three modes: raw source, a split
with source on one side and the rendered document on the other, and a
full-width rich editor. The rendered side is *editable*, not a preview — which
is the part your editor's markdown preview doesn't do.

**It never reformats what you didn't touch.** Edit one paragraph in the rendered
pane and exactly that paragraph's bytes are rewritten. Your bullet characters,
your emphasis style, your hand-wrapped lines and your frontmatter stay as you
wrote them.

**Paste images and audio straight in.** They land in the project's clipboard
folder, get a relative link, and render inline — images shown, audio playable,
without leaving the document.

**Git, including worktrees.** Status, diffs, hunk staging, commits, history and
blame. Plus branches and worktrees, because a project here is often *itself* a
worktree of another one — and creating one offers to open it as a new workspace.

**It tells you when an agent needs you.** A workspace you left running gets an
attention badge when its terminal produces output, and an optional desktop
notification when a busy terminal goes quiet — the agent finished, or it is
waiting for your answer.

## What it is not

Not an IDE. There are no language servers, no autocomplete, no debugger, no
extension host. The editor highlights markdown, HTML, JSON, TOML and YAML, and
opens everything else as plain editable text. This is a tool for **more text,
less code** — the code is the agent's job.

## Built for

Arch Linux and CachyOS, KDE Plasma, Wayland. Rust and Tauri v2. Other Linux
desktops are best-effort; other operating systems are out of scope.

## Documentation

| Where | What |
|---|---|
| [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) | The full spec — every behaviour as Given/When/Then, grouped and prioritised |
| `.lore/codex/decisions/` | ADRs — why each shape was chosen, and what was rejected |
| `.lore/codex/standards/` | The rules the code has to comply with |
| `.lore/codex/vision/` | What the product is for |

Project knowledge lives in Lore. `lore codex list` is the index.

## Building it

There is nothing to build yet. When there is, it will be `pnpm tauri dev` on the
toolchain named in `standards-linux-desktop`.

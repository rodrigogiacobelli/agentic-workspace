# Agentic Workspace

A native Linux desktop app for running several agent-driven projects at once —
without losing the one you just switched away from.

> **Status: third milestone.** Workspaces, the two windows, terminals that
> survive a switch, the file tree, session restore, the three-mode markdown
> editor, git with worktrees, and the two agent signals run. `.lore/codex/`
> holds the decisions behind it.

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
  │ .lore/  │ # Rite Design     │   │ [claude] [server] [git] +   │
  │ src/    │                   │   │                             │
  │ notes/  │ A rite is proce…  │   │ > refactor the parser       │
  │ README  │                   │   │ ✓ edited src/parse.rs       │
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
| `.lore/codex/vision/` | What the product is for |
| `.lore/codex/decisions/` | ADRs — why each shape was chosen, and what was rejected |
| `.lore/codex/standards/` | The rules the code has to comply with |

The in-flight specification — every behaviour as Given/When/Then — lives at
`working/acceptance-criteria.md`, which is not version controlled. Its facts
move into the codex as they are built.

Project knowledge lives in Lore. `lore codex list` is the index.

## Building it

Arch / CachyOS:

```bash
sudo pacman -S --needed base-devel webkit2gtk-4.1 git ripgrep libnotify
```

Rust via [rustup](https://rustup.rs) (1.88 or newer) and Node with pnpm.

> **Fish users:** `~/.cargo/env` is bash syntax and errors under fish. Use
> `source ~/.cargo/env.fish`, or persist it with `fish_add_path ~/.cargo/bin`.

```bash
pnpm install
pnpm tauri dev          # development: both windows, hot reload
pnpm release            # deb / rpm / AppImage under src-tauri/target/release/bundle/
```

`pnpm release` sets `NO_STRIP=1` and `APPIMAGE_EXTRACT_AND_RUN=1` for the
AppImage target; see `standards-linux-desktop` for why. The app writes its
session and settings to `~/.local/share/dev.agenticworkspace.app/` and its
desktop entry and icon under `~/.local/share/` at every launch.

```bash
cd src-tauri && cargo test --lib     # unit tests; no compositor or PTY needed
```

## Keys

| Key | Where | Does |
|---|---|---|
| `Ctrl+Shift+P` | both | Switch workspace |
| `Ctrl+Shift+Space` | both | Focus the other window |
| `Ctrl+Q` | both | Quit |
| `Ctrl+Alt+A` | anywhere | Raise the window you last used (bound through the desktop portal; reassign it in System Settings → Shortcuts) |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | terminal | New / close terminal tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | both | Next / previous tab |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | terminal | Copy / paste |
| `Ctrl+Shift+F` | terminal / workspace | Search scrollback / search the project |
| `Ctrl+Shift+G` | workspace | The git panel |
| `Ctrl+P` | workspace | Quick open a file |
| `Ctrl+S` / `Ctrl+W` | workspace | Save / close the editor tab |
| `Ctrl+E` | workspace | Cycle the markdown editor: source → split → rich |
| `Ctrl+\` / `Ctrl+Alt+\` | workspace | Split the editor area / move the tab to the other group |
| `Ctrl+,` | both | Settings |
| `Ctrl+Alt+Shift+C` | workspace | Copy the selected path, relative to the workspace |

In the rendered markdown view, syntax shows on the lines the cursor touches and
is hidden elsewhere; `Ctrl`+click follows a link. Paste an image or drop a file
onto a document and it lands in the workspace's clipboard folder with a link
relative to the note.

Themes: four built in, and Settings → Import… reads a VS Code theme from a
`.json` or a `.vsix`, reporting what it could not map. A theme can be set per
workspace so projects are distinguishable at a glance.

Git runs through the `git` binary on your machine, so hooks run and your
configuration applies. Desktop notifications go through `notify-send`; clicking
one switches to the terminal that went quiet.

Double-click a terminal tab to rename it; drag tabs to reorder them. Right-click
in the file tree for file operations; deleting moves to the trash through GIO.

---
id: operations-running-agentic-workspace
title: Running Agentic Workspace
summary: How to run Agentic Workspace from a checkout on Arch, build the deb, rpm
  and AppImage bundles, install the AppImage and replace it with a newer build without
  losing the session, start the app at login under KDE, and read the four failures
  that stop it before a window appears.
related:
- standards-linux-desktop
- 008-tauri-v2-on-arch-kde
- 004-central-settings-store
- 013-app-drawn-chrome-and-tray
binds:
- src-tauri/tauri.conf.json
- package.json
- src-tauri/Cargo.toml
---

# Running Agentic Workspace

Agentic Workspace is a Tauri v2 application: a Rust backend under
`src-tauri/src/` and a React frontend under `src/`, built for Arch Linux on KDE
Plasma under Wayland. `pnpm` drives both halves. `package.json` holds the
scripts, `src-tauri/Cargo.toml` the Rust dependencies and the toolchain floor,
`src-tauri/tauri.conf.json` the two windows, the application identifier and the
bundle targets.

Every command block here is fish, the shell this project assumes. `~/.cargo/env`
is bash syntax and errors under fish — `~/.cargo/env.fish` is the fish file —
and `set -x NAME value` is fish's `export`.

## Run it locally

Install the toolchains and the libraries the build links against:

```fish
sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 libayatana-appindicator rustup nodejs pnpm
```

| Package | What links against it |
|---|---|
| `base-devel` | the C toolchain and linker Cargo invokes |
| `webkit2gtk-4.1` | the webview both windows render in |
| `gtk3` | the toolkit under the webview, and the source of the Wayland `app_id` |
| `libayatana-appindicator` | the StatusNotifierItem the tray icon registers as |
| `rustup` | Rust; `rust-version` in `src-tauri/Cargo.toml` sets the floor at 1.88 |
| `nodejs`, `pnpm` | the frontend build |

The backend also shells out to four binaries at run time: `git` for every git
operation, `rg` from `ripgrep` for project search, `gio` from `glib2` to move a
deleted file to the trash, and `notify-send` from `libnotify` for desktop
notifications. Each one fails at the moment it is used rather than at startup.

Put Cargo on the path, install the frontend dependencies, and start the
development build:

```fish
source ~/.cargo/env.fish
pnpm install
pnpm tauri dev
```

`fish_add_path ~/.cargo/bin` records the path permanently, after which the
`source` line is unnecessary.

`pnpm tauri dev` runs `pnpm dev` first — the `beforeDevCommand` in
`src-tauri/tauri.conf.json` — which serves the frontend on port 1420.
`vite.config.ts` sets `strictPort: true`, so another process already on 1420
makes Vite exit instead of choosing a different port, and `devUrl` in
`src-tauri/tauri.conf.json` names that port for the webviews.

Both windows are declared `"visible": false` in `src-tauri/tauri.conf.json`;
`windows::show_all` shows them once `setup` in `src-tauri/src/lib.rs` finishes,
so a successful start puts the Workspace window and the Terminal window on
screen together.

## Build a release

```fish
pnpm release
```

The script is `NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1 tauri build`. Its
`beforeBuildCommand` runs `pnpm build`, which compiles the frontend into
`dist/`; `bundle.targets` in `src-tauri/tauri.conf.json` then produces three
bundles under `src-tauri/target/release/bundle/`:

```
deb/Agentic Workspace_<version>_amd64.deb
rpm/Agentic Workspace-<version>-1.x86_64.rpm
appimage/Agentic Workspace_<version>_amd64.AppImage
```

`<version>` is the `version` field in `src-tauri/tauri.conf.json`.

The two environment variables are on the script because the AppImage target
fails without them. linuxdeploy bundles a `strip` older than the `.relr.dyn`
section current system libraries carry: every strip call fails with
`unknown type [0x13] section '.relr.dyn'`, linuxdeploy exits non-zero, and the
whole bundle step goes with it. `NO_STRIP=1` skips those calls, and
`APPIMAGE_EXTRACT_AND_RUN=1` covers hosts carrying only FUSE 3.
`standards-linux-desktop` is the rule; the deb and rpm targets are unaffected by
either variable.

The deb and rpm declare the two shared libraries their package managers resolve
— `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` for deb,
`webkit2gtk4.1` and `libayatana-appindicator-gtk3` for rpm, both in
`src-tauri/tauri.conf.json`. The AppImage resolves nothing from the host: it
carries WebKitGTK, GTK and their dependencies inside the bundle.

## Where the app keeps its state

Tauri resolves the application data directory from the `identifier` in
`src-tauri/tauri.conf.json`, which makes it
`~/.local/share/dev.agenticworkspace.app/` on Linux. `setup` creates it at
launch.

| Entry | Written by | Holds |
|---|---|---|
| `session.json` | `store::save` | the workspaces, open editors, terminal tabs and their working directories, under a `version` field |
| `settings.json` | `settings::save` | global settings and per-workspace settings keyed by absolute path, as ADR-004 requires |
| `windows.json` | `windows::save` | each window's size, position, maximised state and monitor name |
| `drafts/` | `files::save_draft` | unsaved editor buffers, one file per document |
| `themes/` | `themes::import_themes` | imported VS Code colour themes |

Each of those writers puts a temporary file beside the target and renames it, so
an interrupted write leaves the previous contents intact. `session::quit` saves
the session and the window geometry on the way out, and a thread started in
`setup` saves both every 30 seconds in case the process is killed.

The app maintains three more files outside that directory, checking them at
every launch:
`~/.local/share/applications/dev.agenticworkspace.app.desktop`, and the icons at
`~/.local/share/icons/hicolor/scalable/apps/dev.agenticworkspace.app.svg` and
`~/.local/share/icons/hicolor/256x256/apps/dev.agenticworkspace.app.png`.
`desktop::ensure_entry` rewrites the entry whenever its `Exec` no longer names
the running binary, and `desktop::ensure_icons` rewrites the icons
unconditionally. `standards-linux-desktop` holds the reason both are repaired at
startup rather than installed by hand.

## Install and update

On Arch the AppImage is the install. The deb and rpm exist for other
distributions and are not used here.

Copy the bundle to a fixed path and make it executable:

```fish
mkdir -p ~/.local/bin
cp src-tauri/target/release/bundle/appimage/*.AppImage ~/.local/bin/agentic-workspace.AppImage
chmod +x ~/.local/bin/agentic-workspace.AppImage
```

The path is fixed because the desktop entry names it. An AppImage runs from a
mount under `/tmp` that is torn down on exit, so `desktop::launch_path` writes
the value of `$APPIMAGE` into `Exec` rather than the mount point. A bundle moved
to a different path leaves a stale `Exec` behind until it is launched once from
its new location, where `desktop::ensure_entry` rewrites the entry.

**Replacing the install with a newer build.** Quit the app first, then overwrite
the file in place:

```fish
cp src-tauri/target/release/bundle/appimage/*.AppImage ~/.local/bin/agentic-workspace.AppImage
```

Quitting means the tray menu's **Quit** entry or `Ctrl+Q` in either window.
Closing a window calls `windows::hide`, which leaves the process running with
every terminal alive; `cp` over a running install truncates the file the mounted
AppImage is reading from.

Everything under `~/.local/share/dev.agenticworkspace.app/` survives the
replacement untouched: the new build reads the same session, settings, window
geometry, drafts and imported themes.

**A store the build cannot read.** `store::load` compares the `version` field in
`session.json` against the `SESSION_VERSION` constant in
`src-tauri/src/state.rs` that the running build carries.
A file whose version is higher — and a file that fails to parse — goes to
`store::set_aside`, which renames it to `session.json.unreadable-<seconds>`
where the suffix is the Unix time of the rename. The app then starts with an
empty workspace list and shows a notice naming the file it moved. Nothing is
deleted.

**Rolling back.** Copy the previous AppImage over the same path, with the app
not running. When the build being rolled back from had raised the session
format, the older build refuses the store it finds and moves it aside on its
first launch, and the workspaces are in that moved-aside file rather than in the
empty `session.json` written over it. Restoring it by hand returns the session
to any build that reads its format:

```fish
cd ~/.local/share/dev.agenticworkspace.app
mv session.json.unreadable-1758556800 session.json
```

Restore it while the app is not running; a running process overwrites
`session.json` within 30 seconds.

## Start at login

Under KDE Plasma: **System Settings → Autostart → Add → Application**, then pick
Agentic Workspace. The entry the dialog lists is
`~/.local/share/applications/dev.agenticworkspace.app.desktop`, which
`desktop::ensure_entry` writes — so the app has to have run once before the
entry exists. Copying that file into `~/.config/autostart/` does the same thing
without the dialog:

```fish
mkdir -p ~/.config/autostart
cp ~/.local/share/applications/dev.agenticworkspace.app.desktop ~/.config/autostart/
```

The app never starts hidden. `windows::show_all` shows both windows at every
launch, restoring each one's saved size and maximised state from `windows.json`.
Only closing a window puts it in the tray, and only Quit ends the process:
the tray menu's last entry, or `Ctrl+Q` in either window. Both reach
`session::quit` by way of the Workspace window, which prompts once about unsaved
editor buffers, then saves the session and the window geometry and hangs up
every shell.

The tray icon is a StatusNotifierItem through libayatana-appindicator. On Linux
that host delivers menu events only, so a left click opens the menu rather than
raising a window. The menu's first entry, **Show Agentic Workspace**, raises the
window that held focus last; below it `tray::menu` lists both windows with a
check mark against the ones on screen, then the workspaces, then **Quit**.

A desktop with no StatusNotifierItem host does not strand the process:
`tray::init` fails, `setup` shows a notice saying so, and `on_close_requested`
then runs the quit path when the last visible window is closed.

`Ctrl+Alt+A` raises the last-focused window from anywhere. KDE owns that
assignment and may alter it; `standards-linux-desktop` carries the
`kglobalshortcutsrc` command that reports the key the compositor actually gave.

## When it will not start

**The process exits before either window appears, and the terminal it was
launched from carries a Wayland protocol error.** WebKitGTK's DMA-BUF renderer
trips a Wayland explicit-sync protocol error on the NVIDIA proprietary driver.
`apply_webkit_workaround` in `src-tauri/src/lib.rs` sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` when `WAYLAND_DISPLAY` is present and the
variable is not already in the environment. A variable that is already set is an
opt-out, so a shell profile or a desktop entry exporting
`WEBKIT_DISABLE_DMABUF_RENDERER=0` reinstates the crash. Clear it, or set it to
`1` explicitly:

```fish
set -x WEBKIT_DISABLE_DMABUF_RENDERER 1
```

`standards-linux-desktop` holds the rule.

**A loader error naming `libwebkit2gtk-4.1.so.0`.** The webview library is
missing from the host: `sudo pacman -S --needed webkit2gtk-4.1`. The loader
error reaches a checkout run with `pnpm tauri dev`, and a deb or rpm install on
a host that did not resolve the dependency. The AppImage carries its own copy
and starts on a host without the package.

**The app starts, the workspace list is empty, and a notice names a file it
moved aside.** The session store was unreadable — a newer format, or damaged
JSON — and `store::set_aside` renamed it to
`session.json.unreadable-<seconds>` under
`~/.local/share/dev.agenticworkspace.app/`. The app is usable as it stands:
re-add the workspaces, or quit and restore the moved-aside file under its
original name if the build that wrote it can read it back.

**A window reopens at the wrong size, or off the visible screen.**
`windows.json` under `~/.local/share/dev.agenticworkspace.app/` holds stale
geometry. Delete it with the app closed; `windows::load` then finds nothing to
restore and each window opens at the size declared in
`src-tauri/tauri.conf.json`:

```fish
rm ~/.local/share/dev.agenticworkspace.app/windows.json
```

Position is a separate matter, and deleting the file does not settle it. The app
restores each window's size and maximised state itself and requests its
position, which Wayland leaves to the compositor — `standards-linux-desktop`
records why a client cannot place its own toplevel. Pinning the position is
KWin's job, through **System Settings → Window Management → Window Rules → New**:
match **Window class** `dev.agenticworkspace.app`, add a **Window title** match
to tell the two windows apart (`Agentic Workspace` for the Workspace window,
`Agentic Workspace — Terminal` for the Terminal window), then set
**Size & Position → Position** to *Remember* or *Force*.

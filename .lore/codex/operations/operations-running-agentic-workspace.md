---
id: operations-running-agentic-workspace
title: Running Agentic Workspace
summary: How to run Agentic Workspace from a checkout on Arch, build the deb, rpm
  and AppImage bundles, install the AppImage and replace it with a newer build without
  losing the session, run a development build beside an installed one, start the app
  at login under KDE, and read the four failures that stop it before a window
  appears.
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

## A development build runs beside an installed one

`pnpm tauri dev` and an installed AppImage run at the same time. A development
build's `desktop::APP_ID` is `dev.agenticworkspace.app.dev`, which gives it its
own data directory, its own desktop entry and icons, its own Wayland `app_id`,
its own tray item reading **Agentic Workspace (dev)**, its own portal
registration holding `Ctrl+Alt+D`, and its own single-instance bus name. Neither
build reads the other's session, settings, window geometry, drafts or themes, and
neither answers the other's launch.

A development build therefore opens with an empty workspace list. Copying the
installed build's session across, with both builds closed, starts it on the same
workspaces:

```fish
cp ~/.local/share/dev.agenticworkspace.app/session.json \
   ~/.local/share/dev.agenticworkspace.app.dev/session.json
```

`standards-linux-desktop` holds what the identity reaches, the one surface it
does not, and the `tauri.conf.json` flag that defeats the whole arrangement.

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

`setup` joins `desktop::APP_ID` onto the XDG data directory and creates the
result at launch: `~/.local/share/dev.agenticworkspace.app/` for an installed
build, `~/.local/share/dev.agenticworkspace.app.dev/` for a development one.
Each entry below is one per build.

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
`setup` publishes the session and saves the window geometry every 30 seconds,
which carries every shell's working directory to the windows and keeps both
files close to the truth if the process is killed. `store::save` skips a
session write whose text matches the last one written while `session.json` is
still there.

The app maintains three more files outside that directory, checking them at
every launch:
`~/.local/share/applications/dev.agenticworkspace.app.desktop`, and the icons at
`~/.local/share/icons/hicolor/scalable/apps/dev.agenticworkspace.app.svg` and
`~/.local/share/icons/hicolor/256x256/apps/dev.agenticworkspace.app.png`.
`desktop::ensure_entry` rewrites the entry whenever it differs from the one the
running build wants, and `desktop::ensure_icons` rewrites the icons
unconditionally. Both files are named after `desktop::APP_ID`, so a development
build maintains its own pair rather than these.
`standards-linux-desktop` holds the reason they are repaired at startup rather
than installed by hand.

## Install and update

On Arch the AppImage is the install. The deb and rpm exist for other
distributions and are not used here.

Give the bundle a permanent home under a version-free name, make it executable,
and launch it:

```fish
mkdir -p ~/Applications
mv "src-tauri/target/release/bundle/appimage/Agentic Workspace_<version>_amd64.AppImage" \
   ~/Applications/AgenticWorkspace.AppImage
chmod +x ~/Applications/AgenticWorkspace.AppImage
~/Applications/AgenticWorkspace.AppImage
```

The desktop entry names the file the application ran from.
`desktop::launch_path` returns the path in `$APPIMAGE` when that variable holds
an absolute path that still stats as a file, and the running executable
otherwise — an AppImage's executable sits inside a temporary directory the
runtime removes on exit, so the variable is what makes `Exec` name something
that outlasts the process.

`~/Applications` sits outside the build tree, because an AppImage run out of
`src-tauri/target/` points the entry at a path `cargo clean` empties.
`AgenticWorkspace.AppImage` carries no version, because the next version bump
renames the bundle and leaves the entry naming a file that is gone. GLib
discards an entry whose `Exec` resolves to nothing, so the launcher has nothing
to start; `standards-linux-desktop` holds the rule.

**Verifying the install.** The installed build writes the desktop entry and the
icons itself, naming the AppImage it ran from. It does that in `setup`, which
runs only in a process that starts: `tauri_plugin_single_instance` claims
`dev.agenticworkspace.app.SingleInstance` while Tauri builds the application, so
a second launch under that same identity raises the window the running instance
last used and exits with the entry untouched. Quit the installed build before
installing over it.

```fish
grep Exec ~/.local/share/applications/dev.agenticworkspace.app.desktop
```

`Exec` names the absolute path of the installed AppImage, in the double quotes
`desktop::quote_exec` writes.

KService rebuilds the launcher's cache itself — kded6 watches the directories it
caches for as long as the session runs — so what a launcher offers follows the
entry on disk. `Could not find the program` is KIO's message when the `Exec` it
ran names nothing, so read the entry before rebuilding anything: a bundle moved
but not yet launched still names its old path in the file, where no rebuild
reaches it. Rebuilding by hand settles a launcher still offering a path the
entry no longer names:

```fish
kbuildsycoca6
```

A `pnpm tauri dev` run leaves that entry alone: its `APP_ID` is
`dev.agenticworkspace.app.dev`, so `desktop::ensure_entry` writes
`dev.agenticworkspace.app.dev.desktop` beside it. That entry carries
`NoDisplay=true` and no launcher offers it, because a development binary loads
`devUrl` and answers a launch with a connection error rather than a window.

**Replacing the install with a newer build.** Quit the app first, then move the
new bundle onto the installed path:

```fish
mv "src-tauri/target/release/bundle/appimage/Agentic Workspace_<version>_amd64.AppImage" \
   ~/Applications/AgenticWorkspace.AppImage
```

Quitting means the tray menu's **Quit** entry or `Ctrl+Q` in either window.
Closing a window calls `windows::hide` while the tray is up, which leaves the
process running with every terminal alive and answering the next launch by
raising itself, so the new build never starts. `tauri build` empties
`src-tauri/target/release/bundle/appimage/` before it bundles, so a release
worth rolling back to survives only as a copy made before the next build.

An installed build never looks for a newer one. `tauri-plugin-updater` is not a
dependency in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` sets no
`createUpdaterArtifacts`, so moving a new bundle onto
`~/Applications/AgenticWorkspace.AppImage` is the only update there is.

Everything under `~/.local/share/dev.agenticworkspace.app/` survives the
replacement untouched: the new build reads the same session, settings, window
geometry, drafts and imported themes.

**A store the build cannot read.** `store::load` compares the `version` field in
`session.json` against the `SESSION_VERSION` constant in
`src-tauri/src/state.rs` that the running build carries, and hands a file whose
version is higher — or one that fails to parse — to `store::set_aside`. That
renames it to `session.json.unreadable-<seconds>` rather than deleting it, the
suffix being the Unix time of the rename. The app then starts with an empty
workspace list and shows a notice naming the file it moved.

**Rolling back.** Copy `session.json` aside first:

```fish
cp ~/.local/share/dev.agenticworkspace.app/session.json ~/session-before-rollback.json
```

Then put a previous AppImage at `~/Applications/AgenticWorkspace.AppImage` with
the app not running, and launch it. No save raises the `version` field, so a
store written before a format bump keeps its old number: an older build accepts
it — anything at or below its own `SESSION_VERSION` — and drops whatever the
newer format added on its next save, with no notice and nothing set aside. Only
a store the newer build wrote from scratch carries the higher number, and that
one the older build refuses — the workspaces are then in the file
`store::set_aside` renamed, not in the empty `session.json` the older build
writes in its place, and restoring it by hand returns the session to any build
that reads its format:

```fish
cd ~/.local/share/dev.agenticworkspace.app
mv session.json.unreadable-1758556800 session.json
```

Restore either copy while the app is not running; the running app overwrites
`session.json` the next time its session changes. The launch settles the
desktop entry too: `desktop::ensure_entry` compares the whole entry against the
one the running build wants and writes when the two differ.

## Start at login

Under KDE Plasma: **System Settings → Autostart → Add → Application**, then pick
Agentic Workspace. The entry the dialog lists is
`~/.local/share/applications/dev.agenticworkspace.app.desktop`, which
`desktop::ensure_entry` writes when an installed build runs — so that build has
to have run once before the entry exists. A `pnpm tauri dev` run writes
`dev.agenticworkspace.app.dev.desktop` instead, which `NoDisplay=true` keeps out
of the dialog. Copying that file into `~/.config/autostart/` does the same thing
without the dialog:

```fish
mkdir -p ~/.config/autostart
cp ~/.local/share/applications/dev.agenticworkspace.app.desktop ~/.config/autostart/
```

Copy it after the app has run from its installed location.
`desktop::ensure_entry` rewrites the entry under
`~/.local/share/applications/` and nothing else, so the copy under
`~/.config/autostart/` keeps the `Exec` it was made with.

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
check mark against the ones on screen, then the workspaces, then **Quit**. That
entry and the icon's tooltip both name `desktop::APP_NAME`, so a development
build's tray item reads **Show Agentic Workspace (dev)** and the two are
distinguishable.

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

---
id: standards-linux-desktop
title: Linux desktop standard
summary: The Arch, KDE and Wayland rules this application complies with — the
  four-way application identity chain, the WebKitGTK NVIDIA workaround, the CSS
  a declaration is silently dropped for, window placement limits, the focus that
  gates a clipboard read, global shortcut binding through the portal, overlay
  scrollbars over app-drawn menus, the main loop a synchronous command blocks,
  the scheduling class an auto-nice daemon hands down, the identity a development
  build carries so it runs beside an installed one, the AppImage strip flag and
  the Cargo version floor. Each fails silently when broken.
related:
  - 008-tauri-v2-on-arch-kde
  - standards-motion
  - 001-two-os-windows
  - standards-code
  - operations-running-agentic-workspace
---

# Linux desktop standard

Every rule here shares one property: breaking it produces **no error**. The
application starts, reports success, and something is quietly wrong — a window
that never appears, a hotkey that never fires, a generic icon, a bundle step
that fails for a reason unrelated to the code.

The rules are established practice on this stack, carried from `local-transcribe`.

## Application identity agrees in four places

A task bar resolves a window to a desktop entry, and takes the icon from that
entry. Four names have to match, and the chain breaks silently at whichever one
does not:

| Name | Set by |
|---|---|
| The Wayland `app_id` | `g_get_prgname()` |
| The desktop entry filename | The application, at startup |
| The entry's `Icon=` key | The application, at startup |
| The installed icon filename | The application, at startup |

GTK3 takes `app_id` from `g_get_prgname()`, which defaults to the executable
name rather than the application identifier. `set_application_id` in
`src-tauri/src/lib.rs` sets the program name to `desktop::APP_ID` before GTK
reads it, and that is what keeps the chain intact: one constant fills all four
rows, which is why they agree.

A desktop entry that exists is not necessarily one that loads. GLib splits
`Exec` with `g_shell_parse_argv` and requires `argv[0]` to resolve through
`g_find_program_in_path`; when it does not, GLib discards the entry whole, which
is indistinguishable from having no entry. An `Exec` path is quoted and
escaped, and an AppImage names `$APPIMAGE` rather than the torn-down mount
point under `/tmp`.

Whether an entry loads is settled by GLib, not by reading the file:

```bash
python3 -c "import gi; gi.require_version('Gio','2.0'); from gi.repository import Gio; \
print(Gio.DesktopAppInfo.new('<app-id>.desktop'))"
```

`None` means the entry is inert.

## Desktop integration is repaired at startup

`desktop::ensure_icons` writes the icon theme files at every launch, and
`desktop::ensure_entry` writes the desktop entry whenever it differs from the one
the running build wants, rather than either being documented as a manual setup
step. Each fails silently when absent, so assuming their presence produces a
failure with no message attached.

Neither repair is conditional on the build. A development build writes its own
entry and its own icons, named after its own `APP_ID`, and so does not reach an
installed build's files at all.

## A development build carries its own identity

`desktop::APP_ID` and `desktop::APP_NAME` are split by `debug_assertions`: a
development build is `dev.agenticworkspace.app.dev`, an installed build is
`dev.agenticworkspace.app`. Everything named after the identity splits with it —
the application data directory, the desktop entry and its icons, the Wayland
`app_id`, the app id the portal registers, the tray item and the single-instance
bus name — so both builds run at once, each on its own session, and a
development run leaves an install untouched.

`enableGTKAppId` in `tauri.conf.json` is `false`, and has to be. It does not
reach the `app_id` a toplevel carries, which `g_get_prgname()` decides; what it
does instead is hand GTK the `identifier` to register as a `GApplication`. That
is a second name on the session bus, taken from the config rather than from
`APP_ID`, so both builds claim it: tao makes whichever process starts second a
remote instance and returns from its event loop, after `setup` has already
written the entry and registered a tray. That process exits 0, with no window
and no message.

The split stops at the webview's own storage directory, which Tauri resolves
from `identifier` rather than from `APP_ID`, so both builds share
`~/.local/share/dev.agenticworkspace.app/` for WebKit's caches, its cookie jar
and its HSTS store. No application state lives there and the frontend stores
nothing in the browser, so nothing collides; whatever it stores there later,
both builds share.

A development build's entry names its binary under `src-tauri/target/debug/`, a
path `cargo clean` empties. GLib discards an entry whose `Exec` resolves to
nothing, the portal then refuses the app id, and the development hotkey binds
nothing until the next `pnpm tauri dev` writes the entry again. That entry also
carries `NoDisplay=true`, because a binary whose webview loads `devUrl` answers
a launch from a menu with a connection error rather than a window.

The two builds are one component each to KGlobalAccel, and a key belongs to one
component: `settings.rs` defaults a development build to `CTRL+ALT+d` against an
installed build's `CTRL+ALT+a`, since the second component to ask for a key that
is taken is told it has none.

## WebKitGTK needs the DMA-BUF renderer disabled on Wayland

WebKitGTK's DMA-BUF renderer trips a Wayland explicit-sync protocol error on
the NVIDIA proprietary driver and kills the process before any window appears.
The application sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` under Wayland unless
the variable is already set.

That variable decides how the terminal draws. With the DMA-BUF renderer off
the webview has no GPU path, and a WebGL canvas is presented through software:
xterm's WebGL renderer repaints its canvas for every character, and a keystroke
then waits about a second to appear on screen. Nothing reports it — the addon
loads, reports success, and draws correct output slowly. `desktop::gpu_accelerated`
reads the variable back, and a terminal takes the DOM renderer whenever it is
set. Read that before turning GPU drawing on anywhere: the measurement that
finds this is keystroke-to-pixel, and every measurement of the round trip
underneath it comes back at 6 ms whether the fault is present or not.
## WebKitGTK drops a CSS declaration it cannot parse

A declaration whose value the engine does not understand is discarded, and
whatever preceded it in the same rule stands instead. Nothing is reported. A
rule written for a feature this engine lacks therefore behaves as though it
had never been written, and what the reader sees is the fallback.

WebKitGTK 2.52 parses `@starting-style`, `transition-behavior: allow-discrete`,
the two-value `overflow: visible clip`, and a transition over
`grid-template-rows`. It does not parse an intrinsic size inside a maths
function: `min-width: min(120px, max-content)` is dropped whole, and a
`min-width: 0` written above it is what applies.

`CSS.supports()` evaluated in the running webview answers for this engine. A
browser support table answers for Safari, which is versioned separately from
WebKitGTK and is not the same build.

## WebKitGTK paints overlay scrollbars above every layer

WebKitGTK draws the overlay scrollbar of a scrolling element after everything
else on the page, whatever the stacking order says: a `position: fixed` menu
with a `z-index`, even on its own compositing layer, still shows the scrollbar
of the panel beneath it running across its rows. `scrollbar-color` recolours
the bar and `::-webkit-scrollbar` rules are ignored; neither moves it down.
The application therefore draws every scrollbar itself. `src/scrollbars.ts`
turns the native bars off across the document with `scrollbar-width: none` and
draws a thumb over the trailing edge of whichever surface is being scrolled or
hovered, one at a time; while a menu or a dialog is open, only a scroller
inside one gets a bar. An app-drawn bar takes no layout space either, so
nothing shifts when it appears.

Layering is one scale of custom properties at the top of the stylesheet, from
`--z-drop` to `--z-tooltip`, and every floating layer sits above the window's
own resize band: the band is invisible but takes clicks, so a menu opened
against the edge of the screen would otherwise have five unclickable pixels.

## An auto-nice daemon demotes the whole application

`ananicy` and the daemons like it match a process by the name the kernel
truncates into `/proc/<pid>/comm` and apply a class from their rule set. The
stock rules put `node` in `BG_CPUIO`: nice 16, the idle I/O class, and the
idle scheduling class, whose weight is 3 against a normal task's 1024.
`pnpm tauri dev` is node. A child inherits all three through fork and exec, so
the application, both of its web processes and every shell started in one of
its terminals run there too.

Nothing reports this, and on an idle machine nothing is felt. As soon as
anything else wants the processor, typing in a terminal stalls — for seconds
when the machine is genuinely busy, because every hop of the echo (the GTK
main loop, the web process, the shell) is in the starved class. `restore_scheduling`
in `lib.rs` leaves the idle class before the web processes are forked, so the
repair is inherited; it acts only when the policy is already `SCHED_IDLE` and
lets every call fail quietly, since a system whose `RLIMIT_NICE` forbids the
change keeps what it was given. A release build launched from its desktop
entry is not a child of node and returns at the first line.

`chrt -p <pid>` and `ionice -p <pid>` are the check. Do this before believing
any latency measurement taken on this machine.

## A synchronous Tauri command blocks the window

`#[tauri::command]` on a plain `fn` runs the body inline in the IPC handler,
which on GTK is the main loop. Every other message waits behind it: a `git`
or ripgrep call there is felt as input delay in the terminal, because the
keystroke's `terminal_write` and the shell's echo both cross that same loop
(the echo reaches the webview through `eval`). Commands that read the
filesystem or start a process carry `#[tauri::command(async)]`, which runs
them on the async runtime instead. Commands whose order matters — a write to
a file, a keystroke to a pseudoterminal, a mutation of the session — stay
synchronous, because two spawned tasks can finish in either order.

## Window position belongs to the compositor

Under Wayland a client cannot position its own windows. `set_position` returns
success and changes nothing. Window size is restored; position is requested and
not assumed, and the application reports no placement it did not achieve.

Where placement genuinely matters, KWin's scripting interface is the mechanism,
and a loaded script stays resident until unloaded — an asynchronous operation.
Reloading the same script path too soon returns `-1`, a failure whose only
symptom is a window that never moves.

## The clipboard reaches a window that has focus

The compositor offers the selection to the surface holding keyboard focus. A
client with no focused surface is offered nothing and reads an empty clipboard,
whatever another application has copied, and reports no error for it. A paste
the user drives is always served, because the keystroke that asked for it is
the focus; a read on a timer, from a hidden window, or from a second process
beside the application is not.

Nor can a client revoke a selection it does not own — `gtk_clipboard_clear`
releases one this process holds and does nothing to one another application
holds. Retiring a cut that came from a file manager means taking the selection,
not clearing it.

Together these put an end-to-end check of the file clipboard beyond a script:
a helper that copies a file has no focused window when it does so, and one that
reads is offered nothing. `src-tauri/src/clipboard.rs` is exercised by copying
in a file manager and pasting in the tree.

## Global shortcuts bind through the XDG portal

Under Wayland no application grabs keys directly; the compositor decides. The
`org.freedesktop.portal.GlobalShortcuts` portal is the binding mechanism, and
it is the only one reporting both key press and release.

The portal identifies an application by its desktop entry and refuses an app id
it cannot resolve, then binds no keys. The compositor owns the assignment and
may honour a request, alter it, or assign nothing. The application reports the
binding's real state, including "no key assigned", and offers a route into the
desktop's own shortcut editor.

On KDE the assignment is readable directly:

```bash
grep -A4 '\[<app-id>\]' ~/.config/kglobalshortcutsrc
```

## The AppImage target needs `NO_STRIP=1`

linuxdeploy bundles its own `strip`, older than the `.relr.dyn` section current
system libraries carry. Every strip call fails with `unknown type [0x13] section
'.relr.dyn'` and linuxdeploy exits non-zero, taking the whole bundle step with
it. `NO_STRIP=1` avoids it, and `APPIMAGE_EXTRACT_AND_RUN=1` covers hosts
carrying only FUSE 3. The `deb` and `rpm` targets are unaffected.

## The Cargo version floor is at or above every dependency's

Cargo silently selects older releases of a dependency when `rust-version` in
`Cargo.toml` is below what that dependency requires. A floor set too low
resolves an older major version — Tauri 1.x in place of 2.x — with no error.
`cargo tree -p <crate>` reports the version actually selected.

## Fish is the shell

`~/.cargo/env` is bash syntax and errors under fish. `~/.cargo/env.fish` is the
fish equivalent, and `fish_add_path ~/.cargo/bin` persists it. Documented
commands work under fish, or say which shell they need.

---
id: standards-linux-desktop
title: Linux desktop standard
summary: The Arch, KDE and Wayland rules this application complies with — the
  four-way application identity chain, the WebKitGTK NVIDIA workaround, window
  placement limits, global shortcut binding through the portal, the AppImage
  strip flag and the Cargo version floor. Each fails silently when broken.
related:
  - 008-tauri-v2-on-arch-kde
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
name rather than the application identifier. Setting the program name to the
identifier before GTK reads it is what keeps the chain intact.

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

The desktop entry and the icon theme files are written at every launch when
missing or stale, rather than documented as a manual setup step. Each fails
silently when absent, so assuming their presence produces a failure with no
message attached.

## WebKitGTK needs the DMA-BUF renderer disabled on Wayland

WebKitGTK's DMA-BUF renderer trips a Wayland explicit-sync protocol error on
the NVIDIA proprietary driver and kills the process before any window appears.
The application sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` under Wayland unless
the variable is already set.

## Window position belongs to the compositor

Under Wayland a client cannot position its own windows. `set_position` returns
success and changes nothing. Window size is restored; position is requested and
not assumed, and the application reports no placement it did not achieve.

Where placement genuinely matters, KWin's scripting interface is the mechanism,
and a loaded script stays resident until unloaded — an asynchronous operation.
Reloading the same script path too soon returns `-1`, a failure whose only
symptom is a window that never moves.

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

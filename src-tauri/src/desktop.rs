//! Desktop integration: the desktop entry and icons the task bar resolves a
//! window to. Both are repaired at every launch because both fail silently
//! when absent — see `standards-linux-desktop`.

use anyhow::{Context, Result};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The one name every desktop surface keys off: the desktop entry's filename,
/// its `Icon=` and `StartupWMClass`, the installed icon files, the Wayland
/// `app_id`, the portal's app id, the tray tooltip, the name a notification
/// carries, the single-instance bus name and the application data directory.
///
/// A development build carries its own, so it runs beside an installed build
/// instead of contending with it for every one of those. The release value must
/// match `identifier` in `tauri.conf.json`, which is what Tauri resolves the
/// webview's own storage directory from — the one surface this split does not
/// reach.
#[cfg(not(debug_assertions))]
pub const APP_ID: &str = "dev.agenticworkspace.app";
#[cfg(not(debug_assertions))]
pub const APP_NAME: &str = "Agentic Workspace";
#[cfg(debug_assertions)]
pub const APP_ID: &str = "dev.agenticworkspace.app.dev";
#[cfg(debug_assertions)]
pub const APP_NAME: &str = "Agentic Workspace (dev)";

/// A development build's entry exists for the portal, which refuses an app id it
/// cannot resolve to one, and stays out of the launcher: its `Exec` wants Vite on
/// port 1420, so starting it from a menu answers with a connection error rather
/// than a window.
#[cfg(debug_assertions)]
const NO_DISPLAY: &str = "NoDisplay=true\n";
#[cfg(not(debug_assertions))]
const NO_DISPLAY: &str = "";

const ICON_SVG: &str = include_str!("../../assets/icon.svg");
const ICON_PNG_256: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// Writes `<data_dir>/applications/<APP_ID>.desktop` when it is missing or when
/// it differs from the entry this build wants. Returns the path when written.
/// A development build writes its own file, named after its own `APP_ID`, so it
/// never takes over the entry an installed build put there.
pub fn ensure_entry(data_dir: &Path) -> Result<Option<PathBuf>> {
    let dir = data_dir.join("applications");
    let path = dir.join(format!("{APP_ID}.desktop"));

    let exec = launch_path()?.display().to_string();
    let wanted = entry_contents(&exec);

    if std::fs::read_to_string(&path).is_ok_and(|existing| existing == wanted) {
        return Ok(None);
    }

    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    std::fs::write(&path, &wanted).with_context(|| format!("writing {}", path.display()))?;
    Ok(Some(path))
}

/// The path the desktop entry launches. An AppImage runs from a mount under
/// `/tmp` that is torn down on exit, so the entry names `$APPIMAGE` instead;
/// a dangling `Exec` makes GLib discard the whole entry.
fn launch_path() -> Result<PathBuf> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        let path = PathBuf::from(appimage);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
    }
    std::env::current_exe().context("resolving the running executable")
}

/// Quotes a path for `Exec=`. GLib splits the value like a shell and requires
/// `argv[0]` to resolve to a program; an unquoted path with a space — every
/// AppImage mount, since the mount is named after the product — splits into
/// two words and the entry is rejected whole.
fn quote_exec(path: &str) -> String {
    let escaped: String = path
        .chars()
        .flat_map(|c| {
            let prefix = matches!(c, '"' | '`' | '$' | '\\').then_some('\\');
            prefix.into_iter().chain(std::iter::once(c))
        })
        .collect();
    format!("\"{escaped}\"")
}

/// Installs the icon under the user's hicolor theme so `Icon=<APP_ID>` resolves.
pub fn ensure_icons(data_dir: &Path) -> Result<()> {
    let base = data_dir.join("icons/hicolor");

    let scalable = base.join("scalable/apps");
    std::fs::create_dir_all(&scalable)
        .with_context(|| format!("creating {}", scalable.display()))?;
    std::fs::write(scalable.join(format!("{APP_ID}.svg")), ICON_SVG)
        .context("writing the scalable icon")?;

    // Some panels only look for raster sizes.
    let raster = base.join("256x256/apps");
    std::fs::create_dir_all(&raster).with_context(|| format!("creating {}", raster.display()))?;
    std::fs::write(raster.join(format!("{APP_ID}.png")), ICON_PNG_256)
        .context("writing the 256px icon")?;
    Ok(())
}

fn entry_contents(exec: &str) -> String {
    let exec = quote_exec(exec);
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={APP_NAME}\n\
         Comment=Several agent-driven projects open at once\n\
         Exec={exec}\n\
         Icon={APP_ID}\n\
         Terminal=false\n\
         Categories=Development;Utility;\n\
         StartupWMClass={APP_ID}\n\
         {NO_DISPLAY}"
    )
}

/// Whether the webview composites through the GPU.
///
/// `apply_webkit_workaround` turns WebKit's DMA-BUF renderer off on Wayland,
/// because leaving it on is a protocol error on the NVIDIA driver
/// (`standards-linux-desktop`). With it off, a WebGL canvas is presented
/// through software, and xterm's WebGL renderer — which repaints the canvas
/// for every character — becomes far slower than drawing the same cells into
/// the DOM. Slow enough to stall typing for about a second. The terminal asks
/// this before choosing a renderer.
#[tauri::command]
pub fn gpu_accelerated() -> bool {
    std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
}

/// Set when the application exported `WEBKIT_DISABLE_DMABUF_RENDERER` itself,
/// so its children do not inherit a variable the user never set.
pub static WEBKIT_VAR_SET: AtomicBool = AtomicBool::new(false);

/// What an AppImage's AppRun and its GTK hook export, overwriting any value
/// the user had, so the bundle finds its own Python, GIO modules and GTK
/// data, and runs under X11 (`standards-linux-desktop`).
const APPIMAGE_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "PYTHONHOME",
    "PYTHONDONTWRITEBYTECODE",
    "GDK_BACKEND",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_EXTRA_MODULES",
    "GSETTINGS_SCHEMA_DIR",
    "GTK_DATA_PREFIX",
    "GTK_THEME",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
];

/// Search paths AppRun puts the bundle's directories in front of, keeping the
/// user's own entries after them.
const APPIMAGE_PATHS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
];

/// A command whose environment `clean_child_env` edits: a process the
/// application runs, or a shell it starts on a pseudoterminal.
pub trait ChildEnv {
    fn set_var(&mut self, key: &str, value: &OsStr);
    fn remove_var(&mut self, key: &str);
}

impl ChildEnv for std::process::Command {
    fn set_var(&mut self, key: &str, value: &OsStr) {
        self.env(key, value);
    }
    fn remove_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl ChildEnv for portable_pty::CommandBuilder {
    fn set_var(&mut self, key: &str, value: &OsStr) {
        self.env(key, value);
    }
    fn remove_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

/// Gives a child the user's environment rather than the application's own.
/// A shell, git, ssh and ssh-keygen are the system's programs; under an
/// AppImage's variables they would load the bundle's libraries, modules and
/// Python in place of their own, and a GUI program started from a terminal
/// would run under X11 (CRED-06). The binary needs none of it to start again:
/// its RUNPATH finds every bundled library. `APPDIR` marks an AppImage run;
/// without it only the WebKit variable goes.
pub fn clean_child_env(cmd: &mut impl ChildEnv) {
    if WEBKIT_VAR_SET.load(Ordering::Relaxed) {
        cmd.remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
    }
    let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from).filter(|d| d.is_absolute()) else { return };
    for name in APPIMAGE_VARS {
        cmd.remove_var(name);
    }
    for name in APPIMAGE_PATHS {
        let Some(list) = std::env::var_os(name) else { continue };
        let mut kept = outside(&list, &appdir);
        // linuxdeploy's GTK hook exports XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS":
        // its own "/usr/share" goes too, and a user value that was unset leaves nothing.
        if *name == "XDG_DATA_DIRS" {
            kept = kept.and_then(hook_share_removed);
        }
        match kept {
            Some(kept) if kept == list => {}
            Some(kept) => cmd.set_var(name, &kept),
            None => cmd.remove_var(name),
        }
    }
}

/// `list` without the one leading `/usr/share` entry the AppImage hook
/// prepends; `None` when nothing is left.
fn hook_share_removed(list: OsString) -> Option<OsString> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let bytes = list.as_bytes();
    let rest = bytes.strip_prefix(b"/usr/share:").or_else(|| (bytes == b"/usr/share").then_some(&b""[..])).unwrap_or(bytes);
    (!rest.is_empty()).then(|| OsString::from_vec(rest.to_vec()))
}

/// `list`, a colon-separated search path, without its entries at or under
/// `dir`; `None` when nothing is left.
fn outside(list: &OsStr, dir: &Path) -> Option<OsString> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let kept: Vec<&[u8]> = list
        .as_bytes()
        .split(|&b| b == b':')
        .filter(|entry| !Path::new(OsStr::from_bytes(entry)).starts_with(dir))
        .collect();
    let joined = kept.join(&b':');
    (!joined.is_empty()).then(|| OsString::from_vec(joined))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_search_path_loses_the_bundle_and_keeps_the_rest_in_order() {
        let dir = Path::new("/tmp/.mount_Agentic abc");
        let out = |list: &str| outside(OsStr::new(list), dir).map(|o| o.into_string().unwrap());
        assert_eq!(
            out("/tmp/.mount_Agentic abc/usr/bin:/usr/local/bin:/tmp/.mount_Agentic abc:/usr/bin").as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
        // A sibling whose name merely starts with the bundle's is not in it.
        assert_eq!(out("/tmp/.mount_Agentic abcd/lib:/usr/lib").as_deref(), Some("/tmp/.mount_Agentic abcd/lib:/usr/lib"));
        // An empty entry — the current directory, to the shell — stays where it was.
        assert_eq!(out("/usr/bin::/tmp/.mount_Agentic abc/usr/bin").as_deref(), Some("/usr/bin:"));
        assert_eq!(out("/tmp/.mount_Agentic abc/usr/lib:/tmp/.mount_Agentic abc/usr/lib64"), None);
        assert_eq!(out(""), None);
    }

    #[test]
    fn the_hooks_own_share_entry_goes_with_the_bundle() {
        let dir = Path::new("/tmp/.mount_X");
        let data = |list: &str| outside(OsStr::new(list), dir).and_then(hook_share_removed).map(|o| o.into_string().unwrap());
        // XDG_DATA_DIRS unset before the AppImage started: nothing of it is left.
        assert_eq!(data("/tmp/.mount_X/usr/share/:/tmp/.mount_X/usr/share:/usr/share:"), None);
        // Set: the user's own list comes back unchanged, in its order.
        assert_eq!(
            data("/tmp/.mount_X/usr/share:/usr/share:/opt/x/share:/usr/local/share:/usr/share").as_deref(),
            Some("/opt/x/share:/usr/local/share:/usr/share")
        );
    }

    #[test]
    fn exec_quoting_keeps_one_argument_and_escapes_reserved_characters() {
        for (path, quoted) in [
            ("/a b", "\"/a b\""),
            ("/a\"b", "\"/a\\\"b\""),
            ("/a$b", "\"/a\\$b\""),
            ("/a\\b", "\"/a\\\\b\""),
            ("/a`b", "\"/a\\`b\""),
        ] {
            assert_eq!(quote_exec(path), quoted);
        }
        assert!(entry_contents("/tmp/.mount_Agentic abc/usr/bin/app")
            .contains("Exec=\"/tmp/.mount_Agentic abc/usr/bin/app\"\n"));
    }
}

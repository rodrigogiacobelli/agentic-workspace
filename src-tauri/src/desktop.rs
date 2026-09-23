//! Desktop integration: the desktop entry and icons the task bar resolves a
//! window to. Both are repaired at every launch because both fail silently
//! when absent — see `standards-linux-desktop`.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Must match `identifier` in `tauri.conf.json`: the task bar and the portal
/// look the application up by this exact name.
pub const APP_ID: &str = "dev.agenticworkspace.app";
pub const APP_NAME: &str = "Agentic Workspace";

const ICON_SVG: &str = include_str!("../../assets/icon.svg");
const ICON_PNG_256: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// Writes `<data_dir>/applications/<APP_ID>.desktop` when it is missing or its
/// `Exec` no longer names the running binary. Returns the path when written.
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
         StartupWMClass={APP_ID}\n"
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

#[cfg(test)]
mod tests {
    use super::*;

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

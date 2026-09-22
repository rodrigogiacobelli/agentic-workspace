//! Reading and writing workspace files. Writes are atomic: a temporary file in
//! the same directory, then a rename, so an agent reading the file mid-write
//! sees the old contents or the new, never half of each.

use crate::state::AppState;
use crate::tree;
use anyhow::{Context, Result};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[tauri::command]
pub fn read_file(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<String, String> {
    let (_, abs) = tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let bytes = std::fs::read(&abs)
        .with_context(|| format!("reading {}", abs.display()))
        .map_err(|e| format!("{e:#}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))
}

#[tauri::command]
pub fn write_file(state: tauri::State<AppState>, workspace_id: String, path: String, content: String) -> Result<(), String> {
    let (_, abs) = tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    write_atomic(&abs, content.as_bytes()).map_err(|e| format!("{e:#}"))
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    let dir = path.parent().context("the path has no parent directory")?;
    let name = path.file_name().context("the path has no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.aw-tmp-{}", std::process::id()));
    let existing = std::fs::metadata(path).ok();

    let result = (|| -> Result<()> {
        std::fs::write(&tmp, content).with_context(|| format!("writing {}", tmp.display()))?;
        if let Some(meta) = &existing {
            std::fs::set_permissions(&tmp, meta.permissions()).context("preserving the file mode")?;
            // Only root can hand a file to another user; for everyone else the
            // temporary file already belongs to the same owner.
            let _ = std::os::unix::fs::chown(&tmp, Some(meta.uid()), Some(meta.gid()));
        }
        std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

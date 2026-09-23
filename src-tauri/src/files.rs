//! Reading and writing workspace files. Writes are atomic: a temporary file in
//! the same directory, then a rename, so an agent reading the file mid-write
//! sees the old contents or the new, never half of each.

use crate::state::AppState;
use crate::tree;
use anyhow::{Context, Result};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[tauri::command(async)]
pub fn read_file(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<String, String> {
    let (_, abs) = tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let bytes = std::fs::read(&abs)
        .with_context(|| format!("reading {}", abs.display()))
        .map_err(|e| format!("{e:#}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))
}

/// Opens a file in the desktop's default application, for the files the
/// editor declines: binaries.
#[tauri::command]
pub fn open_externally(app: tauri::AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (_, abs) = tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    app.opener().open_path(abs.to_string_lossy(), None::<&str>).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn write_file(state: tauri::State<AppState>, workspace_id: String, path: String, content: String) -> Result<(), String> {
    let (_, abs) = tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    write_atomic(&abs, content.as_bytes()).map_err(|e| format!("{e:#}"))
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    path.parent().context("the path has no parent directory")?;
    path.file_name().context("the path has no file name")?;
    let tmp = crate::store::tmp_path(path);
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

// --- Drafts: unsaved buffers, kept so a crash loses nothing -------------------

/// FNV-1a over the absolute path: stable across builds, unlike `DefaultHasher`.
fn draft_name(abs: &Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in abs.to_string_lossy().as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.txt")
}

fn draft_path(state: &AppState, workspace_id: &str, path: &str) -> Result<PathBuf, String> {
    let (_, abs) = tree::resolve(state, workspace_id, path).map_err(|e| format!("{e:#}"))?;
    Ok(state.data_dir.join("drafts").join(draft_name(&abs)))
}

#[tauri::command]
pub fn save_draft(state: tauri::State<AppState>, workspace_id: String, path: String, content: String) -> Result<(), String> {
    let target = draft_path(&state, &workspace_id, &path)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(&target, content.as_bytes()).map_err(|e| format!("{e:#}"))
}

#[tauri::command(async)]
pub fn read_draft(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<Option<String>, String> {
    let target = draft_path(&state, &workspace_id, &path)?;
    match std::fs::read_to_string(&target) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Carries a draft to the file's new name. A draft is filed under a hash of
/// the absolute path, so one left behind would surface as the unsaved content
/// of whatever is next created under the old name.
pub fn move_draft(state: &AppState, from_abs: &Path, to_abs: &Path) {
    let drafts = state.data_dir.join("drafts");
    let _ = std::fs::rename(drafts.join(draft_name(from_abs)), drafts.join(draft_name(to_abs)));
}

#[tauri::command]
pub fn delete_draft(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<(), String> {
    let target = draft_path(&state, &workspace_id, &path)?;
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

//! Pasted and dropped assets: written into the workspace's clipboard folder,
//! linked relative to the note that received them.

use crate::state::AppState;
use crate::tree;
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    /// Relative to the workspace root.
    pub path: String,
    /// Relative to the note's directory, for the markdown link.
    pub link: String,
    pub bytes: u64,
}

/// A path from `from_dir` to `to`, both workspace-relative, as markdown wants
/// it: forward slashes, `..` where needed, no leading `./`.
pub fn relative_link(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let to: Vec<&str> = to.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let common = from.iter().zip(to.iter()).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend_from_slice(&to[common..]);
    parts.join("/")
}

fn timestamp() -> String {
    std::process::Command::new("date")
        .arg("+%Y-%m-%d-%H%M%S")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{secs}")
        })
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/webm" => "weba",
        "audio/flac" => "flac",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

/// A free name in `dir`: the wanted name, else `name-2`, `name-3`, and so on.
fn free_name(dir: &Path, wanted: &str) -> String {
    if !dir.join(wanted).exists() {
        return wanted.to_string();
    }
    let (stem, ext) = match wanted.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (wanted.to_string(), String::new()),
    };
    (2..)
        .map(|n| format!("{stem}-{n}{ext}"))
        .find(|name| !dir.join(name).exists())
        .expect("the counter is unbounded")
}

fn sanitize(name: &str) -> String {
    let base = Path::new(name)
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .last()
        .unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if c == '/' || c == '\\' { '-' } else { c }).collect();
    if cleaned.trim().is_empty() { "asset".into() } else { cleaned }
}

fn store(state: &AppState, workspace_id: &str, note: &str, name: &str, write: impl FnOnce(&Path) -> Result<u64>) -> Result<StoredAsset> {
    let (root, _) = tree::resolve(state, workspace_id, note)?;
    let dir_rel = state.settings.lock().clipboard_dir(&root);
    let dir_rel = dir_rel.trim_matches('/').to_string();
    let (_, dir) = tree::resolve(state, workspace_id, &dir_rel)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = free_name(&dir, name);
    let target = dir.join(&name);
    let bytes = write(&target)?;
    let path = if dir_rel.is_empty() { name.clone() } else { format!("{dir_rel}/{name}") };
    let note_dir = note.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    Ok(StoredAsset { link: relative_link(note_dir, &path), path, bytes })
}

fn header(request: &Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(percent_decode)
}

/// Headers are ASCII, so the frontend percent-encodes names and paths.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Stores raw bytes from the clipboard. Headers: `x-workspace`, `x-note`,
/// `x-mime`, and `x-name` when the source had a filename.
#[tauri::command]
pub fn save_asset(state: tauri::State<AppState>, request: Request<'_>) -> Result<StoredAsset, String> {
    let workspace_id = header(&request, "x-workspace").ok_or("missing workspace")?;
    let note = header(&request, "x-note").ok_or("missing note path")?;
    let mime = header(&request, "x-mime").unwrap_or_else(|| "application/octet-stream".into());
    let name = match header(&request, "x-name") {
        Some(n) => sanitize(&n),
        None => format!("{}.{}", timestamp(), extension_for(&mime)),
    };
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    store(&state, &workspace_id, &note, &name, |target| {
        std::fs::write(target, bytes).with_context(|| format!("writing {}", target.display()))?;
        Ok(bytes.len() as u64)
    })
    .map_err(|e| format!("{e:#}"))
}

/// Copies a file already on disk — a drop from the file manager — into the
/// clipboard folder under its own name.
#[tauri::command]
pub fn import_asset(state: tauri::State<AppState>, workspace_id: String, note: String, source: String) -> Result<StoredAsset, String> {
    let src = PathBuf::from(&source);
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("the source has no file name")?;
    store(&state, &workspace_id, &note, &sanitize(&name), |target| {
        std::fs::copy(&src, target).with_context(|| format!("copying {} to {}", src.display(), target.display()))
    })
    .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_relative_to_the_note() {
        for (note_dir, asset, link) in [
            ("", "clipboard/a.png", "clipboard/a.png"),
            ("docs", "clipboard/a.png", "../clipboard/a.png"),
            ("docs/deep", "clipboard/a.png", "../../clipboard/a.png"),
            ("docs/deep", "docs/media/a.png", "../media/a.png"),
            ("docs", "docs/a.png", "a.png"),
            ("clipboard", "clipboard/a.png", "a.png"),
        ] {
            assert_eq!(relative_link(note_dir, asset), link, "note in {note_dir:?}");
        }
    }
}

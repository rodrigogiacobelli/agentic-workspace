//! The file tree and the quick-open file list, both read lazily and both
//! taking their ignore rules from git itself.

use crate::state::AppState;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// Files an unindexed walk stops at, so a huge tree cannot stall quick open.
const WALK_MAX: usize = 50_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Relative to the workspace root, forward slashes, no leading `./`.
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
    /// The path no longer exists; a view or a citation still names it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

/// Resolves a workspace-relative path, refusing anything that leaves the root.
pub fn resolve(state: &AppState, workspace_id: &str, rel: &str) -> Result<(PathBuf, PathBuf)> {
    let root = state
        .session
        .lock()
        .workspace(workspace_id)
        .map(|w| w.path.clone())
        .with_context(|| format!("no workspace {workspace_id}"))?;
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        anyhow::bail!("{rel} is not a path inside the workspace");
    }
    Ok((root.clone(), root.join(rel_path)))
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "." {
        name.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// Which of `paths` git ignores. Git decides, so the tree never disagrees with
/// `git status`; outside a repository nothing is ignored.
fn ignored_by_git(root: &Path, paths: &[String]) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }
    let child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return HashSet::new() };
    if let Some(mut stdin) = child.stdin.take() {
        for p in paths {
            let _ = stdin.write_all(p.as_bytes());
            let _ = stdin.write_all(b"\0");
        }
    }
    let Ok(output) = child.wait_with_output() else { return HashSet::new() };
    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[tauri::command]
pub fn list_dir(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<Vec<Entry>, String> {
    let (root, dir) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let read = std::fs::read_dir(&dir)
        .with_context(|| format!("reading {}", dir.display()))
        .map_err(|e| format!("{e:#}"))?;
    let mut entries: Vec<Entry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // Machine state, not project content. Every other dotfile shows.
            if name == ".git" {
                return None;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                || (e.file_type().map(|t| t.is_symlink()).unwrap_or(false) && e.path().is_dir());
            Some(Entry { path: join_rel(&path, &name), name, is_dir, ignored: false, missing: false })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let ignored = ignored_by_git(&root, &paths);
    for e in entries.iter_mut() {
        e.ignored = ignored.contains(&e.path);
    }
    Ok(entries)
}

/// One entry per workspace-relative path, as a view's root or a citation
/// needs it: its name, whether it is a directory, whether git ignores it,
/// and whether it is there at all.
#[tauri::command]
pub fn stat_entries(state: tauri::State<AppState>, workspace_id: String, paths: Vec<String>) -> Result<Vec<Entry>, String> {
    let (root, _) = resolve(&state, &workspace_id, "").map_err(|e| format!("{e:#}"))?;
    let mut entries: Vec<Entry> = paths
        .iter()
        .map(|p| {
            let rel = p.trim_matches('/').to_string();
            let abs = root.join(&rel);
            let inside = Path::new(&rel).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            Entry { name, is_dir: inside && abs.is_dir(), ignored: false, missing: !inside || !abs.exists(), path: rel }
        })
        .collect();
    let present: Vec<String> = entries.iter().filter(|e| !e.missing).map(|e| e.path.clone()).collect();
    let ignored = ignored_by_git(&root, &present);
    for e in entries.iter_mut() {
        e.ignored = ignored.contains(&e.path);
    }
    Ok(entries)
}

/// Every file quick open can reach: what git tracks plus what it would add,
/// or a bounded walk outside a repository.
#[tauri::command]
pub fn list_files(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<String>, String> {
    let (root, _) = resolve(&state, &workspace_id, "").map_err(|e| format!("{e:#}"))?;
    let listed = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .stderr(Stdio::null())
        .output();
    if let Ok(output) = listed {
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect());
        }
    }
    let mut files = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.filter_map(|e| e.ok()) {
            if files.len() >= WALK_MAX {
                return Ok(files);
            }
            let path = entry.path();
            if entry.file_name() == ".git" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(&root) {
                files.push(rel.to_string_lossy().into_owned());
            }
        }
    }
    Ok(files)
}

fn parent_and_name(rel: &str) -> (String, String) {
    match rel.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (String::new(), rel.to_string()),
    }
}

#[tauri::command]
pub fn create_entry(state: tauri::State<AppState>, workspace_id: String, path: String, is_dir: bool) -> Result<(), String> {
    let (_, abs) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    if abs.exists() {
        return Err(format!("{path} already exists"));
    }
    let result = if is_dir {
        std::fs::create_dir_all(&abs)
    } else {
        abs.parent().map(std::fs::create_dir_all).unwrap_or(Ok(()))
            .and_then(|_| std::fs::write(&abs, b""))
    };
    result.with_context(|| format!("creating {}", abs.display())).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn rename_entry(state: tauri::State<AppState>, workspace_id: String, from: String, to: String) -> Result<(), String> {
    let (_, src) = resolve(&state, &workspace_id, &from).map_err(|e| format!("{e:#}"))?;
    let (_, dst) = resolve(&state, &workspace_id, &to).map_err(|e| format!("{e:#}"))?;
    if dst.exists() {
        return Err(format!("{to} already exists"));
    }
    std::fs::rename(&src, &dst)
        .with_context(|| format!("renaming {} to {}", src.display(), dst.display()))
        .map_err(|e| format!("{e:#}"))
}

/// Copies `path` beside itself as `<stem> copy<ext>`, numbering collisions.
#[tauri::command]
pub fn duplicate_entry(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<String, String> {
    let (root, src) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let (dir, name) = parent_and_name(&path);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let candidate = (1..1000)
        .map(|n| if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") })
        .map(|n| join_rel(&dir, &n))
        .find(|rel| !root.join(rel).exists())
        .ok_or("no free name for the copy")?;
    let dst = root.join(&candidate);
    let result = if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()) };
    result
        .with_context(|| format!("copying {} to {}", src.display(), dst.display()))
        .map_err(|e| format!("{e:#}"))?;
    Ok(candidate)
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// A name in `dir` that nothing has: the wanted one, else `<stem> copy<ext>`,
/// `<stem> copy 2<ext>`, and so on.
fn free_copy_name(root: &Path, dir: &str, name: &str) -> Result<String> {
    if !root.join(join_rel(dir, name)).exists() {
        return Ok(join_rel(dir, name));
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..1000)
        .map(|n| if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") })
        .map(|n| join_rel(dir, &n))
        .find(|rel| !root.join(rel).exists())
        .context("no free name for the copy")
}

/// Pastes a copied or cut entry into a directory. A copy takes a free name;
/// a cut is a move that refuses to overwrite.
#[tauri::command]
pub fn paste_entry(state: tauri::State<AppState>, workspace_id: String, from: String, to_dir: String, cut: bool) -> Result<String, String> {
    let (root, src) = resolve(&state, &workspace_id, &from).map_err(|e| format!("{e:#}"))?;
    resolve(&state, &workspace_id, &to_dir).map_err(|e| format!("{e:#}"))?;
    let (_, name) = parent_and_name(&from);
    let to_dir = to_dir.trim_matches('/').to_string();
    if src.is_dir() && (to_dir == from || to_dir.starts_with(&format!("{from}/"))) {
        return Err(format!("{from} cannot be pasted into itself"));
    }
    if cut {
        let dest = join_rel(&to_dir, &name);
        if dest == from {
            return Ok(dest);
        }
        let dst = root.join(&dest);
        if dst.exists() {
            return Err(format!("{dest} already exists"));
        }
        std::fs::rename(&src, &dst).with_context(|| format!("moving {} to {}", src.display(), dst.display())).map_err(|e| format!("{e:#}"))?;
        return Ok(dest);
    }
    let dest = free_copy_name(&root, &to_dir, &name).map_err(|e| format!("{e:#}"))?;
    let dst = root.join(&dest);
    let result = if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()) };
    result.with_context(|| format!("copying {} to {}", src.display(), dst.display())).map_err(|e| format!("{e:#}"))?;
    Ok(dest)
}

/// Moves the entry to the desktop's trash through GIO, never `rm`.
#[tauri::command]
pub fn trash_entry(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<(), String> {
    let (_, abs) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let output = Command::new("gio")
        .arg("trash")
        .arg(&abs)
        .output()
        .with_context(|| format!("running gio trash on {}", abs.display()))
        .map_err(|e| format!("{e:#}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("gio trash failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[tauri::command]
pub fn reveal_entry(app: tauri::AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (_, abs) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    app.opener().reveal_item_in_dir(&abs).map_err(|e| format!("{e:#}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub text: String,
}

const SEARCH_MAX: usize = 2000;

/// Project-wide text search through ripgrep. Ignored paths are excluded unless
/// asked for; dotfiles are searched, `.git` never is.
#[tauri::command]
pub fn search_project(state: tauri::State<AppState>, workspace_id: String, query: String, include_ignored: bool) -> Result<Vec<SearchHit>, String> {
    let (root, _) = resolve(&state, &workspace_id, "").map_err(|e| format!("{e:#}"))?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd = Command::new("rg");
    cmd.current_dir(&root)
        .args(["--json", "--smart-case", "--fixed-strings", "--hidden", "--glob", "!.git", "--max-count", "200", "--max-filesize", "2M"])
        .arg("--");
    if include_ignored {
        cmd.arg("--no-ignore");
    }
    cmd.arg(&query).arg(".");
    let output = cmd.output().context("running ripgrep (is it installed?)").map_err(|e| format!("{e:#}"))?;
    let mut hits = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if event["type"] != "match" {
            continue;
        }
        let data = &event["data"];
        let Some(path) = data["path"]["text"].as_str() else { continue };
        let text = data["lines"]["text"].as_str().unwrap_or("").trim_end_matches(['\n', '\r']).to_string();
        let column = data["submatches"][0]["start"].as_u64().unwrap_or(0);
        hits.push(SearchHit {
            path: path.trim_start_matches("./").to_string(),
            line: data["line_number"].as_u64().unwrap_or(0),
            column,
            text,
        });
        if hits.len() >= SEARCH_MAX {
            break;
        }
    }
    Ok(hits)
}

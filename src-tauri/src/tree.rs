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
            Some(Entry { path: join_rel(&path, &name), name, is_dir, ignored: false })
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

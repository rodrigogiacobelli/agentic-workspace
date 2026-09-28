//! The file tree and the quick-open file list, both read lazily and both
//! taking their ignore rules from git itself.

use crate::state::AppState;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::AppHandle;

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
    let mut cmd = Command::new("git");
    crate::desktop::clean_child_env(&mut cmd);
    let child = cmd
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn list_files(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<String>, String> {
    let (root, _) = resolve(&state, &workspace_id, "").map_err(|e| format!("{e:#}"))?;
    let mut cmd = Command::new("git");
    crate::desktop::clean_child_env(&mut cmd);
    let listed = cmd
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
pub fn rename_entry(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, from: String, to: String) -> Result<(), String> {
    let (_, src) = resolve(&state, &workspace_id, &from).map_err(|e| format!("{e:#}"))?;
    let (_, dst) = resolve(&state, &workspace_id, &to).map_err(|e| format!("{e:#}"))?;
    if taken(&dst) {
        return Err(format!("{to} already exists"));
    }
    std::fs::rename(&src, &dst)
        .with_context(|| format!("renaming {} to {}", src.display(), dst.display()))
        .map_err(|e| format!("{e:#}"))?;
    crate::session::relocate(&app, &workspace_id, &from, &to);
    Ok(())
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
        copy_entry(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

/// Copies a file, a directory with everything in it, or a symlink as a link.
/// A copy that followed a link would duplicate what it points at, and a
/// cross-filesystem move would then delete the original link.
fn copy_entry(src: &Path, dst: &Path) -> std::io::Result<()> {
    let kind = std::fs::symlink_metadata(src)?.file_type();
    if kind.is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
    } else if kind.is_dir() {
        copy_dir(src, dst)
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

/// Whether anything is at `path`, a dangling symlink included, which
/// `exists` would call free and a rename would silently replace.
fn taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// A name in `dir` that nothing has: the wanted one, else `<stem> copy<ext>`,
/// `<stem> copy 2<ext>`, and so on.
fn free_copy_name(root: &Path, dir: &str, name: &str) -> Result<String> {
    if !taken(&root.join(join_rel(dir, name))) {
        return Ok(join_rel(dir, name));
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..1000)
        .map(|n| if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") })
        .map(|n| join_rel(dir, &n))
        .find(|rel| !taken(&root.join(rel)))
        .context("no free name for the copy")
}

/// Moves `src` to `dst` across filesystems, which `rename` cannot do: a
/// clipboard cut may name a file on another mount.
fn move_across(src: &Path, dst: &Path) -> std::io::Result<()> {
    let is_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    match std::fs::rename(src, dst) {
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            if let Err(e) = copy_entry(src, dst) {
                // Half a directory under a name the user did not ask for is
                // worse than the failure itself.
                let _ = if is_dir(dst) { std::fs::remove_dir_all(dst) } else { std::fs::remove_file(dst) };
                return Err(e);
            }
            if is_dir(src) { std::fs::remove_dir_all(src) } else { std::fs::remove_file(src) }
        }
        other => other,
    }
}

/// What a paste did: where the entry landed, or, when the name was taken and
/// the caller asked first, nothing yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    /// Relative to the workspace root; `None` when nothing moved.
    pub path: Option<String>,
    /// The destination name is taken and `ask` left everything as it was.
    pub exists: bool,
}

/// Pastes a copied or cut entry into a directory, which is also what a drag
/// in the tree and a drop from another application do.
///
/// `from` is absolute, because the clipboard it comes from is the desktop's:
/// the source may be anywhere the user can read, and only the destination is
/// confined to the workspace.
///
/// `conflict` says what a taken name does: `ask` changes nothing and answers
/// `exists`, `replace` sends what is there to the trash first, `keep` takes a
/// free name. Without it a copy takes a free name and a cut refuses.
///
/// Off the main thread: a copy may be large, a cross-mount move slow.
#[tauri::command(async)]
pub fn paste_entry(
    app: AppHandle,
    state: tauri::State<AppState>,
    workspace_id: String,
    from: String,
    to_dir: String,
    cut: bool,
    conflict: Option<String>,
) -> Result<Transfer, String> {
    let (root, dst_dir) = resolve(&state, &workspace_id, &to_dir).map_err(|e| format!("{e:#}"))?;
    let from_path = Path::new(&from);
    if !from_path.is_absolute() {
        return Err(format!("{from} is not an absolute path"));
    }
    // The parent is resolved, not taken as given: the path may pass through
    // a symlinked directory or carry `..`, and both the containment checks
    // below and the is-it-in-this-workspace question have to be asked of the
    // real location. The entry itself is not, so a symlink keeps its own name
    // and is copied as a link.
    let (Some(parent), Some(file_name)) = (from_path.parent(), from_path.file_name()) else {
        return Err(format!("{from} has no name"));
    };
    let name = file_name.to_string_lossy().into_owned();
    let gone = |e: std::io::Error| format!("{from} is no longer there: {e}");
    let src = std::fs::canonicalize(parent).map_err(gone)?.join(file_name);
    let src_is_dir = std::fs::symlink_metadata(&src).map_err(gone)?.is_dir();
    let real_dir = std::fs::canonicalize(&dst_dir).map_err(|e| format!("{} is not there: {e}", dst_dir.display()))?;
    // Copying a directory into itself, or into anything under it, walks into
    // what it is writing and does not stop. The destination may be under an
    // external source just as easily as under one in the workspace, so this is
    // asked of the absolute paths.
    if src_is_dir && real_dir.starts_with(&src) {
        return Err(format!("{} cannot be pasted into itself", src.display()));
    }
    // What the source is called inside this workspace, when it is inside it:
    // the form the tree, the tabs and the views speak.
    let inside = src.strip_prefix(&root).ok().map(|rel| rel.to_string_lossy().into_owned());
    let to_dir = to_dir.trim_matches('/').to_string();
    let wanted = join_rel(&to_dir, &name);
    let target = real_dir.join(file_name);
    let landed = |path: String| Transfer { path: Some(path), exists: false };
    // The entry is already where it is being put: moving it there does
    // nothing, and replacing it would trash the source.
    if target == src && (cut || conflict.as_deref() == Some("replace")) {
        return Ok(landed(wanted));
    }
    let dest = match conflict.as_deref() {
        None if cut => {
            if taken(&target) {
                return Err(format!("{wanted} already exists"));
            }
            wanted
        }
        None | Some("keep") => free_copy_name(&root, &to_dir, &name).map_err(|e| format!("{e:#}"))?,
        Some("ask") if taken(&target) => return Ok(Transfer { path: None, exists: true }),
        Some("ask") => wanted,
        Some("replace") => {
            if taken(&target) {
                if src.starts_with(&target) {
                    return Err(format!("{wanted} holds {from}, so it cannot be replaced by it"));
                }
                trash(&target).map_err(|e| format!("{e:#}"))?;
            }
            wanted
        }
        Some(other) => return Err(format!("no conflict rule {other}")),
    };
    let dst = root.join(&dest);
    if cut {
        move_across(&src, &dst).with_context(|| format!("moving {} to {}", src.display(), dst.display())).map_err(|e| format!("{e:#}"))?;
        // A cut inside the workspace is a move: what was open under the old
        // path follows it.
        if let Some(rel) = inside {
            crate::session::relocate(&app, &workspace_id, &rel, &dest);
        }
    } else {
        copy_entry(&src, &dst).with_context(|| format!("copying {} to {}", src.display(), dst.display())).map_err(|e| format!("{e:#}"))?;
    }
    Ok(landed(dest))
}

/// Moves an entry to the desktop's trash through GIO, never `rm`.
pub fn trash(abs: &Path) -> Result<()> {
    let mut cmd = Command::new("gio");
    crate::desktop::clean_child_env(&mut cmd);
    let output = cmd
        .arg("trash")
        .arg(abs)
        .output()
        .with_context(|| format!("running gio trash on {}", abs.display()))?;
    if !output.status.success() {
        anyhow::bail!("gio trash failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

#[tauri::command]
pub fn trash_entry(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<(), String> {
    let (_, abs) = resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    trash(&abs).map_err(|e| format!("{e:#}"))
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
#[tauri::command(async)]
pub fn search_project(state: tauri::State<AppState>, workspace_id: String, query: String, include_ignored: bool) -> Result<Vec<SearchHit>, String> {
    let (root, _) = resolve(&state, &workspace_id, "").map_err(|e| format!("{e:#}"))?;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd = Command::new("rg");
    crate::desktop::clean_child_env(&mut cmd);
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

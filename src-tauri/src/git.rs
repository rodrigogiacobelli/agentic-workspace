//! Git, through the `git` binary. Hooks run, every config the user set is
//! honoured, and worktrees behave exactly as git makes them behave. See
//! ADR-012.

use crate::state::AppState;
use crate::tree;
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let text = format!("{}{}", stdout, stderr).trim().to_string();
        anyhow::bail!("{}", if text.is_empty() { format!("git {} failed", args.join(" ")) } else { text })
    }
}

fn root_of(state: &AppState, workspace_id: &str) -> Result<PathBuf> {
    tree::resolve(state, workspace_id, "").map(|(root, _)| root)
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// --- Repository information -------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    /// `merge`, `rebase`, `cherry-pick`, `revert` or `bisect` when in progress.
    pub state: Option<String>,
    pub is_worktree: bool,
    pub main_worktree: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub git_dir: Option<String>,
    pub common_dir: Option<String>,
}

pub fn info(root: &Path) -> RepoInfo {
    let Ok(dirs) = git(root, &["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]) else {
        return RepoInfo::default();
    };
    let mut lines = dirs.lines();
    let git_dir = lines.next().map(str::to_string);
    let common_dir = lines.next().map(str::to_string);
    let toplevel = lines.next().map(str::to_string);
    let is_worktree = git_dir != common_dir;
    let main_worktree = if is_worktree {
        common_dir.as_ref().and_then(|c| Path::new(c).parent().map(|p| p.display().to_string()))
    } else {
        None
    };
    let _ = toplevel;

    let mut info = RepoInfo { is_repo: true, is_worktree, main_worktree, git_dir: git_dir.clone(), common_dir, ..Default::default() };
    match git(root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(b) if !b.trim().is_empty() => info.branch = Some(b.trim().to_string()),
        _ => {
            info.detached = true;
            info.branch = git(root, &["rev-parse", "--short", "HEAD"]).ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
        }
    }
    if let Some(dir) = git_dir.as_deref().map(Path::new) {
        info.state = if dir.join("MERGE_HEAD").exists() {
            Some("merge".into())
        } else if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
            Some("rebase".into())
        } else if dir.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick".into())
        } else if dir.join("REVERT_HEAD").exists() {
            Some("revert".into())
        } else if dir.join("BISECT_LOG").exists() {
            Some("bisect".into())
        } else {
            None
        };
    }
    if let Ok(status) = git(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"]) {
        for line in status.split('\0') {
            if let Some(rest) = line.strip_prefix("# branch.upstream ") {
                info.upstream = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
                let mut parts = rest.split_whitespace();
                info.ahead = parts.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
                info.behind = parts.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
            }
        }
    }
    info
}

/// Recomputes the summary the session snapshot carries for a workspace.
pub fn refresh_summary(app: &tauri::AppHandle, workspace_id: &str) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let root = {
        let session = state.session.lock();
        match session.workspace(workspace_id) {
            Some(ws) if ws.path.is_dir() => ws.path.clone(),
            _ => return,
        }
    };
    let i = info(&root);
    let summary = crate::state::GitSummary {
        is_repo: i.is_repo,
        branch: i.branch,
        detached: i.detached,
        state: i.state,
        is_worktree: i.is_worktree,
        git_dir: i.git_dir.map(PathBuf::from),
        common_dir: i.common_dir.map(PathBuf::from),
    };
    state.git.lock().insert(workspace_id.to_string(), summary);
}

#[tauri::command(async)]
pub fn git_info(state: tauri::State<AppState>, workspace_id: String) -> Result<RepoInfo, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    Ok(info(&root))
}

#[tauri::command]
pub fn git_init(state: tauri::State<AppState>, workspace_id: String) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    git(&root, &["init"]).map(|_| ()).map_err(err)
}

// --- Status -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index status letter, `.` for none.
    pub index: String,
    /// Worktree status letter, `.` for none.
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[tauri::command(async)]
pub fn git_status(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<StatusEntry>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["status", "--porcelain=v2", "-z", "--untracked-files=all"]).map_err(err)?;
    let mut entries = Vec::new();
    let mut fields = out.split('\0').peekable();
    while let Some(line) = fields.next() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(9, ' ');
        match parts.next() {
            Some("1") => {
                let xy = parts.next().unwrap_or("..");
                let path = parts.nth(6).unwrap_or("").to_string();
                entries.push(StatusEntry {
                    path,
                    orig_path: None,
                    index: xy.chars().next().unwrap_or('.').to_string(),
                    worktree: xy.chars().nth(1).unwrap_or('.').to_string(),
                    untracked: false,
                    conflicted: false,
                });
            }
            Some("2") => {
                let xy = parts.next().unwrap_or("..");
                let path = parts.nth(7).unwrap_or("").to_string();
                let orig = fields.next().map(str::to_string);
                entries.push(StatusEntry {
                    path,
                    orig_path: orig,
                    index: xy.chars().next().unwrap_or('.').to_string(),
                    worktree: xy.chars().nth(1).unwrap_or('.').to_string(),
                    untracked: false,
                    conflicted: false,
                });
            }
            Some("u") => {
                let xy = parts.next().unwrap_or("..");
                let path = parts.nth(8).unwrap_or("").to_string();
                entries.push(StatusEntry {
                    path,
                    orig_path: None,
                    index: xy.chars().next().unwrap_or('.').to_string(),
                    worktree: xy.chars().nth(1).unwrap_or('.').to_string(),
                    untracked: false,
                    conflicted: true,
                });
            }
            Some("?") => {
                let path = line[2..].to_string();
                entries.push(StatusEntry { path, orig_path: None, index: ".".into(), worktree: "?".into(), untracked: true, conflicted: false });
            }
            _ => {}
        }
    }
    Ok(entries)
}

// --- Diffs ------------------------------------------------------------------

/// The unified diff for one path: against the index for worktree changes,
/// against HEAD for staged ones, and against nothing for an untracked file.
#[tauri::command(async)]
pub fn git_diff(state: tauri::State<AppState>, workspace_id: String, path: String, staged: bool, untracked: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    if untracked {
        let output = Command::new("git")
            .arg("-C").arg(&root)
            .args(["diff", "--no-index", "--", "/dev/null", &path])
            .output()
            .map_err(|e| e.to_string())?;
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let args: Vec<&str> = if staged { vec!["diff", "--cached", "--", &path] } else { vec!["diff", "--", &path] };
    git(&root, &args).map_err(err)
}

/// File contents at a revision (`HEAD`, a hash, or `:` for the index), or
/// empty when the path does not exist there.
#[tauri::command(async)]
pub fn git_show_file(state: tauri::State<AppState>, workspace_id: String, rev: String, path: String) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    // `:` is git's own name for the index, and it is the whole revision: the
    // separator must not be doubled, or the spec names nothing and the caller
    // is handed an empty file (FIX-09).
    let spec = format!("{}:{path}", rev.trim_end_matches(':'));
    Ok(git(&root, &["show", &spec]).unwrap_or_default())
}

#[tauri::command(async)]
pub fn git_commit_file_diff(state: tauri::State<AppState>, workspace_id: String, hash: String, path: String) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    git(&root, &["show", "--format=", "--", &path].iter().map(|s| *s).collect::<Vec<_>>().as_slice()).map_err(err).and_then(|_| {
        git(&root, &["diff-tree", "--no-commit-id", "-p", "--root", &hash, "--", &path]).map_err(err)
    })
}

// --- Staging ----------------------------------------------------------------

#[tauri::command]
pub fn git_stage(state: tauri::State<AppState>, workspace_id: String, paths: Vec<String>) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&root, &args).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn git_unstage(state: tauri::State<AppState>, workspace_id: String, paths: Vec<String>) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let has_head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let mut args = if has_head { vec!["reset", "-q", "HEAD", "--"] } else { vec!["rm", "--cached", "-q", "-r", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git(&root, &args).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn git_stage_all(state: tauri::State<AppState>, workspace_id: String) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    git(&root, &["add", "-A"]).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn git_unstage_all(state: tauri::State<AppState>, workspace_id: String) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let has_head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let args: &[&str] = if has_head { &["reset", "-q"] } else { &["rm", "--cached", "-q", "-r", "."] };
    git(&root, args).map(|_| ()).map_err(err)
}

/// Applies one hunk to the index. `patch` is a complete unified diff holding
/// that hunk alone; `reverse` unstages it.
#[tauri::command]
pub fn git_apply_hunk(state: tauri::State<AppState>, workspace_id: String, patch: String, reverse: bool) -> Result<(), String> {
    use std::io::Write;
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
    if reverse {
        args.push("-R");
    }
    let mut child = Command::new("git")
        .arg("-C").arg(&root)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(patch.as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Restores a tracked file from the index, or trashes an untracked one.
#[tauri::command]
pub fn git_discard(state: tauri::State<AppState>, workspace_id: String, path: String, untracked: bool) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    if untracked {
        let abs = root.join(&path);
        let output = Command::new("gio").arg("trash").arg(&abs).output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        return Ok(());
    }
    git(&root, &["checkout", "--", &path]).map(|_| ()).map_err(err)
}

// --- Commits ----------------------------------------------------------------

#[tauri::command]
pub fn git_commit(state: tauri::State<AppState>, workspace_id: String, message: String, amend: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["commit", "-m", message.as_str()];
    if amend {
        args.push("--amend");
    }
    git(&root, &args).map_err(err)
}

#[tauri::command(async)]
pub fn git_last_message(state: tauri::State<AppState>, workspace_id: String) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    Ok(git(&root, &["log", "-1", "--format=%B"]).unwrap_or_default().trim_end().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub timestamp: i64,
    /// Subject and body together, as the history's hover popup shows it.
    pub message: String,
}

#[tauri::command(async)]
pub fn git_log(state: tauri::State<AppState>, workspace_id: String, skip: u32, limit: u32, path: Option<String>) -> Result<Vec<LogEntry>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let skip = format!("--skip={skip}");
    let limit = format!("--max-count={limit}");
    let mut args = vec!["log", "--format=%H%x1f%s%x1f%an%x1f%ar%x1f%at%x1f%B%x1e", skip.as_str(), limit.as_str()];
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        args.push("--");
        args.push(p);
    }
    let out = match git(&root, &args) {
        Ok(o) => o,
        Err(e) if e.to_string().contains("does not have any commits") => return Ok(Vec::new()),
        Err(e) => return Err(err(e)),
    };
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let f: Vec<&str> = rec.split('\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            Some(LogEntry {
                hash: f[0].into(),
                subject: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                timestamp: f[4].trim().parse().unwrap_or(0),
                message: f[5].trim().into(),
            })
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub files: Vec<CommitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub status: String,
    pub path: String,
}

#[tauri::command(async)]
pub fn git_show(state: tauri::State<AppState>, workspace_id: String, hash: String) -> Result<CommitDetail, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["show", "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%B%x1e", "--name-status", "--root", "--date=iso", &hash]).map_err(err)?;
    let (head, files) = out.split_once('\x1e').unwrap_or((&out, ""));
    let f: Vec<&str> = head.split('\x1f').collect();
    if f.len() < 5 {
        return Err("unexpected git show output".into());
    }
    let files = files
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let status = parts.next()?.chars().next()?.to_string();
            let path = parts.last()?.to_string();
            Some(CommitFile { status, path })
        })
        .collect();
    Ok(CommitDetail { hash: f[0].into(), author: f[1].into(), email: f[2].into(), date: f[3].into(), message: f[4].trim().into(), files })
}

// --- Blame ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
}

#[tauri::command(async)]
pub fn git_blame(state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<Vec<BlameLine>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["blame", "--line-porcelain", "--", &path]).map_err(err)?;
    let mut lines = Vec::new();
    let mut hash = String::new();
    let mut line_no = 0u32;
    let mut author = String::new();
    let mut time = 0i64;
    for l in out.lines() {
        if l.len() >= 40 && l.as_bytes()[..40].iter().all(|b| b.is_ascii_hexdigit()) && l.as_bytes().get(40) == Some(&b' ') {
            let mut parts = l.split(' ');
            hash = parts.next().unwrap_or("").to_string();
            line_no = parts.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(a) = l.strip_prefix("author ") {
            author = a.to_string();
        } else if let Some(t) = l.strip_prefix("author-time ") {
            time = t.parse().unwrap_or(0);
        } else if l.starts_with('\t') {
            let uncommitted = hash.chars().all(|c| c == '0');
            lines.push(BlameLine {
                line: line_no,
                short: if uncommitted { "———".into() } else { hash[..7].to_string() },
                hash: hash.clone(),
                author: if uncommitted { "Not committed".into() } else { author.clone() },
                date: relative(time),
            });
        }
    }
    Ok(lines)
}

fn relative(timestamp: i64) -> String {
    if timestamp == 0 {
        return String::new();
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let s = (now - timestamp).max(0);
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86399 => format!("{} h ago", s / 3600),
        86400..=2591999 => format!("{} d ago", s / 86400),
        2592000..=31535999 => format!("{} mo ago", s / 2592000),
        _ => format!("{} y ago", s / 31536000),
    }
}

// --- Branches ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The worktree this branch is checked out in, if any.
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub local: Vec<Branch>,
    pub remote: Vec<String>,
}

#[tauri::command(async)]
pub fn git_branches(state: tauri::State<AppState>, workspace_id: String) -> Result<Branches, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["for-each-ref", "--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(worktreepath)", "refs/heads"]).map_err(err)?;
    let local = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            let track = f[2];
            let num = |key: &str| -> u32 {
                track
                    .split(|c| c == '[' || c == ']' || c == ',')
                    .map(str::trim)
                    .find_map(|p| p.strip_prefix(key))
                    .and_then(|n| n.trim().parse().ok())
                    .unwrap_or(0)
            };
            Some(Branch {
                name: f[0].to_string(),
                current: f[3] == "*",
                upstream: if f[1].is_empty() { None } else { Some(f[1].to_string()) },
                ahead: num("ahead "),
                behind: num("behind "),
                worktree: if f[4].is_empty() { None } else { Some(f[4].to_string()) },
            })
        })
        .collect();
    let remote = git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
        .map(|o| o.lines().filter(|l| !l.ends_with("/HEAD")).map(str::to_string).collect())
        .unwrap_or_default();
    Ok(Branches { local, remote })
}

#[tauri::command]
pub fn git_create_branch(state: tauri::State<AppState>, workspace_id: String, name: String, start: Option<String>) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["branch", name.as_str()];
    if let Some(s) = start.as_deref().filter(|s| !s.is_empty()) {
        args.push(s);
    }
    git(&root, &args).map(|_| ()).map_err(err)
}

/// Checks out a branch. Git's own refusal — a dirty tree that would be
/// overwritten — comes back verbatim as the error.
#[tauri::command]
pub fn git_checkout(state: tauri::State<AppState>, workspace_id: String, name: String, stash: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    if stash {
        git(&root, &["stash", "push", "-u", "-m", &format!("agentic-workspace: switching to {name}")]).map_err(err)?;
        let result = git(&root, &["checkout", &name]).map_err(err);
        let popped = git(&root, &["stash", "pop"]);
        return match (result, popped) {
            (Ok(out), Ok(_)) => Ok(out),
            (Ok(out), Err(e)) => Ok(format!("{out}\nThe stash could not be re-applied and is kept: {e:#}")),
            (Err(e), _) => Err(e),
        };
    }
    git(&root, &["checkout", &name]).map_err(err)
}

#[tauri::command]
pub fn git_delete_branch(state: tauri::State<AppState>, workspace_id: String, name: String, force: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    git(&root, &["branch", if force { "-D" } else { "-d" }, &name]).map_err(err)
}

/// Commits on `name` that no other branch holds, for a delete confirmation.
#[tauri::command(async)]
pub fn git_unmerged_commits(state: tauri::State<AppState>, workspace_id: String, name: String) -> Result<Vec<String>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let spec = format!("{name}");
    let out = git(&root, &["log", "--format=%h %s", "--max-count=20", &spec, "--not", "--all", "--"]).unwrap_or_default();
    let out = if out.trim().is_empty() {
        git(&root, &["log", "--format=%h %s", "--max-count=20", &format!("HEAD..{name}")]).unwrap_or_default()
    } else {
        out
    };
    Ok(out.lines().map(str::to_string).collect())
}

// --- Worktrees --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
    pub bare: bool,
}

#[tauri::command(async)]
pub fn git_worktrees(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<WorktreeEntry>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["worktree", "list", "--porcelain"]).map_err(err)?;
    let mut list = Vec::new();
    for block in out.split("\n\n") {
        let mut entry: Option<WorktreeEntry> = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                entry = Some(WorktreeEntry { path: p.to_string(), head: None, branch: None, is_main: list.is_empty(), locked: false, prunable: false, bare: false });
            } else if let Some(e) = entry.as_mut() {
                if let Some(h) = line.strip_prefix("HEAD ") {
                    e.head = Some(h[..h.len().min(7)].to_string());
                } else if let Some(b) = line.strip_prefix("branch ") {
                    e.branch = Some(b.trim_start_matches("refs/heads/").to_string());
                } else if line.starts_with("locked") {
                    e.locked = true;
                } else if line.starts_with("prunable") {
                    e.prunable = true;
                } else if line == "bare" {
                    e.bare = true;
                } else if line == "detached" {
                    e.branch = None;
                }
            }
        }
        if let Some(e) = entry {
            list.push(e);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn git_add_worktree(state: tauri::State<AppState>, workspace_id: String, path: String, branch: String, create: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: Vec<&str> = if create { vec!["worktree", "add", "-b", &branch, &path] } else { vec!["worktree", "add", &path, &branch] };
    git(&root, &args).map_err(err)
}

#[tauri::command]
pub fn git_remove_worktree(state: tauri::State<AppState>, workspace_id: String, path: String, force: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: Vec<&str> = if force { vec!["worktree", "remove", "--force", &path] } else { vec!["worktree", "remove", &path] };
    git(&root, &args).map_err(err)
}

/// Uncommitted changes in a worktree, for the delete confirmation.
#[tauri::command(async)]
pub fn git_worktree_dirty(path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let out = git(&root, &["status", "--porcelain", "-z"]).unwrap_or_default();
    Ok(out.split('\0').filter(|l| !l.is_empty()).map(str::to_string).collect())
}

#[tauri::command]
pub fn git_prune_worktrees(state: tauri::State<AppState>, workspace_id: String, dry_run: bool) -> Result<Vec<String>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: &[&str] = if dry_run { &["worktree", "prune", "--dry-run", "-v"] } else { &["worktree", "prune", "-v"] };
    let out = git(&root, args).map_err(err)?;
    Ok(out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
}

// --- Remotes ----------------------------------------------------------------

#[tauri::command]
pub fn git_remote(state: tauri::State<AppState>, workspace_id: String, action: String, set_upstream: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: Vec<&str> = match action.as_str() {
        "fetch" => vec!["fetch", "--all", "--prune"],
        "pull" => vec!["pull"],
        "push" if set_upstream => vec!["push", "-u", "origin", "HEAD"],
        "push" => vec!["push"],
        _ => return Err(format!("unknown remote action {action}")),
    };
    git(&root, &args).map_err(err)
}

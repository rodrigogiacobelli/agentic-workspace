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
    run(root, args, false)
}

/// Runs git and returns its stdout — or, with `whole`, stdout and stderr
/// together, since a fetch or a push writes its entire report to stderr. A
/// failure always carries both.
fn run(root: &Path, args: &[&str], whole: bool) -> Result<String> {
    // No optional locks: a `git status` would otherwise create and delete
    // `index.lock` in the watched git directory — a change, not a read, so the
    // watcher reports it — and the refresh that report starts would run
    // `git status` again, five times a second, for every repository.
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if output.status.success() && !whole {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else if output.status.success() {
        Ok(format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
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
    // What the selector offers under this workspace. Git is asked every time
    // the summary is recomputed — which the watcher does whenever anything in
    // the repository's git directory moves — so `worktree add` and
    // `worktree remove` need no other announcement.
    let siblings = if i.is_repo { worktrees(&root).unwrap_or_default() } else { Vec::new() };
    let summary = crate::state::GitSummary {
        is_repo: i.is_repo,
        branch: i.branch,
        detached: i.detached,
        state: i.state,
        is_worktree: i.is_worktree,
        upstream: i.upstream,
        ahead: i.ahead,
        behind: i.behind,
        worktrees: siblings
            .into_iter()
            // A prunable entry is one whose directory has gone: git still
            // lists it until someone prunes, and offering it would open a
            // workspace on nothing.
            .filter(|w| !w.bare && !w.prunable && Path::new(&w.path) != root)
            .map(|w| crate::state::Worktree {
                name: Path::new(&w.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| w.path.clone()),
                path: w.path,
                branch: w.branch,
                is_main: w.is_main,
            })
            .collect(),
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
            .env("GIT_OPTIONAL_LOCKS", "0")
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
    git(&root, &["diff-tree", "--no-commit-id", "-p", "--root", &hash, "--", &path]).map_err(err)
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

/// Off the main thread, since a commit runs the repository's hooks and a
/// pre-commit hook may lint the whole tree.
#[tauri::command(async)]
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
    pub short: String,
    /// First parent first; none for a root commit, several for a merge.
    pub parents: Vec<String>,
    pub refs: Vec<RefName>,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub timestamp: i64,
    /// Subject and body together, as the history's hover popup shows it.
    pub message: String,
}

/// A ref decorating a commit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefName {
    pub name: String,
    /// `head` for the branch HEAD is on, or for HEAD itself when detached;
    /// otherwise `local`, `remote` or `tag`.
    pub kind: String,
}

/// The refs a `%D` decoration names under `--decorate=full`, which spells
/// every ref out so a branch and a tag of the same name stay apart. A
/// remote's symbolic `HEAD` only repeats the branch it points at, and refs
/// outside branches and tags are not shown.
fn decorations(d: &str) -> Vec<RefName> {
    d.split(", ")
        .filter_map(|r| {
            let (name, kind) = if let Some(b) = r.strip_prefix("HEAD -> refs/heads/") {
                (b, "head")
            } else if r == "HEAD" {
                (r, "head")
            } else if let Some(t) = r.strip_prefix("tag: refs/tags/") {
                (t, "tag")
            } else if let Some(b) = r.strip_prefix("refs/heads/") {
                (b, "local")
            } else {
                (r.strip_prefix("refs/remotes/").filter(|b| !b.ends_with("/HEAD"))?, "remote")
            };
            Some(RefName { name: name.into(), kind: kind.into() })
        })
        .collect()
}

/// A page of history in date order, so a commit always comes before its
/// parents: the graph is drawn from that order. `all` walks every ref rather
/// than HEAD alone. `--parents` matters under a path filter: it rewrites each
/// commit's parents to the nearest ancestor that touched the path, which
/// keeps the graph connected; `%P` alone reports the real parents, most of
/// them never listed.
#[tauri::command(async)]
pub fn git_log(state: tauri::State<AppState>, workspace_id: String, skip: u32, limit: u32, path: Option<String>, all: Option<bool>) -> Result<Vec<LogEntry>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let skip = format!("--skip={skip}");
    let limit = format!("--max-count={limit}");
    let mut args = vec![
        "log",
        "--date-order",
        "--parents",
        "--decorate=full",
        "--format=%H%x1f%h%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar%x1f%at%x1f%B%x1e",
        skip.as_str(),
        limit.as_str(),
    ];
    if all == Some(true) {
        // Every ref a decoration can name — branches, remotes, tags and a
        // detached HEAD — and nothing else: `--all` would also walk the stash,
        // notes and prefetched tips and draw them as unlabelled branches.
        args.extend(["--branches", "--remotes", "--tags"]);
        if git(&root, &["rev-parse", "-q", "--verify", "HEAD"]).is_ok() {
            args.push("HEAD");
        }
    }
    // Always the separator, so a file named `HEAD` in the workspace cannot be
    // mistaken for the revision.
    args.push("--");
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
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
            if f.len() < 9 {
                return None;
            }
            Some(LogEntry {
                hash: f[0].into(),
                short: f[1].into(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                refs: decorations(f[3]),
                subject: f[4].into(),
                author: f[5].into(),
                date: f[6].into(),
                timestamp: f[7].trim().parse().unwrap_or(0),
                message: f[8].trim().into(),
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
            let path = parts.next_back()?.to_string();
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
                    .split(['[', ']', ','])
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
/// overwritten — comes back verbatim as the error. Off the main thread: a
/// checkout rewrites the tree and runs hooks.
#[tauri::command(async)]
pub fn git_checkout(state: tauri::State<AppState>, workspace_id: String, name: String, stash: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    if stash {
        // Only a stash this push made is popped afterwards: with nothing to
        // stash, `stash push` makes none, and a pop would apply and drop
        // whatever stash the user already had.
        let top = || git(&root, &["rev-parse", "-q", "--verify", "refs/stash"]).unwrap_or_default();
        let before = top();
        git(&root, &["stash", "push", "-u", "-m", &format!("agentic-workspace: switching to {name}")]).map_err(err)?;
        if top() == before {
            return git(&root, &["checkout", &name]).map_err(err);
        }
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
    let out = git(&root, &["log", "--format=%h %s", "--max-count=20", &name, "--not", "--all", "--"]).unwrap_or_default();
    let out = if out.trim().is_empty() {
        git(&root, &["log", "--format=%h %s", "--max-count=20", &format!("HEAD..{name}")]).unwrap_or_default()
    } else {
        out
    };
    Ok(out.lines().map(str::to_string).collect())
}

// --- Stashes ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// N in `stash@{N}`. It shifts whenever a stash above it goes, so apply
    /// and drop name a stash by its commit instead.
    pub index: u32,
    /// The stash's commit, which stays the same while its position moves.
    pub hash: String,
    /// The subject git recorded: "On master: dock drag preview".
    pub message: String,
    pub date: String,
    pub timestamp: i64,
}

#[tauri::command(async)]
pub fn git_stashes(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<Stash>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let out = git(&root, &["stash", "list", "--format=%gd%x1f%gs%x1f%cr%x1f%ct%x1f%H"]).map_err(err)?;
    Ok(out
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            // The list runs from `stash@{0}` down, so the position stands in
            // should the selector ever read other than `stash@{N}`.
            let index = f[0].strip_prefix("stash@{").and_then(|n| n.strip_suffix('}')).and_then(|n| n.parse().ok()).unwrap_or(i as u32);
            Some(Stash { index, message: f[1].into(), date: f[2].into(), timestamp: f[3].trim().parse().unwrap_or(0), hash: f[4].trim().into() })
        })
        .collect())
}

/// Stashes every change, untracked files included, under `message` when one
/// is given (GIT-18). Git's report comes back, and says so when there was
/// nothing to stash.
#[tauri::command(async)]
pub fn git_stash_push(state: tauri::State<AppState>, workspace_id: String, message: Option<String>) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["stash", "push", "--include-untracked"];
    if let Some(m) = message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.extend(["-m", m]);
    }
    git(&root, &args).map_err(err)
}

/// Where the stash with commit `hash` sits now, as `stash@{N}`. The list the
/// panel showed may be older than the repository — a stash dropped or pushed
/// from a terminal renumbers every one below it — so a stash is found by its
/// commit, and one that is gone is refused rather than mistaken for another.
fn stash_spec(root: &Path, hash: &str) -> Result<String, String> {
    let list = git(root, &["stash", "list", "--format=%H"]).map_err(err)?;
    list.lines()
        .position(|h| h.trim() == hash)
        .map(|n| format!("stash@{{{n}}}"))
        .ok_or_else(|| "That stash is no longer there; the list has been read again.".to_string())
}

/// Applies a stash, and with `pop` drops it once it applied cleanly. A stash
/// that conflicts is kept either way, and git's report of the conflict is the
/// error.
#[tauri::command(async)]
pub fn git_stash_apply(state: tauri::State<AppState>, workspace_id: String, hash: String, pop: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let spec = stash_spec(&root, &hash)?;
    git(&root, &["stash", if pop { "pop" } else { "apply" }, &spec]).map_err(err)
}

#[tauri::command]
pub fn git_stash_drop(state: tauri::State<AppState>, workspace_id: String, hash: String) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let spec = stash_spec(&root, &hash)?;
    git(&root, &["stash", "drop", &spec]).map_err(err)
}

// --- Tags -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// The short hash of the commit, reached through an annotated tag.
    pub hash: String,
    /// An annotated tag's own subject; a lightweight tag has none, so its
    /// commit's.
    pub subject: String,
    pub date: String,
    pub annotated: bool,
}

/// Every tag, newest first.
#[tauri::command(async)]
pub fn git_tags(state: tauri::State<AppState>, workspace_id: String) -> Result<Vec<Tag>, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    // `contents:subject` reads whatever object the ref names: an annotated
    // tag's message, a lightweight tag's commit. `*objectname` is the commit
    // behind an annotated tag and empty for a lightweight one.
    let format = "--format=%(refname:lstrip=2)%1f%(objecttype)%1f%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%1f%(contents:subject)%1f%(creatordate:relative)";
    let out = git(&root, &["for-each-ref", "--sort=-creatordate", format, "refs/tags"]).map_err(err)?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            Some(Tag { name: f[0].into(), annotated: f[1] == "tag", hash: f[2].into(), subject: f[3].into(), date: f[4].into() })
        })
        .collect())
}

/// Tags `target`, or HEAD: annotated when there is a message, lightweight
/// otherwise. The `--` keeps a name typed with a leading dash from being read
/// as an option: a tag named `-d` would turn the command into a delete.
#[tauri::command]
pub fn git_create_tag(state: tauri::State<AppState>, workspace_id: String, name: String, message: Option<String>, target: Option<String>) -> Result<(), String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let mut args = vec!["tag"];
    if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
        args.extend(["-a", "-m", m]);
    }
    args.extend(["--", name.as_str()]);
    if let Some(t) = target.as_deref().filter(|t| !t.is_empty()) {
        args.push(t);
    }
    git(&root, &args).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn git_delete_tag(state: tauri::State<AppState>, workspace_id: String, name: String) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    git(&root, &["tag", "-d", "--", &name]).map_err(err)
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
    worktrees(&root).map_err(err)
}

/// Every worktree of the repository `root` belongs to, git's own answer.
pub fn worktrees(root: &Path) -> Result<Vec<WorktreeEntry>> {
    let out = git(root, &["worktree", "list", "--porcelain"])?;
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

/// Off the main thread, since it checks out a whole tree.
#[tauri::command(async)]
pub fn git_add_worktree(state: tauri::State<AppState>, workspace_id: String, path: String, branch: String, create: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: Vec<&str> = if create { vec!["worktree", "add", "-b", &branch, &path] } else { vec!["worktree", "add", &path, &branch] };
    git(&root, &args).map_err(err)
}

#[tauri::command(async)]
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

/// Fetches, pulls or pushes. Off the main thread, because a remote can take
/// seconds to answer and the window has to stay usable meanwhile; git's whole
/// output comes back either way, not a line of it (GIT-17).
#[tauri::command(async)]
pub fn git_remote(app: tauri::AppHandle, state: tauri::State<AppState>, workspace_id: String, action: String, set_upstream: bool) -> Result<String, String> {
    let root = root_of(&state, &workspace_id).map_err(err)?;
    let args: Vec<&str> = match action.as_str() {
        "fetch" => vec!["fetch", "--all", "--prune"],
        "pull" => vec!["pull"],
        "push" if set_upstream => vec!["push", "-u", "origin", "HEAD"],
        "push" => vec!["push"],
        _ => return Err(format!("unknown remote action {action}")),
    };
    // Git's whole report, success or not: the panel shows it in full (GIT-17).
    let result = run(&root, &args, true).map_err(err);
    // A fetch or a push moves only `refs/remotes/…`, which the watcher does
    // not see, so the ahead and behind counts and the history are told here.
    refresh_summary(&app, &workspace_id);
    use tauri::Emitter;
    let _ = app.emit(crate::watch::EVENT_GIT_CHANGED, &workspace_id);
    crate::session::publish(&app);
    result
}

#[cfg(test)]
mod tests {
    use super::{decorations, RefName};

    fn r(name: &str, kind: &str) -> RefName {
        RefName { name: name.into(), kind: kind.into() }
    }

    #[test]
    fn a_decoration_names_each_branch_and_tag_once_with_its_kind() {
        // As `git log --decorate=full --format=%D` prints them.
        assert_eq!(
            decorations("HEAD -> refs/heads/main, tag: refs/tags/v2, refs/remotes/origin/main, refs/remotes/origin/HEAD"),
            [r("main", "head"), r("v2", "tag"), r("origin/main", "remote")]
        );
        assert_eq!(decorations("HEAD, tag: refs/tags/release/v1"), [r("HEAD", "head"), r("release/v1", "tag")]);
        assert_eq!(decorations("refs/remotes/origin/fix/nvidia, refs/heads/fix/nvidia"), [r("origin/fix/nvidia", "remote"), r("fix/nvidia", "local")]);
        // A branch and a tag may share a name; the full spelling keeps them apart.
        assert_eq!(decorations("refs/heads/v1, tag: refs/tags/v1"), [r("v1", "local"), r("v1", "tag")]);
        assert_eq!(decorations("refs/stash"), []);
        assert_eq!(decorations(""), []);
    }
}

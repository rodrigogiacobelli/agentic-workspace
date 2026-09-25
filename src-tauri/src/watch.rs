//! Filesystem watches on exactly the directories the active workspace shows:
//! its root, its expanded directories and the directories of its tabs, each
//! non-recursively, plus the git directories of every workspace. An ignored
//! subtree is never watched unless the user expands it.

use crate::session;
use crate::state::{AppState, Workspace};
use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_DIR_CHANGED: &str = "dir-changed";
pub const EVENT_GIT_CHANGED: &str = "git-changed";
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a batch waits for a writer to pause.
const MAX_BATCH: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChanged {
    pub workspace_id: String,
    /// Relative to the workspace root; empty for the root itself.
    pub dirs: Vec<String>,
}

pub struct Watcher {
    inner: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
}

impl Watcher {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let handler = app.clone();
        let inner = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                // A file opened or read is not a change. Every refresh this
                // application runs opens files in what it watches — git reads
                // `HEAD` and the refs, a tab re-reads its file, the tree lists
                // a directory — so forwarding reads would have each refresh
                // start the next, forever. A write that finished still counts.
                if matches!(event.kind, EventKind::Access(kind) if kind != AccessKind::Close(AccessMode::Write)) {
                    return;
                }
                for path in event.paths.into_iter().filter(|p| !is_git_lock(p, || git_dirs(&handler))) {
                    let _ = tx.send(path);
                }
            }
        });
        let inner = match inner {
            Ok(w) => Some(w),
            Err(e) => {
                session::notice(&app, format!("File watching is unavailable: {e}"));
                None
            }
        };
        std::thread::Builder::new()
            .name("watch-settle".into())
            .spawn(move || settle_loop(app, rx))
            .ok();
        Self { inner, watched: HashSet::new() }
    }

    fn apply(&mut self, wanted: HashSet<PathBuf>, app: &AppHandle) {
        let Some(inner) = self.inner.as_mut() else { return };
        for path in self.watched.difference(&wanted) {
            let _ = inner.unwatch(path);
        }
        let mut watched = HashSet::new();
        for path in wanted {
            if self.watched.contains(&path) {
                watched.insert(path);
                continue;
            }
            match inner.watch(&path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    watched.insert(path);
                }
                Err(e) => session::notice(
                    app,
                    format!("Not watching {}: {e}", path.display()),
                ),
            }
        }
        self.watched = watched;
    }

    /// Watches again every watched directory a change names itself. Deleting
    /// a directory ends its watch, and `apply` passes over a path it holds as
    /// watched: `git stash -u`, `git clean` and a checkout delete directories
    /// the tree shows, and may make them again inside one batch. A watch added
    /// twice is still one watch. A directory still gone is let go. Returns
    /// whether a change named a directory not watched — one let go coming
    /// back, or a new one — so the caller can `sync` it in if it is wanted.
    fn heal(&mut self, paths: &HashSet<PathBuf>) -> bool {
        let Some(inner) = self.inner.as_mut() else { return false };
        let mut unwatched = false;
        for path in paths {
            if !self.watched.contains(path) {
                unwatched |= path.is_dir();
                continue;
            }
            let watching = path.is_dir() && inner.watch(path, RecursiveMode::NonRecursive).is_ok();
            if !watching {
                let _ = inner.unwatch(path);
                self.watched.remove(path);
            }
        }
        unwatched
    }
}

/// A lock git holds while it writes — `index.lock`, `HEAD.lock`, a ref's lock.
/// Every `git status` an agent runs creates and deletes `index.lock` without
/// changing anything, and a real change always lands as the lock's rename to
/// the final name, which arrives under that name. A git directory is known by
/// its name, `.git`, or else as one of `git_dirs`: a repository made with
/// `--separate-git-dir` keeps it under any name.
fn is_git_lock(path: &Path, git_dirs: impl FnOnce() -> Vec<PathBuf>) -> bool {
    path.extension().is_some_and(|e| e == "lock")
        && (path.components().any(|c| c.as_os_str() == ".git") || git_dirs().iter().any(|d| path.starts_with(d)))
}

/// The git directory and common directory of every workspace's repository.
fn git_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
    let git = state.git.lock();
    git.values().flat_map(|g| g.git_dir.iter().chain(g.common_dir.iter()).cloned()).collect()
}

/// Coalesces bursts of events into one `dir-changed` per affected directory.
/// A writer that never pauses — a download, a log being tee'd — would hold
/// every workspace's events back, so a batch is also sent once it is
/// `MAX_BATCH` old.
fn settle_loop(app: AppHandle, rx: mpsc::Receiver<PathBuf>) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        let first = match rx.recv() {
            Ok(p) => p,
            Err(_) => return,
        };
        pending.insert(first);
        let started = std::time::Instant::now();
        loop {
            let left = MAX_BATCH.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(SETTLE.min(left)) {
                Ok(p) => {
                    pending.insert(p);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        emit(&app, std::mem::take(&mut pending));
    }
}

/// The directory a change is visible in: the path itself when it is a watched
/// directory, its parent otherwise.
fn dir_of(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf())
    }
}

/// One workspace's repository, as a change inside it is attributed.
struct Repo {
    id: String,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

/// The workspaces a change in `dir` concerns. A linked worktree's own git
/// directory, `<common>/worktrees/<name>`, holds its HEAD and its index and is
/// that worktree's alone. Everything else in the common directory — the refs,
/// `packed-refs`, a new entry under `worktrees/`, and the main worktree's own
/// HEAD and index, which live there too — reaches every workspace on the
/// repository.
fn concerned<'a>(dir: &Path, repos: &'a [Repo]) -> Vec<&'a str> {
    let own: Vec<&str> = repos
        .iter()
        .filter(|r| r.git_dir != r.common_dir && dir.starts_with(&r.git_dir))
        .map(|r| r.id.as_str())
        .collect();
    if !own.is_empty() {
        return own;
    }
    repos.iter().filter(|r| dir.starts_with(&r.common_dir)).map(|r| r.id.as_str()).collect()
}

/// The directory of every tab in both working areas, relative to the root: a
/// diff's as well as a file's.
fn tab_dirs(ws: &Workspace) -> impl Iterator<Item = &Path> {
    ws.all_editors().filter_map(|t| Path::new(&t.path).parent())
}

/// Announces one settled batch of changed paths.
fn emit(app: &AppHandle, paths: HashSet<PathBuf>) {
    let state = app.state::<AppState>();
    let unwatched = state.watcher.lock().heal(&paths);
    let dirs: HashSet<PathBuf> = paths.iter().map(|p| dir_of(p)).collect();
    let (roots, open) = {
        let session = state.session.lock();
        let roots: Vec<(String, PathBuf)> = session.workspaces.iter().map(|w| (w.id.clone(), w.path.clone())).collect();
        let open: HashSet<PathBuf> = session
            .active
            .as_deref()
            .and_then(|id| session.workspace(id))
            .map(|ws| tab_dirs(ws).map(|d| ws.path.join(d)).collect())
            .unwrap_or_default();
        (roots, open)
    };
    let repos: Vec<Repo> = state
        .git
        .lock()
        .iter()
        .filter_map(|(id, g)| Some(Repo { id: id.clone(), git_dir: g.git_dir.clone()?, common_dir: g.common_dir.clone()? }))
        .collect();
    let mut touched: Vec<String> = Vec::new();
    let mut per_workspace: HashMap<String, Vec<String>> = HashMap::new();
    for dir in dirs {
        let concerned = concerned(&dir, &repos);
        let in_git = !concerned.is_empty();
        touched.extend(concerned.into_iter().map(str::to_string));
        // `git-changed` announces a change inside a git directory. Only a tab
        // open on a file in there — a hook, `COMMIT_EDITMSG` — needs to hear
        // of it as a directory too.
        if in_git && !open.contains(&dir) {
            continue;
        }
        // A directory may sit inside several workspaces (a worktree inside its
        // parent project); the deepest root claims it, and any others as well.
        for (id, root) in &roots {
            if let Ok(rel) = dir.strip_prefix(root) {
                per_workspace
                    .entry(id.clone())
                    .or_default()
                    .push(rel.to_string_lossy().into_owned());
            }
        }
    }
    // A change under a repository's git directory means the branch, the
    // index or the refs may have moved: each summary it concerns is
    // recomputed, and the panels are told either way, since the index moves
    // nothing a summary holds.
    let mut refreshed: HashSet<String> = HashSet::new();
    let mut changed = false;
    while let Some(id) = touched.pop() {
        if !refreshed.insert(id.clone()) || !crate::git::refresh_summary(app, &id) {
            continue;
        }
        changed = true;
        // A worktree's branch is also a row in every sibling's worktree list.
        if let Some(repo) = repos.iter().find(|r| r.id == id) {
            touched.extend(repos.iter().filter(|r| r.common_dir == repo.common_dir).map(|r| r.id.clone()));
        }
    }
    for id in &refreshed {
        let _ = app.emit(EVENT_GIT_CHANGED, id);
    }
    // `git worktree add` and `git worktree remove` both write inside the
    // repository's git directory, so this is where the selector's list of
    // worktrees changes — and where one it had opened stops existing. The
    // first add also creates the directory the watch needs, so the watched
    // set is made to match before anything is published. It is made to match
    // after every change in a git directory, whether or not a summary moved:
    // a stash popped or a reset brings back directories the tree shows, which
    // `heal` let go when they went. A directory made anywhere else may be one
    // of those coming back too, in a later batch than its deletion.
    if changed {
        session::prune_worktrees(app);
    }
    if !refreshed.is_empty() || unwatched {
        sync(app);
    }
    if changed {
        session::publish(app);
    }
    for (workspace_id, dirs) in per_workspace {
        let _ = app.emit(EVENT_DIR_CHANGED, DirChanged { workspace_id, dirs });
    }
}

/// Makes the watched set match what is on screen: the active workspace's
/// root, expansions and tab directories. A background workspace's tabs are
/// not watched; `catch_up` tells it to re-read them when it comes back.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    // Held while the set is worked out as well as applied: a switch runs off
    // the main thread, and two syncs racing must not apply the older session's
    // set last.
    let mut watcher = state.watcher.lock();
    let wanted: HashSet<PathBuf> = {
        let session = state.session.lock();
        let mut wanted = HashSet::new();
        if let Some(ws) = session.active.as_deref().and_then(|id| session.workspace(id)).filter(|ws| ws.path.is_dir()) {
            wanted.insert(ws.path.clone());
            wanted.extend(ws.expanded.iter().map(|rel| ws.path.join(rel)));
            wanted.extend(tab_dirs(ws).map(|d| ws.path.join(d)));
        }
        // HEAD, the index and the refs of every workspace's repository, so
        // the branch shown follows a checkout made in the terminal and the
        // tags follow a `git tag` — and `worktrees/`, whose entries are what
        // the selector lists. Every workspace and not only the active one,
        // because the selector offers the worktrees of all of them: a `git
        // worktree add` in a background project has to reach it without being
        // switched to.
        let git = state.git.lock();
        for ws in &session.workspaces {
            let Some(g) = git.get(&ws.id) else { continue };
            for dir in g.git_dir.iter().chain(g.common_dir.iter()) {
                wanted.insert(dir.clone());
                wanted.insert(dir.join("refs/heads"));
                // `refs/stash` sits directly under `refs/`, so a stash pushed
                // or dropped from a terminal reaches the Commit panel.
                wanted.insert(dir.join("refs"));
                wanted.insert(dir.join("refs/tags"));
                wanted.insert(dir.join("worktrees"));
            }
        }
        drop(git);
        wanted.into_iter().filter(|p| p.is_dir()).collect()
    };
    watcher.apply(wanted, app);
}

/// Tells the frontend that everything it shows of a workspace may have
/// changed: its root, every expanded directory, the directory of every tab,
/// and its repository. Only the active workspace is watched, so a background
/// one hears nothing of files changing — nor of the git status, which follows
/// the files. One coming back to the screen gets this nudge to re-read them.
pub fn catch_up(app: &AppHandle, workspace_id: &str) {
    let dirs: Vec<String> = {
        let state = app.state::<AppState>();
        let session = state.session.lock();
        let Some(ws) = session.workspace(workspace_id) else { return };
        let mut dirs = vec![String::new()];
        for dir in ws.expanded.iter().cloned().chain(tab_dirs(ws).map(|d| d.to_string_lossy().into_owned())) {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs
    };
    let _ = app.emit(EVENT_DIR_CHANGED, DirChanged { workspace_id: workspace_id.to_string(), dirs });
    let _ = app.emit(EVENT_GIT_CHANGED, workspace_id);
}

#[cfg(test)]
mod tests {
    use super::{concerned, is_git_lock, Repo};
    use std::path::Path;

    #[test]
    fn a_linked_worktrees_own_git_directory_concerns_it_alone_and_the_rest_reaches_the_family() {
        let repo = |id: &str, git_dir: &str, common_dir: &str| Repo { id: id.into(), git_dir: git_dir.into(), common_dir: common_dir.into() };
        let repos = [
            repo("main", "/p/.git", "/p/.git"),
            // A workspace on a subdirectory of the main worktree shares its git directory.
            repo("sub", "/p/.git", "/p/.git"),
            repo("b", "/p/.git/worktrees/b", "/p/.git"),
            repo("c", "/p/.git/worktrees/c", "/p/.git"),
            repo("other", "/q/.git", "/q/.git"),
        ];
        let at = |dir: &str| {
            let mut ids = concerned(Path::new(dir), &repos);
            ids.sort_unstable();
            ids
        };
        let family = ["b", "c", "main", "sub"];
        assert_eq!(at("/p/.git/worktrees/b"), ["b"]);
        assert_eq!(at("/p/.git/worktrees/c/refs"), ["c"]);
        assert_eq!(at("/p/.git"), family);
        assert_eq!(at("/p/.git/refs/heads"), family);
        // The list itself, a worktree nothing is open on, and one whose name
        // merely starts with another's.
        assert_eq!(at("/p/.git/worktrees"), family);
        assert_eq!(at("/p/.git/worktrees/d"), family);
        assert_eq!(at("/p/.git/worktrees/bb"), family);
        assert_eq!(at("/q/.git/refs/tags"), ["other"]);
        assert!(at("/p/src").is_empty());
        assert!(at("/p/.github").is_empty());
    }

    #[test]
    fn only_a_lock_inside_a_git_directory_is_dropped() {
        let lock = |path: &str| is_git_lock(Path::new(path), || vec!["/srv/p.git".into()]);
        assert!(lock("/p/.git/index.lock"));
        assert!(lock("/p/.git/refs/heads/feature/x.lock"));
        assert!(lock("/p/.git/worktrees/b/HEAD.lock"));
        assert!(lock("/srv/p.git/index.lock"));
        assert!(lock("/srv/p.git/refs/heads/x.lock"));
        assert!(!lock("/p/.git/index"));
        assert!(!lock("/p/Cargo.lock"));
        assert!(!lock("/p/.github/flake.lock"));
        assert!(!lock("/srv/p.github/x.lock"));
    }
}

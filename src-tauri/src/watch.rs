//! Filesystem watches on exactly the directories the tree shows: the active
//! workspace's root and its expanded directories, each non-recursively. An
//! ignored subtree is never watched unless the user expands it.

use crate::session;
use crate::state::AppState;
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
                for path in event.paths {
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
}

/// Coalesces bursts of events into one `dir-changed` per affected directory.
fn settle_loop(app: AppHandle, rx: mpsc::Receiver<PathBuf>) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        let first = match rx.recv() {
            Ok(p) => p,
            Err(_) => return,
        };
        pending.insert(dir_of(&first));
        loop {
            match rx.recv_timeout(SETTLE) {
                Ok(p) => {
                    pending.insert(dir_of(&p));
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

fn emit(app: &AppHandle, dirs: HashSet<PathBuf>) {
    let state = app.state::<AppState>();
    let roots: Vec<(String, PathBuf)> = state
        .session
        .lock()
        .workspaces
        .iter()
        .map(|w| (w.id.clone(), w.path.clone()))
        .collect();
    // A change under a repository's git directory means the branch, the
    // index or the refs moved: the summary is refreshed and the panel told.
    let git_dirs: Vec<(String, Vec<PathBuf>)> = state
        .git
        .lock()
        .iter()
        .map(|(id, g)| (id.clone(), g.git_dir.iter().chain(g.common_dir.iter()).cloned().collect()))
        .collect();
    let mut git_touched: HashSet<String> = HashSet::new();
    for dir in &dirs {
        for (id, gdirs) in &git_dirs {
            if gdirs.iter().any(|g| dir.starts_with(g)) {
                git_touched.insert(id.clone());
            }
        }
    }
    let touched_any = !git_touched.is_empty();
    for id in git_touched {
        crate::git::refresh_summary(app, &id);
        let _ = app.emit(EVENT_GIT_CHANGED, &id);
    }
    if touched_any {
        // `git worktree add` and `git worktree remove` both write inside the
        // repository's git directory, so this is where the selector's list of
        // worktrees changes — and where one it had opened stops existing. The
        // first add also creates the directory the watch needs, so the watched
        // set is made to match before anything is published.
        session::prune_worktrees(app);
        sync(app);
        session::publish(app);
    }
    let mut per_workspace: HashMap<String, Vec<String>> = HashMap::new();
    for dir in dirs {
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
    for (workspace_id, dirs) in per_workspace {
        let _ = app.emit(EVENT_DIR_CHANGED, DirChanged { workspace_id, dirs });
    }
}

/// Makes the watched set match what is on screen: the active workspace's root
/// and expansions, plus the directory of every tab in every workspace — a
/// diff's as well as a file's, in both working areas — since an agent may
/// rewrite a file whose tab is in the background.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let wanted: HashSet<PathBuf> = {
        let session = state.session.lock();
        let mut wanted = HashSet::new();
        for ws in &session.workspaces {
            if !ws.path.is_dir() {
                continue;
            }
            if session.active.as_deref() == Some(&ws.id) {
                wanted.insert(ws.path.clone());
                wanted.extend(ws.expanded.iter().map(|rel| ws.path.join(rel)));
            }
            for tab in ws.all_editors() {
                let file = ws.path.join(&tab.path);
                if let Some(dir) = file.parent() {
                    wanted.insert(dir.to_path_buf());
                }
            }
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
    state.watcher.lock().apply(wanted, app);
}

/// Tells the frontend that everything it shows of a workspace may have
/// changed: its root and every expanded directory, and its repository. The
/// frontend keeps a workspace's views alive while another is on screen, but
/// the tree is only watched for the active workspace, so a background one
/// hears nothing of files changing — nor of the git status, which follows the
/// files. One coming back to the screen gets this nudge to re-read both.
pub fn catch_up(app: &AppHandle, workspace_id: &str) {
    let dirs: Vec<String> = {
        let state = app.state::<AppState>();
        let session = state.session.lock();
        let Some(ws) = session.workspace(workspace_id) else { return };
        std::iter::once(String::new()).chain(ws.expanded.iter().cloned()).collect()
    };
    let _ = app.emit(EVENT_DIR_CHANGED, DirChanged { workspace_id: workspace_id.to_string(), dirs });
    let _ = app.emit(EVENT_GIT_CHANGED, workspace_id);
}

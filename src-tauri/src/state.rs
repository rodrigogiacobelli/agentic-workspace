//! The one state object Tauri holds, and the session model it serialises.

use crate::pty;
use crate::watch;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub const SESSION_VERSION: u32 = 1;

/// Everything restored across a launch. `version` guards the file format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    pub active: Option<String>,
    /// Workspace ids, most recently used first.
    #[serde(default)]
    pub recent: Vec<String>,
}

impl Default for Session {
    fn default() -> Self {
        Self { version: SESSION_VERSION, workspaces: Vec::new(), active: None, recent: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    #[serde(default)]
    pub terminals: Vec<TerminalTab>,
    #[serde(default)]
    pub active_terminal: Option<String>,
    #[serde(default)]
    pub editors: Vec<EditorTab>,
    #[serde(default)]
    pub active_editor: Option<String>,
    /// Expanded tree directories, relative to `path`.
    #[serde(default)]
    pub expanded: Vec<String>,
    /// Recently opened files, relative to `path`, most recent first.
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// Whether `path` is a directory right now. Computed when published.
    #[serde(default, skip_deserializing)]
    pub available: bool,
    /// A background terminal here printed since it was last viewed.
    #[serde(default, skip_deserializing)]
    pub attention: bool,
    /// Branch and state of the repository, when the directory is one.
    #[serde(default, skip_deserializing)]
    pub git: Option<GitSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub state: Option<String>,
    pub is_worktree: bool,
    #[serde(skip)]
    pub git_dir: Option<PathBuf>,
    #[serde(skip)]
    pub common_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTab {
    pub id: String,
    /// A name the user gave the tab. `None` lets the program's title show.
    #[serde(default)]
    pub name: Option<String>,
    pub cwd: PathBuf,
    #[serde(default, skip_deserializing)]
    pub attention: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTab {
    pub id: String,
    /// Relative to the workspace path.
    pub path: String,
    /// `source`, `split` or `rich`; meaningful for markdown only.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// First visible line, restored on reopen.
    #[serde(default)]
    pub line: u32,
}

fn default_mode() -> String {
    "rich".into()
}

impl Session {
    pub fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    pub fn workspace_mut(&mut self, id: &str) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.id == id)
    }

    pub fn workspace_of_terminal_mut_ref(&self, terminal_id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.terminals.iter().any(|t| t.id == terminal_id))
    }

    pub fn workspace_of_terminal_mut(&mut self, terminal_id: &str) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.terminals.iter().any(|t| t.id == terminal_id))
    }
}

pub struct AppState {
    pub session: Mutex<Session>,
    pub settings: Mutex<crate::settings::Settings>,
    /// Terminal ids that printed while out of view.
    pub attention: Mutex<std::collections::HashSet<String>>,
    pub activities: crate::agent::Activities,
    /// Repository summaries keyed by workspace id, refreshed on git changes.
    pub git: Mutex<HashMap<String, GitSummary>>,
    /// Live pseudoterminals keyed by terminal tab id. Locked after `session`,
    /// never before it.
    pub ptys: Mutex<HashMap<String, pty::Live>>,
    pub watcher: Mutex<watch::Watcher>,
    pub data_dir: PathBuf,
    /// Messages for the user that have no command to return through, such as
    /// a state store that could not be read at launch.
    pub notices: Mutex<Vec<String>>,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique for the life of the process and distinct across launches, without a
/// dependency: launch time in nanoseconds plus a counter.
pub fn new_id() -> String {
    use std::sync::OnceLock;
    static EPOCH: OnceLock<u64> = OnceLock::new();
    let epoch = EPOCH.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    });
    format!("{:x}-{:x}", epoch, COUNTER.fetch_add(1, Ordering::Relaxed))
}

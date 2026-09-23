//! The one state object Tauri holds, and the session model it serialises.

use crate::pty;
use crate::tray;
use crate::watch;
use crate::windows;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub const SESSION_VERSION: u32 = 2;

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
    /// Every editor group, in no particular order; `layout` arranges them.
    #[serde(default)]
    pub groups: Vec<EditorGroup>,
    #[serde(default)]
    pub active_group: Option<String>,
    /// How the groups are arranged: a tree of rows and columns whose leaves
    /// are the groups, every group appearing exactly once.
    #[serde(default)]
    pub layout: Option<Layout>,
    /// Session files from before the layout tree held the width of the first
    /// of two groups here.
    #[serde(default = "default_ratio", skip_serializing)]
    pub split_ratio: f32,
    /// Session files from before editor groups existed hold these two.
    #[serde(default, skip_serializing)]
    pub editors: Vec<EditorTab>,
    #[serde(default, skip_serializing)]
    pub active_editor: Option<String>,
    /// Expanded tree directories, relative to `path`.
    #[serde(default)]
    pub expanded: Vec<String>,
    /// Recently opened files, relative to `path`, most recent first.
    #[serde(default)]
    pub recent_files: Vec<String>,
    /// Custom views: named lists of workspace-relative paths (VIEW-01).
    #[serde(default)]
    pub views: Vec<View>,
    /// The view the Files panel last showed; `None` is the file tree.
    #[serde(default)]
    pub active_view: Option<String>,
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

/// A flat, ordered list of shortcuts into the workspace. Each entry sits at
/// the view's root whatever its depth on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub entries: Vec<String>,
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

fn default_ratio() -> f32 {
    0.5
}

/// The arrangement of editor groups: a leaf names a group, a split lays its
/// children out left to right (`row`) or top to bottom (`column`), each
/// taking `sizes[i]` of the space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    Group { id: String },
    Split { direction: String, children: Vec<Layout>, sizes: Vec<f32> },
}

impl Layout {
    pub fn leaves(&self, out: &mut Vec<String>) {
        match self {
            Layout::Group { id } => out.push(id.clone()),
            Layout::Split { children, .. } => children.iter().for_each(|c| c.leaves(out)),
        }
    }

    /// Wraps the leaf `id` in a split beside `new` — or, when the enclosing
    /// split already runs in that direction, inserts `new` as its sibling so
    /// three columns share one row rather than nesting.
    pub fn split_leaf(&mut self, id: &str, direction: &str, new: &str, before: bool) -> bool {
        if let Layout::Split { direction: dir, children, sizes } = self {
            if dir == direction {
                if let Some(i) = children.iter().position(|c| matches!(c, Layout::Group { id: g } if g == id)) {
                    let half = sizes.get(i).copied().unwrap_or(1.0) / 2.0;
                    if let Some(s) = sizes.get_mut(i) {
                        *s = half;
                    }
                    let at = if before { i } else { i + 1 };
                    children.insert(at, Layout::Group { id: new.to_string() });
                    sizes.insert(at, half);
                    return true;
                }
            }
            return children.iter_mut().any(|c| c.split_leaf(id, direction, new, before));
        }
        if matches!(self, Layout::Group { id: g } if g == id) {
            let old = std::mem::replace(self, Layout::Group { id: String::new() });
            let new = Layout::Group { id: new.to_string() };
            let children = if before { vec![new, old] } else { vec![old, new] };
            *self = Layout::Split { direction: direction.to_string(), children, sizes: vec![0.5, 0.5] };
            return true;
        }
        false
    }

    /// Removes the leaf `id`; the sibling that remains takes its space, and a
    /// split left with one child collapses into that child.
    pub fn remove_leaf(&mut self, id: &str) -> bool {
        let Layout::Split { children, sizes, .. } = self else { return false };
        if let Some(i) = children.iter().position(|c| matches!(c, Layout::Group { id: g } if g == id)) {
            children.remove(i);
            if i < sizes.len() {
                sizes.remove(i);
            }
        } else if !children.iter_mut().any(|c| c.remove_leaf(id)) {
            return false;
        }
        self.normalize();
        true
    }

    /// Restores the invariants after an edit: one-child splits collapse, and
    /// sizes count the children and sum to one.
    pub fn normalize(&mut self) {
        if let Layout::Split { children, sizes, .. } = self {
            children.iter_mut().for_each(Layout::normalize);
            if children.len() == 1 {
                *self = children.remove(0);
                return;
            }
            sizes.resize(children.len(), 0.0);
            let total: f32 = sizes.iter().filter(|s| s.is_finite() && **s > 0.0).sum();
            if total <= 0.0 {
                sizes.iter_mut().for_each(|s| *s = 1.0 / children.len() as f32);
            } else {
                sizes.iter_mut().for_each(|s| *s = if s.is_finite() && *s > 0.0 { *s / total } else { 0.0 });
            }
        }
    }

    /// The sizes of the split reached by following child indexes from the root.
    pub fn sizes_at(&mut self, path: &[usize]) -> Option<&mut Vec<f32>> {
        match self {
            Layout::Split { children, sizes, .. } => match path.split_first() {
                None => Some(sizes),
                Some((i, rest)) => children.get_mut(*i)?.sizes_at(rest),
            },
            Layout::Group { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorGroup {
    pub id: String,
    #[serde(default)]
    pub editors: Vec<EditorTab>,
    #[serde(default)]
    pub active_editor: Option<String>,
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
    /// Set when the tab shows a diff of `path` rather than the file itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffSpec>,
    /// A preview tab: one per group, replaced by the next single click.
    #[serde(default)]
    pub preview: bool,
}

/// Which diff of a path a tab shows: the working tree against the index, the
/// index against HEAD, or one commit's change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSpec {
    /// `worktree`, `staged` or `commit`.
    pub kind: String,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub untracked: bool,
}

fn default_mode() -> String {
    "rich".into()
}

impl Workspace {
    /// Every workspace has at least one group and a layout naming each group
    /// exactly once; older session files and new workspaces get theirs here.
    pub fn ensure_groups(&mut self) {
        if self.groups.is_empty() {
            let id = new_id();
            self.groups.push(EditorGroup { id: id.clone(), editors: std::mem::take(&mut self.editors), active_editor: self.active_editor.take() });
            self.active_group = Some(id);
        }
        if self.active_group.as_deref().map(|g| !self.groups.iter().any(|x| x.id == g)).unwrap_or(true) {
            self.active_group = self.groups.first().map(|g| g.id.clone());
        }
        let mut leaves = Vec::new();
        if let Some(l) = &self.layout {
            l.leaves(&mut leaves);
        }
        let mut known: Vec<&str> = self.groups.iter().map(|g| g.id.as_str()).collect();
        known.sort_unstable();
        let mut named: Vec<&str> = leaves.iter().map(String::as_str).collect();
        named.sort_unstable();
        if known != named {
            // A layout that disagrees with the groups is rebuilt as one row;
            // a two-group session from before the tree keeps its ratio.
            let ids: Vec<Layout> = self.groups.iter().map(|g| Layout::Group { id: g.id.clone() }).collect();
            self.layout = Some(if ids.len() == 1 {
                ids.into_iter().next().expect("one group")
            } else {
                let sizes = if ids.len() == 2 { vec![self.split_ratio, 1.0 - self.split_ratio] } else { vec![1.0 / ids.len() as f32; ids.len()] };
                Layout::Split { direction: "row".into(), children: ids, sizes }
            });
        }
        if let Some(l) = self.layout.as_mut() {
            l.normalize();
        }
    }

    /// Drops groups left empty, unless it is the last one, and collapses the
    /// layout around them (ED-38).
    pub fn prune_groups(&mut self) {
        while self.groups.len() > 1 {
            let Some(empty) = self.groups.iter().find(|g| g.editors.is_empty()).map(|g| g.id.clone()) else { break };
            self.groups.retain(|g| g.id != empty);
            if let Some(l) = self.layout.as_mut() {
                l.remove_leaf(&empty);
            }
            if self.active_group.as_deref() == Some(&empty) {
                self.active_group = None;
            }
        }
        self.ensure_groups();
    }

    pub fn group_mut(&mut self, id: &str) -> Option<&mut EditorGroup> {
        self.groups.iter_mut().find(|g| g.id == id)
    }

    pub fn active_group_mut(&mut self) -> &mut EditorGroup {
        self.ensure_groups();
        let id = self.active_group.clone().unwrap_or_default();
        let index = self.groups.iter().position(|g| g.id == id).unwrap_or(0);
        &mut self.groups[index]
    }

    pub fn group_of_editor_mut(&mut self, editor_id: &str) -> Option<&mut EditorGroup> {
        self.groups.iter_mut().find(|g| g.editors.iter().any(|e| e.id == editor_id))
    }

    pub fn all_editors(&self) -> impl Iterator<Item = &EditorTab> {
        self.groups.iter().flat_map(|g| g.editors.iter())
    }
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
    /// The terminal tab on screen: the active workspace's active terminal,
    /// refreshed by `session::persist`. A chunk of output reads this instead
    /// of the session, whose lock is held across the whole of `persist`
    /// (PERF-04).
    pub foreground: Mutex<Option<String>>,
    pub activities: crate::agent::Activities,
    /// Repository summaries keyed by workspace id, refreshed on git changes.
    pub git: Mutex<HashMap<String, GitSummary>>,
    pub hotkey: Mutex<crate::hotkey::Hotkey>,
    /// The window label that last had focus; the global hotkey raises it.
    pub last_focused: Mutex<String>,
    /// Live pseudoterminals keyed by terminal tab id. Locked after `session`,
    /// never before it.
    pub ptys: Mutex<HashMap<String, pty::Live>>,
    pub watcher: Mutex<watch::Watcher>,
    /// Per-window geometry, restored when a window is shown again.
    pub windows: Mutex<windows::Store>,
    pub tray: tray::Tray,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn g(id: &str) -> Layout {
        Layout::Group { id: id.into() }
    }

    fn leaves(l: &Layout) -> Vec<String> {
        let mut out = Vec::new();
        l.leaves(&mut out);
        out
    }

    #[test]
    fn splits_nest_across_directions_and_join_along_one() {
        let mut l = g("a");
        assert!(l.split_leaf("a", "row", "b", false));
        assert_eq!(leaves(&l), ["a", "b"]);
        // A third column joins the row rather than nesting a row in a row.
        assert!(l.split_leaf("b", "row", "c", false));
        assert!(matches!(&l, Layout::Split { direction, children, sizes } if direction == "row" && children.len() == 3 && (sizes.iter().sum::<f32>() - 1.0).abs() < 1e-5));
        // A split in the other direction nests inside the leaf.
        assert!(l.split_leaf("c", "column", "d", false));
        assert_eq!(leaves(&l), ["a", "b", "c", "d"]);
        let Layout::Split { children, .. } = &l else { panic!() };
        assert!(matches!(&children[2], Layout::Split { direction, .. } if direction == "column"));
        // Dropping before puts the new group first.
        assert!(l.split_leaf("a", "column", "e", true));
        let Layout::Split { children, .. } = &l else { panic!() };
        assert_eq!(leaves(&children[0]), ["e", "a"]);
        assert!(!l.split_leaf("zz", "row", "f", false));
    }

    #[test]
    fn removing_a_leaf_gives_its_space_to_its_sibling_and_collapses_single_splits() {
        let mut l = Layout::Split {
            direction: "row".into(),
            children: vec![g("a"), Layout::Split { direction: "column".into(), children: vec![g("b"), g("c")], sizes: vec![0.3, 0.7] }],
            sizes: vec![0.4, 0.6],
        };
        assert!(l.remove_leaf("b"));
        assert_eq!(l, Layout::Split { direction: "row".into(), children: vec![g("a"), g("c")], sizes: vec![0.4, 0.6] });
        assert!(l.remove_leaf("a"));
        assert_eq!(l, g("c"));
        assert!(!l.remove_leaf("c"));
    }

    #[test]
    fn sizes_are_renormalised_and_reached_by_path() {
        let mut l = Layout::Split {
            direction: "row".into(),
            children: vec![g("a"), Layout::Split { direction: "column".into(), children: vec![g("b"), g("c")], sizes: vec![2.0, 2.0] }],
            sizes: vec![3.0, 1.0],
        };
        l.normalize();
        assert_eq!(l.sizes_at(&[]).cloned(), Some(vec![0.75, 0.25]));
        assert_eq!(l.sizes_at(&[1]).cloned(), Some(vec![0.5, 0.5]));
        assert!(l.sizes_at(&[0]).is_none());
        assert!(l.sizes_at(&[5]).is_none());
    }
}

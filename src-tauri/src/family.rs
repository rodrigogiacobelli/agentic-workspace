//! The workspace family: a root the owner added by hand, the repositories
//! found directly inside its folder (its children), and the linked worktrees
//! of either that are open as workspaces (its worktree members). The family
//! decides what the selector and the tray list and which list of terminals a
//! member shows. It changes nothing a document may load: that is ADR-015's
//! worktree family, `tree::family`.
//!
//! Placement and discovery run no git. Placement (`normalise`, `row_for`)
//! works from each entry's repository, which `facts` reads from its `.git` on
//! disk, and discovery (`scan`) is one listing of a root's folder (assumption
//! 27). Only `settle` and `summarise` run git, to read summaries: each child's
//! a scan found, and at launch every workspace's.

use crate::credentials::{self, Repository, Top};
use crate::state::{AppState, Session, Workspace};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// What a child's id starts with. v0.4.0 writes ids back unchanged, so a
/// child stays one through it and a scan never makes a second on its folder.
/// No `:`, on which the windows split the keys they keep.
pub const CHILD_MARK: &str = "child-";

pub fn is_child(id: &str) -> bool {
    id.starts_with(CHILD_MARK)
}

/// Whether an entry is a linked worktree. Its repository read from disk
/// says; when that could not be read — its folder, or its repository's, is
/// away — an entry saved under a row keeps its place (WS-22).
fn is_linked(ws: &Workspace) -> bool {
    ws.repository.as_ref().map_or(ws.opened_under.is_some(), |r| r.linked)
}

/// Whether an entry is a root that lists the repositories inside its folder:
/// neither a child (no grandchildren, WS-15) nor a worktree member. A linked
/// worktree whose repository is not open is a root and lists them too (§1).
/// Reads what `normalise` computed.
pub fn scans(ws: &Workspace) -> bool {
    !is_child(&ws.id) && ws.worktree_of.is_none()
}

/// The common git directory a row answers to: its repository's, or where its
/// `.git` would be, so a row whose folder is away still matches its
/// worktrees and a plain folder matches none.
fn common_of(ws: &Workspace) -> PathBuf {
    ws.repository.as_ref().map_or_else(|| ws.path.join(".git"), |r| r.common_dir.clone())
}

/// The repository at the top of `path`, when its `.git` resolves.
pub fn facts(path: &Path) -> Option<Repository> {
    match credentials::repository_at(path) {
        Top::Repository(r) => Some(r),
        Top::Plain | Top::Unresolved => None,
    }
}

/// Reads every entry's repository from its own `.git`, at load: one stat per
/// entry and two small reads per linked worktree.
pub fn read_repositories(session: &mut Session) {
    for ws in session.workspaces.iter_mut() {
        ws.repository = facts(&ws.path);
    }
}

/// The row a linked worktree opened now goes under (assumption 4): `asked`
/// when that is a row on the worktree's repository — the row it was picked
/// from, or the workspace Source Control opened it from — else such a row in
/// the family on screen, else the first in session order (WS-25). `None`
/// leaves it a root of its own.
pub fn row_for(session: &Session, common: &Path, asked: Option<&str>) -> Option<String> {
    let on_repo = |w: &&Workspace| !is_linked(w) && common_of(w) == common;
    let root_of = |id: &str| session.family_root(id).map(|r| r.id.clone());
    let here = session.active.as_deref().and_then(root_of);
    asked
        .and_then(|id| session.workspace(id))
        .filter(on_repo)
        .or_else(|| session.workspaces.iter().filter(on_repo).find(|w| here.is_some() && root_of(&w.id) == here))
        .or_else(|| session.workspaces.iter().find(on_repo))
        .map(|w| w.id.clone())
}

/// Puts every entry in its place: which are children and of which root,
/// which worktree hangs under which row, and the order the selector and the
/// tray list — each root, its worktree members, then each child followed by
/// its own. Every terminal a member holds moves to the end of its root's list
/// with its id, name and directory (TERM-21, TERM-21b); a running shell is
/// keyed by tab, so it goes on untouched. Pure — it reads the repositories
/// the entries carry and does no I/O — so it runs under the session lock on
/// every persist. Idempotent.
///
/// A worktree goes under the row it was saved under, when that is still a
/// row on its repository. With none saved (a file v0.4.0 wrote back), the
/// order this function saves places it again: the row nearest before it,
/// when only worktrees stand between the two, else the first row on its
/// repository — v0.4.0's own rule. The one order this misreads is a
/// worktree v0.4.0 appended right after the later of two rows on one
/// repository, which v0.4.0 listed under the earlier.
pub fn normalise(session: &mut Session) {
    let ws = &session.workspaces;
    let n = ws.len();
    let index: HashMap<&str, usize> = ws.iter().enumerate().map(|(i, w)| (w.id.as_str(), i)).collect();
    let linked: Vec<bool> = ws.iter().map(is_linked).collect();
    let row = |j: usize| !linked[j];

    let common: Vec<PathBuf> = ws.iter().map(common_of).collect();
    let worktree_of: Vec<Option<usize>> = (0..n)
        .map(|i| {
            if !linked[i] {
                return None;
            }
            let known = ws[i].repository.as_ref().map(|r| &r.common_dir);
            let on_repo = |j: usize| row(j) && known.is_none_or(|c| &common[j] == c);
            let saved = ws[i].opened_under.as_deref().and_then(|id| index.get(id).copied()).filter(|&j| on_repo(j));
            saved.or_else(|| {
                known?;
                (0..i).rev().find(|&j| row(j)).filter(|&j| on_repo(j)).or_else(|| (0..n).find(|&j| on_repo(j)))
            })
        })
        .collect();

    let mut root_at: HashMap<&Path, usize> = HashMap::new();
    for i in (0..n).filter(|&i| !is_child(&ws[i].id) && worktree_of[i].is_none()) {
        root_at.entry(ws[i].path.as_path()).or_insert(i);
    }
    // A child whose root is gone — v0.4.0 removed it, or it was a linked
    // worktree that went under its repository's row when that opened
    // (TERM-25) — stands as a root that does not scan, with its tabs and its
    // name, until that folder is a root again.
    let child_of: Vec<Option<usize>> = (0..n)
        .map(|i| (is_child(&ws[i].id) && !linked[i]).then(|| ws[i].path.parent().and_then(|p| root_at.get(p).copied())).flatten())
        .collect();
    let root_of = |i: usize| {
        let row = worktree_of[i].unwrap_or(i);
        child_of[row].unwrap_or(row)
    };

    let ids: Vec<String> = ws.iter().map(|w| w.id.clone()).collect();
    let active = session.active.clone();
    for (i, id) in ids.iter().enumerate() {
        let r = root_of(i);
        if r == i || session.workspaces[i].terminals.is_empty() {
            continue;
        }
        let tabs = std::mem::take(&mut session.workspaces[i].terminals);
        // The tab in front of the member on screen stays in front (TERM-21a).
        let front = session.workspaces[i].active_terminal.take().filter(|f| active.as_deref() == Some(id.as_str()) && tabs.iter().any(|t| &t.id == f));
        let first = tabs.first().map(|t| t.id.clone());
        let root = &mut session.workspaces[r];
        root.terminals.extend(tabs);
        if front.is_some() {
            root.active_terminal = front;
        } else if root.active_terminal.is_none() {
            root.active_terminal = first;
        }
    }
    for (i, w) in session.workspaces.iter_mut().enumerate() {
        if !w.active_terminal.as_deref().is_some_and(|a| w.terminals.iter().any(|t| t.id == a)) {
            w.active_terminal = w.terminals.first().map(|t| t.id.clone());
        }
        w.child_of = child_of[i].map(|j| ids[j].clone());
        w.worktree_of = worktree_of[i].map(|j| ids[j].clone());
        // From here on the placement is saved.
        w.opened_under = w.worktree_of.clone();
    }

    let mut order: Vec<usize> = Vec::with_capacity(n);
    let mut placed = vec![false; n];
    let mut place = |i: usize, order: &mut Vec<usize>| {
        if !std::mem::replace(&mut placed[i], true) {
            order.push(i);
        }
    };
    let rows = &worktree_of;
    let members = |p: usize| (0..n).filter(move |&i| rows[i] == Some(p));
    for r in (0..n).filter(|&i| child_of[i].is_none() && worktree_of[i].is_none()) {
        place(r, &mut order);
        members(r).for_each(|i| place(i, &mut order));
        for c in (0..n).filter(|&i| child_of[i] == Some(r)) {
            place(c, &mut order);
            members(c).for_each(|i| place(i, &mut order));
        }
    }
    // Every entry is one of those; anything a slip above missed keeps its
    // place at the end rather than leave the session.
    (0..n).for_each(|i| place(i, &mut order));
    debug_assert_eq!(order.len(), n);
    let mut slots: Vec<Option<Workspace>> = std::mem::take(&mut session.workspaces).into_iter().map(Some).collect();
    session.workspaces = order.into_iter().filter_map(|i| slots[i].take()).collect();
}

/// What a scan of a root's folder found.
#[derive(Default)]
pub struct Scan {
    /// Children whose folder is there and who hold no summary: new ones, and
    /// ones back from being away. Each needs its summary — its branch and its
    /// worktrees (WS-19) — and a watch on its git directory.
    pub pending: Vec<String>,
    /// What the windows list moved: a child added, gone or back.
    pub changed: bool,
}

/// The repositories of a root's listing that have no child entry yet, in
/// name order (assumption 6): a folder holding a `.git` directory whose name
/// does not start with `.` (assumption 1). `known` holds the folder of every
/// child entry, so one left without its root is taken back, never made twice.
fn new_children(root: &Path, listing: &[(String, bool)], known: &[&Path]) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = listing
        .iter()
        .filter(|(name, repository)| *repository && !name.starts_with('.'))
        .map(|(name, _)| (name.clone(), root.join(name)))
        .filter(|(_, path)| !known.contains(&path.as_path()))
        .collect();
    found.sort();
    found
}

/// Lists the repositories directly inside a root's folder and gives each new
/// one a child entry, with no terminal (WS-12). One `read_dir` and one stat
/// per folder, with the session unlocked, and nothing below the first level
/// (WS-15a). A `.git` file — a linked worktree, a submodule — is not a
/// child, and neither is a symlinked folder: the worktrees git records name
/// the real path, which is not inside the root. A child whose folder has
/// gone is kept (assumption 8), and a root whose folder cannot be read adds
/// nothing (WS-16a). Nor does a root whose `.git` names a repository that
/// cannot be read: it may be a worktree whose repository is away, which goes
/// under that repository's row once it reads, leaving behind any child it
/// had found.
pub fn scan(app: &AppHandle, root_id: &str) -> Scan {
    let state = app.state::<AppState>();
    let path = {
        let session = state.session.lock();
        match session.workspace(root_id) {
            Some(w) if scans(w) => w.path.clone(),
            _ => return Scan::default(),
        }
    };
    let adds = !matches!(credentials::repository_at(&path), Top::Unresolved);
    let Ok(entries) = std::fs::read_dir(&path) else { return Scan::default() };
    let listing: Vec<(String, bool)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .map(|name| {
            let repository = path.join(&name).join(".git").is_dir();
            (name, repository)
        })
        .collect();

    let mut session = state.session.lock();
    if !session.workspace(root_id).is_some_and(|w| w.path == path && scans(w)) {
        return Scan::default();
    }
    let known: Vec<&Path> = session.workspaces.iter().filter(|w| is_child(&w.id)).map(|w| w.path.as_path()).collect();
    let found = if adds { new_children(&path, &listing, &known) } else { Vec::new() };
    let mut scan = Scan { pending: Vec::new(), changed: !found.is_empty() };
    for (name, dir) in found {
        let mut child = Workspace::new(format!("{CHILD_MARK}{}", crate::state::new_id()), dir, name);
        child.repository = Some(Repository { common_dir: child.path.join(".git"), linked: false });
        session.workspaces.push(child);
    }
    normalise(&mut session);
    let git = state.git.lock();
    for w in session.workspaces.iter().filter(|w| w.child_of.as_deref() == Some(root_id)) {
        let there = w.path.file_name().and_then(|n| n.to_str()).is_some_and(|n| listing.iter().any(|(l, _)| l == n));
        scan.changed |= there != w.available;
        if there && !git.contains_key(&w.id) {
            scan.pending.push(w.id.clone());
        }
    }
    scan
}

/// Scans every root, as launch does (assumption 27), the linked worktrees
/// last: one may be a worktree of a repository another root's scan lists,
/// and then it goes under that row before it lists anything of its own.
pub fn scan_roots(app: &AppHandle) {
    let mut roots: Vec<(bool, String)> = app.state::<AppState>().session.lock().workspaces.iter().filter(|w| scans(w)).map(|w| (is_linked(w), w.id.clone())).collect();
    roots.sort_by_key(|(linked, _)| *linked);
    for (_, id) in roots {
        scan(app, &id);
    }
}

/// Reads the summary of each child a scan left pending and watches its git
/// directory, off the caller's thread: that is git, once per child.
pub fn settle(app: &AppHandle, pending: Vec<String>) {
    if pending.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("family-settle".into())
        .spawn(move || {
            if summarise(&app, pending) {
                crate::watch::sync(&app);
                crate::session::publish(&app);
            }
        })
        .ok();
}

/// Reads the summary of each of `ids` on this thread, but not of one another
/// thread is reading — the launch pass, or the settle of a switch a moment
/// ago — so switching among a family's members while launch reads every
/// summary runs git once per child, not once per switch (ADR-018). Every id
/// is claimed before the first git runs. Whether this thread read any.
pub fn summarise(app: &AppHandle, ids: Vec<String>) -> bool {
    let state = app.state::<AppState>();
    let mine: Vec<String> = {
        let mut reading = state.summarising.lock();
        ids.into_iter().filter(|id| reading.insert(id.clone())).collect()
    };
    for id in &mine {
        crate::git::refresh_summary(app, id);
        state.summarising.lock().remove(id);
    }
    !mine.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TerminalTab;

    fn entry(id: &str, path: &str, repository: Option<(&str, bool)>) -> Workspace {
        let mut w = Workspace::new(id.into(), path.into(), path.rsplit('/').next().unwrap_or(path).into());
        w.repository = repository.map(|(common, linked)| Repository { common_dir: common.into(), linked });
        w
    }
    fn tab(id: &str, cwd: &str) -> TerminalTab {
        TerminalTab { id: id.into(), name: None, cwd: cwd.into(), attention: false }
    }
    fn session(workspaces: Vec<Workspace>, active: &str) -> Session {
        Session { workspaces, active: Some(active.into()), ..Session::default() }
    }
    fn order(s: &Session) -> Vec<&str> {
        s.workspaces.iter().map(|w| w.id.as_str()).collect()
    }
    fn of<'a>(s: &'a Session, id: &str) -> &'a Workspace {
        s.workspace(id).unwrap()
    }
    fn tabs(s: &Session, id: &str) -> Vec<String> {
        of(s, id).terminals.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn a_worktree_hangs_under_its_repository_and_its_tabs_join_the_root() {
        let repo = Some(("/r/.git", false));
        let wt = Some(("/r/.git", true));
        let mut w1 = entry("w1", "/wt/w1", wt);
        w1.terminals = vec![tab("agent", "/wt/w1"), tab("build", "/wt/w1")];
        w1.active_terminal = Some("build".into());
        let mut r = entry("r", "/r", repo);
        r.terminals = vec![tab("r1", "/r")];
        r.active_terminal = Some("r1".into());
        // A saved row that is a worktree, or that is gone, falls back to the rule.
        let mut w2 = entry("w2", "/wt/w2", wt);
        w2.opened_under = Some("w1".into());
        let mut w4 = entry("w4", "/wt/w4", wt);
        w4.opened_under = Some("removed".into());
        // R's folder was away at load: W5's `.git` named nothing, and it keeps the row it was saved under.
        let mut w5 = entry("w5", "/wt/w5", None);
        w5.opened_under = Some("r".into());
        // A worktree of a repository that is not open, and a folder inside R.
        let w3 = entry("w3", "/wt/w3", Some(("/q/.git", true)));
        let sub = entry("sub", "/r/sub", None);
        let mut s = session(vec![w1, sub, r, w2, w3, w4, w5], "w1");
        normalise(&mut s);

        for w in ["w1", "w2", "w4", "w5"] {
            assert_eq!(of(&s, w).worktree_of.as_deref(), Some("r"), "{w}");
            assert_eq!(of(&s, w).opened_under.as_deref(), Some("r"), "{w}");
        }
        assert_eq!(of(&s, "w3").worktree_of, None);
        assert_eq!(of(&s, "sub").worktree_of, None);
        assert_eq!(order(&s), ["sub", "r", "w1", "w2", "w4", "w5", "w3"]);
        // The member's tabs end the root's list, the one in front of the member on screen in front.
        assert_eq!(tabs(&s, "r"), ["r1", "agent", "build"]);
        assert_eq!(of(&s, "r").active_terminal.as_deref(), Some("build"));
        assert!(of(&s, "w1").terminals.is_empty() && of(&s, "w1").active_terminal.is_none());

        let once = format!("{:?}", s.workspaces);
        normalise(&mut s);
        assert_eq!(format!("{:?}", s.workspaces), once);
    }

    #[test]
    fn children_are_known_by_their_mark_and_their_roots_folder() {
        let lore = Some(("/c/lore/.git", false));
        let camelot = entry("camelot", "/c", None);
        let a = entry("child-a", "/c/lore", lore);
        let b = entry("child-b", "/c/realm", Some(("/c/realm/.git", false)));
        // The owner's own `lore` on the same folder stays a root.
        let twin = entry("twin", "/c/lore", lore);
        // A child mark two levels down has no root: it stands alone.
        let deep = entry("child-deep", "/c/tools/gen", Some(("/c/tools/gen/.git", false)));
        // A worktree whose repository is not open is a root, and lists what is inside it.
        let linked_root = entry("lr", "/x", Some(("/y/.git", true)));
        let under_linked = entry("child-ul", "/x/k", Some(("/x/k/.git", false)));
        let mut refactor = entry("refactor", "/wt/refactor", Some(("/c/lore/.git", true)));
        refactor.opened_under = Some("child-a".into());
        let mut on_twin = entry("on-twin", "/wt/other", Some(("/c/lore/.git", true)));
        on_twin.opened_under = Some("twin".into());
        let mut s = session(vec![b, twin, on_twin, refactor, deep, camelot, a, linked_root, under_linked], "camelot");
        normalise(&mut s);

        assert_eq!(of(&s, "child-a").child_of.as_deref(), Some("camelot"));
        assert_eq!(of(&s, "child-b").child_of.as_deref(), Some("camelot"));
        assert_eq!(of(&s, "child-ul").child_of.as_deref(), Some("lr"));
        for alone in ["twin", "child-deep", "lr"] {
            assert_eq!(of(&s, alone).child_of, None, "{alone}");
        }
        assert_eq!(of(&s, "refactor").worktree_of.as_deref(), Some("child-a"));
        assert_eq!(of(&s, "on-twin").worktree_of.as_deref(), Some("twin"));
        assert_eq!(order(&s), ["twin", "on-twin", "child-deep", "camelot", "child-b", "child-a", "refactor", "lr", "child-ul"]);
        assert_eq!(s.family_root("refactor").map(|r| r.id.as_str()), Some("camelot"));
        let mut under = s.listed_under("camelot");
        under.sort();
        assert_eq!(under, ["child-a", "child-b", "refactor"]);

        // Its repository opens: the worktree goes under it and its child stands alone, kept.
        s.workspaces.push(entry("y", "/y", Some(("/y/.git", false))));
        normalise(&mut s);
        assert_eq!(of(&s, "lr").worktree_of.as_deref(), Some("y"));
        assert_eq!(of(&s, "child-ul").child_of, None);
        assert!(!scans(of(&s, "lr")) && !scans(of(&s, "child-ul")));
        assert_eq!(&order(&s)[6..], ["refactor", "child-ul", "y", "lr"]);
    }

    #[test]
    fn a_session_v0_4_0_saved_back_reads_as_the_same_tree() {
        let lore = Some(("/c/lore/.git", false));
        let camelot = entry("camelot", "/c", None);
        let mut a = entry("child-a", "/c/lore", lore);
        a.name = "Lore docs".into();
        let b = entry("child-b", "/c/realm", Some(("/c/realm/.git", false)));
        let twin = entry("twin", "/c/lore", lore);
        let mut refactor = entry("refactor", "/wt/refactor", Some(("/c/lore/.git", true)));
        refactor.opened_under = Some("child-a".into());
        let mut on_twin = entry("on-twin", "/wt/other", Some(("/c/lore/.git", true)));
        on_twin.opened_under = Some("twin".into());
        let mut camelot = camelot;
        camelot.terminals = vec![tab("c1", "/c")];
        let mut s = session(vec![twin, on_twin, camelot, b, a, refactor], "refactor");
        normalise(&mut s);
        let tree = |s: &Session| s.workspaces.iter().map(|w| (w.id.clone(), w.name.clone(), w.child_of.clone(), w.worktree_of.clone())).collect::<Vec<_>>();
        let before = tree(&s);

        // What v0.4.0 writes back: no `openedUnder` or `childOf`, and a tab it added under the worktree.
        let mut json = serde_json::to_value(&s).unwrap();
        for w in json["workspaces"].as_array_mut().unwrap() {
            let w = w.as_object_mut().unwrap();
            w.remove("openedUnder");
            w.remove("childOf");
            if w["id"] == "refactor" {
                w.insert("terminals".into(), serde_json::json!([{ "id": "build", "cwd": "/wt/refactor" }]));
            }
        }
        let mut back: Session = serde_json::from_value(json).unwrap();
        // The repositories are never saved; load reads them from disk again.
        for w in back.workspaces.iter_mut() {
            w.repository = s.workspace(&w.id).and_then(|o| o.repository.clone());
        }
        normalise(&mut back);

        assert_eq!(tree(&back), before);
        assert_eq!(tabs(&back, "camelot"), ["c1", "build"]);
        let mut ids: Vec<&str> = back.workspaces.iter().flat_map(|w| std::iter::once(w.id.as_str()).chain(w.terminals.iter().map(|t| t.id.as_str()))).collect();
        let all = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), all);
    }

    #[test]
    fn a_scan_adds_new_repositories_in_name_order_and_never_twice() {
        let listing: Vec<(String, bool)> = [("realm", true), (".hidden", true), ("notes", false), ("citadel", true), ("lore", true), ("realm-deploy", true)]
            .iter()
            .map(|(n, r)| (n.to_string(), *r))
            .collect();
        let known = [Path::new("/c/lore")];
        let names: Vec<String> = new_children(Path::new("/c"), &listing, &known).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["citadel", "realm", "realm-deploy"]);
    }
}

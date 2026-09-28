//! Session state: the workspace list, and the one function that publishes it.

use crate::pty;
use crate::state::{AppState, Area, DiffSpec, EditorGroup, EditorTab, Layout, Session, TerminalTab, Workspace};
use crate::store;
use crate::tree;
use crate::watch;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_CHANGED: &str = "session-changed";
pub const EVENT_NOTICE: &str = "notice";
pub const EVENT_INFO: &str = "notice-info";
const RECENT_FILES_MAX: usize = 50;

/// Refreshes the parts of the session only the machine knows — terminal
/// working directories, whether each workspace directory exists — and writes
/// the file. Returns the snapshot it wrote.
pub fn persist(app: &AppHandle) -> Session {
    let state = app.state::<AppState>();
    // A readlink per shell is the slow half of this function, and `ptys` is
    // the lock a keystroke needs. Take the pids under it and let it go, then
    // read `/proc` with nothing held (PERF-05).
    let pids: Vec<(String, u32)> = {
        let ptys = state.ptys.lock();
        ptys.iter().filter_map(|(id, live)| live.pid.map(|pid| (id.clone(), pid))).collect()
    };
    let cwds: HashMap<String, PathBuf> = pids
        .into_iter()
        .filter_map(|(id, pid)| std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|cwd| (id, cwd)))
        .collect();
    let (snapshot, moved) = {
        let mut session = state.session.lock();
        let mut attention = state.attention.lock();
        let git = state.git.lock();
        let active = session.active.clone();
        // The open workspace on each repository, by its common git directory:
        // the first in session order that is not a linked worktree.
        let mut repositories: HashMap<PathBuf, String> = HashMap::new();
        for ws in session.workspaces.iter() {
            if let Some(common) = git.get(&ws.id).filter(|g| g.is_repo && !g.is_worktree).and_then(|g| g.common_dir.clone()) {
                repositories.entry(common).or_insert_with(|| ws.id.clone());
            }
        }
        let mut foreground = None;
        for ws in session.workspaces.iter_mut() {
            ws.ensure_groups();
            ws.available = ws.path.is_dir();
            ws.git = git.get(&ws.id).cloned();
            ws.worktree_of = ws
                .git
                .as_ref()
                .filter(|g| g.is_worktree)
                .and_then(|g| g.common_dir.as_ref())
                .and_then(|c| repositories.get(c))
                .cloned();
            // The tab on screen cannot need attention.
            if active.as_deref() == Some(&ws.id) {
                if let Some(t) = ws.active_terminal.as_deref() {
                    attention.remove(t);
                    foreground = Some(t.to_string());
                }
            }
            ws.attention = false;
            for tab in ws.terminals.iter_mut() {
                if let Some(cwd) = cwds.get(&tab.id) {
                    tab.cwd = cwd.clone();
                }
                tab.attention = attention.contains(&tab.id);
                ws.attention |= tab.attention;
            }
        }
        let mut current = state.foreground.lock();
        let moved = *current != foreground;
        *current = foreground;
        drop(current);
        (session.clone(), moved)
    };
    if moved {
        pty::show(&state);
    }
    if let Err(e) = store::save(&state.data_dir, &snapshot) {
        notice(app, format!("Could not save the session: {e:#}"));
    }
    snapshot
}

/// The only writer of every surface that shows session state. A snapshot the
/// windows already hold is not sent again: each one re-renders both windows
/// whole. A window that loads later reads `get_session`.
pub fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut published = state.published.lock();
        let snapshot = persist(app);
        if let Ok(text) = serde_json::to_string(&snapshot) {
            if *published != text {
                let _ = app.emit_str(EVENT_CHANGED, text.clone());
                *published = text;
            }
        }
    }
    // Outside the lock: the tray waits on the main thread, which may itself
    // be waiting to publish.
    crate::tray::refresh(app);
}

/// A message for the user that has no command to return through.
pub fn notice(app: &AppHandle, message: String) {
    eprintln!("agentic-workspace: {message}");
    if app.emit(EVENT_NOTICE, &message).is_err() {
        app.state::<AppState>().notices.lock().push(message);
    }
}

/// A notice that dismisses itself, such as ssh asking for a touch of a
/// security key. One no window heard is dropped rather than kept: it is
/// stale by the time a window shows it.
pub fn inform(app: &AppHandle, message: String) {
    eprintln!("agentic-workspace: {message}");
    let _ = app.emit(EVENT_INFO, &message);
}

/// The new name of `path` after `from` became `to`, or `None` when the move
/// did not touch it. A directory carries everything under it.
fn moved(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    path.strip_prefix(from)
        .filter(|rest| rest.starts_with('/'))
        .map(|rest| format!("{to}{rest}"))
}

/// A file or directory moved inside the workspace: every open tab, recent file
/// and view entry naming it names where it went instead, and the unsaved draft
/// of each moved tab goes with it.
///
/// The session is the only record of what is open, so doing this here reaches
/// tabs in every group of both working areas, whether or not one is on screen.
/// A tab left on the old path would show the file as deleted the moment the
/// watcher reported the directory.
pub fn relocate(app: &AppHandle, workspace_id: &str, from: &str, to: &str) {
    if from == to {
        return;
    }
    let state = app.state::<AppState>();
    let mut session = state.session.lock();
    let Some(ws) = session.workspace_mut(workspace_id) else { return };
    let root = ws.path.clone();
    let mut changed = false;
    for group in ws.editor.groups.iter_mut().chain(ws.review.groups.iter_mut()) {
        for tab in group.editors.iter_mut() {
            let Some(next) = moved(&tab.path, from, to) else { continue };
            crate::files::move_draft(&state, &root.join(&tab.path), &root.join(&next));
            tab.path = next;
            changed = true;
        }
    }
    for path in ws.recent_files.iter_mut() {
        if let Some(next) = moved(path, from, to) {
            *path = next;
            changed = true;
        }
    }
    for view in ws.views.iter_mut() {
        for entry in view.entries.iter_mut() {
            if let Some(next) = moved(entry, from, to) {
                *entry = next;
                changed = true;
            }
        }
    }
    // A renamed directory keeps whatever the tree had open under it; left
    // alone, the old name stays expanded forever and the new one arrives shut.
    for dir in ws.expanded.iter_mut() {
        if let Some(next) = moved(dir, from, to) {
            *dir = next;
            changed = true;
        }
    }
    drop(session);
    if changed {
        // The moved tabs are in new directories, and those are what the
        // watcher has to be looking at now.
        watch::sync(app);
        publish(app);
    }
}

/// Drops workspaces the selector opened from a worktree whose directory has
/// since gone. Nothing the user named by hand is touched, and the one on
/// screen is never pulled out from under them: a worktree removed while its
/// workspace is active keeps the "unavailable" mark instead.
///
/// This is the other half of detection. A worktree that appears is offered
/// without being added; one that disappears takes its workspace with it.
pub fn prune_worktrees(app: &AppHandle) {
    let state = app.state::<AppState>();
    let gone: Vec<(String, String)> = {
        let session = state.session.lock();
        session
            .workspaces
            .iter()
            .filter(|w| w.from_worktree && !w.path.is_dir() && session.active.as_deref() != Some(&w.id))
            .map(|w| (w.id.clone(), w.name.clone()))
            .collect()
    };
    for (id, name) in gone {
        notice(app, format!("Closed workspace \"{name}\": its worktree is gone."));
        drop_workspace(app, &state, &id);
    }
}

/// Takes a workspace out of the session and hangs up its shells, putting the
/// most recent one in its place if it was the one on screen.
fn drop_workspace(app: &AppHandle, state: &AppState, id: &str) {
    let next = {
        let mut session = state.session.lock();
        let Some(pos) = session.workspaces.iter().position(|w| w.id == id) else { return };
        let removed = session.workspaces.remove(pos);
        session.recent.retain(|r| r != id);
        let mut ptys = state.ptys.lock();
        for tab in &removed.terminals {
            if let Some(mut live) = ptys.remove(&tab.id) {
                live.hangup();
            }
            crate::agent::forget(state, &tab.id);
        }
        drop(ptys);
        state.git.lock().remove(id);
        if session.active.as_deref() == Some(id) {
            session.active = None;
            session.recent.first().cloned()
        } else {
            None
        }
    };
    match next {
        Some(next) => {
            if let Err(e) = activate(app, &next) {
                notice(app, format!("Could not open the next workspace: {e:#}"));
            }
        }
        None => watch::sync(app),
    }
}

/// Reorders `items` to follow `ids`; items not named keep their relative order
/// at the end, so a stale list from the view cannot drop anything.
pub fn reorder<T>(items: &mut Vec<T>, ids: &[String], id_of: impl Fn(&T) -> &str) {
    let mut ordered: Vec<T> = Vec::with_capacity(items.len());
    for id in ids {
        if let Some(pos) = items.iter().position(|t| id_of(t) == id) {
            ordered.push(items.remove(pos));
        }
    }
    ordered.append(items);
    *items = ordered;
}

pub fn activate(app: &AppHandle, id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    // The shells start before the workspace is made active: any publish from
    // then on may carry it, and the Terminal window attaches to the terminals
    // of the active workspace as soon as it hears.
    let spawned = pty::ensure_live(app, id);
    {
        let mut session = state.session.lock();
        if session.workspace(id).is_none() {
            anyhow::bail!("no workspace {id}");
        }
        session.active = Some(id.to_string());
        session.recent.retain(|r| r != id);
        session.recent.insert(0, id.to_string());
    }
    // The shells started before the summary was in, so their terminal
    // configuration was resolved from the files git keeps; once `persist`
    // has matched the worktree to its repository, it is resolved again.
    if crate::git::refresh_summary(app, id) {
        persist(app);
        crate::credentials::write_terminal_configs(app);
    }
    watch::sync(app);
    // Every way a workspace comes to the screen — the selector, the tray, a
    // notification, the removal of the one before it — passes through here.
    watch::catch_up(app, id);
    spawned
}

#[tauri::command]
pub fn get_session(app: AppHandle) -> Session {
    persist(&app)
}

#[tauri::command]
pub fn take_notices(state: tauri::State<AppState>) -> Vec<String> {
    std::mem::take(&mut *state.notices.lock())
}

/// Opens a folder as a workspace, or switches to the one already on it.
/// `from_worktree` marks a workspace the selector derived from a repository's
/// worktree list rather than one the user named.
#[tauri::command]
pub fn add_workspace(app: AppHandle, state: tauri::State<AppState>, path: String, name: Option<String>, from_worktree: Option<bool>) -> Result<String, String> {
    let path = PathBuf::from(path);
    let path = std::fs::canonicalize(&path)
        .with_context(|| format!("resolving {}", path.display()))
        .map_err(|e| format!("{e:#}"))?;
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let id = {
        let mut session = state.session.lock();
        match session.workspaces.iter().find(|w| w.path == path) {
            Some(existing) => existing.id.clone(),
            None => {
                let id = crate::state::new_id();
                let terminal = crate::state::new_id();
                let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.display().to_string())
                });
                session.workspaces.push(Workspace {
                    id: id.clone(),
                    path: path.clone(),
                    name,
                    terminals: vec![TerminalTab { id: terminal.clone(), name: None, cwd: path.clone(), attention: false }],
                    active_terminal: Some(terminal),
                    editor: Area::default(),
                    review: Area::default(),
                    mode: "editor".into(),
                    split_ratio: 0.5,
                    editors: Vec::new(),
                    active_editor: None,
                    expanded: Vec::new(),
                    recent_files: Vec::new(),
                    views: Vec::new(),
                    active_view: None,
                    available: true,
                    attention: false,
                    git: None,
                    from_worktree: from_worktree.unwrap_or(false),
                    worktree_of: None,
                });
                id
            }
        }
    };
    let result = activate(&app, &id).map_err(|e| format!("{e:#}"));
    publish(&app);
    result.map(|_| id)
}

/// Off the main thread: `activate` runs git and may start shells, and the
/// main thread is the one delivering key presses.
#[tauri::command(async)]
pub fn switch_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let result = activate(&app, &id).map_err(|e| format!("{e:#}"));
    publish(&app);
    result
}

/// Which mode the Workspace window shows for a workspace. Terminal is a mode
/// as well, but it lives in a window of its own, so it is never stored here.
#[tauri::command]
pub fn set_mode(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, mode: String) -> Result<(), String> {
    if !["editor", "scm"].contains(&mode.as_str()) {
        return Err(format!("no mode {mode}"));
    }
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        ws.mode = mode;
    }
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let next = {
        let mut session = state.session.lock();
        let Some(pos) = session.workspaces.iter().position(|w| w.id == id) else {
            return Err(format!("no workspace {id}"));
        };
        let removed = session.workspaces.remove(pos);
        session.recent.retain(|r| r != &id);
        let mut ptys = state.ptys.lock();
        for tab in &removed.terminals {
            if let Some(mut live) = ptys.remove(&tab.id) {
                live.hangup();
            }
            crate::agent::forget(&state, &tab.id);
        }
        state.git.lock().remove(&id);
        if session.active.as_deref() == Some(&id) {
            session.active = None;
            session.recent.first().cloned()
        } else {
            None
        }
    };
    let result = match &next {
        Some(next) => activate(&app, next).map_err(|e| format!("{e:#}")),
        None => {
            watch::sync(&app);
            Ok(())
        }
    };
    publish(&app);
    // Takes the removed workspace's include file away, so a shell that
    // outlived the hangup — tmux, a disowned job — loses its credentials.
    crate::credentials::write_terminal_configs(&app);
    result
}

/// Reorders the workspace list (WS-11). The frontend names every id, each
/// top-level row followed by its worktrees, so the switcher's grouping and
/// the session's order stay one order.
#[tauri::command]
pub fn reorder_workspaces(app: AppHandle, state: tauri::State<AppState>, ids: Vec<String>) {
    reorder(&mut state.session.lock().workspaces, &ids, |w| &w.id);
    publish(&app);
}

#[tauri::command]
pub fn rename_workspace(app: AppHandle, state: tauri::State<AppState>, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a workspace needs a name".into());
    }
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&id).ok_or_else(|| format!("no workspace {id}"))?;
        ws.name = name;
    }
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn set_expanded(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String, expanded: bool) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            ws.expanded.retain(|p| p != &path);
            if expanded {
                ws.expanded.push(path);
            }
        }
    }
    watch::sync(&app);
    publish(&app);
}

/// The mode a new tab opens in: the configured one for markdown, source for
/// everything else.
fn default_mode(state: &AppState, path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx") {
        let mode = state.settings.lock().markdown_mode.clone();
        if ["source", "split", "rich"].contains(&mode.as_str()) { mode } else { "source".into() }
    } else {
        "source".into()
    }
}

/// Puts `tab` into `group` and makes it active. A preview tab replaces the
/// group's existing preview tab in place; a permanent one is appended.
fn place_tab(group: &mut EditorGroup, tab: EditorTab) -> String {
    let id = tab.id.clone();
    if tab.preview {
        if let Some(i) = group.editors.iter().position(|e| e.preview) {
            group.editors[i] = tab;
            group.active_editor = Some(id.clone());
            return id;
        }
    }
    group.editors.push(tab);
    group.active_editor = Some(id.clone());
    id
}

/// Opens a file in the Editor's active group, or focuses the tab already
/// showing it there. A preview open (a single click) reuses the group's
/// preview tab; a permanent open makes an existing preview tab permanent.
#[tauri::command]
pub fn open_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String, preview: bool) -> Result<String, String> {
    let id = {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let group = ws.editor.active_group_mut();
        let id = match group.editors.iter_mut().find(|e| e.path == path) {
            Some(tab) => {
                if !preview {
                    tab.preview = false;
                }
                let id = tab.id.clone();
                group.active_editor = Some(id.clone());
                id
            }
            None => {
                let mode = default_mode(&state, &path);
                place_tab(group, EditorTab { id: crate::state::new_id(), path: path.clone(), mode, line: 0, diff: None, preview })
            }
        };
        ws.recent_files.retain(|p| p != &path);
        ws.recent_files.insert(0, path);
        ws.recent_files.truncate(RECENT_FILES_MAX);
        id
    };
    watch::sync(&app);
    publish(&app);
    Ok(id)
}

/// Opens a diff of a path in Source Control's active group, or focuses the
/// tab already showing that diff there. A status diff is a preview tab; a
/// commit's diff is permanent, since it was asked for by name. The directory
/// is watched from here on, so the diff follows the file as it changes.
#[tauri::command]
pub fn open_diff(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String, diff: DiffSpec) -> Result<String, String> {
    let id = {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let group = ws.review.active_group_mut();
        match group.editors.iter().find(|e| e.path == path && e.diff.as_ref() == Some(&diff)) {
            Some(tab) => {
                let id = tab.id.clone();
                group.active_editor = Some(id.clone());
                id
            }
            None => {
                let preview = diff.kind != "commit";
                place_tab(group, EditorTab { id: crate::state::new_id(), path, mode: "source".into(), line: 0, diff: Some(diff), preview })
            }
        }
    };
    watch::sync(&app);
    publish(&app);
    Ok(id)
}

/// Makes a preview tab permanent: it was edited, double-clicked or dragged.
#[tauri::command]
pub fn pin_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    let changed = {
        let mut session = state.session.lock();
        session
            .workspace_mut(&workspace_id)
            .and_then(|ws| ws.area_of_editor_mut(&id))
            .and_then(|a| a.group_of_editor_mut(&id))
            .and_then(|g| g.editors.iter_mut().find(|e| e.id == id))
            .map(|tab| std::mem::replace(&mut tab.preview, false))
            .unwrap_or(false)
    };
    if changed {
        publish(&app);
    }
}

/// Records how a tab is being viewed. Saved, not broadcast: scrolling is not
/// something another window needs to hear about.
#[tauri::command]
pub fn set_editor_view(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String, mode: String, line: u32) {
    {
        let mut session = state.session.lock();
        if let Some(tab) = session
            .workspace_mut(&workspace_id)
            .and_then(|ws| ws.area_of_editor_mut(&id))
            .and_then(|a| a.group_of_editor_mut(&id))
            .and_then(|g| g.editors.iter_mut().find(|e| e.id == id))
        {
            tab.mode = mode;
            tab.line = line;
        }
    }
    persist(&app);
}

/// Closes a tab; a group left empty closes itself unless it is the last one
/// of its working area, and the layout collapses around it.
#[tauri::command]
pub fn close_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        if let Some(area) = session.workspace_mut(&workspace_id).and_then(|ws| ws.area_of_editor_mut(&id)) {
            if let Some(group) = area.group_of_editor_mut(&id) {
                let index = group.editors.iter().position(|e| e.id == id).unwrap_or(0);
                group.editors.retain(|e| e.id != id);
                if group.active_editor.as_deref() == Some(&id) {
                    let next = index.min(group.editors.len().saturating_sub(1));
                    group.active_editor = group.editors.get(next).map(|e| e.id.clone());
                }
            }
            area.prune_groups();
        }
    }
    watch::sync(&app);
    publish(&app);
}

/// A click on the tab already active changes nothing and publishes nothing.
#[tauri::command]
pub fn set_active_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        let Some(area) = session.workspace_mut(&workspace_id).and_then(|ws| ws.area_of_editor_mut(&id)) else { return };
        let Some(group) = area.group_of_editor_mut(&id) else { return };
        let group_id = group.id.clone();
        let was = group.active_editor.replace(id.clone());
        if was.as_deref() == Some(id.as_str()) && area.active_group.as_deref() == Some(group_id.as_str()) {
            return;
        }
        area.active_group = Some(group_id);
    }
    publish(&app);
}

#[tauri::command]
pub fn set_active_group(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, group_id: String) {
    {
        let mut session = state.session.lock();
        let Some(area) = session.workspace_mut(&workspace_id).and_then(|ws| ws.area_of_group_mut(&group_id)) else { return };
        if area.active_group.as_deref() == Some(group_id.as_str()) {
            return;
        }
        area.active_group = Some(group_id);
    }
    publish(&app);
}

/// Reorders a group's tabs. A tab dragged to a new position arrives
/// permanent (ED-33).
#[tauri::command]
pub fn reorder_editors(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, group_id: String, ids: Vec<String>, moved: Option<String>) {
    {
        let mut session = state.session.lock();
        if let Some(group) = session
            .workspace_mut(&workspace_id)
            .and_then(|ws| ws.area_of_group_mut(&group_id))
            .and_then(|a| a.group_mut(&group_id))
        {
            reorder(&mut group.editors, &ids, |e| &e.id);
            if let Some(tab) = moved.and_then(|m| group.editors.iter_mut().find(|e| e.id == m)) {
                tab.preview = false;
            }
        }
    }
    publish(&app);
}

/// The working area a command names: `editor`, which is the default, or
/// `review`, Source Control's.
fn area_named<'a>(ws: &'a mut Workspace, name: Option<&str>) -> Result<&'a mut Area, String> {
    match name.unwrap_or("editor") {
        "editor" => Ok(&mut ws.editor),
        "review" => Ok(&mut ws.review),
        other => Err(format!("no working area {other}")),
    }
}

/// A new group beside `beside`, split off in `direction` (`row` or `column`),
/// after it unless `before`.
fn add_group(area: &mut Area, beside: &str, direction: &str, before: bool, editors: Vec<EditorTab>) -> String {
    area.ensure_groups();
    let id = crate::state::new_id();
    let active_editor = editors.first().map(|e| e.id.clone());
    area.groups.push(EditorGroup { id: id.clone(), editors, active_editor });
    if let Some(l) = area.layout.as_mut() {
        if !l.split_leaf(beside, direction, &id, before) {
            // The leaf named is gone; the new group joins the root row.
            let old = std::mem::replace(l, Layout::Group { id: String::new() });
            *l = Layout::Split { direction: "row".into(), children: vec![old, Layout::Group { id: id.clone() }], sizes: vec![0.5, 0.5] };
        }
    }
    area.active_group = Some(id.clone());
    id
}

/// Opens a second group to the right of the active one showing the same tab,
/// so two views — or two files — sit side by side (ED-42). `area` is
/// `editor`, the default, or `review` for Source Control's diffs.
#[tauri::command]
pub fn split_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, area: Option<String>) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let area = area_named(ws, area.as_deref())?;
        area.ensure_groups();
        let beside = area.active_group.clone().unwrap_or_default();
        let tab = {
            let active = area.active_group_mut();
            active.active_editor.as_deref().and_then(|id| active.editors.iter().find(|e| e.id == id)).cloned()
        };
        let editors = tab.map(|t| vec![EditorTab { id: crate::state::new_id(), path: t.path, mode: t.mode, line: t.line, diff: t.diff, preview: false }]).unwrap_or_default();
        add_group(area, &beside, "row", false, editors);
    }
    watch::sync(&app);
    publish(&app);
    Ok(())
}

/// Takes a tab out of its group, keeping its id so its editor state travels.
fn take_tab(area: &mut Area, id: &str) -> Option<EditorTab> {
    let from = area.group_of_editor_mut(id)?;
    let pos = from.editors.iter().position(|e| e.id == id)?;
    let mut tab = from.editors.remove(pos);
    tab.preview = false;
    if from.active_editor.as_deref() == Some(id) {
        from.active_editor = from.editors.get(pos.min(from.editors.len().saturating_sub(1))).map(|e| e.id.clone());
    }
    Some(tab)
}

/// Moves a tab into another group of its own working area, or into a new
/// group to the right of its own when `group_id` is empty. The tab arrives
/// permanent. A tab never crosses between the Editor and Source Control.
#[tauri::command]
pub fn move_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String, group_id: String, index: Option<usize>) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let area = ws.area_of_editor_mut(&id).ok_or_else(|| format!("no editor {id}"))?;
        // Checked before the tab is taken, so a refused move loses nothing.
        if !group_id.is_empty() && !area.holds_group(&group_id) {
            return Err(format!("no group {group_id} in the working area of {id}"));
        }
        let beside = area.group_of_editor_mut(&id).map(|g| g.id.clone()).unwrap_or_default();
        let tab = take_tab(area, &id).ok_or("no such tab")?;
        if group_id.is_empty() {
            add_group(area, &beside, "row", false, vec![tab]);
        } else if let Some(group) = area.group_mut(&group_id) {
            let at = index.unwrap_or(group.editors.len()).min(group.editors.len());
            group.editors.insert(at, tab);
            group.active_editor = Some(id);
            area.active_group = Some(group_id);
        }
        area.prune_groups();
    }
    publish(&app);
    Ok(())
}

/// What a drop carries: a tab by id, or a file by workspace-relative path.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropSource {
    #[serde(default)]
    pub editor: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

/// A tab or file dropped on a group: on its centre it joins the group, on an
/// edge it opens a new group split off on that side (ED-36, ED-37, ED-41). A
/// tab only lands in its own working area, and Source Control's takes no
/// files.
#[tauri::command]
pub fn drop_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, source: DropSource, target: String, zone: String, index: Option<usize>) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let review = ws.review.holds_group(&target);
        if !review && !ws.editor.holds_group(&target) {
            return Err(format!("no group {target}"));
        }
        let area = if review { &mut ws.review } else { &mut ws.editor };
        let tab = match (&source.editor, &source.path) {
            (Some(id), _) => take_tab(area, id).ok_or_else(|| format!("no editor {id} in the working area of {target}"))?,
            (None, Some(_)) if review => return Err("Source Control shows diffs; open files in the Editor".into()),
            (None, Some(path)) => EditorTab { id: crate::state::new_id(), path: path.clone(), mode: default_mode(&state, path), line: 0, diff: None, preview: false },
            (None, None) => return Err("nothing to drop".into()),
        };
        let id = tab.id.clone();
        let (direction, before) = match zone.as_str() {
            "left" => ("row", true),
            "right" => ("row", false),
            "top" => ("column", true),
            "bottom" => ("column", false),
            _ => ("", false),
        };
        if direction.is_empty() {
            // Taking a tab never removes a group, so the target checked above
            // is still there.
            if let Some(group) = area.group_mut(&target) {
                if let Some(existing) = group.editors.iter().find(|e| e.path == tab.path && e.diff == tab.diff && e.id != tab.id).map(|e| e.id.clone()) {
                    group.active_editor = Some(existing);
                } else {
                    let at = index.unwrap_or(group.editors.len()).min(group.editors.len());
                    group.editors.insert(at, tab);
                    group.active_editor = Some(id);
                }
            }
            area.active_group = Some(target);
        } else {
            add_group(area, &target, direction, before, vec![tab]);
        }
        area.prune_groups();
        if let Some(path) = &source.path {
            ws.recent_files.retain(|p| p != path);
            ws.recent_files.insert(0, path.clone());
            ws.recent_files.truncate(RECENT_FILES_MAX);
        }
    }
    watch::sync(&app);
    publish(&app);
    Ok(())
}

/// Records the sizes of one split of a working area — `editor`, the default,
/// or `review` — after its divider was dragged (ED-39).
#[tauri::command]
pub fn set_layout_sizes(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, area: Option<String>, path: Vec<usize>, sizes: Vec<f32>) {
    {
        let mut session = state.session.lock();
        if let Some(l) = session
            .workspace_mut(&workspace_id)
            .and_then(|ws| area_named(ws, area.as_deref()).ok())
            .and_then(|a| a.layout.as_mut())
        {
            if let Some(target) = l.sizes_at(&path).filter(|t| t.len() == sizes.len()) {
                *target = sizes;
            }
            l.normalize();
        }
    }
    persist(&app);
}

// --- Custom views ------------------------------------------------------------

fn with_view<T>(state: &AppState, workspace_id: &str, view_id: &str, f: impl FnOnce(&mut crate::state::View) -> T) -> Result<T, String> {
    let mut session = state.session.lock();
    let ws = session.workspace_mut(workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
    let view = ws.views.iter_mut().find(|v| v.id == view_id).ok_or_else(|| format!("no view {view_id}"))?;
    Ok(f(view))
}

#[tauri::command]
pub fn view_create(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a view needs a name".into());
    }
    let id = {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        if ws.views.iter().any(|v| v.name == name) {
            return Err(format!("a view named {name} already exists"));
        }
        let id = crate::state::new_id();
        ws.views.push(crate::state::View { id: id.clone(), name, entries: Vec::new() });
        ws.active_view = Some(id.clone());
        id
    };
    publish(&app);
    Ok(id)
}

#[tauri::command]
pub fn view_rename(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a view needs a name".into());
    }
    with_view(&state, &workspace_id, &view_id, |v| v.name = name)?;
    publish(&app);
    Ok(())
}

/// Deletes the list only; every file it pointed at is untouched (VIEW-10).
#[tauri::command]
pub fn view_delete(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: String) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        ws.views.retain(|v| v.id != view_id);
        if ws.active_view.as_deref() == Some(&view_id) {
            ws.active_view = None;
        }
    }
    publish(&app);
    Ok(())
}

/// Adds a workspace-relative path to a view; a path already there is left
/// where it is.
#[tauri::command]
pub fn view_add(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: String, path: String) -> Result<(), String> {
    tree::resolve(&state, &workspace_id, &path).map_err(|e| format!("{e:#}"))?;
    let path = path.trim_matches('/').to_string();
    if path.is_empty() {
        return Err("the workspace root cannot be sent to a view".into());
    }
    with_view(&state, &workspace_id, &view_id, |v| {
        if !v.entries.contains(&path) {
            v.entries.push(path);
        }
    })?;
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn view_remove(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: String, path: String) -> Result<(), String> {
    with_view(&state, &workspace_id, &view_id, |v| v.entries.retain(|e| e != &path))?;
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn view_reorder(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: String, paths: Vec<String>) -> Result<(), String> {
    with_view(&state, &workspace_id, &view_id, |v| reorder(&mut v.entries, &paths, |p| p.as_str()))?;
    publish(&app);
    Ok(())
}

/// Which view the Custom panel shows; `None` for the first there is (VIEW-09).
#[tauri::command]
pub fn set_active_view(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, view_id: Option<String>) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            ws.active_view = view_id.filter(|id| ws.views.iter().any(|v| &v.id == id));
        }
    }
    publish(&app);
}

/// Raises a window at its remembered geometry. Under Wayland the compositor
/// decides whether to honour the focus; from a focused window of the same
/// application it does.
#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    crate::windows::show(&app, &label).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    for label in crate::windows::LABELS {
        crate::windows::record(&app, label);
    }
    crate::windows::save(&app);
    persist(&app);
    pty::shutdown(&app);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::moved;

    #[test]
    fn a_move_takes_the_path_and_everything_under_it_and_nothing_beside_it() {
        assert_eq!(moved("notes.md", "notes.md", "journal.md").as_deref(), Some("journal.md"));
        assert_eq!(moved("docs/a.md", "docs", "guide").as_deref(), Some("guide/a.md"));
        assert_eq!(moved("docs/deep/a.md", "docs", "guide").as_deref(), Some("guide/deep/a.md"));
        // A name that merely starts with the old one is a different file.
        assert_eq!(moved("docs-old/a.md", "docs", "guide"), None);
        assert_eq!(moved("documents", "doc", "guide"), None);
        assert_eq!(moved("other/a.md", "docs", "guide"), None);
        // Into a subdirectory of itself is git's problem, not this function's.
        assert_eq!(moved("docs/a.md", "docs", "docs/old").as_deref(), Some("docs/old/a.md"));
    }
}

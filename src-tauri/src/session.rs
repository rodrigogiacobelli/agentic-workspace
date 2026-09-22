//! Session state: the workspace list, and the one function that publishes it.

use crate::pty;
use crate::state::{AppState, DiffSpec, EditorGroup, EditorTab, Session, TerminalTab, Workspace};
use crate::store;
use crate::watch;
use anyhow::{Context, Result};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_CHANGED: &str = "session-changed";
pub const EVENT_NOTICE: &str = "notice";
const RECENT_FILES_MAX: usize = 50;

/// Refreshes the parts of the session only the machine knows — terminal
/// working directories, whether each workspace directory exists — and writes
/// the file. Returns the snapshot it wrote.
pub fn persist(app: &AppHandle) -> Session {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut session = state.session.lock();
        let ptys = state.ptys.lock();
        let mut attention = state.attention.lock();
        let git = state.git.lock();
        let active = session.active.clone();
        for ws in session.workspaces.iter_mut() {
            ws.ensure_groups();
            ws.available = ws.path.is_dir();
            ws.git = git.get(&ws.id).cloned();
            // The tab on screen cannot need attention.
            if active.as_deref() == Some(&ws.id) {
                if let Some(t) = ws.active_terminal.as_deref() {
                    attention.remove(t);
                }
            }
            ws.attention = false;
            for tab in ws.terminals.iter_mut() {
                if let Some(cwd) = ptys.get(&tab.id).and_then(|live| live.cwd()) {
                    tab.cwd = cwd;
                }
                tab.attention = attention.contains(&tab.id);
                ws.attention |= tab.attention;
            }
        }
        session.clone()
    };
    if let Err(e) = store::save(&state.data_dir, &snapshot) {
        notice(app, format!("Could not save the session: {e:#}"));
    }
    snapshot
}

/// The only writer of every surface that shows session state.
pub fn publish(app: &AppHandle) {
    let snapshot = persist(app);
    let _ = app.emit(EVENT_CHANGED, &snapshot);
    crate::tray::refresh(app);
}

/// A message for the user that has no command to return through.
pub fn notice(app: &AppHandle, message: String) {
    eprintln!("agentic-workspace: {message}");
    if app.emit(EVENT_NOTICE, &message).is_err() {
        app.state::<AppState>().notices.lock().push(message);
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
    {
        let mut session = state.session.lock();
        if session.workspace(id).is_none() {
            anyhow::bail!("no workspace {id}");
        }
        session.active = Some(id.to_string());
        session.recent.retain(|r| r != id);
        session.recent.insert(0, id.to_string());
    }
    let spawned = pty::ensure_live(app, id);
    crate::git::refresh_summary(app, id);
    watch::sync(app);
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

#[tauri::command]
pub fn add_workspace(app: AppHandle, state: tauri::State<AppState>, path: String, name: Option<String>) -> Result<String, String> {
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
                    groups: Vec::new(),
                    active_group: None,
                    split_ratio: 0.5,
                    editors: Vec::new(),
                    active_editor: None,
                    expanded: Vec::new(),
                    recent_files: Vec::new(),
                    available: true,
                    attention: false,
                    git: None,
                });
                id
            }
        }
    };
    let result = activate(&app, &id).map_err(|e| format!("{e:#}"));
    publish(&app);
    result.map(|_| id)
}

#[tauri::command]
pub fn switch_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let result = activate(&app, &id).map_err(|e| format!("{e:#}"));
    publish(&app);
    result
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
    let result = match next {
        Some(next) => activate(&app, &next).map_err(|e| format!("{e:#}")),
        None => {
            watch::sync(&app);
            Ok(())
        }
    };
    publish(&app);
    result
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

fn default_mode(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") { "rich" } else { "source" }
}

/// Opens a file in the active editor group, or focuses the tab already
/// showing it there.
#[tauri::command]
pub fn open_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<String, String> {
    let id = {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let group = ws.active_group_mut();
        let id = match group.editors.iter().find(|e| e.path == path && e.diff.is_none()) {
            Some(tab) => tab.id.clone(),
            None => {
                let id = crate::state::new_id();
                group.editors.push(EditorTab { id: id.clone(), path: path.clone(), mode: default_mode(&path).into(), line: 0, diff: None, preview: false });
                id
            }
        };
        group.active_editor = Some(id.clone());
        ws.recent_files.retain(|p| p != &path);
        ws.recent_files.insert(0, path);
        ws.recent_files.truncate(RECENT_FILES_MAX);
        id
    };
    watch::sync(&app);
    publish(&app);
    Ok(id)
}

/// Opens a diff of a path as a tab in the active group, beside the file tabs,
/// or focuses the tab already showing that diff.
#[tauri::command]
pub fn open_diff(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String, diff: DiffSpec) -> Result<String, String> {
    let id = {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let group = ws.active_group_mut();
        let id = match group.editors.iter().find(|e| e.path == path && e.diff.as_ref() == Some(&diff)) {
            Some(tab) => tab.id.clone(),
            None => {
                let id = crate::state::new_id();
                group.editors.push(EditorTab { id: id.clone(), path, mode: "source".into(), line: 0, diff: Some(diff), preview: false });
                id
            }
        };
        group.active_editor = Some(id.clone());
        id
    };
    publish(&app);
    Ok(id)
}

/// Records how a tab is being viewed. Saved, not broadcast: scrolling is not
/// something another window needs to hear about.
#[tauri::command]
pub fn set_editor_view(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String, mode: String, line: u32) {
    {
        let mut session = state.session.lock();
        if let Some(tab) = session
            .workspace_mut(&workspace_id)
            .and_then(|ws| ws.group_of_editor_mut(&id))
            .and_then(|g| g.editors.iter_mut().find(|e| e.id == id))
        {
            tab.mode = mode;
            tab.line = line;
        }
    }
    persist(&app);
}

/// Closes a tab; a group left empty closes itself unless it is the last one.
#[tauri::command]
pub fn close_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            if let Some(group) = ws.group_of_editor_mut(&id) {
                let index = group.editors.iter().position(|e| e.id == id).unwrap_or(0);
                group.editors.retain(|e| e.id != id);
                if group.active_editor.as_deref() == Some(&id) {
                    let next = index.min(group.editors.len().saturating_sub(1));
                    group.active_editor = group.editors.get(next).map(|e| e.id.clone());
                }
            }
            if ws.groups.len() > 1 {
                ws.groups.retain(|g| !g.editors.is_empty());
            }
            ws.ensure_groups();
        }
    }
    watch::sync(&app);
    publish(&app);
}

#[tauri::command]
pub fn set_active_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            let group_id = ws.group_of_editor_mut(&id).map(|g| {
                g.active_editor = Some(id.clone());
                g.id.clone()
            });
            if let Some(g) = group_id {
                ws.active_group = Some(g);
            }
        }
    }
    publish(&app);
}

#[tauri::command]
pub fn set_active_group(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, group_id: String) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            if ws.groups.iter().any(|g| g.id == group_id) {
                ws.active_group = Some(group_id);
            }
        }
    }
    publish(&app);
}

#[tauri::command]
pub fn reorder_editors(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, group_id: String, ids: Vec<String>) {
    {
        let mut session = state.session.lock();
        if let Some(group) = session.workspace_mut(&workspace_id).and_then(|ws| ws.group_mut(&group_id)) {
            reorder(&mut group.editors, &ids, |e| &e.id);
        }
    }
    publish(&app);
}

/// Opens a second group beside the active one showing the same file, so two
/// views — or two files — sit side by side.
#[tauri::command]
pub fn split_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        ws.ensure_groups();
        let (index, tab) = {
            let active = ws.active_group_mut();
            let tab = active.active_editor.as_deref().and_then(|id| active.editors.iter().find(|e| e.id == id)).cloned();
            (ws.groups.iter().position(|g| Some(&g.id) == ws.active_group.as_ref()).unwrap_or(0), tab)
        };
        let id = crate::state::new_id();
        let editors = tab.map(|t| vec![EditorTab { id: crate::state::new_id(), path: t.path, mode: t.mode, line: t.line, diff: t.diff, preview: false }]).unwrap_or_default();
        let active_editor = editors.first().map(|e| e.id.clone());
        ws.groups.insert(index + 1, EditorGroup { id: id.clone(), editors, active_editor });
        ws.active_group = Some(id);
    }
    watch::sync(&app);
    publish(&app);
    Ok(())
}

/// Moves a tab into another group, or into a new group to the right when
/// `group_id` is empty. The tab keeps its id, so its editor state travels.
#[tauri::command]
pub fn move_editor(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String, group_id: String, index: Option<usize>) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        let ws = session.workspace_mut(&workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let tab = {
            let Some(from) = ws.group_of_editor_mut(&id) else { return Err(format!("no editor {id}")) };
            let pos = from.editors.iter().position(|e| e.id == id).ok_or("no such tab")?;
            let tab = from.editors.remove(pos);
            if from.active_editor.as_deref() == Some(&id) {
                from.active_editor = from.editors.get(pos.min(from.editors.len().saturating_sub(1))).map(|e| e.id.clone());
            }
            tab
        };
        let target = if group_id.is_empty() {
            let gid = crate::state::new_id();
            ws.groups.push(EditorGroup { id: gid.clone(), editors: Vec::new(), active_editor: None });
            gid
        } else {
            group_id
        };
        if let Some(group) = ws.group_mut(&target) {
            let at = index.unwrap_or(group.editors.len()).min(group.editors.len());
            group.editors.insert(at, tab);
            group.active_editor = Some(id);
        }
        ws.active_group = Some(target);
        if ws.groups.len() > 1 {
            ws.groups.retain(|g| !g.editors.is_empty());
        }
        ws.ensure_groups();
    }
    publish(&app);
    Ok(())
}

#[tauri::command]
pub fn set_split_ratio(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, ratio: f32) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            ws.split_ratio = ratio.clamp(0.15, 0.85);
        }
    }
    persist(&app);
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

//! Session state: the workspace list, and the one function that publishes it.

use crate::pty;
use crate::state::{AppState, EditorTab, Session, TerminalTab, Workspace};
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

/// Opens a file in an editor tab, or focuses the tab already showing it.
#[tauri::command]
pub fn open_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, path: String) -> Result<String, String> {
    let id = {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        let id = match ws.editors.iter().find(|e| e.path == path) {
            Some(tab) => tab.id.clone(),
            None => {
                let id = crate::state::new_id();
                let mode = if path.to_lowercase().ends_with(".md") || path.to_lowercase().ends_with(".markdown") { "rich" } else { "source" };
                ws.editors.push(EditorTab { id: id.clone(), path: path.clone(), mode: mode.into(), line: 0 });
                id
            }
        };
        ws.active_editor = Some(id.clone());
        ws.recent_files.retain(|p| p != &path);
        ws.recent_files.insert(0, path);
        ws.recent_files.truncate(RECENT_FILES_MAX);
        id
    };
    watch::sync(&app);
    publish(&app);
    Ok(id)
}

/// Records how a tab is being viewed. Saved, not broadcast: scrolling is not
/// something another window needs to hear about.
#[tauri::command]
pub fn set_editor_view(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String, mode: String, line: u32) {
    {
        let mut session = state.session.lock();
        if let Some(tab) = session.workspace_mut(&workspace_id).and_then(|ws| ws.editors.iter_mut().find(|e| e.id == id)) {
            tab.mode = mode;
            tab.line = line;
        }
    }
    persist(&app);
}

#[tauri::command]
pub fn close_file(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            let index = ws.editors.iter().position(|e| e.id == id).unwrap_or(0);
            ws.editors.retain(|e| e.id != id);
            if ws.active_editor.as_deref() == Some(&id) {
                let next = index.min(ws.editors.len().saturating_sub(1));
                ws.active_editor = ws.editors.get(next).map(|e| e.id.clone());
            }
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
            if ws.editors.iter().any(|e| e.id == id) {
                ws.active_editor = Some(id);
            }
        }
    }
    publish(&app);
}

#[tauri::command]
pub fn reorder_editors(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, ids: Vec<String>) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            reorder(&mut ws.editors, &ids, |e| &e.id);
        }
    }
    publish(&app);
}

/// Raises a window. Under Wayland the compositor decides whether to honour
/// it; from a focused window of the same application it does.
#[tauri::command]
pub fn focus_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window {label}"))?;
    window.show().map_err(|e| format!("{e:#}"))?;
    window.set_focus().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    persist(&app);
    pty::shutdown(&app);
    app.exit(0);
}

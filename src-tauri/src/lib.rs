mod agent;
mod assets;
mod desktop;
mod git;
mod files;
mod pty;
mod session;
mod settings;
mod state;
mod store;
mod tree;
mod watch;

use crate::state::AppState;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

pub const EVENT_QUIT_REQUESTED: &str = "quit-requested";

fn setup(app: &mut tauri::App) -> Result<()> {
    let handle = app.handle().clone();

    let data_dir = handle.path().app_data_dir().context("resolving the application data directory")?;
    std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;

    let xdg_data = handle.path().data_dir().context("resolving the user data directory")?;
    if let Err(e) = desktop::ensure_icons(&xdg_data) {
        eprintln!("agentic-workspace: could not install the application icon ({e:#})");
    }
    match desktop::ensure_entry(&xdg_data) {
        Ok(Some(path)) => eprintln!("agentic-workspace: installed desktop entry at {}", path.display()),
        Ok(None) => {}
        Err(e) => eprintln!("agentic-workspace: could not install a desktop entry ({e:#})"),
    }

    let mut notices = Vec::new();
    let session = match store::load(&data_dir) {
        store::Loaded::Session(s) => s,
        store::Loaded::Fresh => state::Session::default(),
        store::Loaded::Unreadable { moved_to, reason } => {
            notices.push(format!(
                "The saved session could not be read ({reason}). It was moved to {moved_to} and the workspace list starts empty."
            ));
            state::Session::default()
        }
    };

    handle.manage(AppState {
        session: Mutex::new(session),
        settings: Mutex::new(settings::load(&data_dir)),
        attention: Mutex::new(std::collections::HashSet::new()),
        activities: Mutex::new(HashMap::new()),
        git: Mutex::new(HashMap::new()),
        ptys: Mutex::new(HashMap::new()),
        watcher: Mutex::new(watch::Watcher::new(handle.clone())),
        data_dir,
        notices: Mutex::new(notices),
    });

    let active = handle.state::<AppState>().session.lock().active.clone();
    if let Some(id) = active {
        if let Err(e) = pty::ensure_live(&handle, &id) {
            session::notice(&handle, format!("Could not restore the active workspace's terminals: {e:#}"));
        }
        git::refresh_summary(&handle, &id);
    }
    watch::sync(&handle);
    session::persist(&handle);

    let quiet = handle.clone();
    std::thread::Builder::new().name("quiet-watch".into()).spawn(move || agent::quiet_loop(quiet)).ok();

    // Terminal working directories change with no event to observe; a periodic
    // save keeps the session file close to the truth if the process is killed.
    let ticker = handle.clone();
    std::thread::Builder::new()
        .name("session-persist".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            session::persist(&ticker);
        })
        .ok();
    Ok(())
}

/// Closing one window hides it while the other stays; closing the last visible
/// window asks the workspace window — which knows about unsaved buffers — to
/// run the quit path.
fn on_close_requested(app: &AppHandle, label: &str) {
    let other = if label == "terminal" { "workspace" } else { "terminal" };
    let other_visible = app
        .get_webview_window(other)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if other_visible {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    } else if let Some(window) = app.get_webview_window("workspace") {
        let _ = window.emit(EVENT_QUIT_REQUESTED, ());
    }
}

/// WebKitGTK's DMA-BUF renderer trips a Wayland explicit-sync protocol error
/// on the NVIDIA driver and the process dies before any window appears. Must
/// run before GTK initialises; setting the variable yourself opts out.
fn apply_webkit_workaround() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        pty::SCRUB_WEBKIT_VAR.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// GTK3 takes a Wayland toplevel's `app_id` from `g_get_prgname()`, which
/// defaults to the executable name; the task bar resolves a window to a desktop
/// entry by that id. Naming the process after the identifier keeps the chain
/// intact. `enableGTKAppId` in `tauri.conf.json` does not reach the surface.
fn set_application_id() {
    glib::set_prgname(Some(desktop::APP_ID));
    glib::set_application_name(desktop::APP_NAME);
}

pub fn run() {
    set_application_id();
    apply_webkit_workaround();

    tauri::Builder::default()
        // Registered first so a second launch is answered before anything
        // else initialises: it raises the running instance's windows.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            for label in ["workspace", "terminal"] {
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }))
        // Size is restored; position is requested, which Wayland ignores.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            setup(app).map_err(|e| -> Box<dyn std::error::Error> { format!("{e:#}").into() })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                on_close_requested(window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            session::get_session,
            session::take_notices,
            session::add_workspace,
            session::switch_workspace,
            session::remove_workspace,
            session::set_expanded,
            session::open_file,
            session::close_file,
            session::set_active_editor,
            session::reorder_editors,
            session::set_editor_view,
            settings::get_settings,
            settings::update_settings,
            assets::save_asset,
            assets::import_asset,
            git::git_info,
            git::git_init,
            git::git_status,
            git::git_diff,
            git::git_show_file,
            git::git_commit_file_diff,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_apply_hunk,
            git::git_discard,
            git::git_commit,
            git::git_last_message,
            git::git_log,
            git::git_show,
            git::git_blame,
            git::git_branches,
            git::git_create_branch,
            git::git_checkout,
            git::git_delete_branch,
            git::git_unmerged_commits,
            git::git_worktrees,
            git::git_add_worktree,
            git::git_remove_worktree,
            git::git_worktree_dirty,
            git::git_prune_worktrees,
            git::git_remote,
            session::focus_window,
            session::quit,
            pty::terminal_open,
            pty::terminal_close,
            pty::terminal_attach,
            pty::terminal_detach,
            pty::terminal_write,
            pty::terminal_resize,
            pty::terminal_rename,
            pty::set_active_terminal,
            pty::reorder_terminals,
            tree::list_dir,
            tree::list_files,
            tree::create_entry,
            tree::rename_entry,
            tree::duplicate_entry,
            tree::trash_entry,
            tree::reveal_entry,
            tree::search_project,
            files::read_file,
            files::open_externally,
            files::write_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agentic Workspace")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                pty::shutdown(app);
            }
        });
}

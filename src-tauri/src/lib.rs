mod agent;
mod askpass;
mod assets;
mod clipboard;
mod credentials;
mod desktop;
mod git;
mod hotkey;
mod files;
mod pty;
mod secret;
mod session;
mod settings;
mod state;
mod store;
mod themes;
mod tray;
mod tree;
mod watch;
mod windows;

pub use askpass::helper;

use crate::state::AppState;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

pub const EVENT_QUIT_REQUESTED: &str = "quit-requested";

fn setup(app: &mut tauri::App) -> Result<()> {
    let handle = app.handle().clone();

    let xdg_data = handle.path().data_dir().context("resolving the user data directory")?;

    // Not `app_data_dir()`: that resolves from the `identifier` in
    // `tauri.conf.json`, which a development build shares with an installed one,
    // and one data directory holding two live sessions loses whichever saved
    // first. `APP_ID` carries the build's own identity; for a release build the
    // two resolve to the same path.
    let data_dir = xdg_data.join(desktop::APP_ID);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
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

    let (settings, unreadable) = settings::load(&data_dir);
    notices.extend(unreadable);

    let mut session = session;
    session.workspaces.iter_mut().for_each(state::Workspace::ensure_groups);
    handle.manage(AppState {
        session: Mutex::new(session),
        settings: Mutex::new(settings),
        attention: Mutex::new(std::collections::HashSet::new()),
        foreground: Mutex::new(None),
        activities: Mutex::new(HashMap::new()),
        git: Mutex::new(HashMap::new()),
        hotkey: Mutex::new(hotkey::Hotkey::default()),
        last_focused: Mutex::new("workspace".into()),
        ptys: Mutex::new(HashMap::new()),
        watcher: Mutex::new(watch::Watcher::new(handle.clone())),
        windows: Mutex::new(windows::load(&data_dir)),
        tray: tray::Tray::default(),
        published: Mutex::new(String::new()),
        data_dir,
        notices: Mutex::new(notices),
        dropped: Mutex::new(None),
        git_children: Mutex::new(HashMap::new()),
        prompts: Mutex::new(askpass::Prompts::default()),
    });
    // Before any shell or git starts: the relay answers their prompts, and a
    // shell's include has to exist when its first git runs.
    askpass::sweep();
    if let Err(e) = askpass::serve(&handle) {
        eprintln!("agentic-workspace: no askpass relay, so ssh's prompts reach no dialog ({e})");
    }
    credentials::write_terminal_configs(&handle);
    if let Err(e) = tray::init(&handle) {
        session::notice(&handle, format!("No tray icon: {e:#}. Closing the last window quits instead."));
    }
    windows::show_all(&handle);

    let active = handle.state::<AppState>().session.lock().active.clone();
    if let Some(id) = active {
        if let Err(e) = pty::ensure_live(&handle, &id) {
            session::notice(&handle, format!("Could not restore the active workspace's terminals: {e:#}"));
        }
    }
    // Every workspace, not only the one on screen: the selector lists each
    // one's branch and its worktrees, and a summary is what carries both. Off
    // the main loop, because that is several `git` processes per workspace and
    // the windows are already up (`standards-linux-desktop`).
    let summaries = handle.clone();
    std::thread::Builder::new()
        .name("git-summaries".into())
        .spawn(move || {
            let all: Vec<String> = summaries.state::<AppState>().session.lock().workspaces.iter().map(|w| w.id.clone()).collect();
            for id in all {
                git::refresh_summary(&summaries, &id);
            }
            session::prune_worktrees(&summaries);
            watch::sync(&summaries);
            session::publish(&summaries);
            // Launch wrote the terminal configurations before any summary
            // was in; the summaries can resolve a worktree differently.
            credentials::write_terminal_configs(&summaries);
        })
        .ok();
    watch::sync(&handle);
    session::persist(&handle);

    let quiet = handle.clone();
    std::thread::Builder::new().name("quiet-watch".into()).spawn(move || agent::quiet_loop(quiet)).ok();
    let portal = handle.clone();
    std::thread::Builder::new().name("global-hotkey".into()).spawn(move || hotkey::run_blocking(portal)).ok();

    // Terminal working directories change with no event to observe. The shell
    // on screen is followed as it prints (`agent::quiet_loop`); every other
    // one reaches the windows here, and the session file stays close to the
    // truth if the process is killed. A publish that finds nothing moved
    // sends and writes nothing.
    let ticker = handle.clone();
    std::thread::Builder::new()
        .name("session-persist".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            session::publish(&ticker);
            windows::save(&ticker);
        })
        .ok();
    Ok(())
}

/// Closing a window hides it; the application lives on in the tray with every
/// terminal still running (TRAY-01). Without a tray there is no way back, so
/// closing the last visible window asks the workspace window — which knows
/// about unsaved buffers — to run the quit path instead.
fn on_close_requested(app: &AppHandle, label: &str) {
    let other = if label == "terminal" { "workspace" } else { "terminal" };
    let stranded = !app.state::<AppState>().tray.is_available() && !windows::is_visible(app, other);
    if stranded {
        if let Some(window) = app.get_webview_window("workspace") {
            let _ = window.emit(EVENT_QUIT_REQUESTED, ());
        }
    } else {
        windows::hide(app, label);
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
        desktop::WEBKIT_VAR_SET.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Auto-nice daemons match `node` by name and put it in the idle scheduling
/// class: `ananicy`'s stock rules ship exactly that, `pnpm tauri dev` is node,
/// and a child inherits the policy, the nice value and the I/O class through
/// both fork and exec. The application, its two web processes and every shell
/// started in a terminal then run at SCHED_IDLE, whose weight is 3 against a
/// normal task's 1024. Nothing reports it. On an idle machine nothing is felt
/// either; the moment anything else wants the processor, typing in a terminal
/// stalls, for seconds under real load. The demotion is undone here, before
/// the web processes are forked, so that they inherit the repair. A release
/// build launched from its desktop entry is not a child of node, finds itself
/// in the normal class, and returns at the first line.
fn restore_scheduling() {
    // SAFETY: each call names this process and is allowed to fail — a system
    // whose RLIMIT_NICE forbids the change keeps the policy it was given.
    unsafe {
        if libc::sched_getscheduler(0) != libc::SCHED_IDLE {
            return;
        }
        let normal = libc::sched_param { sched_priority: 0 };
        libc::sched_setscheduler(0, libc::SCHED_OTHER, &normal);
        libc::setpriority(libc::PRIO_PROCESS, 0, 0);
        // The same demotion covers disk access, where the idle class is
        // starved outright while anything else reads. `ioprio_set` has no
        // wrapper: best-effort is class 2, shifted 13, with the default
        // priority 4.
        libc::syscall(libc::SYS_ioprio_set, 1, 0, (2 << 13) | 4);
    }
}

/// GTK3 takes a Wayland toplevel's `app_id` from `g_get_prgname()`, which
/// defaults to the executable name; the task bar resolves a window to a desktop
/// entry by that id. Naming the process after `APP_ID` keeps the chain intact.
///
/// `enableGTKAppId` in `tauri.conf.json` is off, and has to be: it does not
/// reach the `app_id` a toplevel carries, and what it does instead is hand
/// GTK the `identifier` to register as a `GApplication` — a second name on the
/// session bus, claimed by both builds, that makes whichever process starts
/// second a remote instance which tao exits at the top of its event loop.
fn set_application_id() {
    glib::set_prgname(Some(desktop::APP_ID));
    glib::set_application_name(desktop::APP_NAME);
}

pub fn run() {
    credentials::forget_inherited_env();
    restore_scheduling();
    set_application_id();
    apply_webkit_workaround();

    tauri::Builder::default()
        // Registered first so a second launch is answered before anything
        // else initialises: it raises the running instance's windows. The bus
        // name comes off `APP_ID` rather than the config identifier, so a
        // development build claims its own and starts beside an installed
        // build instead of raising that one and exiting.
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                .callback(|app, _argv, _cwd| windows::raise_last_focused(app))
                .dbus_id(desktop::APP_ID)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            setup(app).map_err(|e| -> Box<dyn std::error::Error> { format!("{e:#}").into() })?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                on_close_requested(window.app_handle(), window.label());
            }
            WindowEvent::Focused(true) => {
                *window.app_handle().state::<AppState>().last_focused.lock() = window.label().to_string();
            }
            WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                windows::record(window.app_handle(), window.label());
            }
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { .. }) => {
                windows::capture_drop(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            session::get_session,
            session::take_notices,
            session::add_workspace,
            session::switch_workspace,
            session::remove_workspace,
            session::rename_workspace,
            session::reorder_workspaces,
            session::set_mode,
            session::set_expanded,
            session::open_file,
            session::open_diff,
            session::pin_editor,
            session::close_file,
            session::set_active_editor,
            session::reorder_editors,
            session::set_active_group,
            session::split_editor,
            session::move_editor,
            session::drop_editor,
            session::set_layout_sizes,
            session::set_editor_view,
            session::view_create,
            session::view_rename,
            session::view_delete,
            session::view_add,
            session::view_remove,
            session::view_reorder,
            session::set_active_view,
            desktop::gpu_accelerated,
            settings::get_settings,
            settings::update_settings,
            credentials::credentials_status,
            credentials::credentials_key_files,
            credentials::credential_add_key,
            credentials::credential_rename_key,
            credentials::credential_save_passphrase,
            credentials::credential_remove_key,
            credentials::credential_add_identity,
            credentials::credential_update_identity,
            credentials::credential_remove_identity,
            credentials::set_workspace_credentials,
            askpass::credential_prompts,
            askpass::credential_prompt_answer,
            themes::import_themes,
            themes::list_themes,
            themes::delete_theme,
            hotkey::hotkey_status,
            hotkey::configure_hotkey,
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
            git::git_stashes,
            git::git_stash_push,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_tags,
            git::git_create_tag,
            git::git_delete_tag,
            session::focus_window,
            windows::show_window_menu,
            windows::drop_modifiers,
            session::quit,
            pty::terminal_open,
            pty::terminal_close,
            pty::terminal_attach,
            pty::terminal_detach,
            pty::terminal_ack,
            pty::terminal_write,
            pty::terminal_resize,
            pty::terminal_rename,
            pty::set_active_terminal,
            pty::reorder_terminals,
            pty::terminal_restart,
            pty::workspace_stale_terminals,
            tree::list_dir,
            tree::list_files,
            tree::stat_entries,
            tree::create_entry,
            tree::rename_entry,
            tree::duplicate_entry,
            tree::trash_entry,
            tree::paste_entry,
            tree::reveal_entry,
            tree::search_project,
            files::read_file,
            files::open_externally,
            files::save_draft,
            files::read_draft,
            files::delete_draft,
            files::write_file,
            clipboard::clipboard_files,
            clipboard::set_clipboard_files,
            clipboard::clear_clipboard_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agentic Workspace")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                windows::save(app);
                pty::shutdown(app);
            }
        });
}

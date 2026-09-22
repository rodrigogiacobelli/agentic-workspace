//! The one global hotkey — raise the application from anywhere — bound through
//! `org.freedesktop.portal.GlobalShortcuts`, the only mechanism a Wayland
//! compositor sanctions. The compositor owns the binding: what it reports back
//! is the truth, and "no key assigned" is a state the settings screen shows.

use crate::desktop::APP_ID;
use crate::state::AppState;
use anyhow::{Context, Result};
use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut};
use ashpd::desktop::CreateSessionOptions;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const SHORTCUT_ID: &str = "raise";
pub const EVENT_CHANGED: &str = "hotkey-changed";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub active: bool,
    /// The key the compositor reports, or `None` when none is assigned.
    pub trigger: Option<String>,
    pub message: Option<String>,
}

pub struct Hotkey {
    pub status: HotkeyStatus,
    pub configure: Arc<AtomicBool>,
    pub restart: Arc<AtomicBool>,
}

impl Default for Hotkey {
    fn default() -> Self {
        Self { status: HotkeyStatus::default(), configure: Arc::new(AtomicBool::new(false)), restart: Arc::new(AtomicBool::new(false)) }
    }
}

fn publish(app: &AppHandle, status: HotkeyStatus) {
    app.state::<AppState>().hotkey.lock().status = status.clone();
    let _ = app.emit(EVENT_CHANGED, &status);
}

/// Raises the window the user last worked in.
fn raise(app: &AppHandle) {
    let label = app.state::<AppState>().last_focused.lock().clone();
    let label = if label.is_empty() { "workspace".to_string() } else { label };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Runs the portal session for the life of the application, re-binding when
/// the preferred trigger changes. Blocking; runs on its own thread.
pub fn run_blocking(app: AppHandle) {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_none() {
        return;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            publish(&app, HotkeyStatus { active: false, trigger: None, message: Some(format!("no runtime for the portal: {e}")) });
            return;
        }
    };
    loop {
        let preferred = app.state::<AppState>().settings.lock().global_hotkey.clone();
        let (configure, restart) = {
            let state = app.state::<AppState>();
            let h = state.hotkey.lock();
            (Arc::clone(&h.configure), Arc::clone(&h.restart))
        };
        restart.store(false, Ordering::SeqCst);
        let result = runtime.block_on(session(&app, preferred, configure, Arc::clone(&restart)));
        if let Err(e) = result {
            publish(&app, HotkeyStatus { active: false, trigger: None, message: Some(format!("{e:#}")) });
            // Wait for a settings change asking for another attempt.
            while !restart.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

async fn session(app: &AppHandle, preferred: String, configure: Arc<AtomicBool>, restart: Arc<AtomicBool>) -> Result<()> {
    // The portal refuses an app id it cannot resolve to a desktop entry and then
    // binds nothing, which is why `desktop::ensure_entry` runs first at startup.
    if let Ok(app_id) = APP_ID.try_into() {
        if let Err(e) = ashpd::register_host_app(app_id).await {
            eprintln!("agentic-workspace: the portal rejected the app id ({e}); the shortcut may bind under the launcher");
        }
    }
    let proxy = GlobalShortcuts::new().await.context("connecting to the desktop portal")?;
    let session = proxy.create_session(CreateSessionOptions::default()).await.context("opening a global-shortcuts session")?;
    let shortcuts = vec![NewShortcut::new(SHORTCUT_ID, "Raise Agentic Workspace").preferred_trigger(Some(preferred.as_str()).filter(|s| !s.trim().is_empty()))];

    let mut activated = proxy.receive_activated().await.context("subscribing to activations")?;
    let mut changed = proxy.receive_shortcuts_changed().await.ok();
    let mut closed = session.receive_closed().await.ok();

    // BindShortcuts runs on every launch: since xdg-desktop-portal-kde 6.7.4 a
    // new session does not activate previously bound shortcuts. It may block
    // behind a consent dialog, so it is polled inside the loop.
    let bind = proxy.bind_shortcuts(&session, &shortcuts, None, Default::default());
    tokio::pin!(bind);
    let mut binding = true;
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        tokio::select! {
            result = &mut bind, if binding => {
                binding = false;
                match result.and_then(|r| r.response()) {
                    Ok(bound) => publish(app, summarise(bound.shortcuts())),
                    Err(e) => {
                        close(&session).await;
                        anyhow::bail!("the desktop refused the shortcut: {e}");
                    }
                }
            }
            _ = ticker.tick() => {
                if restart.load(Ordering::SeqCst) {
                    close(&session).await;
                    return Ok(());
                }
                if configure.swap(false, Ordering::SeqCst) {
                    if let Err(e) = proxy.configure_shortcuts(&session, None, Default::default()).await {
                        publish(app, HotkeyStatus { message: Some(format!("could not open the shortcut editor: {e}")), ..app.state::<AppState>().hotkey.lock().status.clone() });
                    }
                }
            }
            Some(event) = activated.next() => {
                if event.shortcut_id() == SHORTCUT_ID {
                    raise(app);
                }
            }
            Some(event) = next_or_pending(&mut changed) => {
                publish(app, summarise(event.shortcuts()));
            }
            Some(_) = next_or_pending(&mut closed) => {
                anyhow::bail!("the desktop closed the shortcuts session");
            }
        }
    }
}

async fn next_or_pending<S, T>(stream: &mut Option<S>) -> Option<T>
where
    S: futures_util::Stream<Item = T> + Unpin,
{
    match stream {
        Some(s) => s.next().await,
        None => std::future::pending().await,
    }
}

/// A `Session` has no `Drop`; abandoning it leaks a subscription that keeps
/// re-emitting every shortcut signal.
async fn close(session: &ashpd::desktop::Session<GlobalShortcuts>) {
    let _ = tokio::time::timeout(Duration::from_secs(2), session.close()).await;
}

fn summarise(shortcuts: &[Shortcut]) -> HotkeyStatus {
    let trigger = shortcuts
        .iter()
        .find(|s| s.id() == SHORTCUT_ID)
        .map(|s| s.trigger_description().to_string())
        .filter(|t| !t.trim().is_empty());
    HotkeyStatus {
        active: trigger.is_some(),
        message: if trigger.is_none() { Some("no key assigned; open the desktop's shortcut editor to assign one".into()) } else { None },
        trigger,
    }
}

#[tauri::command]
pub fn hotkey_status(state: tauri::State<AppState>) -> HotkeyStatus {
    state.hotkey.lock().status.clone()
}

/// Opens the desktop's own shortcut editor for this application.
#[tauri::command]
pub fn configure_hotkey(state: tauri::State<AppState>) {
    state.hotkey.lock().configure.store(true, Ordering::SeqCst);
}

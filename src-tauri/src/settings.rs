//! Settings — global and per workspace — in one file beside the session.

use crate::session::EVENT_NOTICE;
use crate::state::AppState;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter};

const FILE: &str = "settings.json";
pub const EVENT_CHANGED: &str = "settings-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub theme: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u32,
    pub terminal_line_height: f32,
    pub editor_font_family: String,
    pub editor_font_size: u32,
    pub prose_font_family: String,
    pub prose_font_size: u32,
    pub autosave: bool,
    pub autosave_delay_ms: u32,
    pub notifications: bool,
    pub quiet_threshold_s: u32,
    pub asset_warn_mb: u32,
    /// What paste and drop write for a stored asset: `markdown` for a link
    /// relative to the note, `citation` for `@/path` from the workspace root.
    pub asset_links: String,
    /// Preferred trigger for the raise-from-anywhere hotkey, in the portal's
    /// syntax. The compositor may assign something else, or nothing.
    pub global_hotkey: String,
    /// Language overrides keyed by absolute file path.
    pub languages: HashMap<String, String>,
    /// How the mode selector and every panel tab read: `labels` or `icons`,
    /// never both. Settings files from before modes call it `panelTabs`, and
    /// the `text` they may hold is read as `labels`.
    #[serde(alias = "panelTabs")]
    pub tab_display: String,
    /// The mode a markdown file opens in: `source`, `split` or `rich`.
    pub markdown_mode: String,
    /// Rich mode fills the tab's width rather than a readable column.
    pub rich_full_width: bool,
    /// A trash from the file tree asks first (SET-05).
    pub confirm_delete: bool,
    /// The program a terminal tab runs. Empty means `$SHELL`, which is what
    /// the desktop's own terminal would start.
    pub terminal_shell: String,
    /// Which renderer a terminal draws with: `auto`, `webgl` or `dom`. `auto`
    /// draws into the DOM — see `useWebgl` in `src/terminals.ts`.
    pub terminal_gpu: String,
    /// Where ＋ starts a shell: `root`, the folder of the family's root, or
    /// `workspace`, the one on screen (TERM-17, TERM-18). v0.4.0 drops it
    /// when it saves the settings, which puts it back to `root`.
    pub terminal_open_in: String,
    /// Where each docked mode's panels sit around its working area: one dock
    /// tree per mode, `{ editor, scm }`, as the frontend lays them out and
    /// opaque to the backend. The application's, not a workspace's (DOCK-08).
    /// Null until a panel is first moved; a single tree stored before modes
    /// is migrated by the frontend.
    pub panel_layout: serde_json::Value,
    /// Per-workspace settings keyed by absolute directory path.
    pub workspaces: HashMap<String, WorkspaceSettings>,
    /// The SSH keys and commit identities a workspace can be assigned. Only
    /// the credential commands change them; `update_settings` keeps what the
    /// backend holds (CRED-02).
    pub credentials: Credentials,
    /// The page the settings dialog opens on.
    pub settings_tab: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSettings {
    /// Where pasted assets land, relative to the workspace root.
    pub clipboard_dir: Option<String>,
    pub notifications: Option<bool>,
    pub theme: Option<String>,
    /// The SSH key this workspace's git uses: `None` is unset, which a linked
    /// worktree takes from its repository; `Some("")` is explicitly the
    /// user's own ssh setup; otherwise a key's id. Like the two below, only
    /// the credential commands change it.
    pub ssh_key: Option<String>,
    /// The commit identity, in the same three states as `ssh_key`.
    pub identity: Option<String>,
    /// Whether this workspace's terminals carry its credentials (CRED-07).
    /// Never inherited.
    pub terminal_credentials: bool,
}

/// Holds no secret: a passphrase lives in the wallet, never here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Credentials {
    pub keys: Vec<SshKey>,
    pub identities: Vec<Identity>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SshKey {
    pub id: String,
    pub name: String,
    /// The private key file, absolute.
    pub path: String,
    /// `None` until known: an encrypted PEM key without its `.pub` gives its
    /// fingerprint only once its passphrase is checked.
    pub fingerprint: Option<String>,
    /// The key needs a passphrase.
    pub protected: bool,
    /// Its passphrase is in the wallet.
    pub saved: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub label: String,
    pub name: String,
    pub email: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            theme: "graphite".into(),
            terminal_font_family: String::new(),
            terminal_font_size: 13,
            terminal_line_height: 1.15,
            editor_font_family: String::new(),
            editor_font_size: 13,
            prose_font_family: String::new(),
            prose_font_size: 15,
            autosave: false,
            autosave_delay_ms: 1000,
            notifications: true,
            quiet_threshold_s: 20,
            asset_warn_mb: 5,
            asset_links: "markdown".into(),
            // KGlobalAccel gives one key to one component, and a development
            // build is a component of its own, so it asks for its own key
            // rather than the one an installed build already holds.
            global_hotkey: if cfg!(debug_assertions) { "CTRL+ALT+d" } else { "CTRL+ALT+a" }.into(),
            languages: HashMap::new(),
            tab_display: "labels".into(),
            markdown_mode: "source".into(),
            rich_full_width: false,
            confirm_delete: true,
            terminal_shell: String::new(),
            terminal_gpu: "auto".into(),
            terminal_open_in: "root".into(),
            panel_layout: serde_json::Value::Null,
            workspaces: HashMap::new(),
            credentials: Credentials::default(),
            settings_tab: "general".into(),
        }
    }
}

impl Settings {
    pub fn clipboard_dir(&self, workspace: &Path) -> String {
        self.workspaces
            .get(&workspace.display().to_string())
            .and_then(|w| w.clipboard_dir.clone())
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| "clipboard".into())
    }
}

/// The settings, and a notice for the user when the file could not be used.
/// Such a file is moved aside rather than overwritten by the defaults, and
/// with it go the credential assignments it held.
pub fn load(data_dir: &Path) -> (Settings, Option<String>) {
    let path = data_dir.join(FILE);
    let parsed = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Settings>(&text).map_err(|e| format!("parsing it: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("reading it: {e}")),
    };
    let (mut settings, notice) = match parsed {
        Ok(settings) => (settings, None),
        Err(reason) => {
            let moved_to = crate::store::set_aside(&path);
            let notice = format!(
                "The settings could not be read ({reason}). They were moved to {moved_to} and the defaults apply: every workspace's SSH key, commit identity and terminal credentials were reset."
            );
            (Settings::default(), Some(notice))
        }
    };
    if settings.tab_display == "text" {
        settings.tab_display = "labels".into();
    }
    (settings, notice)
}

fn save(data_dir: &Path, settings: &Settings) -> Result<()> {
    let text = serde_json::to_string_pretty(settings).context("serialising settings")?;
    crate::store::write_atomic(&data_dir.join(FILE), &text)
}

#[tauri::command]
pub fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().clone()
}

/// Writes `settings` and sends them to both windows; a failed write is also
/// a notice. Called with the settings lock held from the change through the
/// emit, so of two writers racing — the credential commands run off the main
/// thread — the later state is the one left on disk and the one the windows
/// hear last. A window holding an older snapshot would send it back whole on
/// its next change.
pub fn write_and_emit(app: &AppHandle, data_dir: &Path, settings: &Settings) -> Result<()> {
    let saved = save(data_dir, settings);
    if let Err(e) = &saved {
        let _ = app.emit(EVENT_NOTICE, format!("Could not save settings: {e:#}"));
    }
    let _ = app.emit(EVENT_CHANGED, settings);
    saved
}

/// Writes the settings as they are now and sends them to both windows: the
/// caller's change and any made since.
pub fn save_and_emit(app: &AppHandle, state: &AppState) {
    let current = state.settings.lock();
    let _ = write_and_emit(app, &state.data_dir, &current);
}

/// `settings` keeps the credentials and every workspace's credential
/// assignments that `current` holds: the frontend sends the whole object back,
/// and only the credential commands may change those.
fn keep_credentials(settings: &mut Settings, current: &Settings) {
    settings.credentials = current.credentials.clone();
    for (path, ws) in settings.workspaces.iter_mut() {
        let held = current.workspaces.get(path);
        ws.ssh_key = held.and_then(|h| h.ssh_key.clone());
        ws.identity = held.and_then(|h| h.identity.clone());
        ws.terminal_credentials = held.is_some_and(|h| h.terminal_credentials);
    }
    for (path, held) in &current.workspaces {
        if !settings.workspaces.contains_key(path) && (held.ssh_key.is_some() || held.identity.is_some() || held.terminal_credentials) {
            let ws = WorkspaceSettings {
                ssh_key: held.ssh_key.clone(),
                identity: held.identity.clone(),
                terminal_credentials: held.terminal_credentials,
                ..Default::default()
            };
            settings.workspaces.insert(path.clone(), ws);
        }
    }
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: tauri::State<AppState>, mut settings: Settings) -> Result<Settings, String> {
    let (snapshot, hotkey_changed) = {
        let mut current = state.settings.lock();
        let changed = current.global_hotkey != settings.global_hotkey;
        keep_credentials(&mut settings, &current);
        *current = settings;
        // A failed write has already told the user; the change stands.
        let _ = write_and_emit(&app, &state.data_dir, &current);
        (current.clone(), changed)
    };
    if hotkey_changed {
        state.hotkey.lock().restart.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(snapshot)
}

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
    /// Preferred trigger for the raise-from-anywhere hotkey, in the portal's
    /// syntax. The compositor may assign something else, or nothing.
    pub global_hotkey: String,
    /// Language overrides keyed by absolute file path.
    pub languages: HashMap<String, String>,
    /// Where the Files, Search, Git and Outline panels sit, as the frontend
    /// lays them out; the application's, not a workspace's (DOCK-08). Null
    /// until a panel is first moved.
    pub panel_layout: serde_json::Value,
    /// Per-workspace settings keyed by absolute directory path.
    pub workspaces: HashMap<String, WorkspaceSettings>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSettings {
    /// Where pasted assets land, relative to the workspace root.
    pub clipboard_dir: Option<String>,
    pub notifications: Option<bool>,
    pub theme: Option<String>,
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
            global_hotkey: "CTRL+ALT+a".into(),
            languages: HashMap::new(),
            panel_layout: serde_json::Value::Null,
            workspaces: HashMap::new(),
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

pub fn load(data_dir: &Path) -> Settings {
    let path = data_dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("agentic-workspace: settings unreadable ({e}); using defaults");
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

fn save(data_dir: &Path, settings: &Settings) -> Result<()> {
    let path = data_dir.join(FILE);
    let tmp = data_dir.join(format!(".{FILE}.tmp-{}", std::process::id()));
    let text = serde_json::to_string_pretty(settings).context("serialising settings")?;
    std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().clone()
}

pub fn save_and_emit(app: &AppHandle, state: &AppState, snapshot: &Settings) {
    if let Err(e) = save(&state.data_dir, snapshot) {
        let _ = app.emit(EVENT_NOTICE, format!("Could not save settings: {e:#}"));
    }
    let _ = app.emit(EVENT_CHANGED, snapshot);
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: tauri::State<AppState>, settings: Settings) -> Result<Settings, String> {
    let (snapshot, hotkey_changed) = {
        let mut current = state.settings.lock();
        let changed = current.global_hotkey != settings.global_hotkey;
        *current = settings;
        (current.clone(), changed)
    };
    save_and_emit(&app, &state, &snapshot);
    if hotkey_changed {
        state.hotkey.lock().restart.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(snapshot)
}

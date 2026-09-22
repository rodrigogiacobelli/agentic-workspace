//! The tray icon: the application's home once every window is closed. Its
//! menu lists the windows and the workspaces, and the icon changes while a
//! background workspace wants attention. On Linux the icon is a
//! StatusNotifierItem through libayatana-appindicator, which delivers menu
//! events only — a left click opens the menu, whose first entry raises the
//! last-focused window.

use crate::desktop::APP_NAME;
use crate::state::AppState;
use crate::windows;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

pub const ID: &str = "main";

/// What the menu and icon were last built from, so a publish that changes
/// nothing visible does not rebuild an open menu under the pointer.
#[derive(Default)]
pub struct Tray {
    available: AtomicBool,
    signature: Mutex<String>,
}

impl Tray {
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::SeqCst)
    }
}

pub fn init(app: &AppHandle) -> Result<()> {
    let idle = icon(app, false).context("no application icon to show in the tray")?;
    TrayIconBuilder::with_id(ID)
        .icon(idle)
        .tooltip(APP_NAME)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu)
        .build(app)
        .context("registering the tray icon")?;
    app.state::<AppState>().tray.available.store(true, Ordering::SeqCst);
    refresh(app);
    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == "show" {
        windows::raise_last_focused(app);
    } else if let Some(label) = id.strip_prefix("win:") {
        if let Err(e) = windows::show(app, label) {
            crate::session::notice(app, format!("{e:#}"));
        }
    } else if let Some(ws) = id.strip_prefix("ws:") {
        if let Err(e) = crate::session::activate(app, ws) {
            crate::session::notice(app, format!("{e:#}"));
        }
        crate::session::publish(app);
        windows::raise_last_focused(app);
    } else if id == "quit" {
        // The workspace window owns the unsaved-buffer prompt; it has to be
        // on screen for the dialog to have a parent.
        if let Err(e) = windows::show(app, "workspace") {
            crate::session::notice(app, format!("{e:#}"));
        }
        if let Some(w) = app.get_webview_window("workspace") {
            let _ = w.emit(crate::EVENT_QUIT_REQUESTED, ());
        }
    }
}

/// Rebuilds the menu and picks the icon from the current session.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.tray.is_available() {
        return;
    }
    let Some(tray): Option<TrayIcon> = app.tray_by_id(ID) else { return };
    let (workspaces, attention) = {
        let session = state.session.lock();
        let attention_set = state.attention.lock();
        let list: Vec<(String, String, bool, bool)> = session
            .workspaces
            .iter()
            .map(|w| {
                let wants = w.terminals.iter().any(|t| attention_set.contains(&t.id));
                (w.id.clone(), w.name.clone(), session.active.as_deref() == Some(&w.id), wants)
            })
            .collect();
        let any = list.iter().any(|(_, _, active, wants)| *wants && !*active);
        (list, any)
    };
    let visible: Vec<bool> = windows::LABELS.iter().map(|l| windows::is_visible(app, l)).collect();
    let signature = format!("{visible:?}|{attention}|{workspaces:?}");
    {
        let mut last = state.tray.signature.lock();
        if *last == signature {
            return;
        }
        *last = signature;
    }
    match menu(app, &workspaces, &visible) {
        Ok(m) => {
            if let Err(e) = tray.set_menu(Some(m)) {
                eprintln!("agentic-workspace: could not update the tray menu ({e})");
            }
        }
        Err(e) => eprintln!("agentic-workspace: could not build the tray menu ({e:#})"),
    }
    if let Some(image) = icon(app, attention) {
        let _ = tray.set_icon(Some(image));
    }
}

fn menu(app: &AppHandle, workspaces: &[(String, String, bool, bool)], visible: &[bool]) -> Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", format!("Show {APP_NAME}"), true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (label, title, shown) in [("workspace", "Workspace window", visible[0]), ("terminal", "Terminal window", visible[1])] {
        menu.append(&CheckMenuItem::with_id(app, format!("win:{label}"), title, true, shown, None::<&str>)?)?;
    }
    if !workspaces.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (id, name, active, wants) in workspaces {
            let text = if *wants && !*active { format!("● {name}") } else { name.clone() };
            menu.append(&CheckMenuItem::with_id(app, format!("ws:{id}"), text, true, *active, None::<&str>)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

/// The application icon, with a dot in the corner for the attention variant.
fn icon(app: &AppHandle, attention: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    if attention {
        let r = (w.min(h) as f32 * 0.2) as i32;
        let (cx, cy) = (w as i32 - r - 1, h as i32 - r - 1);
        for y in (cy - r).max(0)..(cy + r + 1).min(h as i32) {
            for x in (cx - r).max(0)..(cx + r + 1).min(w as i32) {
                let dx = x - cx;
                let dy = y - cy;
                if dx * dx + dy * dy <= r * r {
                    let i = ((y as u32 * w + x as u32) * 4) as usize;
                    rgba[i..i + 4].copy_from_slice(&[0xf9, 0x73, 0x16, 0xff]);
                }
            }
        }
    }
    Some(Image::new_owned(rgba, w, h))
}

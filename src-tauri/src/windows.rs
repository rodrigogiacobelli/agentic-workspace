//! Window geometry, kept by the application per window rather than per
//! workspace, so a window hidden to the tray comes back exactly as it was
//! closed. Size and the maximised state are restored; position is requested,
//! which Wayland leaves to the compositor (PLT-11).

use crate::state::AppState;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const FILE: &str = "windows.json";
pub const LABELS: [&str; 2] = ["workspace", "terminal"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
    /// The monitor the window was on, by the name the compositor reports.
    pub monitor: Option<String>,
}

#[derive(Default)]
pub struct Store {
    geometry: HashMap<String, Geometry>,
    dirty: bool,
}

pub fn load(data_dir: &Path) -> Store {
    let geometry = std::fs::read_to_string(data_dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    Store { geometry, dirty: false }
}

fn window(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

/// Reads the window's current geometry into the store. The size of a
/// maximised window is the screen's, so only the maximised flag is taken then
/// and the last restored size stays.
pub fn record(app: &AppHandle, label: &str) {
    let Some(w) = window(app, label) else { return };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let state = app.state::<AppState>();
    let mut store = state.windows.lock();
    let g = store.geometry.entry(label.to_string()).or_default();
    g.maximized = maximized;
    if !maximized {
        if let Ok(size) = w.outer_size() {
            if size.width > 0 && size.height > 0 {
                g.width = size.width;
                g.height = size.height;
            }
        }
        if let Ok(pos) = w.outer_position() {
            g.x = pos.x;
            g.y = pos.y;
        }
    }
    g.monitor = w.current_monitor().ok().flatten().and_then(|m| m.name().cloned());
    store.dirty = true;
}

/// Applies the stored geometry. Position is a request the compositor may
/// ignore; a monitor is chosen by placing the window inside its bounds.
fn restore(app: &AppHandle, w: &WebviewWindow) {
    let saved = app.state::<AppState>().windows.lock().geometry.get(w.label()).cloned();
    let Some(g) = saved else { return };
    if g.width > 0 && g.height > 0 {
        let _ = w.set_size(PhysicalSize::new(g.width, g.height));
    }
    let on_monitor = g
        .monitor
        .as_ref()
        .and_then(|name| w.available_monitors().ok()?.into_iter().find(|m| m.name() == Some(name)));
    match on_monitor {
        Some(m) if !m.size().width.eq(&0) => {
            let area = m.position();
            let size = m.size();
            let inside = g.x >= area.x && g.x < area.x + size.width as i32 && g.y >= area.y && g.y < area.y + size.height as i32;
            let (x, y) = if inside { (g.x, g.y) } else { (area.x + 40, area.y + 40) };
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = w.set_position(PhysicalPosition::new(g.x, g.y));
        }
    }
    if g.maximized {
        let _ = w.maximize();
    } else if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    }
}

/// Shows a window at its remembered geometry and focuses it.
pub fn show(app: &AppHandle, label: &str) -> Result<()> {
    let w = window(app, label).with_context(|| format!("no window {label}"))?;
    let was_visible = w.is_visible().unwrap_or(false);
    if !was_visible {
        restore(app, &w);
    }
    w.show().context("showing the window")?;
    let _ = w.unminimize();
    w.set_focus().context("focusing the window")?;
    if !was_visible {
        crate::tray::refresh(app);
    }
    Ok(())
}

/// Hides a window, remembering where it was so it reopens there.
pub fn hide(app: &AppHandle, label: &str) {
    record(app, label);
    save(app);
    if let Some(w) = window(app, label) {
        let _ = w.hide();
    }
    crate::tray::refresh(app);
}

/// The window the user last worked in, for the hotkey and the tray.
pub fn raise_last_focused(app: &AppHandle) {
    let label = app.state::<AppState>().last_focused.lock().clone();
    let label = if LABELS.contains(&label.as_str()) { label } else { "workspace".to_string() };
    if let Err(e) = show(app, &label) {
        crate::session::notice(app, format!("{e:#}"));
    }
}

pub fn is_visible(app: &AppHandle, label: &str) -> bool {
    window(app, label).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// Restores every window at launch and shows it. The application never
/// starts hidden: only closing a window puts it in the tray.
pub fn show_all(app: &AppHandle) {
    for label in LABELS {
        if let Err(e) = show(app, label) {
            crate::session::notice(app, format!("Could not show the {label} window: {e:#}"));
        }
    }
}

/// Opens the compositor's window menu — move to desktop, keep above and the
/// rest — at a point in the window, as a right-click on a title bar would.
/// Wayland's `xdg_toplevel.show_window_menu` needs the serial of a real
/// button press, which GDK keeps from the click the webview just received;
/// a synthetic button event carrying the seat's pointer hands it over.
#[tauri::command]
pub fn show_window_menu(window: WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    use gtk::prelude::*;
    let gtk_window = window.gtk_window().map_err(|e| format!("{e:#}"))?;
    let gdk_window = gtk_window.window().ok_or("the window is not realised")?;
    let pointer = gdk_window
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
        .ok_or("no pointer device")?;
    let mut event = gtk::gdk::Event::new(gtk::gdk::EventType::ButtonPress);
    event.set_device(Some(&pointer));
    // Safe: the event is a freshly allocated GdkEventButton, and the window
    // reference it takes is kept alive by `gdk_window` for the call.
    unsafe {
        use glib::translate::{ToGlibPtr, ToGlibPtrMut};
        let raw: *mut gtk::gdk::ffi::GdkEvent = event.to_glib_none_mut().0;
        let button = &mut (*raw).button;
        button.window = gdk_window.to_glib_none().0;
        glib::gobject_ffi::g_object_ref(button.window as *mut glib::gobject_ffi::GObject);
        button.x = x;
        button.y = y;
        button.button = 3;
        button.time = gtk::gdk::ffi::GDK_CURRENT_TIME as u32;
    }
    if gdk_window.show_window_menu(&mut event) {
        Ok(())
    } else {
        Err("the compositor did not open a window menu".into())
    }
}

pub fn save(app: &AppHandle) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut store = state.windows.lock();
        if !store.dirty {
            return;
        }
        store.dirty = false;
        store.geometry.clone()
    };
    let path = state.data_dir.join(FILE);
    let tmp = state.data_dir.join(format!(".{FILE}.tmp-{}", std::process::id()));
    let result = serde_json::to_string_pretty(&snapshot)
        .context("serialising window geometry")
        .and_then(|text| std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display())))
        .and_then(|_| std::fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display())));
    if let Err(e) = result {
        crate::session::notice(app, format!("Could not save window geometry: {e:#}"));
    }
}

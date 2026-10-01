//! The tray icon: the application's home once every window is closed. Its
//! menu lists the windows and the workspaces, and the icon changes while a
//! background workspace wants attention. On Linux the icon is a
//! StatusNotifierItem through libayatana-appindicator, which delivers menu
//! events only — a left click opens the menu, whose first entry raises the
//! last-focused window.

use crate::desktop::APP_NAME;
use crate::state::{AppState, Workspace};
use crate::windows;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// `tray_icon` builds the StatusNotifierItem's own id and the icon file it
/// writes under `$XDG_RUNTIME_DIR/tray-icon/` from this, so a development build
/// takes a different one: two builds sharing it share the panel's per-item
/// settings and race on the same filenames, which shows as one build briefly
/// publishing the other's attention dot.
#[cfg(not(debug_assertions))]
pub const ID: &str = "main";
#[cfg(debug_assertions)]
pub const ID: &str = "main-dev";

/// What the menu and icon were last built from, so a publish that changes
/// nothing visible does not rebuild an open menu under the pointer.
#[derive(Default)]
pub struct Tray {
    available: AtomicBool,
    signature: Mutex<String>,
    /// Whether the icon shows the attention dot. The menu changes with every
    /// workspace renamed or switched to, the icon only when this flips, and
    /// each new icon costs GTK a PNG decode in a separate process.
    dotted: AtomicBool,
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
        // Off the main thread, as a pick in the selector is: bringing a
        // workspace on screen runs git and a scan and may start shells.
        let (app, ws) = (app.clone(), ws.to_string());
        std::thread::spawn(move || {
            if let Err(e) = crate::session::activate(&app, &ws) {
                crate::session::notice(&app, format!("{e:#}"));
            }
            crate::session::publish(&app);
            windows::raise_last_focused(&app);
        });
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

/// Rebuilds the menu and picks the icon from the current session. Publishes
/// come from any thread, and two rebuilds running at once could land in the
/// wrong order under a signature that then skips the right one; on the main
/// thread they run one at a time, each reading the session as it runs.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle));
}

fn apply(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.tray.is_available() {
        return;
    }
    let Some(tray): Option<TrayIcon> = app.tray_by_id(ID) else { return };
    let (workspaces, attention) = {
        let session = state.session.lock();
        // A family's terminals are its root's, so its dot sits on the root's
        // row alone, and not while any member is on screen (AGT-10, AGT-11).
        // `session::persist` sets the root's flag, which a tab its family was
        // shown since no longer raises.
        let home = session.active.as_deref().and_then(|a| session.family_root(a)).map(|r| r.id.clone());
        let row = |w: &Workspace, mark: &str| {
            let wants = home.as_deref() != Some(w.id.as_str()) && w.attention;
            Row { id: format!("ws:{}", w.id), text: format!("{mark}{}", w.name), active: session.active.as_deref() == Some(&w.id), wants, enabled: true }
        };
        let under = |id: &str, of: fn(&Workspace) -> &Option<String>| session.workspaces.iter().filter(|w| of(w).as_deref() == Some(id)).collect::<Vec<_>>();
        // As the selector lists them (TRAY-08): each root, its worktrees —
        // under a label when it has children as well — then each child
        // followed by the child's worktrees.
        let mut list = Vec::new();
        for root in session.workspaces.iter().filter(|w| w.worktree_of.is_none() && w.child_of.is_none()) {
            list.push(row(root, ""));
            let worktrees = under(&root.id, |w| &w.worktree_of);
            let children = under(&root.id, |w| &w.child_of);
            if !worktrees.is_empty() && !children.is_empty() {
                list.push(Row { id: format!("wtgroup:{}", root.id), text: "Worktrees".into(), active: false, wants: false, enabled: false });
            }
            list.extend(worktrees.into_iter().map(|w| row(w, "⑂ ")));
            for child in children {
                list.push(row(child, "› "));
                list.extend(under(&child.id, |w| &w.worktree_of).into_iter().map(|w| row(w, "› ⑂ ")));
            }
        }
        let any = list.iter().any(|r| r.wants);
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
    if state.tray.dotted.swap(attention, Ordering::SeqCst) != attention {
        if let Some(image) = icon(app, attention) {
            let _ = tray.set_icon(Some(image));
        }
    }
}

/// One workspace row of the menu, or the disabled label a repository's
/// worktrees sit under.
#[derive(Debug)]
struct Row {
    id: String,
    text: String,
    active: bool,
    wants: bool,
    enabled: bool,
}

fn menu(app: &AppHandle, workspaces: &[Row], visible: &[bool]) -> Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", format!("Show {APP_NAME}"), true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (label, title, shown) in [("workspace", "Workspace window", visible[0]), ("terminal", "Terminal window", visible[1])] {
        menu.append(&CheckMenuItem::with_id(app, format!("win:{label}"), title, true, shown, None::<&str>)?)?;
    }
    if !workspaces.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for row in workspaces {
            if !row.enabled {
                menu.append(&MenuItem::with_id(app, &row.id, &row.text, false, None::<&str>)?)?;
                continue;
            }
            let text = if row.wants { format!("● {}", row.text) } else { row.text.clone() };
            menu.append(&CheckMenuItem::with_id(app, &row.id, text, true, row.active, None::<&str>)?)?;
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

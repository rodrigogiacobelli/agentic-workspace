//! The desktop's file clipboard, so a file copied in Dolphin or an editor
//! pastes into the tree and one copied in the tree pastes into them.
//!
//! `tauri-plugin-clipboard-manager` carries text, HTML and images and nothing
//! else, and a file copy is neither: on X11 and Wayland alike it is a
//! selection offering `text/uri-list`, with the cut-or-copy flag in a
//! desktop-specific target beside it. GTK owns the selection this process
//! already has, so the list is read and written through `gtk::Clipboard`.
//!
//! Every function here runs a GTK main-loop round trip and must stay on the
//! main thread, which is why each command is synchronous
//! (`standards-linux-desktop`).

use gtk::{TargetEntry, TargetFlags};
use serde::{Deserialize, Serialize};

/// KDE's flag: the target exists on a cut, holding `1`.
const KDE_CUT: &str = "application/x-kde-cutselection";
/// GNOME's: one target whose first line is `cut` or `copy`, then the URIs.
const GNOME_FILES: &str = "x-special/gnome-copied-files";
const URI_LIST: &str = "text/uri-list";
const PLAIN: &str = "text/plain;charset=utf-8";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFiles {
    /// Absolute paths. Empty when the clipboard holds something else.
    pub paths: Vec<String>,
    /// The source wants the files moved, not copied.
    pub cut: bool,
}

fn clipboard() -> Result<gtk::Clipboard, String> {
    let display = gtk::gdk::Display::default().ok_or("no display is open")?;
    gtk::Clipboard::default(&display).ok_or_else(|| "the display has no clipboard".to_string())
}

/// What the desktop clipboard holds, when what it holds is files.
#[tauri::command]
pub fn clipboard_files() -> Result<ClipboardFiles, String> {
    let clipboard = clipboard()?;
    if !clipboard.wait_is_uris_available() {
        return Ok(ClipboardFiles::default());
    }
    let paths: Vec<String> = clipboard
        .wait_for_uris()
        .iter()
        // A URI naming a remote file, one this machine cannot map to a path,
        // or a name that is not UTF-8 — the tree can copy none of them, and a
        // lossy conversion would hand back a path that does not exist.
        .filter_map(|uri| glib::filename_from_uri(uri).ok())
        .filter_map(|(path, _host)| path.to_str().map(str::to_string))
        .collect();
    let cut = read_cut_flag(&clipboard);
    Ok(ClipboardFiles { paths, cut })
}

fn read_cut_flag(clipboard: &gtk::Clipboard) -> bool {
    if let Some(data) = clipboard.wait_for_contents(&gtk::gdk::Atom::intern(KDE_CUT)) {
        return data.data().first() == Some(&b'1');
    }
    if let Some(data) = clipboard.wait_for_contents(&gtk::gdk::Atom::intern(GNOME_FILES)) {
        return data.data().starts_with(b"cut");
    }
    false
}

/// Offers `paths` to the desktop as a file copy or cut. The application owns
/// the selection until something else takes it, which is what makes "the last
/// copy wins" hold across applications: one clipboard answers every paste,
/// whether the copy happened here or in another window.
#[tauri::command]
pub fn set_clipboard_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    let clipboard = clipboard()?;
    let uris: Vec<String> = paths
        .iter()
        .map(|p| glib::filename_to_uri(p, None).map(|u| u.to_string()))
        .collect::<Result<_, _>>()
        .map_err(|e: glib::Error| format!("{e}"))?;
    if uris.is_empty() {
        return Ok(());
    }
    // `text/uri-list` is CRLF-separated by its own specification; the GNOME
    // target puts the verb on the first line and reuses the same list.
    let uri_list = format!("{}\r\n", uris.join("\r\n"));
    let gnome = format!("{}\n{}", if cut { "cut" } else { "copy" }, uris.join("\n"));
    let plain = paths.join("\n");

    let targets = [
        TargetEntry::new(URI_LIST, TargetFlags::empty(), 0),
        TargetEntry::new(KDE_CUT, TargetFlags::empty(), 1),
        TargetEntry::new(GNOME_FILES, TargetFlags::empty(), 2),
        TargetEntry::new(PLAIN, TargetFlags::empty(), 3),
    ];
    let served = clipboard.set_with_data(&targets, move |_, selection, info| match info {
        0 => selection.set(&gtk::gdk::Atom::intern(URI_LIST), 8, uri_list.as_bytes()),
        1 => selection.set(&gtk::gdk::Atom::intern(KDE_CUT), 8, if cut { b"1" } else { b"0" }),
        2 => selection.set(&gtk::gdk::Atom::intern(GNOME_FILES), 8, gnome.as_bytes()),
        _ => {
            selection.set_text(&plain);
        }
    });
    if served {
        Ok(())
    } else {
        Err("the desktop refused the clipboard selection".into())
    }
}

/// Drops a cut once it has been pasted, as a file manager does: the files are
/// no longer where the clipboard says they are, and a second paste would move
/// something that is already gone.
///
/// `gtk_clipboard_clear` only releases a selection this process owns, and the
/// cut may have come from another application — no client can revoke another's
/// on Wayland. Taking the selection is the only way to retire it.
#[tauri::command]
pub fn clear_clipboard_files() -> Result<(), String> {
    let clipboard = clipboard()?;
    clipboard.clear();
    if clipboard.wait_is_uris_available() {
        clipboard.set_text("");
    }
    Ok(())
}

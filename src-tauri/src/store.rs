//! The session file under the application's data directory.

use crate::state::{Session, SESSION_VERSION};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const FILE: &str = "session.json";

/// What `load` found: a session, or the reason it started empty.
pub enum Loaded {
    Session(Session),
    Fresh,
    /// The file could not be used and was moved to the returned path.
    Unreadable { moved_to: String, reason: String },
}

pub fn load(data_dir: &Path) -> Loaded {
    let path = data_dir.join(FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Fresh,
        Err(e) => return set_aside(&path, format!("reading it: {e}")),
    };
    match serde_json::from_str::<Session>(&text) {
        Ok(session) if session.version <= SESSION_VERSION => Loaded::Session(session),
        Ok(session) => set_aside(
            &path,
            format!(
                "it was written by a newer version (format {}, this build reads {})",
                session.version, SESSION_VERSION
            ),
        ),
        Err(e) => set_aside(&path, format!("parsing it: {e}")),
    }
}

/// Moves an unusable store aside rather than deleting it.
fn set_aside(path: &Path, reason: String) -> Loaded {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = path.with_extension(format!("json.unreadable-{stamp}"));
    let moved_to = match std::fs::rename(path, &aside) {
        Ok(()) => aside.display().to_string(),
        Err(e) => format!("(could not move it: {e})"),
    };
    Loaded::Unreadable { moved_to, reason }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary name beside `path` that no other write shares. Two threads
/// saving the same file at once — the periodic save and a publish — would
/// otherwise write one temporary file and rename it out from under each other.
pub fn tmp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{name}.tmp-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)))
}

/// Writes text atomically: a temporary file beside the target, then a rename.
pub fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let tmp = tmp_path(path);
    let result = std::fs::write(&tmp, text)
        .with_context(|| format!("writing {}", tmp.display()))
        .and_then(|_| std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display())));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Writes the session atomically.
pub fn save(data_dir: &Path, session: &Session) -> Result<()> {
    let text = serde_json::to_string_pretty(session).context("serialising the session")?;
    write_atomic(&data_dir.join(FILE), &text)
}

//! The session file under the application's data directory.

use crate::state::{Session, SESSION_VERSION};
use anyhow::{Context, Result};
use std::path::Path;

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

/// Writes the session atomically: a temporary file beside it, then a rename.
pub fn save(data_dir: &Path, session: &Session) -> Result<()> {
    let path = data_dir.join(FILE);
    let tmp = data_dir.join(format!(".{FILE}.tmp-{}", std::process::id()));
    let text = serde_json::to_string_pretty(session).context("serialising the session")?;
    std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

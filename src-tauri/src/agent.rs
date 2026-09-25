//! The two agent signals: an attention badge when a background terminal
//! prints, and a desktop notification when a busy background terminal goes
//! quiet. Notifications go through `notify-send`, whose `--action` support
//! is what lets a click switch to the terminal that raised it. The loop that
//! watches for quiet also follows the directory of the shell on screen.

use crate::session;
use crate::state::AppState;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Below this, a slow build notifies constantly.
pub const QUIET_FLOOR_S: u32 = 5;

#[derive(Default)]
pub struct Activity {
    pub last_output: Option<Instant>,
    /// Output arrived while the workspace was in the background and no quiet
    /// notification has been sent for it since.
    pub busy: bool,
    pub notification_id: Option<u32>,
}

pub type Activities = Mutex<HashMap<String, Activity>>;

/// Called from the output thread of every terminal, after each chunk. This is
/// the hot path: a full-screen program redraws on every keystroke, so it runs
/// as often as the user types. It takes no lock that `session::persist` holds,
/// and it reaches the session at all only on the first chunk a background
/// terminal prints after being noticed (PERF-04).
pub fn on_output(app: &AppHandle, terminal_id: &str) {
    let state = app.state::<AppState>();
    let foreground = state.foreground.lock().as_deref() == Some(terminal_id);
    {
        let mut activities = state.activities.lock();
        let activity = activities.entry(terminal_id.to_string()).or_default();
        activity.last_output = Some(Instant::now());
        // `quiet_loop` is what decides whether a notification is due, and it
        // already drops every terminal in the workspace on screen (AGT-05),
        // so arming this needs no reading of the session here.
        if !foreground {
            activity.busy = true;
        }
    }
    if foreground {
        return;
    }
    // The badge goes up once per quiet period. This is the only branch that
    // reaches the session, and output alone never takes it there.
    if state.attention.lock().insert(terminal_id.to_string()) {
        session::publish(app);
    }
}

pub fn forget(state: &AppState, terminal_id: &str) {
    state.activities.lock().remove(terminal_id);
    state.attention.lock().remove(terminal_id);
}

/// How often `quiet_loop` looks, and so how long a `cd` takes to reach the
/// windows.
const TICK: Duration = Duration::from_millis(250);

/// Runs for the life of the application: follows the directory of the shell
/// on screen, and checks for a busy background terminal that has gone quiet.
pub fn quiet_loop(app: AppHandle) {
    let mut since = Instant::now();
    let mut seen = None;
    let mut ticks = 0u32;
    loop {
        std::thread::sleep(TICK);
        let now = Instant::now();
        follow_directory(&app, since, &mut seen);
        since = now;
        // A quiet threshold is whole seconds, at least five: once a second is
        // grain enough, and the scan clones the settings.
        ticks = ticks.wrapping_add(1);
        if !ticks.is_multiple_of(4) {
            continue;
        }
        let state = app.state::<AppState>();
        let settings = state.settings.lock().clone();
        let threshold = Duration::from_secs(settings.quiet_threshold_s.max(QUIET_FLOOR_S) as u64);
        let mut due: Vec<(String, String, String, String, Option<u32>)> = Vec::new();
        {
            let session = state.session.lock();
            let mut activities = state.activities.lock();
            for (id, activity) in activities.iter_mut() {
                if !activity.busy {
                    continue;
                }
                let Some(last) = activity.last_output else { continue };
                if last.elapsed() < threshold {
                    continue;
                }
                let Some(ws) = session.workspace_of_terminal_mut_ref(id) else { continue };
                if session.active.as_deref() == Some(&ws.id) {
                    activity.busy = false;
                    continue;
                }
                let enabled = settings
                    .workspaces
                    .get(&ws.path.display().to_string())
                    .and_then(|w| w.notifications)
                    .unwrap_or(settings.notifications);
                activity.busy = false;
                if !enabled {
                    continue;
                }
                let tab = ws.terminals.iter().find(|t| t.id == *id);
                let tab_name = tab
                    .and_then(|t| t.name.clone())
                    .unwrap_or_else(|| tab.map(|t| t.cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).unwrap_or_default());
                due.push((id.clone(), ws.id.clone(), ws.name.clone(), tab_name, activity.notification_id));
            }
        }
        for (terminal_id, ws_id, ws_name, tab_name, replace) in due {
            let app = app.clone();
            let seconds = threshold.as_secs();
            std::thread::Builder::new()
                .name("notify".into())
                .spawn(move || notify(app, terminal_id, ws_id, ws_name, tab_name, seconds, replace))
                .ok();
        }
    }
}

/// Publishes when the shell on screen has changed directory: the Terminal
/// window resolves a relative link against it, and its status bar and tab
/// show it. A `cd` has no event to observe, but it always prints a prompt, so
/// the directory is read on the tick after output, never on the hot path.
/// `seen` is the terminal and directory the last read found. Another terminal
/// come on screen counts as a move as well: nothing here knows what the
/// windows were last sent for it, and a publish that finds nothing moved
/// sends nothing.
fn follow_directory(app: &AppHandle, since: Instant, seen: &mut Option<(String, PathBuf)>) {
    let state = app.state::<AppState>();
    let Some(id) = state.foreground.lock().clone() else { return };
    let printed = state.activities.lock().get(&id).and_then(|a| a.last_output).is_some_and(|t| t >= since);
    if !printed {
        return;
    }
    let Some(pid) = state.ptys.lock().get(&id).and_then(|live| live.pid) else { return };
    let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) else { return };
    let current = Some((id, cwd));
    if *seen != current {
        *seen = current;
        session::publish(app);
    }
}

fn notify(app: AppHandle, terminal_id: String, ws_id: String, ws_name: String, tab_name: String, seconds: u64, replace: Option<u32>) {
    let mut cmd = Command::new("notify-send");
    cmd.args(["-a", crate::desktop::APP_NAME, "-i", crate::desktop::APP_ID, "-p", "-A", "default=Show"]);
    if let Some(id) = replace {
        cmd.arg("-r").arg(id.to_string());
    }
    cmd.arg(format!("{ws_name}: {tab_name} went quiet"))
        .arg(format!("No output for {seconds} s. The agent finished, or it is waiting for you."))
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return };
    // The id is printed as soon as the notification shows; record it for
    // replacement before waiting for the click.
    let stdout = child.stdout.take();
    let mut clicked = false;
    if let Some(out) = stdout {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if let Ok(id) = line.parse::<u32>() {
                if let Some(a) = app.state::<AppState>().activities.lock().get_mut(&terminal_id) {
                    a.notification_id = Some(id);
                }
            } else if line == "default" {
                clicked = true;
            }
        }
    }
    let _ = child.wait();
    if clicked {
        activate(&app, &ws_id, &terminal_id);
    }
}

/// Switches to the workspace and terminal a notification named, and raises
/// the Terminal window.
fn activate(app: &AppHandle, ws_id: &str, terminal_id: &str) {
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(ws_id) {
            if ws.terminals.iter().any(|t| t.id == terminal_id) {
                ws.active_terminal = Some(terminal_id.to_string());
            }
        }
    }
    if let Err(e) = crate::session::activate(app, ws_id) {
        session::notice(app, format!("{e:#}"));
    }
    session::publish(app);
    if let Err(e) = crate::windows::show(app, "terminal") {
        session::notice(app, format!("{e:#}"));
    }
}

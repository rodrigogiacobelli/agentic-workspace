//! Pseudoterminal sessions. The backend owns every one of them; a view
//! attaches to receive output and detaches without disturbing the process.

use crate::session;
use crate::state::{AppState, Session, TerminalTab};
use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_RESTARTED: &str = "terminal-restarted";

/// Bytes of recent output kept for a view that attaches after the fact — a
/// reloaded webview. Roughly ten thousand lines of ordinary output.
const BUFFER_MAX: usize = 2 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

/// How long output accumulates before it is handed to the view as one message.
///
/// A read of a pseudoterminal returns the moment a single byte is there, so a
/// program that draws a screen out of short escape sequences produces hundreds
/// of reads a second — measured here, a 30 fps full-screen redraw carrying
/// 21 KB/s arrives as 981 reads a second averaging 22 bytes. One message per
/// read puts every one of those on the GTK main thread, which is also the
/// thread that delivers key presses, and typing stalls for seconds. Batching
/// on a window turns that same second of output into 29 messages.
///
/// The window is armed by the first byte to arrive and is never re-armed, so
/// output is delayed by at most this, however hard the program writes. This is
/// VSCode's `TerminalDataBufferer`, whose `throttleBy` is the same 5 ms
/// (`src/vs/platform/terminal/common/terminalDataBuffering.ts`).
const FLUSH_WINDOW: Duration = Duration::from_millis(5);

/// The window for a terminal that is not on screen. Its view, if it has one,
/// is a hidden tab or a background workspace's, and nobody reads its output as
/// it arrives: a busy agent's hundreds of messages a second become four, each
/// one a webview script evaluation the GTK main thread runs. The terminal that
/// comes on screen is woken and flushes at once.
const BACKGROUND_WINDOW: Duration = Duration::from_millis(250);

/// A window ends early once this much is waiting. Nothing is owed an
/// acknowledgement until it is sent, so without this the watermark could not
/// hold back a flood inside a long window, and the backlog would grow here
/// rather than in the kernel.
const FLUSH_EARLY: usize = 64 * 1024;

/// Flow control, from VSCode's `FlowControlConstants`
/// (`src/vs/platform/terminal/common/terminal.ts`). The view acknowledges what
/// it has parsed; past the high mark the reader stops taking bytes from the
/// pseudoterminal, so the kernel buffer fills and the program writing into it
/// blocks, rather than the backlog growing in this process without bound.
const HIGH_WATERMARK_CHARS: usize = 100_000;
/// Resuming only at zero would stutter, so the reader restarts here instead.
/// Must not be below the view's acknowledgement size or it would never resume.
const LOW_WATERMARK_CHARS: usize = 5_000;

/// The most bytes one message carries.
///
/// Tauri delivers a channel message in one of two ways: by evaluating a script
/// on the webview, or — past a size — by parking the body and having the page
/// fetch it back over a second round trip. Raw bytes take the fetch path at
/// 1 KB, a JSON payload only at 8 KB (`MAX_RAW_DIRECT_EXECUTE_THRESHOLD` and
/// `MAX_JSON_DIRECT_EXECUTE_THRESHOLD` in tauri's `ipc/channel.rs`). Batching
/// pushes every message over 1 KB, so raw bytes would put all of this on the
/// slower path — and because the view refuses to hand a message to the
/// terminal until every earlier one has arrived, one message on the fetch path
/// holds up every message behind it. Base64 under the JSON threshold keeps all
/// of them on the one fast path, in order. Base64 grows by four thirds and the
/// quotes add two, so 6000 bytes encodes to 8002 — inside the 8192 limit.
const MAX_MESSAGE_BYTES: usize = 6_000;

pub struct Live {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub pid: Option<u32>,
    /// The shell started with its workspace's terminal credentials (CRED-07).
    pub credentials: bool,
    stream: Arc<Stream>,
}

/// The bytes leaving one pseudoterminal, and the two conditions the reader and
/// the flusher wait on.
struct Stream {
    out: Mutex<Output>,
    /// Raised when the first byte of a window arrives: it starts the flusher's
    /// clock. Nothing re-arms it until that window has been flushed. Also
    /// raised to end a window early: past `FLUSH_EARLY`, on coming on screen,
    /// and on hangup.
    armed: Condvar,
    /// Raised when the view has caught up enough for the reader to go on.
    drained: Condvar,
}

/// The buffered tail and the attached view, under one lock so that attaching
/// can snapshot the one and install the other without a byte slipping between.
struct Output {
    buffer: Vec<u8>,
    sink: Option<Channel<InvokeResponseBody>>,
    /// Read from the pseudoterminal, not yet handed to the view.
    pending: Vec<u8>,
    /// Sent to the view and not yet reported parsed.
    unacked: usize,
    /// The pseudoterminal has hung up; both threads are to stop.
    closed: bool,
    /// The Terminal window shows this one: its output leaves on the short
    /// window. Follows `AppState::foreground`.
    on_screen: bool,
}

impl Live {
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("resizing the pseudoterminal")
    }

    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data).context("writing to the pseudoterminal")
    }

    /// Delivers `SIGHUP`; dropping the master afterwards hangs up the line.
    pub fn hangup(&mut self) {
        // A reader held at the high-water mark is waiting on the view, not on
        // the shell, and would never notice the hangup on its own.
        {
            let mut out = self.stream.out.lock();
            out.closed = true;
        }
        self.stream.drained.notify_one();
        self.stream.armed.notify_one();
        let _ = self.killer.kill();
    }
}

/// What a workspace's shells start as: the program the setting names, empty
/// meaning the one the desktop would have started, and the environment its
/// terminal credentials add (CRED-06, CRED-07). Read once per spawn batch, the
/// repository looked up on disk before the settings lock is taken. A tab
/// takes both when its shell starts, so a change applies to the next shell
/// rather than disturbing a running one.
fn shell_env(app: &AppHandle, workspace_id: &str) -> (String, Vec<(String, String)>) {
    let state = app.state::<AppState>();
    let scope = crate::credentials::scope(&state, workspace_id);
    let (shell, env, written) = {
        let settings = state.settings.lock();
        let chosen = settings.terminal_shell.trim();
        let shell = if chosen.is_empty() {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        } else {
            chosen.to_string()
        };
        match &scope {
            // The include the environment names has to exist before the
            // shell's first git runs.
            Some(scope) => (
                shell,
                crate::credentials::terminal_env(&settings, scope, workspace_id),
                crate::credentials::write_terminal_config(&settings, scope, workspace_id),
            ),
            None => (shell, Vec::new(), Ok(())),
        }
    };
    if let Err(e) = written {
        session::notice(app, format!("Terminal credentials could not be written: {e}"));
    }
    (shell, env)
}

fn spawn(app: AppHandle, id: String, cwd: &Path, size: PtySize, shell: &str, env: &[(String, String)]) -> Result<Live> {
    let system = native_pty_system();
    let pair = system.openpty(size).context("allocating a pseudoterminal")?;

    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    crate::desktop::clean_child_env(&mut cmd);
    for (name, value) in env {
        cmd.env(name, value);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .with_context(|| format!("starting {shell} in {}", cwd.display()))?;
    drop(pair.slave);

    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().context("opening the output reader")?;
    let writer = pair.master.take_writer().context("opening the input writer")?;
    let stream = Arc::new(Stream {
        out: Mutex::new(Output { buffer: Vec::new(), sink: None, pending: Vec::new(), unacked: 0, closed: false, on_screen: false }),
        armed: Condvar::new(),
        drained: Condvar::new(),
    });

    let app_for_flush = app.clone();
    let pump = Arc::clone(&stream);
    let exited_id = id.clone();
    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; CHUNK];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let chunk = &buf[..n];
                let mut out = pump.out.lock();
                out.buffer.extend_from_slice(chunk);
                trim(&mut out.buffer);
                // The first byte of a window starts the flusher's clock; the
                // one that fills it ends the window.
                let before = out.pending.len();
                out.pending.extend_from_slice(chunk);
                if before == 0 || (before < FLUSH_EARLY && out.pending.len() >= FLUSH_EARLY) {
                    pump.armed.notify_one();
                }
                // Past the high mark, stop reading until the view catches up.
                // The kernel's buffer fills and the program writing blocks.
                while out.unacked >= HIGH_WATERMARK_CHARS && !out.closed {
                    pump.drained.wait(&mut out);
                }
            }
            {
                let mut out = pump.out.lock();
                out.closed = true;
                pump.armed.notify_one();
            }
            let _ = child.wait();
            on_exit(&app, &exited_id, &pump);
        })
        .context("starting the output thread")?;

    let drain = Arc::clone(&stream);
    let flush_app = app_for_flush;
    let flush_id = id.clone();
    std::thread::Builder::new()
        .name(format!("pty-flush-{id}"))
        .spawn(move || loop {
            {
                let mut out = drain.out.lock();
                while out.pending.is_empty() && !out.closed {
                    drain.armed.wait(&mut out);
                }
                if out.closed && out.pending.is_empty() {
                    return;
                }
                // The window. Everything the program writes inside it leaves
                // as one message; the lock is released while it waits. Its
                // length is read again on every wake, so a terminal coming on
                // screen cuts a background window short.
                let start = Instant::now();
                loop {
                    let deadline = start + if out.on_screen { FLUSH_WINDOW } else { BACKGROUND_WINDOW };
                    if out.closed || out.pending.len() >= FLUSH_EARLY || Instant::now() >= deadline {
                        break;
                    }
                    drain.armed.wait_until(&mut out, deadline);
                }
                let payload = std::mem::take(&mut out.pending);
                // Only what a view actually received is owed an
                // acknowledgement; with no view attached there is no backlog.
                if !payload.is_empty() && out.sink.is_some() {
                    let mut sent = 0usize;
                    let mut gone = false;
                    for piece in payload.chunks(MAX_MESSAGE_BYTES) {
                        // Base64's alphabet holds nothing JSON escapes, so the
                        // quoted string is the encoding, with no second pass.
                        let message = format!("\"{}\"", BASE64.encode(piece));
                        match &out.sink {
                            Some(sink) if sink.send(InvokeResponseBody::Json(message)).is_ok() => sent += piece.len(),
                            _ => {
                                gone = true;
                                break;
                            }
                        }
                    }
                    if gone {
                        out.sink = None;
                        out.unacked = 0;
                        drain.drained.notify_one();
                    } else {
                        out.unacked += sent;
                    }
                }
            }
            // Once per window rather than once per read.
            crate::agent::on_output(&flush_app, &flush_id);
        })
        .context("starting the flush thread")?;

    Ok(Live { master: pair.master, writer, killer, pid, credentials: !env.is_empty(), stream })
}

/// Drops the oldest bytes once the tail is an eighth past the cap, cutting
/// back to the cap at a line start so a replay begins on a sane byte. The
/// slack is what makes this cheap: the cut moves the whole buffer, and without
/// it a terminal at the cap would move two megabytes on every read.
fn trim(buffer: &mut Vec<u8>) {
    if buffer.len() <= BUFFER_MAX + BUFFER_MAX / 8 {
        return;
    }
    let excess = buffer.len() - BUFFER_MAX;
    let cut = buffer[excess..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| excess + i + 1)
        .unwrap_or(excess);
    buffer.drain(..cut);
}

/// The shell in a tab ended: the tab goes with it. Unless the tab has moved
/// on — the shell was restarted in place, closed, or taken with its
/// workspace — in which case its exit changes nothing at all.
fn on_exit(app: &AppHandle, id: &str, stream: &Arc<Stream>) {
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock();
        let mut ptys = state.ptys.lock();
        if !ptys.get(id).is_some_and(|live| Arc::ptr_eq(&live.stream, stream)) {
            return;
        }
        ptys.remove(id);
        drop(ptys);
        close_tab(&state, &mut session, id);
    }
    session::publish(app);
}

fn close_tab(state: &AppState, session: &mut Session, id: &str) {
    if let Some(ws) = session.workspace_of_terminal_mut(id) {
        ws.terminals.retain(|t| t.id != id);
        if ws.active_terminal.as_deref() == Some(id) {
            ws.active_terminal = ws.terminals.last().map(|t| t.id.clone());
        }
    }
    crate::agent::forget(state, id);
}

/// Starts a shell for every tab of the workspace that has none. A workspace is
/// spawned when first shown, so launch does not scale with the workspace count.
pub fn ensure_live(app: &AppHandle, workspace_id: &str) -> Result<()> {
    // One caller at a time: a switch runs off the main thread, and two callers
    // would each find a tab without a shell and each start one. The second
    // would replace the first, whose shell, hung up, would then take the tab
    // with it as it exited.
    static SPAWNING: Mutex<()> = Mutex::new(());
    let _one = SPAWNING.lock();
    let state = app.state::<AppState>();
    let (root, tabs): (PathBuf, Vec<TerminalTab>) = {
        let session = state.session.lock();
        match session.workspace(workspace_id) {
            Some(ws) => (ws.path.clone(), ws.terminals.clone()),
            None => return Ok(()),
        }
    };
    if !root.is_dir() {
        anyhow::bail!("{} is not a directory", root.display());
    }
    let mut shell = None;
    let mut ended = false;
    for tab in tabs {
        if state.ptys.lock().contains_key(&tab.id) {
            continue;
        }
        let (program, env) = shell.get_or_insert_with(|| shell_env(app, workspace_id));
        let cwd = if tab.cwd.is_dir() { tab.cwd.clone() } else { root.clone() };
        let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
        let mut live = spawn(app.clone(), tab.id.clone(), &cwd, size, program, env)?;
        // A tab closed, or its workspace removed, while the shell started has
        // nothing left to hang that shell up. Both take `ptys` under the
        // session, so under the two of them here the tab either is still
        // there or has already been taken out.
        let mut session = state.session.lock();
        let mut ptys = state.ptys.lock();
        if session.workspace_of_terminal_mut_ref(&tab.id).is_none() {
            live.hangup();
            continue;
        }
        // A shell that has already exited, such as a shell program that
        // fails to start, is not put here. Its exit handler, run or still
        // waiting on these locks, finds it missing from `ptys` and leaves the
        // tab alone, so the tab is taken out here instead.
        if live.stream.out.lock().closed {
            drop(ptys);
            close_tab(&state, &mut session, &tab.id);
            ended = true;
            continue;
        }
        // Read under `ptys`, which `show` needs too, so a persist that moves
        // the screen to this tab meanwhile either finds it here or has
        // already moved `foreground`.
        let on_screen = state.foreground.lock().as_deref() == Some(tab.id.as_str());
        live.stream.out.lock().on_screen = on_screen;
        ptys.insert(tab.id, live);
    }
    if ended {
        session::publish(app);
    }
    Ok(())
}

/// Gives the short flush window to the terminal `foreground` names and the
/// long one to every other, and wakes the one on screen so what it gathered
/// on the long window reaches the view at once. `foreground` is read here,
/// under `ptys`, so persists racing leave the flags matching whichever of them
/// wrote it last.
pub fn show(state: &AppState) {
    let ptys = state.ptys.lock();
    let foreground = state.foreground.lock().clone();
    for (id, live) in ptys.iter() {
        let on_screen = foreground.as_deref() == Some(id.as_str());
        let mut out = live.stream.out.lock();
        if out.on_screen != on_screen {
            out.on_screen = on_screen;
            if on_screen {
                live.stream.armed.notify_one();
            }
        }
    }
}

/// Hangs up every session. Run on every exit path so no shell outlives the app.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut ptys = state.ptys.lock();
    for live in ptys.values_mut() {
        live.hangup();
    }
    ptys.clear();
}

fn with_live<T>(state: &AppState, id: &str, f: impl FnOnce(&mut Live) -> Result<T>) -> Result<T, String> {
    let mut ptys = state.ptys.lock();
    let live = ptys.get_mut(id).ok_or_else(|| format!("terminal {id} is not running"))?;
    f(live).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn terminal_open(app: AppHandle, state: tauri::State<AppState>, workspace_id: String) -> Result<String, String> {
    let id = crate::state::new_id();
    {
        let mut session = state.session.lock();
        let ws = session
            .workspace_mut(&workspace_id)
            .ok_or_else(|| format!("no workspace {workspace_id}"))?;
        ws.terminals.push(TerminalTab { id: id.clone(), name: None, cwd: ws.path.clone(), attention: false });
        ws.active_terminal = Some(id.clone());
    }
    ensure_live(&app, &workspace_id).map_err(|e| format!("{e:#}"))?;
    session::publish(&app);
    Ok(id)
}

#[tauri::command]
pub fn terminal_close(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<(), String> {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_of_terminal_mut(&id) {
            let index = ws.terminals.iter().position(|t| t.id == id).unwrap_or(0);
            ws.terminals.retain(|t| t.id != id);
            if ws.active_terminal.as_deref() == Some(&id) {
                let next = index.min(ws.terminals.len().saturating_sub(1));
                ws.active_terminal = ws.terminals.get(next).map(|t| t.id.clone());
            }
        }
        if let Some(mut live) = state.ptys.lock().remove(&id) {
            live.hangup();
        }
        crate::agent::forget(&state, &id);
    }
    session::publish(&app);
    Ok(())
}

/// Hands the view the buffered tail and installs its channel for what follows.
#[tauri::command]
pub fn terminal_attach(
    state: tauri::State<AppState>,
    id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Response, String> {
    with_live(&state, &id, |live| {
        let tail = {
            let mut out = live.stream.out.lock();
            out.sink = Some(on_output);
            // The tail carries whatever was waiting for a window, and the new
            // view owes nothing for what the old one was sent.
            out.pending.clear();
            out.unacked = 0;
            live.stream.drained.notify_one();
            out.buffer.clone()
        };
        live.resize(cols, rows)?;
        Ok(Response::new(tail))
    })
}

#[tauri::command]
pub fn terminal_detach(state: tauri::State<AppState>, id: String) {
    if let Some(live) = state.ptys.lock().get(&id) {
        let mut out = live.stream.out.lock();
        out.sink = None;
        // Nothing is going to acknowledge what the departing view held.
        out.unacked = 0;
        live.stream.drained.notify_one();
    }
}

/// The view reports what it has parsed. Sent once per `ACK_SIZE` characters
/// rather than per message, so a flood costs a handful of calls a second.
#[tauri::command]
pub fn terminal_ack(state: tauri::State<AppState>, id: String, chars: usize) {
    if let Some(live) = state.ptys.lock().get(&id) {
        let mut out = live.stream.out.lock();
        out.unacked = out.unacked.saturating_sub(chars);
        if out.unacked < LOW_WATERMARK_CHARS {
            live.stream.drained.notify_one();
        }
    }
}

#[tauri::command]
pub fn terminal_write(state: tauri::State<AppState>, id: String, data: String) -> Result<(), String> {
    with_live(&state, &id, |live| live.write(data.as_bytes()))
}

#[tauri::command]
pub fn terminal_resize(state: tauri::State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    with_live(&state, &id, |live| live.resize(cols, rows))
}

#[tauri::command]
pub fn terminal_rename(app: AppHandle, state: tauri::State<AppState>, id: String, name: Option<String>) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_of_terminal_mut(&id) {
            if let Some(tab) = ws.terminals.iter_mut().find(|t| t.id == id) {
                tab.name = name.filter(|n| !n.trim().is_empty());
            }
        }
    }
    session::publish(&app);
}

#[tauri::command]
pub fn set_active_terminal(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, id: String) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            if ws.terminals.iter().any(|t| t.id == id) {
                ws.active_terminal = Some(id);
            }
        }
    }
    session::publish(&app);
}

#[tauri::command]
pub fn reorder_terminals(app: AppHandle, state: tauri::State<AppState>, workspace_id: String, ids: Vec<String>) {
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_mut(&workspace_id) {
            session::reorder(&mut ws.terminals, &ids, |t| &t.id);
        }
    }
    session::publish(&app);
}

/// A shell that started without the credentials its workspace now gives
/// terminals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleTerminal {
    pub id: String,
    pub label: String,
}

/// The workspace's shells that started without the credentials its terminals
/// now carry (CRED-07). A shell that started with them follows every later
/// change through its include, so only these need a restart.
#[tauri::command]
pub async fn workspace_stale_terminals(state: tauri::State<'_, AppState>, workspace_id: String) -> Result<Vec<StaleTerminal>, String> {
    let scope = crate::credentials::scope(&state, &workspace_id).ok_or_else(|| format!("no workspace {workspace_id}"))?;
    let settings = state.settings.lock().clone();
    if crate::credentials::terminal_env(&settings, &scope, &workspace_id).is_empty() {
        return Ok(Vec::new());
    }
    let tabs = state.session.lock().workspace(&workspace_id).map(|ws| ws.terminals.clone()).unwrap_or_default();
    let ptys = state.ptys.lock();
    Ok(tabs
        .into_iter()
        .enumerate()
        .filter(|(_, tab)| ptys.get(&tab.id).is_some_and(|live| !live.credentials))
        .map(|(at, tab)| {
            // As the tab strip names it, less the program's title, which only
            // the view knows; the tab's place tells two alike apart.
            let name = tab.name.clone().unwrap_or_else(|| tab.cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            StaleTerminal { id: tab.id, label: format!("{name} (tab {})", at + 1) }
        })
        .collect())
}

/// Replaces a running shell with a fresh one in the same tab: same id, name
/// and working directory, the workspace's environment as it is now. A shell
/// that has exited is not restarted (TERM-14 is unbuilt). The new shell
/// starts before the old one goes, and is swapped in under the session and
/// `ptys` as `ensure_live` does, so a tab closed meanwhile takes no shell
/// with it. A tab without a running shell is refused, before and at
/// the swap: starting its shell is `ensure_live`'s, and the two would each
/// start one.
#[tauri::command]
pub fn terminal_restart(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let (workspace_id, root, tab_cwd) = {
        let session = state.session.lock();
        let ws = session.workspace_of_terminal_mut_ref(&id).ok_or_else(|| format!("terminal {id} is not open"))?;
        let tab = ws.terminals.iter().find(|t| t.id == id).map(|t| t.cwd.clone()).unwrap_or_else(|| ws.path.clone());
        (ws.id.clone(), ws.path.clone(), tab)
    };
    let (pid, size) = {
        let ptys = state.ptys.lock();
        let live = ptys.get(&id).ok_or("No shell is running in this tab.")?;
        (live.pid, live.master.get_size().ok())
    };
    let cwd = pid
        .and_then(|p| std::fs::read_link(format!("/proc/{p}/cwd")).ok())
        .filter(|d| d.is_dir())
        .or_else(|| tab_cwd.is_dir().then_some(tab_cwd))
        .unwrap_or(root);
    let size = size.unwrap_or(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 });
    let (shell, env) = shell_env(&app, &workspace_id);
    let mut live = spawn(app.clone(), id.clone(), &cwd, size, &shell, &env).map_err(|e| format!("{e:#}"))?;
    let old = {
        let session = state.session.lock();
        let mut ptys = state.ptys.lock();
        if session.workspace_of_terminal_mut_ref(&id).is_none() {
            live.hangup();
            return Ok(());
        }
        let Some(old) = ptys.get(&id) else {
            live.hangup();
            return Err("No shell is running in this tab.".into());
        };
        // The new shell's exit handler finds the old one in `ptys` and
        // leaves the tab to it.
        if live.stream.out.lock().closed {
            return Err("The new shell exited at once, so the old one keeps running.".into());
        }
        let on_screen = old.stream.out.lock().on_screen;
        live.stream.out.lock().on_screen = on_screen;
        ptys.insert(id.clone(), live)
    };
    if let Some(mut old) = old {
        old.hangup();
    }
    let _ = app.emit(EVENT_RESTARTED, &id);
    session::publish(&app);
    Ok(())
}

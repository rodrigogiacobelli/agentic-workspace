//! Pseudoterminal sessions. The backend owns every one of them; a view
//! attaches to receive output and detaches without disturbing the process.

use crate::session;
use crate::state::{AppState, TerminalTab};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Manager};

/// Bytes of recent output kept for a view that attaches after the fact — a
/// reloaded webview. Roughly ten thousand lines of ordinary output.
const BUFFER_MAX: usize = 2 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

/// Set when the launcher exported `WEBKIT_DISABLE_DMABUF_RENDERER` itself, so
/// shells do not inherit a variable the user never set.
pub static SCRUB_WEBKIT_VAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct Live {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub pid: Option<u32>,
    shared: Arc<Mutex<Output>>,
}

/// The buffered tail and the attached view, under one lock so that attaching
/// can snapshot the one and install the other without a byte slipping between.
struct Output {
    buffer: Vec<u8>,
    sink: Option<Channel<InvokeResponseBody>>,
}

impl Live {
    pub fn cwd(&self) -> Option<PathBuf> {
        let pid = self.pid?;
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

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
        let _ = self.killer.kill();
    }
}

fn spawn(app: AppHandle, id: String, cwd: &Path, cols: u16, rows: u16) -> Result<Live> {
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .context("allocating a pseudoterminal")?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if SCRUB_WEBKIT_VAR.load(std::sync::atomic::Ordering::Relaxed) {
        cmd.env_remove("WEBKIT_DISABLE_DMABUF_RENDERER");
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
    let shared = Arc::new(Mutex::new(Output { buffer: Vec::new(), sink: None }));

    let pump = Arc::clone(&shared);
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
                let mut out = pump.lock();
                out.buffer.extend_from_slice(chunk);
                trim(&mut out.buffer);
                let delivered = match &out.sink {
                    Some(sink) => sink.send(InvokeResponseBody::Raw(chunk.to_vec())).is_ok(),
                    None => true,
                };
                if !delivered {
                    out.sink = None;
                }
            }
            let _ = child.wait();
            on_exit(&app, &exited_id);
        })
        .context("starting the output thread")?;

    Ok(Live { master: pair.master, writer, killer, pid, shared })
}

/// Drops the oldest bytes past the cap, cutting at a line start so a replay
/// begins on a sane byte.
fn trim(buffer: &mut Vec<u8>) {
    if buffer.len() <= BUFFER_MAX {
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

/// The shell in a tab ended: the tab goes with it.
fn on_exit(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    {
        let mut session = state.session.lock();
        if let Some(ws) = session.workspace_of_terminal_mut(id) {
            ws.terminals.retain(|t| t.id != id);
            if ws.active_terminal.as_deref() == Some(id) {
                ws.active_terminal = ws.terminals.last().map(|t| t.id.clone());
            }
        }
        state.ptys.lock().remove(id);
    }
    session::publish(app);
}

/// Starts a shell for every tab of the workspace that has none. A workspace is
/// spawned when first shown, so launch does not scale with the workspace count.
pub fn ensure_live(app: &AppHandle, workspace_id: &str) -> Result<()> {
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
    for tab in tabs {
        if state.ptys.lock().contains_key(&tab.id) {
            continue;
        }
        let cwd = if tab.cwd.is_dir() { tab.cwd.clone() } else { root.clone() };
        let live = spawn(app.clone(), tab.id.clone(), &cwd, 80, 24)?;
        state.ptys.lock().insert(tab.id, live);
    }
    Ok(())
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
        ws.terminals.push(TerminalTab { id: id.clone(), name: None, cwd: ws.path.clone() });
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
            let mut out = live.shared.lock();
            out.sink = Some(on_output);
            out.buffer.clone()
        };
        live.resize(cols, rows)?;
        Ok(Response::new(tail))
    })
}

#[tauri::command]
pub fn terminal_detach(state: tauri::State<AppState>, id: String) {
    if let Some(live) = state.ptys.lock().get(&id) {
        live.shared.lock().sink = None;
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

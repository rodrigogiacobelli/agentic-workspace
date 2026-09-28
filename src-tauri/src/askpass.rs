//! The questions ssh asks, answered by the running application.
//!
//! The binary has two helper modes, entered from `main` before any of the
//! application starts (`helper`):
//!
//! - **The wrapper** (`--agentic-ssh <socket> <key> <credential>`) is git's
//!   ssh for a workspace with a key. `-i` would not confine ssh to that key:
//!   the configuration's own `IdentityFile` for the host is still offered, and
//!   a missing `-i` file falls back to `~/.ssh/id_*`. So the wrapper has ssh
//!   resolve the host's configuration (`ssh -G`), writes it out flat without
//!   a single identity line, and runs ssh on that file with the key as the
//!   only identity (CRED-04).
//! - **The askpass helper** is ssh's `SSH_ASKPASS`. It relays the prompt to
//!   the application over a Unix socket and prints what comes back; a secret
//!   is read in the running application and nowhere else.
//!
//! The relay (`serve`) runs in the application. It works out who asked from
//! the process tree, never from anything the caller sends, and answers a
//! passphrase from the wallet only when the asking ssh was handed that key by
//! the wrapper for a workspace that resolves to it now. Everything else is a
//! dialog in the window of whoever asked.

use crate::credentials::{self, Assigned};
use crate::desktop::APP_ID;
use crate::secret::{self, SecretError};
use crate::settings::SshKey;
use crate::state::AppState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Where the askpass helper finds the relay. Set on ssh by the wrapper, and on
/// git for a workspace without a key (CRED-08, every workspace).
pub const SOCKET_VAR: &str = "AGENTIC_WORKSPACE_SOCKET";
/// The credential the wrapper handed ssh. A claim, never trusted: the relay
/// checks it against the process tree before the wallet is read.
const CREDENTIAL_VAR: &str = "AGENTIC_WORKSPACE_CREDENTIAL";
const WRAPPER_FLAG: &str = "--agentic-ssh";
const MAX_REQUEST: usize = 16 * 1024;
const ANSWER_WITHIN: Duration = Duration::from_secs(300);
/// A second passphrase prompt from one ssh within this long of a wallet answer
/// means the stored passphrase did not open the key.
const RETRY_WINDOW: Duration = Duration::from_secs(600);

pub const EVENT_PROMPT: &str = "credential-prompt";
pub const EVENT_PROMPT_CLOSED: &str = "credential-prompt-closed";

/// A question ssh asked, waiting on the user in the window `window` names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPrompt {
    pub id: String,
    /// `workspace` or `terminal`.
    pub window: String,
    /// `host`, `passphrase`, `secret` or `confirm`.
    pub kind: String,
    pub title: String,
    pub text: String,
    pub host: Option<String>,
    pub fingerprint: Option<String>,
    /// Who asked: a workspace's Source Control, a terminal of one, or an
    /// unknown process.
    pub origin: String,
}

/// What the relay holds between requests.
#[derive(Default)]
pub struct Prompts {
    pending: Vec<Pending>,
    /// ssh processes the wallet answered, and when.
    answered: Vec<(u32, Instant)>,
}

/// A prompt on screen and everyone waiting on it: an identical host-key
/// question or confirmation from the same origin shares its dialog and its
/// answer. A secret never does: typed for the origin the dialog names, it
/// goes to that one requester alone.
pub struct Pending {
    prompt: CredentialPrompt,
    /// Each waiter by a token of its own, so a helper that hangs up takes
    /// its waiter alone off a shared dialog.
    waiters: Vec<(String, mpsc::Sender<Outcome>)>,
}

/// No `Debug` on anything that carries a secret: a stray `{:?}` in a log or a
/// panic would print it.
enum Outcome {
    Answer(String),
    Declined,
    TimedOut,
}

#[derive(Serialize, Deserialize)]
struct Request {
    credential: Option<String>,
    /// ssh's prompt, base64: it is bytes, and a key path cut at 100 bytes may
    /// end inside a character.
    prompt: String,
    hint: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Reply {
    answer: Option<String>,
    message: Option<String>,
}

impl Reply {
    fn message(text: String) -> Self {
        Self { answer: None, message: Some(text) }
    }
}

static SERVING: AtomicBool = AtomicBool::new(false);

/// The relay's socket: one per running instance, so a development build and
/// an installed one never answer each other's prompts.
pub fn socket_path() -> PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_default();
    base.join(APP_ID).join(format!("askpass-{}.sock", std::process::id()))
}

pub fn serving() -> bool {
    SERVING.load(Ordering::Relaxed)
}

/// The helper modes of the binary, run before anything else starts: ssh
/// runs it as its askpass program and git as its ssh. `Some(code)` is the
/// exit code of a helper run; `None` means start the application.
pub fn helper() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == WRAPPER_FLAG) {
        return Some(wrapper(&args[2..]));
    }
    // ssh runs an askpass program with the prompt as its one argument.
    if std::env::var_os(SOCKET_VAR).is_some() && args.len() == 2 {
        return Some(ask(&args[1]));
    }
    None
}

// --- The wrapper ----------------------------------------------------------------

fn wrapper(args: &[OsString]) -> i32 {
    let [socket, key, credential, ssh_args @ ..] = args else {
        eprintln!("Agentic Workspace: the ssh wrapper needs a socket, a key and a credential.");
        return 255;
    };
    match wrap(socket, Path::new(key), credential, ssh_args) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("Agentic Workspace: {message}");
            255
        }
    }
}

/// Keywords the flat file leaves out. Identities and certificates are the
/// point; a master connection or an agent forwarded to the host would carry
/// other keys; the prompt count and the methods are the wrapper's to set.
const DROPPED: &[&str] = &[
    "identityfile",
    "identitiesonly",
    "identityagent",
    "certificatefile",
    "pkcs11provider",
    "controlmaster",
    "controlpath",
    "controlpersist",
    "addkeystoagent",
    "numberofpasswordprompts",
    "forwardagent",
    "preferredauthentications",
];

/// Single values `ssh -G` prints unquoted, which read back as several words.
const QUOTED_WHEN_SPACED: &[&str] = &["user", "hostkeyalias", "revokedhostkeys", "securitykeyprovider", "xauthlocation"];

/// A configuration word in double quotes, as ssh's own parser reads them.
fn config_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', r"\\").replace('"', "\\\""))
}

/// The host's resolved configuration, as `ssh -G` prints it, turned back into
/// a configuration file for that host with every identity taken out. `-G`
/// prints some values in a form its own parser refuses or reads differently,
/// and those are rewritten. `default_algorithms` is the `hostkeyalgorithms`
/// line `-G` prints with no configuration at all: written out, the list would
/// count as set, and ssh would stop preferring the algorithm `known_hosts`
/// already holds for the host — a host known by its ECDSA key would then
/// present its Ed25519 one and be refused as changed.
fn flatten(resolved: &str, default_algorithms: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut setenv: Vec<String> = Vec::new();
    let mut host = None;
    let mut jump = false;
    for line in resolved.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "host" => {
                host = Some(value);
                lines.push(line.to_string());
            }
            k if DROPPED.contains(&k) => {}
            "hostkeyalgorithms" if Some(line) == default_algorithms => {}
            // One line per variable, and ssh takes only the first `SetEnv`.
            "setenv" => setenv.push(config_quote(value)),
            "obscurekeystroketiming" if value != "yes" && value != "no" => lines.push(format!("{key} interval:{value}")),
            "escapechar" => lines.push(format!("{key} {}", value.strip_prefix('\\').unwrap_or(value))),
            k if QUOTED_WHEN_SPACED.contains(&k) && value.contains(' ') => lines.push(format!("{key} {}", config_quote(value))),
            "userknownhostsfile" | "globalknownhostsfile" => lines.push(format!("{key} {}", known_hosts(value))),
            "proxyjump" => {
                jump = value != "none";
                lines.push(line.to_string());
            }
            _ => lines.push(line.to_string()),
        }
    }
    if !setenv.is_empty() {
        lines.push(format!("setenv {}", setenv.join(" ")));
    }
    // ssh hands `-F <this file>` to the jump host's own ssh, which would find
    // nothing here for that host. Every other host reads the user's own
    // configuration, so the hop connects as it always does and only the
    // target sees the assigned key.
    if let (true, Some(host)) = (jump, host) {
        lines.push(format!("Match !originalhost {host}"));
        lines.push("    Include ~/.ssh/config /etc/ssh/ssh_config".into());
    }
    lines.join("\n") + "\n"
}

/// `-G` joins the files with spaces and quotes none of them. A word that does
/// not start a path belongs to the one before; a path holding ` /` or ` ~`
/// stays ambiguous.
fn known_hosts(value: &str) -> String {
    let mut paths: Vec<String> = Vec::new();
    for word in value.split(' ') {
        match paths.last_mut() {
            Some(last) if !word.starts_with('/') && !word.starts_with('~') => {
                last.push(' ');
                last.push_str(word);
            }
            _ => paths.push(word.to_string()),
        }
    }
    paths.iter().map(|p| config_quote(p)).collect::<Vec<_>>().join(" ")
}

/// The `-o` argument that hands ssh the key: `%` doubled, because ssh expands
/// `%` tokens in an identity path, and the path quoted so a space or a quote
/// in it stays one word. The relay looks for exactly this argument on the
/// asking ssh's command line.
pub fn identity_option(path: &str) -> String {
    format!("IdentityFile={}", config_quote(&path.replace('%', "%%")))
}

fn ssh() -> Command {
    let mut cmd = Command::new("ssh");
    crate::desktop::clean_child_env(&mut cmd);
    cmd
}

fn random() -> u64 {
    let mut n = 0u64;
    // SAFETY: writes at most eight bytes into `n`. A failure leaves it zero,
    // and `create_new` still refuses a name that exists.
    unsafe { libc::getrandom(&mut n as *mut u64 as *mut libc::c_void, 8, 0) };
    n
}

/// Deletes the flat file whichever way the wrapper leaves.
struct Unlink(PathBuf);

impl Drop for Unlink {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

extern "C" fn ignore(_: libc::c_int) {}

fn wrap(socket: &OsStr, key: &Path, credential: &OsStr, args: &[OsString]) -> Result<i32, String> {
    let dir = credentials::runtime_dir()?;
    if !key.is_file() {
        return Err(format!("the key file {} assigned to this workspace is missing.", key.display()));
    }
    // The destination and the remote command both, as for the real
    // connection: `Match command` and `Match sessiontype` depend on them.
    let resolved = ssh().arg("-G").args(args).stdin(Stdio::null()).output().map_err(|e| format!("ssh could not run: {e}"))?;
    if !resolved.status.success() {
        let _ = std::io::stderr().write_all(&resolved.stderr);
        return Ok(resolved.status.code().unwrap_or(255));
    }
    let resolved = String::from_utf8_lossy(&resolved.stdout).into_owned();
    let host = resolved.lines().next().and_then(|l| l.strip_prefix("host ")).ok_or("ssh -G did not name the host.")?;
    let defaults = ssh().args(["-F", "none", "-G", host]).stdin(Stdio::null()).output().ok();
    let default_algorithms = defaults
        .as_ref()
        .and_then(|o| std::str::from_utf8(&o.stdout).ok())
        .and_then(|text| text.lines().find(|l| l.starts_with("hostkeyalgorithms ")));
    let flat = flatten(&resolved, default_algorithms);

    let file = dir.join(format!("ssh-{}-{:016x}.conf", std::process::id(), random()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&file)
        .and_then(|mut f| f.write_all(flat.as_bytes()))
        .map_err(|e| format!("writing {}: {e}", file.display()))?;
    let _unlink = Unlink(file.clone());

    // A Ctrl+C in a terminal reaches the whole foreground group. ssh handles
    // it; the wrapper outlives ssh to delete the file. A handler, not
    // `SIG_IGN`, which ssh would inherit through exec.
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler does nothing, which is async-signal-safe.
        unsafe { libc::signal(signal, ignore as extern "C" fn(libc::c_int) as libc::sighandler_t) };
    }
    let exe = std::env::current_exe().map_err(|e| format!("finding this program: {e}"))?;
    let mut child = ssh()
        .arg("-F")
        .arg(&file)
        // The command line is read before `-F`, so these win over the file.
        .args(["-o", &identity_option(&key.to_string_lossy())])
        .args(["-o", "IdentitiesOnly=yes"])
        // `IdentitiesOnly` already keeps the agent to this key; the agent
        // stays reachable for jump hosts and proxy commands, but is never
        // forwarded to the host, where it would hold other accounts' keys.
        .args(["-o", "ForwardAgent=no"])
        .args(["-o", "ControlMaster=no", "-o", "ControlPath=none"])
        .args(["-o", "AddKeysToAgent=no"])
        .args(["-o", "PreferredAuthentications=publickey"])
        .args(["-o", "NumberOfPasswordPrompts=2"])
        .args(args)
        .env("SSH_ASKPASS", &exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(SOCKET_VAR, socket)
        .env(CREDENTIAL_VAR, credential)
        // ssh sets the hint only when it has one and leaves an inherited
        // value in place otherwise.
        .env_remove("SSH_ASKPASS_PROMPT")
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh could not run: {e}"))?;
    // ssh's messages pass straight through; an error that starts with the
    // flat file's name — `<file> line N:` or `<file>: line N:` — means a
    // setting did not survive the round trip. `-v` names it too, behind
    // `debug1: `.
    let named = file.display().to_string();
    let forwarded = child.stderr.take().map(|mut from| {
        std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = from.read(&mut buf) {
                let _ = std::io::stderr().write_all(&buf[..n]);
                if seen.len() < 64 * 1024 {
                    seen.extend_from_slice(&buf[..n]);
                }
            }
            String::from_utf8_lossy(&seen).lines().any(|l| l.strip_prefix(named.as_str()).is_some_and(|rest| rest.starts_with(" line ") || rest.starts_with(": ")))
        })
    });
    let status = child.wait().map_err(|e| format!("waiting for ssh: {e}"))?;
    if forwarded.and_then(|t| t.join().ok()).unwrap_or(false) {
        eprintln!("Agentic Workspace: an ssh setting for this host could not be carried over.");
    }
    Ok(status.code().unwrap_or(255))
}

// --- The askpass helper -------------------------------------------------------

/// The peer's pid and uid, from the kernel.
fn peer(stream: &UnixStream) -> Option<(u32, u32)> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for the kernel to write, and `len`
    // holds their size.
    let ok = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut libc::ucred as *mut libc::c_void, &mut len) } == 0;
    ok.then_some((cred.pid as u32, cred.uid))
}

fn uid() -> u32 {
    // SAFETY: getuid cannot fail and touches no memory.
    unsafe { libc::getuid() }
}

fn ask(prompt: &OsStr) -> i32 {
    // Nothing of this process — the answer above all — is to be read through
    // a core dump or ptrace by another of the user's processes.
    // SAFETY: changes a flag of this process only.
    unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
    let not_running = || {
        eprintln!("Agentic Workspace is not running, so no passphrase was given.");
        1
    };
    let Some(socket) = std::env::var_os(SOCKET_VAR) else { return not_running() };
    let Ok(mut stream) = UnixStream::connect(&socket) else { return not_running() };
    if peer(&stream).map(|(_, u)| u) != Some(uid()) {
        eprintln!("Agentic Workspace: the relay's socket belongs to another user; nothing was sent.");
        return 1;
    }
    let request = Request {
        credential: std::env::var(CREDENTIAL_VAR).ok(),
        prompt: BASE64.encode(prompt.as_bytes()),
        hint: std::env::var_os("SSH_ASKPASS_PROMPT").map(|h| h.to_string_lossy().into_owned()),
    };
    let Ok(mut line) = serde_json::to_vec(&request) else { return 1 };
    line.push(b'\n');
    if line.len() > MAX_REQUEST {
        eprintln!("Agentic Workspace: the prompt is too long to relay.");
        return 1;
    }
    // stdin is left alone: under git it is the protocol pipe.
    if stream.write_all(&line).is_err() {
        return not_running();
    }
    let mut text = String::new();
    if BufReader::new(&stream).take(MAX_REQUEST as u64).read_line(&mut text).is_err() {
        return not_running();
    }
    let Ok(reply) = serde_json::from_str::<Reply>(&text) else { return not_running() };
    match reply.answer {
        Some(answer) => {
            let mut out = std::io::stdout();
            let _ = out.write_all(answer.as_bytes()).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush());
            0
        }
        None => {
            if let Some(message) = reply.message {
                eprintln!("{message}");
            }
            1
        }
    }
}

// --- Classification -------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Kind {
    /// ssh asking for the passphrase of the credential's own key, byte for
    /// byte: the only prompt ever answered from the wallet.
    KeyPassphrase,
    /// A passphrase prompt for some other key.
    Passphrase,
    Host { host: String, fingerprint: Option<String> },
    Confirm,
    /// Something to show, not to answer: a security key waiting for a touch.
    Notice,
    Secret,
}

/// ssh's prompt for a key, with the path cut as `%.100s` cuts it: at 100
/// bytes, inside a character if that is where the hundredth byte falls.
fn passphrase_prompt(key_path: &str) -> Vec<u8> {
    let path = key_path.as_bytes();
    [b"Enter passphrase for key '".as_slice(), &path[..path.len().min(100)], b"': "].concat()
}

/// `user@host` from a keyboard-interactive prompt, which ssh prints as
/// `(%s@%s) %s`. Everything after that prefix is the server's to write, so a
/// prompt carrying it is never taken for one of ssh's own.
fn server_asking(prompt: &[u8]) -> Option<String> {
    let rest = prompt.strip_prefix(b"(")?;
    let end = rest.windows(2).position(|w| w == b") ")?;
    let who = &rest[..end];
    who.contains(&b'@').then(|| String::from_utf8_lossy(who).into_owned())
}

/// Whole prompts only, never a search inside one: server text arrives with
/// its `(user@host) ` prefix and can match none of these.
fn classify(prompt: &[u8], key_path: Option<&str>, hint: Option<&str>) -> Kind {
    if key_path.is_some_and(|p| prompt == passphrase_prompt(p)) {
        return Kind::KeyPassphrase;
    }
    if prompt.starts_with(b"Enter passphrase for key '") && prompt.ends_with(b"': ") {
        return Kind::Passphrase;
    }
    if prompt.starts_with(b"The authenticity of host '") && prompt.ends_with(b"(yes/no/[fingerprint])? ") {
        let text = String::from_utf8_lossy(prompt);
        let quoted = text.strip_prefix("The authenticity of host '").and_then(|t| t.split('\'').next()).unwrap_or_default();
        let host = quoted.split(" (").next().unwrap_or(quoted).to_string();
        let fingerprint = text
            .lines()
            .find_map(|l| l.split_once(" key fingerprint is"))
            .map(|(_, f)| f.trim_start_matches(':').trim().to_string())
            .filter(|f| !f.is_empty());
        return Kind::Host { host, fingerprint };
    }
    if server_asking(prompt).is_some() {
        return Kind::Secret;
    }
    if prompt.ends_with(b"(yes/no)? ") || prompt.ends_with(b"(yes/no): ") || hint == Some("confirm") {
        return Kind::Confirm;
    }
    if hint == Some("none") {
        return Kind::Notice;
    }
    Kind::Secret
}

// --- The relay ------------------------------------------------------------------

/// Starts the relay: a socket only this user can open, and a thread per
/// request, since a request may wait minutes on a person.
pub fn serve(app: &AppHandle) -> Result<(), String> {
    credentials::runtime_dir()?;
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).map_err(|e| format!("listening on {}: {e}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("{}: {e}", path.display()))?;
    SERVING.store(true, Ordering::Relaxed);
    let app = app.clone();
    std::thread::Builder::new()
        .name("askpass".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                let _ = std::thread::Builder::new().name("askpass-request".into()).spawn(move || handle(&app, stream));
            }
        })
        .map(|_| ())
        .map_err(|e| format!("starting the relay: {e}"))
}

/// Deletes the flat files and sockets left by instances that are gone: a
/// wrapper killed outright, an application that crashed.
pub fn sweep() {
    let Ok(dir) = credentials::runtime_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let pid = if let Some(rest) = name.strip_prefix("ssh-").filter(|_| name.ends_with(".conf")) {
            rest.split('-').next()
        } else {
            name.strip_prefix("askpass-").and_then(|r| r.strip_suffix(".sock"))
        };
        if let Some(pid) = pid.and_then(|p| p.parse::<u32>().ok()) {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn handle(app: &AppHandle, mut stream: UnixStream) {
    let Some((pid, peer_uid)) = peer(&stream) else { return };
    if peer_uid != uid() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = Vec::new();
    if BufReader::new(&stream).take(MAX_REQUEST as u64 + 1).read_until(b'\n', &mut line).is_err() {
        return;
    }
    let reply = if line.len() > MAX_REQUEST {
        Reply::message("Agentic Workspace: the prompt is too long to relay.".into())
    } else {
        match serde_json::from_slice::<Request>(&line) {
            Ok(request) => respond(app, pid, request, &stream),
            Err(_) => return,
        }
    };
    if let Ok(mut out) = serde_json::to_vec(&reply) {
        out.push(b'\n');
        let _ = stream.write_all(&out);
    }
}

/// Who asked, worked out from the process tree.
struct Asker {
    /// The ssh the helper was started by, when it was started by one.
    ssh: Option<u32>,
    who: Who,
}

enum Who {
    /// The application's own git for this workspace, and whether the main
    /// thread started it.
    App(String, bool),
    /// A shell in one of this workspace's terminals, or something under it.
    Terminal(String),
    Unknown,
}

fn parent(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold anything, spaces and
    // parentheses included; the fields after its last `)` are fixed.
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// The ssh on this system's path, resolved once. A helper whose parent runs
/// some other program called `ssh` could print what it is told.
fn ssh_program() -> Option<&'static Path> {
    static SSH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    SSH.get_or_init(|| {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path).map(|d| d.join("ssh")).find(|p| p.is_file()).and_then(|p| std::fs::canonicalize(p).ok())
    })
    .as_deref()
}

fn cmdline(pid: u32) -> Vec<Vec<u8>> {
    std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| b.split(|&c| c == 0).map(<[u8]>::to_vec).collect()).unwrap_or_default()
}

fn asker(state: &AppState, helper: u32) -> Asker {
    let ssh = parent(helper).filter(|&p| ssh_program().is_some_and(|ssh| std::fs::read_link(format!("/proc/{p}/exe")).is_ok_and(|exe| exe == ssh)));
    let Some(ssh) = ssh else { return Asker { ssh: None, who: Who::Unknown } };
    let mut chain = Vec::new();
    let mut pid = ssh;
    while chain.len() < 64 {
        match parent(pid) {
            Some(p) if p > 1 => {
                chain.push(p);
                pid = p;
            }
            _ => break,
        }
    }
    let children = state.git_children.lock().clone();
    let shells: std::collections::HashMap<u32, String> = state.ptys.lock().iter().filter_map(|(id, live)| live.pid.map(|p| (p, id.clone()))).collect();
    let who = chain
        .iter()
        .find_map(|p| {
            if let Some((workspace, main)) = children.get(p) {
                return Some(Who::App(workspace.clone(), *main));
            }
            let tab = shells.get(p)?;
            let workspace = state.session.lock().workspace_of_terminal_mut_ref(tab).map(|w| w.id.clone());
            Some(workspace.map_or(Who::Unknown, Who::Terminal))
        })
        .unwrap_or(Who::Unknown);
    Asker { ssh: Some(ssh), who }
}

/// Whether the wallet may answer for `key`: the asking ssh was handed that key
/// by the wrapper, and the workspace it asked for resolves to the key now —
/// for a terminal, with its terminal option on. Turning the option off, or
/// assigning another key, stops a shell started before from being answered.
fn trusted(state: &AppState, asker: &Asker, key: &SshKey) -> bool {
    let Some(ssh) = asker.ssh else { return false };
    let option = identity_option(&key.path);
    if !cmdline(ssh).iter().any(|a| a == option.as_bytes()) {
        return false;
    }
    let (Who::App(workspace, _) | Who::Terminal(workspace)) = &asker.who else { return false };
    let Some(scope) = credentials::scope(state, workspace) else { return false };
    let resolved = credentials::resolve(&state.settings.lock(), &scope);
    let assigned = matches!(&resolved.key, Assigned::Given(k) if k.id == key.id);
    assigned && (matches!(asker.who, Who::App(..)) || resolved.terminals)
}

fn origin(state: &AppState, who: &Who) -> String {
    let name = |id: &str| state.session.lock().workspace(id).map(|w| w.name.clone()).unwrap_or_else(|| id.to_string());
    match who {
        Who::App(id, _) => format!("{} (Source Control)", name(id)),
        Who::Terminal(id) => format!("a terminal of {}", name(id)),
        Who::Unknown => "an unknown process".into(),
    }
}

fn respond(app: &AppHandle, helper: u32, request: Request, stream: &UnixStream) -> Reply {
    let Ok(prompt) = BASE64.decode(&request.prompt) else { return Reply::default() };
    let state = app.state::<AppState>();
    let key = request.credential.as_deref().and_then(|id| state.settings.lock().credentials.keys.iter().find(|k| k.id == id).cloned());
    let kind = classify(&prompt, key.as_ref().map(|k| k.path.as_str()), request.hint.as_deref());
    let text = String::from_utf8_lossy(&prompt).into_owned();
    if kind == Kind::Notice {
        crate::session::inform(app, text);
        return Reply::default();
    }
    if kind == Kind::Passphrase && request.credential.is_some() && key.is_none() {
        return Reply::message("Agentic Workspace: the credential was removed; restart this shell.".into());
    }
    let asker = asker(&state, helper);
    if let (Kind::KeyPassphrase, Some(key)) = (&kind, &key) {
        if let Some(reply) = from_wallet(app, &state, &asker, key) {
            return reply;
        }
    }
    // The main thread waits on this git, and a dialog's answer would arrive
    // through it: the application would freeze for the whole wait.
    if matches!(asker.who, Who::App(_, true)) {
        return Reply::message("Agentic Workspace: this action cannot wait for an answer, so ssh's question was not asked. Press Fetch, answer it there, then try again.".into());
    }
    let (kind, title, host, fingerprint) = match kind {
        Kind::KeyPassphrase => ("passphrase", format!("Passphrase for {}", key.as_ref().map_or("the key", |k| k.name.as_str())), None, None),
        Kind::Passphrase => {
            let path = text.strip_prefix("Enter passphrase for key '").and_then(|t| t.strip_suffix("': ")).unwrap_or_default();
            ("passphrase", format!("Passphrase for {path}"), None, None)
        }
        Kind::Host { host, fingerprint } => ("host", format!("Trust {host}?"), Some(host), fingerprint),
        Kind::Confirm => ("confirm", "ssh asks".to_string(), None, None),
        Kind::Secret | Kind::Notice => {
            let title = server_asking(&prompt).map_or_else(|| "ssh asks for a secret".to_string(), |who| format!("{who} asks"));
            ("secret", title, None, None)
        }
    };
    let prompt = CredentialPrompt {
        id: crate::state::new_id(),
        window: if matches!(asker.who, Who::Terminal(_)) { "terminal" } else { "workspace" }.into(),
        kind: kind.into(),
        title,
        text,
        host,
        fingerprint,
        origin: origin(&state, &asker.who),
    };
    match ask_user(app, &state, prompt, stream) {
        Outcome::Answer(answer) => Reply { answer: Some(answer), message: None },
        Outcome::Declined => Reply::default(),
        Outcome::TimedOut => Reply::message("Agentic Workspace: no answer within 5 minutes.".into()),
    }
}

/// The wallet's answer for the credential's own key, or `None` to ask the
/// user instead: the ask did not pass `trusted`, nothing is saved, or the
/// saved passphrase was just refused.
fn from_wallet(app: &AppHandle, state: &AppState, asker: &Asker, key: &SshKey) -> Option<Reply> {
    if !key.saved || !trusted(state, asker, key) {
        return None;
    }
    let ssh = asker.ssh?;
    let retried = {
        let mut prompts = state.prompts.lock();
        prompts.answered.retain(|(_, at)| at.elapsed() < RETRY_WINDOW);
        prompts.answered.iter().any(|(pid, _)| *pid == ssh)
    };
    if retried {
        crate::session::notice(app, format!("The passphrase saved for {} no longer opens it.", key.name));
        return None;
    }
    Some(match tauri::async_runtime::block_on(secret::lookup(&key.id)) {
        Ok(Some(passphrase)) => {
            state.prompts.lock().answered.push((ssh, Instant::now()));
            Reply { answer: Some(passphrase), message: None }
        }
        Ok(None) => return None,
        Err(SecretError::StayedLocked) => Reply::message(format!("Agentic Workspace: the wallet stayed locked, so the passphrase for {} was not read.", key.name)),
        Err(SecretError::NoWallet(_)) => Reply::message(format!("Agentic Workspace: no wallet answers, so the passphrase for {} was not read.", key.name)),
        Err(SecretError::Failed(e)) => Reply::message(format!("Agentic Workspace: the passphrase for {} could not be read from the wallet ({e}).", key.name)),
    })
}

/// Shows the prompt in its window and waits for the answer, five minutes at
/// most, or until the helper hangs up: an ssh killed meanwhile leaves no
/// dialog behind holding the window's keyboard. The lock is never held
/// across the wait.
fn ask_user(app: &AppHandle, state: &AppState, prompt: CredentialPrompt, stream: &UnixStream) -> Outcome {
    let (tx, rx) = mpsc::channel();
    let token = crate::state::new_id();
    let tx = (token.clone(), tx);
    let (id, fresh) = {
        let mut prompts = state.prompts.lock();
        let shared = matches!(prompt.kind.as_str(), "host" | "confirm");
        let same = prompts.pending.iter_mut().find(|p| {
            shared && p.prompt.kind == prompt.kind && p.prompt.text == prompt.text && p.prompt.window == prompt.window && p.prompt.origin == prompt.origin
        });
        match same {
            Some(p) => {
                p.waiters.push(tx);
                (p.prompt.id.clone(), false)
            }
            None => {
                prompts.pending.push(Pending { prompt: prompt.clone(), waiters: vec![tx] });
                (prompt.id.clone(), true)
            }
        }
    };
    if fresh {
        let handle = app.clone();
        let label = prompt.window.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = crate::windows::show(&handle, &label) {
                eprintln!("agentic-workspace: could not show the {label} window for a prompt ({e:#})");
            }
        });
        let _ = app.emit(EVENT_PROMPT, &prompt);
    }
    // The helper writes nothing after its request, so a read returns only
    // when it exits. The clone shares the socket's 10 s request timeout,
    // which the wait must outlast.
    let watch = stream.try_clone().ok().filter(|w| w.set_read_timeout(None).is_ok());
    if let Some(mut w) = watch.as_ref().and_then(|w| w.try_clone().ok()) {
        let handle = app.clone();
        let _ = std::thread::Builder::new().name("askpass-watch".into()).spawn(move || {
            let mut byte = [0u8; 1];
            while matches!(w.read(&mut byte), Ok(n) if n > 0) {}
            hung_up(&handle, &token);
        });
    }
    let outcome = match rx.recv_timeout(ANSWER_WITHIN) {
        Ok(outcome) => outcome,
        // `hung_up` dropped the sender: nobody is left to answer.
        Err(mpsc::RecvTimeoutError::Disconnected) => Outcome::Declined,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            settle(app, state, &id, || Outcome::TimedOut);
            Outcome::TimedOut
        }
    };
    // Ends the watch; its waiter is settled already, so `hung_up` finds
    // nothing to do.
    if let Some(w) = &watch {
        let _ = w.shutdown(std::net::Shutdown::Read);
    }
    outcome
}

/// A helper hung up, its ssh gone: its waiter leaves the prompt, and the
/// last one to leave takes the dialog with it.
fn hung_up(app: &AppHandle, token: &str) {
    let state = app.state::<AppState>();
    let closed = {
        let mut prompts = state.prompts.lock();
        let Some(i) = prompts.pending.iter().position(|p| p.waiters.iter().any(|(t, _)| t == token)) else { return };
        prompts.pending[i].waiters.retain(|(t, _)| t != token);
        prompts.pending[i].waiters.is_empty().then(|| prompts.pending.remove(i).prompt.id)
    };
    if let Some(id) = closed {
        let _ = app.emit(EVENT_PROMPT_CLOSED, &id);
    }
}

/// Takes the prompt off the list, hands every waiter the outcome and tells the
/// windows it is gone.
fn settle(app: &AppHandle, state: &AppState, id: &str, outcome: impl Fn() -> Outcome) {
    let taken = {
        let mut prompts = state.prompts.lock();
        prompts.pending.iter().position(|p| p.prompt.id == id).map(|i| prompts.pending.remove(i))
    };
    if let Some(taken) = taken {
        for (_, waiter) in taken.waiters {
            let _ = waiter.send(outcome());
        }
        let _ = app.emit(EVENT_PROMPT_CLOSED, id);
    }
}

#[tauri::command]
pub fn credential_prompts(state: tauri::State<AppState>) -> Result<Vec<CredentialPrompt>, String> {
    Ok(state.prompts.lock().pending.iter().map(|p| p.prompt.clone()).collect())
}

/// `None` declines. A host key or a confirmation is answered `yes` whatever
/// the window sent; ssh writes `known_hosts` itself.
#[tauri::command]
pub fn credential_prompt_answer(app: AppHandle, state: tauri::State<AppState>, id: String, answer: Option<String>) -> Result<(), String> {
    let kind = state.prompts.lock().pending.iter().find(|p| p.prompt.id == id).map(|p| p.prompt.kind.clone());
    let Some(kind) = kind else { return Ok(()) };
    let answer = match (kind.as_str(), answer) {
        (_, None) => None,
        ("host" | "confirm", Some(_)) => Some("yes".to_string()),
        (_, Some(answer)) => Some(answer),
    };
    settle(&app, &state, &id, || answer.clone().map_or(Outcome::Declined, Outcome::Answer));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ssh -G` of OpenSSH 10.5p1 for a host setting every value that does not
    /// read back as printed, trimmed to those lines and a few that do.
    const TRICKY: &str = "host tricky
user first last
hostname 127.0.0.1
port 2222
controlmaster auto
identitiesonly yes
numberofpasswordprompts 3
obscurekeystroketiming 40
controlpath /home/kk/.ssh/cm-3993d1465df1ab11f1a45817ad6194615c30aaa7
hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256
hostkeyalias my alias
identityfile ~/.ssh/other_key
globalknownhostsfile /etc/ssh/ssh_known_hosts
userknownhostsfile /tmp/kh dir/known hosts /home/kk/.ssh/kh2
revokedhostkeys none
setenv GREETING=hello world
setenv A=1
addkeystoagent false
forwardagent yes
controlpersist no
escapechar \\^A
ipqos ef cs0
";

    const DEFAULT_ALGORITHMS: &str = "hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256";

    #[test]
    fn a_flattened_configuration_has_no_identity_and_reads_back_as_printed() {
        let flat = flatten(TRICKY, Some(DEFAULT_ALGORITHMS));
        let lines: Vec<&str> = flat.lines().collect();
        assert_eq!(lines[0], "host tricky");
        for dropped in ["identityfile", "identitiesonly", "controlmaster", "controlpath", "controlpersist", "addkeystoagent", "forwardagent", "numberofpasswordprompts"] {
            assert!(!lines.iter().any(|l| l.starts_with(dropped)), "{dropped} survived");
        }
        // The default list, written out, would count as set.
        assert!(!lines.iter().any(|l| l.starts_with("hostkeyalgorithms")));
        assert!(lines.contains(&"user \"first last\""));
        assert!(lines.contains(&"hostkeyalias \"my alias\""));
        assert!(lines.contains(&"obscurekeystroketiming interval:40"));
        assert!(lines.contains(&"escapechar ^A"));
        assert!(lines.contains(&"userknownhostsfile \"/tmp/kh dir/known hosts\" \"/home/kk/.ssh/kh2\""));
        assert!(lines.contains(&"globalknownhostsfile \"/etc/ssh/ssh_known_hosts\""));
        assert!(lines.contains(&"setenv \"GREETING=hello world\" \"A=1\""));
        assert_eq!(lines.iter().filter(|l| l.starts_with("setenv")).count(), 1);
        // What reads back as printed stays as printed.
        for kept in ["hostname 127.0.0.1", "port 2222", "revokedhostkeys none", "ipqos ef cs0"] {
            assert!(lines.contains(&kept), "{kept} lost");
        }
        assert!(!flat.contains("Match"));
    }

    #[test]
    fn a_list_the_user_set_is_kept_and_a_jump_host_reads_the_users_own_configuration() {
        let set = "host hk\nhostname 10.0.0.6\nhostkeyalgorithms ssh-ed25519,ecdsa-sha2-nistp256\n";
        assert!(flatten(set, Some(DEFAULT_ALGORITHMS)).contains("hostkeyalgorithms ssh-ed25519,ecdsa-sha2-nistp256\n"));

        let jump = "host viajump\nhostname 10.0.0.5\nproxyjump jumpbox\nobscurekeystroketiming yes\nescapechar ~\n";
        let flat = flatten(jump, None);
        assert!(flat.contains("obscurekeystroketiming yes\nescapechar ~\n"));
        assert!(flat.ends_with("proxyjump jumpbox\nobscurekeystroketiming yes\nescapechar ~\nMatch !originalhost viajump\n    Include ~/.ssh/config /etc/ssh/ssh_config\n"));
        assert!(!flatten("host direct\nproxyjump none\n", None).contains("Match"));
    }

    #[test]
    fn an_identity_path_is_one_word_with_every_percent_doubled() {
        assert_eq!(identity_option("/home/kk/.ssh/id_ed25519"), "IdentityFile=\"/home/kk/.ssh/id_ed25519\"");
        assert_eq!(identity_option("/k/100%h %%d"), "IdentityFile=\"/k/100%%h %%%%d\"");
        assert_eq!(identity_option("/k/it's \"q\" \\x"), "IdentityFile=\"/k/it's \\\"q\\\" \\\\x\"");
    }

    #[test]
    fn prompts_are_told_apart_by_the_whole_text() {
        // A path whose hundredth byte falls inside `ç`: ssh cuts it there.
        let path = format!("/home/kk/.ssh/{}ção", "a".repeat(85));
        assert_eq!(path.as_bytes()[99], 0xc3);
        let mut exact = b"Enter passphrase for key '".to_vec();
        exact.extend_from_slice(&path.as_bytes()[..100]);
        exact.extend_from_slice(b"': ");
        assert_eq!(classify(&exact, Some(&path), None), Kind::KeyPassphrase);
        // The same prompt for a key other than the credential's.
        assert_eq!(classify(&exact, Some("/home/kk/.ssh/other"), None), Kind::Passphrase);
        // ssh's hint for a passphrase is none at all; a stray inherited one
        // does not turn it into a notice.
        assert_eq!(classify(&exact, Some(&path), Some("none")), Kind::KeyPassphrase);

        // Server text arrives behind `(user@host) ` and matches nothing of ssh's.
        let fake = format!("(git@evil.example) Enter passphrase for key '{path}': ");
        assert_eq!(classify(fake.as_bytes(), Some(&path), None), Kind::Secret);
        let fake_host = b"(git@evil.example) The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is: SHA256:forged\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(classify(fake_host, None, None), Kind::Secret);
        assert_eq!(server_asking(fake_host).as_deref(), Some("git@evil.example"));
        assert_eq!(classify(b"(git@evil.example) Proceed (yes/no)? ", None, None), Kind::Secret);

        let host = b"The authenticity of host '[127.0.0.1]:35005 ([127.0.0.1]:35005)' can't be established.\nED25519 key fingerprint is: SHA256:GudDq0zD2QJ3b4n\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(classify(host, None, None), Kind::Host { host: "[127.0.0.1]:35005".into(), fingerprint: Some("SHA256:GudDq0zD2QJ3b4n".into()) });
        let older = b"The authenticity of host 'git.example (10.0.0.1)' can't be established.\nECDSA key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(classify(older, None, None), Kind::Host { host: "git.example".into(), fingerprint: Some("SHA256:abc.".into()) });

        assert_eq!(classify(b"Are you sure you want to continue connecting (yes/no)? ", None, None), Kind::Confirm);
        assert_eq!(classify(b"Accept updated hostkeys? (yes/no): ", None, None), Kind::Confirm);
        assert_eq!(classify(b"Allow shared connection to git.example? ", None, Some("confirm")), Kind::Confirm);
        assert_eq!(classify(b"Confirm user presence for key ED25519-SK SHA256:x", None, Some("none")), Kind::Notice);
        assert_eq!(classify(b"Enter PIN for ED25519-SK key /home/kk/.ssh/id_sk: ", None, None), Kind::Secret);
    }
}

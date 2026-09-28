//! SSH keys and commit identities a workspace's git runs with, and what its
//! terminals may carry. A key file stays where it is in `~/.ssh` and its
//! passphrase in the wallet (`secret`); the settings record only which key and
//! identity a workspace uses, and only the commands here change that (CRED-02).

use crate::desktop::APP_ID;
use crate::secret::{self, SecretError};
use crate::settings::{self, Identity, Settings, SshKey, WorkspaceSettings};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tauri::{AppHandle, Emitter, Manager};

/// What the Credentials page shows beside the stored credentials.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub wallet: WalletStatus,
    /// Keyed by credential id.
    pub keys: HashMap<String, KeyStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    pub available: bool,
    /// The Secret Service provider: GNOME Keyring, KWallet, KeePassXC.
    pub name: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    /// The key file is gone.
    pub missing: bool,
    /// Why ssh would refuse the key, such as permissions that are too open.
    pub problem: Option<String>,
    /// The wallet holds its passphrase.
    pub stored: bool,
}

/// A private key file in `~/.ssh`, offered by *Add SSH key*.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub path: String,
    pub name: String,
    pub fingerprint: Option<String>,
    /// `None` when ssh-keygen could not tell.
    pub protected: Option<bool>,
    pub problem: Option<String>,
}

// --- The runtime directory ----------------------------------------------------

/// `$XDG_RUNTIME_DIR/<APP_ID>`: the relay's socket, the wrapper's flattened ssh
/// configurations and the terminals' git configurations. Everything there
/// steers or answers ssh, so the directory has to be this user's alone, and
/// there is no fallback: in a shared `/tmp` another user could plant the
/// socket and answer a host-key question, or swap a configuration before ssh
/// reads it.
pub fn runtime_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("XDG_RUNTIME_DIR is not set, and nowhere else is private enough")?;
    private(&base)?;
    let dir = base.join(APP_ID);
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => Ok(dir),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => private(&dir).map(|()| dir),
        Err(e) => Err(format!("creating {}: {e}", dir.display())),
    }
}

/// A directory, not a link to one, owned by this user and closed to everyone
/// else.
fn private(dir: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // SAFETY: getuid cannot fail and touches no memory.
    let uid = unsafe { libc::getuid() };
    if !meta.file_type().is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(format!("{} is not a directory only this user can open", dir.display()));
    }
    Ok(())
}

/// Writes `text` to `path`, readable by this user only, through a new file
/// renamed into place: a shell's git may read the file at any moment.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = crate::store::tmp_path(path);
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

// --- Quoting ------------------------------------------------------------------

/// Single-quotes a word for the shell git runs `GIT_SSH_COMMAND` and
/// `core.sshCommand` through.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A git configuration value in double quotes. Control characters other than
/// these are refused where they enter, so none reaches here.
fn git_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str(r"\n"),
            '\t' => out.push_str(r"\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn no_controls(value: &str, what: &str) -> Result<String, String> {
    let value = value.trim();
    if value.chars().any(char::is_control) {
        return Err(format!("The {what} cannot hold control characters."));
    }
    Ok(value.to_string())
}

// --- Resolution -----------------------------------------------------------------

/// A workspace as the credential code sees it.
pub struct Scope {
    pub path: PathBuf,
    /// For a linked worktree, where its unset fields come from: the
    /// workspace on its repository, so a new worktree pushes and commits as
    /// the repository does.
    pub repository: Option<PathBuf>,
    /// The repository's common git directory. Terminal credentials apply
    /// inside it and nowhere else, so `cd ../other` keeps the user's setup;
    /// without one, inside every repository under the workspace.
    pub common_dir: Option<PathBuf>,
}

/// Reads the workspace from the session and its repository from the git
/// summary. Before the summaries are in — launch starts the active
/// workspace's shells first — the repository is read from the files git
/// keeps.
pub fn scope(state: &AppState, workspace_id: &str) -> Option<Scope> {
    let (path, repository, summary) = {
        let session = state.session.lock();
        let ws = session.workspace(workspace_id)?;
        let repository = ws.worktree_of.as_deref().and_then(|r| session.workspace(r)).map(|r| r.path.clone());
        let summary = state.git.lock().get(workspace_id).map(|g| {
            let main = g.worktrees.iter().find(|w| w.is_main).map(|w| PathBuf::from(&w.path));
            (g.is_repo, g.is_worktree, g.common_dir.clone(), main)
        });
        (ws.path.clone(), repository, summary)
    };
    // A worktree whose repository is not open falls back to the main
    // worktree: the one git lists first, as the Workspace page reads it, or
    // before the summary is in, the directory holding the common `.git`.
    let (linked, common_dir, main) = match summary {
        Some((true, linked, Some(common), main)) => (linked, Some(common), main),
        Some((false, ..)) => (false, None, None),
        _ => repository_of(&path).map_or((false, None, None), |r| {
            let main = r.common_dir.parent().filter(|_| r.common_dir.file_name() == Some(OsStr::new(".git"))).map(Path::to_path_buf);
            (r.linked, Some(r.common_dir), main)
        }),
    };
    let repository = linked.then(|| repository.or(main)).flatten();
    Some(Scope { path, repository, common_dir })
}

pub struct Repository {
    pub common_dir: PathBuf,
    /// A linked worktree rather than the repository's own working tree.
    pub linked: bool,
}

/// The repository `dir` is in, from the files git keeps: the first `.git`
/// above it, a directory or a `gitdir:` file, and the linked worktree's
/// `commondir`. A bare repository is its own common directory. Git answers
/// the same through `rev-parse`; this exists for the shells launch starts
/// before any summary is in.
pub fn repository_of(dir: &Path) -> Option<Repository> {
    for d in dir.ancestors() {
        let dot = d.join(".git");
        match std::fs::metadata(&dot) {
            Ok(meta) if meta.is_dir() => return Some(Repository { common_dir: dot, linked: false }),
            Ok(_) => {
                let text = std::fs::read_to_string(&dot).ok()?;
                let target = text.lines().next()?.strip_prefix("gitdir:")?.trim();
                let git_dir = lexical(&d.join(target));
                return Some(match std::fs::read_to_string(git_dir.join("commondir")) {
                    Ok(common) => Repository { common_dir: lexical(&git_dir.join(common.trim_end_matches(['\n', '\r']))), linked: true },
                    // A submodule's `.git` names a git directory of its own.
                    Err(_) => Repository { common_dir: git_dir, linked: false },
                });
            }
            Err(_) if d.join("HEAD").is_file() && d.join("objects").is_dir() && d.join("refs").is_dir() => {
                return Some(Repository { common_dir: d.to_path_buf(), linked: false });
            }
            Err(_) => {}
        }
    }
    None
}

/// `..` resolved against the path itself, not the filesystem: the result is
/// compared with paths the user opened, which keep their symlinks.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// A field's value once unset has fallen through to the repository.
pub enum Assigned<T> {
    /// The user's own ssh setup, or their own git configuration.
    Own,
    Given(T),
    /// An id nothing in the settings holds any more.
    Dangling(String),
}

pub struct Resolved {
    pub key: Assigned<SshKey>,
    pub identity: Assigned<Identity>,
    /// The workspace's own terminal option: never inherited (decision 4).
    pub terminals: bool,
}

fn settings_key(path: &Path) -> String {
    path.display().to_string()
}

pub fn resolve(settings: &Settings, scope: &Scope) -> Resolved {
    let own = settings.workspaces.get(&settings_key(&scope.path));
    let inherited = scope.repository.as_ref().and_then(|r| settings.workspaces.get(&settings_key(r)));
    // `None` falls through to the repository; `Some("")` is an explicit
    // choice of the user's own setup and stops there.
    let field = |get: fn(&WorkspaceSettings) -> &Option<String>| own.and_then(|w| get(w).clone()).or_else(|| inherited.and_then(|w| get(w).clone()));
    let key = match field(|w| &w.ssh_key).as_deref() {
        None | Some("") => Assigned::Own,
        Some(id) => settings.credentials.keys.iter().find(|k| k.id == id).cloned().map_or_else(|| Assigned::Dangling(id.to_string()), Assigned::Given),
    };
    let identity = match field(|w| &w.identity).as_deref() {
        None | Some("") => Assigned::Own,
        Some(id) => settings.credentials.identities.iter().find(|i| i.id == id).cloned().map_or_else(|| Assigned::Dangling(id.to_string()), Assigned::Given),
    };
    Resolved { key, identity, terminals: own.is_some_and(|w| w.terminal_credentials) }
}

fn dangling(id: &str) -> String {
    format!("This workspace is assigned a credential that no longer exists ({id}).")
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "agentic-workspace".into())
}

/// What git runs as its ssh for a workspace with a key: this binary as the
/// wrapper (`askpass`), which hands ssh that key and nothing else.
fn ssh_command(key: &SshKey) -> Result<String, String> {
    // ssh expands `${VAR}` in an identity path and has no escape for it.
    if key.path.contains('$') {
        return Err(format!("ssh cannot use {}: it would read the `$` in its path as a variable.", key.path));
    }
    let socket = crate::askpass::socket_path().display().to_string();
    Ok(format!("{} --agentic-ssh {} {} {}", sh_quote(&exe()), sh_quote(&socket), sh_quote(&key.path), sh_quote(&key.id)))
}

/// The environment the application's own git runs in for a workspace. A key
/// goes through the wrapper, which sets the askpass variables for ssh alone;
/// without one, ssh's prompts still reach a dialog (CRED-08, every
/// workspace) while git's own HTTPS prompts keep the user's askpass chain:
/// git asks `GIT_ASKPASS`, then `core.askPass`, then `SSH_ASKPASS`, and only
/// that last fallback, now the application's helper, is blocked. An identity
/// sets all four variables: the author's alone leave the committer to the
/// configuration.
pub fn git_env(resolved: &Resolved) -> Result<Vec<(String, String)>, String> {
    let mut env = Vec::new();
    match &resolved.key {
        Assigned::Given(key) => {
            env.push(("GIT_SSH_COMMAND".to_string(), ssh_command(key)?));
            // Skips the probe git otherwise runs to learn what the command
            // is, which would be a second whole run of the wrapper.
            env.push(("GIT_SSH_VARIANT".to_string(), "ssh".to_string()));
        }
        Assigned::Own if crate::askpass::serving() => {
            env.push(("SSH_ASKPASS".to_string(), exe()));
            env.push(("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()));
            env.push((crate::askpass::SOCKET_VAR.to_string(), crate::askpass::socket_path().display().to_string()));
            // An inherited `GIT_ASKPASS` wins already. Otherwise it stands in
            // for the user's own `SSH_ASKPASS`, or, empty, turns the prompt
            // off; `Repo::keep_core_askpass` takes it back out where the
            // repository sets `core.askPass`.
            if std::env::var_os("GIT_ASKPASS").is_none() {
                env.push(("GIT_ASKPASS".to_string(), std::env::var("SSH_ASKPASS").unwrap_or_default()));
            }
        }
        Assigned::Own => {}
        Assigned::Dangling(id) => return Err(dangling(id)),
    }
    match &resolved.identity {
        Assigned::Given(i) => {
            for (name, value) in [("NAME", &i.name), ("EMAIL", &i.email)] {
                env.push((format!("GIT_AUTHOR_{name}"), value.clone()));
                env.push((format!("GIT_COMMITTER_{name}"), value.clone()));
            }
        }
        Assigned::Own => {}
        Assigned::Dangling(id) => return Err(dangling(id)),
    }
    Ok(env)
}

/// Names a variable the terminal environment adds, so an application started
/// from such a shell can take it out again (`forget_inherited_env`).
const GIT_CONFIG_MARK: &str = "AGENTIC_WORKSPACE_GIT_CONFIG";

fn terminal_config(dir: &Path, workspace_id: &str) -> PathBuf {
    dir.join(format!("terminal-{workspace_id}.gitconfig"))
}

/// The `includeIf.gitdir:` patterns that match the repository's own git
/// directory and its linked worktrees' and nothing else. A pattern is a glob,
/// so the path's own `*`, `?`, `[` and `\` are escaped: unescaped, a
/// repository under `proj[12]/` would match `proj1/` and never itself. The
/// worktrees' pattern ends in `*`, which stops at a `/`, rather than in `/`,
/// which git widens to `**`: that would reach a submodule's git directory,
/// kept under `modules/` in either directory — another repository, possibly
/// on another account.
fn include_patterns(common: &Path) -> Vec<String> {
    let glob = glob_escape(common);
    let worktrees = format!("{glob}/worktrees/*");
    vec![glob, worktrees]
}

fn glob_escape(path: &Path) -> String {
    let mut glob = String::new();
    for c in path.display().to_string().chars() {
        if matches!(c, '*' | '?' | '[' | '\\') {
            glob.push('\\');
        }
        glob.push(c);
    }
    glob
}

/// Where the workspace's terminal configuration applies: its repository, or,
/// for a workspace that is not in one, every repository under it — a pattern
/// ending in `/`, which git widens to `**`.
fn terminal_patterns(scope: &Scope) -> Vec<String> {
    match &scope.common_dir {
        Some(common) => include_patterns(common),
        None => vec![format!("{}/", glob_escape(&scope.path))],
    }
}

/// The variables a shell of the workspace starts with: none, unless its own
/// terminal option is on (CRED-06). Then git configuration entries, appended
/// after any the user's environment holds, include the workspace's terminal
/// configuration inside its repositories alone (`terminal_patterns`), so
/// `cd ../other && git push` keeps the user's own setup. Git skips
/// an include whose file is gone, which is how turning the option off takes
/// effect in shells already running.
pub fn terminal_env(settings: &Settings, scope: &Scope, workspace_id: &str) -> Vec<(String, String)> {
    let on = settings.workspaces.get(&settings_key(&scope.path)).is_some_and(|w| w.terminal_credentials);
    let (true, Ok(dir)) = (on, runtime_dir()) else { return Vec::new() };
    let n: usize = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let file = terminal_config(&dir, workspace_id).display().to_string();
    let patterns = terminal_patterns(scope);
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), (n + patterns.len()).to_string()), (GIT_CONFIG_MARK.to_string(), n.to_string())];
    for (i, pattern) in patterns.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{}", n + i), format!("includeIf.gitdir:{pattern}.path")));
        env.push((format!("GIT_CONFIG_VALUE_{}", n + i), file.clone()));
    }
    env
}

fn terminal_config_text(settings: &Settings, scope: &Scope) -> Result<String, String> {
    let resolved = resolve(settings, scope);
    let mut text = String::new();
    if resolved.terminals {
        if let Assigned::Given(key) = &resolved.key {
            text.push_str(&format!("[core]\n\tsshCommand = {}\n[ssh]\n\tvariant = ssh\n", git_quote(&ssh_command(key)?)));
        }
        if let Assigned::Given(identity) = &resolved.identity {
            let (name, email) = (git_quote(&identity.name), git_quote(&identity.email));
            // `author.*` and `committer.*` beat `user.*` from any scope, which
            // is why the application's own git sets all four variables.
            for section in ["user", "author", "committer"] {
                text.push_str(&format!("[{section}]\n\tname = {name}\n\temail = {email}\n"));
            }
        }
    }
    Ok(text)
}

/// The workspace's terminal configuration: the key's `sshCommand` and the
/// identity, when its terminal option is on and something resolves; removed
/// otherwise. One that cannot be brought up to date is removed too, so its
/// shells lose the credentials rather than keep ones since taken away. The
/// caller holds the settings lock from reading `settings` to this return: a
/// write from an older view of them would undo a newer one.
pub fn write_terminal_config(settings: &Settings, scope: &Scope, workspace_id: &str) -> Result<(), String> {
    let text = terminal_config_text(settings, scope);
    let dir = match runtime_dir() {
        Ok(dir) => dir,
        // Without the directory nothing was ever written there.
        Err(_) if text.as_ref().is_ok_and(String::is_empty) => return Ok(()),
        Err(e) => return Err(e),
    };
    let path = terminal_config(&dir, workspace_id);
    let written = match text {
        Ok(text) if text.is_empty() => Ok(()),
        Ok(text) => match write_private(&path, &text) {
            Ok(()) => return Ok(()),
            Err(e) => Err(format!("writing {}: {e}", path.display())),
        },
        Err(e) => Err(e),
    };
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => written.and(Err(format!("removing {}: {e}", path.display()))),
        _ => written,
    }
}

/// Rewrites every open workspace's terminal configuration and removes those
/// of workspaces no longer open. Run at launch and after every credential or
/// assignment change, so opted-in shells follow the change at once. One
/// workspace that fails stops none of the others.
pub fn write_terminal_configs(app: &AppHandle) {
    let state = app.state::<AppState>();
    let ids: Vec<String> = state.session.lock().workspaces.iter().map(|w| w.id.clone()).collect();
    let scopes: Vec<(&String, Scope)> = ids.iter().filter_map(|id| scope(&state, id).map(|s| (id, s))).collect();
    let failed: Vec<String> = {
        let settings = state.settings.lock();
        scopes.iter().filter_map(|(id, scope)| write_terminal_config(&settings, scope, id).err()).collect()
    };
    if !failed.is_empty() {
        crate::session::notice(app, format!("Terminal credentials could not be updated: {}", failed.join("; ")));
    }
    let Ok(dir) = runtime_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    // Read again: a workspace opened while the files were written has its
    // own already.
    let ids: Vec<String> = state.session.lock().workspaces.iter().map(|w| w.id.clone()).collect();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let open = name.strip_prefix("terminal-").and_then(|n| n.strip_suffix(".gitconfig")).map(|id| ids.iter().any(|i| i == id));
        if open == Some(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// An application started from a shell that carries a workspace's
/// credentials — `pnpm tauri dev` in an opted-in terminal — would otherwise
/// hand them to every git and every shell of its own. Run first thing, before
/// any thread starts.
pub fn forget_inherited_env() {
    if let Some(n) = std::env::var(GIT_CONFIG_MARK).ok().and_then(|v| v.parse::<usize>().ok()) {
        // One entry or two; a second index past the count is nobody's.
        for i in [n, n + 1] {
            std::env::remove_var(format!("GIT_CONFIG_KEY_{i}"));
            std::env::remove_var(format!("GIT_CONFIG_VALUE_{i}"));
        }
        if n == 0 {
            std::env::remove_var("GIT_CONFIG_COUNT");
        } else {
            std::env::set_var("GIT_CONFIG_COUNT", n.to_string());
        }
    }
    let ours: Vec<_> = std::env::vars_os().map(|(k, _)| k).filter(|k| k.to_string_lossy().starts_with("AGENTIC_WORKSPACE_")).collect();
    for name in ours {
        std::env::remove_var(name);
    }
}

// --- Keys on disk ---------------------------------------------------------------

fn ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let dir = home.join(".ssh");
    std::fs::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))
}

/// A private key by its first line, which is all that is read of it.
fn is_private_key(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name.ends_with(".pub") || ["known_hosts", "authorized_keys", "config"].iter().any(|p| name.starts_with(p)) {
        return false;
    }
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
        return false;
    }
    let mut head = Vec::new();
    if std::fs::File::open(path).and_then(|f| f.take(80).read_to_end(&mut head)).is_err() {
        return false;
    }
    let line = head.split(|&b| b == b'\n').next().unwrap_or_default();
    let line = String::from_utf8_lossy(line);
    let line = line.trim_end_matches('\r');
    line.starts_with("-----BEGIN ") && line.ends_with("PRIVATE KEY-----")
}

/// Runs ssh-keygen with no way to ask anyone anything: no askpass, and in a
/// session of its own, so it has no terminal to open — a development build
/// started from one would otherwise read `/dev/tty`. A passphrase goes in on
/// stdin, never on the command line where any process can read it.
fn keygen(args: &[&OsStr], input: Option<&[u8]>) -> std::io::Result<Output> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("ssh-keygen");
    crate::desktop::clean_child_env(&mut cmd);
    cmd.args(args)
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: setsid is async-signal-safe and touches no memory of ours.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        // A key that needs nothing exits without reading.
        let _ = stdin.write_all(bytes);
    }
    child.wait_with_output()
}

/// ssh-keygen's complaint, without the prompt it printed on the same line.
fn stderr_line(out: &Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let line = text.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("ssh-keygen failed");
    line[line.find("Load key ").unwrap_or(0)..].trim().to_string()
}

/// `SHA256:…` from ssh-keygen's listing.
fn fingerprint_in(out: &Output) -> Option<String> {
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).split_whitespace().nth(1).map(str::to_string)).flatten()
}

/// From the `.pub` beside the key, else the private file, which ssh-keygen
/// reads without a passphrase except in the old PEM format.
fn fingerprint(path: &Path) -> Option<String> {
    let list = |p: &Path| p.is_file().then(|| keygen(&["-l".as_ref(), "-f".as_ref(), p.as_os_str()], None).ok()).flatten().as_ref().and_then(fingerprint_in);
    list(Path::new(&format!("{}.pub", path.display()))).or_else(|| list(path))
}

fn too_open(path: &Path) -> Option<String> {
    let mode = std::fs::metadata(path).ok()?.permissions().mode() & 0o777;
    (mode & 0o077 != 0).then(|| format!("ssh refuses this key: its permissions are too open ({mode:04o}). chmod 600 {} fixes it.", path.display()))
}

/// Whether the key needs a passphrase, by trying the empty one; and what
/// stops ssh from using it, if anything does.
fn protection(path: &Path) -> (Option<bool>, Option<String>) {
    if let Some(problem) = too_open(path) {
        return (None, Some(problem));
    }
    match keygen(&["-y".as_ref(), "-P".as_ref(), "".as_ref(), "-f".as_ref(), path.as_os_str()], None) {
        Ok(out) if out.status.success() => (Some(false), None),
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stderr);
            if text.contains("incorrect passphrase") {
                (Some(true), None)
            } else if text.contains("bad permissions") || text.contains("UNPROTECTED PRIVATE KEY FILE") {
                (None, Some(format!("ssh refuses this key's permissions. chmod 600 {} fixes it.", path.display())))
            } else {
                (None, Some(stderr_line(&out)))
            }
        }
        Err(e) => (None, Some(format!("ssh-keygen could not run: {e}"))),
    }
}

fn key_file(path: &Path) -> KeyFile {
    let (protected, problem) = protection(path);
    KeyFile {
        path: path.display().to_string(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        fingerprint: fingerprint(path),
        protected,
        problem,
    }
}

// --- Commands -------------------------------------------------------------------

/// Changes the settings under one hold of the lock, from the check to the
/// write and the emit. The slow work — ssh-keygen, the wallet — is done
/// before, so `change` checks again what it relied on. A change that cannot
/// be written is undone in memory too: the wallet, the file and the windows
/// never disagree about a credential.
fn commit<T>(app: &AppHandle, state: &AppState, change: impl FnOnce(&mut Settings) -> Result<T, String>) -> Result<T, String> {
    let mut current = state.settings.lock();
    let before = current.clone();
    let out = match change(&mut current) {
        Ok(out) => out,
        Err(e) => {
            *current = before;
            return Err(e);
        }
    };
    if let Err(e) = settings::write_and_emit(app, &state.data_dir, &current) {
        *current = before;
        let _ = app.emit(settings::EVENT_CHANGED, &*current);
        return Err(format!("The settings could not be saved: {e:#}"));
    }
    Ok(out)
}

fn key(state: &AppState, id: &str) -> Result<SshKey, String> {
    state.settings.lock().credentials.keys.iter().find(|k| k.id == id).cloned().ok_or_else(|| "That key is no longer in the list.".to_string())
}

#[tauri::command]
pub async fn credentials_status(state: tauri::State<'_, AppState>) -> Result<CredentialStatus, String> {
    let wallet = secret::probe().await;
    let keys = state.settings.lock().credentials.keys.clone();
    let mut status = HashMap::new();
    for key in keys {
        let path = Path::new(&key.path);
        let stored = wallet.is_ok() && secret::exists(&key.id).await.unwrap_or(false);
        status.insert(key.id.clone(), KeyStatus { missing: !path.exists(), problem: too_open(path), stored });
    }
    let wallet = match wallet {
        Ok(name) => WalletStatus { available: true, name: Some(name), message: None },
        Err(message) => WalletStatus { available: false, name: None, message: Some(message) },
    };
    Ok(CredentialStatus { wallet, keys: status })
}

#[tauri::command]
pub async fn credentials_key_files() -> Result<Vec<KeyFile>, String> {
    let dir = ssh_dir()?;
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_private_key(p))
        .collect();
    paths.sort();
    Ok(paths.iter().map(|p| key_file(p)).collect())
}

/// Adds a private key from `~/.ssh` by reference: the file is neither copied
/// nor moved (CRED-01). Returns the new credential's id.
#[tauri::command]
pub async fn credential_add_key(app: AppHandle, state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    // ssh expands `%` and `${…}` in an identity path. `%` is doubled where
    // the path is handed over; `$` has no escape.
    if path.contains('$') {
        return Err("ssh would read the `$` in this key's path as a variable, so it cannot be used.".into());
    }
    let path = PathBuf::from(no_controls(&path, "key path")?);
    let dir = ssh_dir()?;
    let name = path.file_name().ok_or("That is not a key file.")?.to_owned();
    if path.parent().and_then(|p| std::fs::canonicalize(p).ok()).as_deref() != Some(dir.as_path()) {
        return Err("Only a key in ~/.ssh can be added.".into());
    }
    let file = dir.join(&name);
    if !is_private_key(&file) {
        return Err(format!("{} is not a private key.", name.to_string_lossy()));
    }
    let info = key_file(&file);
    let id = crate::state::new_id();
    commit(&app, &state, |s| {
        if s.credentials.keys.iter().any(|k| k.path == info.path) {
            return Err(format!("{} is already in the list.", info.name));
        }
        s.credentials.keys.push(SshKey {
            id: id.clone(),
            name: info.name.clone(),
            path: info.path.clone(),
            fingerprint: info.fingerprint.clone(),
            // Unknown until the passphrase is saved or the problem is fixed:
            // the page offers the field, and saving checks again.
            protected: info.protected.unwrap_or(true),
            saved: false,
        });
        Ok(id.clone())
    })
}

#[tauri::command]
pub fn credential_rename_key(app: AppHandle, state: tauri::State<AppState>, id: String, name: String) -> Result<(), String> {
    let name = no_controls(&name, "name")?;
    if name.is_empty() {
        return Err("A key needs a name.".into());
    }
    commit(&app, &state, |s| {
        let key = s.credentials.keys.iter_mut().find(|k| k.id == id).ok_or("That key is no longer in the list.")?;
        key.name = name;
        Ok(())
    })
}

/// Checks the passphrase against the key, stores it in the wallet and marks
/// the key saved. The passphrase is written nowhere else (CRED-02).
#[tauri::command]
pub async fn credential_save_passphrase(app: AppHandle, state: tauri::State<'_, AppState>, id: String, passphrase: String) -> Result<(), String> {
    if passphrase.is_empty() {
        return Err("Type the passphrase first.".into());
    }
    // ssh reads an askpass answer up to the first line break.
    if passphrase.contains(['\n', '\r']) {
        return Err("A passphrase cannot hold a line break.".into());
    }
    let key = key(&state, &id)?;
    let path = Path::new(&key.path);
    if !path.exists() {
        return Err(format!("{} is missing.", key.path));
    }
    match protection(path) {
        (_, Some(problem)) => return Err(problem),
        (Some(false), _) => return Err(format!("{} needs no passphrase.", key.name)),
        _ => {}
    }
    let checked = keygen(&["-y".as_ref(), "-f".as_ref(), path.as_os_str()], Some(format!("{passphrase}\n").as_bytes())).map_err(|e| format!("ssh-keygen could not run: {e}"))?;
    if !checked.status.success() {
        let text = String::from_utf8_lossy(&checked.stderr);
        return Err(if text.contains("incorrect passphrase") { format!("That passphrase does not open {}.", key.name) } else { stderr_line(&checked) });
    }
    // An old PEM key without its `.pub` shows no fingerprint until it opens.
    let fingerprint = match key.fingerprint {
        Some(_) => None,
        None => keygen(&["-l".as_ref(), "-f".as_ref(), "-".as_ref()], Some(&checked.stdout)).ok().as_ref().and_then(fingerprint_in),
    };
    secret::store(&id, &key.name, &passphrase).await.map_err(|e| format!("The wallet did not keep the passphrase: {e}."))?;
    let saved = commit(&app, &state, |s| {
        let k = s.credentials.keys.iter_mut().find(|k| k.id == id).ok_or("That key was removed meanwhile.")?;
        k.saved = true;
        k.protected = true;
        if fingerprint.is_some() {
            k.fingerprint = fingerprint;
        }
        Ok(())
    });
    if saved.is_err() {
        // Nothing may stay in the wallet that the settings do not know of.
        let _ = secret::delete(&id).await;
    }
    saved
}

/// Deletes the key's wallet entry, then the key and every assignment to it,
/// which return to the user's own ssh setup (CRED-11) — explicitly, since an
/// unset field on a linked worktree would take its repository's key instead.
/// A passphrase that cannot be deleted keeps the key: no screen could reach
/// the entry after.
#[tauri::command]
pub async fn credential_remove_key(app: AppHandle, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let key = key(&state, &id)?;
    match secret::delete(&id).await {
        Ok(()) => {}
        Err(SecretError::NoWallet(_)) if !key.saved => {}
        Err(e) => return Err(format!("The passphrase saved for {} could not be removed from the wallet ({e}), so the key stays.", key.name)),
    }
    commit(&app, &state, |s| {
        s.credentials.keys.retain(|k| k.id != id);
        for ws in s.workspaces.values_mut() {
            if ws.ssh_key.as_deref() == Some(id.as_str()) {
                ws.ssh_key = Some(String::new());
            }
        }
        Ok(())
    })?;
    write_terminal_configs(&app);
    Ok(())
}

fn identity_fields(label: &str, name: &str, email: &str) -> Result<(String, String, String), String> {
    let (label, name, email) = (no_controls(label, "label")?, no_controls(name, "name")?, no_controls(email, "email")?);
    if name.is_empty() {
        return Err("An identity needs a name.".into());
    }
    if !email.contains('@') {
        return Err("An email needs an @.".into());
    }
    Ok((if label.is_empty() { name.clone() } else { label }, name, email))
}

/// Returns the new identity's id.
#[tauri::command]
pub fn credential_add_identity(app: AppHandle, state: tauri::State<AppState>, label: String, name: String, email: String) -> Result<String, String> {
    let (label, name, email) = identity_fields(&label, &name, &email)?;
    let id = crate::state::new_id();
    commit(&app, &state, |s| {
        s.credentials.identities.push(Identity { id: id.clone(), label, name, email });
        Ok(id.clone())
    })
}

#[tauri::command]
pub fn credential_update_identity(app: AppHandle, state: tauri::State<AppState>, id: String, label: String, name: String, email: String) -> Result<(), String> {
    let (label, name, email) = identity_fields(&label, &name, &email)?;
    commit(&app, &state, |s| {
        let identity = s.credentials.identities.iter_mut().find(|i| i.id == id).ok_or("That identity is no longer in the list.")?;
        *identity = Identity { id: id.clone(), label, name, email };
        Ok(())
    })?;
    write_terminal_configs(&app);
    Ok(())
}

/// Removes the identity and every assignment to it, which return to the
/// user's own git configuration — explicitly, as a removed key's do.
#[tauri::command]
pub fn credential_remove_identity(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<(), String> {
    commit(&app, &state, |s| {
        s.credentials.identities.retain(|i| i.id != id);
        for ws in s.workspaces.values_mut() {
            if ws.identity.as_deref() == Some(id.as_str()) {
                ws.identity = Some(String::new());
            }
        }
        Ok(())
    })?;
    write_terminal_configs(&app);
    Ok(())
}

/// `ssh_key` and `identity`: `None` unset, `Some("")` the user's own setup,
/// otherwise an id.
#[tauri::command]
pub fn set_workspace_credentials(
    app: AppHandle,
    state: tauri::State<AppState>,
    workspace_id: String,
    ssh_key: Option<String>,
    identity: Option<String>,
    terminals: bool,
) -> Result<(), String> {
    let path = state
        .session
        .lock()
        .workspace(&workspace_id)
        .map(|w| settings_key(&w.path))
        .ok_or_else(|| format!("no workspace {workspace_id}"))?;
    commit(&app, &state, |s| {
        if let Some(id) = ssh_key.as_deref().filter(|id| !id.is_empty()) {
            if !s.credentials.keys.iter().any(|k| k.id == id) {
                return Err("That SSH key is no longer in the list.".into());
            }
        }
        if let Some(id) = identity.as_deref().filter(|id| !id.is_empty()) {
            if !s.credentials.identities.iter().any(|i| i.id == id) {
                return Err("That identity is no longer in the list.".into());
            }
        }
        let ws = s.workspaces.entry(path).or_default();
        ws.ssh_key = ssh_key;
        ws.identity = identity;
        ws.terminal_credentials = terminals;
        Ok(())
    })?;
    write_terminal_configs(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_word_survives_any_quote_inside_it() {
        assert_eq!(sh_quote("/a b/key"), "'/a b/key'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("''"), r"''\'''\'''");
        assert_eq!(sh_quote("$HOME `x` \\"), "'$HOME `x` \\'");
    }

    #[test]
    fn a_git_configuration_value_escapes_what_git_would_read_otherwise() {
        assert_eq!(git_quote("Rodrigo Giacobelli"), "\"Rodrigo Giacobelli\"");
        assert_eq!(git_quote(r#"say "hi" \ bye"#), r#""say \"hi\" \\ bye""#);
        assert_eq!(git_quote("a\tb\nc"), r#""a\tb\nc""#);
        // A command quoted for the shell inside a quoted value keeps both layers.
        assert_eq!(git_quote(&sh_quote("it's")), r#""'it'\\''s'""#);
    }

    #[test]
    fn an_include_pattern_matches_its_own_path_and_no_other() {
        assert_eq!(include_patterns(Path::new("/home/kk/r/.git")), ["/home/kk/r/.git".to_string(), "/home/kk/r/.git/worktrees/*".to_string()]);
        assert_eq!(include_patterns(Path::new(r"/p[12]/*?\x/.git"))[0], r"/p\[12]/\*\?\\x/.git");
    }

    #[test]
    fn a_repository_is_found_from_a_working_tree_a_linked_worktree_and_a_bare_directory() {
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let scratch = Scratch(std::env::temp_dir().join(format!("agentic-workspace-repository-of-{}", std::process::id())));
        let root = scratch.0.clone();
        let mk = |p: &str| std::fs::create_dir_all(root.join(p)).unwrap();
        let write = |p: &str, text: &str| std::fs::write(root.join(p), text).unwrap();

        // A working tree, from a directory inside it.
        mk("repo/.git/worktrees/wt");
        mk("repo/src/deep");
        let found = repository_of(&root.join("repo/src/deep")).unwrap();
        assert_eq!((found.common_dir, found.linked), (root.join("repo/.git"), false));

        // A linked worktree with an absolute gitdir and a relative commondir.
        mk("wt/sub");
        write("wt/.git", &format!("gitdir: {}\n", root.join("repo/.git/worktrees/wt").display()));
        write("repo/.git/worktrees/wt/commondir", "../..\n");
        let found = repository_of(&root.join("wt/sub")).unwrap();
        assert_eq!((found.common_dir, found.linked), (root.join("repo/.git"), true));

        // `git worktree add --relative-paths` writes the gitdir relative to
        // the file's own directory.
        mk("repo/.git/worktrees/rel");
        mk("rel");
        write("rel/.git", "gitdir: ../repo/.git/worktrees/rel\n");
        write("repo/.git/worktrees/rel/commondir", "../..\n");
        let found = repository_of(&root.join("rel")).unwrap();
        assert_eq!((found.common_dir, found.linked), (root.join("repo/.git"), true));

        // A bare repository has no `.git` above it: it is its own.
        mk("bare.git/objects");
        mk("bare.git/refs");
        write("bare.git/HEAD", "ref: refs/heads/main\n");
        let found = repository_of(&root.join("bare.git")).unwrap();
        assert_eq!((found.common_dir, found.linked), (root.join("bare.git"), false));

        mk("plain");
        assert!(repository_of(&root.join("plain")).is_none_or(|r| !r.common_dir.starts_with(&root)));
    }
}

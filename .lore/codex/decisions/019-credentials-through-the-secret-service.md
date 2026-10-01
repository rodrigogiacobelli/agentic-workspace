---
id: 019-credentials-through-the-secret-service
title: 'ADR-019: Credentials live in the Secret Service and reach ssh through the application''s own binary'
summary: Why a key's passphrase is kept only in the desktop's Secret Service, why
  the settings hold credentials and assignments without a secret, why the application's
  binary doubles as an ssh wrapper that confines ssh to one key and as an askpass
  helper that relays every prompt to the running application, why a commit identity
  travels in the environment and never in git configuration, why a family's terminals
  carry its root's credentials only on the root's consent, what a worktree inherits,
  and where the trust boundary sits.
related:
- 012-git-through-the-git-binary
- 004-central-settings-store
- 002-backend-owned-terminal-sessions
- 007-workspace-is-one-directory
- standards-linux-desktop
- operations-running-agentic-workspace
- 020-workspace-family
binds:
- src-tauri/src/credentials.rs
- src-tauri/src/askpass.rs
- src-tauri/src/secret.rs
- src-tauri/src/git.rs
- src-tauri/src/pty.rs
- src-tauri/src/settings.rs
- src-tauri/src/main.rs
- src/components/CredentialsPage.tsx
- src/components/CredentialPrompt.tsx
---

# ADR-019: Credentials live in the Secret Service and reach ssh through the application's own binary

## Context

`git_remote` ran fetch, pull and push with `GIT_TERMINAL_PROMPT=0` and
whatever key ssh chose for the host. The owner holds five
passphrase-protected keys and pins one per host in `~/.ssh/config`. That
cannot tell two accounts on one host apart, and a workspace's push could go
out under any key the ssh-agent held. A question ssh asked — an unknown host
key, a passphrase — had no terminal to reach and failed.

Key forces:

- **A secret belongs to the desktop, not to this application.** The owner's
  machine answers `org.freedesktop.secrets` with GNOME Keyring; KWallet 6 and
  KeePassXC answer it elsewhere. A wallet of the application's own, or a
  passphrase file, is one more store holding secrets.
- **`-i` does not confine ssh.** Measured on OpenSSH 10.5p1: `-i K -o
  IdentitiesOnly=yes` still offers the `IdentityFile` the user's configuration
  names for the host, and a missing `-i` file falls back to `~/.ssh/id_*`. A
  push meant for one account reaches the server with another's key.
- **ssh starts the askpass program, not the application.** Any process of the
  user can start the same program with the same environment, so a helper that
  reads the wallet itself hands the passphrase to whoever runs it.
- **The terminal is the user's.** A shell and everything started in it keep
  the user's own ssh setup and git configuration unless the user asks
  otherwise.
- **Nothing is written into a workspace** (`004-central-settings-store`), so
  an identity cannot be set with `git config` in the repository.
- **Worktrees are workspaces** (`007-workspace-is-one-directory`), and a
  worktree created for a task is expected to push and commit as its
  repository does.
- **A development build runs beside an installed one**
  (`standards-linux-desktop`), and neither may read or answer for the other.

## Decision

**What the settings hold.** `settings.json` carries `credentials`: SSH keys —
id, name, the absolute path of the private key file in `~/.ssh`, fingerprint,
whether it needs a passphrase, whether the wallet holds it — and commit
identities — id, label, name, email. Each workspace's entry carries `sshKey`
and `identity`, each unset (`null`), explicitly the user's own setup (`""`),
or an id, and `terminalCredentials`. No secret is in the file. Only the
credential commands in `credentials.rs` change these fields;
`update_settings` keeps the backend's values over whatever the frontend sends
(`004-central-settings-store`). `credential_add_key` adds a key by reference:
the file must be a private key directly inside the canonical `~/.ssh`, is
neither copied nor moved, and is refused when its path holds `$`, which ssh
expands in an identity path with no escape.

**Where a passphrase lives.** `secret.rs` stores it in the default collection
of whatever owns `org.freedesktop.secrets`, over a `plain` session on the
user's session bus, through a connection opened for that operation alone. An
item carries the attributes `application=<APP_ID>`, `credential=<id>` and
`xdg:schema=<APP_ID>.passphrase` and the label `Agentic Workspace — SSH key
<name>`; every search, lookup and delete matches both `application` and
`credential`, so a development build and an installed one never touch each
other's items. A whole operation is bounded at 120 seconds; an unlock still
unanswered then fails the operation with `SecretError::StayedLocked`, and the
push that asked says the wallet stayed locked (CRED-09). `secret.rs` never
calls the prompt's `Dismiss`: on gnome-keyring-daemon 50.0 that call trips an
assertion in `perform_next_unlock` (`gkd-secret-unlock.c`) and aborts the
daemon, taking the keyring down for every client. The wallet's own unlock
dialog therefore stays on screen after the bound ends, and answering it later
unlocks the wallet for the next operation. `credential_save_passphrase` checks the
passphrase with `ssh-keygen -y`, handing it over on stdin, never on the
command line, in a session of its own with no askpass, then stores it; a
settings write that fails afterwards deletes the stored item.
`credential_remove_key` deletes the wallet item first and keeps the key when
that fails, since no screen could reach the item afterwards; it then sets
every assignment to the key to `""`, so a worktree that would have inherited
it falls back to the user's own setup too.

**Resolution.** `credentials::resolve` takes a workspace's own field, and for
a field left unset on a linked worktree, its repository's. The repository is
the row the worktree is listed under (`Workspace.worktree_of`,
`020-workspace-family`), else the main worktree git lists, else — for shells
launch starts before any git summary is in — what `repository_of` reads from
the `.git` files on disk. `repository_of` stops at a `.git` it cannot resolve
rather than climb past it, and a folder that is gone is never read upwards:
its scope takes the repository its entry last read from its own `.git`, or
none, whose include pattern matches nothing while the folder is gone
(TERM-26). `terminalCredentials` is never inherited. An id that names no
credential makes every git of the workspace fail with a message rather than
run under the user's own key.

**The application's own git.** `git::repo_of` gives every git command in
`git.rs`, reads included, the workspace's environment
(`012-git-through-the-git-binary`); a checkout can run an LFS download and a
partial clone fetches on read.

- A key sets `GIT_SSH_COMMAND` to the application's binary as the wrapper —
  `'<exe>' --agentic-ssh '<socket>' '<key path>' '<credential id>'`, each word
  single-quoted — and `GIT_SSH_VARIANT=ssh`, which spares git a probe run of
  the wrapper.
- An identity sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
  `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`. The author pair alone leaves
  the committer to the configuration.
- A workspace with no key, while the relay runs, sets `SSH_ASKPASS` to the
  binary, `SSH_ASKPASS_REQUIRE=force` and `AGENTIC_WORKSPACE_SOCKET`, so ssh's
  questions reach a dialog for every workspace (CRED-08). `GIT_ASKPASS` is set
  to the `SSH_ASKPASS` the application inherited, or empty, unless the
  application inherited a `GIT_ASKPASS` or the repository sets
  `core.askPass`: git's own HTTPS prompts keep the user's askpass chain and
  never reach the application's helper.
- Before a pull or a push with a key, `git::preflight` refuses to start when
  the key file is gone (CRED-10), and when the remote's URL after the user's
  `insteadOf` rewrites is reached through a remote helper — HTTPS, or any
  other `<scheme>://` or `<helper>::` git does not handle itself — since the
  push would then go out under whatever credential that helper holds.
  `ssh://`, the scp-like `[user@]host:path`, a local path, `file://` and
  `git://` carry no credential of their own and pass. A fetch checks only the
  key file.

**The ssh wrapper.** `main` calls `askpass::helper` before anything of the
application starts — above all before the single-instance check, which would
raise the running application and exit 0. With `--agentic-ssh` the binary:

1. checks the runtime directory and that the key file exists, exiting 255
   with a message naming the file otherwise;
2. runs `ssh -G` with git's arguments unchanged — destination and remote
   command, so `Match command` and `Match sessiontype` evaluate as for the
   real connection — and `ssh -F none -G <host>` for the default
   `hostkeyalgorithms` line;
3. writes the resolved configuration back out as a flat file: every
   `identityfile`, `identitiesonly`, `identityagent`, `certificatefile`,
   `pkcs11provider`, `controlmaster`, `controlpath`, `controlpersist`,
   `addkeystoagent`, `numberofpasswordprompts`, `forwardagent` and
   `preferredauthentications` line dropped; `hostkeyalgorithms` dropped when
   it equals the default, since a written-out list would stop ssh preferring
   the algorithm `known_hosts` holds for the host; and what `-G` prints in a
   form its own parser reads differently rewritten — every `setenv` merged
   into one line of double-quoted words, a numeric `obscurekeystroketiming`
   as `interval:N`, `escapechar` without its backslash, a spaced `user`,
   `hostkeyalias`, `revokedhostkeys`, `securitykeyprovider` or
   `xauthlocation` double-quoted, and the known-hosts file lists split at
   words that start a path and quoted;
4. appends, when the host has a `proxyjump`, `Match !originalhost <host>`
   with `Include ~/.ssh/config /etc/ssh/ssh_config`: ssh hands `-F <flat
   file>` to the jump host's ssh, and the hop then connects as the user's own
   setup does, while only the target sees the assigned key;
5. creates the file as `ssh-<pid>-<random>.conf` in the runtime directory,
   `create_new`, mode 0600, `O_NOFOLLOW`;
6. runs `ssh -F <file>` with `-o IdentityFile="<key path, % doubled>"`,
   `IdentitiesOnly=yes`, `ForwardAgent=no`, `ControlMaster=no`,
   `ControlPath=none`, `AddKeysToAgent=no`,
   `PreferredAuthentications=publickey` and `NumberOfPasswordPrompts=2`,
   then git's arguments. `IdentityAgent` stays as the user has it:
   `IdentitiesOnly` already confines the agent to the key, and the agent stays
   reachable for jump hosts and proxy commands. The host-key policy, the
   known-hosts files and the jump hosts are the user's own, carried in the
   flat file. ssh's environment is `clean_child_env`, then `SSH_ASKPASS` set
   to the binary, `SSH_ASKPASS_REQUIRE=force`, `AGENTIC_WORKSPACE_SOCKET` and
   `AGENTIC_WORKSPACE_CREDENTIAL`, with `SSH_ASKPASS_PROMPT` removed;
7. installs do-nothing handlers for SIGINT, SIGTERM and SIGHUP, waits for
   ssh, deletes the file and exits with ssh's code. When ssh's error names the
   flat file, it adds `Agentic Workspace: an ssh setting for this host could
   not be carried over.`

`askpass::sweep` deletes, at launch, the flat files and sockets whose pid is
gone.

**The askpass relay.** Started with `AGENTIC_WORKSPACE_SOCKET` set and one
argument, the binary is ssh's askpass helper. It makes itself undumpable,
connects to the socket, checks with `SO_PEERCRED` that the server runs as the
same user, sends one JSON line — the credential it was started for, as a
claim; ssh's prompt, base64; ssh's hint — of at most 16 KiB, never reads stdin,
which under git is the protocol pipe, and prints the answer or exits 1 with
the relay's message. `askpass::serve`, started in `setup`, listens on
`askpass-<pid>.sock` in the runtime directory, mode 0600, one thread per
request, and refuses a peer of another uid.

- **The origin is derived, never taken from the request.** The helper's
  parent must run the `ssh` found on `PATH`. The relay walks that ssh's
  ancestors, 64 at most: the first registered as one of the application's
  git processes (`AppState.git_children`, filled by `git::run_env` for as
  long as the process runs) makes the origin *`<workspace>` (Source
  Control)*; the first that is a terminal's shell makes it *a terminal of
  `<workspace>`*, the workspace whose credentials that shell started with
  (`Live.credentials`), or for a shell that started with none, the family
  root holding its tab; neither makes it *an unknown process*.
- **Classification compares whole prompts, byte for byte.** The credential's
  own passphrase prompt is exactly `Enter passphrase for key '` plus the first
  100 bytes of its key path plus `': `. A prompt starting `The authenticity of
  host '` and ending `(yes/no/[fingerprint])? ` is a host key, its host and
  fingerprint parsed out. Keyboard-interactive text arrives from ssh as
  `(user@host) <text>`; a prompt carrying that prefix is the server's words
  and is shown as a secret request naming the server, never taken for one of
  ssh's own. A prompt ending `(yes/no)? ` or `(yes/no): `, or carrying the
  hint `confirm`, is a yes-or-no question. The hint `none` — a security key
  waiting for a touch — becomes an information notice answered with nothing,
  which leaves as every notice does, after two seconds unless the pointer or
  focus holds it (NTF-01, NTF-02).
  Anything else is a secret request.
- **The wallet answers only when every condition holds**: the key's
  passphrase is saved; the prompt is that key's; the asking ssh's command line
  carries exactly the wrapper's `IdentityFile=` argument for it; the origin is
  the application's git or a terminal of a workspace that resolves to that
  key now; and for a terminal, that workspace's terminal option is on. A
  shell that joined a family from a worktree that was a root of its own
  (TERM-25) is judged by that worktree, whose include it still carries, until
  it is restarted. A second passphrase prompt from the same ssh within ten
  minutes of a wallet answer raises the notice `The passphrase saved for
  <name> no longer opens it.` and asks the user. A wallet that stays locked, answers nothing or fails
  gives ssh a message saying the passphrase was not read. Any failed
  condition asks the user.
- **Asking the user.** The relay puts a `CredentialPrompt` in the window of
  whoever asked — the Terminal window for a terminal, the Workspace window
  otherwise — shows that window, emits `credential-prompt` and waits up to 300
  seconds. A timeout answers with `Agentic Workspace: no answer within 5
  minutes.`; a helper that hangs up takes its waiter off the prompt, and the
  last waiter to leave takes the dialog down. Identical host-key and yes-or-no
  prompts from the same origin share one dialog and its answer; a secret is
  never shared and goes to the one request it was typed for. *Trust* answers
  `yes` and ssh writes `known_hosts` itself; *Decline* answers nothing, and
  ssh stops with `Host key verification failed.` A host whose configuration
  never asks — `StrictHostKeyChecking no` — gets no dialog.
- **A git the main thread waits on gets no dialog.** A synchronous command's
  git blocks the GTK main loop that would deliver the answer, so the relay
  answers it with a message telling the user to run Fetch, answer the question
  there, and try again.

`CredentialPrompt.tsx` draws the dialog in both windows. *Decline* or *No*
has the first focus, *Trust* is never the Enter default, and every button but
the one that declines, and the secret field, ignore input for 700 ms after
each new prompt appears, so keystrokes meant for a shell do not answer it.

**Terminals carry credentials only on consent.** Every shell of a workspace
family starts with its root's terminal environment (CRED-14,
`020-workspace-family`). With the root's own `terminalCredentials` off, the
family's shells start with nothing added (CRED-06). With it on (CRED-07),
`credentials::terminal_env` appends git configuration entries through
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` after
any the application inherited, and records `n` in
`AGENTIC_WORKSPACE_GIT_CONFIG`. The entries are `includeIf.gitdir:<pattern>.path`
for two patterns — the repository's common git directory, and that directory
followed by `/worktrees/*` — with every `*`, `?`, `[` and `\` of the path
escaped, since a pattern is a glob. `*` stops at a slash, so a submodule's git
directory under `modules/`, another repository, stays out. A workspace outside
any repository gets one pattern, its own path followed by `/`, which git
widens to every repository under it. So a repository root's family shells
carry its credentials in its repository and its worktrees, and git inside one
of its children keeps the user's own setup; a plain-folder root's reach every
repository under it, its children included (CRED-15). A member's own terminal
option, key and identity reach no shell of the family: its Workspace page
reads `Terminals of <root>'s family start with <root>'s credentials.` in place
of the toggle and the stale list (CRED-16). The value is
`terminal-<workspace id>.gitconfig` in the runtime directory: `core.sshCommand`
set to the wrapper, `ssh.variant = ssh`, and the identity under `user`,
`author` and `committer`, since `author.*` and `committer.*` beat `user.*`
from any scope. `write_terminal_config` writes it atomically, mode 0600, and
removes it when the option is off, nothing resolves, or the workspace is
removed. It runs at launch, again once the git summaries are in, when a
workspace is activated and its summary changed, and after every credential or
assignment change. Git skips an include whose file is gone, so a shell already
running follows every change at once. A shell started while the option was off
carries no include, and a shell that joined the family from a worktree root
carries that worktree's; the root's Workspace page lists every shell of the
family that did not start with the root's credentials, each labelled
`<name> (tab N)` — the tab's name, else its directory's, and its place in the
tab strip — and *Restart shell* replaces one in place, with the root's
environment (`002-backend-owned-terminal-sessions`).
`credentials::forget_inherited_env` runs first in `run` and takes those entries
and every `AGENTIC_WORKSPACE_*` variable out of the application's own
environment, so an application started from an opted-in shell hands nothing on.

**The runtime directory.** `credentials::runtime_dir` is
`$XDG_RUNTIME_DIR/<APP_ID>`. `XDG_RUNTIME_DIR` has to be an absolute path to a
real directory, not a symlink, owned by the user with no group or other
permission bits; `<APP_ID>` inside it is created with mode 0700 or checked the
same way. There is no fallback. Without it the relay does not start — the
application's git then gets no askpass variables — and the wrapper exits 255.

## Rationale

- The Secret Service is the one store every desktop the application targets
  already runs and already guards with the user's login; the application keeps
  a reference to a key and a flag that a passphrase is saved, and nothing that
  opens a key.
- Flattening `ssh -G` and dropping every identity line is the only
  arrangement measured to offer the assigned key and nothing else: when the
  server refuses that key, no other is offered.
- The relay reads the wallet inside the process that decides whether to, and
  decides from facts the kernel reports — the peer's uid and pid, the process
  tree, the asking ssh's command line — rather than from what the caller
  claims.
- Whole-prompt classification keeps a server from dressing a
  keyboard-interactive prompt as ssh's passphrase or host-key question.
- Environment variables reach one git process and nothing else, so an identity
  set that way is never written into the repository and never outlives the
  command.
- An include keyed to the repository's git directory confines a terminal's
  credentials to that repository and its worktrees: `cd ../other && git push`
  uses the user's own setup. A file that goes away takes the credentials out
  of every running shell without touching the shell.
- Keying the wallet attributes, the runtime directory and the socket by
  `APP_ID` and pid keeps a development build and an installed one apart
  without a mode of their own.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **`-i <key> -o IdentitiesOnly=yes` on git's ssh** | One line, and measured to still offer the configuration's `IdentityFile` for the host and to fall back to `~/.ssh/id_*` when the file is missing. |
| **A wallet or passphrase file of the application's own** | Works without a desktop wallet, and puts a second store of secrets on disk under the application's own protection. |
| **Keeping a passphrase in memory without a wallet** | Saves retyping for a session, and makes the application a secret store after all. Without a wallet, saving is refused. |
| **An askpass helper that reads the wallet itself** | No socket and no relay, and any process of the user that starts the helper gets the passphrase. |
| **Loading the keys into ssh-agent** | ssh already talks to it, and the agent then holds every account's key for any ssh the user runs, which is the crossing this decision exists to stop. |
| **`git config user.name` and `core.sshCommand` in the repository** | Survives outside the application, and writes into a repository the user may not own (`004-central-settings-store`). |
| **`GIT_SSH_COMMAND` exported into opted-in shells** | Simpler than an include, and follows the shell into every other repository it `cd`s into, and cannot be withdrawn from a running shell. |
| **Each member's own terminal credentials inside a family shell** | Git in a child would push as the child, and it needs a per-tab record of the environment and an askpass rule by working directory; a family's shells carry the root's alone (`020-workspace-family`). |
| **A KWallet-native path** | KWallet answers the Secret Service like the others; a second code path buys nothing. |

## Consequences

**Easier:**
- A workspace pushes, pulls and fetches as its own account, and two accounts
  on one host never cross, from Source Control and, on a root's consent, from
  its family's terminals.
- A new worktree pushes and commits as its repository with nothing assigned.
- An unknown host key, a passphrase and a server's question reach a dialog in
  the right window instead of failing.
- A workspace with nothing assigned runs git as it did before, with ssh's
  prompts gaining a dialog.

**Harder:**
- The wrapper carries a configuration through `ssh -G`, which prints some
  values in a form its parser reads differently. The rewrites cover every such
  keyword known against OpenSSH 10.5; one outside that set fails the
  connection and the wrapper says a setting could not be carried over. A
  known-hosts path holding ` /` or ` ~` stays ambiguous.
- The trust boundary is the user account. A process of the same user can
  read an unlocked GNOME Keyring item through the Secret Service directly; the
  relay's checks stop a process from getting the application to read it on its
  behalf, not from asking the wallet itself. KeePassXC may confirm access per
  client: it sees the application as that client, so every ssh the relay
  answers passes under the application's one approval.
- A wallet unlock that outlasts the 120-second bound fails the push while
  the wallet's own dialog stays on screen, since dismissing it would abort
  gnome-keyring-daemon 50.0. The user answers or closes that dialog and runs
  the push again.
- A git a synchronous command runs cannot ask the user anything.
- The jump host of a `proxyjump` connects with the user's own setup, never the
  assigned key.
- A shell started before its root's terminal option was turned on keeps the
  user's setup, and a shell that joined a family from a worktree root keeps
  that worktree's credentials, until it is restarted.
- In a family shell, git inside a child of a repository root runs with the
  user's own setup, whatever the child has assigned.
- `openssh` is a runtime dependency: the wrapper runs `ssh` and the key checks
  run `ssh-keygen`.

## Constraints imposed

- **No secret in any file the application writes, in any log, or in a type
  that implements `Debug`.** A passphrase is in the wallet and, for the length
  of one request, in the relay.
- **An identity is never written into git configuration.** The application's
  git gets the four environment variables; an opted-in terminal gets them
  through the include file in the runtime directory.
- **Every git command in `git.rs` for a workspace runs through `repo_of`**, so
  none goes out under the user's default key while a key is assigned.
- **Every wallet operation matches both `application` and `credential`.**
- **The relay derives the origin and never trusts the request's credential**;
  the wallet answers only the exact passphrase prompt of that credential's key.
- **A family's terminals carry its root's credentials only when the root's
  own option is on**, and only inside the root's repository — for a
  plain-folder root, inside every repository under it.
- **The wrapper keeps the user's host-key policy, known-hosts files and jump
  hosts**, and replaces only what decides which key is offered.
- **The runtime directory has no fallback.** Without a private
  `$XDG_RUNTIME_DIR`, no socket and no flat file is created anywhere else.

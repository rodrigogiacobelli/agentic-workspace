import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import { report } from "../notice";
import type { CredentialStatus, Identity, KeyFile, Settings, SshKey, StaleTerminal, Workspace } from "../types";
import { Dropdown, type Option } from "./Menu";

// The credential pages of the settings dialog. Shared code (ADR-018): nothing
// here reaches the editors or the terminals, so a running shell is known only
// by what the backend reports of it.

/** The two assignments a workspace holds, as `WorkspaceSettings` names them. */
type Field = "sshKey" | "identity";

/** What an unset or explicitly empty assignment falls back to. */
const OWN: Record<Field, string> = { sshKey: "Your own ssh setup", identity: "Your git configuration" };

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The open workspaces, kept current while a page shows. */
function useWorkspaces(): Workspace[] {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(() => {
    let live = true;
    api.getSession().then((s) => { if (live) setWorkspaces(s.workspaces); }).catch(report);
    const unlisten = events.onSession((s) => setWorkspaces(s.workspaces));
    return () => {
      live = false;
      void unlisten.then((u) => u());
    };
  }, []);
  return workspaces;
}

/**
 * The repository a linked worktree takes an unset key or identity from: the
 * open workspace on it, or git's main worktree when that one is not open —
 * the rule `credentials::scope` resolves by. Null for anything that is not a
 * linked worktree.
 */
function repositoryOf(ws: Workspace, workspaces: Workspace[]): { path: string; name: string } | null {
  const open = ws.worktreeOf ? workspaces.find((w) => w.id === ws.worktreeOf) : undefined;
  if (open) return { path: open.path, name: open.name };
  if (!ws.git?.isWorktree) return null;
  const main = ws.git.worktrees.find((t) => t.isMain);
  if (!main) return null;
  return { path: main.path, name: workspaces.find((w) => w.path === main.path)?.name ?? main.name };
}

/**
 * Every workspace a removal changes: each assigned `id` — by name when it is
 * open, by path when it is not — and each linked worktree that leaves the
 * field unset and so inherits it from its repository: by name when it is
 * open, by path when only its open repository lists it. A closed
 * repository's worktrees are not known here.
 */
function usersOf(field: Field, id: string, current: Settings, workspaces: Workspace[]): string[] {
  const named = new Map<string, string>();
  for (const [path, ws] of Object.entries(current.workspaces)) {
    if (ws[field] === id) named.set(path, workspaces.find((w) => w.path === path)?.name ?? path);
  }
  for (const w of workspaces) {
    if (named.has(w.path) || (current.workspaces[w.path]?.[field] ?? null) !== null) continue;
    const repo = repositoryOf(w, workspaces);
    if (repo && current.workspaces[repo.path]?.[field] === id) named.set(w.path, `${w.name}, a worktree of ${repo.name}`);
  }
  for (const r of workspaces) {
    if (r.git?.isWorktree || current.workspaces[r.path]?.[field] !== id) continue;
    for (const t of r.git?.worktrees ?? []) {
      if (t.isMain || named.has(t.path) || workspaces.some((w) => w.path === t.path)) continue;
      if ((current.workspaces[t.path]?.[field] ?? null) === null) named.set(t.path, `${t.path}, a worktree of ${r.name}`);
    }
  }
  return [...named.values()];
}

/** A removal's confirmation: what goes, and every workspace that goes back to the user's own setup. */
function removal(what: string, field: Field, users: string[], tail: string): string {
  const who = users.length === 0
    ? "No workspace uses it."
    : `${users.length === 1 ? "This workspace uses it and goes" : "These workspaces use it and go"} back to ${OWN[field].toLowerCase()}:\n${users.map((u) => `• ${u}`).join("\n")}`;
  return `Remove ${what}?\n\n${who}${tail ? `\n\n${tail}` : ""}`;
}

/** The line under a key: what ssh needs from it, and where its passphrase is. */
function keyState(key: SshKey, status: CredentialStatus | null): { text: string; problem: boolean } {
  const s = status?.keys[key.id];
  if (s?.missing) return { text: `Missing: ${key.path}`, problem: true };
  if (s?.problem) return { text: s.problem, problem: true };
  if (!key.protected) return { text: "No passphrase needed", problem: false };
  // Until the wallet answers, what settings last recorded.
  if (!status) return { text: key.saved ? "Passphrase saved" : "Passphrase not saved", problem: false };
  return s?.stored ? { text: `Stored in: ${status.wallet.name ?? "the wallet"}`, problem: false } : { text: "Passphrase not saved", problem: false };
}

/**
 * The Credentials page: the wallet, the SSH keys and the commit identities
 * every workspace can be assigned. The wallet's status and the key files are
 * read when the page shows and after each change made on it — not polled.
 */
export function CredentialsPage({ current }: { current: Settings }) {
  const workspaces = useWorkspaces();
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [files, setFiles] = useState<KeyFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  /** The key just added, whose name takes the keyboard so it can be renamed at once. */
  const [fresh, setFresh] = useState<string | null>(null);
  const { keys, identities } = current.credentials;

  const refresh = useCallback(() => {
    api.credentialsStatus()
      .then((s) => { setStatus(s); setStatusError(null); })
      .catch((e) => setStatusError(String(e)));
    api.credentialsKeyFiles()
      .then((f) => { setFiles(f); setFilesError(null); })
      .catch((e) => setFilesError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const wallet = status?.wallet ?? null;

  const addKey = (path: string) => {
    setAddError(null);
    api.credentialAddKey(path)
      .then((id) => { setFresh(id); refresh(); })
      .catch((e) => setAddError(`The key was not added: ${String(e)}`));
  };

  const removeKey = async (k: SshKey) => {
    const stored = status?.keys[k.id]?.stored ?? k.saved;
    const tail = `${stored ? `Its passphrase is deleted from ${wallet?.name ?? "the wallet"}. ` : ""}The key file ${k.path} stays where it is.`;
    const yes = await ask(removal(`the SSH key “${k.name}”`, "sshKey", usersOf("sshKey", k.id, current, workspaces), tail), {
      title: "Remove SSH key",
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (!yes) return;
    await api.credentialRemoveKey(k.id);
    refresh();
  };

  const removeIdentity = async (i: Identity) => {
    const yes = await ask(removal(`the commit identity “${i.label}”`, "identity", usersOf("identity", i.id, current, workspaces), ""), {
      title: "Remove commit identity",
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (yes) await api.credentialRemoveIdentity(i.id);
  };

  const offered = (files ?? []).filter((f) => !keys.some((k) => k.path === f.path));

  return (
    <>
      {statusError ? (
        <p className="setting-error" role="alert">The wallet and the keys could not be checked: {statusError}</p>
      ) : !wallet ? (
        <p className="settings-note">Looking for a wallet…</p>
      ) : wallet.available ? (
        <p className="settings-note">Passphrases are kept in: {wallet.name ?? "the wallet"}</p>
      ) : (
        <>
          <p className="settings-note">No wallet found. Passphrases cannot be saved without one.</p>
          {wallet.message && <p className="settings-note">{wallet.message}</p>}
        </>
      )}

      <h3>SSH keys</h3>
      {keys.length === 0 && <p className="settings-note">No key added. A workspace without one uses your own ssh setup.</p>}
      {keys.map((k) => (
        <KeyRow key={k.id} sshKey={k} status={status} statusFailed={!!statusError} fresh={k.id === fresh} onSaved={refresh} onRemove={() => removeKey(k)} />
      ))}
      {/* A dropdown keeps the keyboard on its own button and picks with the
          arrows and Enter, so the dialog's focus trap has nothing to undo.
          With nothing to offer it gives way to the reason. */}
      <div className="cred-add">
        {offered.length ? (
          <Dropdown
            value=""
            display="Add SSH key"
            title="The private keys in ~/.ssh; the file stays where it is"
            options={offered.map((f) => ({
              id: f.path,
              label: f.name,
              detail: [f.fingerprint ?? "Fingerprint shown once its passphrase is checked", f.problem].filter(Boolean).join(" · "),
            }))}
            onChange={addKey}
          />
        ) : files === null ? (
          !filesError && <p className="settings-note">Reading ~/.ssh…</p>
        ) : (
          <p className="settings-note">{files.length ? "Every private key in ~/.ssh is added." : "~/.ssh holds no private key."}</p>
        )}
      </div>
      {filesError && <p className="setting-error" role="alert">~/.ssh could not be read: {filesError}</p>}
      {addError && <p className="setting-error" role="alert">{addError}</p>}

      <h3>Commit identities</h3>
      {identities.length === 0 && <p className="settings-note">No identity added. A workspace without one commits as your git configuration says.</p>}
      {identities.map((i) => (
        <IdentityRow key={i.id} identity={i} onRemove={() => removeIdentity(i)} />
      ))}
      <AddIdentity />
    </>
  );
}

/** One key: its name to edit, its file, its fingerprint, its passphrase. */
function KeyRow({ sshKey: k, status, statusFailed, fresh, onSaved, onRemove }: {
  sshKey: SshKey;
  status: CredentialStatus | null;
  /** The wallet did not answer, so `status` is what it said last, or nothing. */
  statusFailed: boolean;
  fresh: boolean;
  onSaved: () => void;
  onRemove: () => Promise<void>;
}) {
  const [pass, setPass] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!fresh) return;
    name.current?.focus();
    name.current?.select();
  }, [fresh]);
  const state = keyState(k, status);
  const canSave = !!status?.wallet.available && k.protected && !status.keys[k.id]?.missing;
  // A disabled field says why it is (CRED-03), where the eye already is: the
  // wallet line at the top of the page has scrolled away past a few keys.
  const why = !k.protected ? "This key needs no passphrase"
    : status?.keys[k.id]?.missing ? "The key file is missing"
    : !status ? (statusFailed ? "The wallet could not be checked" : "Checking the wallet…")
    : !status.wallet.available ? "No wallet: a passphrase cannot be saved"
    : "Passphrase";

  // An edit that does not land puts the stored name back. The field is keyed
  // by that name, and a name that did not change never renders it again.
  const rename = (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (!next || next === k.name) {
      input.value = k.name;
      return;
    }
    setError(null);
    api.credentialRenameKey(k.id, next).catch((e) => {
      input.value = k.name;
      setError(`The name was not changed: ${String(e)}`);
    });
  };

  // The field empties as the passphrase leaves it, whatever the check says:
  // it is held nowhere longer than the one call that checks and stores it.
  const save = () => {
    if (!pass || !canSave || saving) return;
    const typed = pass;
    setPass("");
    setSaving(true);
    setError(null);
    api.credentialSavePassphrase(k.id, typed)
      .then(onSaved)
      .catch((e) => setError(`The passphrase was not saved: ${String(e)}`))
      .finally(() => setSaving(false));
  };

  return (
    <div className="cred-key">
      <div className="cred-key-head">
        <input
          ref={name}
          key={k.name}
          defaultValue={k.name}
          aria-label="Key name"
          spellCheck={false}
          onBlur={(e) => rename(e.target)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <span className="cred-file" title={k.path}>{basename(k.path)}</span>
        <button onClick={() => void onRemove().catch((e) => setError(`The key was not removed: ${String(e)}`))}>Remove</button>
      </div>
      <div className="cred-fingerprint">{k.fingerprint ?? "Fingerprint shown once its passphrase is checked"}</div>
      <div className={`cred-status${state.problem ? " problem" : ""}`}>{state.text}</div>
      <div className="cred-pass">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={why}
          aria-label={`Passphrase for ${k.name}`}
          disabled={!canSave}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
        />
        <button disabled={!canSave || !pass || saving} onClick={save}>{saving ? "Checking…" : "Save"}</button>
      </div>
      {error && <p className="setting-error" role="alert">{error}</p>}
    </div>
  );
}

/** One identity, each field saved when it loses the keyboard. */
function IdentityRow({ identity: i, onRemove }: { identity: Identity; onRemove: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  // As a key's name: an edit that does not land — an emptied field among
  // them, since an identity needs all three — puts the stored value back.
  const update = (field: "label" | "name" | "email", input: HTMLInputElement) => {
    const next = { ...i, [field]: input.value.trim() };
    if (!next[field] || next[field] === i[field]) {
      input.value = i[field];
      return;
    }
    setError(null);
    api.credentialUpdateIdentity(i.id, next.label, next.name, next.email).catch((e) => {
      input.value = i[field];
      setError(`The identity was not changed: ${String(e)}`);
    });
  };
  // Keyed by the stored value: a change from elsewhere replaces what the field shows.
  const field = (f: "label" | "name" | "email", label: string) => (
    <input
      key={`${f}:${i[f]}`}
      defaultValue={i[f]}
      placeholder={label}
      aria-label={label}
      spellCheck={false}
      onBlur={(e) => update(f, e.target)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
  return (
    <>
      <div className="cred-identity">
        {field("label", "Label")}
        {field("name", "Name")}
        {field("email", "Email")}
        <button onClick={() => void onRemove().catch((e) => setError(`The identity was not removed: ${String(e)}`))}>Remove</button>
      </div>
      {error && <p className="setting-error" role="alert">{error}</p>}
    </>
  );
}

function AddIdentity() {
  const empty = { label: "", name: "", email: "" };
  const [draft, setDraft] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const ready = !!(draft.label.trim() && draft.name.trim() && draft.email.trim());
  const add = () => {
    if (!ready) return;
    setError(null);
    api.credentialAddIdentity(draft.label.trim(), draft.name.trim(), draft.email.trim())
      .then(() => setDraft(empty))
      .catch((e) => setError(`The identity was not added: ${String(e)}`));
  };
  const field = (f: keyof typeof empty, label: string) => (
    <input
      value={draft[f]}
      placeholder={label}
      aria-label={`New identity's ${label.toLowerCase()}`}
      spellCheck={false}
      onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
    />
  );
  return (
    <>
      <div className="cred-identity">
        {field("label", "Label, e.g. Work")}
        {field("name", "Name")}
        {field("email", "Email")}
        <button disabled={!ready} onClick={add}>Add identity</button>
      </div>
      {error && <p className="setting-error" role="alert">{error}</p>}
    </>
  );
}

const UNSET = "unset";
const EXPLICIT_OWN = "own";

/**
 * A three-state assignment. Unset reads as the user's own setup — or, on a
 * linked worktree, as its repository's value, which it inherits; there an
 * explicit *Your own …* option says "not the repository's".
 */
function Assignment({ label, field, value, items, repo, onChange }: {
  label: string;
  field: Field;
  value: string | null;
  items: Option[];
  repo: { name: string; value: string | null } | null;
  onChange: (value: string | null) => void;
}) {
  const noun = field === "sshKey" ? "key" : "identity";
  const own = OWN[field];
  const named = (v: string | null) => (v ? items.find((i) => i.id === v)?.label ?? `a removed ${noun}` : own.toLowerCase());
  const options: Option[] = [
    ...(repo ? [{ id: UNSET, label: `Same as ${repo.name} (${named(repo.value)})` }, { id: EXPLICIT_OWN, label: own }] : [{ id: UNSET, label: own }]),
    ...items.map((i) => ({ ...i, id: `id:${i.id}` })),
    // An assignment to something no longer listed shows as what it is, not as a blank.
    ...(value && !items.some((i) => i.id === value) ? [{ id: `id:${value}`, label: `A removed ${noun} (${value})` }] : []),
  ];
  const selected = value === null ? UNSET : value === "" ? (repo ? EXPLICIT_OWN : UNSET) : `id:${value}`;
  return (
    <label className="setting">
      <span>{label}</span>
      <Dropdown
        value={selected}
        options={options}
        onChange={(id) => onChange(id === UNSET ? null : id === EXPLICIT_OWN ? "" : id.slice(3))}
      />
    </label>
  );
}

/**
 * The Workspace page's credentials: the key and the identity this workspace
 * uses, whether its terminals carry them (CRED-07, never inherited), and the
 * shells still running on the environment they started with — the family's,
 * since a root's terminals are its family's. A member names `family`, its
 * root: its terminals start with the root's credentials, so it has no
 * terminal option of its own to offer (CRED-16).
 */
export function WorkspaceCredentials({ current, workspace, family }: { current: Settings; workspace: Workspace; family?: Workspace }) {
  const workspaces = useWorkspaces();
  const own = current.workspaces[workspace.path];
  const sshKey = own?.sshKey ?? null;
  const identity = own?.identity ?? null;
  const terminals = own?.terminalCredentials ?? false;
  const repo = repositoryOf(workspace, workspaces);
  const repoSettings = repo ? current.workspaces[repo.path] : undefined;
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<StaleTerminal[]>([]);
  const [staleError, setStaleError] = useState<string | null>(null);

  const member = family !== undefined;
  const readStale = useCallback(() => {
    if (member) return;
    api.workspaceStaleTerminals(workspace.id)
      .then((s) => { setStale(s); setStaleError(null); })
      .catch((e) => setStaleError(`This workspace's terminals could not be listed: ${String(e)}`));
  }, [workspace.id, member]);
  // When the page shows, when the option changes from either window, and on
  // every session change while it is open — a shell opened or closed.
  useEffect(readStale, [readStale, terminals, workspaces]);
  useEffect(() => {
    const unlisten = events.onTerminalRestarted(() => readStale());
    return () => { void unlisten.then((u) => u()); };
  }, [readStale]);

  const assign = (patch: Partial<{ sshKey: string | null; identity: string | null; terminals: boolean }>) => {
    const next = { sshKey, identity, terminals, ...patch };
    setError(null);
    api.setWorkspaceCredentials(workspace.id, next.sshKey, next.identity, next.terminals)
      .then(readStale)
      .catch((e) => setError(`This workspace's credentials were not changed: ${String(e)}`));
  };

  const restart = async (t: StaleTerminal) => {
    const yes = await ask(`Restart the shell in “${t.label}”? Whatever runs in it now stops.`, {
      title: "Restart shell",
      kind: "warning",
      okLabel: "Restart",
      cancelLabel: "Cancel",
    });
    if (!yes) return;
    api.terminalRestart(t.id)
      .then(readStale)
      .catch((e) => report(`The shell in “${t.label}” was not restarted: ${String(e)}`));
  };

  return (
    <>
      <h3>Credentials</h3>
      <Assignment
        label="SSH key"
        field="sshKey"
        value={sshKey}
        items={current.credentials.keys.map((k) => ({ id: k.id, label: k.name, detail: basename(k.path) }))}
        repo={repo && { name: repo.name, value: repoSettings?.sshKey ?? null }}
        onChange={(v) => assign({ sshKey: v })}
      />
      <Assignment
        label="Commit identity"
        field="identity"
        value={identity}
        items={current.credentials.identities.map((i) => ({ id: i.id, label: i.label, detail: `${i.name} <${i.email}>` }))}
        repo={repo && { name: repo.name, value: repoSettings?.identity ?? null }}
        onChange={(v) => assign({ identity: v })}
      />
      {family ? (
        <p className="settings-note">Terminals of {family.name}'s family start with {family.name}'s credentials.</p>
      ) : (
        <label className="setting">
          <span>Terminals use this workspace's credentials</span>
          <input type="checkbox" checked={terminals} onChange={(e) => assign({ terminals: e.target.checked })} />
        </label>
      )}
      {error && <p className="setting-error" role="alert">{error}</p>}
      {!member && stale.length > 0 && (
        <>
          <p className="settings-note">Started before the change, still on the old environment:</p>
          {stale.map((t) => (
            <div className="setting" key={t.id}>
              <span>{t.label}</span>
              <button onClick={() => void restart(t)}>Restart shell</button>
            </div>
          ))}
        </>
      )}
      {staleError && <p className="setting-error" role="alert">{staleError}</p>}
    </>
  );
}

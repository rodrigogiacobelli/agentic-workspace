import { useEffect, useState } from "react";
import { api } from "../api";
import * as editors from "../editors";
import { LANGUAGES, languageFor } from "../editor/languages";
import { modeOf, pick } from "../modes";
import { report } from "../notice";
import * as repo from "../repo";
import * as settings from "../settings";
import * as terminals from "../terminals";
import type { Session, WindowRole, Workspace } from "../types";
import { Dropdown } from "./Menu";

/**
 * The application's status bar, not a mode's: it sits below the body in both
 * windows, so what it says about the workspace survives a mode switch. Each
 * mode fills the left with its own facts; the workspace and its branch hold
 * the right end, and the branch opens Source Control.
 */
export function StatusBar({ session, role }: { session: Session; role: WindowRole }) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  if (!ws) return <footer className="statusbar" />;
  const mode = modeOf(ws, role);
  const git = ws.git?.isRepo ? ws.git : null;
  return (
    <footer className="statusbar">
      {mode === "editor" && <EditorFacts ws={ws} />}
      {mode === "scm" && <ScmFacts ws={ws} />}
      {mode === "terminal" && <TerminalFacts ws={ws} />}
      <span className="statusbar-grow" />
      <span className="statusbar-workspace" title={ws.path}>{ws.name}</span>
      {git && (
        <button
          className="statusbar-branch"
          onClick={() => void pick(ws, "scm", role).catch(report)}
          title={`${git.state ? `${git.state} in progress · ` : ""}${git.upstream ? `tracking ${git.upstream}` : "no upstream"} — open Source Control`}
        >
          ⑂ {git.detached ? "detached @ " : ""}{git.branch ?? ""}
          {git.ahead > 0 && <span className="ahead"> ↑{git.ahead}</span>}
          {git.behind > 0 && <span className="behind"> ↓{git.behind}</span>}
          {git.state && <span className="state"> · {git.state}</span>}
        </button>
      )}
    </footer>
  );
}

/** Where the cursor is in the active document, and how the document is read. */
function EditorFacts({ ws }: { ws: Workspace }) {
  const [, bump] = useState(0);
  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);
  const id = editors.activeEditorId(ws);
  const tab = id ? editors.activeGroup(ws)?.editors.find((t) => t.id === id) : undefined;
  const doc = id ? editors.doc(id) : undefined;
  const unsaved = editors.dirtyCount();
  if (!tab || !id) return unsaved ? <span>{unsaved} unsaved</span> : null;
  const cursor = doc?.cursor();
  const s = settings.get();
  const abs = `${ws.path}/${tab.path}`;
  const language = languageFor(tab.path, s?.languages[abs]);
  const setLanguage = async (lang: string) => {
    if (!s) return;
    const languages = { ...s.languages };
    if (lang === languageFor(tab.path)) delete languages[abs];
    else languages[abs] = lang;
    await settings.update({ languages });
    if (doc?.dirty) {
      report("Save the file before changing its language; the buffer is re-opened with the new grammar.");
      return;
    }
    editors.reopen(id);
    void api.setActiveEditor(ws.id, id);
  };
  const toggleBlame = async () => {
    if (!doc) return;
    if (doc.blameOn) { doc.setBlame(null); return; }
    try {
      doc.setBlame(await api.gitBlame(ws.id, tab.path));
    } catch (e) {
      report(e);
    }
  };
  return (
    <>
      {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
      {doc?.isMarkdown && <span className="statusbar-mode">{doc.mode}</span>}
      {doc && ws.git?.isRepo && <button className={doc.blameOn ? "active" : ""} onClick={() => void toggleBlame()} title="Blame">blame</button>}
      <span>UTF-8</span>
      <span>LF</span>
      <Dropdown className="statusbar-language" value={language} options={LANGUAGES.map((l) => ({ id: l.id, label: l.name }))} onChange={(l) => void setLanguage(l)} title="Language for this file" />
      {unsaved > 0 && <span>{unsaved} unsaved</span>}
    </>
  );
}

/** What the working tree holds, counted as the Commit panel sections it. */
function ScmFacts({ ws }: { ws: Workspace }) {
  const { info, status, stashes } = repo.useRepo(ws.id);
  if (!info?.isRepo) return null;
  const staged = status.filter((s) => !s.untracked && !s.conflicted && s.index !== ".").length;
  const conflicts = status.filter((s) => s.conflicted).length;
  const changed = repo.unstagedCount(status);
  return (
    <>
      <span>{changed} changed · {staged} staged</span>
      {conflicts > 0 && <span className="statusbar-danger">{conflicts} conflict{conflicts === 1 ? "" : "s"}</span>}
      {stashes.length > 0 && <span>{stashes.length} stash{stashes.length === 1 ? "" : "es"}</span>}
    </>
  );
}

/** The shell on screen: what it runs, where, and how many others there are. */
function TerminalFacts({ ws }: { ws: Workspace }) {
  const [, bump] = useState(0);
  useEffect(() => terminals.onTitles(() => bump((n) => n + 1)), []);
  const tab = ws.terminals.find((t) => t.id === ws.activeTerminal);
  const root = ws.path.replace(/\/+$/, "");
  const cwd = tab ? (tab.cwd === root ? "." : tab.cwd.startsWith(`${root}/`) ? `./${tab.cwd.slice(root.length + 1)}` : tab.cwd) : null;
  const waiting = ws.terminals.filter((t) => t.attention).length;
  return (
    <>
      {tab && <span className="statusbar-mono">{terminals.get(tab.id)?.title || tab.name || "shell"}</span>}
      {cwd && <span className="statusbar-mono" title={tab?.cwd}>{cwd}</span>}
      <span>
        {ws.terminals.length} tab{ws.terminals.length === 1 ? "" : "s"}
        {waiting > 0 && ` · ${waiting} with output`}
      </span>
    </>
  );
}

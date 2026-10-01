import { useEffect, useState } from "react";
import { api } from "../api";
import * as editors from "../editors";
import { LANGUAGES, languageFor } from "../editor/languages";
import { mediaKind } from "../editor/preview";
import { report } from "../notice";
import * as repo from "../repo";
import * as settings from "../settings";
import type { Workspace } from "../types";
import { percent, useImage } from "./ImageView";
import { Dropdown } from "./Menu";

/**
 * The status bar's facts for the Workspace window, by the mode it shows.
 * They load with the window's own half of the application, so the status bar
 * both windows share imports neither the editors nor the repository store.
 */
export function WorkspaceFacts({ ws }: { ws: Workspace }) {
  return ws.mode === "scm" ? <ScmFacts ws={ws} /> : <EditorFacts ws={ws} />;
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
  // Media has no encoding, line ending or language to show.
  const media = mediaKind(tab.path);
  if (media !== "file") {
    return (
      <>
        {media === "image" && <ImageFacts workspaceId={ws.id} tabId={id} />}
        {unsaved > 0 && <span>{unsaved} unsaved</span>}
      </>
    );
  }
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

/** An image's own size, and the zoom it is drawn at (IMG-08). */
function ImageFacts({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const [view] = useImage(workspaceId, tabId);
  if (!view.width) return null;
  return (
    <>
      <span>{view.width} × {view.height}</span>
      <span>{percent(view.scale)}</span>
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

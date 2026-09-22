import { Fragment, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import * as editors from "../editors";
import { MODES, type Mode } from "../editor/document";
import { LANGUAGES, languageFor } from "../editor/languages";
import * as settings from "../settings";
import type { DiffTarget, EditorGroup, Workspace } from "../types";
import { DiffView } from "./DiffView";
import { report } from "./Switcher";

const TAB_MIME = "application/x-agentic-tab";

export async function closeTab(ws: Workspace, id: string): Promise<void> {
  if (editors.isDirty(id)) {
    const path = ws.groups.flatMap((g) => g.editors).find((t) => t.id === id)?.path ?? "this file";
    const discard = await ask(`${path} has unsaved changes. Close it and discard them?`, {
      title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep open",
    });
    if (!discard) return;
  }
  await api.closeFile(ws.id, id);
}

interface AreaProps {
  ws: Workspace;
  diff: DiffTarget | null;
  onCloseDiff: () => void;
  onDiffChanged: () => void;
}

/** The editor groups side by side, or the diff view in their place. */
export function EditorArea({ ws, diff, onCloseDiff, onDiffChanged }: AreaProps) {
  const area = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(ws.splitRatio);
  useEffect(() => setRatio(ws.splitRatio), [ws.splitRatio, ws.id]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = area.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let current = ratio;
    const move = (ev: MouseEvent) => {
      current = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
      setRatio(current);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      void api.setSplitRatio(ws.id, current);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <section className="editor-area">
      {diff ? (
        <DiffView ws={ws} target={diff} onClose={onCloseDiff} onChanged={onDiffChanged} />
      ) : (
        <div className="editor-groups" ref={area}>
          {ws.groups.map((g, i) => (
            <Fragment key={g.id}>
              {i > 0 && <div className="group-divider" onMouseDown={startDrag} />}
              <GroupView
                ws={ws}
                group={g}
                active={g.id === ws.activeGroup || ws.groups.length === 1}
                style={ws.groups.length === 2 ? { flex: `${i === 0 ? ratio : 1 - ratio} 1 0` } : { flex: "1 1 0" }}
              />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function GroupView({ ws, group, active, style }: { ws: Workspace; group: EditorGroup; active: boolean; style: React.CSSProperties }) {
  const host = useRef<HTMLDivElement>(null);
  const shownRef = useRef<string | null>(null);
  const [, bump] = useState(0);
  const activeId = group.activeEditor;
  const tab = group.editors.find((t) => t.id === activeId);

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (shownRef.current && shownRef.current !== activeId) editors.unmount(shownRef.current);
    shownRef.current = activeId;
    if (tab) void editors.mount(ws, tab, container).catch(report);
  }, [activeId, ws, tab]);

  useEffect(() => () => { if (shownRef.current) editors.unmount(shownRef.current); }, []);

  const dropOnTab = (e: React.DragEvent, index: number | null) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (group.editors.some((t) => t.id === id)) {
      if (index === null) return;
      const ids = group.editors.map((t) => t.id);
      const from = ids.indexOf(id);
      ids.splice(from, 1);
      ids.splice(index > from ? index - 1 : index, 0, id);
      void api.reorderEditors(ws.id, group.id, ids);
    } else {
      void api.moveEditor(ws.id, id, group.id, index).catch(report);
    }
  };

  const entry = tab ? editors.get(tab.id) : undefined;
  const doc = entry && "doc" in entry ? entry.doc : undefined;

  return (
    <div
      className={`editor-group${active ? " active" : ""}`}
      style={style}
      onMouseDownCapture={() => { if (ws.activeGroup !== group.id) void api.setActiveGroup(ws.id, group.id); }}
    >
      <div
        className="tabs"
        onDragOver={(e) => { if (e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault(); }}
        onDrop={(e) => dropOnTab(e, null)}
      >
        {group.editors.map((t, i) => (
          <div
            key={t.id}
            className={`tab${t.id === activeId ? " active" : ""}${editors.doc(t.id)?.detached ? " detached" : ""}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(TAB_MIME, t.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault(); }}
            onDrop={(e) => dropOnTab(e, i)}
            onClick={() => void api.setActiveEditor(ws.id, t.id)}
            title={t.path}
          >
            <span className="tab-label">{editors.isDirty(t.id) ? "● " : ""}{t.path.split("/").pop()}</span>
            <button className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(ws, t.id); }} title="Close (Ctrl+W)">×</button>
          </div>
        ))}
        <span className="tabs-spacer" />
        <button className="tab-add" onClick={() => void api.splitEditor(ws.id).catch(report)} title="Split the editor (Ctrl+\)">⫿</button>
      </div>
      {tab && <Breadcrumbs ws={ws} path={tab.path} doc={doc} />}
      {doc && <Banner doc={doc} />}
      <div className="editor-host" ref={host}>
        {group.editors.length === 0 && <div className="empty">Open a file from the tree, or press Ctrl+P.</div>}
      </div>
      {entry && "binary" in entry && tab && (
        <div className="binary-notice">
          <p>{tab.path} is not a text file.</p>
          <button onClick={() => void api.openExternally(ws.id, tab.path).catch(report)}>Open with the default application</button>
        </div>
      )}
      {tab && <StatusBar ws={ws} tabId={tab.id} path={tab.path} doc={doc} />}
    </div>
  );
}

function Breadcrumbs({ ws, path, doc }: { ws: Workspace; path: string; doc?: import("../editor/document").Doc }) {
  const segments = path.split("/");
  const trail = doc?.headingTrail() ?? [];
  return (
    <div className="breadcrumbs">
      <span className="crumb">{ws.name}</span>
      {segments.map((s, i) => (
        <span key={i} className="crumb" onClick={() => { if (i < segments.length - 1) void api.setExpanded(ws.id, segments.slice(0, i + 1).join("/"), true); }}>{s}</span>
      ))}
      {trail.map((h, i) => (
        <span key={`h${i}`} className="crumb heading" onClick={() => doc?.jumpTo(h.from)}>{h.text}</span>
      ))}
      {doc?.isMarkdown && (
        <span className="mode-switch">
          {MODES.map((m: Mode) => (
            <button key={m} className={doc.mode === m ? "active" : ""} onClick={() => doc.setMode(m)} title="Cycle with Ctrl+E">{m}</button>
          ))}
        </span>
      )}
    </div>
  );
}

function Banner({ doc }: { doc: import("../editor/document").Doc }) {
  if (doc.conflict !== null) {
    return (
      <div className="banner conflict">
        <span>{doc.path} changed on disk while this buffer has unsaved changes.</span>
        <button onClick={() => doc.keepMine()}>Keep mine</button>
        <button onClick={() => doc.takeTheirs()}>Take theirs</button>
        <button onClick={() => doc.openDiff()} disabled={doc.diffOpen}>Open both</button>
      </div>
    );
  }
  if (doc.diffOpen) {
    return (
      <div className="banner">
        <span>Showing the difference against the version on disk.</span>
        <button onClick={() => { doc.closeDiff(); doc.keepMine(); }}>Done</button>
      </div>
    );
  }
  if (doc.restored) {
    return <div className="banner info"><span>Unsaved changes from the previous session were restored. Save to keep them, or undo to discard.</span></div>;
  }
  if (doc.detached) {
    return <div className="banner warn"><span>{doc.path} was deleted or moved on disk. Saving recreates it.</span></div>;
  }
  if (doc.reloadedAt && Date.now() - doc.reloadedAt < 4000) {
    return <div className="banner info"><span>Reloaded from disk.</span></div>;
  }
  return null;
}

function StatusBar({ ws, tabId, path, doc }: { ws: Workspace; tabId: string; path: string; doc?: import("../editor/document").Doc }) {
  const cursor = doc?.cursor();
  const s = settings.get();
  const abs = `${ws.path}/${path}`;
  const language = languageFor(path, s?.languages[abs]);
  const setLanguage = async (id: string) => {
    if (!s) return;
    const languages = { ...s.languages };
    if (id === languageFor(path)) delete languages[abs];
    else languages[abs] = id;
    await settings.update({ languages });
    if (doc?.dirty) {
      report("Save the file before changing its language; the buffer is re-opened with the new grammar.");
      return;
    }
    editors.reopen(tabId);
    void api.setActiveEditor(ws.id, tabId);
  };
  const toggleBlame = async () => {
    if (!doc) return;
    if (doc.blameOn) { doc.setBlame(null); return; }
    try {
      doc.setBlame(await api.gitBlame(ws.id, path));
    } catch (e) {
      report(e);
    }
  };
  return (
    <div className="statusbar">
      {ws.git?.isRepo && <span title={ws.git.state ? `${ws.git.state} in progress` : "branch"}>{ws.git.detached ? "detached" : ""} {ws.git.branch ?? ""}{ws.git.state ? ` · ${ws.git.state}` : ""}</span>}
      {cursor && <span>Ln {cursor.line}, Col {cursor.col}</span>}
      {doc?.isMarkdown && <span>{doc.mode}</span>}
      {doc && ws.git?.isRepo && <button className={doc.blameOn ? "active" : ""} onClick={() => void toggleBlame()} title="Blame">blame</button>}
      <span>UTF-8</span>
      <span>LF</span>
      <select value={language} onChange={(e) => void setLanguage(e.target.value)} title="Language for this file">
        {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );
}

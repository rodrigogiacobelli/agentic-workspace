import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import * as editors from "../editors";
import { MODES, type Mode } from "../editor/document";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LANGUAGES, languageFor } from "../editor/languages";
import * as settings from "../settings";
import type { EditorGroup, EditorTab, LayoutGroup, Workspace } from "../types";
import { DiffView } from "./DiffView";
import { Dropdown } from "./Menu";
import { FILE_MIME, SplitTree, TAB_MIME, useDropZone } from "./SplitTree";
import { report } from "./Switcher";
import { TabOverflow, useTabStrip } from "./tabs";

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

/** What a tab reads: the file name, marked when the tab shows a diff of it. */
export function tabLabel(tab: EditorTab): string {
  const name = tab.path.split("/").pop() ?? tab.path;
  if (!tab.diff) return name;
  return tab.diff.kind === "commit" ? `${name} (${tab.diff.hash?.slice(0, 7) ?? "commit"})` : `${name} (diff)`;
}

/** Group ids in reading order: left to right, top to bottom. */
export function groupOrder(ws: Workspace): string[] {
  const out: string[] = [];
  const walk = (node: typeof ws.layout) => {
    if (node.kind === "group") out.push(node.id);
    else node.children.forEach(walk);
  };
  walk(ws.layout);
  return out;
}

interface AreaProps {
  ws: Workspace;
  onGitChanged: () => void;
}

/** The editor groups, arranged by the workspace's layout tree (ED-40). */
export function EditorArea({ ws, onGitChanged }: AreaProps) {
  return (
    <section className="editor-area">
      <SplitTree<LayoutGroup>
        node={ws.layout}
        path={[]}
        keyOf={(leaf) => leaf.id}
        renderLeaf={(leaf) => {
          const group = ws.groups.find((g) => g.id === leaf.id);
          return group ? <GroupView ws={ws} group={group} active={group.id === ws.activeGroup || ws.groups.length === 1} onGitChanged={onGitChanged} /> : null;
        }}
        onResize={(path, sizes) => void api.setLayoutSizes(ws.id, path, sizes)}
      />
    </section>
  );
}

function GroupView({ ws, group, active, onGitChanged }: { ws: Workspace; group: EditorGroup; active: boolean; onGitChanged: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const shownRef = useRef<string | null>(null);
  const [, bump] = useState(0);
  const activeId = group.activeEditor;
  const tab = group.editors.find((t) => t.id === activeId);
  const strip = useTabStrip(activeId, group.editors.length);

  // A tab or a file dropped on the group: the centre joins it, an edge
  // splits it (ED-36, ED-37, ED-41). The tab strip handles its own drops.
  const zone = useDropZone(
    (types) => types.includes(TAB_MIME) || types.includes(FILE_MIME),
    (z, e) => {
      const editor = e.dataTransfer.getData(TAB_MIME);
      const path = e.dataTransfer.getData(FILE_MIME);
      if (z === "center" && editor && group.editors.some((t) => t.id === editor)) return;
      void api.dropEditor(ws.id, editor ? { editor } : { path }, group.id, z, null).catch(report);
    },
    { ignore: (target) => !!target.closest(".tab-bar") },
  );

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);

  // Mounts when the active tab changes or its document was dropped from the
  // registry — never on every session update, which would refocus the editor
  // while something else is being typed into.
  const mounted = activeId ? !!editors.get(activeId) : false;
  useEffect(() => {
    if (shownRef.current && shownRef.current !== activeId) editors.unmount(shownRef.current);
    shownRef.current = tab && !tab.diff ? activeId : null;
    const container = host.current;
    if (tab && !tab.diff && container) void editors.mount(ws, tab, container).catch(report);
  }, [activeId, ws.id, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (shownRef.current) editors.unmount(shownRef.current); }, []);

  const dropOnTab = (e: React.DragEvent, index: number | null) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    const path = e.dataTransfer.getData(FILE_MIME);
    if (!id && !path) return;
    e.preventDefault();
    e.stopPropagation();
    if (path) {
      void api.dropEditor(ws.id, { path }, group.id, "center", index).catch(report);
    } else if (group.editors.some((t) => t.id === id)) {
      if (index === null) return;
      const ids = group.editors.map((t) => t.id);
      const from = ids.indexOf(id);
      ids.splice(from, 1);
      ids.splice(index > from ? index - 1 : index, 0, id);
      void api.reorderEditors(ws.id, group.id, ids, id);
    } else {
      void api.moveEditor(ws.id, id, group.id, index).catch(report);
    }
  };
  const acceptsTab = (e: React.DragEvent) => { if (e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(FILE_MIME)) e.preventDefault(); };

  const entry = tab && !tab.diff ? editors.get(tab.id) : undefined;
  const doc = entry && "doc" in entry ? entry.doc : undefined;
  const media = entry && "media" in entry ? entry.media : null;

  return (
    <div
      ref={zone.ref}
      {...zone.handlers}
      className={`editor-group${active ? " active" : ""}`}
      onMouseDownCapture={() => { if (ws.activeGroup !== group.id) void api.setActiveGroup(ws.id, group.id); }}
    >
      <div className="tab-bar">
        <div className="tabs" ref={strip.ref} onWheel={strip.onWheel} onDragOver={acceptsTab} onDrop={(e) => dropOnTab(e, null)}>
          {group.editors.map((t, i) => (
            <div
              key={t.id}
              data-tab={t.id}
              className={`tab${t.id === activeId ? " active" : ""}${editors.doc(t.id)?.detached ? " detached" : ""}${t.preview ? " preview" : ""}`}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(TAB_MIME, t.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={acceptsTab}
              onDrop={(e) => dropOnTab(e, i)}
              onClick={() => void api.setActiveEditor(ws.id, t.id)}
              onDoubleClick={() => { if (t.preview) void api.pinEditor(ws.id, t.id); }}
              title={t.preview ? `${t.path} (preview — double-click to keep)` : t.path}
            >
              <span className="tab-label">{editors.isDirty(t.id) ? "● " : ""}{tabLabel(t)}</span>
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(ws, t.id); }} title="Close (Ctrl+W)">×</button>
            </div>
          ))}
          <span className="tabs-spacer" />
        </div>
        <TabOverflow
          strip={strip}
          entries={group.editors.map((t) => ({ id: t.id, label: tabLabel(t), active: t.id === activeId }))}
          onPick={(id) => void api.setActiveEditor(ws.id, id)}
        />
        <button className="tab-add" onClick={() => void api.splitEditor(ws.id).catch(report)} title="Split the editor (Ctrl+\)">⫿</button>
      </div>
      {tab?.diff ? (
        <DiffView key={tab.id} ws={ws} tab={tab} onClose={() => void closeTab(ws, tab.id)} onChanged={onGitChanged} />
      ) : (
        <>
          {tab && <Breadcrumbs ws={ws} path={tab.path} doc={doc} />}
          {doc && <Banner doc={doc} />}
          <div className="editor-host" ref={host} hidden={!!media}>
            {group.editors.length === 0 && <div className="empty">Open a file from the tree, or press Ctrl+P.</div>}
          </div>
          {media && tab && <MediaView ws={ws} path={tab.path} kind={media} />}
          {entry && "binary" in entry && tab && (
            <div className="binary-notice">
              <p>{tab.path} is not a text file.</p>
              <button onClick={() => void api.openExternally(ws.id, tab.path).catch(report)}>Open with the default application</button>
            </div>
          )}
          {tab && <StatusBar ws={ws} tabId={tab.id} path={tab.path} doc={doc} />}
        </>
      )}
      {zone.overlay}
    </div>
  );
}

/** An image, an audio file or a video opened from the tree, shown as itself. */
function MediaView({ ws, path, kind }: { ws: Workspace; path: string; kind: "image" | "audio" | "video" }) {
  const url = convertFileSrc(`${ws.path}/${path}`);
  return (
    <div className="media-view">
      {kind === "image" && <img src={url} alt={path} title={path} />}
      {kind === "audio" && <audio src={url} controls title={path} />}
      {kind === "video" && <video src={url} controls title={path} />}
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
      <Dropdown className="statusbar-language" value={language} options={LANGUAGES.map((l) => ({ id: l.id, label: l.name }))} onChange={(id) => void setLanguage(id)} title="Language for this file" />
    </div>
  );
}

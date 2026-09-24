import { useCallback, useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useChanged } from "../live";
import { rank } from "../fuzzy";
import { report } from "../notice";
import * as repo from "../repo";
import type { Tag, Workspace } from "../types";
import { Icon } from "./icons";
import { Palette } from "./Palette";
import { Prompt } from "./Prompt";

type Step = { kind: "name" } | { kind: "kind"; name: string } | { kind: "message"; name: string };

/** The repository's tags, newest first; create one at HEAD, copy a name, delete one. */
export function TagsPanel({ ws }: { ws: Workspace }) {
  const { info } = repo.useRepo(ws.id);
  const isRepo = info?.isRepo === true;
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step | null>(null);

  const load = useCallback(() => api.gitTags(ws.id).then(setTags).catch(report), [ws.id]);
  useEffect(() => { if (isRepo) void load(); }, [isRepo, load]);
  // An agent may tag a release from a terminal; the watcher says so.
  useChanged(ws.id, () => { if (isRepo) void load(); });

  const shown = useMemo(() => rank(query, tags ?? [], (t) => t.name, Infinity), [query, tags]);

  if (!info) return <div className="panel"><div className="tree-loading loading">Loading…</div></div>;
  if (!info.isRepo) return <div className="panel"><div className="panel-empty">{ws.name} is not inside a git repository.</div></div>;

  /** This list and every surface reading the repository store see the change. */
  const changed = () => { void load(); void repo.refresh(ws.id); };

  const create = (name: string, message: string | null) => {
    setStep(null);
    void api.gitCreateTag(ws.id, name, message, null).catch(report).finally(changed);
  };

  const remove = async (t: Tag) => {
    const yes = await ask(`Delete the tag ${t.name}? It marks ${t.hash}, “${t.subject}”.`, {
      title: "Delete tag", kind: "warning", okLabel: "Delete", cancelLabel: "Keep",
    });
    if (!yes) return;
    await api.gitDeleteTag(ws.id, t.name).catch(report);
    changed();
  };

  return (
    <div className="panel">
      <div className="panel-bar">
        <input placeholder="Filter tags" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button title="New tag at HEAD…" onClick={() => setStep({ kind: "name" })}>＋</button>
      </div>
      <div className="panel-list">
        {!tags && <div className="tree-loading loading">Loading…</div>}
        {shown.map((t) => (
          <div key={t.name} className="git-row plain" title={`${t.name}${t.annotated ? " (annotated)" : ""}\n${t.subject}`}>
            <span className="ref-mark tag"><Icon name="tag" size={12} /></span>
            <span className="ref-name tag">{t.name}</span>
            <span className="git-dir">{t.subject}</span>
            <span className="ref-meta"><span className="ref-date">{t.date}</span><span className="ref-hash">{t.hash}</span></span>
            <span className="git-actions">
              <button title="Copy the tag name" onClick={() => void api.copyText(t.name).catch(report)}><Icon name="copy" size={13} /></button>
              <button title="Delete tag" onClick={() => void remove(t)}><Icon name="close" size={13} /></button>
            </span>
          </div>
        ))}
        {tags && shown.length === 0 && <div className="panel-empty">{query ? "No tag matches." : "This repository has no tags."}</div>}
      </div>
      {step?.kind === "name" && (
        <Prompt title="New tag name" onClose={() => setStep(null)} onSubmit={(name) => setStep({ kind: "kind", name })} />
      )}
      {step?.kind === "kind" && (
        <Palette
          title={`Tag ${step.name} at HEAD`}
          items={[
            { id: "annotated", label: "Annotated, with a message…" },
            { id: "lightweight", label: "Lightweight" },
          ]}
          onClose={() => setStep(null)}
          onPick={(item) => {
            if (item.id === "annotated") setStep({ kind: "message", name: step.name });
            else create(step.name, null);
          }}
        />
      )}
      {step?.kind === "message" && (
        <Prompt title={`Message for ${step.name}`} onClose={() => setStep(null)} onSubmit={(message) => create(step.name, message)} />
      )}
    </div>
  );
}

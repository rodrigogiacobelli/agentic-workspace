import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import * as settings from "../settings";
import { allThemes, isImported } from "../themes";
import type { HotkeyStatus, Settings, Workspace } from "../types";
import { defaultLayout, normalize, showPanel, PANELS } from "./dock";
import { Dropdown } from "./Menu";
import { report } from "./Switcher";

interface Props {
  current: Settings;
  workspace: Workspace | undefined;
  onClose: () => void;
}

export function SettingsDialog({ current, workspace, onClose }: Props) {
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    api.hotkeyStatus().then(setHotkey).catch(() => {});
    const unlisten = events.onHotkey(setHotkey);
    return () => { void unlisten.then((u) => u()); };
  }, []);

  const set = (patch: Partial<Settings>) => void settings.update(patch);
  const wsKey = workspace?.path ?? "";
  const wsSettings = current.workspaces[wsKey] ?? { clipboardDir: null, notifications: null, theme: null };
  const setWs = (patch: Partial<typeof wsSettings>) =>
    set({ workspaces: { ...current.workspaces, [wsKey]: { ...wsSettings, ...patch } } });

  const importTheme = async () => {
    const picked = await open({ multiple: false, title: "Import a VS Code theme", filters: [{ name: "Theme", extensions: ["json", "jsonc", "vsix"] }] });
    if (typeof picked !== "string") return;
    try {
      const imported = await api.importThemes(picked);
      await settings.reloadImported();
      bump((n) => n + 1);
      for (const t of imported) {
        const detail = t.report.length ? `\n${t.report.map((r) => `• ${r}`).join("\n")}` : "\nEverything mapped.";
        report(`Imported theme "${t.name}".${detail}`);
      }
      if (imported[0]) set({ theme: imported[0].id });
    } catch (e) {
      report(`Theme import failed: ${String(e)}`);
    }
  };

  const removeTheme = async () => {
    try {
      await api.deleteTheme(current.theme);
      await settings.reloadImported();
      bump((n) => n + 1);
    } catch (e) {
      report(e);
    }
  };

  const text = (label: string, value: string, onChange: (v: string) => void, placeholder = "") => (
    <label className="setting">
      <span>{label}</span>
      <input defaultValue={value} placeholder={placeholder} onBlur={(e) => { if (e.target.value !== value) onChange(e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
  const number = (label: string, value: number, onChange: (v: number) => void, min: number, max: number, step = 1) => (
    <label className="setting">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => { const v = Number(e.target.value); if (v >= min && v <= max) onChange(v); }} />
    </label>
  );
  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="setting">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="dialog-title"><span>Settings</span><button onClick={onClose}>×</button></div>
        <h3>Appearance</h3>
        <label className="setting">
          <span>Theme</span>
          <span className="setting-row">
            <Dropdown value={current.theme} options={allThemes().map((t) => ({ id: t.id, label: t.name }))} onChange={(id) => set({ theme: id })} />
            <button onClick={() => void importTheme()} title="Import a VS Code theme (.json or .vsix)">Import…</button>
            {isImported(current.theme) && <button onClick={() => void removeTheme()} title="Remove this imported theme">Remove</button>}
          </span>
        </label>
        <label className="setting">
          <span>Panel tabs</span>
          <Dropdown value={current.panelTabs} options={[{ id: "text", label: "Words" }, { id: "icons", label: "Icons" }]} onChange={(id) => set({ panelTabs: id as "text" | "icons" })} />
        </label>
        <h3>Raise from anywhere</h3>
        {text("Preferred key (portal syntax, e.g. CTRL+ALT+a)", current.globalHotkey, (v) => set({ globalHotkey: v }))}
        <div className="setting">
          <span>
            {hotkey?.active ? `Bound to ${hotkey.trigger}` : hotkey?.message ?? "Binding…"}
          </span>
          <button onClick={() => void api.configureHotkey()}>Open the desktop's shortcut editor</button>
        </div>
        <h3>Terminal</h3>
        {text("Font family", current.terminalFontFamily, (v) => set({ terminalFontFamily: v }), "system monospace")}
        {number("Font size", current.terminalFontSize, (v) => set({ terminalFontSize: v }), 8, 32)}
        {number("Line height", current.terminalLineHeight, (v) => set({ terminalLineHeight: v }), 1, 2, 0.05)}
        <h3>Editor</h3>
        {text("Monospace font", current.editorFontFamily, (v) => set({ editorFontFamily: v }), "system monospace")}
        {number("Monospace size", current.editorFontSize, (v) => set({ editorFontSize: v }), 8, 32)}
        {text("Prose font", current.proseFontFamily, (v) => set({ proseFontFamily: v }), "system sans-serif")}
        {number("Prose size", current.proseFontSize, (v) => set({ proseFontSize: v }), 8, 40)}
        {toggle("Autosave", current.autosave, (v) => set({ autosave: v }))}
        {number("Autosave delay (ms)", current.autosaveDelayMs, (v) => set({ autosaveDelayMs: v }), 200, 60000, 100)}
        {number("Warn for assets above (MB)", current.assetWarnMb, (v) => set({ assetWarnMb: v }), 1, 1000)}
        <label className="setting">
          <span>Asset links — what paste and drop write</span>
          <Dropdown
            value={current.assetLinks}
            options={[{ id: "markdown", label: "Markdown link, relative to the note" }, { id: "citation", label: "Citation: @/path from the workspace root" }]}
            onChange={(id) => set({ assetLinks: id as "markdown" | "citation" })}
          />
        </label>
        <h3>Panels</h3>
        {normalize(current.panelLayout ?? defaultLayout()).hidden.map((id) => (
          <div className="setting" key={id}>
            <span>{PANELS.find((p) => p.id === id)?.label ?? id} is hidden</span>
            <button onClick={() => set({ panelLayout: showPanel(normalize(current.panelLayout ?? defaultLayout()), id) })}>Show</button>
          </div>
        ))}
        <div className="setting">
          <span>Files, Search, Git and Outline back in one left sidebar</span>
          <button onClick={() => set({ panelLayout: null })}>Reset panel layout</button>
        </div>
        <h3>Agent signals</h3>
        {toggle("Desktop notifications when a busy terminal goes quiet", current.notifications, (v) => set({ notifications: v }))}
        {number("Quiet threshold (seconds, minimum 5)", current.quietThresholdS, (v) => set({ quietThresholdS: v }), 5, 3600)}
        {workspace && (
          <>
            <h3>Workspace: {workspace.name}</h3>
            {text("Clipboard folder (relative to the workspace)", wsSettings.clipboardDir ?? "", (v) => setWs({ clipboardDir: v || null }), "clipboard")}
            <label className="setting">
              <span>Theme for this workspace</span>
              <Dropdown value={wsSettings.theme ?? ""} options={[{ id: "", label: "Global theme" }, ...allThemes().map((t) => ({ id: t.id, label: t.name }))]} onChange={(id) => setWs({ theme: id || null })} />
            </label>
            <label className="setting">
              <span>Notifications</span>
              <Dropdown
                value={wsSettings.notifications === null ? "inherit" : wsSettings.notifications ? "on" : "off"}
                options={[{ id: "inherit", label: "Follow the global setting" }, { id: "on", label: "On" }, { id: "off", label: "Off" }]}
                onChange={(id) => setWs({ notifications: id === "inherit" ? null : id === "on" })}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

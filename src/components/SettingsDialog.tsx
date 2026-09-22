import * as settings from "../settings";
import { themes } from "../themes";
import type { Settings, Workspace } from "../types";

interface Props {
  current: Settings;
  workspace: Workspace | undefined;
  onClose: () => void;
}

export function SettingsDialog({ current, workspace, onClose }: Props) {
  const set = (patch: Partial<Settings>) => void settings.update(patch);
  const wsKey = workspace?.path ?? "";
  const wsSettings = current.workspaces[wsKey] ?? { clipboardDir: null, notifications: null, theme: null };
  const setWs = (patch: Partial<typeof wsSettings>) =>
    set({ workspaces: { ...current.workspaces, [wsKey]: { ...wsSettings, ...patch } } });

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
          <select value={current.theme} onChange={(e) => set({ theme: e.target.value })}>
            {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
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
        <h3>Agent signals</h3>
        {toggle("Desktop notifications when a busy terminal goes quiet", current.notifications, (v) => set({ notifications: v }))}
        {number("Quiet threshold (seconds, minimum 5)", current.quietThresholdS, (v) => set({ quietThresholdS: v }), 5, 3600)}
        {workspace && (
          <>
            <h3>Workspace: {workspace.name}</h3>
            {text("Clipboard folder (relative to the workspace)", wsSettings.clipboardDir ?? "", (v) => setWs({ clipboardDir: v || null }), "clipboard")}
            <label className="setting">
              <span>Notifications</span>
              <select value={wsSettings.notifications === null ? "inherit" : wsSettings.notifications ? "on" : "off"} onChange={(e) => setWs({ notifications: e.target.value === "inherit" ? null : e.target.value === "on" })}>
                <option value="inherit">Follow the global setting</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </>
        )}
      </div>
    </div>
  );
}

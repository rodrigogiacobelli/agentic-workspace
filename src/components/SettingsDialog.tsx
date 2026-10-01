import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, events } from "../api";
import * as settings from "../settings";
import { allThemes, isImported } from "../themes";
import { useModal } from "../modal";
import { useDismiss } from "../motion";
import type { HotkeyStatus, Settings, Workspace } from "../types";
import { CredentialsPage, WorkspaceCredentials } from "./CredentialsPage";
import { normalizeAll, panelInfo, showPanel } from "./dock";
import { Dropdown } from "./Menu";
import { notify, report } from "../notice";

interface Props {
  current: Settings;
  workspace: Workspace | undefined;
  /** The root of the workspace's family, whose settings govern the
   *  family's terminals (AGT-12, CRED-16). */
  root: Workspace | undefined;
  onClose: () => void;
}

/** The column of tabs, in order; the active workspace's own page follows a divider. */
const PAGES = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "panels", label: "Panels" },
  { id: "signals", label: "Agent signals" },
  { id: "credentials", label: "Credentials" },
];

/**
 * This window's writes, one after another. Each sends the whole settings, so
 * two in flight would each carry the other's old value — a field committed by
 * its blur as the dialog closes, and the page it closed on, would race.
 */
let writes: Promise<void> = Promise.resolve();

export function SettingsDialog({ current, workspace, root, onClose }: Props) {
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  // As stored, not as shown: a workspace page with no workspace to show opens
  // General, and stays remembered for when there is one again.
  const [tab, setTab] = useState(current.settingsTab);
  const dialog = useRef<HTMLDivElement>(null);
  const [closing, dismiss] = useDismiss(onClose);
  const [, bump] = useState(0);
  // At dialog level, not on General: the binding reports while the dialog is open, whichever page shows.
  useEffect(() => {
    api.hotkeyStatus().then(setHotkey).catch(() => {});
    const unlisten = events.onHotkey(setHotkey);
    return () => { void unlisten.then((u) => u()); };
  }, []);

  const set = (patch: Partial<Settings>) => {
    writes = writes.then(() => settings.update(patch)).catch(report);
  };
  const wsKey = workspace?.path ?? "";
  const wsSettings = current.workspaces[wsKey] ?? { clipboardDir: null, notifications: null, theme: null, sshKey: null, identity: null, terminalCredentials: false };
  const setWs = (patch: Partial<typeof wsSettings>) =>
    set({ workspaces: { ...current.workspaces, [wsKey]: { ...wsSettings, ...patch } } });

  const pages = workspace ? [...PAGES, { id: "workspace", label: `Workspace: ${workspace.name}` }] : PAGES;
  const shown = pages.some((p) => p.id === tab) ? tab : "general";

  const close = () => {
    if (closing) return;
    // A field still being edited commits on its blur, while its page is still
    // there to commit it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && dialog.current?.contains(focused)) focused.blur();
    // Once, on the way out (SET-02): every write reaches both windows and
    // re-fits every terminal, which arrowing down the column must not do.
    if (tab !== current.settingsTab) set({ settingsTab: tab });
    dismiss();
  };
  useModal(dialog, close);

  // A vertical tab list: arrows move the selection and wrap, Home and End go
  // to the ends, and the page follows the tab the keyboard is on. Only the
  // selected tab is in the Tab order, so Tab from it goes into the page.
  const onTabKey = (e: KeyboardEvent) => {
    const at = pages.findIndex((p) => p.id === shown);
    const n = pages.length;
    const to = e.key === "ArrowDown" ? (at + 1) % n : e.key === "ArrowUp" ? (at - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(pages[to].id);
    document.getElementById(`settings-tab-${pages[to].id}`)?.focus();
  };

  const importTheme = async () => {
    const picked = await open({ multiple: false, title: "Import a VS Code theme", filters: [{ name: "Theme", extensions: ["json", "jsonc", "vsix"] }] });
    if (typeof picked !== "string") return;
    try {
      const imported = await api.importThemes(picked);
      await settings.reloadImported();
      bump((n) => n + 1);
      // A report of what did not map is a failure, one line per item; a
      // clean import is a confirmation.
      for (const t of imported) {
        if (t.report.length) report(`Imported theme "${t.name}".\n${t.report.map((r) => `• ${r}`).join("\n")}`);
        else notify(`Imported theme "${t.name}". Everything mapped.`);
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

  const page = (): ReactNode => {
    switch (shown) {
      case "general":
        return (
          <>
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
              <span>Modes and panel tabs read as</span>
              <Dropdown value={current.tabDisplay} options={[{ id: "labels", label: "Labels" }, { id: "icons", label: "Icons" }]} onChange={(id) => set({ tabDisplay: id as "labels" | "icons" })} />
            </label>
            <h3>Raise from anywhere</h3>
            {text("Preferred key (portal syntax, e.g. CTRL+ALT+a)", current.globalHotkey, (v) => set({ globalHotkey: v }))}
            <div className="setting">
              <span>
                {hotkey?.active ? `Bound to ${hotkey.trigger}` : hotkey?.message ?? "Binding…"}
              </span>
              <button onClick={() => void api.configureHotkey()}>Open the desktop's shortcut editor</button>
            </div>
          </>
        );
      case "editor":
        return (
          <>
            {text("Monospace font", current.editorFontFamily, (v) => set({ editorFontFamily: v }), "system monospace")}
            {number("Monospace size", current.editorFontSize, (v) => set({ editorFontSize: v }), 8, 32)}
            {text("Prose font", current.proseFontFamily, (v) => set({ proseFontFamily: v }), "system sans-serif")}
            {number("Prose size", current.proseFontSize, (v) => set({ proseFontSize: v }), 8, 40)}
            <label className="setting">
              <span>Markdown opens in</span>
              <Dropdown value={current.markdownMode} options={[{ id: "source", label: "Source" }, { id: "split", label: "Split" }, { id: "rich", label: "Rich" }]} onChange={(id) => set({ markdownMode: id as "source" | "split" | "rich" })} />
            </label>
            {toggle("Rich mode fills the tab width", current.richFullWidth, (v) => set({ richFullWidth: v }))}
            {toggle("Autosave", current.autosave, (v) => set({ autosave: v }))}
            {number("Autosave delay (ms)", current.autosaveDelayMs, (v) => set({ autosaveDelayMs: v }), 200, 60000, 100)}
            {number("Warn for assets above (MB)", current.assetWarnMb, (v) => set({ assetWarnMb: v }), 1, 1000)}
            {toggle("Ask before moving files to the trash", current.confirmDelete, (v) => set({ confirmDelete: v }))}
            <label className="setting">
              <span>Asset links — what paste and drop write</span>
              <Dropdown
                value={current.assetLinks}
                options={[{ id: "markdown", label: "Markdown link, relative to the note" }, { id: "citation", label: "Citation: @path from the workspace root" }]}
                onChange={(id) => set({ assetLinks: id as "markdown" | "citation" })}
              />
            </label>
          </>
        );
      case "terminal":
        return (
          <>
            {text("Font family", current.terminalFontFamily, (v) => set({ terminalFontFamily: v }), "system monospace")}
            {number("Font size", current.terminalFontSize, (v) => set({ terminalFontSize: v }), 8, 32)}
            {number("Line height", current.terminalLineHeight, (v) => set({ terminalLineHeight: v }), 1, 2, 0.05)}
            {text("Shell", current.terminalShell, (v) => set({ terminalShell: v }), "$SHELL — applies to the next terminal")}
            <label className="setting">
              <span>New terminals open in</span>
              <Dropdown
                value={current.terminalOpenIn}
                options={[{ id: "root", label: "The root workspace" }, { id: "workspace", label: "The workspace on screen" }]}
                onChange={(id) => set({ terminalOpenIn: id as "root" | "workspace" })}
              />
            </label>
            <label className="setting">
              <span>Renderer — GPU drawing is slower where the webview cannot reach the GPU</span>
              <Dropdown
                value={current.terminalGpu}
                options={[{ id: "auto", label: "Auto" }, { id: "webgl", label: "GPU (WebGL)" }, { id: "dom", label: "DOM" }]}
                onChange={(id) => set({ terminalGpu: id as "auto" | "webgl" | "dom" })}
              />
            </label>
          </>
        );
      case "panels":
        return (
          <>
            {(["editor", "scm"] as const).flatMap((mode) => {
              const layouts = normalizeAll(current.panelLayout);
              return layouts[mode].hidden.map((id) => (
                <div className="setting" key={`${mode}:${id}`}>
                  <span>{panelInfo(id)?.label ?? id} is hidden in {mode === "editor" ? "Editor" : "Source Control"}</span>
                  <button onClick={() => set({ panelLayout: { ...layouts, [mode]: showPanel(layouts[mode], id) } })}>Show</button>
                </div>
              ));
            })}
            <div className="setting">
              <span>Every mode's panels back where they started</span>
              <button onClick={() => set({ panelLayout: null })}>Reset panel layout</button>
            </div>
          </>
        );
      case "signals":
        return (
          <>
            {toggle("Desktop notifications when a busy terminal goes quiet", current.notifications, (v) => set({ notifications: v }))}
            {number("Quiet threshold (seconds, minimum 5)", current.quietThresholdS, (v) => set({ quietThresholdS: v }), 5, 3600)}
          </>
        );
      case "credentials":
        return <CredentialsPage current={current} />;
      case "workspace": {
        if (!workspace) return null;
        // A member's terminals are its family's, on the root: the root's
        // setting governs their notifications, and this folder's value —
        // shared with any other entry on it — reaches none of them (AGT-12).
        const family = root && root.id !== workspace.id ? root : undefined;
        // Keyed by the workspace: another becoming active while the page is
        // open must not leave the last one's values in the fields.
        return (
          <Fragment key={workspace.path}>
            <label className="setting">
              <span>Theme for this workspace</span>
              <Dropdown value={wsSettings.theme ?? ""} options={[{ id: "", label: "Global theme" }, ...allThemes().map((t) => ({ id: t.id, label: t.name }))]} onChange={(id) => setWs({ theme: id || null })} />
            </label>
            {family ? (
              <p className="settings-note">Desktop notifications for the shells of {family.name}'s family follow {family.name}'s setting.</p>
            ) : (
              <label className="setting">
                <span>Notifications</span>
                <Dropdown
                  value={wsSettings.notifications === null ? "inherit" : wsSettings.notifications ? "on" : "off"}
                  options={[{ id: "inherit", label: "Follow the global setting" }, { id: "on", label: "On" }, { id: "off", label: "Off" }]}
                  onChange={(id) => setWs({ notifications: id === "inherit" ? null : id === "on" })}
                />
              </label>
            )}
            {text("Clipboard folder (relative to the workspace)", wsSettings.clipboardDir ?? "", (v) => setWs({ clipboardDir: v || null }), "clipboard")}
            <WorkspaceCredentials current={current} workspace={workspace} family={family} />
          </Fragment>
        );
      }
      default:
        return null;
    }
  };

  // Inert through its exit (standards-motion): a click on the fading page
  // would write a setting, or ask a question, after the dialog was dismissed.
  return (
    <div className={`overlay${closing ? " is-closing" : ""}`} onMouseDown={close}>
      <div
        ref={dialog}
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        inert={closing}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title"><span id="settings-title">Settings</span><button onClick={close} aria-label="Close settings">×</button></div>
        <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-labelledby="settings-title" onKeyDown={onTabKey}>
          {pages.map((p) => (
            <Fragment key={p.id}>
              {p.id === "workspace" && <div className="settings-divider" aria-hidden="true" />}
              <button
                id={`settings-tab-${p.id}`}
                role="tab"
                aria-selected={p.id === shown}
                aria-controls="settings-page"
                tabIndex={p.id === shown ? 0 : -1}
                autoFocus={p.id === shown}
                title={p.id === "workspace" ? workspace?.path : undefined}
                onClick={() => setTab(p.id)}
              >
                {p.label}
              </button>
            </Fragment>
          ))}
        </div>
        <div key={shown} id="settings-page" className="settings-page" role="tabpanel" aria-labelledby={`settings-tab-${shown}`}>
          {page()}
        </div>
      </div>
    </div>
  );
}

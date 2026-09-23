import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "./api";
import * as editors from "./editors";
import * as settings from "./settings";
import { useDismiss } from "./motion";
import { Palette } from "./components/Palette";
import { SettingsDialog } from "./components/SettingsDialog";
import { Switcher, report } from "./components/Switcher";
import { TerminalWindow } from "./components/TerminalWindow";
import { WorkspaceWindow } from "./components/WorkspaceWindow";
import type { Session, Settings, WindowRole } from "./types";

export function App({ role }: { role: WindowRole }) {
  const [session, setSession] = useState<Session | null>(null);
  const [current, setCurrent] = useState<Settings | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Keyed, not indexed: a toast plays its own exit, and an index would hand
  // that state to whichever message shifted up into its place.
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    let next = 0;
    const push = (m: string) => setNotices((n) => [...n, { id: next++, text: m }]);
    settings.init().then(setCurrent).catch(report);
    api.getSession().then(setSession).catch(report);
    api.takeNotices().then((ns) => ns.forEach(push)).catch(() => {});
    const unlisten = [
      events.onSession(setSession),
      events.onNotice(push),
      events.onQuitRequested(() => void quit()),
    ];
    const stop = settings.subscribe(setCurrent);
    const onLocal = (e: Event) => push((e as CustomEvent<string>).detail);
    window.addEventListener("app-notice", onLocal);
    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      stop();
      window.removeEventListener("app-notice", onLocal);
    };
  }, []);

  useEffect(() => editors.subscribe(() => bump((n) => n + 1)), []);

  if (!session || !current) return null;

  const workspaces = [...session.recent, ...session.workspaces.map((w) => w.id)]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => session.workspaces.find((w) => w.id === id))
    .filter((w): w is NonNullable<typeof w> => !!w);
  const active = session.workspaces.find((w) => w.id === session.active);
  settings.setActivePath(active?.path ?? null);

  return (
    <div className={`app app-${role}`}>
      <Switcher session={session} role={role} unsaved={editors.dirtyCount()} onSettings={() => setShowSettings(true)} />
      {role === "terminal" ? (
        <TerminalWindow session={session} openSwitcher={() => setSwitcher(true)} openSettings={() => setShowSettings(true)} />
      ) : (
        <WorkspaceWindow session={session} openSwitcher={() => setSwitcher(true)} openSettings={() => setShowSettings(true)} />
      )}
      {switcher && (
        <Palette
          title="Switch workspace"
          items={workspaces.map((w) => ({ id: w.id, label: w.name, detail: w.path }))}
          onClose={() => setSwitcher(false)}
          onPick={(item) => { setSwitcher(false); void api.switchWorkspace(item.id).catch(report); }}
        />
      )}
      {showSettings && <SettingsDialog current={current} workspace={active} onClose={() => setShowSettings(false)} />}
      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n) => (
            <Notice key={n.id} message={n.text} onClose={() => setNotices((all) => all.filter((o) => o.id !== n.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One toast. Every notice here carries a failure, so none of them expires on
 * a timer: the reader dismisses it, and the dismissal is what plays its exit
 * (§9, WCAG 2.2.1).
 */
function Notice({ message, onClose }: { message: string; onClose: () => void }) {
  const [closing, dismiss] = useDismiss(onClose);
  return (
    <div className={`notice${closing ? " is-closing" : ""}`}>
      <span>{message}</span>
      <button onClick={dismiss} title="Dismiss">×</button>
    </div>
  );
}

/** The quit path: one prompt about unsaved buffers, then every shell hangs up. */
async function quit(): Promise<void> {
  const unsaved = editors.dirtyCount();
  if (unsaved > 0) {
    const yes = await ask(
      `${unsaved} editor buffer${unsaved === 1 ? " has" : "s have"} unsaved changes. Quit and discard them?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
    );
    if (!yes) return;
  }
  await api.quit();
}

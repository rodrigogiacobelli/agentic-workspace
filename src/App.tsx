import { useEffect, useState, type ComponentType } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "./api";
import * as settings from "./settings";
import { useDismiss } from "./motion";
import { Palette } from "./components/Palette";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { Switcher, report } from "./components/Switcher";
import type { Session, Settings, WindowRole, Workspace } from "./types";

/** What only one window draws: its body, and its mode's facts in the status bar. */
interface Half {
  Body: ComponentType<{ session: Session; openSwitcher: () => void; openSettings: () => void }>;
  Facts: ComponentType<{ ws: Workspace }>;
}

/**
 * Each window loads its own half of the application and never the other's:
 * the Terminal window fetches no CodeMirror and no git panel, the Workspace
 * window no xterm. Not `React.lazy`: React 19 holds a Suspense boundary's
 * content back until 300 ms after its fallback showed, and a lazy component
 * shows the fallback at least once, so every start would wait for it.
 */
function loadHalf(role: WindowRole): Promise<Half> {
  const half: Promise<Half> = role === "terminal"
    ? import("./components/TerminalWindow").then((m) => ({ Body: m.TerminalWindow, Facts: m.TerminalFacts }))
    : Promise.all([import("./components/WorkspaceWindow"), import("./components/WorkspaceFacts")])
        .then(([w, f]) => ({ Body: w.WorkspaceWindow, Facts: f.WorkspaceFacts }));
  // A half that fails to load says so in the window instead of leaving it blank.
  return half.catch((e: unknown) => {
    console.error(e);
    return { Body: () => <main className="empty">This window failed to load: {String(e)}</main>, Facts: () => null };
  });
}

export function App({ role }: { role: WindowRole }) {
  const [session, setSession] = useState<Session | null>(null);
  const [current, setCurrent] = useState<Settings | null>(null);
  const [half, setHalf] = useState<Half | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Keyed, not indexed: a toast plays its own exit, and an index would hand
  // that state to whichever message shifted up into its place.
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([]);

  useEffect(() => {
    let next = 0;
    const push = (m: string) => setNotices((n) => [...n, { id: next++, text: m }]);
    void loadHalf(role).then(setHalf);
    settings.init().then(setCurrent).catch(report);
    api.getSession().then(setSession).catch(report);
    api.takeNotices().then((ns) => ns.forEach(push)).catch(() => {});
    const unlisten = [events.onSession(setSession), events.onNotice(push)];
    // The request reaches every window, and only this one holds buffers to
    // ask about: the Terminal window answering it would quit past the prompt.
    if (role === "workspace") unlisten.push(events.onQuitRequested(() => void quit()));
    const stop = settings.subscribe(setCurrent);
    const onLocal = (e: Event) => push((e as CustomEvent<string>).detail);
    window.addEventListener("app-notice", onLocal);
    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      stop();
      window.removeEventListener("app-notice", onLocal);
    };
  }, [role]);

  if (!session || !current || !half) return null;
  const { Body, Facts } = half;

  const workspaces = [...session.recent, ...session.workspaces.map((w) => w.id)]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => session.workspaces.find((w) => w.id === id))
    .filter((w): w is NonNullable<typeof w> => !!w);
  const active = session.workspaces.find((w) => w.id === session.active);
  settings.setActivePath(active?.path ?? null);

  return (
    <div className={`app app-${role}`}>
      <Switcher session={session} role={role} onSettings={() => setShowSettings(true)} />
      <Body session={session} openSwitcher={() => setSwitcher(true)} openSettings={() => setShowSettings(true)} />
      <StatusBar session={session} role={role}>{active && <Facts ws={active} />}</StatusBar>
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
  // Loaded with this window's half already; a static import would pull the
  // editors into the Terminal window's bundle too.
  const unsaved = (await import("./editors")).dirtyCount();
  if (unsaved > 0) {
    const yes = await ask(
      `${unsaved} editor buffer${unsaved === 1 ? " has" : "s have"} unsaved changes. Quit and discard them?`,
      { title: "Unsaved changes", kind: "warning", okLabel: "Quit", cancelLabel: "Cancel" },
    );
    if (!yes) return;
  }
  await api.quit();
}

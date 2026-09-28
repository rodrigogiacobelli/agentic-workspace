import { useEffect, useRef, useState, type ComponentType } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "./api";
import * as settings from "./settings";
import { useDismiss } from "./motion";
import { CredentialPrompt } from "./components/CredentialPrompt";
import { Palette } from "./components/Palette";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { Switcher, report } from "./components/Switcher";
import type { Session, Settings, WindowRole, Workspace } from "./types";

/** A failure stays until the reader dismisses it; an info notice confirms something that worked. */
type NoticeKind = "error" | "info";

/** How long an info notice stays: design-motion's short confirmation. */
const CONFIRM_DWELL_MS = 3500;

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
  const [notices, setNotices] = useState<{ id: number; text: string; kind: NoticeKind }[]>([]);

  useEffect(() => {
    let next = 0;
    const push = (m: string, kind: NoticeKind = "error") => setNotices((n) => [...n, { id: next++, text: m, kind }]);
    void loadHalf(role).then(setHalf);
    settings.init().then(setCurrent).catch(report);
    api.getSession().then(setSession).catch(report);
    api.takeNotices().then((ns) => ns.forEach((m) => push(m))).catch(() => {});
    const unlisten = [events.onSession(setSession), events.onNotice(push), events.onInfo((m) => push(m, "info"))];
    // The request reaches every window, and only this one holds buffers to
    // ask about: the Terminal window answering it would quit past the prompt.
    if (role === "workspace") unlisten.push(events.onQuitRequested(() => void quit()));
    const stop = settings.subscribe(setCurrent);
    // `report` sends the failure as a bare string, `notify` a kinded object.
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent<string | { text: string; kind: NoticeKind }>).detail;
      if (typeof detail === "string") push(detail);
      else push(detail.text, detail.kind);
    };
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
      <CredentialPrompt role={role} />
      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n) => (
            <Notice key={n.id} message={n.text} kind={n.kind} onClose={() => setNotices((all) => all.filter((o) => o.id !== n.id))} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One toast. A failure never expires on a timer: the reader dismisses it, and
 * the dismissal is what plays its exit (§9, WCAG 2.2.1). An info notice asks
 * nothing of the reader, so it leaves by itself after its dwell, which pauses
 * while the pointer or the keyboard is on it and resumes where it stopped.
 */
function Notice({ message, kind, onClose }: { message: string; kind: NoticeKind; onClose: () => void }) {
  const [closing, dismiss] = useDismiss(onClose);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const left = useRef(CONFIRM_DWELL_MS);
  const held = hovered || focused;
  useEffect(() => {
    if (kind !== "info" || held || closing) return;
    const started = performance.now();
    const timer = window.setTimeout(dismiss, left.current);
    return () => {
      window.clearTimeout(timer);
      left.current -= performance.now() - started;
    };
  }, [kind, held, closing, dismiss]);
  return (
    <div
      className={`notice${kind === "info" ? " info" : ""}${closing ? " is-closing" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
    >
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

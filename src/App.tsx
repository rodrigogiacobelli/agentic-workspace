import { useEffect, useRef, useState, type ComponentType } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, events } from "./api";
import { familyRoot } from "./modes";
import * as settings from "./settings";
import { useDismiss } from "./motion";
import { NOTICE_DWELL_MS } from "./notice";
import { CredentialPrompt } from "./components/CredentialPrompt";
import { Palette } from "./components/Palette";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { Switcher, report } from "./components/Switcher";
import type { Session, Settings, WindowRole, Workspace } from "./types";

/** A failure, or a confirmation of something that worked: they differ in colour, and leave alike. */
type NoticeKind = "error" | "info";

/** What only one window draws: its body, and its mode's facts in the status bar. */
interface Half {
  Body: ComponentType<{ session: Session; openSwitcher: () => void; openSettings: () => void }>;
  Facts: ComponentType<{ ws: Workspace; session: Session }>;
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

  useEffect(() => {
    void loadHalf(role).then(setHalf);
    settings.init().then(setCurrent).catch(report);
    api.getSession().then(setSession).catch(report);
    const unlisten = [events.onSession(setSession)];
    // The request reaches every window, and only this one holds buffers to
    // ask about: the Terminal window answering it would quit past the prompt.
    if (role === "workspace") unlisten.push(events.onQuitRequested(() => void quit()));
    // What launch moved aside is data lost, so it waits for an answer rather
    // than leaving like a toast, in the window the owner works in (NTF-04).
    if (role === "workspace") {
      api.takeSetAside()
        .then((ms) => { if (ms.length) return message(ms.join("\n\n"), { title: "Saved data could not be read", kind: "warning", okLabel: "OK" }); })
        .catch(report);
    }
    const stop = settings.subscribe(setCurrent);
    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      stop();
    };
  }, [role]);

  // Drawn from the first paint and kept across the load, keyed so the load
  // does not remount it: a message from launch lands in a live region that
  // already exists (NTF-05a).
  const stack = <Notices key="notices" />;
  if (!session || !current || !half) return stack;
  const { Body, Facts } = half;

  const workspaces = [...session.recent, ...session.workspaces.map((w) => w.id)]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => session.workspaces.find((w) => w.id === id))
    .filter((w): w is NonNullable<typeof w> => !!w);
  const active = session.workspaces.find((w) => w.id === session.active);
  settings.setActivePath(active?.path ?? null);

  return (
    <>
      <div className={`app app-${role}`}>
        <Switcher session={session} role={role} onSettings={() => setShowSettings(true)} />
        <Body session={session} openSwitcher={() => setSwitcher(true)} openSettings={() => setShowSettings(true)} />
        <StatusBar session={session} role={role}>{active && <Facts ws={active} session={session} />}</StatusBar>
        {switcher && (
          <Palette
            title="Switch workspace"
            items={workspaces.map((w) => {
              // A child or a worktree names the row it is listed under; a root, its path (WS-26).
              const row = session.workspaces.find((o) => o.id === (w.childOf ?? w.worktreeOf));
              return { id: w.id, label: w.name, detail: row ? `${row.name} › ${w.name}` : w.path };
            })}
            onClose={() => setSwitcher(false)}
            onPick={(item) => { setSwitcher(false); void api.switchWorkspace(item.id).catch(report); }}
          />
        )}
        {showSettings && <SettingsDialog current={current} workspace={active} root={familyRoot(session.workspaces, active)} onClose={() => setShowSettings(false)} />}
        <CredentialPrompt role={role} />
      </div>
      {stack}
    </>
  );
}

/**
 * The window's toasts. The stack is held as one while the pointer is on it or
 * focus is in it, and counts only while this window has focus (NTF-02,
 * NTF-03). That state lives here rather than in `App`, so a window gaining or
 * losing focus re-renders the stack and not the window (ADR-018).
 */
function Notices() {
  // Keyed, not indexed: a toast plays its own exit, and an index would hand
  // that state to whichever message shifted up into its place.
  const [notices, setNotices] = useState<{ id: number; text: string; kind: NoticeKind }[]>([]);
  const stack = useRef<HTMLDivElement>(null);
  /** Where in the window the pointer last moved to. */
  const point = useRef<{ x: number; y: number } | null>(null);
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(() => document.hasFocus());

  useEffect(() => {
    let next = 0;
    const push = (m: string, kind: NoticeKind = "error") => setNotices((n) => [...n, { id: next++, text: m, kind }]);
    api.takeNotices().then((ns) => ns.forEach((m) => push(m))).catch(() => {});
    const unlisten = [events.onNotice(push), events.onInfo((m) => push(m, "info"))];
    // `report` sends the failure as a bare string, `notify` a kinded object.
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent<string | { text: string; kind: NoticeKind }>).detail;
      if (typeof detail === "string") push(detail);
      else push(detail.text, detail.kind);
    };
    window.addEventListener("app-notice", onLocal);
    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      window.removeEventListener("app-notice", onLocal);
    };
  }, []);

  useEffect(() => {
    // Only a move says where the pointer is. One at the point of the last is
    // the webview noting that what lies under a resting pointer changed, and
    // a toast that appeared there has not been pointed at (NTF-02).
    let x = NaN;
    let y = NaN;
    const move = (e: MouseEvent) => {
      if (e.screenX === x && e.screenY === y) return;
      x = e.screenX;
      y = e.screenY;
      point.current = { x: e.clientX, y: e.clientY };
      setPointed(!!stack.current?.contains(e.target as Node));
    };
    // Out of the window, where no move follows to say it left the stack.
    const out = (e: MouseEvent) => { if (!e.relatedTarget) setPointed(false); };
    const focus = () => setSeen(true);
    const blur = () => setSeen(false);
    window.addEventListener("mousemove", move);
    document.addEventListener("mouseout", out);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousemove", move);
      document.removeEventListener("mouseout", out);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // A toast that leaves with focus in it takes the focus along, and no blur
  // says so. One that leaves from under a resting pointer can leave it over
  // nothing, and no move says that either: the stack is anchored at the
  // bottom, so the toasts below it stay put. The hold is only released here,
  // never taken, as a toast arriving under a resting pointer has not been
  // pointed at (NTF-02).
  useEffect(() => {
    if (!stack.current?.contains(document.activeElement)) setFocused(false);
    const p = point.current;
    if (!p || !stack.current?.contains(document.elementFromPoint(p.x, p.y))) setPointed(false);
  }, [notices]);

  // Present while empty: a live region made with its first message is not reliably announced (NTF-05a).
  return (
    <div
      ref={stack}
      className="notices"
      role="log"
      aria-live="polite"
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
    >
      {notices.map((n) => (
        <Notice key={n.id} text={n.text} kind={n.kind} held={pointed || focused || !seen} onClose={() => setNotices((all) => all.filter((o) => o.id !== n.id))} />
      ))}
    </div>
  );
}

/**
 * One toast. Failures and confirmations alike leave by themselves once they
 * have been on screen for the dwell (NTF-01), which stops while the stack is
 * held and resumes where it stopped; the × leaves at once.
 */
function Notice({ text, kind, held, onClose }: { text: string; kind: NoticeKind; held: boolean; onClose: () => void }) {
  const [closing, dismiss] = useDismiss(onClose);
  const left = useRef(NOTICE_DWELL_MS);
  useEffect(() => {
    if (held || closing) return;
    const started = performance.now();
    const timer = window.setTimeout(dismiss, left.current);
    return () => {
      window.clearTimeout(timer);
      left.current -= performance.now() - started;
    };
  }, [held, closing, dismiss]);
  return (
    <div className={`notice${kind === "info" ? " info" : ""}${closing ? " is-closing" : ""}`} role={kind === "error" ? "alert" : undefined}>
      <span>{text}</span>
      <button onClick={dismiss} title="Dismiss" aria-label="Dismiss">×</button>
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

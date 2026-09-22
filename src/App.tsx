import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, events } from "./api";
import * as editors from "./editors";
import { Palette } from "./components/Palette";
import { Switcher, report } from "./components/Switcher";
import { TerminalWindow } from "./components/TerminalWindow";
import { WorkspaceWindow } from "./components/WorkspaceWindow";
import type { Session, WindowRole } from "./types";

export function App({ role }: { role: WindowRole }) {
  const [session, setSession] = useState<Session | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [, bump] = useState(0);

  useEffect(() => {
    const push = (m: string) => setNotices((n) => [...n, m]);
    api.getSession().then(setSession).catch(report);
    api.takeNotices().then((ns) => ns.forEach(push)).catch(() => {});
    const unlisten = [
      events.onSession(setSession),
      events.onNotice(push),
      events.onQuitRequested(() => void quit()),
    ];
    const onLocal = (e: Event) => push((e as CustomEvent<string>).detail);
    window.addEventListener("app-notice", onLocal);
    return () => {
      unlisten.forEach((u) => void u.then((f) => f()));
      window.removeEventListener("app-notice", onLocal);
    };
  }, []);

  useEffect(() => editors.onDirty(() => bump((n) => n + 1)), []);

  if (!session) return null;

  const workspaces = [...session.recent, ...session.workspaces.map((w) => w.id)]
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => session.workspaces.find((w) => w.id === id))
    .filter((w): w is NonNullable<typeof w> => !!w);

  return (
    <div className={`app app-${role}`}>
      <Switcher session={session} role={role} unsaved={editors.dirtyCount()} />
      {role === "terminal" ? (
        <TerminalWindow session={session} openSwitcher={() => setSwitcher(true)} />
      ) : (
        <WorkspaceWindow session={session} openSwitcher={() => setSwitcher(true)} />
      )}
      {switcher && (
        <Palette
          title="Switch workspace"
          items={workspaces.map((w) => ({ id: w.id, label: w.name, detail: w.path }))}
          onClose={() => setSwitcher(false)}
          onPick={(item) => { setSwitcher(false); void api.switchWorkspace(item.id).catch(report); }}
        />
      )}
      {notices.length > 0 && (
        <div className="notices">
          {notices.map((n, i) => (
            <div key={i} className="notice">
              <span>{n}</span>
              <button onClick={() => setNotices((all) => all.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
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

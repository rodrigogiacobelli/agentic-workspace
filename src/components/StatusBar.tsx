import type { ReactNode } from "react";
import { pick } from "../modes";
import { report } from "../notice";
import type { Session, WindowRole } from "../types";

/**
 * The application's status bar, not a mode's: it sits below the body in both
 * windows, so what it says about the workspace survives a mode switch. Each
 * mode fills the left with its own facts, handed in as `children` by the
 * window's own half of the application; the workspace and its branch hold
 * the right end, and the branch opens Source Control.
 */
export function StatusBar({ session, role, children }: { session: Session; role: WindowRole; children?: ReactNode }) {
  const ws = session.workspaces.find((w) => w.id === session.active);
  if (!ws) return <footer className="statusbar" />;
  const git = ws.git?.isRepo ? ws.git : null;
  return (
    <footer className="statusbar">
      {children}
      <span className="statusbar-grow" />
      <span className="statusbar-workspace" title={ws.path}>{ws.name}</span>
      {git && (
        <button
          className="statusbar-branch"
          onClick={() => void pick(ws, "scm", role).catch(report)}
          title={`${git.state ? `${git.state} in progress · ` : ""}${git.upstream ? `tracking ${git.upstream}` : "no upstream"} — open Source Control`}
        >
          ⑂ {git.detached ? "detached @ " : ""}{git.branch ?? ""}
          {git.ahead > 0 && <span className="ahead"> ↑{git.ahead}</span>}
          {git.behind > 0 && <span className="behind"> ↓{git.behind}</span>}
          {git.state && <span className="state"> · {git.state}</span>}
        </button>
      )}
    </footer>
  );
}


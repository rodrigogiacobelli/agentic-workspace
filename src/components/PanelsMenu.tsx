import { useEffect, useState } from "react";
import * as settings from "../settings";
import type { DockedMode, PanelId } from "../types";
import { hidePanel, normalizeAll, panelsOf, showPanel } from "./dock";
import { MenuButton } from "./Menu";
import { report } from "../notice";

/**
 * The View menu: which of the mode's panels are shown, the way back for a
 * hidden one (DOCK-09, DOCK-11), and whether tabs read as words or glyphs.
 */
export function PanelsMenu({ mode }: { mode: DockedMode }) {
  const [, bump] = useState(0);
  useEffect(() => settings.subscribe(() => bump((n) => n + 1)), []);
  const s = settings.get();
  const layouts = normalizeAll(s?.panelLayout);
  const layout = layouts[mode];
  const toggle = (id: PanelId) => {
    const next = layout.hidden.includes(id) ? showPanel(layout, id) : hidePanel(layout, id);
    void settings.update({ panelLayout: { ...layouts, [mode]: next } }).catch(report);
  };
  const icons = s?.tabDisplay === "icons";
  return (
    <MenuButton label="View" title="Show or hide a panel">
      {panelsOf(mode).map((p) => (
        <button key={p.id} onClick={() => toggle(p.id)}>
          <span className="menu-check">{layout.hidden.includes(p.id) ? "" : "✓"}</span>
          <span className="menu-label">{p.label}</span>
          {p.hotkey && <span className="menu-hint">{p.hotkey}</span>}
        </button>
      ))}
      <hr />
      <button onClick={() => void settings.update({ tabDisplay: icons ? "labels" : "icons" }).catch(report)}>
        <span className="menu-check">{icons ? "✓" : ""}</span>
        <span className="menu-label">Tabs as icons</span>
      </button>
      <button onClick={() => void settings.update({ panelLayout: { ...layouts, [mode]: undefined } }).catch(report)}>
        <span className="menu-check" />
        <span className="menu-label">Reset this mode's panels</span>
      </button>
    </MenuButton>
  );
}

import { useEffect, useState } from "react";
import * as settings from "../settings";
import { PANELS, defaultLayout, hidePanel, normalize, showPanel } from "./dock";
import { MenuButton } from "./Menu";
import { report } from "./Switcher";

/** The View menu: which panels are shown, and the way back for a hidden one (DOCK-09, DOCK-11). */
export function PanelsMenu() {
  const [, bump] = useState(0);
  useEffect(() => settings.subscribe(() => bump((n) => n + 1)), []);
  const layout = normalize(settings.get()?.panelLayout ?? defaultLayout());
  const toggle = (id: (typeof PANELS)[number]["id"]) => {
    const next = layout.hidden.includes(id) ? showPanel(layout, id) : hidePanel(layout, id);
    void settings.update({ panelLayout: next }).catch(report);
  };
  return (
    <MenuButton label="View" title="Show or hide a panel">
      {PANELS.map((p) => (
        <button key={p.id} onClick={() => toggle(p.id)}>
          <span className="menu-check">{layout.hidden.includes(p.id) ? "" : "✓"}</span>
          <span className="menu-label">{p.label}</span>
          <span className="menu-hint">{p.hotkey}</span>
        </button>
      ))}
      <hr />
      <button onClick={() => void settings.update({ panelLayout: null }).catch(report)}>
        <span className="menu-check" />
        <span className="menu-label">Reset panel layout</span>
      </button>
    </MenuButton>
  );
}

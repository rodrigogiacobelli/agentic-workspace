import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import type { WindowRole } from "./types";
import "./styles.css";
import { installScrollbars } from "./scrollbars";
import { installTooltips } from "./tooltip";

installScrollbars();
installTooltips();

const role: WindowRole = getCurrentWindow().label === "terminal" ? "terminal" : "workspace";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App role={role} />
  </StrictMode>,
);

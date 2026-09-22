import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import type { WindowRole } from "./types";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const role: WindowRole = getCurrentWindow().label === "terminal" ? "terminal" : "workspace";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App role={role} />
  </StrictMode>,
);

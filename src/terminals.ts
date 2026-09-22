// The registry of xterm.js instances, keyed by terminal tab id. Instances live
// outside React and survive workspace switches: a hidden terminal's element is
// simply not in the document, and its buffer keeps receiving output.

import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import { api, toBytes, type OutputChunk } from "./api";
import { actionFor, TERMINAL_ACTIONS } from "./hotkeys";
import { monospace, theme } from "./theme";

export interface Instance {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  /** The program's own title, from OSC 0/2. */
  title: string;
  disposers: IDisposable[];
}

const registry = new Map<string, Instance>();
const titleListeners = new Set<() => void>();

export function onTitles(cb: () => void): () => void {
  titleListeners.add(cb);
  return () => titleListeners.delete(cb);
}

export function get(id: string): Instance | undefined {
  return registry.get(id);
}

/** Shows the terminal in `container`, creating and attaching it on first use. */
export async function mount(id: string, container: HTMLElement): Promise<Instance> {
  let inst = registry.get(id);
  if (!inst) {
    inst = create(id);
    registry.set(id, inst);
    container.replaceChildren(inst.el);
    inst.term.open(inst.el);
    loadWebgl(inst.term);
    inst.fit.fit();
    inst.term.focus();
    await attach(id, inst);
    return inst;
  }
  if (inst.el.parentElement !== container) container.replaceChildren(inst.el);
  // Re-fitting resizes the PTY, so a program inside sees the window it is
  // actually drawn in and redraws on the SIGWINCH.
  inst.fit.fit();
  inst.term.scrollToBottom();
  inst.term.focus();
  return inst;
}

export function unmount(id: string): void {
  registry.get(id)?.el.remove();
}

export function dispose(id: string): void {
  const inst = registry.get(id);
  if (!inst) return;
  registry.delete(id);
  inst.disposers.forEach((d) => d.dispose());
  inst.term.dispose();
  inst.el.remove();
}

/** Disposes every instance whose tab no longer exists. */
export function retain(ids: Set<string>): void {
  for (const id of [...registry.keys()]) if (!ids.has(id)) dispose(id);
}

function create(id: string): Instance {
  const term = new Terminal({
    scrollback: 10_000,
    fontFamily: monospace,
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    theme,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const el = document.createElement("div");
  el.className = "term";
  const inst: Instance = { term, fit, search, el, title: "", disposers: [] };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const action = actionFor(e);
    // Returning false leaves the key to the window handler instead of the shell.
    return !(action && TERMINAL_ACTIONS.has(action));
  });
  inst.disposers.push(
    term.onData((data) => void api.terminalWrite(id, data).catch(() => {})),
    term.onBinary((data) => void api.terminalWrite(id, data).catch(() => {})),
    term.onResize(({ cols, rows }) => void api.terminalResize(id, cols, rows).catch(() => {})),
    term.onTitleChange((title) => {
      inst.title = title;
      titleListeners.forEach((cb) => cb());
    }),
  );
  return inst;
}

function loadWebgl(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // The DOM renderer is the fallback and needs nothing.
  }
}

async function attach(id: string, inst: Instance): Promise<void> {
  const channel = new Channel<OutputChunk>();
  channel.onmessage = (chunk) => inst.term.write(toBytes(chunk));
  const tail = await api.terminalAttach(id, inst.term.cols, inst.term.rows, channel);
  if (tail.byteLength > 0) inst.term.write(new Uint8Array(tail));
}

// The registry of xterm.js instances, keyed by terminal tab id. Instances live
// outside React and survive workspace switches: a hidden terminal's element is
// simply not in the document, and its buffer keeps receiving output.

import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Channel } from "@tauri-apps/api/core";
import { api, events, toBytes, type OutputChunk } from "./api";
import { actionFor, TERMINAL_ACTIONS } from "./hotkeys";
import { modalOpen } from "./modal";
import * as settings from "./settings";

export interface Instance {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  /** The program's own title, from OSC 0/2. */
  title: string;
  disposers: IDisposable[];
  /** The channel output arrives on. A restarted shell brings a new one, and
   * whatever the old shell still had in flight is dropped, not drawn. */
  channel: Channel<OutputChunk> | null;
}

const registry = new Map<string, Instance>();
const titleListeners = new Set<(id: string) => void>();

export interface LinkTarget {
  path: string;
  line: number;
  column: number;
}

/** Resolves a path printed in a terminal against that terminal's directory. */
let linkHandler: (terminalId: string, target: LinkTarget) => void = () => {};

export function setLinkHandler(h: typeof linkHandler): void {
  linkHandler = h;
}

const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g;
const PATH_RE = /(?:^|[\s'"(\[])((?:\.{1,2}\/|~\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8})(?::(\d+)(?::(\d+))?)?/g;

/** URLs and file paths become links; Ctrl+click follows them. */
function linkProvider(id: string): import("@xterm/xterm").ILinkProvider {
  return {
    provideLinks(y, callback) {
      const inst = registry.get(id);
      const line = inst?.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links: import("@xterm/xterm").ILink[] = [];
      for (const m of line.matchAll(URL_RE)) {
        const start = (m.index ?? 0) + 1;
        links.push({
          range: { start: { x: start, y }, end: { x: start + m[0].length - 1, y } },
          text: m[0],
          decorations: { underline: true, pointerCursor: true },
          activate: (e, text) => { if (e.ctrlKey || e.metaKey) void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(text)); },
        });
      }
      for (const m of line.matchAll(PATH_RE)) {
        const offset = m[0].indexOf(m[1]);
        const start = (m.index ?? 0) + offset + 1;
        const suffix = m[2] ? `:${m[2]}${m[3] ? `:${m[3]}` : ""}` : "";
        const text = `${m[1]}${suffix}`;
        if (/^https?:/.test(m[1])) continue;
        links.push({
          range: { start: { x: start, y }, end: { x: start + text.length - 1, y } },
          text,
          decorations: { underline: true, pointerCursor: true },
          activate: (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            linkHandler(id, { path: m[1], line: Number(m[2] ?? 0), column: Number(m[3] ?? 0) });
          },
        });
      }
      callback(links);
    },
  };
}

/** Called with the terminal whose title changed, so a view can ignore terminals it does not show. */
export function onTitles(cb: (id: string) => void): () => void {
  titleListeners.add(cb);
  return () => titleListeners.delete(cb);
}

export function get(id: string): Instance | undefined {
  return registry.get(id);
}

// Font and palette changes reach every terminal, shown or hidden.
settings.subscribe((s) => {
  const font = settings.terminalFont(s);
  for (const inst of registry.values()) {
    inst.term.options.theme = settings.theme().terminal;
    inst.term.options.fontFamily = font.fontFamily;
    inst.term.options.fontSize = font.fontSize;
    inst.term.options.lineHeight = font.lineHeight;
    if (inst.el.isConnected) inst.fit.fit();
  }
});

/** The tab each container was last asked to show. */
const wanted = new WeakMap<HTMLElement, string>();

/** Shows the terminal in `container`, creating and attaching it on first use. */
export async function mount(id: string, container: HTMLElement): Promise<void> {
  wanted.set(container, id);
  let inst = registry.get(id);
  if (!inst) {
    // Settled before the terminal is opened, so it never draws a frame with
    // one renderer and the rest with another. The WebGL renderer's module is
    // fetched only by a terminal that draws with it.
    const webgl = useWebgl(settings.get()?.terminalGpu)
      ? (await import("@xterm/addon-webgl").catch(() => null))?.WebglAddon
      : undefined;
    // The container moved on to another tab while this one waited; this tab
    // is created when it is next shown.
    if (wanted.get(container) !== id) return;
    // Another mount of the same tab may have created it while this one waited.
    if (registry.has(id)) return mount(id, container);
    inst = create(id);
    registry.set(id, inst);
    container.replaceChildren(inst.el);
    inst.term.open(inst.el);
    if (webgl) loadWebgl(inst.term, webgl);
    inst.fit.fit();
    // Behind a modal, focus stays in the modal; keys typed there are not the shell's.
    if (!modalOpen()) inst.term.focus();
    try {
      await attach(id, inst);
    } catch (e) {
      // A shell not running yet: kept, the tab would show a terminal nothing
      // feeds. Dropped, the next mount creates and attaches it again.
      if (registry.get(id) === inst) dispose(id);
      throw e;
    }
    return;
  }
  if (inst.el.parentElement !== container) container.replaceChildren(inst.el);
  // Re-fitting resizes the PTY, so a program inside sees the window it is
  // actually drawn in and redraws on the SIGWINCH.
  inst.fit.fit();
  inst.term.scrollToBottom();
  if (!modalOpen()) inst.term.focus();
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

// A restarted shell keeps its tab and its id and is a new process behind them:
// its instance starts a clean screen and attaches again. One this window has
// not shown yet attaches when it is first mounted.
void events.onTerminalRestarted((id) => {
  const inst = registry.get(id);
  if (!inst) return;
  // The reset is written into the stream, not called: `reset()` would run
  // ahead of output from the old shell that xterm has not parsed yet, and that
  // output would then draw on the new screen. The title was the stopped
  // program's, and is cleared once that output is parsed, since a title it
  // still carries would otherwise come back.
  inst.term.write("\x1bc", () => {
    inst.title = "";
    titleListeners.forEach((cb) => cb(id));
  });
  // A shell that exited at once takes its tab with it; nothing is left to attach.
  void attach(id, inst).catch(() => {});
});

function create(id: string): Instance {
  const s = settings.get();
  const font = s ? settings.terminalFont(s) : { fontFamily: settings.monospaceFallback, fontSize: 13, lineHeight: 1.15 };
  const term = new Terminal({
    scrollback: 10_000,
    ...font,
    cursorBlink: true,
    allowProposedApi: true,
    theme: settings.theme().terminal,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const el = document.createElement("div");
  el.className = "term";
  const inst: Instance = { term, fit, search, el, title: "", disposers: [], channel: null };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const action = actionFor(e);
    // Returning false leaves the key to the window handler instead of the shell.
    return !(action && TERMINAL_ACTIONS.has(action));
  });
  inst.disposers.push(
    term.registerLinkProvider(linkProvider(id)),
    term.onData((data) => void api.terminalWrite(id, data).catch(() => {})),
    term.onBinary((data) => void api.terminalWrite(id, data).catch(() => {})),
    term.onResize(({ cols, rows }) => void api.terminalResize(id, cols, rows).catch(() => {})),
    term.onTitleChange((title) => {
      // Shells and agents re-send the same title at every prompt or spinner frame.
      if (title === inst.title) return;
      inst.title = title;
      titleListeners.forEach((cb) => cb(id));
    }),
  );
  return inst;
}

/** Set when WebGL has failed once. xterm cannot be asked twice in one process
 * without the same failure, so every later terminal draws into the DOM. */
let webglBroken = false;

/** Which renderer this terminal draws with: WebGL only when the setting asks
 * for it. Where the webview cannot reach the GPU — WebKit's DMA-BUF renderer
 * off, as on NVIDIA under X11 — a WebGL canvas is presented through software, and
 * repainting it for each character held a keystroke for about a second. Where
 * it can, WebGL's keystroke-to-pixel latency has not been measured, so `auto`
 * draws into the DOM either way. */
function useWebgl(setting: string | undefined): boolean {
  return !webglBroken && setting === "webgl";
}

function loadWebgl(term: Terminal, Addon: typeof WebglAddon): void {
  try {
    const webgl = new Addon();
    webgl.onContextLoss(() => {
      webglBroken = true;
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch {
    webglBroken = true;
  }
}

/** Characters parsed before the backend is told, matching the size it resumes
 * at. One call per this many characters rather than one per message, so a
 * flooding terminal costs a handful of calls a second. */
const ACK_SIZE = 5_000;

async function attach(id: string, inst: Instance): Promise<void> {
  const channel = new Channel<OutputChunk>();
  inst.channel = channel;
  // The acknowledgement is sent from `write`'s callback, which runs once
  // xterm has actually parsed the bytes — so this reports what the terminal
  // has caught up on, not merely what arrived, and the backend stops reading
  // the pseudoterminal when it gets too far ahead.
  let parsed = 0;
  channel.onmessage = (chunk) => {
    if (inst.channel !== channel) return;
    const bytes = toBytes(chunk);
    inst.term.write(bytes, () => {
      // Parsed after a restart, these bytes were the old shell's; the id now
      // names the new one, which is owed nothing for them.
      if (inst.channel !== channel) return;
      parsed += bytes.length;
      while (parsed > ACK_SIZE) {
        parsed -= ACK_SIZE;
        void api.terminalAck(id, ACK_SIZE).catch(() => {});
      }
    });
  };
  const tail = await api.terminalAttach(id, inst.term.cols, inst.term.rows, channel);
  if (inst.channel === channel && tail.byteLength > 0) inst.term.write(new Uint8Array(tail));
}

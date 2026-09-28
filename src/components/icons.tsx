// The icon set: small inline SVGs, so nothing depends on a font being
// installed. File icons are chosen by extension and coloured by family.

const PATHS = {
  folder: "M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z",
  folderOpen: "M1.5 3.5h4.5l1.5 1.5h7v2h-10.5l-2.5 6.5h13l2-6.5 M1.5 3.5v10",
  file: "M4 1.5h5l3 3v10h-8z M9 1.5v3h3",
  text: "M4 1.5h5l3 3v10h-8z M9 1.5v3h3 M6 8h4 M6 10.5h4",
  markdown: "M4 1.5h5l3 3v10h-8z M9 1.5v3h3 M5.5 12v-4.5l1.75 2 1.75-2v4.5",
  code: "M6 4l-3.5 4 3.5 4 M10 4l3.5 4-3.5 4",
  image: "M2 3h12v10h-12z M5.5 7.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M2 12l4-4 3 3 2-2 3 3",
  audio: "M5 14a2 2 0 100-4 2 2 0 000 4z M7 12v-9l5 1.5",
  video: "M2 3h12v10h-12z M6.5 5.5v5l4-2.5z",
  data: "M6 2.5c-2 0-2 1.5-2 2.5s0 2-1.5 3c1.5 1 1.5 2 1.5 3s0 2.5 2 2.5 M10 2.5c2 0 2 1.5 2 2.5s0 2 1.5 3c-1.5 1-1.5 2-1.5 3s0 2.5-2 2.5",
  config: "M2 4h12 M2 8h12 M2 12h12 M5 2.5v3 M10 6.5v3 M6 10.5v3",
  archive: "M3 2.5h10v11h-10z M6 2.5v11 M8 5h2 M8 8h2 M8 11h2",
  lock: "M4 7h8v7h-8z M5.5 7v-2a2.5 2.5 0 015 0v2",
  git: "M4.5 3a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z M4.5 13.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z M13 5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z M3 4.5v7.5 M11.5 6.5c0 3.5-8.5 2-8.5 5.5",
  custom: "M2 2.5h5v5H2z M9 2.5h5v5H9z M2 8.5h5v5H2z M9.5 11h4 M11.5 9v4",
  commit: "M8 1.5v3.2 M8 11.3v3.2 M11.2 8a3.2 3.2 0 11-6.4 0 3.2 3.2 0 016.4 0z",
  history: "M4 2.6a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2z M4 11.2a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2z M4 4.8v6.4 M7.5 3.7h6.5 M7.5 8h6.5 M7.5 12.3h4.5",
  worktrees: "M8 1.8v3.4 M8 5.2H4.2v2.4 M8 5.2h3.8v2.4 M1.8 7.6h4.8v4.6H1.8z M9.4 7.6h4.8v4.6H9.4z",
  tag: "M2 8.4V2.4h6L14 8.4 8.4 14z M5.1 5.4h.01",
  logo: "M2 4.5L8 1.5l6 3v7L8 14.5l-6-3z M8 7.5l6-3 M8 7.5l-6-3 M8 7.5v7",
  search: "M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z M10.5 10.5l3.5 3.5",
  outline: "M2 4h12 M2 8h9 M2 12h6",
  terminal: "M2 3h12v10h-12z M5 6.5l2 1.5-2 1.5 M8.5 9.5h3",
  workspace: "M2 3h12v10h-12z M2 6h12 M6 6v7",
  newFile: "M4 1.5h5l3 3v5 M9 1.5v3h3 M4 1.5v13h4 M11.5 11v4 M9.5 13h4",
  newFolder: "M1.5 3.5h4.5l1.5 1.5h7v4 M1.5 3.5v10h6 M12.5 11v4 M10.5 13h4",
  copy: "M6 6h8v8.5h-8z M10.5 6v-4.5h-8v8.5h3",
  chevronDown: "M4 6.5l4 4 4-4",
  rename: "M11 2.5l2.5 2.5-7.5 7.5-3.5 1 1-3.5z M9.5 4l2.5 2.5",
  close: "M4 4l8 8 M12 4l-8 8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, color, size = 16, className }: { name: IconName; color?: string; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color ?? "currentColor"} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The same icon as an element, for what is drawn outside React: a citation chip. */
export function iconElement(name: IconName, color?: string, className?: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const attrs = {
    class: `icon${className ? ` ${className}` : ""}`, width: "16", height: "16", viewBox: "0 0 16 16", fill: "none",
    stroke: color ?? "currentColor", "stroke-width": "1.4", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.appendChild(document.createElementNS(ns, "path")).setAttribute("d", PATHS[name]);
  return svg;
}

const CODE: Record<string, string> = {
  ts: "#3b82f6", tsx: "#3b82f6", mts: "#3b82f6", cts: "#3b82f6",
  js: "#eab308", jsx: "#eab308", mjs: "#eab308", cjs: "#eab308",
  rs: "#f97316", py: "#60a5fa", go: "#22d3ee", java: "#f97316", kt: "#a78bfa", swift: "#f97316",
  c: "#93c5fd", h: "#93c5fd", cpp: "#93c5fd", hpp: "#93c5fd", cc: "#93c5fd", cs: "#a78bfa",
  rb: "#ef4444", php: "#a78bfa", lua: "#60a5fa", dart: "#22d3ee", zig: "#f59e0b", scala: "#ef4444",
  sh: "#22c55e", fish: "#22c55e", bash: "#22c55e", zsh: "#22c55e",
  html: "#f97316", htm: "#f97316", css: "#8b5cf6", scss: "#ec4899", less: "#8b5cf6", vue: "#22c55e", svelte: "#f97316",
  sql: "#60a5fa", r: "#60a5fa", jl: "#a78bfa", ex: "#a78bfa", exs: "#a78bfa", hs: "#a78bfa", elm: "#22d3ee",
};
const DATA = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "csv", "tsv", "ini", "cfg", "conf", "properties"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const AUDIO = new Set(["mp3", "ogg", "oga", "wav", "flac", "m4a", "weba", "opus", "aac"]);
const VIDEO = new Set(["mp4", "webm", "mkv", "mov", "ogv", "m4v"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "deb", "rpm", "appimage", "pdf", "bin", "exe", "so", "o", "wasm", "db", "sqlite"]);
const CONFIG = new Set(["env", "gitignore", "gitattributes", "editorconfig", "npmrc", "prettierrc", "eslintrc", "dockerignore", "makefile", "dockerfile", "license", "justfile"]);

/** The icon and colour for a file or directory row. */
export function fileIcon(name: string, isDir: boolean, expanded = false): { name: IconName; color?: string } {
  if (isDir) return { name: expanded ? "folderOpen" : "folder", color: "#7ba7d9" };
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  const stem = lower.startsWith(".") ? lower.slice(1) : lower;
  if (lower.endsWith(".lock") || lower === "cargo.lock" || lower === "pnpm-lock.yaml" || lower === "package-lock.json") return { name: "lock", color: "#9ca3af" };
  if (stem === "gitignore" || stem === "gitattributes" || stem === "gitmodules") return { name: "git", color: "#f97316" };
  if (ext === "md" || ext === "markdown" || ext === "mdx") return { name: "markdown", color: "#60a5fa" };
  if (ext in CODE) return { name: "code", color: CODE[ext] };
  if (DATA.has(ext)) return { name: "data", color: "#eab308" };
  if (IMAGE.has(ext)) return { name: "image", color: "#a855f7" };
  if (AUDIO.has(ext)) return { name: "audio", color: "#ec4899" };
  if (VIDEO.has(ext)) return { name: "video", color: "#ec4899" };
  if (ARCHIVE.has(ext)) return { name: "archive", color: "#9ca3af" };
  if (CONFIG.has(ext) || CONFIG.has(stem)) return { name: "config", color: "#9ca3af" };
  if (ext === "txt" || ext === "log" || ext === "rst" || ext === "org") return { name: "text" };
  return { name: "file" };
}

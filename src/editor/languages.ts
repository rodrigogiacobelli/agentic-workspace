// The five built-in grammars, chosen by extension or by a per-path override.
// Anything else is plain text, which is an ordinary case rather than an error.

import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yaml, yamlLanguage } from "@codemirror/lang-yaml";
import { LanguageDescription, StreamLanguage, type LanguageSupport } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { GFM } from "@lezer/markdown";
import type { Extension } from "@codemirror/state";
import { citation } from "./citation";
import { frontmatter } from "./frontmatter";

export type LanguageId = "markdown" | "html" | "json" | "yaml" | "toml" | "plain";

export const LANGUAGES: { id: LanguageId; name: string }[] = [
  { id: "plain", name: "Plain text" },
  { id: "markdown", name: "Markdown" },
  { id: "html", name: "HTML" },
  { id: "json", name: "JSON" },
  { id: "yaml", name: "YAML" },
  { id: "toml", name: "TOML" },
];

const tomlLanguage = StreamLanguage.define(toml);

/**
 * Fenced code blocks use the same set, selected by the fence's info string.
 * Each grammar is built the first time a fence asks for it, not at import.
 */
const fenceLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: "html", alias: ["htm", "xml", "svg"], load: async () => html({ autoCloseTags: false }) }),
  LanguageDescription.of({ name: "json", alias: ["jsonc", "json5"], load: async () => json() }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], load: async () => yaml() }),
  LanguageDescription.of({ name: "toml", support: new (class { language = tomlLanguage; extension: Extension = tomlLanguage; })() as unknown as LanguageSupport }),
  LanguageDescription.of({ name: "markdown", alias: ["md"], load: async () => markdown({ base: markdownLanguage }) }),
];

export function languageFor(path: string, override?: string): LanguageId {
  if (override && LANGUAGES.some((l) => l.id === override)) return override as LanguageId;
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "md": case "markdown": case "mdx": return "markdown";
    case "html": case "htm": case "xhtml": return "html";
    case "json": case "jsonc": case "json5": return "json";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
  }
  return "plain";
}

export function languageExtension(id: LanguageId): Extension {
  switch (id) {
    case "markdown":
      return markdown({
        base: markdownLanguage,
        codeLanguages: fenceLanguages,
        extensions: [GFM, frontmatter, citation],
        addKeymap: true,
        completeHTMLTags: false,
      });
    case "html": return html({ autoCloseTags: false, matchClosingTags: true });
    case "json": return json();
    case "yaml": return yaml();
    case "toml": return tomlLanguage;
    case "plain": return [];
  }
}

export { yamlLanguage };

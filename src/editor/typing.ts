// The typing helpers from the larger editors: bracket pairs that wrap a
// selection, several cursors and a column selection, line operations, and
// markdown-aware Tab and task toggling. They apply in every view of a
// document, the rendered pane included (TYP-18).

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { addCursorAbove, addCursorBelow } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, rectangularSelection, type Command } from "@codemirror/view";
import type { LanguageId } from "./languages";

const WRAP: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`", "*": "*", "_": "_" };

/** Typing a pair's opening character with text selected wraps the selection and keeps it (TYP-01). */
const wrapSelection = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = WRAP[text];
  if (!close || view.state.selection.ranges.every((r) => r.empty)) return false;
  view.dispatch(view.state.changeByRange((range) => ({
    changes: [{ from: range.from, insert: text }, { from: range.to, insert: close }],
    range: EditorSelection.range(range.anchor + text.length, range.head + text.length),
  })));
  return true;
});

/** Appends the next line to the current one with a single space between (TYP-11). */
const joinLines: Command = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    if (line.number === state.doc.lines) return { range };
    const next = state.doc.line(line.number + 1);
    const from = line.from + line.text.trimEnd().length;
    const to = next.from + (next.text.length - next.text.trimStart().length);
    const insert = line.text.trim() && next.text.trim() ? " " : "";
    return { changes: { from, to, insert }, range: EditorSelection.cursor(from + insert.length) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "delete" }));
  return true;
};

const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)/;
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s|$)/;

/** `- [ ]` becomes `- [x]` and back; a plain item gains a box (TYP-17). */
const toggleTask: Command = ({ state, dispatch }) => {
  const changes: { from: number; to: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    const task = TASK.exec(line.text);
    if (task) {
      const at = line.from + task[1].length + 1;
      changes.push({ from: at, to: at + 1, insert: task[2] === " " ? "x" : " " });
      continue;
    }
    const item = ITEM.exec(line.text);
    if (!item) return false;
    changes.push({ from: line.from + item[0].length, to: line.from + item[0].length, insert: "[ ] " });
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input" }));
  return true;
};

/** The indentation the document already uses for nested items, or the width of `line`'s marker. */
function listUnit(state: EditorState, marker: string): number {
  for (let n = 1; n <= state.doc.lines; n++) {
    const m = ITEM.exec(state.doc.line(n).text);
    if (m && m[1].length > 0) return m[1].length;
  }
  return marker.length;
}

/** Tab nests a list item one level under the item above; Shift+Tab returns it (TYP-15). */
function listDepth(delta: 1 | -1): Command {
  return ({ state, dispatch }) => {
    const changes: { from: number; to: number; insert: string }[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const from = state.doc.lineAt(range.from).number;
      const to = state.doc.lineAt(range.to).number;
      for (let n = from; n <= to; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const m = ITEM.exec(line.text);
        if (!m) return false;
        const unit = listUnit(state, m[2] + m[3]);
        if (delta > 0) changes.push({ from: line.from, to: line.from, insert: " ".repeat(unit) });
        else {
          const remove = Math.min(unit, m[1].length);
          if (remove > 0) changes.push({ from: line.from, to: line.from + remove, insert: "" });
        }
      }
    }
    if (!changes.length) return false;
    dispatch(state.update({ changes, userEvent: "input.indent" }));
    return true;
  };
}

const LINE_COMMENTS: Record<string, string> = {
  ts: "//", tsx: "//", js: "//", jsx: "//", mjs: "//", cjs: "//", rs: "//", c: "//", h: "//", cpp: "//", hpp: "//", cc: "//", java: "//", kt: "//", swift: "//", go: "//", cs: "//", scala: "//", dart: "//", zig: "//", php: "//",
  py: "#", sh: "#", fish: "#", bash: "#", zsh: "#", rb: "#", pl: "#", conf: "#", cfg: "#", ini: "#", r: "#", jl: "#", nim: "#", ex: "#", exs: "#", tf: "#", hcl: "#", nix: "#", mk: "#", cmake: "#", gitignore: "#", env: "#",
  lua: "--", sql: "--", hs: "--", elm: "--",
  lisp: ";", clj: ";", el: ";", scm: ";",
  vim: '"', tex: "%",
};

/** Ctrl+/ needs a comment token; the built-in grammars carry theirs, plain files get one by extension (TYP-12). */
function commentTokens(language: LanguageId, path: string): Extension {
  if (language !== "plain") return [];
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const line = LINE_COMMENTS[ext] ?? (name === "makefile" || name === "dockerfile" ? "#" : undefined);
  const block = ext === "css" || ext === "scss" || ext === "less" ? { open: "/*", close: "*/" } : undefined;
  if (!line && !block) return [];
  return EditorState.languageData.of(() => [{ commentTokens: { line, block } }]);
}

export function typingHelpers(language: LanguageId, path: string): Extension[] {
  return [
    Prec.high(wrapSelection),
    closeBrackets(),
    // Alt+click adds a cursor; Shift+Alt and drag selects a rectangle (TYP-04, TYP-07).
    EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey && e.button === 0 }),
    Prec.high(keymap.of([
      ...closeBracketsKeymap,
      { key: "Ctrl-Alt-ArrowUp", run: addCursorAbove },
      { key: "Ctrl-Alt-ArrowDown", run: addCursorBelow },
      { key: "Ctrl-j", run: joinLines },
      { key: "Alt-c", run: toggleTask },
      { key: "Tab", run: listDepth(1) },
      { key: "Shift-Tab", run: listDepth(-1) },
    ])),
    commentTokens(language, path),
  ];
}

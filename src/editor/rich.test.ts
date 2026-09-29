// What the rendered view's keys write (ADR-011, RICH-18). A document is
// written with `|` for the caret, or `«` and `»` around a selection.

import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import {
  canonical, caretSide, cellBreak, cellMove, cellText, deleteBy, deletion, enter, exemptLines, hardBreak, intact, landing, layout, lineSyntax, mended, moveChar, pasted, rowMove, typedRange,
  type Edit,
} from "./rich.ts";

function open(marked: string): EditorState {
  const caret = marked.indexOf("|");
  const doc = marked.replace(/[|«»]/g, "");
  const selection = caret >= 0 ? EditorSelection.cursor(caret) : EditorSelection.range(marked.indexOf("«"), marked.indexOf("»") - 1);
  return EditorState.create({ doc, selection, extensions: markdown({ base: markdownLanguage, extensions: [GFM] }) });
}

function run(marked: string, key: (state: EditorState) => Edit | null): string {
  const state = open(marked);
  const edit = key(state);
  if (!edit) return "(not handled)";
  const next = state.update({ changes: edit.changes, selection: edit.range }).state;
  const head = next.selection.main.head;
  return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`;
}

const lay = (s: EditorState) => layout(s, exemptLines(s));

test("Enter makes paragraphs one blank line apart and splits the formatting it falls inside", () => {
  const cases: [string, string][] = [
    ["abc|", "abc\n\n|"],
    ["abc|\n\ndef", "abc\n\n|\n\ndef"],
    ["abc|\n# Next", "abc\n\n|\n\n# Next"],
    ["**bold|**", "**bold**\n\n|"],
    ["**bo|ld** x", "**bo**\n\n**|ld** x"],
    ["[li|nk](u)", "[li](u)\n\n[|nk](u)"],
    ["## Ti|tle", "## Ti\n\n## |tle"],
    // A setext heading's first half takes a copy of its underline, wherever the split falls.
    ["Ti|tle\n===", "Ti\n===\n\n|tle\n==="],
    ["Ti|tle\n---\n\npara", "Ti\n---\n\n|tle\n---\n\npara"],
    ["**Ti|tle**\n===", "**Ti**\n===\n\n**|tle**\n==="],
    ["One|\nTitle\n===", "One\n===\n\n|\n\nTitle\n==="],
    ["One\n|Title\n===", "One\n===\n\n|Title\n==="],
    ["One\\\n|Title\n===", "One\n===\n\n|Title\n==="],
    ["Title|\n===", "Title\n===\n\n|"],
    ["# Title|", "# Title\n\n|"],
    ["|abc", "|\n\nabc"],
    ["p\n\n|abc", "p\n\n|\n\nabc"],
    ["# H\n|abc", "# H\n\n|\n\nabc"],
    ["line1|\nline2", "line1\n\n|\n\nline2"],
    ["a|\\\nb", "a\n\n|\n\nb"],
    ["abc\n\n|", "abc\n\n|"],
    // At the start of a line inside a paragraph, the line break before it becomes the paragraph break.
    ["line1\n|line2", "line1\n\n|line2"],
    ["**a\n|b**", "**a**\n\n**|b**"],
    ["a\\\n|b", "a\n\n|b"],
    // A split never lands between an opening mark and its text, nor inside an
    // autolink; whitespace at the cut goes, and never stands against a mark there.
    ["x **|bold** y", "x\n\n|**bold** y"],
    ["see <https://exa|mple.com> x", "see <https://example.com>\n\n|x"],
    ["**one |two**", "**one**\n\n**|two**"],
    ["**one \n|two**", "**one**\n\n**|two**"],
    ["**one|\n  two**", "**one**\n\n|\n\n**two**"],
    ["```ts|", "```ts\n|\n```\n"],
    ["```ts|\nafter", "```ts\n|\n```\nafter"],
    ["```ts\nco|de\n```", "(not handled)"],
    ["- item|", "(not handled)"],
  ];
  for (const [before, after] of cases) assert.equal(run(before, (s) => enter(s, lay(s), s.selection.main)), after, before);
});

test("Enter leaves the second half a paragraph, whatever its first line would open standing alone", () => {
  const cases: [string, string][] = [
    // Indentation, which would open a code block, goes.
    ["one\n    |two", "one\n\n|two"],
    ["one|\n    two", "one\n\n|\n\ntwo"],
    // A mark that would open a list, a link definition or an HTML block is escaped.
    ["one\n|2. two", "one\n\n|2\\. two"],
    ["one|\n2. two", "one\n\n|\n\n2\\. two"],
    ["one\n|[two]: /u", "one\n\n|\\[two]: /u"],
    ["one\n|*", "one\n\n|\\*"],
    ["a |- b", "a\n\n|\\- b"],
    ["one\n|<span>\ntwo", "one\n\n|\\<span>\ntwo"],
    // A split the escape cannot save, whose first half would read as a heading's underline, is a hard break,
    // and the line the break starts is escaped as the second half would be.
    ["one\n--- |two", "one\n--- \\\n|two"],
    ["two\n--|- y a", "two\n--\\\n|\\- y a"],
    ["<b>| # h b\n10) z", "<b>\\\n|\\# h b\n10) z"],
  ];
  for (const [before, after] of cases) assert.equal(run(before, (s) => enter(s, lay(s), s.selection.main)), after, before);
});

test("Shift+Enter writes a hard break that stays in its paragraph, quote or list item", () => {
  const cases: [string, string][] = [
    ["ab|cd", "ab\\\n|cd"],
    ["**bold|**", "**bold**\\\n|"],
    ["a *it|* b", "a *it*\\\n| b"],
    ["> ab|cd", "> ab\\\n> |cd"],
    ["- ab|cd", "- ab\\\n  |cd"],
    ["# Ti|tle", "# Ti\n\n# |tle"],
  ];
  for (const [before, after] of cases) assert.equal(run(before, (s) => hardBreak(s, lay(s), s.selection.main)), after, before);
});

test("Backspace and Delete take visible text, never leave empty marks, and remove empty paragraphs", () => {
  const back = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, false, false);
  const del = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, true, false);
  const cases: [string, (s: EditorState) => Edit | null, string][] = [
    ["Some **«bold»** and", back, "Some | and"],
    ["Some **b|** and", back, "Some | and"],
    ["**bold|** and", del, "**bold|**and"],
    ["**bo«ld** an»d", back, "**bo|**d"],
    ["a [k](x)| b", back, "a | b"],
    ["[link](x)|", (s) => deleteBy(s, lay(s), s.selection.main, false, true), "|"],
    ["a ![i](x.png)| b", back, "a | b"],
    // Backspace at a block's start belongs to RICH-07, in format.ts.
    ["abc\n\n|def", back, "(not handled)"],
    ["abc\n\n# |Head", back, "(not handled)"],
    ["abc\n\n|", back, "abc|"],
    ["abc\n\n|\n\n# def", del, "abc\n\n# |def"],
    ["a\\\n|b", back, "a|b"],
    ["- a\n  |b", back, "- a|b"],
    ["> a\n> |b", back, "> a|b"],
    ["- a\\\n  |b", back, "- a|b"],
    ["abc|\n\n# Head", del, "abc|Head"],
    ["abc|\n\n```\ncode\n```", del, "(not handled)"],
    ["a|\\\nb", del, "a|b"],
    ["a\\*|b", back, "a|b"],
    ["|abc", back, "(not handled)"],
    ["```\ncode\n```\n\n|after", back, "(not handled)"],
  ];
  for (const [before, key, after] of cases) assert.equal(run(before, key), after, before);
});

test("A deletion at the inside edge of a construct never leaves its marks showing", () => {
  const back = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, false, false);
  const del = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, true, false);
  const word = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, false, true);
  const wordDel = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, true, true);
  const cases: [string, (s: EditorState) => Edit | null, string][] = [
    // A word at either edge goes with the whitespace that would stand against the mark, when whitespace stands outside it.
    ["x **bold «and»** y", back, "x **bold|** y"],
    ["x *it «and»* y", back, "x *it|* y"],
    ["x ~~a «b»~~ y", back, "x ~~a|~~ y"],
    ["x `co «de»` y", back, "x `co|` y"],
    ["x [link «text»](u) y", back, "x [link|](u) y"],
    ["x **«bold» and** y", back, "x **|and** y"],
    ["x [«link» text](u) y", del, "x [|text](u) y"],
    ["x **bold and|** y", word, "x **bold|** y"],
    ["x **|bold and** y", wordDel, "x **|and** y"],
    ["**a *b c|*** y", word, "**a *b|*** y"],
    ["# **bold and|**", word, "# **bold|**"],
    ["- [ ] **bold and|** x", word, "- [ ] **bold|** x"],
    // With a word outside, the marks move in over the whitespace, which stays between the words.
    ["**bold «and»**y", back, "**bold** |y"],
    ["x**«and» bold** y", back, "x| **bold** y"],
    // One character goes alone: the whitespace stays, outside the marks, and the caret beside it.
    ["x **bold a|** y", back, "x **bold** | y"],
    ["x **bold |a** y", del, "x **bold** | y"],
    ["x **a| bold** y", back, "x | **bold** y"],
    // Whitespace across a soft line break takes the line break, and the lines join.
    ["**bold\nand|** y", word, "**bold|** y"],
    ["> **bold\n> and|** y", word, "> **bold|** y"],
    ["x**|and\nbold** y", wordDel, "x|\n**bold** y"],
    // A space typed after a bold word, deleted, leaves the word bold again.
    ["x **bold |** y", back, "x **bold|** y"],
    // Joined onto a word, `__` no longer opens: the construct loses its marks and keeps its text.
    ["a|\n\n__b__ c", del, "a|b c"],
  ];
  for (const [before, key, after] of cases) assert.equal(run(before, key), after, before);
});

test("A deletion keeps the fences of a code block it covers only partly", () => {
  const back = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, false, false);
  const cases: [string, string][] = [
    ["```js\nlet «a\n```\n\naft»er x\n\n# More", "```js\nlet |\n```\n\ner x\n\n# More"],
    ["para «one\n\n```js\nlet a»\n```\n\nmore", "para |\n\n```js\n\n```\n\nmore"],
    ["a«b\n\n```\ncode\n```\n\nc»d", "a|d"],
    ["- ```\n  co«de\n  ```\n\nx»y", "- ```\n  co|\n  ```\n\ny"],
    ["a«b\n\n- ```\n  co»de\n  ```", "a|\n\n- ```\n  de\n  ```"],
    ["> ```\n> «a\n> b»\n> ```", "> ```\n> |\n> ```"],
  ];
  for (const [before, after] of cases) assert.equal(run(before, back), after, before);
});

test("Text typed over a selection keeps the block and the formatting it starts in, and the paragraph break after whole lines", () => {
  // As the rendered view's filter writes it: `typedRange`, then `deletion`, then `pasted`, then `mended`.
  const typeOver = (marked: string, text: string) => {
    const s = open(marked);
    const { main } = s.selection;
    const r = main.empty ? main : typedRange(s, lay(s), main.from, main.to);
    const del = r.to > r.from ? deletion(s, r.from, r.to, !!text && !text.includes("\n")) : [];
    const { at, insert } = pasted(s, del.length ? del[0].from : r.from, text);
    const changes = mended(s, [...del.map((d) => (d.from === at ? { ...d, insert } : d)), ...(del.some((d) => d.from === at) ? [] : [{ from: at, to: at, insert }])]);
    const head = changes.mapPos(at, -1) + insert.length;
    const doc = changes.apply(s.doc).toString();
    return `${doc.slice(0, head)}|${doc.slice(head)}`;
  };
  const cases: [string, string, string][] = [
    // A triple click selects the line and the line break after it.
    ["a\n\n«body text\n\n»c", "X", "a\n\nX|\n\nc"],
    ["«line1\n»line2", "X", "X|\nline2"],
    ["«# Title»\n\npara", "X", "# X|\n\npara"],
    ["«- item»\n- two", "X", "- X|\n- two"],
    ["«> quote»\n\npara", "X", "> X|\n\npara"],
    ["«- [ ] task»\n- [ ] two", "X", "- [ ] X|\n- [ ] two"],
    ["x **«bold»** y", "X", "x **X|** y"],
    ["x «**bold**» y", "X", "x X| y"],
    ["«# Title\n\npa»ra", "X", "# X|ra"],
    // A selection of the paragraph break alone still joins the paragraphs.
    ["body tex«t\n\nc»d", "X", "body texX|d"],
    ["para «one\n\n```js\nlet a»\n```", "Z", "para Z|\n\n```js\n\n```"],
    // Pasted paragraphs close the formatting they land in and reopen it after.
    ["x **bo|ld** y", "a\n\nb", "x **boa**\n\n**b|ld** y"],
    ["a [li|nk](u) b", "x\n\ny", "a [lix](u)\n\n[y|nk](u) b"],
    ["x **bold|** y", "a\n\nb", "x **bold**a\n\nb| y"],
    ["x **bo|ld** y", "ab", "x **boab|ld** y"],
    ["see <https://exa|mple.com> x", "a\nb", "see <https://example.com>a\nb| x"],
    // A cut at a construct's edge takes the whitespace out of its marks, as a deletion does.
    ["x **bold «and»** y", "", "x **bold|** y"],
    // A space typed against a closing mark would leave it showing: the construct loses its marks and keeps its text.
    ["x **bold «and»** y", " ", "x bold  | y"],
  ];
  for (const [before, text, after] of cases) assert.equal(typeOver(before, text), after, `${before} + ${JSON.stringify(text)}`);
});

test("Dropped text sheds the syntax of the constructs it lands inside", () => {
  const cases: [string, string, string][] = [
    ["**bold and| more**", "**x**", "x"],
    ["**bold| more**", "*x* y", "*x* y"],
    ["***b|i***", "***x***", "x"],
    ["[li|nk](u)", "[x](v) *y*", "x *y*"],
    // A code span holds no syntax: the visible text lands.
    ["`co|de`", "**x** `y`", "x y"],
    ["plain| text", "**x**", "**x**"],
  ];
  for (const [marked, text, landed] of cases) {
    const s = open(marked);
    assert.equal(landing(s, s.selection.main.head, text), landed, `${marked} + ${text}`);
  }
  assert.equal(landing(open("plain| text"), 5, "**x** [y](u) `z`", true), "x y z");
  // Landed with its marks inside bold, `**and**` would close the bold early and show `****`: `intact` refuses it.
  const s = open("**bold more** x");
  assert.equal(intact(s, [{ from: 11, to: 11, insert: "**and**" }]), null);
  assert.equal(intact(s, [{ from: 11, to: 11, insert: "and" }])?.apply(s.doc).toString(), "**bold moreand** x");
});

test("An arrow press moves exactly one visible character", () => {
  const state = open("|Some **bold** and a [link](notes.md).");
  const l = lay(state);
  const stops: number[] = [];
  for (let range = state.selection.main; ; ) {
    const next = moveChar(state, l, range, true, false);
    if (next.head === range.head) break;
    stops.push(next.head);
    range = next;
  }
  // "Some bold and a link." is 21 visible characters.
  assert.deepEqual(stops, [1, 2, 3, 4, 5, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 36, 37]);
});

test("A code span shows `\\|` as `|` in a table cell and as written anywhere else", () => {
  const doc = "| h | i |\n|---|---|\n| `a \\| b` | c |\n\ncode `x \\| y` here";
  const state = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage, extensions: [GFM] }) });
  const shown = (n: number) => {
    const line = state.doc.line(n);
    const hidden = new Set<number>();
    for (const p of lineSyntax(state, line).pieces) if (p.draw === "hide") for (let i = p.from; i < p.to; i++) hidden.add(i);
    return [...line.text].filter((_, i) => !hidden.has(line.from + i)).join("");
  };
  assert.equal(shown(3), "a | bc");
  assert.equal(shown(5), "code x \\| y here");
});

test("The caret stands where typing continues the formatting before it", () => {
  const cases: [string, number][] = [
    ["# |Title", 2],
    ["|# Title", 2],
    ["**b|old**", 3],
    ["|**bold** x", 2],
    ["x |**bold**", 2],
    ["x **bold|** y", 8],
    ["x **bold**| y", 8],
    ["[link](u)| x", 9],
    ["[link|](u) x", 9],
    ["**[a](u)|**", 8],
    ["- [ ] |task", 6],
    ["|- [ ] task", 6],
  ];
  for (const [marked, pos] of cases) {
    const state = open(marked);
    assert.equal(canonical(state, lay(state), state.selection.main.head, 0).head, pos, marked);
  }
});

// Tables are written with ‸ for the caret and ‹ › around a selection, since `|` is their own syntax.

function openTable(marked: string): EditorState {
  let doc = "";
  let anchor = 0;
  let head = 0;
  for (const ch of marked) {
    if (ch === "‸") anchor = head = doc.length;
    else if (ch === "‹") anchor = doc.length;
    else if (ch === "›") head = doc.length;
    else doc += ch;
  }
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: markdown({ base: markdownLanguage, extensions: [GFM] }) });
}

const caretAt = (state: EditorState, pos: number) => `${state.doc.sliceString(0, pos)}‸${state.doc.sliceString(pos)}`;

/** The document after an edit, with ‸ where the caret lands; the input unchanged when the key declines. */
function edited(marked: string, key: (s: EditorState) => Edit | null): string {
  const state = openTable(marked);
  const edit = key(state);
  if (!edit) return marked;
  const next = state.update({ changes: edit.changes, selection: edit.range }).state;
  return caretAt(next, next.selection.main.head);
}

test("Tab, Shift+Tab and Enter move between a table's cells and never write", () => {
  const tab = (s: EditorState) => cellMove(s, lay(s), s.selection.main, 1);
  const back = (s: EditorState) => cellMove(s, lay(s), s.selection.main, -1);
  const down = (s: EditorState) => rowMove(s, lay(s), s.selection.main);
  const cases: [string, (s: EditorState) => SelectionRange | null, string][] = [
    ["| a‸ | b |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter", tab, "| a | b‸ |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter"],
    ["| a | ‸b |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter", tab, "| a | b |\n|---|:-:|\n| c1‸ | **d** |\n| e |  |\n\nafter"],
    ["| a | b |\n|---|:-:|\n| ‸c1 | **d** |\n| e |  |\n\nafter", tab, "| a | b |\n|---|:-:|\n| c1 | **d‸** |\n| e |  |\n\nafter"],
    ["| a | b |\n|---|:-:|\n| c1 | **d** |\n| e‸ |  |\n\nafter", tab, "| a | b |\n|---|:-:|\n| c1 | **d** |\n| e | ‸ |\n\nafter"],
    ["| a | b |\n|---|:-:|\n| c1 | **d** |\n| e | ‸ |\n\nafter", tab, "| a | b |\n|---|:-:|\n| c1 | **d** |\n| e | ‸ |\n\nafter"],
    ["| a | b |\n|---|:-:|\n| c‸1 | **d** |\n| e |  |\n\nafter", back, "| a | b‸ |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter"],
    ["| ‸a | b |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter", back, "| ‸a | b |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter"],
    ["| a | b‸ |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\nafter", down, "| a | b |\n|---|:-:|\n| c1 | **d‸** |\n| e |  |\n\nafter"],
    ["| a | b |\n|---|:-:|\n| c1 | **d** |\n| ‸e |  |\n\nafter", down, "| a | b |\n|---|:-:|\n| c1 | **d** |\n| e |  |\n\n‸after"],
    ["| a | b |\n|---|---|\n| ‸c | d |", down, "| a | b |\n|---|---|\n| ‸c | d |"],
    ["a | b\n--|--\n1‸ | 2", tab, "a | b\n--|--\n1 | 2‸"],
    // From spaces just typed at the end of a cell, the cell is still the one the caret is in.
    ["| a | b |\n|---|---|\n| c1 ‸ | d |", tab, "| a | b |\n|---|---|\n| c1  | d‸ |"],
  ];
  for (const [before, key, after] of cases) {
    const state = openTable(before);
    const range = key(state);
    assert.equal(range ? caretAt(state, range.head) : before, after, before);
  }
  // Outside a table the keys decline, and fall through to the editor's own.
  assert.equal(tab(openTable("plain‸ text")), null);
  assert.equal(down(openTable("plain‸ text")), null);
});

test("Shift+Enter in a cell writes <br>, and typed text is written as the cell can hold it", () => {
  const cases: [string, string][] = [
    ["| a | b |\n|---|---|\n| c‸1 | d |", "| a | b |\n|---|---|\n| c<br>‸1 | d |"],
    ["| a | b |\n|---|---|\n| c1‸ | d |", "| a | b |\n|---|---|\n| c1<br>‸ | d |"],
    ["| a | b |\n|---|---|\n| ‹c1 | d›x |", "| a | b |\n|---|---|\n| <br>‸ | x |"],
    ["plain‸ text", "plain‸ text"],
    // From a paragraph into a table the break would land in the paragraph: the key is Shift+Enter's there.
    ["pa‹ra\n\n| a | b |\n|---|---|\n| c›1 | d |", "pa‹ra\n\n| a | b |\n|---|---|\n| c›1 | d |"],
  ];
  for (const [before, after] of cases) assert.equal(edited(before, (s) => cellBreak(s, s.selection.main)), after, before);
  // The cell's text before the insertion, the text, the character after it.
  const text: [string, string, string, string][] = [
    ["", "a|b", "", "a\\|b"],
    ["", "a\nb", "", "a<br>b"],
    ["", "a\r\nb\rc", "", "a<br>b<br>c"],
    ["x\\", "|", "", "|"],
    ["", "\\|", "", "\\|"],
    ["", "a\\\\|", "", "a\\\\\\|"],
    ["x", "\\", "|", "\\\\"],
    ["x", "\\", " ", "\\"],
    ["", "plain", "|", "plain"],
    // A deletion that leaves a backslash before the cell's pipe escapes it; an escaped one stays.
    ["a\\", "", "|", "\\"],
    ["a\\\\", "", "|", ""],
  ];
  for (const [before, insert, next, written] of text) assert.equal(cellText(before, insert, next), written, JSON.stringify([before, insert, next]));
});

test("Deleting in a table takes the text of its cells and keeps its pipes and rows", () => {
  const back = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, false, false);
  const del = (s: EditorState) => deleteBy(s, lay(s), s.selection.main, true, false);
  const cases: [string, (s: EditorState) => Edit | null, string][] = [
    ["| a | b |\n|---|---|\n| c1‸ | d |", back, "| a | b |\n|---|---|\n| c‸ | d |"],
    ["| a | b |\n|---|---|\n| c1 | ‸d |", back, "| a | b |\n|---|---|\n| c1 | ‸d |"],
    ["| a | b |\n|---|---|\n| c1‸ | d |", del, "| a | b |\n|---|---|\n| c1‸ | d |"],
    ["| a | b |\n|---|---|\n| ‸c1 | d |", back, "| a | b |\n|---|---|\n| ‸c1 | d |"],
    ["| a | b |\n|---|---|\n| c1 | d‸ |\n| e | f |", del, "| a | b |\n|---|---|\n| c1 | d‸ |\n| e | f |"],
    ["para‸\n\n| a | b |\n|---|---|", del, "para‸\n\n| a | b |\n|---|---|"],
    // Spaces typed at the end of a cell are its text until a word follows them.
    ["| a | b |\n|---|---|\n| c1 ‸ | d |", back, "| a | b |\n|---|---|\n| c1‸ | d |"],
    ["| a | b |\n|---|---|\n| ‹c1 | d› |", back, "| a | b |\n|---|---|\n| ‸ |  |"],
    ["| a | b |\n|---|---|\n| c‹1 | **d** |\n| e› | f |", back, "| a | b |\n|---|---|\n| c‸ |  |\n|  | f |"],
    ["pa‹ra\n\n| a | b |\n|---|---|\n| c›1 | d |", back, "pa‸\n\n|  |  |\n|---|---|\n| 1 | d |"],
    ["pa‹ra\n\n| a | b |\n|---|---|\n| c1 | d |\n\naf›ter", back, "pa‸ter"],
  ];
  for (const [before, key, after] of cases) assert.equal(edited(before, key), after, before);
});

test("An arrow press crosses a table's pipe in one step, and a caret by a pipe is drawn in its own cell", () => {
  const state = openTable("‸| ab | **c** |  |\n|---|---|---|");
  const l = lay(state);
  const stops: string[] = [];
  for (let range = canonical(state, l, 0, 1); ; ) {
    stops.push(`${caretAt(state, range.head).split("\n")[0]} ${range.assoc}`);
    const next = moveChar(state, l, range, true, false);
    if (next.head === range.head || stops.length > 12) break;
    range = next;
  }
  assert.deepEqual(stops, [
    "| ‸ab | **c** |  | 1",
    "| a‸b | **c** |  | 0",
    "| ab‸ | **c** |  | -1",
    "| ab | **‸c** |  | 1",
    "| ab | **c‸** |  | -1",
    "| ab | **c** | ‸ | -1",
  ]);
  // Text typed at the end of a cell, or spaces typed there, leave the caret drawn in that cell.
  const typedAt = (marked: string, text: string) => {
    const s = openTable(marked);
    const tr = s.update({ changes: { from: s.selection.main.head, insert: text } });
    return caretSide(s, s.selection.main.head + text.length, tr.changes);
  };
  assert.equal(typedAt("| a | b |\n|---|---|\n| c‸ | d |", "x"), -1);
  assert.equal(typedAt("| a | b |\n|---|---|\n| c‸ | d |", " "), -1);
  assert.equal(typedAt("| a | b |\n|---|---|\n| c ‸ | d |", " "), -1);
  assert.equal(typedAt("| a | b |\n|---|---|\n| ‸c | d |", "x"), 0);
});

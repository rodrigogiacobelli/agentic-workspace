// The formatting commands write Markdown into someone's file, and a wrong
// byte is silent: each case gives the exact document before and after, so a
// change anywhere outside the construct formatted fails the case
// (`standards-testing`, ADR-003). In the documents, ‸ is the caret and ‹ ›
// a selection from anchor to head.

import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { frontmatter } from "./frontmatter.ts";
import {
  backspaceBlock, clipboardContent, dragText, insertLink, linkAt, linkable, pendingField, removeLink, setHeading,
  toggleCodeBlock, toggleList, toggleMark, toggleQuote, typeWithPending, updateLink, type Mark,
} from "./format.ts";

const language = markdown({ base: markdownLanguage, extensions: [GFM, frontmatter] });

function parse(marked: string): EditorState {
  let doc = "";
  let anchor = 0;
  let head = 0;
  for (const ch of marked) {
    if (ch === "‸") anchor = head = doc.length;
    else if (ch === "‹") anchor = doc.length;
    else if (ch === "›") head = doc.length;
    else doc += ch;
  }
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [language, pendingField] });
}

function show(state: EditorState): string {
  const { anchor, head } = state.selection.main;
  const marks = anchor === head ? [[head, "‸"]] : [[anchor, "‹"], [head, "›"]];
  let doc = state.doc.toString();
  for (const [pos, mark] of (marks as [number, string][]).sort((a, b) => b[0] - a[0])) doc = doc.slice(0, pos) + mark + doc.slice(pos);
  return doc;
}

/** The document after the command, markers and all; the input unchanged when the command declines. */
function after(input: string, command: (s: EditorState) => TransactionSpec | null): string {
  const state = parse(input);
  const spec = command(state);
  return spec ? show(state.update(spec).state) : input;
}

function table<T extends unknown[]>(cases: [string, ...T, string][], command: (s: EditorState, ...args: T) => TransactionSpec | null): void {
  for (const c of cases) {
    const input = c[0];
    const expected = c[c.length - 1] as string;
    const args = c.slice(1, -1) as unknown as T;
    assert.equal(after(input, (s) => command(s, ...args)), expected, `${JSON.stringify(input)} ${args.join(" ")}`);
  }
}

test("character formatting goes on the selection or the caret's word, and comes off text that has it", () => {
  table<[Mark]>([
    ["Some wo‸rd here", "strong", "Some **wo‸rd** here"],
    ["Some ‹two words› here", "strong", "Some **‹two words›** here"],
    ["Some ‹two words› here", "emphasis", "Some *‹two words›* here"],
    ["Some ‹gone› here", "strike", "Some ~~‹gone›~~ here"],
    ["Run ‹npm test› now", "code", "Run `‹npm test›` now"],
    ["Some **wo‸rd** here", "strong", "Some wo‸rd here"],
    ["Some *wo‸rd* here", "emphasis", "Some wo‸rd here"],
    ["Some ~~wo‸rd~~ here", "strike", "Some wo‸rd here"],
    ["Run `np‸m` now", "code", "Run np‸m now"],
    ["Some __wo‸rd__ here", "strong", "Some wo‸rd here"],
    ["‹**bold**›", "strong", "‹bold›"],
    // Partly bold becomes all bold, one run.
    ["‹plain **bold**›", "strong", "**‹plain bold**›"],
    ["‹**bold** plain›", "strong", "‹**bold plain›**"],
    ["**bold**‹more›", "strong", "**bold‹more›**"],
    // Taking it off part of a run keeps it on the rest.
    ["**one ‹two› three**", "strong", "**one** ‹two› **three**"],
    ["**one ‹two three›**", "strong", "**one** ‹two three›"],
    ["**foo‹bar›**", "strong", "**foo**‹bar›"],
    ["_foo‹bar›_", "emphasis", "*foo*‹bar›"],
    // Punctuation beside a letter stays outside, where a marker could not open or close by it.
    ["word‹) end›.", "strong", "word‹) **end›**."],
    ["**foo.‹bar›**", "strong", "**foo**.‹bar›"],
    // Across and inside other formatting.
    ["**one ‹two› three**", "emphasis", "**one *‹two›* three**"],
    ["‹foo *bar* baz›", "strong", "**‹foo *bar* baz›**"],
    ["‹foo *ba›r* baz", "strong", "**‹foo *ba›r*** baz"],
    ["[a ‹link› here](x.md)", "strong", "[a **‹link›** here](x.md)"],
    ["see ‹[link](x.m›d) now", "strong", "see **‹[link](x.m›d)** now"],
    ["see ‹www.exa›mple.com now", "strong", "see **‹www.exa›mple.com** now"],
    // Leading and trailing spaces stay outside the markers.
    ["a‹ word ›b", "strong", "a‹ **word** ›b"],
    // A code span holds no formatting, and its fence outgrows the backticks inside.
    ["run ‹a `b` c›", "code", "run `‹a b c›`"],
    ["run ‹a **b** c›", "code", "run `‹a b c›`"],
    ["‹a [link](u) b›", "code", "`‹a link b›`"],
    ["‹a <https://x.y> b›", "code", "`‹a https://x.y b›`"],
    ["use ‹a`b›", "code", "use ``‹a`b›``"],
    // Every paragraph, heading and item the selection spans, each on its own.
    ["‹one\n\ntwo›", "strong", "**‹one**\n\n**two›**"],
    ["# ‹Title›", "emphasis", "# *‹Title›*"],
    ["- ‹item›\n- next", "strong", "- **‹item›**\n- next"],
    ["| a | b |\n|---|---|\n| ‹x› | y |", "strong", "| a | b |\n|---|---|\n| **‹x›** | y |"],
    ["```\nco‸de\n```", "strong", "```\nco‸de\n```"],
    // The caret's word is the word rich mode shows, hidden syntax and all; partly formatted, it all takes the formatting.
    ["a wo**r‸d** b", "strong", "a **wor‸d** b"],
    ["a *wo*r‸d b", "emphasis", "a *wor‸d* b"],
    ["**foo**‸bar", "strong", "**foo‸bar**"],
    // Hidden syntax is not text: every letter here is bold already.
    ["‹_**a**_ **b**›", "strong", "‹_a_ b›"],
  ], toggleMark);
});

test("taking formatting off never cuts through a construct inside the run", () => {
  table<[Mark]>([
    ["**see [‹docs›](u) now**", "strong", "**see** [‹docs›](u) **now**"],
    ["*see [‹docs›](https://x.y) now*", "emphasis", "*see* [‹docs›](https://x.y) *now*"],
    ["**a *‹b›* c**", "strong", "**a** *‹b›* **c**"],
    ["*a **‹b›** c*", "emphasis", "*a* **‹b›** *c*"],
    ["***‹both›***", "emphasis", "**‹both›**"],
    ["~~a **‹b›** c~~", "strike", "~~a~~ **‹b›** ~~c~~"],
    // Part of a construct's text takes all of it.
    ["**see [d‹oc›s](u) now**", "strong", "**see** [d‹oc›s](u) **now**"],
    // The same formatting nested in the run goes, and the cut runs through it.
    ["**a __b‹c›d__ e**", "strong", "**a b**‹c›**d e**"],
    // No marker lands inside a hard break or a quote's `>`, or beside a `*` that is text.
    ["**a\\\n‹b› c**", "strong", "**a**\\\n‹b› **c**"],
    ["> **a\n> ‹b› c**", "strong", "> **a**\n> ‹b› **c**"],
    ["**a * ‹b›**", "strong", "**a** * ‹b›"],
    // A marker may join a construct's own, where CommonMark still reads both.
    ["**a *b* ‹c›**", "strong", "**a *b*** ‹c›"],
    ["*a [x](u)__‹b›__*", "emphasis", "*a [x](u)*__‹b›__"],
    // `_` that could not close or reopen at the cut, beside a letter and punctuation, is written `*`.
    ["_x ‹y›**z**_", "emphasis", "*x* ‹y›***z***"],
    ["_(p) ‹x1›**foo.** q_", "emphasis", "*(p)* ‹x1›***foo.** q*"],
  ], toggleMark);
});

test("a new run's markers open and close where they stand, or the run takes in the whole word", () => {
  table<[Mark]>([
    // A construct's syntax taken in, glued to a letter, leaves no marker room to open or close.
    ["‹q, [i›t's](u)x1bc", "strong", "**‹q, [i›t's](u)x1bc**"],
    ["bc<http‹s://a.b›>", "emphasis", "*bc<http‹s://a.b›>*"],
    ["(p‹) **d›ef**a it's", "strike", "(p‹) ~~**d›ef**a~~ it's"],
    ["x`co‹de` y›", "strong", "**x`co‹de` y›**"],
    // Nor may a marker stop the mark of a construct beside it opening or closing.
    ["bc**‹a def f›oo.** foo.", "strike", "~~bc**‹a def f›oo.**~~ foo."],
    // A code span takes such a construct in whole instead, and drops its formatting as it drops all it holds.
    ["the **‹bold›**ly", "code", "the `‹bold›`ly"],
    ["a~~‹fo›o.~~ b", "code", "a`‹fo›o.` b"],
  ], toggleMark);
});

test("a plain delimiter a new marker would pair with is escaped", () => {
  table<[Mark]>([
    // `~~~` at a line's start would open a code fence over the rest of the document.
    ["‹~5 minutes› left", "strike", "~~‹\\~5 minutes›~~ left"],
    ["a*‹b›", "emphasis", "a\\**‹b›*"],
    // Without the inner link, the outer brackets would become a link.
    ["[b‹c [word](u) foo.›](u)", "code", "\\[b`‹c word foo.›`\\](u)"],
  ], toggleMark);
  table<[string]>([
    ["see ‹a]b› now", "u", "see [a\\]b](u)‸ now"],
    ["see ‹www.exa›mple.com now", "u", "see [www.example.com](u)‸ now"],
  ], (s, target) => insertLink(s, s.selection.main.from, s.selection.main.to, target));
  table<[]>([
    ["*x [a‸*](u)", "\\*x a‸\\*"],
    ["a [www.exa‸mple.com](u) b", "a www.exa‸mple.com b"],
  ], (s) => removeLink(s, linkAt(s, s.selection.main.from, s.selection.main.to)!));
});

test("a code span in a table cell keeps the backslash of a pipe, which GFM drops there, so the cell stays one", () => {
  const head = "| h | i |\n|---|---|\n";
  table<[Mark]>([
    [`${head}| ‹a \\| b› | c |`, "code", `${head}| \`‹a \\| b›\` | c |`],
    ["| ‹a \\| b› | c |\n|---|---|\n| 1 | 2 |", "code", "| `‹a \\| b›` | c |\n|---|---|\n| 1 | 2 |"],
    // Any other escape's backslash would show in the code, and goes.
    [`${head}| ‹a \\| b \\* c› | d |`, "code", `${head}| \`‹a \\| b * c›\` | d |`],
    ["‹a \\| b›", "code", "`‹a | b›`"],
  ], toggleMark);
});

test("formatting the parser would read otherwise than promised is refused, and nothing is written", () => {
  table<[Mark]>([
    // Whichever way the markers go, the inner run's mark would pair with the outer's.
    ["x ~~a ~~(b) ‹c~~ d›~~", "emphasis", "x ~~a ~~(b) ‹c~~ d›~~"],
    ["*a *(b) ‹c* d›*", "strike", "*a *(b) ‹c* d›*"],
  ], toggleMark);
});

test("a drag carries the formatting it cuts through, and no block syntax", () => {
  const cases: [string, string][] = [
    ["**bo‹ld** and› more", "**ld** and"],
    ["# ‹Title› here", "Title"],
    ["- ‹item *o›ne* two", "item *o*"],
    ["a [li‹nk te›xt](u) b", "[nk te](u)"],
    ["x `co‹de` y›", "`de` y"],
    // Part of an address is that part: the drag removes only it, and carrying the whole would write the rest twice.
    ["see https://‹example›.com now", "example"],
    ["see <https://‹example›.com> now", "example"],
    // A backslash goes with what it escapes, and stays when that does.
    ["x ‹a\\›* y", "a"],
  ];
  for (const [input, text] of cases) {
    const { from, to } = parse(input).selection.main;
    assert.equal(dragText(parse(input), from, to), text, input);
  }
});

test("with the caret between words, formatting is set for what is typed next", () => {
  const type = (input: string, marks: Mark[], text: string) => {
    let state = parse(input);
    for (const m of marks) state = state.update(toggleMark(state, m)!).state;
    assert.equal(state.doc.toString(), parse(input).doc.toString(), "setting it writes nothing yet");
    for (const ch of text) state = state.update(typeWithPending(state, ch) ?? { changes: { from: state.selection.main.head, insert: ch }, selection: { anchor: state.selection.main.head + 1 } }).state;
    return show(state);
  };
  const cases: [string, Mark[], string, string][] = [
    ["one ‸ two", ["strong"], "x", "one **x‸** two"],
    ["one ‸two", ["emphasis"], "new", "one *new‸*two"],
    ["one ‸ two", ["strong", "emphasis"], "x", "one ***x‸*** two"],
    ["one ‸ two", ["strong"], " x", "one  **x‸** two"],
    ["**one ‸two**", ["strong"], "x", "**one** x‸**two**"],
    ["**one‸**", ["strong"], "x", "**one**x‸"],
    ["**one**‸ two", ["strong"], "x", "**one**x‸ two"],
    ["one ‸**two**", ["strong"], "x", "one **x‸two**"],
    ["**‸one**", ["strong"], "x", "x‸**one**"],
    ["one ‸ two", ["strong", "strong"], "x", "one x‸ two"],
    // A plain `*` or `~` beside the text typed stays plain.
    ["x ‸*y", ["emphasis"], "w", "x *w‸*\\*y"],
    ["‸", ["strike"], "~x", "~~\\~x‸~~"],
  ];
  for (const [input, marks, text, expected] of cases) assert.equal(type(input, marks, text), expected, `${input} ${marks} ${text}`);
});

test("paragraph styles write only the `#`s", () => {
  table<[number]>([
    ["Tit‸le", 1, "# Tit‸le"],
    ["‸Title", 2, "## ‸Title"],
    ["## Tit‸le", 3, "### Tit‸le"],
    ["## Tit‸le", 0, "Tit‸le"],
    ["## Tit‸le ##", 0, "Tit‸le"],
    ["## Tit‸le ##", 1, "# Tit‸le ##"],
    ["Tit‸le\n=====", 0, "Tit‸le"],
    ["Tit‸le\n=====", 2, "## Tit‸le"],
    ["Tit‸le\n=====", 1, "Tit‸le\n====="],
    ["- it‸em", 2, "- ## it‸em"],
    ["> quo‸te", 1, "> # quo‸te"],
    ["one\n\n‸", 1, "one\n\n# ‸"],
    ["‹a\nb›", 1, "# ‹a\n# b›"],
    ["para\n\nTit‸le\n\npara", 2, "para\n\n## Tit‸le\n\npara"],
    // A heading cut out of a paragraph takes the hard breaks either side of it, which would show.
    ["line1\\\nli‸ne2", 1, "line1\n# li‸ne2"],
    ["line1\\\nli‸ne2\\\nline3", 1, "line1\n# li‸ne2\nline3"],
    ["```\nco‸de\n```", 1, "```\nco‸de\n```"],
    ["---\ntitle: ‸x\n---", 1, "---\ntitle: ‸x\n---"],
  ], setHeading);
});

test("lists, checklists and quotes toggle on each selected line", () => {
  table<[string]>([
    ["‹one\n\ntwo›", "bullet", "- ‹one\n\n- two›"],
    ["‹- one\n- two›", "bullet", "‹one\ntwo›"],
    ["‹one\ntwo›", "bullet", "- ‹one\n- two›"],
    ["‹- one\ntwo›", "bullet", "‹- one\n- two›"],
    ["‹1. one\n- two›", "bullet", "‹- one\n- two›"],
    ["‹a\nb\nc›", "ordered", "1. ‹a\n2. b\n3. c›"],
    ["‹1. a\nb›", "ordered", "‹1. a\n2. b›"],
    ["‹1. a\n2. b›", "ordered", "‹a\nb›"],
    ["‹a\n- b›", "task", "- [ ] ‹a\n- [ ] b›"],
    ["- [ ] ta‸sk", "task", "ta‸sk"],
    ["- [x] do‸ne", "task", "do‸ne"],
    ["- [ ] ta‸sk", "bullet", "- ta‸sk"],
    ["* it‸em", "task", "* [ ] it‸em"],
    ["- a\n  b‸", "bullet", "- a\n- b‸"],
    ["  - a\n    b‸", "bullet", "  - a\n  - b‸"],
    ["# T‸itle", "bullet", "- # T‸itle"],
    ["> quo‸te", "bullet", "> - quo‸te"],
    ["a\n\n‸", "bullet", "a\n\n- ‸"],
    ["a\n\n‸", "ordered", "a\n\n1. ‸"],
    ["| a |\n|---|\n| ‸b |", "bullet", "| a |\n|---|\n| ‸b |"],
    ["Tit‸le\n=====", "bullet", "Tit‸le\n====="],
    // An item cut out of a paragraph takes the hard break before it; one it keeps stays.
    ["line1\\\nli‸ne2", "bullet", "line1\n- li‸ne2"],
    ["‹line1\\\nline2›", "bullet", "- ‹line1\n- line2›"],
    ["li‸ne1\\\nline2", "bullet", "- li‸ne1\\\nline2"],
  ], (s, kind) => toggleList(s, kind as "bullet" | "ordered" | "task"));
  table<[]>([
    ["‹a\n\nb›", "> ‹a\n\n> b›"],
    ["> a‸", "a‸"],
    ["> a\n> b‸", "a\nb‸"],
    ["> a\nb‸", "a\nb‸"],
    ["a\nb‸", "> a\n> b‸"],
    ["> > a‸", "> a‸"],
    ["- it‸em", "> - it‸em"],
    ["a\n\n‸", "a\n\n> ‸"],
    ["Tit‸le\n=====", "Tit‸le\n====="],
  ], toggleQuote);
});

test("a heading or an item cut out of a paragraph closes and reopens the formatting across the break", () => {
  table<[number]>([
    ["This is **an important\n‸phrase** that wraps.", 2, "This is **an important**\n## **‸phrase** that wraps."],
    ["run `npm\n‸install` now", 1, "run `npm`\n# `‸install` now"],
    ["**a\\\n‸b**", 1, "**a**\n# **‸b**"],
    ["*a\n‸b\nc*", 1, "*a*\n# *‸b*\n*c*"],
    ["> *a\n> ‸b*", 1, "> *a*\n> # *‸b*"],
    ["- *a\n  ‸b*", 1, "- *a*\n  # *‸b*"],
    // What cannot close and reopen is not cut: the command does nothing.
    ["a <span\n‸class=\"x\">b</span>", 1, "a <span\n‸class=\"x\">b</span>"],
  ], setHeading);
  table<[string]>([
    ["This is **an important\n‸phrase** that wraps.", "bullet", "This is **an important**\n- **‸phrase** that wraps."],
    ["see [the\n‸docs](u) here", "bullet", "see [the](u)\n- [‸docs](u) here"],
    ["one *two\n‸three* four", "task", "one *two*\n- [ ] *‸three* four"],
    ["‹a **b\nc** d›", "ordered", "1. ‹a **b**\n2. **c** d›"],
    ["a ![alt\n‸text](x.png)", "bullet", "a ![alt\n‸text](x.png)"],
  ], (s, kind) => toggleList(s, kind as "bullet" | "ordered" | "task"));
  table<[]>([
    // A heading holds one line: the rest of a paragraph joined to one stays a paragraph.
    ["# Head\n\n‸one\\\ntwo", "# Head‸one\ntwo"],
    ["# Head\n\n‸**one\ntwo**", "# Head‸**one**\n**two**"],
    // Joined, the backtick above would pair with the one below and make code of the text between.
    ["- `a\n\n‸b` c", "- `a\n\n‸b` c"],
  ], backspaceBlock);
});

test("an item changed or taken out of a list leaves the rest of the list whole", () => {
  table<[string]>([
    // A numbered item not counting from 1 cannot start a list after another list's item, so a blank line parts them.
    ["1. ‸a\n2. b\n3. c", "task", "- [ ] ‸a\n\n2. b\n3. c"],
    ["1. ‸a\n2. b", "bullet", "- ‸a\n\n2. b"],
    ["1. a\n2. ‸b\n3. c", "bullet", "1. a\n- ‸b\n\n3. c"],
    ["> 1. ‸a\n> 2. b", "bullet", "> - ‸a\n>\n> 2. b"],
    ["- a\n- ‸b\n-\n- d", "ordered", "- a\n1. ‸b\n\n-\n- d"],
    // Nor after a paragraph; and an item above would take the text in.
    ["1. ‸a\n2. b", "ordered", "‸a\n\n2. b"],
    ["- a\n- ‸b\n- c", "bullet", "- a\n\n‸b\n- c"],
    // A checklist item holds only text, so a heading made one leaves its `#`s; a bullet or a number keeps them.
    ["## ‸Head", "task", "- [ ] ‸Head"],
    ["## ‸Head ##", "task", "- [ ] ‸Head"],
    ["- ## ‸Head", "task", "- [ ] ‸Head"],
    ["1. ## ‸Head", "bullet", "- ## ‸Head"],
    ["- ## ‸Head", "bullet", "## ‸Head"],
  ], (s, kind) => toggleList(s, kind as "bullet" | "ordered" | "task"));
  table<[]>([
    ["> 1. a\n> 2. ‸b\n> 3. c", "> 1. a\n>\n> ‸b\n>\n> 3. c"],
  ], backspaceBlock);
});

test("code, frontmatter and what rich mode shows as source take no formatting and no link", () => {
  const link = (s: EditorState) => insertLink(s, s.selection.main.from, s.selection.main.to, "https://x", "t");
  for (const input of ["```\ncode‸\n```", "---\ntitle: ‸x\n---\n\nbody", "[^1]: a ‸note", "| a | b |\n|---|---‸|\n| c | d |"]) {
    assert.equal(after(input, link), input, input);
    const state = parse(input);
    assert.equal(linkable(state, state.selection.main.from, state.selection.main.to), false, input);
  }
  assert.equal(after("[^1]: a ‹note›", (s) => toggleMark(s, "strong")), "[^1]: a ‹note›");
  assert.equal(after("[^1]: a ‸note", (s) => setHeading(s, 1)), "[^1]: a ‸note");
  assert.equal(toggleMark(parse("```\na ‸ b\n```"), "strong"), null, "no formatting is set for what is typed in code");
});

test("code blocks are fenced and unfenced by whole lines", () => {
  table<[]>([
    ["a‸", "```\na‸\n```"],
    ["‹one\ntwo›\nthree", "```\n‹one\ntwo›\n```\nthree"],
    ["x\n\n‸\n\ny", "x\n\n```\n‸\n```\n\ny"],
    ["```\na‸\n```", "a‸"],
    ["p\n\n```js\na‸\nb\n```\n\nq", "p\n\na‸\nb\n\nq"],
    // Inside a list item or a quote the block stays in it, and back again.
    ["- it‸em", "- ```\n  it‸em\n  ```"],
    ["- ```\n  it‸em\n  ```", "- it‸em"],
    ["> quo‸te", "> ```\n> quo‸te\n> ```"],
    ["> ```\n> quo‸te\n> ```", "> quo‸te"],
    ["‹> a\nb›", "> ```\n> ‹a\n> b›\n> ```"],
    ["- a\n  b‸", "- a\n  ```\n  b‸\n  ```"],
    ["> - a‸", "> - ```\n>   a‸\n>   ```"],
    ["- ‸", "- ```\n  ‸\n  ```"],
    // Two items, a checklist item's box and a table's row hold no block.
    ["‹- a\n- b›", "‹- a\n- b›"],
    ["- [ ] ta‸sk", "- [ ] ta‸sk"],
    ["| a | b |\n|---|---|\n| 1 | 2‸ |", "| a | b |\n|---|---|\n| 1 | 2‸ |"],
  ], toggleCodeBlock);
});

test("Backspace at the start of a block takes its formatting off, then joins it to the paragraph above", () => {
  table<[]>([
    ["# ‸Title", "‸Title"],
    ["‸# Title", "‸Title"],
    ["## ‸Title ##", "‸Title"],
    ["Title\n‸===", "Title\n‸==="],
    ["‸Title\n===", "‸Title"],
    ["- ‸item", "‸item"],
    ["- [ ] ‸task", "‸task"],
    ["1. ‸one", "‸one"],
    ["> ‸quote", "‸quote"],
    ["> ‸a\n> b", "‸a\nb"],
    ["> - ‸item", "> ‸item"],
    ["- > ‸item", "- ‸item"],
    // An item after another stands apart as a paragraph, as does a numbered item after it that could not.
    ["- a\n- ‸b", "- a\n\n‸b"],
    ["- a\n- ‸b\n- c", "- a\n\n‸b\n- c"],
    ["1. a\n2. ‸b\n3. c", "1. a\n\n‸b\n\n3. c"],
    ["1. ‸a\n2. b", "‸a\n\n2. b"],
    ["> - a\n> - ‸b", "> - a\n>\n> ‸b"],
    ["- a\n  - ‸b", "- a\n\n  ‸b"],
    ["para\n- ‸b", "para\n\n‸b"],
    ["- a\n\n- ‸b", "- a\n\n‸b"],
    ["- ‸", "‸"],
    ["one\n\n‸two", "one‸two"],
    ["# One\n\n‸two", "# One‸two"],
    ["# One #\n\n‸two", "# One‸two"],
    ["- a\n\n‸b", "- a‸b"],
    ["- a\n\n  ‸b", "- a‸b"],
    ["> a\n>\n‸b", "> a‸b"],
    ["one  \n\n‸two", "one‸two"],
    // Not at a block's start, or nothing to join: the ordinary Backspace.
    ["Te‸xt", "Te‸xt"],
    ["one\n‸two", "one\n‸two"],
    ["‸first", "‸first"],
    ["```\nx\n```\n\n‸two", "```\nx\n```\n\n‸two"],
    ["| a |\n|---|\n\n‸two", "| a |\n|---|\n\n‸two"],
    ["Set\n===\n\n‸two", "Set\n===\n\n‸two"],
  ], backspaceBlock);
});

test("links are written, edited and removed in place", () => {
  const link = (s: EditorState) => linkAt(s, s.selection.main.from, s.selection.main.to)!;
  table<[string]>([
    ["see ‹this› now", "https://example.org", "see [this](https://example.org)‸ now"],
    ["see ‸ now", "notes/a b.md", "see [notes/a b.md](notes/a%20b.md)‸ now"],
    ["see ‹**bo›ld** now", "u", "see [**bold**](u)‸ now"],
    ["‹a [b](c) d›", "u", "‹a [b](c) d›"],
  ], (s, target) => insertLink(s, s.selection.main.from, s.selection.main.to, target));
  // Nothing typed into the popover can end the link, or the table cell it is in.
  table<[string, string]>([
    ["see ‸ now", "a [b] c\\", "u", "see [a \\[b\\] c\\\\](u)‸ now"],
    ["| h |\n|---|\n| x‸ |", "a|b", "c|d", "| h |\n|---|\n| x[a\\|b](c%7Cd)‸ |"],
    // A backtick nothing in the text closes would open a code span past the link's end.
    ["x ‸ `y", "a`b", "u", "x [a\\`b](u)‸ `y"],
    ["x ‸ `y", "a `b` c", "u", "x [a `b` c](u)‸ `y"],
    // A backslash in a target is encoded, or it would escape the character after it.
    ["see docs‸", "t", "a\\*b", "see docs[t](a%5C*b)‸"],
    ["see ‹docs› here", "", "C:\\dir\\", "see [docs](C:%5Cdir%5C)‸ here"],
    // On a line holding no text the link is a paragraph of its own, or nothing is written.
    ["a\n\n‸\n\nb", "t", "u", "a\n\n[t](u)‸\n\nb"],
    ["- ‸", "t", "u", "- [t](u)‸"],
    ["a\n‸", "t", "u", "a\n‸"],
    ["a\n\n‸\n---", "t", "u", "a\n\n‸\n---"],
  ], (s, text, target) => insertLink(s, s.selection.main.from, s.selection.main.to, target, text));
  table<[string, string]>([
    ["a [te‸xt](old.md) b", "text", "new.md", "a [text](new.md)‸ b"],
    ["a [te‸xt](old.md) b", "other", "old.md", "a [other](old.md)‸ b"],
    ["a [te‸xt](old.md \"Title\") b", "text", "new.md", "a [text](new.md \"Title\")‸ b"],
    ["a [te‸xt][ref] b", "text", "u", "a [text](u)‸ b"],
    ["a [te‸xt] b", "text", "u", "a [text](u)‸ b"],
    ["a [te‸xt](old.md) b", "text", "", "a te‸xt b"],
    ["a [te‸xt](u) b", "x]y|z", "u", "a [x\\]y|z](u)‸ b"],
    ["| h |\n|---|\n| [a‸b](u) |", "a|b", "v|w", "| h |\n|---|\n| [a\\|b](v%7Cw)‸ |"],
    ["a [te‸xt](u) and `code`", "a`b", "u", "a [a\\`b](u)‸ and `code`"],
  ], (s, text, target) => updateLink(s, link(s), text, target));
  table<[]>([
    ["a [te‸xt](old.md) b", "a te‸xt b"],
    ["a [**te‸xt**](old.md \"T\") b", "a **te‸xt** b"],
  ], (s) => removeLink(s, link(s)));
  assert.equal(linkAt(parse("a [text](x)‸ b"), 11, 11), null, "a caret just after a link is outside it");
});

test("a copy carries the selection as standalone Markdown and as escaped HTML", () => {
  const cases: [string, string, string][] = [
    ["Some **bo‹ld** and [a li›nk](https://x.org) end", "**ld** and [a li](https://x.org)", "<p><strong>ld</strong> and <a href=\"https://x.org\">a li</a></p>"],
    ["‹- one\n- **two**›", "- one\n- **two**", "<ul><li>one</li><li><strong>two</strong></li></ul>"],
    ["# ‹Title›", "# Title", "<h1>Title</h1>"],
    ["‹1 < 2 & \"q\" `<b>`›", "1 < 2 & \"q\" `<b>`", "<p>1 &lt; 2 &amp; &quot;q&quot; <code>&lt;b&gt;</code></p>"],
    ["‹[x](javascript:alert(1)) <img src=x onerror=alert(1)>›", "[x](javascript:alert(1)) <img src=x onerror=alert(1)>", "<p>x </p>"],
    ["‹> quoted *text*\n\n- [x] done›", "> quoted *text*\n\n- [x] done", "<blockquote><p>quoted <em>text</em></p></blockquote><ul><li>☑ done</li></ul>"],
    // Copy and cut carry the same text: the part of an address selected.
    ["see https://‹example›.com now", "example", "<p><a href=\"https://example.com\">example</a></p>"],
  ];
  for (const [input, text, html] of cases) {
    const state = parse(input);
    const out = clipboardContent(state, state.selection.ranges);
    assert.equal(out.text, text, input);
    assert.equal(out.html, `<meta charset="utf-8">${html}`, input);
  }
});

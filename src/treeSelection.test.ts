// Which rows a click leaves highlighted is which files Delete trashes, and
// with the question off nothing asks first (SET-05). Each case draws the
// panel as a list of rows and names what stays selected and what leads.

import assert from "node:assert/strict";
import { test } from "node:test";
import { afterRemoval, all, deleting, drawing, draws, extend, indexOf, only, outermost, toggle, type Doomed, type Row, type Selection } from "./treeSelection.ts";

const rows = (...paths: string[]): Row[] => paths.map((path) => ({ key: path, path }));
const picked = (sel: Selection) => ({ set: [...sel.set].sort(), lead: sel.lead, anchor: sel.anchor });

test("a Ctrl+click takes a row out, and the lead goes to the nearest selected row above, else below, else nowhere", () => {
  const drawn = rows("a.md", "b.md", "c.md", "d.md");
  // a.md, then Ctrl on b.md, c.md, then a.md again (TREE-22).
  let sel = only(drawn[0]);
  sel = toggle(sel, drawn, 1);
  sel = toggle(sel, drawn, 2);
  sel = toggle(sel, drawn, 0);
  assert.deepEqual(picked(sel), { set: ["b.md", "c.md"], lead: "b.md", anchor: "a.md" });
  assert.equal(toggle(sel, drawn, 2).lead, "b.md", "above first");
  assert.equal(toggle(sel, drawn, 1).lead, "c.md", "below when nothing is above");
  assert.equal(toggle(toggle(sel, drawn, 1), drawn, 2).lead, null, "nothing leads an empty selection");
});

test("a Shift range runs from the anchor over the drawn rows, and Ctrl adds it to what is there", () => {
  const drawn = rows("a.md", "b.md", "c.md", "d.md", "e.md");
  assert.deepEqual(picked(extend(only(drawn[0]), drawn, 3, false)), { set: ["a.md", "b.md", "c.md", "d.md"], lead: "d.md", anchor: "a.md" });
  // Upwards from the anchor, which stays for the next Shift+click.
  const up = extend(only(drawn[3]), drawn, 1, false);
  assert.deepEqual(picked(extend(up, drawn, 4, false)), { set: ["d.md", "e.md"], lead: "e.md", anchor: "d.md" });
  // Ctrl+Shift: a second range beside the first.
  const second = extend(toggle(extend(only(drawn[0]), drawn, 1, false), drawn, 3), drawn, 4, true);
  assert.deepEqual(second.set, new Set(["a.md", "b.md", "d.md", "e.md"]));
  // Nothing selected: the row alone, whatever anchor an emptied selection left.
  const emptied = toggle(only(drawn[2]), drawn, 2);
  assert.deepEqual(picked(extend(emptied, drawn, 4, false)), { set: ["e.md"], lead: "e.md", anchor: "e.md" });
  // An anchor folded out of sight gives way to the lead.
  assert.deepEqual(picked(extend({ set: new Set(["b.md"]), lead: "b.md", anchor: "gone.md" }, drawn, 3, false)).set, ["b.md", "c.md", "d.md"]);
});

test("a range in a view runs from the copy clicked when a file is drawn twice", () => {
  // The view holds docs/ and docs/plan.md; docs/ is open, so plan.md is drawn under it and again as an entry.
  const drawn: Row[] = [
    { key: "docs\0docs", path: "docs" },
    { key: "docs\0docs/a.md", path: "docs/a.md" },
    { key: "docs\0docs/plan.md", path: "docs/plan.md" },
    { key: "docs/plan.md\0docs/plan.md", path: "docs/plan.md" },
    { key: "notes.md\0notes.md", path: "notes.md" },
  ];
  assert.deepEqual(extend(only(drawn[4]), drawn, 3, false).set, new Set(["docs/plan.md", "notes.md"]));
  assert.deepEqual(extend(only(drawn[4]), drawn, 2, false).set, new Set(["docs/plan.md", "notes.md"]));
  assert.deepEqual(extend(only(drawn[0]), drawn, 2, false).set, new Set(["docs", "docs/a.md", "docs/plan.md"]));
  // A bare path, as a reveal or a move leaves the lead, means its first copy.
  assert.equal(extend({ set: new Set(["docs/plan.md"]), lead: "docs/plan.md", anchor: "docs/plan.md" }, drawn, 0, false).set.size, 3);
  // So does the copy under docs/ once docs/ folds: the entry copy is what is left of it.
  const folded = [drawn[0], drawn[3], drawn[4]];
  const under = only(drawn[2]);
  assert.equal(indexOf(folded, under.lead), 1);
  assert.deepEqual(picked(extend(under, folded, 2, false)), { set: ["docs/plan.md", "notes.md"], lead: "notes.md\0notes.md", anchor: "docs/plan.md\0docs/plan.md" });
});

test("Ctrl+A selects every drawn row and keeps the lead", () => {
  const drawn = rows("a.md", "b.md", "c.md");
  assert.deepEqual(picked(all(only(drawn[1]), drawn)), { set: ["a.md", "b.md", "c.md"], lead: "b.md", anchor: "b.md" });
});

test("an operation takes each path once, and nothing inside a folder it takes", () => {
  assert.deepEqual(outermost(["notes", "notes/a.md", "b.md", "notes/deep/c.md", "b.md"]), ["notes", "b.md"]);
  // A name that only starts like a taken folder is a different file.
  assert.deepEqual(outermost(["docs", "docs-old/a.md", "docsa"]), ["docs", "docs-old/a.md", "docsa"]);
  assert.deepEqual(outermost(["/w/notes", "/w/notes/a.md", "/elsewhere/notes/a.md"]), ["/w/notes", "/elsewhere/notes/a.md"]);
});

test("Delete trashes each selection once, keeps what a leaving entry or a filter's folder row stands for, and never a missing entry", () => {
  const row = (path: string, isDir = false, folds = true, missing = false): Doomed => ({ key: path, path, entry: { isDir, missing }, folds });
  const paths = ({ leaving, going }: { leaving: Doomed[]; going: Doomed[] }) => ({ leaving: leaving.map((r) => r.path), going: going.map((r) => r.path) });
  // TREE-25: a folder goes once with what is in it.
  assert.deepEqual(paths(deleting([row("notes", true), row("notes/a.md"), row("b.md")], [])), { leaving: [], going: ["notes", "b.md"] });
  // Ctrl+A in a view: the entry leaves, and the file drawn beneath it stays on disk.
  assert.deepEqual(paths(deleting([row("docs", true), row("docs/a.md"), row("gone.md", false, true, true)], ["docs", "gone.md"])), { leaving: ["docs", "gone.md"], going: [] });
  // TREE-25a: a file beneath an entry left in the view is trashed; a missing entry never is.
  assert.deepEqual(paths(deleting([row("docs/a.md"), row("gone.md", false, true, true)], [])), { leaving: [], going: ["docs/a.md"] });
  // Ctrl+A under a filter: the folders drawn on the way to the matches stay, with what the filter hides.
  assert.deepEqual(paths(deleting([row("src", true, false), row("src/lib", true, false), row("src/lib/foo.test.ts", false, false)], [])), { leaving: [], going: ["src/lib/foo.test.ts"] });
  // A folder row taken alone under a filter is the folder.
  assert.deepEqual(paths(deleting([row("src", true, false), row("b.test.ts", false, false)], [])), { leaving: [], going: ["src", "b.test.ts"] });
});

test("a panel draws a path under open folders, from a view's entries in a view, or where its filter matches", () => {
  const expanded = ["src", "src/components/deep", "docs"];
  assert.equal(draws("README.md", expanded, null, "", null), true);
  assert.equal(draws("src/App.tsx", expanded, null, "", null), true);
  assert.equal(draws("src/components/FileTree.tsx", expanded, null, "", null), false, "a folded folder hides it (TREE-19)");
  assert.equal(draws("src/components/deep/x.ts", expanded, null, "", null), false, "an open folder inside a folded one is not drawn");
  // A view counts from its entries, whatever lies above them.
  assert.equal(draws("src/components/deep/x.ts", expanded, ["src/components/deep"], "", null), true);
  assert.equal(draws("src/components/deep", [], ["src/components/deep"], "", null), true, "an entry is drawn at the root");
  assert.equal(draws("docs/plan.md", [], ["docs"], "", null), false, "under a folded entry");
  assert.equal(draws("src/App.tsx", expanded, ["docs"], "", null), false, "outside every entry");
  assert.equal(draws("docs-old/a.md", ["docs-old"], ["docs"], "", null), false, "a name that only starts like an entry");
  // A filter draws every file it matches, and the folders holding one, whatever is folded.
  const files = ["src/App.tsx", "src/components/FileTree.tsx", "notes/app.md"];
  assert.equal(draws("src/components/FileTree.tsx", [], null, "tree", files), true);
  assert.equal(draws("src/App.tsx", expanded, null, "tree", files), false);
  assert.equal(draws("src/components", [], null, "tree", files), true, "a folder holding a match");
  assert.equal(draws("notes", [], null, "tree", files), false);
  assert.equal(draws("dist/app.js", [], null, "app", files), false, "an ignored file is not in the list");
  assert.equal(draws("dist/app.js", [], null, "APP", null), true, "until the list is read, the name decides");
  assert.equal(draws("notes/app.md", [], ["src"], "app", files), false, "a view's filter keeps to its entries");
  // Weighed once for a whole selection, a filtered panel draws what it draws path by path.
  const more = [...files, "src/components/deep/app.ts", "docs-app/x.md"];
  const paths = ["", "src", "src/App.tsx", "src/components", "src/components/deep", "src/comp", "src/components/FileTree.tsx", "notes", "docs", "docs-app"];
  for (const roots of [null, ["src"]]) {
    const shows = drawing([], roots, "app", more);
    for (const p of paths) assert.equal(shows(p), draws(p, [], roots, "app", more), `${p} in ${roots ?? "the Explorer"}`);
  }
  // A filter draws the first 2000 files it matches, in the list's order; one past them has no row.
  const many = [...Array.from({ length: 2000 }, (_, i) => `a/${i}.md`), "b/late.md"];
  for (const roots of [null, ["a", "b"]]) {
    const shows = drawing([], roots, "md", many);
    for (const [p, drawn] of [["a/1999.md", true], ["a", true], ["b/late.md", false], ["b", false]] as const) {
      assert.equal(shows(p), drawn, `${p} in ${roots ?? "the Explorer"}`);
      assert.equal(draws(p, [], roots, "md", many), drawn, `${p} alone in ${roots ?? "the Explorer"}`);
    }
  }
});

test("after a delete the selection goes to the row after the last one removed, else the one before the first", () => {
  const drawn = rows("b.md", "notes", "notes/a.md", "notes/z.md", "readme.md", "z.md");
  assert.equal(afterRemoval(drawn, ["notes", "b.md"])?.path, "readme.md");
  assert.equal(afterRemoval(drawn, ["readme.md", "z.md"])?.path, "notes/z.md");
  assert.equal(afterRemoval(drawn, ["b.md", "z.md"])?.path, "notes");
  assert.equal(afterRemoval(drawn, ["notes/a.md"])?.path, "notes/z.md");
  assert.equal(afterRemoval(drawn, ["b.md", "notes", "readme.md", "z.md"]), null);
  assert.equal(afterRemoval(drawn, ["nothing.md"]), null);
});

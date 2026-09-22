// A lezer-markdown extension: a `---` fence at the very start of the document
// is YAML frontmatter, parsed as YAML for highlighting and marked so the
// rendered view can draw it as a table.

import { parseMixed } from "@lezer/common";
import { styleTags, tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { yamlLanguage } from "@codemirror/lang-yaml";

const fence = /^---\s*$/;

export const frontmatter: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }, "FrontmatterMark", "FrontmatterContent"],
  props: [styleTags({ FrontmatterMark: t.contentSeparator })],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !fence.test(line.text)) return false;
        const openEnd = line.text.length;
        let contentFrom = -1;
        let contentTo = -1;
        let end: number | null = null;
        while (cx.nextLine()) {
          if (fence.test(line.text)) {
            end = cx.lineStart + line.text.length;
            break;
          }
          if (contentFrom < 0) contentFrom = cx.lineStart;
          contentTo = cx.lineStart + line.text.length;
        }
        if (end === null) return true;
        const children = [cx.elt("FrontmatterMark", 0, openEnd)];
        if (contentFrom >= 0) children.push(cx.elt("FrontmatterContent", contentFrom, contentTo));
        children.push(cx.elt("FrontmatterMark", end - line.text.length, end));
        cx.addElement(cx.elt("Frontmatter", 0, end, children));
        cx.nextLine();
        return true;
      },
    },
  ],
  wrap: parseMixed((node) =>
    node.type.name === "FrontmatterContent" ? { parser: yamlLanguage.parser } : null,
  ),
};

// Rich mode's formatting controls: the shortcuts, the toolbar over the text,
// the link popover and the clipboard (RICH-04 to RICH-07, RICH-09, RICH-10,
// RICH-17). Every control runs a command from `format.ts`, which decides the
// bytes written. Only the rendered view carries this extension, so source
// mode and the source side of a split have no toolbar and keep CodeMirror's
// own keys.

import { Prec, StateEffect, StateField, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showPanel, showTooltip, tooltips, type Panel, type TooltipView } from "@codemirror/view";
import { iconElement, type IconName } from "../components/icons";
import { duration } from "../motion";
import { place } from "../tooltip";
import {
  backspaceBlock, clipboardContent, dragText, formatState, insertLink, linkAt, linkable, pendingField, removeLink, setHeading,
  toggleCodeBlock, toggleList, toggleMark, toggleQuote, typeWithPending, updateLink, wordAt,
  type FormatState, type LinkInfo,
} from "./format";

type Run = (view: EditorView) => void;

function command(make: (state: EditorState) => TransactionSpec | null): Run {
  return (view) => {
    const spec = make(view.state);
    if (spec) view.dispatch(spec);
  };
}

/**
 * A shortcut by the key's place on the keyboard rather than the character it
 * types, so it sits in the same place on any layout (§7): `code` is the
 * physical key, and Ctrl is always held.
 */
interface Key { code: string; shift?: boolean; alt?: boolean; text: string }

interface Control { id: string; label: string; icon: IconName; key?: Key; run: Run; pressed(s: FormatState): boolean }

// --- The link popover (RICH-09) ----------------------------------------------

/** The range a link is being written over, and the link when it exists already. */
interface LinkEdit { from: number; to: number; link: LinkInfo | null }

const setLinkEdit = StateEffect.define<LinkEdit | null>();

/** Open until it is applied or dismissed, or the text or caret moves under it. */
const linkEdit = StateField.define<LinkEdit | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLinkEdit)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (field) => showTooltip.from(field, (edit) => (edit ? { pos: edit.from, above: false, create: (view) => linkPopover(view, edit) } : null)),
});

/**
 * Ctrl+K: the link the caret is in, or the selection, or the caret's word,
 * or a new link at the caret. In code, frontmatter and what rich mode shows
 * as source it does nothing, as no link can be written there.
 */
function editLink(view: EditorView): void {
  const { state } = view;
  const r = state.selection.main;
  if (!linkable(state, r.from, r.to)) return;
  const link = linkAt(state, r.from, r.to);
  const word = r.empty ? wordAt(state, r.head) : null;
  view.dispatch({ effects: setLinkEdit.of(link ? { from: link.from, to: link.to, link } : { from: word?.from ?? r.from, to: word?.to ?? r.to, link: null }) });
}

function linkPopover(view: EditorView, edit: LinkEdit): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-lp-linkpop";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", edit.link ? "Edit link" : "Insert link");
  const field = (label: string, value: string, placeholder: string) => {
    const row = dom.appendChild(document.createElement("label"));
    row.className = "cm-lp-linkpop-field";
    row.appendChild(document.createElement("span")).textContent = label;
    const input = row.appendChild(document.createElement("input"));
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  };
  // A selection is the new link's text already; nothing else is.
  const text = edit.link || edit.from === edit.to ? field("Text", edit.link?.text ?? "", "Link text") : null;
  const target = field("Target", edit.link?.url ?? "", "https://… or a path");
  const actions = dom.appendChild(document.createElement("div"));
  actions.className = "cm-lp-linkpop-actions";
  const button = (label: string, cls: string, run: () => void) => {
    const b = actions.appendChild(document.createElement("button"));
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", run);
  };

  // Said when a command is refused, since Markdown would read what it writes
  // otherwise (`format.ts`): the popover stays open with what was typed.
  const refusal = dom.insertBefore(document.createElement("p"), actions);
  refusal.className = "setting-error";
  refusal.setAttribute("role", "alert");
  refusal.hidden = true;

  let done = false;
  const close = (spec: TransactionSpec | null, refocus = true) => {
    if (done) return;
    done = true;
    view.dispatch(...(spec ? [spec] : []), { effects: setLinkEdit.of(null) });
    if (refocus) view.focus();
  };
  const attempt = (spec: TransactionSpec | null) => {
    if (spec) return close(spec);
    refusal.textContent = "Not written: it would change the text around the link.";
    refusal.hidden = false;
  };
  const apply = () => {
    const state = view.state;
    if (edit.link) attempt(updateLink(state, edit.link, text?.value ?? edit.link.text, target.value));
    else if (target.value.trim()) attempt(insertLink(state, edit.from, edit.to, target.value, text?.value ?? ""));
    else close(null);
  };
  if (edit.link) button("Remove link", "cm-lp-linkpop-remove", () => attempt(removeLink(view.state, edit.link!)));
  button(edit.link ? "Apply" : "Insert", "cm-lp-linkpop-apply", apply);

  dom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply(); }
    else if (e.key === "Escape") { e.preventDefault(); close(null); }
  });
  // Focus leaving for anywhere but the popover dismisses it; the text keeps
  // what it had. Removing the popover moves focus too, so this waits a turn.
  dom.addEventListener("focusout", (e) => {
    if (dom.contains(e.relatedTarget as Node | null)) return;
    window.setTimeout(() => { if (view.state.field(linkEdit, false) === edit) close(null, false); });
  });
  return {
    dom,
    mount: () => {
      const first = text && !edit.link ? text : target;
      first.focus({ preventScroll: true });
      first.select();
    },
  };
}

// --- Controls ----------------------------------------------------------------

const mark = (m: Parameters<typeof toggleMark>[1]) => command((s) => toggleMark(s, m));
const list = (k: Parameters<typeof toggleList>[1]) => command((s) => toggleList(s, k));

const CONTROLS: Control[] = [
  { id: "strong", label: "Bold", icon: "bold", key: { code: "KeyB", text: "Ctrl+B" }, run: mark("strong"), pressed: (s) => s.marks.strong },
  { id: "emphasis", label: "Italic", icon: "italic", key: { code: "KeyI", text: "Ctrl+I" }, run: mark("emphasis"), pressed: (s) => s.marks.emphasis },
  { id: "strike", label: "Strikethrough", icon: "strikethrough", key: { code: "KeyX", shift: true, text: "Ctrl+Shift+X" }, run: mark("strike"), pressed: (s) => s.marks.strike },
  { id: "code", label: "Inline code", icon: "code", key: { code: "Backquote", text: "Ctrl+`" }, run: mark("code"), pressed: (s) => s.marks.code },
  { id: "link", label: "Link", icon: "link", key: { code: "KeyK", text: "Ctrl+K" }, run: editLink, pressed: (s) => s.link },
  { id: "bullet", label: "Bulleted list", icon: "bulletList", key: { code: "Digit8", shift: true, text: "Ctrl+Shift+8" }, run: list("bullet"), pressed: (s) => s.list === "bullet" },
  { id: "ordered", label: "Numbered list", icon: "numberedList", key: { code: "Digit7", shift: true, text: "Ctrl+Shift+7" }, run: list("ordered"), pressed: (s) => s.list === "ordered" },
  { id: "task", label: "Checklist", icon: "checklist", key: { code: "Digit9", shift: true, text: "Ctrl+Shift+9" }, run: list("task"), pressed: (s) => s.list === "task" },
  { id: "quote", label: "Quote", icon: "quote", run: command(toggleQuote), pressed: (s) => s.quote },
  { id: "codeblock", label: "Code block", icon: "codeBlock", run: command(toggleCodeBlock), pressed: (s) => s.codeBlock },
];
/** Where the toolbar draws a divider: after inline code, after the link, and after the lists. */
const GROUP_ENDS = new Set(["code", "link", "task"]);

const STYLES: { level: number; label: string; key: Key; run: Run }[] = [0, 1, 2, 3].map((level) => ({
  level,
  label: level ? `Heading ${level}` : "Body text",
  key: { code: `Digit${level}`, alt: true, text: `Ctrl+Alt+${level}` },
  run: command((state) => setHeading(state, level)),
}));

const BINDINGS: { key: Key; run: Run }[] = [...CONTROLS, ...STYLES].flatMap((c) => (c.key ? [{ key: c.key, run: c.run }] : []));

/**
 * Takes a binding's key whatever the command makes of it: a key the editor
 * let through would reach the webview's own editing, which bolds and
 * italicises the page's markup rather than the file.
 */
function onKeydown(e: KeyboardEvent, view: EditorView): boolean {
  if (!e.ctrlKey || e.metaKey || e.isComposing) return false;
  const hit = BINDINGS.find((b) => b.key.code === e.code && !!b.key.shift === e.shiftKey && !!b.key.alt === e.altKey);
  if (!hit) return false;
  hit.run(view);
  return true;
}

// --- The toolbar (RICH-10) -----------------------------------------------------

function toolButton(className: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", label);
  return b;
}

/**
 * A row of controls over the rendered text. Each shows whether the selection
 * has its formatting and names its shortcut; none takes the caret or the
 * selection from the text, since a press on the row is never a focus change.
 */
function toolbar(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-lp-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Formatting");
  dom.addEventListener("mousedown", (e) => e.preventDefault());

  const style = toolButton("cm-lp-tool cm-lp-style", "Paragraph style", "Paragraph style");
  style.setAttribute("aria-haspopup", "menu");
  style.setAttribute("aria-expanded", "false");
  const styleName = style.appendChild(document.createElement("span"));
  styleName.className = "cm-lp-style-name";
  style.append(iconElement("chevronDown", undefined, "cm-lp-style-caret"));
  style.addEventListener("click", () => (menu ? closeMenu(true) : openMenu()));
  dom.append(style, divider());

  const buttons = CONTROLS.map((c) => {
    const b = toolButton("cm-lp-tool", c.label, c.key ? `${c.label} (${c.key.text})` : c.label);
    b.dataset.command = c.id;
    b.setAttribute("aria-pressed", "false");
    b.append(iconElement(c.icon));
    b.addEventListener("click", () => {
      c.run(view);
      // Pressed while focus was elsewhere, the control hands the text the
      // caret; the link popover, or a control reached by keyboard, keeps it.
      if (!view.dom.contains(document.activeElement)) view.focus();
    });
    dom.append(b);
    if (GROUP_ENDS.has(c.id)) dom.append(divider());
    return b;
  });

  // The paragraph style menu: the application's menu, hung under the control.
  let menu: HTMLDivElement | null = null;
  let focused = -1;
  const items: HTMLButtonElement[] = [];
  const highlight = (i: number) => {
    focused = (i + items.length) % items.length;
    items.forEach((item, n) => item.classList.toggle("focused", n === focused));
  };
  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!menu?.contains(t) && !style.contains(t)) closeMenu(true);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu(true);
    else if (e.key === "ArrowDown") highlight(focused + 1);
    else if (e.key === "ArrowUp") highlight(focused - 1);
    else if (e.key === "Enter" && focused >= 0) items[focused].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onLeave = () => closeMenu(false);
  const openMenu = () => {
    const current = formatState(view.state).heading;
    menu = document.createElement("div");
    menu.className = "menu cm-lp-style-menu";
    menu.setAttribute("role", "menu");
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    items.length = 0;
    for (const s of STYLES) {
      const item = menu.appendChild(document.createElement("button"));
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(s.level === current));
      item.dataset.level = String(s.level);
      const check = item.appendChild(document.createElement("span"));
      check.className = "menu-check";
      check.textContent = s.level === current ? "✓" : "";
      const label = item.appendChild(document.createElement("span"));
      label.className = `menu-label cm-lp-style-${s.level}`;
      label.textContent = s.label;
      const hint = item.appendChild(document.createElement("span"));
      hint.className = "menu-hint";
      hint.textContent = s.key.text;
      // An action closes its menu at once; its result is the acknowledgement.
      item.addEventListener("click", () => {
        closeMenu(false);
        s.run(view);
      });
      items.push(item);
    }
    document.body.append(menu);
    place(menu, style);
    focused = -1;
    style.classList.add("open");
    style.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onMenuKey, true);
    window.addEventListener("blur", onLeave);
    window.addEventListener("resize", onLeave);
  };
  function closeMenu(animate: boolean) {
    const m = menu;
    if (!m) return;
    menu = null;
    style.classList.remove("open");
    style.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("resize", onLeave);
    if (!animate) return m.remove();
    m.classList.add("is-closing");
    window.setTimeout(() => m.remove(), duration("--d-fast"));
  }

  const refresh = (state: EditorState) => {
    const s = formatState(state);
    styleName.textContent = STYLES[s.heading]?.label ?? `Heading ${s.heading}`;
    CONTROLS.forEach((c, i) => {
      const on = c.pressed(s);
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-pressed", String(on));
    });
  };
  refresh(view.state);
  return {
    dom,
    top: true,
    update: (u) => {
      if (u.docChanged || u.selectionSet || u.startState.field(pendingField) !== u.state.field(pendingField)) refresh(u.state);
    },
    destroy: () => closeMenu(false),
  };
}

function divider(): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-lp-tool-divider";
  el.setAttribute("role", "separator");
  return el;
}

// --- Copying (RICH-17) -------------------------------------------------------

/**
 * Copy and cut put the Markdown on the clipboard as text and the formatting
 * as HTML. A copy and a cut carry the same text, the selection's own, so
 * what a cut removes is what it pastes back. An empty selection is
 * CodeMirror's: the whole line.
 */
function copy(e: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length || !e.clipboardData) return false;
  const { text, html } = clipboardContent(view.state, ranges);
  e.clipboardData.clearData();
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData("text/html", html);
  if (cut && !view.state.readOnly) view.dispatch({ changes: ranges, scrollIntoView: true, userEvent: "delete.cut" });
  return true;
}

/**
 * A drag carries the selection's source balanced (`dragText`), where
 * CodeMirror would carry the raw slice and drop a lone `**`. CodeMirror runs
 * this filter on the text of a drag and of its own copy; a copy of a
 * selection is `copy`'s, and CodeMirror's copies only a caret's whole line,
 * which is not the selection's text and passes unchanged.
 */
const dragFilter = EditorView.clipboardOutputFilter.of((text, state) => {
  const { main } = state.selection;
  return !main.empty && text === state.sliceDoc(main.from, main.to) ? dragText(state, main.from, main.to) : text;
});

export function richFormatting(): Extension {
  return [
    pendingField,
    linkEdit,
    dragFilter,
    Prec.highest([
      EditorView.domEventHandlers({
        keydown: onKeydown,
        copy: (e, view) => copy(e, view, false),
        cut: (e, view) => copy(e, view, true),
      }),
      keymap.of([{
        key: "Backspace",
        run: (view) => {
          const spec = backspaceBlock(view.state);
          if (spec) view.dispatch(spec);
          return !!spec;
        },
      }]),
      // Text typed where formatting is pending is written with it (RICH-04).
      EditorView.inputHandler.of((view, from, to, text) => {
        if (from !== to || view.composing || from !== view.state.selection.main.head) return false;
        const spec = typeWithPending(view.state, text);
        if (spec) view.dispatch(spec);
        return !!spec;
      }),
    ]),
    showPanel.of(toolbar),
    // The link popover sits in `.cm-editor`, which its group clips
    // (`.split-child`), so it is placed in the editor's own box, 8 px in at
    // the sides, rather than anywhere in the window, and styles.css keeps it
    // narrower than that box. Absolute from the start: WebKitGTK passes for
    // Safari, whose path in CodeMirror turns a fixed tooltip absolute on its
    // first or second measure anyway, and while fixed the width cap is a
    // share of the window rather than of the editor.
    tooltips({
      position: "absolute",
      tooltipSpace: (view) => {
        const r = view.dom.getBoundingClientRect();
        return { left: r.left + 8, right: r.right - 8, top: r.top, bottom: r.bottom };
      },
    }),
  ];
}

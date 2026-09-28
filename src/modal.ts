// Whether an app-drawn modal is open. Behind one, nothing else may take the
// keyboard: the modal traps focus, the terminals and the editors skip focusing
// themselves, and each window's capture-phase shortcuts return early — quit
// excepted — so a keystroke meant for a passphrase field never reaches the
// shell or the document the dialog covers. A stack, not a flag: a credential
// prompt can arrive over the settings dialog, closing it must leave the dialog
// under it modal, and only the newest one holds the keyboard.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** A modal's element, and where the keyboard goes back to when it closes. */
interface Entry { node: HTMLElement | null; from: HTMLElement | null }

const stack: Entry[] = [];

export function modalOpen(): boolean {
  return stack.length > 0;
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/** What Tab stops at inside `root`, in document order: a roving tab list's unselected tabs are not. */
function tabbable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

/**
 * Makes the element `ref` holds modal for as long as the calling component is
 * mounted: on the stack `modalOpen` reads, focus kept inside it — a `focusin`
 * anywhere else is moved back, and Tab and Shift+Tab wrap at its ends — and,
 * when it unmounts, the keyboard given back to whatever had it before it
 * opened. `onEscape` runs for an Escape nothing inside already handled
 * (`defaultPrevented`); a dismissed surface still on screen for its exit is
 * the caller's to ignore. The element carries `aria-modal="true"`, takes its
 * own first focus with `autoFocus` (else its first stop gets it), and wants
 * `tabIndex={-1}` for the case where nothing inside it can take the keyboard.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  // Read while rendering: by the time an effect runs, a field inside with
  // `autoFocus` already has the keyboard.
  const [from] = useState(() => document.activeElement as HTMLElement | null);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useLayoutEffect(() => {
    const node = ref.current;
    const entry: Entry = { node, from };
    // An app-drawn menu left open — a dropdown in the dialog underneath —
    // sits above every overlay, still takes clicks and would take the first
    // Escape. Each closes on a mousedown outside itself, and one dispatched on
    // the body reaches none of the app's own handlers.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    stack.push(entry);
    const top = () => stack[stack.length - 1] === entry;
    let last: HTMLElement | null = null;
    const onFocusIn = (e: FocusEvent) => {
      if (!node || !top()) return;
      const target = e.target as HTMLElement;
      if (node.contains(target)) { last = target; return; }
      // A modal opening over this one: React gives its `autoFocus` field the
      // keyboard before the modal has registered and taken the top.
      const owner = target.closest?.('[aria-modal="true"]');
      if (owner && !stack.some((o) => o.node === owner)) return;
      (last && node.contains(last) ? last : tabbable(node)[0] ?? node).focus();
    };
    if (node && !node.contains(document.activeElement)) (tabbable(node)[0] ?? node).focus();
    // On the document, bubbling: every handler inside has had the key first.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!node || !top() || e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (!escape.current) return;
        e.preventDefault();
        escape.current();
        return;
      }
      // WebKitGTK reports Shift+Tab with key "Unidentified"; its code stays "Tab".
      if (e.key !== "Tab" && e.code !== "Tab") return;
      const all = tabbable(node);
      const at = all.indexOf(document.activeElement as HTMLElement);
      const inside = node.contains(document.activeElement);
      if (!all.length) { e.preventDefault(); node.focus(); }
      else if (e.shiftKey && (!inside || at === 0)) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && (!inside || at === all.length - 1)) { e.preventDefault(); all[0].focus(); }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
      const i = stack.indexOf(entry);
      const above = stack[i + 1];
      // Closed from under another modal: that one gives the keyboard back
      // now, and what it would have given it to was inside this one.
      if (above && (!above.from || node?.contains(above.from))) above.from = entry.from;
      stack.splice(i, 1);
      const back = entry.from;
      // StrictMode rehearses an unmount and mounts again at once, with the
      // element still in the document; only a real close gives the keyboard
      // back, and only when nothing else has taken it since.
      queueMicrotask(() => {
        if (node?.isConnected || above) return;
        const now = document.activeElement;
        if (back?.isConnected && (!now || now === document.body)) back.focus();
      });
    };
  }, [ref, from]);
}

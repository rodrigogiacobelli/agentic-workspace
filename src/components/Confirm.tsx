import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../modal";
import { useDismiss } from "../motion";

interface Props {
  title: string;
  message: string;
  /** A choice that goes with the answer, unticked until it is ticked; `detail` says what ticking it costs. */
  checkbox?: { label: string; detail?: string };
  ok: string;
  cancel: string;
  /** A third answer, between the two: Keep both beside Replace (TREE-27). */
  alt?: string;
  /**
   * `ok` is false for every way of declining; `checked` is the box, false
   * without one; `alt` says the third answer was picked, with `ok` false.
   */
  onClose: (ok: boolean, checked: boolean, alt: boolean) => void;
}

/**
 * A question with a yes and a no, drawn by the app because the platform's
 * dialog holds two buttons and nothing else, and some questions carry a
 * choice of their own (GIT-22, SET-05a) or a third answer (TREE-27).
 */
export function Confirm({ title, message, checkbox, ok, cancel, alt, onClose }: Props) {
  const [checked, setChecked] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [closing, dismiss] = useDismiss(() => onClose(false, false, false));
  const id = useId();
  useModal(dialog, closing ? undefined : dismiss);
  // On the body: a panel's region is a size container, and that would make it
  // the box a fixed overlay is placed in.
  return createPortal(
    <div className={`overlay${closing ? " is-closing" : ""}`} onMouseDown={dismiss}>
      {/* Focusable, so a click on the text keeps the keyboard inside the
          dialog rather than dropping it on the body. */}
      <div
        ref={dialog}
        className="dialog confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id={`${id}-title`}>{title}</div>
        <p className="confirm-message" id={`${id}-message`}>{message}</p>
        {checkbox && (
          <label className="confirm-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{checkbox.label}</span>
          </label>
        )}
        {checkbox?.detail && <p className="confirm-detail">{checkbox.detail}</p>}
        <div className="confirm-actions">
          {/* The keyboard starts on the way out: Enter on a question that
              deletes something keeps it. */}
          <button autoFocus onClick={dismiss}>{cancel}</button>
          {alt && <button onClick={() => { if (!closing) onClose(false, checked, true); }}>{alt}</button>}
          <button className="confirm-ok" onClick={() => { if (!closing) onClose(true, checked, false); }}>{ok}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

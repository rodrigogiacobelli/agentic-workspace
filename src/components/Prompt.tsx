import { useEffect, useRef, useState } from "react";
import { useDismiss } from "../motion";

interface Props {
  title: string;
  initial?: string;
  /** Characters to preselect, so renaming keeps the extension out of the way. */
  selectEnd?: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** One text field in a modal. */
export function Prompt({ title, initial = "", selectEnd, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  /** Where the keyboard was when this opened, and whether it was answered. */
  const from = useRef<HTMLElement | null>(null);
  const submitted = useRef(false);
  const [closing, dismiss] = useDismiss(onClose);
  useEffect(() => {
    from.current = document.activeElement as HTMLElement | null;
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectEnd ?? initial.length);
    // Dismissing gives the keyboard back to whatever had it — the file tree,
    // usually. Left on the body, the next key pressed would do nothing.
    // Answering does not: what the answer opened is owed the keyboard.
    return () => { if (!submitted.current) from.current?.focus?.(); };
  }, [initial, selectEnd]);
  return (
    <div className={`overlay${closing ? " is-closing" : ""}`} onMouseDown={dismiss}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          placeholder={title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Dismissed is dismissed: the exit is still on screen, but the
            // field must not still answer for it.
            if (closing) return;
            if (e.key === "Enter" && value.trim()) { submitted.current = true; onSubmit(value.trim()); }
            if (e.key === "Escape") dismiss();
          }}
        />
      </div>
    </div>
  );
}

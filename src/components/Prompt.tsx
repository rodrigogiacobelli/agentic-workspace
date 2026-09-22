import { useEffect, useRef, useState } from "react";

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
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectEnd ?? initial.length);
  }, [initial, selectEnd]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          placeholder={title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
    </div>
  );
}

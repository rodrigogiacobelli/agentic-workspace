// Tooltips drawn by the app. The platform's own take half a second to show
// and cannot be tuned; these show after 200 ms, take their text from the
// element's `title`, and follow the pointer at once while one is on screen.

const DELAY = 200;

export function installTooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);
  /** The element whose tip is shown or pending. */
  let current: Element | null = null;
  /** The element under the last click: no tip for it until the pointer leaves. */
  let clicked: Element | null = null;
  let timer: number | null = null;

  const hoverable = (node: EventTarget | null): Element | null =>
    (node as Element | null)?.closest?.("[title], [data-tip]") ?? null;

  const hide = () => {
    if (timer) { window.clearTimeout(timer); timer = null; }
    tip.hidden = true;
    current = null;
  };
  const show = (el: Element, text: string) => {
    if (!el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
    let y = r.bottom + 6;
    if (y + h > window.innerHeight) y = Math.max(4, r.top - h - 6);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  document.addEventListener("mouseover", (e) => {
    const el = hoverable(e.target);
    if (el === current || el === clicked) return;
    clicked = null;
    // A tip already on screen moves to the next element without the delay.
    const chain = !tip.hidden;
    hide();
    if (!el) return;
    // The native tooltip would show too; the text moves to a data attribute.
    const title = el.getAttribute("title");
    if (title) { el.setAttribute("data-tip", title); el.removeAttribute("title"); }
    const text = el.getAttribute("data-tip");
    if (!text) return;
    current = el;
    if (chain) show(el, text);
    else timer = window.setTimeout(() => { timer = null; if (current === el) show(el, text); }, DELAY);
  });
  document.addEventListener("mouseout", (e) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    // Straight onto another element with a tip: the mouseover that follows
    // decides, with this tip still up. Anywhere else, the delay starts over.
    if (hoverable(to)) return;
    hide();
  });
  document.addEventListener("mousedown", (e) => { clicked = hoverable(e.target); hide(); }, true);
  for (const type of ["keydown", "wheel", "dragstart"]) document.addEventListener(type, hide, true);
  window.addEventListener("blur", hide);
}

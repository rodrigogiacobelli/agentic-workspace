// Tooltips drawn by the app. The platform's own take half a second to show
// and cannot be tuned; these show after 200 ms, at once while the pointer is
// still moving between tips, and take their text from the element's `title`.

const DELAY = 200;
const GRACE = 500;

export function installTooltips(): void {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);
  let current: Element | null = null;
  let timer: number | null = null;
  let hiddenAt = 0;

  const hide = () => {
    if (timer) { window.clearTimeout(timer); timer = null; }
    if (!tip.hidden) hiddenAt = Date.now();
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
    const el = (e.target as Element).closest?.("[title], [data-tip]") ?? null;
    if (el === current) return;
    hide();
    if (!el) return;
    // The native tooltip would show too; the text moves to a data attribute.
    const title = el.getAttribute("title");
    if (title) { el.setAttribute("data-tip", title); el.removeAttribute("title"); }
    const text = el.getAttribute("data-tip");
    if (!text) return;
    current = el;
    const delay = Date.now() - hiddenAt < GRACE ? 0 : DELAY;
    timer = window.setTimeout(() => { timer = null; if (current === el) show(el, text); }, delay);
  });
  document.addEventListener("mouseout", (e) => {
    if (!current) return;
    const to = e.relatedTarget as Node | null;
    if (to && current.contains(to)) return;
    hide();
  });
  for (const type of ["mousedown", "keydown", "wheel", "dragstart"]) document.addEventListener(type, hide, true);
  window.addEventListener("blur", hide);
}

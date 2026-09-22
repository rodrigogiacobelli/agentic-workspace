// Subsequence matching with a bias toward the start of path segments and
// words, so `acmd` finds `working/acceptance-criteria.md`.

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return -1;
    const prev = idx > 0 ? t[idx - 1] : "/";
    if (prev === "/" || prev === "-" || prev === "_" || prev === "." || prev === " ") score += 8;
    else if (idx === lastMatch + 1) score += 4;
    else score -= Math.min(idx - ti, 10) * 0.5;
    lastMatch = idx;
    ti = idx + 1;
  }
  // Shorter texts rank above longer ones with the same match quality.
  return score - text.length * 0.01;
}

export function rank<T>(query: string, items: T[], text: (item: T) => string, limit = 50): T[] {
  if (!query) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(query, text(item)) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}

/**
 * Fuzzy matching in the spirit of VS Code's quick open (Ctrl+P): the query's characters must appear in the
 * text in order, case-insensitively; matches at the start of the text, at word boundaries (`-`, `_`, `.`,
 * space, camelCase, digits) and runs of consecutive characters score higher.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the text of the matched characters, ascending. */
  indices: number[];
}

const START_BONUS = 8;
const BOUNDARY_BONUS = 6;
const CONSECUTIVE_BONUS = 5;
const GAP_PENALTY = 1;

function isSeparator(ch: string): boolean {
  return ch === "-" || ch === "_" || ch === "." || ch === " " || ch === "/";
}

function charBonus(text: string, j: number): number {
  if (j === 0) return START_BONUS;
  const prev = text[j - 1]!;
  const cur = text[j]!;
  if (isSeparator(prev)) return BOUNDARY_BONUS;
  if (prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase()) return BOUNDARY_BONUS;
  if (/\d/.test(cur) && !/\d/.test(prev)) return BOUNDARY_BONUS;
  return 0;
}

/** Best match of `query` in `text`, or null when `query` is not a subsequence of it. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;

  // best[i][j]: best score of matching q[0..i] with q[i] at t[j]; from[i][j]: the position of q[i-1].
  const NONE = Number.NEGATIVE_INFINITY;
  const best: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(n).fill(NONE);
    const back = new Array<number>(n).fill(-1);
    for (let j = i; j < n; j++) {
      if (t[j] !== q[i]) continue;
      const base = 1 + charBonus(text, j);
      if (i === 0) {
        // A late first character costs a little, so "pr" prefers "projects" over "app-routes".
        row[j] = base - Math.min(j, 3);
        continue;
      }
      const prev = best[i - 1]!;
      for (let k = i - 1; k < j; k++) {
        if (prev[k] === NONE) continue;
        const s = prev[k]! + base + (k === j - 1 ? CONSECUTIVE_BONUS : -GAP_PENALTY);
        if (s > row[j]!) {
          row[j] = s;
          back[j] = k;
        }
      }
    }
    best.push(row);
    from.push(back);
  }

  const last = best[m - 1]!;
  let end = -1;
  for (let j = 0; j < n; j++) if (last[j] !== NONE && (end < 0 || last[j]! > last[end]!)) end = j;
  if (end < 0) return null;

  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i]![j]!;
  }
  return { score: last[end]!, indices };
}

/**
 * The items of `items` that match `query`, best first (higher score, then shorter label, then alphabetical),
 * each with its match. An empty query keeps every item in its original order.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, label: (item: T) => string): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; text: string; order: number }[] = [];
  items.forEach((item, order) => {
    const text = label(item);
    const match = fuzzyMatch(query, text);
    if (match) out.push({ item, match, text, order });
  });
  if (query.length > 0) {
    out.sort((a, b) => b.match.score - a.match.score || a.text.length - b.text.length || a.text.localeCompare(b.text) || a.order - b.order);
  }
  return out.map(({ item, match }) => ({ item, match }));
}

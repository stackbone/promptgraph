/**
 * Lane layout of the Git graph (DESIGN §13.7): a pure function from commits in topological order (children before
 * their parents, as `git log --topo-order` gives them) to one row per commit with the commit's column, its colour and
 * the line segments crossing the row. Linear in commits × lanes, so thousands of commits lay out in milliseconds.
 *
 * Model: a list of lanes, each waiting for one commit (the parent of the commit above it in the lane). A commit takes
 * the leftmost lane waiting for it, or a free lane when none does (a branch tip); every other lane waiting for it
 * joins it there. Its first parent continues in its lane with its colour, even when another lane already waits for
 * that parent (both lines run side by side and meet at the parent, so a branch is drawn down to where it forked);
 * each further parent (a merge) joins the lane already waiting for that parent, or opens a new lane with a new colour
 * to the right. Free lanes are reused, so the graph stays as narrow as the branches alive at each row.
 *
 * With `mainline` (the checked-out commit), its first-parent chain owns lane 0 and colour 0: the current branch is a
 * straight line on the left, and every other branch is drawn from lane 1 on.
 */

export interface LayoutCommit {
  hash: string;
  parents: readonly string[];
  /** Draw the lines from this commit to its parents dashed (the uncommitted-changes row). */
  dashed?: boolean;
}

/**
 * A segment inside one row, between lane columns. `through`: top to bottom of a lane that passes by; `in`: from the
 * top of lane `from` to the commit (column `to`); `out`: from the commit (column `from`) to the bottom of lane `to`.
 */
export interface GraphEdge {
  kind: "through" | "in" | "out";
  from: number;
  to: number;
  /** Colour index (the renderer maps it onto its palette). */
  colour: number;
  dashed: boolean;
}

export interface GraphRow {
  /** Column of the commit's node. */
  column: number;
  colour: number;
  edges: GraphEdge[];
  /** Columns this row uses (node and edges). */
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest row. */
  width: number;
}

interface Lane {
  /** The commit this lane waits for. */
  hash: string;
  colour: number;
  dashed: boolean;
}

/** The first free lane at or after `from` (possibly past the end). */
function freeLane(lanes: (Lane | null)[], from: number): number {
  for (let i = from; i < lanes.length; i++) if (lanes[i] === null) return i;
  return Math.max(lanes.length, from);
}

/** Sets a lane, filling any gap before it with free lanes (never holes). */
function setLane(lanes: (Lane | null)[], i: number, lane: Lane): void {
  while (lanes.length < i) lanes.push(null);
  lanes[i] = lane;
}

function laneOf(lanes: (Lane | null)[], hash: string): number {
  return lanes.findIndex((l) => l !== null && l.hash === hash);
}

/** `start` and its first parents, as far as they are in `commits`. */
function firstParentChain(commits: readonly LayoutCommit[], start: string): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const chain = new Set<string>();
  for (let c = byHash.get(start); c && !chain.has(c.hash); c = c.parents[0] ? byHash.get(c.parents[0]) : undefined) chain.add(c.hash);
  return chain;
}

export function layoutGraph(commits: readonly LayoutCommit[], opts: { mainline?: string | null } = {}): GraphLayout {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  const mainline = opts.mainline ? firstParentChain(commits, opts.mainline) : new Set<string>();
  // Lane 0 and colour 0 belong to the mainline when there is one.
  const firstLane = mainline.size > 0 ? 1 : 0;
  let nextColour = firstLane;
  let width = 0;

  for (const commit of commits) {
    const edges: GraphEdge[] = [];
    const waiting: number[] = [];
    lanes.forEach((lane, i) => {
      if (!lane) return;
      if (lane.hash === commit.hash) waiting.push(i);
      else edges.push({ kind: "through", from: i, to: i, colour: lane.colour, dashed: lane.dashed });
    });

    const onMainline = mainline.has(commit.hash);
    const column = onMainline ? 0 : waiting.length > 0 ? waiting[0]! : freeLane(lanes, firstLane);
    const colour = onMainline ? 0 : waiting.length > 0 ? lanes[column]!.colour : nextColour++;
    for (const i of waiting) {
      const lane = lanes[i]!;
      edges.push({ kind: "in", from: i, to: column, colour: lane.colour, dashed: lane.dashed });
      lanes[i] = null;
    }

    const dashed = !!commit.dashed;
    const parents = [...new Set(commit.parents)];
    parents.forEach((parent, n) => {
      const existing = n === 0 ? -1 : laneOf(lanes, parent);
      if (existing >= 0) {
        // A merged parent whose line already exists: join it.
        edges.push({ kind: "out", from: column, to: existing, colour: lanes[existing]!.colour, dashed });
        return;
      }
      const target = n === 0 ? column : freeLane(lanes, column + 1);
      const lane = { hash: parent, colour: n === 0 ? colour : nextColour++, dashed };
      setLane(lanes, target, lane);
      edges.push({ kind: "out", from: column, to: target, colour: lane.colour, dashed });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    let rowWidth = column + 1;
    for (const e of edges) rowWidth = Math.max(rowWidth, e.from + 1, e.to + 1);
    width = Math.max(width, rowWidth);
    rows.push({ column, colour, edges, width: rowWidth });
  }
  return { rows, width };
}

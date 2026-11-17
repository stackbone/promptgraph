import { memo } from "react";
import type { GraphEdge, GraphRow } from "../../lib/git-graph/layout";

/** Geometry of the Git graph (DESIGN §13.7), shared by the list. */
export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 14;
const NODE_RADIUS = 4;
const STROKE = 1.75;

const x = (column: number) => column * LANE_WIDTH + LANE_WIDTH / 2;

/** One segment as an SVG path: straight within a lane, an S-curve between lanes over half a row. */
function edgePath(e: GraphEdge): string {
  const half = ROW_HEIGHT / 2;
  const [y1, y2] = e.kind === "through" ? [0, ROW_HEIGHT] : e.kind === "in" ? [0, half] : [half, ROW_HEIGHT];
  const x1 = x(e.from);
  const x2 = x(e.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

/**
 * The graph part of one row: the lines crossing it and the commit's node. HEAD is a ring, a merge a smaller dot, the
 * uncommitted changes a dashed ring.
 */
export const GraphCell = memo(function GraphCell({
  row,
  columns,
  colours,
  node,
}: {
  row: GraphRow;
  /** Columns drawn (the cell's width); lanes beyond are clipped. */
  columns: number;
  colours: readonly string[];
  node: "commit" | "merge" | "head" | "worktree";
}) {
  const colour = (i: number) => colours[i % colours.length]!;
  const cx = x(row.column);
  const cy = ROW_HEIGHT / 2;
  const fill = colour(row.colour);
  return (
    <svg aria-hidden="true" width={columns * LANE_WIDTH} height={ROW_HEIGHT} className="shrink-0 overflow-hidden">
      {row.edges.map((e, i) => (
        <path
          key={i}
          d={edgePath(e)}
          fill="none"
          stroke={colour(e.colour)}
          strokeWidth={STROKE}
          strokeDasharray={e.dashed ? "3 3" : undefined}
          strokeLinecap="round"
        />
      ))}
      {node === "head" || node === "worktree" ? (
        <circle
          cx={cx}
          cy={cy}
          r={NODE_RADIUS}
          fill="var(--popover)"
          stroke={fill}
          strokeWidth={2}
          strokeDasharray={node === "worktree" ? "2 2" : undefined}
        />
      ) : (
        <circle cx={cx} cy={cy} r={node === "merge" ? NODE_RADIUS - 1 : NODE_RADIUS} fill={fill} />
      )}
    </svg>
  );
});

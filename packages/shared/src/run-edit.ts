import { z } from "zod";
import { edgeWhen, nodeDisplayLabel, type Graph, type GraphEdge, type GraphNode } from "./graph.js";
import type { NodeRun } from "./run.js";
import { buildTopology, computeLanePlan, loopBody, type LanePlan, type PlannedLane } from "./topology.js";

/**
 * Live edits of an active run (DESIGN §8.7): what may still change in a graph whose run is active, pure so the
 * engine, the web editor and the MCP server agree on it.
 */

/**
 * Lock level of a node that already started (nodes absent from RunLocks are `open`: fully editable).
 * `config`: label, config and onError may change (the next attempt uses them); `frozen`: label and position only.
 */
export const RunLockLevelSchema = z.enum(["config", "frozen"]);
export type RunLockLevel = z.infer<typeof RunLockLevelSchema>;

/** Lock level per node id; nodes that never started are absent. */
export const RunLocksSchema = z.record(z.string(), RunLockLevelSchema);
export type RunLocks = z.infer<typeof RunLocksSchema>;

export const RUN_EDIT_PROBLEM_CODES = ["frozen_node", "frozen_edge", "loop_started", "graph_settings", "lane_conflict", "no_snapshot"] as const;
export const RunEditProblemSchema = z.object({
  code: z.enum(RUN_EDIT_PROBLEM_CODES),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
export type RunEditProblem = z.infer<typeof RunEditProblemSchema>;

/** ApiError code of a save refused because it changes steps of the active run that already started (details: RunEditProblem[]). */
export const RUN_EDIT_REFUSED_CODE = "run_edit_refused";
/** ApiError code of a save that arrived while the active run was in a transition (a node finishing); retry shortly. */
export const RUN_BUSY_CODE = "run_busy";

const NOT_STARTED: ReadonlySet<string> = new Set(["pending", "ready"]);

function hasStarted(nr: NodeRun): boolean {
  return nr.startedAt !== null || !NOT_STARTED.has(nr.status);
}

/** Latest (iteration, attempt) node run per node id. */
function currentRuns(nodeRuns: readonly NodeRun[]): Map<string, NodeRun> {
  const out = new Map<string, NodeRun>();
  for (const nr of nodeRuns) {
    const cur = out.get(nr.nodeId);
    if (!cur || nr.iteration > cur.iteration || (nr.iteration === cur.iteration && nr.attempt >= cur.attempt)) out.set(nr.nodeId, nr);
  }
  return out;
}

/** A failure that keeps the run paused until the user retries or skips the node (not routed downstream). */
function isBlockingFailure(nr: NodeRun): boolean {
  if (nr.status === "interrupted" || nr.status === "cancelled") return true;
  return nr.status === "failed" && !nr.output?.failureHandled && !nr.output?.loopExhausted;
}

/** Lock level of every node of the run that already started (§8.7). */
export function runEditLocks(nodeRuns: readonly NodeRun[]): RunLocks {
  const started = new Set(nodeRuns.filter(hasStarted).map((nr) => nr.nodeId));
  const locks: RunLocks = {};
  for (const [nodeId, cur] of currentRuns(nodeRuns)) {
    if (!started.has(nodeId)) continue;
    locks[nodeId] = !hasStarted(cur) || isBlockingFailure(cur) ? "config" : "frozen";
  }
  return locks;
}

/** Whether `edge` may be added or removed while the run is active (its target never started). */
export function isEdgeEditable(edge: Pick<GraphEdge, "target">, locks: RunLocks): boolean {
  return locks[edge.target] === undefined;
}

/** Stable JSON (sorted object keys), so equal values built in another key order compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Content of an edge, ignoring its id (save_graph may derive new ids for the same connection). */
function edgeKey(e: GraphEdge): string {
  return stable({ s: e.source, p: e.sourcePort, t: e.target, w: edgeWhen(e), l: e.loop ?? null });
}

export interface RunEditDiff {
  addedNodes: string[];
  removedNodes: string[];
  /** Nodes whose type, config or onError changed (not position or label only). */
  updatedNodes: string[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
}

/** What a live edit changes (positions and labels are ignored). Edges are compared by content, not id. */
export function diffRunGraph(before: Pick<Graph, "nodes" | "edges">, after: Pick<Graph, "nodes" | "edges">): RunEditDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n] as const));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n] as const));
  const content = (n: GraphNode) => stable({ ...n, position: null, label: null });
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  return {
    addedNodes: after.nodes.filter((n) => !beforeNodes.has(n.id)).map((n) => n.id),
    removedNodes: before.nodes.filter((n) => !afterNodes.has(n.id)).map((n) => n.id),
    updatedNodes: after.nodes.filter((n) => beforeNodes.has(n.id) && content(beforeNodes.get(n.id)!) !== content(n)).map((n) => n.id),
    addedEdges: after.edges.filter((e) => !beforeEdges.has(edgeKey(e))),
    removedEdges: before.edges.filter((e) => !afterEdges.has(edgeKey(e))),
  };
}

export function isEmptyRunEditDiff(d: RunEditDiff): boolean {
  return d.addedNodes.length + d.removedNodes.length + d.updatedNodes.length + d.addedEdges.length + d.removedEdges.length === 0;
}

/**
 * The problems that refuse a live edit from `before` (the run's snapshot) to `after` (§8.7), empty when it is
 * allowed. `nodeRuns`: every node run of the run (for the lock levels and the failed sources).
 */
export function checkRunEdit(before: Graph, after: Graph, nodeRuns: readonly NodeRun[]): RunEditProblem[] {
  const problems: RunEditProblem[] = [];
  const locks = runEditLocks(nodeRuns);
  const current = currentRuns(nodeRuns);
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n] as const));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n] as const));
  const label = (id: string) => {
    const n = afterNodes.get(id) ?? beforeNodes.get(id);
    return n ? nodeDisplayLabel(n) : id;
  };

  const { nodes: _bn, edges: _be, ...beforeRest } = before;
  const { nodes: _an, edges: _ae, ...afterRest } = after;
  if (stable(beforeRest) !== stable(afterRest)) {
    problems.push({ code: "graph_settings", message: "The graph's name, settings and linked issues cannot change while a run is active" });
  }

  for (const [id, node] of beforeNodes) {
    const lock = locks[id];
    if (!lock) continue;
    const next = afterNodes.get(id);
    if (!next) {
      problems.push({ code: "frozen_node", nodeId: id, message: `"${label(id)}" already started in this run: it cannot be removed` });
      continue;
    }
    if (next.type !== node.type) {
      problems.push({ code: "frozen_node", nodeId: id, message: `"${label(id)}" already started in this run: its type cannot change` });
    } else if (lock === "frozen" && stable({ ...node, position: null, label: null }) !== stable({ ...next, position: null, label: null })) {
      problems.push({ code: "frozen_node", nodeId: id, message: `"${label(id)}" already started in this run: only its label and position can change` });
    }
  }

  const diff = diffRunGraph(before, after);
  const changedEdges = [...diff.addedEdges.map((e) => ({ e, verb: "added" })), ...diff.removedEdges.map((e) => ({ e, verb: "removed" }))];
  for (const { e, verb } of changedEdges) {
    if (locks[e.target]) {
      problems.push({
        code: "frozen_edge",
        edgeId: e.id,
        nodeId: e.target,
        message: `"${label(e.target)}" already started in this run: an input of it cannot be ${verb}`,
      });
      continue;
    }
    const source = current.get(e.source);
    if (source?.status === "failed" && edgeWhen(e) !== "success") {
      problems.push({
        code: "frozen_edge",
        edgeId: e.id,
        nodeId: e.source,
        message: `"${label(e.source)}" already failed: its failure edges cannot change (retry or skip it first)`,
      });
    }
  }

  problems.push(...loopProblems(before, after, diff, locks, label));
  return problems;
}

/** Loops whose body already started cannot change structurally (§8.7). */
function loopProblems(before: Graph, after: Graph, diff: RunEditDiff, locks: RunLocks, label: (id: string) => string): RunEditProblem[] {
  const topoBefore = buildTopology(before);
  const topoAfter = buildTopology(after);
  const loops = new Map<string, { edge: GraphEdge; before: Set<string> | null; after: Set<string> | null }>();
  for (const e of topoBefore.loopEdges) loops.set(edgeKey(e), { edge: e, before: loopBody(topoBefore, e), after: null });
  for (const e of topoAfter.loopEdges) {
    const entry = loops.get(edgeKey(e));
    if (entry) entry.after = loopBody(topoAfter, e);
    else loops.set(edgeKey(e), { edge: e, before: null, after: loopBody(topoAfter, e) });
  }
  const problems: RunEditProblem[] = [];
  for (const { edge, before: b, after: a } of loops.values()) {
    const body = new Set([...(b ?? []), ...(a ?? [])]);
    if (![...body].some((id) => locks[id])) continue;
    const name = `the loop back to "${label(edge.target)}"`;
    const sameBody = b !== null && a !== null && b.size === a.size && [...b].every((id) => a.has(id));
    const innerChange = [...diff.addedEdges, ...diff.removedEdges].some((e) => !e.loop && body.has(e.source) && body.has(e.target));
    if (b === null || a === null) {
      problems.push({ code: "loop_started", edgeId: edge.id, message: `${name} already started: it cannot be ${b === null ? "added" : "removed"}` });
    } else if (!sameBody || innerChange) {
      problems.push({ code: "loop_started", edgeId: edge.id, message: `${name} already started: the steps inside it cannot be added, removed or reconnected` });
    }
  }
  return problems;
}

export interface RunLanePlanInput {
  graph: Graph;
  /** The plan the run used so far. */
  previous: LanePlan;
  nodeRuns: readonly NodeRun[];
  /** Ids of the lanes already created in the run. */
  createdLaneIds: Iterable<string>;
}

/**
 * The lane plan after a live edit (§8.7): close to `previous`, every node that started keeps its lane
 * (`lane_conflict` otherwise), and a new fork after a node that already finished starts from that node's end
 * snapshot (`no_snapshot` when it has none).
 */
export function planRunLanes(input: RunLanePlanInput): { plan: LanePlan; problems: RunEditProblem[] } {
  const { graph, previous, nodeRuns } = input;
  const locks = runEditLocks(nodeRuns);
  const current = currentRuns(nodeRuns);
  const pinned = new Map<string, string>();
  for (const [nodeId, nr] of current) if (locks[nodeId] && nr.laneId) pinned.set(nodeId, nr.laneId);
  const prefer = new Map(previous.laneOf);
  for (const [nodeId, laneId] of pinned) prefer.set(nodeId, laneId);
  const plan = computeLanePlan(graph, { previous, prefer, reserved: input.createdLaneIds });

  const problems: RunEditProblem[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const label = (id: string) => (nodes.has(id) ? nodeDisplayLabel(nodes.get(id)!) : id);
  for (const [nodeId, laneId] of pinned) {
    if (!nodes.has(nodeId) || plan.laneOf.get(nodeId) === laneId) continue;
    problems.push({
      code: "lane_conflict",
      nodeId,
      message: `"${label(nodeId)}" already started in its workspace and this change would move it to another one; connect the new steps elsewhere`,
    });
  }

  const previousIds = new Set(previous.lanes.map((l) => l.id));
  plan.lanes = plan.lanes.map((lane): PlannedLane => {
    if (previousIds.has(lane.id) || !lane.forkAfterNodeId) return lane;
    const after = current.get(lane.forkAfterNodeId);
    // Still to finish (or never ran): the fork is created when it does, from the parent lane (§9.3).
    if (!after || !["succeeded", "failed", "skipped"].includes(after.status)) return lane;
    // A dead path never grants its lanes.
    if (after.status === "skipped" && !after.output?.skippedByUser) return lane;
    if (!after.snapshotEnd) {
      problems.push({
        code: "no_snapshot",
        nodeId: lane.forkAfterNodeId,
        message: `"${label(lane.forkAfterNodeId)}" has no snapshot of its workspace, so a parallel branch cannot start after it; connect the new step after another one`,
      });
      return lane;
    }
    return { ...lane, fromSnapshot: after.snapshotEnd };
  });
  return { plan, problems };
}

// --- Persistence of a plan (runs.lane_plan) ----------------------------------

const PlannedLaneSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  parentLaneId: z.string().nullable(),
  forkAfterNodeId: z.string().nullable(),
  firstNodeId: z.string(),
  fromSnapshot: z.string().optional(),
});

export const LanePlanJsonSchema = z.object({
  lanes: z.array(PlannedLaneSchema),
  laneOf: z.record(z.string(), z.string()),
  mergeSources: z.record(z.string(), z.array(z.string())),
  edgeLane: z.record(z.string(), z.string()),
});
export type LanePlanJson = z.infer<typeof LanePlanJsonSchema>;

export function lanePlanToJson(plan: LanePlan): LanePlanJson {
  return {
    lanes: plan.lanes.map((l) => ({ ...l })),
    laneOf: Object.fromEntries(plan.laneOf),
    mergeSources: Object.fromEntries(plan.mergeSources),
    edgeLane: Object.fromEntries(plan.edgeLane),
  };
}

export function lanePlanFromJson(json: LanePlanJson): LanePlan {
  return {
    lanes: json.lanes.map((l) => ({ ...l })),
    laneOf: new Map(Object.entries(json.laneOf)),
    mergeSources: new Map(Object.entries(json.mergeSources)),
    edgeLane: new Map(Object.entries(json.edgeLane)),
  };
}

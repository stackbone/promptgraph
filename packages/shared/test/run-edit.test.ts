import { describe, expect, it } from "vitest";
import {
  applyGraphPatch,
  checkRunEdit,
  computeLanePlan,
  diffRunGraph,
  GraphSchema,
  lanePlanFromJson,
  lanePlanToJson,
  planRunLanes,
  runEditLocks,
  type Graph,
  type GraphInput,
  type NodeRun,
  type NodeStatus,
} from "../src/index.js";

/** Live edits of an active run (DESIGN §8.7). */

type N = { id: string; type?: string; x?: number; y?: number; config?: Record<string, unknown> };
type E = { id?: string; source: string; target: string; sourcePort?: string; when?: string; loop?: { maxIterations: number } };

const CONFIG: Record<string, Record<string, unknown>> = { prompt: { prompt: "do it" }, shell: { run: "true" }, merge: {} };

function g(nodes: N[], edges: E[]): Graph {
  return GraphSchema.parse({
    version: 1,
    id: "flow",
    name: "Flow",
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type ?? "prompt",
      label: n.id,
      position: { x: n.x ?? 0, y: n.y ?? i * 100 },
      config: n.config ?? CONFIG[n.type ?? "prompt"] ?? {},
    })),
    edges: edges.map((e) => ({ id: e.id ?? `${e.source}-${e.target}`, ...e })),
  } as GraphInput);
}

let seq = 0;
function nr(nodeId: string, status: NodeStatus, extra: Partial<NodeRun> = {}): NodeRun {
  const started = status !== "pending" && status !== "ready" && status !== "skipped";
  return {
    id: `nr${++seq}`,
    runId: "r",
    nodeId,
    iteration: 0,
    attempt: 0,
    laneId: "main",
    status,
    sessionId: null,
    transcriptPath: null,
    ptyId: null,
    activity: null,
    waitingReason: null,
    hold: false,
    laneSetup: null,
    graceUntil: null,
    snapshotStart: started ? `start-${nodeId}` : null,
    snapshotEnd: started && status !== "running" ? `end-${nodeId}` : null,
    output: null,
    error: null,
    startedAt: started ? 1 : null,
    finishedAt: null,
    updatedAt: 1,
    ...extra,
  };
}

const codes = (list: { code: string; nodeId?: string }[]) => list.map((p) => `${p.code}:${p.nodeId ?? ""}`);

/** a → b → c */
const CHAIN = g([{ id: "a" }, { id: "b" }, { id: "c" }], [{ source: "a", target: "b" }, { source: "b", target: "c" }]);

describe("runEditLocks", () => {
  it("leaves never-started nodes open and locks the rest by level", () => {
    const locks = runEditLocks([
      nr("a", "succeeded"),
      nr("b", "running"),
      nr("c", "pending"),
      nr("d", "ready"),
      nr("e", "failed"),
      nr("f", "failed", { output: { failureHandled: true } }),
      nr("g", "skipped"),
      nr("h", "interrupted"),
    ]);
    expect(locks).toEqual({ a: "frozen", b: "frozen", e: "config", f: "frozen", g: "frozen", h: "config" });
  });

  it("gives a pending retry attempt or a new loop iteration the config level", () => {
    const locks = runEditLocks([
      nr("a", "failed"),
      nr("a", "pending", { attempt: 1 }),
      nr("b", "succeeded"),
      nr("b", "pending", { iteration: 1 }),
    ]);
    expect(locks).toEqual({ a: "config", b: "config" });
  });
});

describe("checkRunEdit", () => {
  const runs = [nr("a", "succeeded"), nr("b", "running"), nr("c", "pending")];

  it("allows inserting a step after a finished one and editing pending steps", () => {
    const { graph } = applyGraphPatch(CHAIN, [
      { op: "insert_after", after: "a", node: { id: "x", type: "shell", label: "x", config: { run: "echo" } } },
      { op: "update_node", id: "c", config: { prompt: "new" } },
    ]);
    // insert_after rewires a → b into a → x → b: both touch an input of b, which started. A plain extra branch is fine.
    expect(codes(checkRunEdit(CHAIN, graph, runs))).toEqual(["frozen_edge:b", "frozen_edge:b"]);
    const branch = applyGraphPatch(CHAIN, [
      { op: "add_node", node: { id: "x", type: "shell", label: "x", config: { run: "echo" } } },
      { op: "connect", source: "a", target: "x" },
      { op: "update_node", id: "c", config: { prompt: "new" } },
    ]).graph;
    expect(checkRunEdit(CHAIN, branch, runs)).toEqual([]);
  });

  it("allows adding a step after the running one and before a pending one", () => {
    const { graph } = applyGraphPatch(CHAIN, [{ op: "insert_before", before: "c", node: { id: "x", type: "shell", label: "x", config: { run: "echo" } } }]);
    expect(checkRunEdit(CHAIN, graph, runs)).toEqual([]);
  });

  it("refuses removing or reconfiguring a started step, but allows renaming and moving it", () => {
    const removed = applyGraphPatch(CHAIN, [{ op: "remove_node", id: "b" }]).graph;
    expect(codes(checkRunEdit(CHAIN, removed, runs))).toContain("frozen_node:b");
    const reconfigured = applyGraphPatch(CHAIN, [{ op: "update_node", id: "a", config: { prompt: "other" } }]).graph;
    expect(codes(checkRunEdit(CHAIN, reconfigured, runs))).toEqual(["frozen_node:a"]);
    const renamed = applyGraphPatch(CHAIN, [{ op: "update_node", id: "a", label: "Renamed", position: { x: 500, y: 9 } }]).graph;
    expect(checkRunEdit(CHAIN, renamed, runs)).toEqual([]);
  });

  it("lets a failed step's config change for its retry, not its failure edges", () => {
    const failed = [nr("a", "succeeded"), nr("b", "failed"), nr("c", "pending")];
    const config = applyGraphPatch(CHAIN, [{ op: "update_node", id: "b", config: { prompt: "fixed" } }]).graph;
    expect(checkRunEdit(CHAIN, config, failed)).toEqual([]);
    const handler = applyGraphPatch(CHAIN, [
      { op: "add_node", node: { id: "fix", type: "shell", label: "fix", config: { run: "echo" } } },
      { op: "connect", source: "b", target: "fix", when: "failure" },
    ]).graph;
    expect(codes(checkRunEdit(CHAIN, handler, failed))).toEqual(["frozen_edge:b"]);
  });

  it("refuses graph-level changes", () => {
    expect(codes(checkRunEdit(CHAIN, { ...CHAIN, name: "Other" }, runs))).toEqual(["graph_settings:"]);
  });

  it("refuses structural changes inside a loop whose body started", () => {
    const loop = g(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ source: "a", target: "b" }, { source: "b", target: "c" }, { id: "back", source: "c", target: "a", loop: { maxIterations: 3 } }],
    );
    const started = [nr("a", "running"), nr("b", "pending"), nr("c", "pending")];
    const inserted = applyGraphPatch(loop, [{ op: "insert_before", before: "c", node: { id: "x", type: "shell", label: "x", config: { run: "echo" } } }]).graph;
    expect(codes(checkRunEdit(loop, inserted, started))).toEqual(["loop_started:"]);
    // Before the loop starts, its body is open.
    expect(checkRunEdit(loop, inserted, [nr("a", "pending"), nr("b", "pending"), nr("c", "pending")])).toEqual([]);
  });

  it("diffRunGraph ignores positions and edge ids", () => {
    const moved = { ...CHAIN, nodes: CHAIN.nodes.map((n) => ({ ...n, position: { x: 1, y: 2 } })), edges: CHAIN.edges.map((e) => ({ ...e, id: `new-${e.id}` })) };
    const d = diffRunGraph(CHAIN, moved);
    expect(d).toEqual({ addedNodes: [], removedNodes: [], updatedNodes: [], addedEdges: [], removedEdges: [] });
  });
});

describe("planRunLanes", () => {
  it("keeps the lane of started nodes when a new branch is placed first on the canvas", () => {
    const before = g([{ id: "a" }, { id: "b", x: 100 }], [{ source: "a", target: "b" }]);
    const previous = computeLanePlan(before);
    const after = applyGraphPatch(before, [
      { op: "add_node", node: { id: "x", type: "shell", label: "x", config: { run: "echo" }, position: { x: -300, y: 100 } } },
      { op: "connect", source: "a", target: "x" },
    ]).graph;
    const { plan, problems } = planRunLanes({ graph: after, previous, nodeRuns: [nr("a", "succeeded"), nr("b", "running")], createdLaneIds: ["main"] });
    expect(problems).toEqual([]);
    expect(plan.laneOf.get("b")).toBe("main");
    const fork = plan.lanes.find((l) => l.id === plan.laneOf.get("x"))!;
    // A fork after a node that already finished starts from its end snapshot.
    expect(fork).toMatchObject({ id: "l2", parentLaneId: "main", forkAfterNodeId: "a", fromSnapshot: "end-a" });
  });

  it("gives a new fork a fresh id that no earlier lane used", () => {
    const before = g([{ id: "a" }, { id: "b" }, { id: "c", x: 100 }], [{ source: "a", target: "b" }, { source: "a", target: "c" }]);
    const previous = computeLanePlan(before);
    expect(previous.laneOf.get("c")).toBe("l2");
    const after = applyGraphPatch(before, [
      { op: "remove_node", id: "c" },
      { op: "add_node", node: { id: "d", type: "shell", label: "d", config: { run: "echo" }, position: { x: 200, y: 100 } } },
      { op: "connect", source: "a", target: "d" },
    ]).graph;
    const { plan } = planRunLanes({ graph: after, previous, nodeRuns: [nr("a", "running")], createdLaneIds: ["main", "l2"] });
    // l2 belonged to the removed c and may already exist: d gets a new lane.
    expect(plan.laneOf.get("d")).toBe("l3");
    expect(plan.lanes.find((l) => l.id === "l3")?.index).toBe(2);
  });

  it("reports a started node the edit would move to another lane", () => {
    const before = g([{ id: "a" }, { id: "b" }, { id: "c", x: 100 }], [{ source: "a", target: "b" }, { source: "a", target: "c" }]);
    const previous = computeLanePlan(before);
    // c ran in l2; the plan from scratch of a graph where c is a's only successor would put c in main.
    const after = applyGraphPatch(before, [{ op: "disconnect", source: "a", target: "b" }]).graph;
    const { problems } = planRunLanes({ graph: after, previous, nodeRuns: [nr("a", "succeeded"), nr("b", "pending"), nr("c", "running", { laneId: "l2" })], createdLaneIds: ["main", "l2"] });
    expect(codes(problems)).toEqual(["lane_conflict:c"]);
  });

  it("asks for a snapshot to fork after a user-skipped node", () => {
    const before = g([{ id: "a" }, { id: "b" }], [{ source: "a", target: "b" }]);
    const after = applyGraphPatch(before, [
      { op: "add_node", node: { id: "x", type: "shell", label: "x", config: { run: "echo" }, position: { x: 300, y: 100 } } },
      { op: "connect", source: "a", target: "x" },
    ]).graph;
    const runs = [nr("a", "skipped", { output: { skippedByUser: true } }), nr("b", "running")];
    expect(codes(planRunLanes({ graph: after, previous: computeLanePlan(before), nodeRuns: runs, createdLaneIds: ["main"] }).problems)).toEqual(["no_snapshot:a"]);
  });

  it("round-trips a plan through JSON", () => {
    const plan = computeLanePlan(g([{ id: "a" }, { id: "b" }, { id: "c", x: 100 }], [{ source: "a", target: "b" }, { source: "a", target: "c" }]));
    expect(lanePlanFromJson(JSON.parse(JSON.stringify(lanePlanToJson(plan))))).toEqual(plan);
  });
});

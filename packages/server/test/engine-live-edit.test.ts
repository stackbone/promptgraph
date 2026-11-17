import { applyGraphPatch, type Graph, type GraphPatchOp } from "@promptgraph/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "../src/engine/engine.js";
import { runWorkspaceSetup } from "../src/workspace/setup.js";
import { waitFor } from "./helpers.js";
import { allTypes, FakeRunner, makeGraph, runStatus, setup, statusOf, waitRun, type Setup } from "./support/engine-fakes.js";

vi.mock("../src/workspace/setup.js", () => ({ runWorkspaceSetup: vi.fn() }));

afterEach(() => {
  vi.mocked(runWorkspaceSetup).mockReset();
});

/** Live edits of an active run (DESIGN §8.7): saving the graph file applies to the run. */

/** Saves the graph on disk patched with `ops` (what the editor's autosave and patch_graph do). */
function edit(s: Setup, ops: GraphPatchOp[]): Graph {
  const next = applyGraphPatch(s.graphs.get("flow").graph, ops).graph;
  s.graphs.save(next);
  return next;
}

const shell = (id: string, run = `echo ${id}`) => ({ id, type: "shell" as const, label: id.toUpperCase(), config: { run } });

describe("live edits of an active run (§8.7)", () => {
  it("runs a step inserted before a pending one and uses edited config", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [["a", "b"], ["b", "c"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);

    edit(s, [
      { op: "insert_before", before: "c", node: shell("x") },
      { op: "update_node", id: "b", config: { prompt: "edited while a ran" } },
    ]);
    expect(s.store.getRunSummary(run.id)!.graphRev).toBe(1);
    expect(s.engine.getRun(run.id).run.graphSnapshot.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "x"]);
    expect(statusOf(s, run.id)).toMatchObject({ x: "pending" });

    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b") !== undefined);
    expect(runner.last("b")!.ctx.node.config).toMatchObject({ prompt: "edited while a ran" });
    runner.last("b")!.succeed();
    await waitFor(() => runner.last("x") !== undefined);
    expect(runner.last("x")!.ctx.predecessors.map((p) => p.nodeId)).toEqual(["b"]);
    runner.last("x")!.succeed();
    await waitFor(() => runner.last("c") !== undefined);
    runner.last("c")!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => e.ctx.node.id)).toEqual(["a", "b", "x", "c"]);
    const edited = s.store.listEvents(run.id).filter((e) => e.type === "run.edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]!.payload).toMatchObject({ rev: 1, added: ["x"], updated: ["b"] });
  });

  it("starts a step added after a finished one at once, in a fork lane from its end snapshot", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b") !== undefined);
    const a = s.store.listNodeRuns(run.id).find((nr) => nr.nodeId === "a")!;

    // Without an end snapshot there is no state to fork from (FakeLanes takes none).
    expect(() => edit(s, [{ op: "add_node", node: { ...shell("x"), position: { x: 0, y: 300 } } }, { op: "connect", source: "a", target: "x" }])).toThrow(
      expect.objectContaining({ code: "run_edit_refused", details: [expect.objectContaining({ code: "no_snapshot", nodeId: "a" })] }),
    );
    expect(s.graphs.get("flow").graph.nodes).toHaveLength(2);

    s.store.updateNodeRun(a.id, { snapshotEnd: "snap-a" });
    edit(s, [{ op: "add_node", node: { ...shell("x"), position: { x: 0, y: 300 } } }, { op: "connect", source: "a", target: "x" }]);
    await waitFor(() => runner.last("x") !== undefined);
    expect(s.lanes.calls).toContain("snapshot-fork:l2:snap-a:A");
    expect(runner.last("x")!.ctx.lane.id).toBe("l2");
    expect(runner.last("b")!.ctx.lane.id).toBe("main");
    runner.last("x")!.succeed();
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("refuses edits of started steps and leaves the file and the run unchanged", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    const hash = s.graphs.get("flow").hash;

    const err = (() => {
      try {
        edit(s, [{ op: "remove_node", id: "a" }]);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: "run_edit_refused", details: [expect.objectContaining({ code: "frozen_node", nodeId: "a" })] });
    expect(s.graphs.get("flow").hash).toBe(hash);
    expect(s.store.getRunSummary(run.id)!.graphRev).toBe(0);

    // A new step with an invalid config is refused until it is valid.
    expect(() => edit(s, [{ op: "insert_after", after: "b", node: { id: "x", type: "prompt", label: "X", config: { prompt: "" } } }])).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    // Moving and renaming a started step is fine, and writes no run.edited event.
    edit(s, [{ op: "update_node", id: "a", label: "Renamed", position: { x: 40, y: 40 } }]);
    expect(s.store.getRunSummary(run.id)!.graphRev).toBe(1);
    expect(s.store.listEvents(run.id).some((e) => e.type === "run.edited")).toBe(false);
    expect(() => s.graphs.delete("flow")).toThrow(expect.objectContaining({ code: "run_active" }));

    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b") !== undefined);
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("drops a removed pending step and finishes without it", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c" }], [["a", "b"], ["b", "c"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    edit(s, [{ op: "remove_node", id: "c" }]);
    expect(s.store.listNodeRuns(run.id).map((nr) => nr.nodeId).sort()).toEqual(["a", "b"]);
    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b") !== undefined);
    runner.last("b")!.succeed();
    await waitRun(s, run.id, "succeeded");
    expect(runner.started.map((e) => e.ctx.node.id)).toEqual(["a", "b"]);
  });

  it("lets a failed step's config change before Retry, and keeps new steps waiting while the run is paused", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    runner.last("a")!.failWith();
    await waitRun(s, run.id, "paused");

    edit(s, [
      { op: "update_node", id: "a", config: { prompt: "try again differently" } },
      { op: "insert_after", after: "b", node: shell("x") },
    ]);
    expect(runStatus(s, run.id)).toBe("paused");
    const failed = s.store.listNodeRuns(run.id).find((nr) => nr.nodeId === "a")!;
    await s.engine.retry(failed.id);
    await waitFor(() => runner.byNode("a").length === 2);
    expect(runner.last("a")!.ctx.node.config).toMatchObject({ prompt: "try again differently" });
    runner.last("a")!.succeed();
    await waitFor(() => runner.last("b") !== undefined);
    runner.last("b")!.succeed();
    await waitFor(() => runner.last("x") !== undefined);
    runner.last("x")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });

  it("keeps the edited lane plan and graph across a restart", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }], [["a", "b"]]));
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    edit(s, [{ op: "insert_after", after: "b", node: shell("x") }]);
    expect(s.store.getLanePlan(run.id)?.laneOf).toEqual({ a: "main", b: "main", x: "main" });

    await s.engine.shutdown();
    expect(runStatus(s, run.id)).toBe("paused");
    const restarted = new FakeRunner();
    const engine = s.makeEngine(allTypes(restarted));
    const interrupted = s.store.listNodeRuns(run.id).find((nr) => nr.nodeId === "a")!;
    await engine.retry(interrupted.id);
    await waitRun(s, run.id, "succeeded");
    expect(restarted.started.map((e) => e.ctx.node.id)).toEqual(["a", "b", "x"]);
  });

  it("waits for a node that is finishing before applying a save (whenEditable)", async () => {
    const runner = new FakeRunner(() => {});
    const s = setup(allTypes(runner));
    s.graphs.save(makeGraph([{ id: "a" }, { id: "b" }, { id: "c", x: 100, y: 200 }], [["a", "b"], ["a", "c"]]));
    let open!: () => void;
    s.lanes.gate = { laneIds: ["l2"], until: new Promise<void>((r) => (open = r)) };
    const { run } = await s.engine.startRun("flow");
    await waitFor(() => runner.started.length === 1);
    runner.last("a")!.succeed();
    // a's fork lane is being created: a save now would race the transition.
    await waitFor(() => s.lanes.calls.length > 0 && statusOf(s, run.id).a === "succeeded");
    expect(() => edit(s, [{ op: "insert_after", after: "b", node: shell("y") }])).toThrow(expect.objectContaining({ code: "run_busy" }));
    const waited = s.engine.whenEditable("flow");
    open();
    await waited;
    edit(s, [{ op: "insert_after", after: "b", node: shell("y") }]);
    await waitFor(() => runner.last("b") !== undefined && runner.last("c") !== undefined);
    runner.last("b")!.succeed();
    runner.last("c")!.succeed();
    await waitFor(() => runner.last("y") !== undefined);
    runner.last("y")!.succeed();
    await waitRun(s, run.id, "succeeded");
  });
});

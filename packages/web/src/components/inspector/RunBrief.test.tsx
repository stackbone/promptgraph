// @vitest-environment jsdom
import type { RunBriefEntry } from "@promptgraph/shared";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, runDetailOf } from "../../test-fixtures";
import { createTestView, type TestView } from "../../store/view/test-view";
import { Inspector } from "./Inspector";

function entryOf(patch: Partial<RunBriefEntry> & Pick<RunBriefEntry, "id">): RunBriefEntry {
  return {
    runId: "r1",
    kind: "node",
    nodeRunId: `nr-${patch.id}`,
    nodeId: "a",
    outcome: "succeeded",
    status: "ready",
    title: null,
    summary: null,
    error: null,
    usage: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  };
}

function briefGraph(enabled: boolean) {
  const graph = linearGraph();
  return { ...graph, settings: { ...graph.settings, brief: { enabled } } };
}

describe("run brief in the inspector (§13.6)", () => {
  let view: TestView;
  beforeEach(() => {
    view = createTestView({ runDeps: { subscribe: vi.fn(() => () => undefined), fetchRun: vi.fn() } });
  });
  afterEach(cleanup);

  it("shows the timeline live and selects a step's node from its name", async () => {
    const user = userEvent.setup();
    view.run.getState().showRun({ ...runDetailOf(briefGraph(true), []), brief: [entryOf({ id: 1, title: "Implemented the parser", summary: "Added **parse()**." })] });
    view.render(<Inspector />);

    expect(screen.getByText("Implemented the parser")).toBeTruthy();
    expect(screen.getByText("parse()")).toBeTruthy();

    // brief:update: a new pending entry, then the same entry failed; stale updates are ignored.
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "pending", updatedAt: 2000 }));
    expect(await screen.findByText("Summarising…")).toBeTruthy();
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "failed", error: "timed out", updatedAt: 3000 }));
    view.run.getState().applyBriefUpdate(entryOf({ id: 2, nodeId: "b", status: "pending", updatedAt: 2500 }));
    expect(await screen.findByText("No summary: timed out")).toBeTruthy();
    expect(screen.queryByText("Summarising…")).toBeNull();
    // Another run's entry is not shown.
    view.run.getState().applyBriefUpdate(entryOf({ id: 3, runId: "other", title: "Elsewhere" }));
    expect(screen.queryByText("Elsewhere")).toBeNull();
    expect(screen.getAllByTestId("brief-entry")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(view.run.getState().selectedNodeId).toBe("b");
  });

  it("labels the closing entry with the run's result", () => {
    view.run.getState().showRun({
      ...runDetailOf(briefGraph(true), []),
      brief: [entryOf({ id: 1, kind: "run", nodeRunId: null, nodeId: null, outcome: "succeeded", title: "All done" })],
    });
    view.render(<Inspector />);
    expect(screen.getByText("Run succeeded")).toBeTruthy();
    expect(screen.getByText("All done")).toBeTruthy();
  });

  it("shows the newest status above the timeline, apart from it, and says when it is being rewritten", async () => {
    const status = (patch: Partial<RunBriefEntry> & Pick<RunBriefEntry, "id">) =>
      entryOf({ kind: "status", nodeRunId: null, nodeId: null, outcome: "running", ...patch });
    view.run.getState().showRun({
      ...runDetailOf(briefGraph(true), []),
      brief: [
        entryOf({ id: 1, title: "Implemented the parser" }),
        status({ id: 2, title: "1 of 2 steps done, all fine", summary: "- Left: **Test**" }),
      ],
    });
    view.render(<Inspector />);
    expect(screen.getByTestId("brief-status").textContent).toContain("1 of 2 steps done, all fine");
    expect(screen.getByText("Left:", { exact: false })).toBeTruthy();
    // Status entries are not part of the timeline.
    expect(screen.getAllByTestId("brief-entry")).toHaveLength(1);
    // Order: the status, then the usage, then the timeline.
    const [statusBox, cost, timelineEntry] = [screen.getByTestId("brief-status"), screen.getByTestId("usage-cost"), screen.getAllByTestId("brief-entry")[0]!];
    expect(statusBox.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cost.compareDocumentPosition(timelineEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A newer one being written keeps the current text and says it is updating; then replaces it.
    view.run.getState().applyBriefUpdate(status({ id: 3, status: "pending" }));
    expect(await screen.findByText("Updating…")).toBeTruthy();
    expect(screen.getByTestId("brief-status").textContent).toContain("1 of 2 steps done, all fine");
    view.run.getState().applyBriefUpdate(status({ id: 3, title: "Test failed", updatedAt: 2000 }));
    expect(await screen.findByText("Test failed")).toBeTruthy();
    expect(screen.queryByText("1 of 2 steps done, all fine")).toBeNull();
    expect(screen.queryByText("Updating…")).toBeNull();
  });

  it("tells how to turn it on when the graph has it off", () => {
    view.run.getState().showRun(runDetailOf(briefGraph(false), []));
    view.render(<Inspector />);
    expect(screen.getByText(/in the graph settings to get a short summary/)).toBeTruthy();
  });
});

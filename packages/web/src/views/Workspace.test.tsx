// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linearGraph } from "../test-fixtures";
import { createTestView, TEST_REPO_ID, type TestView } from "../store/view/test-view";
import { Workspace } from "./Workspace";

const graph = linearGraph();
let view: TestView;

function renderWorkspace() {
  return view.render(<Workspace route={{ kind: "graph", repoId: TEST_REPO_ID, graphId: "g1" }} />);
}

beforeEach(() => {
  localStorage.clear();
  view = createTestView({ graphId: "g1", graphs: [{ id: "g1", name: "Graph 1", loadError: null, updatedAt: 1, hash: "h0" }] });
  view.editor.setState({ graph, graphHash: "h0", loading: false });
});
afterEach(cleanup);

describe("workspace layout", () => {
  it("has no left sidebar: the canvas toolbar holds the nodes, the run menu and the run controls, in that order", async () => {
    const { container } = renderWorkspace();
    await screen.findByText("Implement");

    expect(container.querySelector('[data-slot="sidebar"][data-side="left"]')).toBeNull();
    expect(screen.queryByRole("region", { name: "Nodes" })).toBeNull();
    const toolbar = screen.getByRole("toolbar", { name: "Graph toolbar" });
    const order = ["Nodes", "Editor", "Undo", "Redo", "Arrange", "Run"].map((name) => within(toolbar).getByRole("button", { name: new RegExp(`^${name}`) }));
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Icon-only buttons except the run menu and Run.
    expect(within(toolbar).getByRole("button", { name: "Nodes" }).textContent).toBe("");
    expect(within(toolbar).getByRole("button", { name: "Arrange" }).textContent).toBe("");
  });

  it("shows the problems as a badge above the toolbar and lists them in a popover", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText("Implement");
    const toolbar = screen.getByRole("toolbar", { name: "Graph toolbar" });
    const nodeId = view.editor.getState().graph!.nodes[0]!.id;
    act(() => {
      view.editor.setState({ validation: { errors: [{ code: "x", message: "Broken", nodeId }], warnings: [] } as never });
    });
    // Outside the toolbar, so it never changes the toolbar's size.
    expect(within(toolbar).queryByRole("button", { name: "1 error" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "1 error" }));
    const popover = await screen.findByRole("dialog", { name: "Problems" });
    expect(popover.getAttribute("data-side")).toBe("top");
    expect(popover.getAttribute("data-align")).toBe("center");
    await user.click(within(popover).getByRole("button", { name: "Broken" }));
    expect(view.editor.getState().selectedNodeIds).toEqual([nodeId]);
    expect(screen.queryByRole("dialog", { name: "Problems" })).toBeNull();
  });

  it("shows no problem for an empty graph: Run is disabled with a hint instead", async () => {
    view.editor.setState({ graph: { ...graph, nodes: [], edges: [] } });
    act(() => view.editor.getState().rename("Empty"));
    renderWorkspace();
    const toolbar = screen.getByRole("toolbar", { name: "Graph toolbar" });
    expect(view.editor.getState().validation.errors).toEqual([]);
    expect(within(toolbar).queryByRole("button", { name: /error/ })).toBeNull();
    const run = within(toolbar).getByRole("button", { name: /^Run/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe("Add nodes first");
  });

  it("opens the node palette above the toolbar; a click appends a node and closes it", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText("Implement");
    const before = view.editor.getState().graph!.nodes.length;

    await user.click(screen.getByRole("button", { name: "Nodes" }));
    const menu = await screen.findByRole("dialog", { name: "Nodes" });
    expect(menu.getAttribute("data-side")).toBe("top");
    await user.click(within(menu).getByRole("button", { name: /^Prompt/ }));

    expect(view.editor.getState().graph!.nodes).toHaveLength(before + 1);
    expect(screen.queryByRole("dialog", { name: "Nodes" })).toBeNull();
  });

  it("hides the node palette while a node type is dragged out of it and closes it once dropped", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByText("Implement");
    await user.click(screen.getByRole("button", { name: "Nodes" }));
    const menu = await screen.findByRole("dialog", { name: "Nodes" });
    const prompt = within(menu).getByRole("button", { name: /^Prompt/ });

    fireEvent.dragStart(prompt, { dataTransfer: { setData() {}, effectAllowed: "" } });
    await waitFor(() => expect(menu.className).toContain("opacity-0"));
    expect(menu.isConnected).toBe(true);
    fireEvent.dragEnd(prompt);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nodes" })).toBeNull());
  });

  it("docks the inspector beside the canvas, always shown, with a resize handle and no collapse", async () => {
    renderWorkspace();
    await screen.findByText("Implement");
    const inspector = screen.getByRole("region", { name: "Inspector" });
    expect(within(inspector).getByText("Graph settings")).toBeTruthy();
    expect(within(inspector).getByRole("separator", { name: "Resize inspector" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /(Collapse|Expand) inspector/ })).toBeNull();
  });

  it("disables the Nodes button while a run is shown: nothing can be added to a run", () => {
    view.run.setState({ selectedRunId: "r1" });
    renderWorkspace();
    expect((screen.getByRole("button", { name: "Nodes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

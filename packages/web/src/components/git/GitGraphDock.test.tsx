// @vitest-environment jsdom
import type { GitLogCommit, GitLogResponse } from "@promptgraph/shared";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitGitGraphShortcut } from "../../lib/chat-shortcut";
import { createTestView } from "../../store/view/test-view";
import { GitGraphDock } from "./GitGraphDock";

const commit = (hash: string, over: Partial<GitLogCommit> = {}): GitLogCommit => ({
  hash: hash.repeat(40),
  parents: [],
  subject: `commit ${hash}`,
  authorName: "Ann",
  authorEmail: "ann@example.com",
  authorDate: "2026-01-02T10:00:00Z",
  committerDate: "2026-01-02T10:00:00Z",
  source: "main",
  refs: [],
  ...over,
});

function logOf(over: Partial<GitLogResponse> = {}): GitLogResponse {
  return {
    head: { ref: "refs/heads/main", hash: "a".repeat(40), upstream: { name: "origin/main", ahead: 2, behind: 1, gone: false } },
    commits: [
      commit("a", { parents: ["b".repeat(40), "c".repeat(40)], subject: "Merge feature", committerDate: "2026-01-03T10:00:00Z", refs: [{ kind: "branch", ref: "refs/heads/main", name: "main" }] }),
      commit("c", { parents: ["b".repeat(40)], subject: "Feature work", source: "feature", committerDate: "2026-01-02T12:00:00Z", refs: [{ kind: "tag", ref: "refs/tags/v1", name: "v1" }] }),
      commit("b", { subject: "Initial commit", committerDate: "2026-01-01T10:00:00Z" }),
    ],
    hasMore: false,
    status: { added: 0, modified: 0, deleted: 0 },
    signature: "sig-1",
    ...over,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function setup(
  gitLog: (limit?: number) => Promise<GitLogResponse> = vi.fn(async () => logOf()),
  gitState = vi.fn(async () => ({ head: logOf().head, status: logOf().status, signature: "sig-1" })),
) {
  const view = createTestView({ api: { gitLog, gitState } });
  view.render(<GitGraphDock />);
  return { gitLog, gitState };
}

const toggle = () => screen.getByRole("button", { name: "Git graph" });

describe("GitGraphDock (DESIGN §13.7)", () => {
  it("is closed by default and opens the panel with the repository's history", async () => {
    const { gitLog } = setup();
    expect(screen.queryByRole("region", { name: "Git graph" })).toBeNull();
    expect(gitLog).not.toHaveBeenCalled();

    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    expect(await within(panel).findByText("Merge feature")).toBeTruthy();
    expect(within(panel).getByText("Feature work")).toBeTruthy();
    expect(within(panel).getByText("Initial commit")).toBeTruthy();
    expect(within(panel).getAllByText("main").length).toBeGreaterThan(0);
    expect(within(panel).getByText("v1")).toBeTruthy();
    expect(gitLog).toHaveBeenCalledWith(500);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("pg.gitGraph.open")).toBe("1");
  });

  it("remembers that it was open and closes from its header", async () => {
    localStorage.setItem("pg.gitGraph.open", "1");
    setup();
    const panel = await screen.findByRole("region", { name: "Git graph" });
    fireEvent.click(within(panel).getByRole("button", { name: "Close Git graph" }));
    expect(screen.queryByRole("region", { name: "Git graph" })).toBeNull();
    expect(localStorage.getItem("pg.gitGraph.open")).toBe("0");
  });

  it("toggles with the shortcut", async () => {
    setup();
    act(() => emitGitGraphShortcut());
    expect(await screen.findByRole("region", { name: "Git graph" })).toBeTruthy();
    act(() => emitGitGraphShortcut());
    expect(screen.queryByRole("region", { name: "Git graph" })).toBeNull();
  });

  it("shows a selected commit's details", async () => {
    setup();
    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    const row = (await within(panel).findByText("Feature work")).closest("[data-commit]")!;
    fireEvent.click(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    const details = await within(panel).findByRole("contentinfo", { name: "Commit details" });
    expect(within(details).getByText("c".repeat(40))).toBeTruthy();
    expect(within(details).getByText("<ann@example.com>")).toBeTruthy();
    expect(within(details).getByText("bbbbbbb")).toBeTruthy();
  });

  it("moves the selection with the keyboard", async () => {
    setup();
    fireEvent.click(toggle());
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await within(list).findByText("Merge feature");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(within(list).getByRole("option", { selected: true }).textContent).toContain("Feature work");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(within(list).queryByRole("option", { selected: true })).toBeNull();
  });

  it("re-reads the log only when the repository's signature changed", async () => {
    const gitState = vi.fn(async () => ({ head: logOf().head, status: logOf().status, signature: "sig-1" }));
    const gitLog = vi.fn(async () => logOf());
    setup(gitLog, gitState);
    fireEvent.click(toggle());
    await screen.findByText("Merge feature");
    expect(gitLog).toHaveBeenCalledTimes(1);

    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(gitState).toHaveBeenCalled());
    expect(gitLog).toHaveBeenCalledTimes(1);

    gitState.mockResolvedValue({ head: logOf().head, status: logOf().status, signature: "sig-2" });
    gitLog.mockResolvedValue(logOf({ commits: [commit("d", { subject: "New commit" }), ...logOf().commits], signature: "sig-2" }));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("New commit")).toBeTruthy();
    expect(gitLog).toHaveBeenCalledTimes(2);
  });

  it("shows uncommitted changes, loads more commits near the end and reports errors", async () => {
    const gitLog = vi
      .fn<(limit?: number) => Promise<GitLogResponse>>()
      .mockResolvedValueOnce(logOf({ hasMore: true, status: { added: 1, modified: 2, deleted: 0 } }))
      .mockRejectedValueOnce(new Error("git exploded"));
    setup(gitLog);
    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    expect((await within(panel).findByText(/Uncommitted changes/)).textContent).toContain("+1 ~2");
    // Three rows are all near the end: the next page is requested at once.
    await waitFor(() => expect(gitLog).toHaveBeenLastCalledWith(1000));
    expect((await within(panel).findByRole("alert")).textContent).toContain("git exploded");
    // The last good history stays on screen.
    expect(within(panel).getByText("Merge feature")).toBeTruthy();
  });

  it("marks where the checkout is: HEAD row, header chip with branch, commit and upstream", async () => {
    setup();
    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    const headRow = (await within(panel).findByText("Merge feature")).closest("[data-commit]")!;
    expect(headRow.getAttribute("data-head")).toBe("true");
    expect(headRow.textContent).toContain("HEAD›main");
    // The checked-out branch is shown once, in the HEAD badge.
    expect(within(headRow as HTMLElement).getAllByText("main")).toHaveLength(1);
    const chip = within(panel).getByRole("button", { name: /^Checkout: Checked out: main · at aaaaaaa · 2 ahead of, 1 behind origin\/main/ });
    expect(chip.textContent).toBe("mainaaaaaaa21");
    // The chip selects HEAD.
    fireEvent.click(within(panel).getByText("Feature work"));
    fireEvent.click(chip);
    expect(within(panel).getByRole("option", { selected: true }).getAttribute("data-head")).toBe("true");
  });

  it("shows a detached HEAD", async () => {
    setup(vi.fn(async () => logOf({ head: { ref: null, hash: "c".repeat(40), upstream: null } })));
    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    expect(await within(panel).findByText("detached HEAD")).toBeTruthy();
    expect((await within(panel).findByText("Feature work")).closest("[data-commit]")!.textContent).toContain("HEAD›detached");
    expect(within(panel).queryByRole("button", { name: "Copy branch name" })).toBeNull();
  });

  it("copies the branch name, the refs and the commit hash", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    fireEvent.click(toggle());
    const panel = await screen.findByRole("region", { name: "Git graph" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Copy branch name" }));
    expect(writeText).toHaveBeenLastCalledWith("main");
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Copy branch name" }).getAttribute("title")).toBe("Copied"));

    fireEvent.click((await within(panel).findByText("Feature work")).closest("[data-commit]")!);
    const details = within(panel).getByRole("contentinfo", { name: "Commit details" });
    fireEvent.click(within(details).getByRole("button", { name: "Copy tag name v1" }));
    expect(writeText).toHaveBeenLastCalledWith("v1");
    fireEvent.click(within(details).getByRole("button", { name: "Copy commit hash" }));
    expect(writeText).toHaveBeenLastCalledWith("c".repeat(40));
  });

  it("says when the repository has no commits", async () => {
    setup(vi.fn(async () => logOf({ head: { ref: "refs/heads/main", hash: null, upstream: null }, commits: [] })));
    fireEvent.click(toggle());
    expect(await screen.findByText("No commits yet.")).toBeTruthy();
  });
});

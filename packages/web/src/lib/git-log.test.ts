import type { GitLogCommit, GitLogResponse } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { branchName, buildGitGraph, hasWorktreeChanges } from "./git-log";

const commit = (hash: string, parents: string[] = []): GitLogCommit => ({
  hash,
  parents,
  subject: `commit ${hash}`,
  authorName: "Ann",
  authorEmail: "ann@x",
  authorDate: "2026-01-01T00:00:00Z",
  committerDate: "2026-01-01T00:00:00Z",
  source: "main",
  refs: [],
});

const log = (over: Partial<GitLogResponse> = {}): GitLogResponse => ({
  head: { ref: "refs/heads/main", hash: "c", upstream: null },
  commits: [commit("t", ["b"]), commit("c", ["b"]), commit("b")],
  hasMore: false,
  status: { added: 0, modified: 0, deleted: 0 },
  signature: "sig",
  ...over,
});

describe("buildGitGraph", () => {
  it("makes one row per commit and marks HEAD", () => {
    const { items, layout } = buildGitGraph(log());
    expect(items.map((i) => (i.kind === "commit" ? [i.commit.hash, i.isHead] : i.kind))).toEqual([["t", false], ["c", true], ["b", false]]);
    // HEAD's line owns the first lane, although the newer branch tip comes first.
    expect(layout.rows.map((r) => r.column)).toEqual([1, 0, 0]);
    expect(layout.rows.map((r) => r.colour)).toEqual([1, 0, 0]);
  });

  it("puts uncommitted changes first, with a dashed line to HEAD", () => {
    const { items, layout } = buildGitGraph(log({ status: { added: 0, modified: 2, deleted: 0 } }));
    expect(items[0]).toEqual({ kind: "worktree" });
    expect(layout.rows[0]!.edges).toEqual([{ kind: "out", from: 0, to: 0, colour: 0, dashed: true }]);
    // HEAD (c) is reached by the dashed lane.
    expect(layout.rows[2]!.edges.some((e) => e.kind === "in" && e.dashed)).toBe(true);
  });

  it("has no uncommitted row without commits", () => {
    expect(buildGitGraph(log({ head: { ref: "refs/heads/main", hash: null, upstream: null }, commits: [], status: { added: 1, modified: 0, deleted: 0 } })).items).toEqual([]);
  });
});

describe("branchName / hasWorktreeChanges", () => {
  it("names the checked-out branch, null when detached", () => {
    expect(branchName({ ref: "refs/heads/feature/x", hash: "a", upstream: null })).toBe("feature/x");
    expect(branchName({ ref: null, hash: "a", upstream: null })).toBeNull();
  });

  it("detects uncommitted changes", () => {
    expect(hasWorktreeChanges(log())).toBe(false);
    expect(hasWorktreeChanges(log({ status: { added: 0, modified: 1, deleted: 0 } }))).toBe(true);
  });
});

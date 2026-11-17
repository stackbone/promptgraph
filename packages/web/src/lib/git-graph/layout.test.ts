import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphEdge, type LayoutCommit } from "./layout";

const c = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents });
const edge = (kind: GraphEdge["kind"], from: number, to: number, colour: number, dashed = false): GraphEdge => ({ kind, from, to, colour, dashed });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane with one colour", () => {
    const { rows, width } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => [r.column, r.colour])).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(rows[0]!.edges).toEqual([edge("out", 0, 0, 0)]);
    expect(rows[1]!.edges).toEqual([edge("in", 0, 0, 0), edge("out", 0, 0, 0)]);
    expect(rows[2]!.edges).toEqual([edge("in", 0, 0, 0)]);
    expect(width).toBe(1);
  });

  it("draws a merge: the merged branch opens a lane to the right and joins back at the fork point", () => {
    // M merges F into A; both come from I.
    const { rows, width } = layoutGraph([c("M", "A", "F"), c("F", "I"), c("A", "I"), c("I")]);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 0]);
    expect(rows[0]!.edges).toEqual([edge("out", 0, 0, 0), edge("out", 0, 1, 1)]);
    // F: lane 0 (waiting for A) passes by; F continues in its lane down to I.
    expect(rows[1]!.edges).toEqual([edge("through", 0, 0, 0), edge("in", 1, 1, 1), edge("out", 1, 1, 1)]);
    // A: lane 1 (waiting for I) passes by; A continues in its own lane although lane 1 waits for I too.
    expect(rows[2]!.edges).toEqual([edge("through", 1, 1, 1), edge("in", 0, 0, 0), edge("out", 0, 0, 0)]);
    // I: both lanes meet at the fork point, in the leftmost.
    expect(rows[3]!.edges).toEqual([edge("in", 0, 0, 0), edge("in", 1, 0, 1)]);
    expect(width).toBe(2);
  });

  it("puts a new branch tip in the first free lane and runs it down to where it forked", () => {
    const rows = layoutGraph([c("x", "b"), c("y", "b"), c("b")]).rows;
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0]);
    expect(rows.map((r) => r.colour)).toEqual([0, 1, 0]);
    expect(rows[1]!.edges).toEqual([edge("through", 0, 0, 0), edge("out", 1, 1, 1)]);
    expect(rows[2]!.edges).toEqual([edge("in", 0, 0, 0), edge("in", 1, 0, 1)]);
  });

  it("joins several lanes waiting for the same commit into the leftmost", () => {
    // x and y were laid out first in lanes 0 and 1, both waiting for b.
    const rows = layoutGraph([c("x", "b"), c("y", "z"), c("z", "b"), c("b")]).rows;
    expect(rows.map((r) => r.column)).toEqual([0, 1, 1, 0]);
    expect(rows[3]!.edges).toEqual([edge("in", 0, 0, 0), edge("in", 1, 0, 1)]);
  });

  it("reuses freed lanes and stays narrow", () => {
    // Two short-lived branches one after the other.
    const commits = [c("m2", "m1", "f2"), c("f2", "m1"), c("m1", "m0", "f1"), c("f1", "m0"), c("m0")];
    const { rows, width } = layoutGraph(commits);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 1, 0]);
    expect(width).toBe(2);
    // Each branch gets its own colour.
    expect(rows[1]!.colour).not.toBe(rows[3]!.colour);
  });

  it("handles octopus merges and duplicate parents", () => {
    const rows = layoutGraph([c("o", "a", "b", "c", "a"), c("a", "r"), c("b", "r"), c("c", "r"), c("r")]).rows;
    expect(rows[0]!.edges.filter((e) => e.kind === "out").map((e) => e.to)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 2, 0]);
  });

  it("keeps lanes of parents outside the loaded history running to the bottom", () => {
    const rows = layoutGraph([c("b", "a"), c("x", "y")]).rows;
    expect(rows[1]!.column).toBe(1);
    expect(rows[1]!.edges).toEqual([edge("through", 0, 0, 0), edge("out", 1, 1, 1)]);
  });

  it("draws the uncommitted-changes row dashed down to HEAD", () => {
    const rows = layoutGraph([{ hash: "*", parents: ["h"], dashed: true }, c("t", "h"), c("h")]).rows;
    expect(rows[0]!.edges).toEqual([edge("out", 0, 0, 0, true)]);
    expect(rows[1]!.edges[0]).toEqual(edge("through", 0, 0, 0, true));
    expect(rows[2]!.edges).toEqual([edge("in", 0, 0, 0, true), edge("in", 1, 0, 1)]);
  });

  it("keeps the mainline (HEAD's first parents) straight in lane 0 with colour 0", () => {
    // A newer branch tip t forked from m1; HEAD is m2, on top of m1; a merge brings f in.
    const commits = [c("t", "m1"), c("m2", "m1", "f"), c("f", "m0"), c("m1", "m0"), c("m0")];
    const plain = layoutGraph(commits).rows;
    expect(plain.map((r) => r.column)).toEqual([0, 1, 2, 0, 0]);
    const { rows } = layoutGraph(commits, { mainline: "m2" });
    expect(rows.map((r) => r.column)).toEqual([1, 0, 2, 0, 0]);
    expect(rows.filter((_, i) => i !== 0 && i !== 2).map((r) => r.colour)).toEqual([0, 0, 0]);
    expect(rows[0]!.colour).not.toBe(0);
    // t's line meets the mainline at m1.
    expect(rows[3]!.edges).toContainEqual(edge("in", 1, 0, rows[0]!.colour));
  });

  it("draws continuous lines on random histories (every line leaving a row enters the next one)", () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 200; run++) {
      // Build a random DAG oldest first, then reverse it: children before parents, as git's topological order.
      const oldestFirst: LayoutCommit[] = [];
      const n = 5 + Math.floor(random() * 60);
      for (let i = 0; i < n; i++) {
        const parents: string[] = [];
        const count = i === 0 ? 0 : random() < 0.15 ? 2 + Math.floor(random() * 2) : random() < 0.05 ? 0 : 1;
        for (let p = 0; p < count; p++) parents.push(`c${Math.floor(random() * i)}`);
        oldestFirst.push(c(`c${i}`, ...parents));
      }
      const commits = oldestFirst.reverse();
      const mainline = random() < 0.5 ? commits[Math.floor(random() * commits.length)]!.hash : undefined;
      const { rows } = layoutGraph(commits, { mainline });
      for (let i = 0; i + 1 < rows.length; i++) {
        const bottom = new Set(rows[i]!.edges.filter((e) => e.kind !== "in").map((e) => e.to));
        const top = new Set(rows[i + 1]!.edges.filter((e) => e.kind !== "out").map((e) => e.from));
        expect([...top].sort(), `run ${run}, rows ${i}→${i + 1}`).toEqual([...bottom].sort());
      }
      for (const r of rows) for (const e of r.edges) expect(Number.isInteger(e.from) && Number.isInteger(e.to)).toBe(true);
      if (mainline) {
        // Lane 0 holds the mainline (mainline's first parents) and nothing else.
        const chain = new Set<string>();
        const byHash = new Map(commits.map((x) => [x.hash, x]));
        for (let x = byHash.get(mainline); x && !chain.has(x.hash); x = x.parents[0] ? byHash.get(x.parents[0]) : undefined) chain.add(x.hash);
        rows.forEach((r, i) => expect(r.column === 0, `run ${run}, row ${i}`).toBe(chain.has(commits[i]!.hash)));
      }
    }
  });

  it("lays out thousands of commits quickly", () => {
    // 20 000 commits with a merge every 10 commits.
    const commits: LayoutCommit[] = [];
    for (let i = 0; i < 20_000; i++) {
      const parents = [`m${i + 1}`];
      if (i % 10 === 0) parents.push(`f${i}`);
      commits.push(c(`m${i}`, ...parents));
      if (i % 10 === 0) commits.push(c(`f${i}`, `m${i + 3}`));
    }
    // Topological order: each f must come after its child m and before its parent; f{i} → m{i+3} comes later anyway.
    const start = performance.now();
    const { rows, width } = layoutGraph(commits);
    expect(rows).toHaveLength(commits.length);
    expect(width).toBeLessThanOrEqual(3);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

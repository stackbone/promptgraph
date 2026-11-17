import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const names = (items: { item: string }[]) => items.map((r) => r.item);

describe("fuzzyMatch", () => {
  it("matches a case-insensitive subsequence and reports the matched indices", () => {
    expect(fuzzyMatch("PR", "Projects")?.indices).toEqual([0, 1]);
    expect(fuzzyMatch("pjs", "projects")?.indices).toEqual([0, 3, 7]);
    expect(fuzzyMatch("xyz", "projects")).toBeNull();
    expect(fuzzyMatch("projectsx", "projects")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("prefers word boundaries over scattered characters", () => {
    expect(fuzzyMatch("pg", "prompt-graph")?.indices).toEqual([0, 7]);
    expect(fuzzyMatch("mg", "myGraph")?.indices).toEqual([0, 2]);
  });
});

describe("fuzzyFilter", () => {
  const dirs = ["Desktop", "Documents", "app-routes", "Projects", "repro", "Pictures", "prompts"];

  it("ranks the closest match first", () => {
    expect(names(fuzzyFilter(dirs, "pr", (d) => d))[0]).toBe("prompts");
    expect(names(fuzzyFilter(dirs, "proj", (d) => d))).toEqual(["Projects"]);
    expect(names(fuzzyFilter(dirs, "doc", (d) => d))[0]).toBe("Documents");
  });

  it("puts a prefix match before a match in the middle of a name", () => {
    const ranked = names(fuzzyFilter(dirs, "pr", (d) => d));
    expect(ranked.indexOf("Projects")).toBeLessThan(ranked.indexOf("app-routes"));
    expect(ranked.indexOf("Projects")).toBeLessThan(ranked.indexOf("repro"));
  });

  it("keeps the original order with an empty query", () => {
    expect(names(fuzzyFilter(dirs, "", (d) => d))).toEqual(dirs);
  });
});

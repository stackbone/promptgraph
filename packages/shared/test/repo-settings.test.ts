import { describe, expect, it } from "vitest";
import { GraphSchema, RepoSettingsSchema, extractUrls, pickAppUrl, repoCommandId, validateGraph, type GraphInput } from "../src/index.js";

function graph(nodes: GraphInput["nodes"], edges: GraphInput["edges"] = []) {
  return GraphSchema.parse({ version: 1, id: "g", name: "G", nodes, edges });
}

describe("repository settings", () => {
  it("accepts relative directories only and unique ids", () => {
    const app = { id: "web", name: "Web", run: "pnpm dev" };
    expect(RepoSettingsSchema.parse({ apps: [app] }).apps[0]).toEqual({ ...app, cwd: "" });
    expect(RepoSettingsSchema.safeParse({ apps: [{ ...app, cwd: "../x" }] }).success).toBe(false);
    expect(RepoSettingsSchema.safeParse({ apps: [{ ...app, cwd: "/abs" }] }).success).toBe(false);
    expect(RepoSettingsSchema.safeParse({ apps: [app, app] }).success).toBe(false);
    expect(RepoSettingsSchema.safeParse({ apps: [{ ...app, url: "localhost:3000" }] }).success).toBe(false);
  });

  it("derives command ids from names", () => {
    expect(repoCommandId("Unit tests")).toBe("unit-tests");
    expect(repoCommandId("Unit tests", ["unit-tests"])).toBe("unit-tests-2");
    expect(repoCommandId("!!!")).toBe("item");
  });

  it("finds the URLs a dev server prints and prefers local ones", () => {
    const out = "  ➜  Network: http://192.168.1.4:5173/\n  ➜  Local:   http://0.0.0.0:5173/.\nTunnel: https://abc.trycloudflare.com";
    expect(extractUrls(out)).toEqual(["http://192.168.1.4:5173/", "http://localhost:5173/", "https://abc.trycloudflare.com"]);
    expect(pickAppUrl(extractUrls(out))).toBe("http://localhost:5173/");
    expect(pickAppUrl(["https://abc.trycloudflare.com"])).toBe("https://abc.trycloudflare.com");
    expect(pickAppUrl([])).toBeNull();
  });
});

describe("validation of app and test nodes (§26.3)", () => {
  const g = graph([
    { id: "a", type: "app", label: "Start" },
    { id: "t", type: "test", label: "Tests", config: { checks: ["unit", "lint"] } },
  ]);

  it("is not checked without the repository's commands", () => {
    expect(validateGraph(g).errors.filter((e) => e.code === "repo_command_missing")).toEqual([]);
  });

  it("needs a configured app and the named checks", () => {
    const none = validateGraph(g, { repoCommands: { apps: [], checks: [] } }).errors.filter((e) => e.code === "repo_command_missing");
    expect(none.map((e) => e.nodeId)).toEqual(["a", "t"]);
    const some = validateGraph(g, { repoCommands: { apps: ["web"], checks: ["unit"] } }).errors.filter((e) => e.code === "repo_command_missing");
    expect(some).toEqual([{ code: "repo_command_missing", message: 'The repository settings have no check "lint".', nodeId: "t" }]);
    const ok = validateGraph(g, { repoCommands: { apps: ["web"], checks: ["unit", "lint"] } }).errors.filter((e) => e.code === "repo_command_missing");
    expect(ok).toEqual([]);
  });

  it("lets an exit-code condition follow a test node", () => {
    const loop = graph(
      [
        { id: "t", type: "test", label: "Tests" },
        { id: "c", type: "condition", label: "Green?", config: { evaluator: { kind: "exitCode", equals: 0 } } },
        { id: "done", type: "approval", label: "Done" },
      ],
      [
        { id: "e1", source: "t", target: "c", when: "always" },
        { id: "e2", source: "c", sourcePort: "true", target: "done" },
      ],
    );
    expect(validateGraph(loop).errors).toEqual([]);
  });
});

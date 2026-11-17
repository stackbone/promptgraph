import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyGraph } from "@promptgraph/shared";
import { projectDirName } from "../src/chat/transcript.js";
import { getPaths, isInWorktreesDir, pgWorktreesDir, type PgPaths } from "../src/config/paths.js";
import { openDatabase, Store } from "../src/store/store.js";
import { migrateLegacyWorktrees } from "../src/workspace/worktree-migration.js";
import { createTempRepo, tempDir } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("pgWorktreesDir", () => {
  it("lives outside PG_HOME: XDG data dir for the real home, next to an explicit PG_HOME, or PG_WORKTREES_DIR", () => {
    expect(pgWorktreesDir({ PG_WORKTREES_DIR: "/w/../wt" })).toBe(path.resolve("/wt"));
    expect(pgWorktreesDir({ PG_HOME: "/tmp/pg" })).toBe(path.resolve("/tmp/pg-worktrees"));
    expect(pgWorktreesDir({ XDG_DATA_HOME: "/data" })).toBe("/data/promptgraph/worktrees");
    expect(pgWorktreesDir({ XDG_DATA_HOME: "relative" })).toMatch(/\/\.local\/share\/promptgraph\/worktrees$/);
    const paths = getPaths({ PG_HOME: "/tmp/pg" });
    expect(paths.worktreesDir.startsWith(`${paths.home}/`)).toBe(false);
    expect(paths.legacyWorktreesDir).toBe(path.resolve("/tmp/pg/worktrees"));
  });

  it("treats both roots as lane worktrees, never as repositories", () => {
    const paths = getPaths({ PG_HOME: "/tmp/pg" });
    expect(isInWorktreesDir(paths, "/tmp/pg-worktrees/repo/run/main")).toBe(true);
    expect(isInWorktreesDir(paths, "/tmp/pg/worktrees/repo/run/main")).toBe(true);
    expect(isInWorktreesDir(paths, "/tmp/pg-worktrees-x/repo")).toBe(false);
  });
});

describe("migrateLegacyWorktrees", () => {
  let root: string;
  let cleanupRoot: () => void;
  let repo: string;
  let cleanupRepo: () => void;
  let paths: PgPaths;
  let store: Store;
  let env: NodeJS.ProcessEnv;
  const lines: string[] = [];

  beforeEach(() => {
    ({ dir: root, cleanup: cleanupRoot } = tempDir());
    ({ repo, cleanup: cleanupRepo } = createTempRepo());
    // As on a real machine (~/.promptgraph/worktrees → ~/.local/share/promptgraph/worktrees), the two roots give
    // different Claude project dir names (`<PG_HOME>-worktrees` would map to the same one: "/" and "-" both become "-").
    env = { PG_HOME: path.join(root, "pg"), PG_WORKTREES_DIR: path.join(root, "share", "promptgraph", "worktrees"), CLAUDE_CONFIG_DIR: path.join(root, "claude") };
    paths = getPaths(env);
    store = new Store(openDatabase(":memory:"));
    lines.length = 0;
  });
  afterEach(() => {
    store.db.close();
    cleanupRepo();
    cleanupRoot();
  });

  /** A run with one lane worktree in the legacy root, a pasted image and a Claude session of that cwd. */
  function legacyRun(runId: string): { oldWt: string; newWt: string; transcript: string } {
    const oldWt = path.join(paths.legacyWorktreesDir, "my-repo", runId, "main");
    fs.mkdirSync(path.dirname(oldWt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", `pg/${runId}`, oldWt);
    fs.writeFileSync(path.join(oldWt, "untracked.txt"), "work in progress");
    fs.mkdirSync(path.join(oldWt, "..", ".images", "nr1"), { recursive: true });
    fs.writeFileSync(path.join(oldWt, "..", ".images", "nr1", "a.png"), "png");
    store.insertRun({ id: runId, repoPath: repo, graph: createEmptyGraph("g", "G"), graphHash: "h", shortId: runId.slice(0, 4), startedAt: 1 });
    store.insertLane({ id: "main", runId, index: 0, branch: `pg/${runId}`, worktreePath: oldWt, baseRef: "HEAD" });
    const project = path.join(env.CLAUDE_CONFIG_DIR!, "projects", projectDirName(oldWt));
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(project, `sess-${runId}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    store.insertNodeRun({ id: `nr-${runId}`, runId, nodeId: "a", iteration: 0, attempt: 0, laneId: "main", status: "idle" });
    store.updateNodeRun(`nr-${runId}`, { transcriptPath: transcript });
    return { oldWt, newWt: path.join(paths.worktreesDir, "my-repo", runId, "main"), transcript };
  }

  it("moves the run directories, repairs git, rewrites the store and copies the Claude sessions", () => {
    const { oldWt, newWt, transcript } = legacyRun("run1");
    const result = migrateLegacyWorktrees({ store, paths, env, log: (l) => lines.push(l) });

    expect(result).toMatchObject({ moved: ["my-repo/run1"], failed: [], repairFailed: [], transcriptDirsCopied: 1 });
    expect(fs.existsSync(oldWt)).toBe(false);
    expect(fs.existsSync(paths.legacyWorktreesDir)).toBe(false);
    expect(fs.readFileSync(path.join(newWt, "untracked.txt"), "utf8")).toBe("work in progress");
    expect(fs.existsSync(path.join(newWt, "..", ".images", "nr1", "a.png"))).toBe(true);
    // Both sides of the git link point at the new location.
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${newWt}`);
    expect(git(newWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pg/run1");
    git(repo, "worktree", "prune");
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${newWt}`);

    expect(store.getLane("run1", "main")!.worktreePath).toBe(newWt);
    const copied = path.join(env.CLAUDE_CONFIG_DIR!, "projects", projectDirName(newWt), "sess-run1.jsonl");
    expect(store.getNodeRun("nr-run1")!.transcriptPath).toBe(copied);
    expect(fs.readFileSync(copied, "utf8")).toBe('{"type":"user"}\n');
    // Claude Code's own data is copied, never moved.
    expect(fs.existsSync(transcript)).toBe(true);
    expect(lines.join("\n")).toMatch(/moved 1 run/);

    // Idempotent: a second start finds nothing to do.
    expect(migrateLegacyWorktrees({ store, paths, env, log: () => undefined })).toMatchObject({ moved: [], failed: [] });
  });

  it("keeps a run whose target exists in place, with its stored paths", () => {
    const { oldWt } = legacyRun("run2");
    fs.mkdirSync(path.join(paths.worktreesDir, "my-repo", "run2"), { recursive: true });
    const result = migrateLegacyWorktrees({ store, paths, env, log: (l) => lines.push(l) });
    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual([{ run: "my-repo/run2", error: expect.stringMatching(/already exists/) }]);
    expect(fs.existsSync(oldWt)).toBe(true);
    expect(store.getLane("run2", "main")!.worktreePath).toBe(oldWt);
    expect(lines.join("\n")).toMatch(/kept my-repo\/run2/);
  });

  it("does nothing without a legacy root, or when PG_WORKTREES_DIR points at it", () => {
    expect(migrateLegacyWorktrees({ store, paths, env })).toEqual({ moved: [], failed: [], repairFailed: [], transcriptDirsCopied: 0 });
    const same = getPaths({ ...env, PG_WORKTREES_DIR: path.join(env.PG_HOME!, "worktrees") });
    const { oldWt } = legacyRun("run3");
    expect(migrateLegacyWorktrees({ store, paths: same, env }).moved).toEqual([]);
    expect(fs.existsSync(oldWt)).toBe(true);
  });
});

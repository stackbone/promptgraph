import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { REPO_SETTINGS_FILE, type RepoSettings } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AppManager } from "../src/apps/app-manager.js";
import { getPaths } from "../src/config/paths.js";
import { EventBus } from "../src/events/bus.js";
import { PtyManager } from "../src/pty/pty-manager.js";
import { analysisPrompt, toRepoSettings } from "../src/repo-settings/analyzer.js";
import { RepoSettingsService } from "../src/repo-settings/settings-service.js";
import { AppRunner } from "../src/runners/app-runner.js";
import { ShellRunner } from "../src/runners/shell-runner.js";
import { TestRunner, shQuote, testScript } from "../src/runners/test-runner.js";
import { tempDir, waitFor } from "./helpers.js";
import { makeCtx, makeLane, makeRun } from "./support/runner-ctx.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function env(dir: string) {
  return { PATH: process.env.PATH, HOME: dir, PG_HOME: path.join(dir, "pg") };
}

function setupPtys(dir: string) {
  const paths = getPaths(env(dir));
  const ptys = new PtyManager(new EventBus(), () => null);
  cleanups.push(() => ptys.killAll());
  return { paths, ptys: ptys.owned("repo"), manager: ptys };
}

describe("RepoSettingsService", () => {
  it("reads an absent file as empty settings, saves atomically and checks the base hash", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const changes: unknown[] = [];
    const svc = new RepoSettingsService({ repoPath: t.dir, onChange: (s) => changes.push(s) });
    expect(svc.state()).toMatchObject({ exists: false, hash: null, error: null, settings: { apps: [], checks: [] }, analysis: { status: "idle" } });

    const saved = svc.save({ version: 1, copyFiles: [], apps: [{ id: "web", name: "Web", run: "pnpm dev", cwd: "" }], checks: [] }, null);
    expect(saved.exists).toBe(true);
    expect(saved.hash).toMatch(/\w+/);
    expect(JSON.parse(fs.readFileSync(path.join(t.dir, REPO_SETTINGS_FILE), "utf8")).apps[0].id).toBe("web");
    expect(changes).toHaveLength(1);
    expect(svc.commandIds()).toEqual({ apps: ["web"], checks: [] });

    expect(() => svc.save({ version: 1, copyFiles: [], apps: [], checks: [] }, "stale")).toThrow(/changed since/);
    expect(() => svc.save({ version: 1, copyFiles: [], apps: [], checks: [] }, null)).toThrow(/changed since/);
    svc.save({ version: 1, copyFiles: [], apps: [], checks: [] }, saved.hash);
    expect(svc.settings().apps).toEqual([]);
  });

  it("reports an invalid file without throwing", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    fs.mkdirSync(path.join(t.dir, ".promptgraph"));
    fs.writeFileSync(path.join(t.dir, REPO_SETTINGS_FILE), "{ nope");
    const state = new RepoSettingsService({ repoPath: t.dir }).state();
    expect(state.exists).toBe(true);
    expect(state.error).toMatch(/not valid JSON/);
    expect(state.settings.apps).toEqual([]);
  });

  it("runs one analysis at a time and writes its result", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    let finish!: (s: RepoSettings) => void;
    const svc = new RepoSettingsService({
      repoPath: t.dir,
      analyze: () => new Promise<RepoSettings>((res) => (finish = res)),
      now: () => 1000,
    });
    expect(svc.analyze().analysis.status).toBe("running");
    expect(() => svc.analyze()).toThrow(/already being analysed/);
    finish({ version: 1, copyFiles: [], apps: [], checks: [{ id: "unit", name: "Unit", run: "pnpm test", cwd: "" }] });
    await waitFor(() => svc.state().analysis.status === "succeeded");
    expect(svc.settings()).toMatchObject({ checks: [{ id: "unit" }], analyzedAt: 1000 });
  });

  it("keeps the file when the analysis fails", async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const svc = new RepoSettingsService({ repoPath: t.dir, analyze: () => Promise.reject(new Error("no claude")) });
    svc.analyze();
    await waitFor(() => svc.state().analysis.status === "failed");
    expect(svc.state()).toMatchObject({ exists: false, analysis: { error: "no claude" } });
  });
});

describe("analysis output", () => {
  it("derives unique ids, normalises directories and drops unusable entries", () => {
    const s = toRepoSettings({
      copyFiles: [],
      apps: [
        { name: "Web app", run: "pnpm dev", cwd: "./packages/web/", url: "http://localhost:5173" },
        { name: "Web app", run: "pnpm dev:2", url: "not a url" },
        { name: "Broken", run: "   " },
      ],
      checks: [{ name: "Unit tests", run: "pnpm test", cwd: "." }, { name: "Escape", run: "make", cwd: "../other" }],
      notes: " Run pnpm install first. ",
    });
    expect(s.apps).toEqual([
      { id: "web-app", name: "Web app", run: "pnpm dev", cwd: "packages/web", url: "http://localhost:5173" },
      { id: "web-app-2", name: "Web app", run: "pnpm dev:2", cwd: "" },
    ]);
    expect(s.checks).toEqual([{ id: "unit-tests", name: "Unit tests", run: "pnpm test", cwd: "" }]);
    expect(s.notes).toBe("Run pnpm install first.");
  });

  it("keeps the setup command and the local files to copy, without dependency directories or escapes", () => {
    const s = toRepoSettings({
      apps: [{ name: "Web", run: "pnpm dev" }],
      checks: [],
      setup: " pnpm install --frozen-lockfile ",
      copyFiles: ["./.env", ".env", "apps/web/.env.local", "node_modules", "../secrets", "packages/a/node_modules/x"],
    });
    expect(s.setup).toBe("pnpm install --frozen-lockfile");
    expect(s.copyFiles).toEqual([".env", "apps/web/.env.local"]);
    expect(toRepoSettings({ apps: [{ name: "Web", run: "x" }], checks: [], setup: "", copyFiles: [] }).setup).toBeUndefined();
  });

  it("fails when nothing usable was found", () => {
    expect(() => toRepoSettings({ copyFiles: [], apps: [], checks: [], notes: "Empty repository." })).toThrow("Empty repository.");
  });

  it("asks to keep the current settings on a re-analysis", () => {
    expect(analysisPrompt({ version: 1, copyFiles: [], apps: [], checks: [] })).not.toContain("currently say");
    expect(analysisPrompt({ version: 1, copyFiles: [], apps: [{ id: "a", name: "A", run: "x", cwd: "" }], checks: [] })).toContain("currently say");
  });
});

describe("TestRunner", () => {
  it("quotes for sh", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  function setupTest(checks: RepoSettings["checks"], config: Record<string, unknown> = {}) {
    const t = tempDir();
    cleanups.push(t.cleanup);
    fs.mkdirSync(path.join(t.dir, "sub"));
    const { paths, ptys } = setupPtys(t.dir);
    const shell = new ShellRunner({ ptys, paths, env: env(t.dir) });
    const runner = new TestRunner({ shell, ptys, settings: () => ({ version: 1, copyFiles: [], apps: [], checks }) });
    const run = makeRun({ nodes: [{ id: "t", type: "test", label: "Tests", config: { continueOnFailure: true, ...config } } as never] });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(t.dir) });
    return { dir: t.dir, ctx, exec: runner.start(ctx) };
  }

  it("runs every check in its directory and reports each result", async () => {
    const { exec } = setupTest([
      { id: "ok", name: "Passes", run: "test \"$(basename \"$PWD\")\" = sub", cwd: "sub" },
      { id: "bad", name: "Lint's check", run: "echo broken; exit 3", cwd: "" },
      { id: "late", name: "Still runs", run: "true", cwd: "" },
    ]);
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", error: "1 of 3 checks failed: Lint's check" });
    if (result.status !== "failed") return;
    expect(result.output?.checks?.map((c) => [c.id, c.status, c.exitCode])).toEqual([
      ["ok", "passed", 0],
      ["bad", "failed", 3],
      ["late", "passed", 0],
    ]);
    expect(result.output?.stdoutTail).toContain("broken");
  });

  it("stops at the first failure without continueOnFailure and skips the rest", async () => {
    const { exec } = setupTest(
      [
        { id: "bad", name: "Bad", run: "exit 1", cwd: "" },
        { id: "never", name: "Never", run: "true", cwd: "" },
      ],
      { continueOnFailure: false },
    );
    const result = await exec.result;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.output?.checks?.map((c) => c.status)).toEqual(["failed", "skipped"]);
  });

  it("runs only the selected checks and succeeds when they pass", async () => {
    const { exec } = setupTest(
      [
        { id: "a", name: "A", run: "true", cwd: "" },
        { id: "b", name: "B", run: "exit 1", cwd: "" },
      ],
      { checks: ["a"] },
    );
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { checks: [{ id: "a", status: "passed" }], text: "The check passed" } });
  });

  it("times a check out with timeout", async () => {
    const { exec } = setupTest([{ id: "slow", name: "Slow", run: "sleep 30", cwd: "", timeoutSec: 1 }]);
    const result = await exec.result;
    expect(result).toMatchObject({ status: "failed", output: { checks: [{ id: "slow", status: "failed", exitCode: 124 }] } });
  });

  it("fails without configured checks", async () => {
    const { exec } = setupTest([]);
    expect(await exec.result).toEqual({ status: "failed", error: "No test or check is configured in the repository settings" });
  });

  it("builds a script that ends with the failure flag", () => {
    expect(testScript([{ id: "a", name: "A", run: "true", cwd: "" }], true).split("\n").at(-1)).toBe('exit "$pg_failed"');
  });
});

describe("AppManager and AppRunner", () => {
  function setupApps() {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const { paths, ptys } = setupPtys(t.dir);
    const changes: number[] = [];
    const apps = new AppManager({ repoId: "repo", repoPath: t.dir, ptys, paths, env: env(t.dir), onChange: (l) => changes.push(l.length) });
    cleanups.push(() => apps.dispose());
    return { dir: t.dir, apps, ptys, changes };
  }

  it("is ready at the first URL printed, local addresses first, and lists the exit", async () => {
    const { dir, apps } = setupApps();
    const started = apps.start({
      app: { id: "web", name: "Web", run: "echo 'Network: http://192.168.1.4:5173/'; echo '  Local:   http://0.0.0.0:5173/'; sleep 30", cwd: "" },
      root: dir,
    });
    expect(started.process.ptyId).toMatch(/^app-/);
    // Both URLs may arrive in one chunk: the local one wins.
    await expect(started.ready).resolves.toMatch(/^http:\/\/(localhost:5173\/|192\.168\.1\.4:5173\/)$/);
    expect(apps.list()[0]).toMatchObject({ status: "ready", runId: null });
    expect(apps.findManualApp("web")).toBeDefined();
    await apps.stop(started.process.ptyId);
    await waitFor(() => apps.list()[0]?.status === "exited");
    expect(apps.findManualApp("web")).toBeUndefined();
  });

  it("waits for the configured URL's port", async () => {
    const { dir, apps } = setupApps();
    const server = http.createServer((_q, s) => s.end("ok"));
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
    const port = (server.address() as AddressInfo).port;
    const started = apps.start({ app: { id: "api", name: "API", run: "echo 'see http://example.test/docs'; sleep 30", cwd: "", url: `http://localhost:${port}` }, root: dir });
    await expect(started.ready).resolves.toBe(`http://localhost:${port}`);
  });

  it("keeps manual starts per worktree apart and stops whatever runs in a worktree being removed (§26.7)", async () => {
    const { dir, apps } = setupApps();
    const wt = path.join(dir, "wt");
    fs.mkdirSync(path.join(wt, "web"), { recursive: true });
    fs.mkdirSync(path.join(dir, "web"), { recursive: true });
    const app = { id: "web", name: "Web", run: "echo http://127.0.0.1:4100; sleep 30", cwd: "web" };
    apps.start({ app, root: dir });
    const inLane = apps.start({ app, root: wt, worktree: { runId: "r1", laneId: "main", branch: "pg/x/main" } });
    expect(inLane.process).toMatchObject({ runId: null, worktree: { laneId: "main" }, cwd: path.join(wt, "web") });
    expect(apps.findManualApp("web")?.worktree).toBeNull();
    expect(apps.findManualApp("web", { runId: "r1", laneId: "main" })?.ptyId).toBe(inLane.process.ptyId);
    expect(apps.findManualApp("web", { runId: "r1", laneId: "l2" })).toBeUndefined();
    await apps.stopIn(wt);
    await waitFor(() => apps.list().filter((p) => p.status === "exited").length === 1);
    expect(apps.list().find((p) => p.status !== "exited")?.worktree).toBeNull();
    await apps.stopButtonApps();
    await waitFor(() => apps.list().every((p) => p.status === "exited"));
  });

  it("rejects when the app exits before it is reachable", async () => {
    const { dir, apps } = setupApps();
    const started = apps.start({ app: { id: "x", name: "X", run: "exit 2", cwd: "" }, root: dir });
    await expect(started.ready).rejects.toThrow("X exited with code 2 before it was reachable");
  });

  it("app nodes succeed with the URL in the lane and stop with their run", async () => {
    const { dir, apps } = setupApps();
    fs.mkdirSync(path.join(dir, "web"));
    const settings = (): RepoSettings => ({ version: 1, copyFiles: [], apps: [{ id: "web", name: "Web", run: 'echo "cwd=$(basename "$PWD") http://127.0.0.1:4000"; sleep 30', cwd: "web" }], checks: [] });
    const runner = new AppRunner({ apps, settings });
    const run = makeRun({ nodes: [{ id: "a", type: "app", label: "Start", config: {} } as never] });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(dir) });
    const exec = runner.start(ctx);
    expect(await exec.result).toMatchObject({ status: "succeeded", output: { app: { appId: "web", url: "http://127.0.0.1:4000" } } });
    expect(ctx.patches[0]).toMatchObject({ ptyId: ctx.nodeRun.id });
    expect(apps.list()[0]).toMatchObject({ ptyId: ctx.nodeRun.id, runId: run.id, status: "ready" });
    await apps.stopRun(run.id);
    await waitFor(() => apps.list()[0]?.status === "exited");
  });

  it("app nodes fail on a timeout and stop the process", async () => {
    const { dir, apps } = setupApps();
    const runner = new AppRunner({ apps, settings: () => ({ version: 1, copyFiles: [], apps: [{ id: "w", name: "Worker", run: "sleep 30", cwd: "" }], checks: [] }) });
    const run = makeRun({ nodes: [{ id: "a", type: "app", label: "Start", config: { readyTimeoutSec: 1 } } as never] });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(dir) });
    expect(await runner.start(ctx).result).toMatchObject({ status: "failed", error: "Worker was not reachable after 1s" });
    await waitFor(() => apps.list()[0]?.status === "exited");
  });

  it("app nodes fail without a configured app", async () => {
    const { dir, apps } = setupApps();
    const runner = new AppRunner({ apps, settings: () => ({ version: 1, copyFiles: [], apps: [], checks: [] }) });
    const run = makeRun({ nodes: [{ id: "a", type: "app", label: "Start", config: { appId: "web" } } as never] });
    const ctx = makeCtx({ run, node: run.graphSnapshot.nodes[0]!, lane: makeLane(dir) });
    expect(await runner.start(ctx).result).toEqual({ status: "failed", error: 'The repository settings have no app "web"' });
  });
});

import fs from "node:fs";
import {
  RunChecksRequestSchema,
  SaveRepoSettingsRequestSchema,
  StartAppsRequestSchema,
  StopAppsRequestSchema,
  type AppWorktree,
  type AppsStatusResponse,
  type RepoSettingsResponse,
  type RunChecksResponse,
} from "@promptgraph/shared";
import { childEnv } from "../../config/child-env.js";
import { ptyLogPath } from "../../config/paths.js";
import type { DaemonContext } from "../../daemon/context.js";
import type { RepoContext } from "../../daemon/repo-context.js";
import { RepoSettingsError } from "../../repo-settings/settings-service.js";
import { testScript } from "../../runners/test-runner.js";
import { newId } from "../../util/ids.js";
import { HttpError, readBody } from "../errors.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

function settingsError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RepoSettingsError) throw new HttpError(409, err.code, err.message);
    throw err;
  }
}

/**
 * Where a manual start runs (§26.7): the main checkout, or with `nodeRunId` the worktree of that node run's lane, which
 * must belong to this repository and still be on disk.
 */
function resolveRoot(daemon: DaemonContext, ctx: RepoContext, nodeRunId: string | undefined): { root: string; worktree: AppWorktree | null; label: string } {
  if (!nodeRunId) return { root: ctx.repo.path, worktree: null, label: "main checkout" };
  const nodeRun = daemon.store.getNodeRun(nodeRunId);
  const run = nodeRun ? daemon.store.getRun(nodeRun.runId) : undefined;
  if (!nodeRun || !run || run.repoPath !== ctx.repo.path) throw new HttpError(404, "not_found", `No node run ${nodeRunId} in this repository`);
  const lane = nodeRun.laneId ? daemon.store.getLane(run.id, nodeRun.laneId) : undefined;
  if (!lane || lane.status === "removed" || !fs.existsSync(lane.worktreePath)) {
    throw new HttpError(409, "no_worktree", "This step's worktree no longer exists (the run was cleaned up)");
  }
  return { root: lane.worktreePath, worktree: { runId: run.id, laneId: lane.id, branch: lane.branch }, label: lane.branch };
}

/**
 * Under /api/repos/:repoId (DESIGN §26): GET/PUT …/settings · POST …/settings/analyze · GET …/apps ·
 * POST …/apps/start · POST …/apps/stop · POST …/checks/run.
 */
export function registerRepoSettingsRoutes(app: App, daemon: DaemonContext): void {
  app.get(`${P}/settings`, (c) => c.json<RepoSettingsResponse>(repoOf(c).settings.state()));

  app.put(`${P}/settings`, async (c) => {
    const body = await readBody(c, SaveRepoSettingsRequestSchema);
    const { settings } = repoOf(c);
    return c.json<RepoSettingsResponse>(settingsError(() => settings.save(body.settings, body.baseHash)));
  });

  /** Starts the analysis (headless Claude with Haiku, read-only); the result arrives as `repo-settings:update`. */
  app.post(`${P}/settings/analyze`, (c) => c.json<RepoSettingsResponse>(settingsError(() => repoOf(c).settings.analyze())));

  app.get(`${P}/apps`, (c) => c.json<AppsStatusResponse>({ apps: repoOf(c).apps.list() }));

  /**
   * Starts one app (`appId`) or every configured app in the main checkout, or with `nodeRunId` in that step's worktree
   * (§26.7); apps already running there are not started twice.
   */
  app.post(`${P}/apps/start`, async (c) => {
    const { appId, nodeRunId } = await readBody(c, StartAppsRequestSchema);
    const ctx = repoOf(c);
    const where = resolveRoot(daemon, ctx, nodeRunId);
    const configured = ctx.settings.settings().apps;
    if (configured.length === 0) throw new HttpError(409, "no_apps", "No application is configured in the repository settings");
    const selected = appId ? configured.filter((a) => a.id === appId) : configured;
    if (selected.length === 0) throw new HttpError(404, "not_found", `The repository settings have no app "${appId}"`);
    for (const a of selected) {
      if (!ctx.apps.findManualApp(a.id, where.worktree)) ctx.apps.start({ app: a, root: where.root, ...(where.worktree ? { worktree: where.worktree } : {}) });
    }
    return c.json<AppsStatusResponse>({ apps: ctx.apps.list() });
  });

  /** Stops one process (`ptyId`, also a run's) or every app started by the button. */
  app.post(`${P}/apps/stop`, async (c) => {
    const { ptyId } = await readBody(c, StopAppsRequestSchema);
    const ctx = repoOf(c);
    if (ptyId) {
      if (!(await ctx.apps.stop(ptyId))) throw new HttpError(404, "not_found", `No running app ${ptyId}`);
    } else {
      await ctx.apps.stopButtonApps();
    }
    return c.json<AppsStatusResponse>({ apps: ctx.apps.list() });
  });

  /**
   * Runs the checks (`checks` ids; absent = all) once, by hand, in the main checkout or a step's worktree (§26.7): one
   * PTY `checks-<id>` the client opens in the terminal drawer. It is not part of any run.
   */
  app.post(`${P}/checks/run`, async (c) => {
    const { checks: ids, nodeRunId } = await readBody(c, RunChecksRequestSchema);
    const ctx = repoOf(c);
    const all = ctx.settings.settings().checks;
    if (all.length === 0) throw new HttpError(409, "no_checks", "No test or check is configured in the repository settings");
    const checks = ids?.length ? all.filter((ch) => ids.includes(ch.id)) : all;
    if (checks.length === 0) throw new HttpError(404, "not_found", "None of these checks is configured");
    const where = resolveRoot(daemon, ctx, nodeRunId);
    const ptyId = `checks-${newId()}`;
    ctx.ptys.spawn({
      id: ptyId,
      file: "sh",
      args: ["-c", testScript(checks, true)],
      cwd: where.root,
      env: childEnv({}, daemon.env),
      logPath: ptyLogPath(daemon.paths, `apps-${ctx.repo.id}`, ptyId),
    });
    const what = checks.length === all.length ? "Tests" : checks.map((ch) => ch.name).join(", ");
    return c.json<RunChecksResponse>({ ptyId, title: `${what} (${where.label})` });
  });
}

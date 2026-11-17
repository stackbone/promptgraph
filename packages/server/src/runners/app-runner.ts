import { DEFAULT_APP_READY_TIMEOUT_SEC, type GraphNodeOf, type RepoSettings } from "@promptgraph/shared";
import type { AppManager } from "../apps/app-manager.js";
import { errorMessage } from "../util/text.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "./types.js";

export interface AppRunnerDeps {
  apps: AppManager;
  /** The repository settings now (§26.1). */
  settings: () => RepoSettings;
}

type Ending = { kind: "failed"; reason: string } | { kind: "cancelled" } | { kind: "done" };

const noop = () => undefined;

/**
 * `app` nodes (DESIGN §26.3): start the configured app in the lane worktree through the AppManager (PTY id = node
 * run id) and succeed once it is reachable, with `output.app.url`. The process keeps running for the next steps and
 * is stopped when the run ends. Fails when the app exits first or is not reachable within `readyTimeoutSec`. Done =
 * succeed now (the user sees it runs; the URL stays unknown); Fail and Cancel stop the process.
 */
export class AppRunner implements Runner {
  constructor(private readonly deps: AppRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const node = ctx.node as GraphNodeOf<"app">;
    if (node.type !== "app") throw new Error(`AppRunner cannot run ${ctx.node.type} nodes`);
    const { apps } = this.deps.settings();
    const app = node.config.appId ? apps.find((a) => a.id === node.config.appId) : apps[0];
    const immediate = (r: RunnerResult): NodeExecution => ({
      result: Promise.resolve(r),
      controls: { done: noop, fail: noop, setHold: noop, cancel: async () => undefined },
    });
    if (!app) {
      return immediate({
        status: "failed",
        error: node.config.appId
          ? `The repository settings have no app "${node.config.appId}"`
          : "No application is configured in the repository settings",
      });
    }

    let started;
    try {
      started = this.deps.apps.start({ app, root: ctx.lane.worktreePath, node: { runId: ctx.run.id, nodeRunId: ctx.nodeRun.id } });
    } catch (err) {
      return immediate({ status: "failed", error: `Could not start ${app.name}: ${errorMessage(err)}` });
    }
    ctx.update({ ptyId: started.handle.id, activity: `Starting ${app.name}` });

    let resolveEnding!: (e: Ending) => void;
    const ending = new Promise<Ending>((res) => (resolveEnding = res));
    let ended = false;
    const settle = (e: Ending) => {
      ended = true;
      resolveEnding(e);
    };
    const timeoutSec = node.config.readyTimeoutSec ?? DEFAULT_APP_READY_TIMEOUT_SEC;
    const timer = setTimeout(() => settle({ kind: "failed", reason: `${app.name} was not reachable after ${timeoutSec}s` }), timeoutSec * 1000);
    const onAbort = () => settle({ kind: "cancelled" });
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    const stop = () => this.deps.apps.stop(started.handle.id);
    const byEnding = ending.then(async (e): Promise<RunnerResult> => {
      if (e.kind === "done") return { status: "succeeded", output: { app: { appId: app.id, name: app.name, url: null }, text: `${app.name} was marked as running` } };
      await stop();
      if (e.kind === "cancelled") return { status: "cancelled" };
      return { status: "failed", error: e.reason, output: { app: { appId: app.id, name: app.name, url: null } } };
    });
    const result = Promise.race([
      started.ready.then(
        (url): RunnerResult | Promise<RunnerResult> =>
          ended ? byEnding : { status: "succeeded", output: { app: { appId: app.id, name: app.name, url }, text: `${app.name} is running at ${url}` } },
        // Stopping the process for a timeout, Fail or Cancel also rejects `ready`: the ending is the reason.
        (err: unknown): RunnerResult | Promise<RunnerResult> =>
          ended ? byEnding : { status: "failed", error: errorMessage(err), output: { app: { appId: app.id, name: app.name, url: null } } },
      ),
      byEnding,
    ]).finally(() => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    });

    return {
      result,
      controls: {
        done: () => settle({ kind: "done" }),
        setHold: noop,
        fail: (reason) => settle({ kind: "failed", reason: reason || "Marked as failed by the user" }),
        cancel: async () => {
          settle({ kind: "cancelled" });
          await result;
          await stop();
        },
      },
    };
  }
}

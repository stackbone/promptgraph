import net from "node:net";
import path from "node:path";
import { extractUrls, pickAppUrl, type AppProcess, type AppWorktree, type RepoApp } from "@promptgraph/shared";
import { childEnv } from "../config/child-env.js";
import { ptyLogPath, type PgPaths } from "../config/paths.js";
import type { OwnedPtys, PtyHandle } from "../pty/pty-manager.js";
import { newId } from "../util/ids.js";
import { stripAnsi } from "../util/text.js";

/** Output kept per process to find its URLs (dev servers print them in the first lines). */
const SCAN_BUFFER_CHARS = 64 * 1024;
/** How often a configured URL's port is probed while the app starts. */
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 500;
const KILL_WAIT_MS = 3000;
/** Exited processes listed after they end (the button and the inspector show why), per repository. */
const KEEP_EXITED = 10;

export interface AppManagerDeps {
  repoId: string;
  repoPath: string;
  ptys: OwnedPtys;
  paths: PgPaths;
  /** Base env for childEnv; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Called after every change of the list (the daemon broadcasts `apps:status`). */
  onChange?: (apps: AppProcess[]) => void;
  now?: () => number;
  /** Test seam: whether something accepts TCP connections on host:port. */
  probe?: (host: string, port: number) => Promise<boolean>;
}

export interface StartAppOptions {
  app: RepoApp;
  /** Directory the app's `cwd` is relative to: the main checkout (button) or a lane worktree (`app` node). */
  root: string;
  /** Set for an `app` node: the PTY id is the node run id and the process belongs to the run. */
  node?: { runId: string; nodeRunId: string };
  /** Started by hand in a run's worktree (§25.7): stopped when that worktree is removed. */
  worktree?: AppWorktree;
}

export interface StartedApp {
  process: AppProcess;
  handle: PtyHandle;
  /** Resolves with the URL once the app is reachable; rejects if it exits first. Never settles if neither happens. */
  ready: Promise<string>;
}

interface Entry {
  process: AppProcess;
  handle: PtyHandle;
  stop: () => Promise<void>;
}

/**
 * The applications of one repository started from the canvas's Run app button (main checkout) or by `app` nodes (in
 * their lane), DESIGN §25.4. Each runs `sh -c <run>` in a PTY of the repository, viewable in the terminal drawer. It
 * is `ready` once its URL is known: the configured `url` when that is printed or its port accepts connections, else
 * the first URL it prints (local addresses first, `pickAppUrl`). Processes of a run are stopped when the run ends
 * (`stopRun`); the others when the user stops them, the repository is removed or the daemon stops.
 */
export class AppManager {
  private readonly entries = new Map<string, Entry>();
  private readonly exited: AppProcess[] = [];

  constructor(private readonly deps: AppManagerDeps) {}

  list(): AppProcess[] {
    const live = [...this.entries.values()].map((e) => e.process);
    return [...live, ...this.exited].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The live process of `appId` started by hand in the main checkout (`worktree` null) or in that lane's worktree. */
  findManualApp(appId: string, worktree: Pick<AppWorktree, "runId" | "laneId"> | null = null): AppProcess | undefined {
    return [...this.entries.values()].find(
      (e) =>
        e.process.runId === null &&
        e.process.appId === appId &&
        (worktree ? e.process.worktree?.runId === worktree.runId && e.process.worktree.laneId === worktree.laneId : e.process.worktree === null),
    )?.process;
  }

  start(opts: StartAppOptions): StartedApp {
    const { app, root, node, worktree } = opts;
    const now = this.deps.now ?? Date.now;
    const ptyId = node ? node.nodeRunId : `app-${newId()}`;
    const cwd = app.cwd ? path.join(root, app.cwd) : root;
    const logPath = ptyLogPath(this.deps.paths, node ? node.runId : `apps-${this.deps.repoId}`, ptyId);
    const handle = this.deps.ptys.spawn({ id: ptyId, file: "sh", args: ["-c", app.run], cwd, env: childEnv({}, this.deps.env ?? process.env), logPath });
    const proc: AppProcess = {
      ptyId,
      appId: app.id,
      name: app.name,
      runId: node?.runId ?? null,
      nodeRunId: node?.nodeRunId ?? null,
      worktree: node ? null : (worktree ?? null),
      cwd,
      status: "starting",
      url: null,
      startedAt: now(),
      exitCode: null,
    };

    let resolveReady!: (url: string) => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<string>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    ready.catch(() => undefined);

    const markReady = (url: string) => {
      if (proc.status !== "starting") return;
      proc.status = "ready";
      proc.url = url;
      clearInterval(probeTimer);
      offData();
      resolveReady(url);
      this.changed();
    };

    const configured = app.url ? parseHostPort(app.url) : null;
    let scanned = "";
    const offData = handle.onData((chunk) => {
      scanned = (scanned + chunk.toString("utf8")).slice(-SCAN_BUFFER_CHARS);
      const urls = extractUrls(stripAnsi(scanned));
      if (app.url) {
        if (configured && urls.some((u) => sameHostPort(u, configured))) markReady(app.url);
      } else {
        const url = pickAppUrl(urls);
        if (url) markReady(url);
      }
    });
    const probe = this.deps.probe ?? tcpProbe;
    let probing = false;
    const probeTimer = setInterval(() => {
      if (!configured || probing || proc.status !== "starting") return;
      probing = true;
      void probe(configured.host, configured.port)
        .then((open) => {
          if (open && app.url) markReady(app.url);
        })
        .finally(() => {
          probing = false;
        });
    }, PROBE_INTERVAL_MS);
    if (!configured) clearInterval(probeTimer);

    const entry: Entry = {
      process: proc,
      handle,
      stop: async () => {
        if (!handle.isLive) return;
        handle.kill("SIGTERM");
        const timer = setTimeout(() => handle.kill("SIGKILL"), KILL_WAIT_MS);
        await handle.exited;
        clearTimeout(timer);
      },
    };
    this.entries.set(ptyId, entry);
    void handle.exited.then((exit) => {
      clearInterval(probeTimer);
      offData();
      const wasStarting = proc.status === "starting";
      proc.status = "exited";
      proc.exitCode = exit.code;
      this.entries.delete(ptyId);
      this.exited.unshift(proc);
      this.exited.splice(KEEP_EXITED);
      if (wasStarting) rejectReady(new Error(`${app.name} exited${exit.code === null ? "" : ` with code ${exit.code}`} before it was reachable`));
      this.changed();
    });
    this.changed();
    return { process: proc, handle, ready };
  }

  async stop(ptyId: string): Promise<boolean> {
    const entry = this.entries.get(ptyId);
    if (!entry) return false;
    await entry.stop();
    return true;
  }

  /** Stops every process started by the button in the main checkout. */
  async stopButtonApps(): Promise<void> {
    await Promise.all([...this.entries.values()].filter((e) => e.process.runId === null && e.process.worktree === null).map((e) => e.stop()));
  }

  /** Stops every process running in `dir` or below it (a worktree about to be removed, §25.7). */
  async stopIn(dir: string): Promise<void> {
    const root = path.resolve(dir);
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => {
          const rel = path.relative(root, e.process.cwd);
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        })
        .map((e) => e.stop()),
    );
  }

  /** Stops the processes started by hand in a lane's worktree (§25.7). */
  async stopWorktree(runId: string, laneId: string): Promise<void> {
    await Promise.all(
      [...this.entries.values()].filter((e) => e.process.worktree?.runId === runId && e.process.worktree.laneId === laneId).map((e) => e.stop()),
    );
  }

  /** Stops the processes the run's `app` nodes started (the run ended, §25.3). */
  async stopRun(runId: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter((e) => e.process.runId === runId).map((e) => e.stop()));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.stop()));
  }

  private changed(): void {
    this.deps.onChange?.(this.list());
  }
}

function parseHostPort(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    const host = u.hostname === "localhost" || u.hostname === "0.0.0.0" || u.hostname === "[::]" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, "");
    return { host, port };
  } catch {
    return null;
  }
}

function sameHostPort(url: string, target: { host: string; port: number }): boolean {
  const hp = parseHostPort(url);
  return !!hp && hp.port === target.port && (hp.host === target.host || (isLoopback(hp.host) && isLoopback(target.host)));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

/** Whether something accepts TCP connections on host:port within PROBE_TIMEOUT_MS. */
export function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

import { z } from "zod";

/**
 * Repository settings (DESIGN §26): how the repository's applications start and how its tests and checks run.
 * Stored in the repository, `.promptgraph/repo-settings.json`, next to the graphs (committable). `app` and `test`
 * nodes and the canvas's Run app button read them; the analysis (a headless Claude call with Haiku) fills them in.
 */

/** Relative path inside the repository (or its lane worktree); no `..` segments, no absolute paths. */
export const RepoRelativeDirSchema = z
  .string()
  .trim()
  .refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "a path relative to the repository, without ..");

export const REPO_COMMAND_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const RepoCommandIdSchema = z.string().regex(REPO_COMMAND_ID_PATTERN, "lowercase letters, digits and dashes");

/** One application of the repository (a web app, an API, a docs site…). */
export const RepoAppSchema = z.object({
  id: RepoCommandIdSchema,
  name: z.string().trim().min(1).max(80),
  /** Shell command that starts it in the foreground, e.g. "pnpm --filter web dev". */
  run: z.string().trim().min(1),
  /** Directory to run in, relative to the repository root; empty = the root. */
  cwd: RepoRelativeDirSchema.default(""),
  /**
   * Where it is reachable once started (e.g. "http://localhost:5173"). Optional: without it the first http(s) URL
   * the command prints is used. With it the app counts as ready when that URL is printed or its port accepts
   * connections.
   */
  url: z.url({ protocol: /^https?$/, error: "an http(s) URL, e.g. http://localhost:5173" }).optional(),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;

/** One test suite or verification (unit tests, typecheck, lint…). */
export const RepoCheckSchema = z.object({
  id: RepoCommandIdSchema,
  name: z.string().trim().min(1).max(80),
  /** Shell command; exit code 0 = passed. */
  run: z.string().trim().min(1),
  cwd: RepoRelativeDirSchema.default(""),
  timeoutSec: z.number().int().positive().max(86_400).optional(),
});
export type RepoCheck = z.infer<typeof RepoCheckSchema>;

function uniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((i) => i.id)).size === items.length;
}

export const RepoSettingsSchema = z.object({
  version: z.literal(1).default(1),
  apps: z.array(RepoAppSchema).max(20).default([]).refine(uniqueIds, "app ids must be unique"),
  checks: z.array(RepoCheckSchema).max(30).default([]).refine(uniqueIds, "check ids must be unique"),
  /**
   * Lane preparation (§26.6). A run works in git worktrees, which hold only what git tracks: these files or
   * directories, relative to the repository root and usually ignored by git (`.env`, `apps/web/.env.local`), are
   * copied from the main checkout into each new worktree. Missing ones are skipped; existing ones are not overwritten.
   */
  copyFiles: z
    .array(RepoRelativeDirSchema.pipe(z.string().min(1)))
    .max(50)
    .default([])
    .refine((files) => new Set(files).size === files.length, "files must be unique"),
  /**
   * Shell command that prepares a new worktree (e.g. "pnpm install"), run after `copyFiles`. A graph's own
   * `settings.workspaceSetup` replaces it for that graph.
   */
  setup: z.string().trim().min(1).optional(),
  /** Set by the analysis (§26.2): when it last filled these settings in, and what it noticed. */
  analyzedAt: z.number().int().optional(),
  notes: z.string().max(2000).optional(),
});
export type RepoSettings = z.infer<typeof RepoSettingsSchema>;
export type RepoSettingsInput = z.input<typeof RepoSettingsSchema>;

export const EMPTY_REPO_SETTINGS: RepoSettings = { version: 1, apps: [], checks: [], copyFiles: [] };

/** Path of the settings file inside the repository. */
export const REPO_SETTINGS_FILE = ".promptgraph/repo-settings.json";

/** State of the repository analysis (§26.2), held by the daemon in memory. */
export const RepoAnalysisSchema = z.object({
  status: z.enum(["idle", "running", "succeeded", "failed"]),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type RepoAnalysis = z.infer<typeof RepoAnalysisSchema>;

export const IDLE_ANALYSIS: RepoAnalysis = { status: "idle", startedAt: null, finishedAt: null, error: null };

/** GET/PUT /api/repos/:repoId/settings. */
export const RepoSettingsResponseSchema = z.object({
  settings: RepoSettingsSchema,
  /** The file exists (false: never configured, the settings are empty). */
  exists: z.boolean(),
  /** Hash of the file as read, for PUT ?baseHash; null when it does not exist. */
  hash: z.string().nullable(),
  /** Set when the file exists but cannot be parsed; `settings` is then empty and a PUT replaces the file. */
  error: z.string().nullable(),
  analysis: RepoAnalysisSchema,
});
export type RepoSettingsResponse = z.infer<typeof RepoSettingsResponseSchema>;

export const SaveRepoSettingsRequestSchema = z.object({ settings: RepoSettingsSchema, baseHash: z.string().nullable().optional() });
export type SaveRepoSettingsRequest = z.input<typeof SaveRepoSettingsRequestSchema>;

/** What the analysis call must answer (`--json-schema`); converted to RepoSettings by the daemon. */
export const RepoAnalysisOutputSchema = z.object({
  apps: z
    .array(
      z.object({
        name: z.string(),
        run: z.string(),
        cwd: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .default([]),
  checks: z
    .array(
      z.object({
        name: z.string(),
        run: z.string(),
        cwd: z.string().optional(),
      }),
    )
    .default([]),
  /** Command that installs the dependencies in a fresh checkout; "" when none is needed. */
  setup: z.string().optional(),
  /** Untracked local files (`.env`…) that exist in the repository and the commands need. */
  copyFiles: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type RepoAnalysisOutput = z.infer<typeof RepoAnalysisOutputSchema>;

// ---------------------------------------------------------------------------
// Running applications (§26.4)
// ---------------------------------------------------------------------------

export const AppProcessStatusSchema = z.enum(["starting", "ready", "exited"]);
export type AppProcessStatus = z.infer<typeof AppProcessStatusSchema>;

/** The run worktree a manually started app or check runs in (a node's context menu, §26.7). */
export const AppWorktreeSchema = z.object({ runId: z.string(), laneId: z.string(), branch: z.string() });
export type AppWorktree = z.infer<typeof AppWorktreeSchema>;

/** One started application process (from the Run app button, a node's context menu, or an `app` node of a run). */
export const AppProcessSchema = z.object({
  /** = its PTY id: `app-<id>` for the Run app button, the node run id for an `app` node. */
  ptyId: z.string(),
  appId: z.string(),
  name: z.string(),
  /** null: started by the Run app button in the main checkout; else the run whose `app` node started it. */
  runId: z.string().nullable(),
  nodeRunId: z.string().nullable(),
  /** Started by hand in a run's worktree (§26.7); null in the main checkout and for `app` nodes. */
  worktree: AppWorktreeSchema.nullable(),
  cwd: z.string(),
  status: AppProcessStatusSchema,
  /** Where to open it: the configured URL, else the first URL it printed; null until known. */
  url: z.string().nullable(),
  startedAt: z.number(),
  exitCode: z.number().nullable(),
});
export type AppProcess = z.infer<typeof AppProcessSchema>;

/** GET /api/repos/:repoId/apps, POST …/apps/start, POST …/apps/stop; WS `apps:status`. */
export const AppsStatusResponseSchema = z.object({ apps: z.array(AppProcessSchema) });
export type AppsStatusResponse = z.infer<typeof AppsStatusResponseSchema>;

/**
 * POST …/apps/start: one app (`appId`) or every configured app (absent), in the main checkout or, with `nodeRunId`, in
 * the worktree of that node run's lane (§26.7).
 */
export const StartAppsRequestSchema = z.object({ appId: RepoCommandIdSchema.optional(), nodeRunId: z.string().optional() });
export type StartAppsRequest = z.infer<typeof StartAppsRequestSchema>;

/** POST …/apps/stop: one process (`ptyId`) or every process started by the Run app button (absent). */
export const StopAppsRequestSchema = z.object({ ptyId: z.string().optional() });
export type StopAppsRequest = z.infer<typeof StopAppsRequestSchema>;

/** POST …/checks/run (§26.7): the checks (`checks` ids; absent = all) in the main checkout or a node run's worktree. */
export const RunChecksRequestSchema = z.object({ checks: z.array(z.string()).optional(), nodeRunId: z.string().optional() });
export type RunChecksRequest = z.infer<typeof RunChecksRequestSchema>;

/** The PTY the checks run in (`checks-<id>`), for the terminal drawer, and a title for its tab. */
export const RunChecksResponseSchema = z.object({ ptyId: z.string(), title: z.string() });
export type RunChecksResponse = z.infer<typeof RunChecksResponseSchema>;

/** Turns a display name into a command id ("Web app" → "web-app"), unique among `taken`. */
export function repoCommandId(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * URLs printed by a dev server or a tunnel, in order of appearance, without duplicates. `0.0.0.0` and `[::]` are
 * rewritten to `localhost` (they are bind addresses, not something a browser opens). `text` must be ANSI-stripped.
 */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>`)\]]+/g)) {
    let url = m[0].replace(/[.,;:]+$/, "");
    url = url.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\])(?=[:/]|$)/, "$1localhost");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** The URL to open for an app: local addresses first (a dev server also prints docs or network links), else the first. */
export function pickAppUrl(urls: readonly string[]): string | null {
  const local = urls.find((u) => /^https?:\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/.test(u));
  return local ?? urls[0] ?? null;
}

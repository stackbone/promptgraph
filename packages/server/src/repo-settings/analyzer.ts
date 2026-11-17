import {
  RepoAnalysisOutputSchema,
  RepoAppSchema,
  RepoCheckSchema,
  RepoRelativeDirSchema,
  RepoSettingsSchema,
  repoCommandId,
  type RepoAnalysisOutput,
  type RepoApp,
  type RepoCheck,
  type RepoSettings,
} from "@promptgraph/shared";
import { z } from "zod";
import { runHeadless } from "../runners/claude/headless.js";

/** Model of the analysis (§26.2): reading a few manifests is light work. */
export const ANALYSIS_MODEL = "haiku";
/** Built-in tools the analysis may use: reading only, never Bash or edits. */
export const ANALYSIS_TOOLS = ["Read", "Glob", "Grep"] as const;
const ANALYSIS_TIMEOUT_MS = 5 * 60_000;

export const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(RepoAnalysisOutputSchema, { io: "input" });

export interface AnalyzeRepositoryOptions {
  repoPath: string;
  /** The settings now, so a re-analysis can keep what the user wrote. */
  current: RepoSettings;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** The analysis prompt (§26.2); exported for tests. */
export function analysisPrompt(current: RepoSettings): string {
  const existing =
    current.apps.length || current.checks.length
      ? `\nThe repository settings currently say (keep what is still right, fix what is wrong):\n${JSON.stringify({ apps: current.apps, checks: current.checks, setup: current.setup, copyFiles: current.copyFiles }, null, 2)}\n`
      : "";
  return `You are configuring promptgraph for the repository in the current directory. Find out, by reading its files
(package.json scripts and workspaces, Makefile, justfile, Taskfile, pyproject.toml, Cargo.toml, go.mod, docker-compose
files, Procfile, README, CONTRIBUTING, CLAUDE.md, AGENTS.md, CI workflows under .github/workflows), two things:

1. "apps": how each application of the project is started for local development (a web front end, an API server, a
   docs site, a desktop app's dev mode…). One entry per process a developer starts. "run" is the shell command that
   starts it in the foreground and keeps running (a dev server, not a build). "cwd" is the directory to run it in,
   relative to the repository root ("" for the root); prefer commands that work from the root (e.g. "pnpm --filter web
   dev") when the project supports them. "url" is where it is reachable once started (e.g. "http://localhost:5173")
   when the configuration or the docs tell you the port; leave it out otherwise. Leave out apps that need secrets or
   cloud resources the docs say a developer must set up first, and say so in "notes".
2. "checks": how the tests and other verifications run (unit tests, integration tests, typecheck, lint, format check).
   Each must be non-interactive and terminate: never a watch mode (use "vitest run", "jest --ci", "pnpm test" only when
   that script does not watch). Prefer the commands CI runs. Order them from fastest to slowest. Do not include
   installing dependencies.

The commands also run in fresh git worktrees of the repository, which contain only the files git tracks. So also say:

3. "setup": the one command that installs the dependencies in such a fresh checkout (e.g. "pnpm install
   --frozen-lockfile", "uv sync", "bundle install"); "" when nothing needs installing.
4. "copyFiles": local files that git ignores but the apps or tests need, and that exist in this directory now: typically
   ".env", ".env.local", "apps/web/.env" (look for them with Glob, including hidden files, and check that .gitignore
   ignores them). Paths relative to the repository root. Never list dependency or build directories (node_modules,
   .venv, dist): "setup" recreates those. Do not read the contents of these files.

Use the package manager the project uses (lock files tell: pnpm-lock.yaml, yarn.lock, package-lock.json, bun.lockb,
uv.lock, poetry.lock…). "name" is a short human name ("Web app", "API", "Unit tests", "Typecheck"). Do not invent
commands that the files do not support. "notes" is at most three short sentences for the developer: what you could not
determine, or what must be done before the commands work (e.g. "Run pnpm install first."). Answer only with the JSON.
${existing}`;
}

/**
 * Runs the analysis: `claude -p --model haiku` in the repository with read-only tools and a JSON schema (§26.2), then
 * normalises the answer into RepoSettings (ids derived from the names, invalid entries dropped).
 * @throws when the call fails or the answer has no usable entry.
 */
export async function analyzeRepository(opts: AnalyzeRepositoryOptions): Promise<RepoSettings> {
  const result = await runHeadless({
    prompt: analysisPrompt(opts.current),
    cwd: opts.repoPath,
    model: ANALYSIS_MODEL,
    jsonSchema: ANALYSIS_JSON_SCHEMA,
    readOnlyTools: ANALYSIS_TOOLS,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    signal: opts.signal,
    env: opts.env,
  });
  const parsed = RepoAnalysisOutputSchema.safeParse(result.structured_output);
  if (!parsed.success) throw new Error(`The analysis answered in an unexpected shape: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return toRepoSettings(parsed.data);
}

/** Normalises an analysis answer (pure; exported for tests). */
export function toRepoSettings(out: RepoAnalysisOutput): RepoSettings {
  const appIds: string[] = [];
  const apps: RepoApp[] = [];
  for (const a of out.apps) {
    const id = repoCommandId(a.name, appIds);
    const url = a.url?.trim() ? a.url.trim() : undefined;
    const app = RepoAppSchema.safeParse({ id, name: a.name, run: a.run, cwd: normaliseCwd(a.cwd), url });
    const fallback = app.success ? app : RepoAppSchema.safeParse({ id, name: a.name, run: a.run, cwd: normaliseCwd(a.cwd) });
    if (!fallback.success) continue;
    appIds.push(id);
    apps.push(fallback.data);
  }
  const checkIds: string[] = [];
  const checks: RepoCheck[] = [];
  for (const c of out.checks) {
    const id = repoCommandId(c.name, checkIds);
    const check = RepoCheckSchema.safeParse({ id, name: c.name, run: c.run, cwd: normaliseCwd(c.cwd) });
    if (!check.success) continue;
    checkIds.push(id);
    checks.push(check.data);
  }
  if (apps.length === 0 && checks.length === 0) {
    throw new Error(out.notes?.trim() || "The analysis found no application and no test command");
  }
  const notes = out.notes?.trim().slice(0, 2000);
  const setup = out.setup?.trim();
  const copyFiles = [...new Set(out.copyFiles.map(normaliseCwd).filter((f) => f && RepoRelativeDirSchema.safeParse(f).success && !/(^|\/)(node_modules|\.git)(\/|$)/.test(f)))];
  return RepoSettingsSchema.parse({
    version: 1,
    apps: apps.slice(0, 20),
    checks: checks.slice(0, 30),
    copyFiles: copyFiles.slice(0, 50),
    ...(setup ? { setup } : {}),
    ...(notes ? { notes } : {}),
  });
}

function normaliseCwd(cwd: string | undefined): string {
  const c = (cwd ?? "").trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return c === "." ? "" : c;
}

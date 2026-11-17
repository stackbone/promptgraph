import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of promptgraph's own state. `PG_HOME` overrides `~/.promptgraph` (tests). Under vitest (`VITEST`
 * is set, and inherited by every process a test spawns) a missing PG_HOME is an error instead of a
 * fallback, so a test can never read or migrate the user's real state.
 */
export function pgHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PG_HOME) return path.resolve(env.PG_HOME);
  if (env.VITEST ?? process.env.VITEST) throw new Error("PG_HOME must be set under vitest (refusing to fall back to ~/.promptgraph)");
  return path.join(os.homedir(), ".promptgraph");
}

/**
 * Root of the lane worktrees (DESIGN §9.1, §11): outside PG_HOME, so the `permissions.deny` rule for PG_HOME
 * (§7.6) never covers a node's own working directory, and outside every repository. `PG_WORKTREES_DIR` overrides
 * it. Without it: `$XDG_DATA_HOME/promptgraph/worktrees` (default `~/.local/share/…`) for the real PG_HOME, and
 * `<PG_HOME>-worktrees` next to an explicit PG_HOME (tests, manual runs), so those never write to the user's home.
 */
export function pgWorktreesDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PG_WORKTREES_DIR) return path.resolve(env.PG_WORKTREES_DIR);
  if (env.PG_HOME) return `${pgHome(env)}-worktrees`;
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "promptgraph", "worktrees");
}

export interface PgPaths {
  home: string;
  /** SQLite database (§11.2). */
  stateDb: string;
  /** App settings JSON (AppSettings). */
  settingsFile: string;
  /** Per-run dirs: hooks.json + terminal logs. */
  runsDir: string;
  /** Worktrees root: <worktreesDir>/<repo-name>/<run-id>/<lane-id> (§9.1); see pgWorktreesDir. */
  worktreesDir: string;
  /** Where worktrees lived before 2026-11 (`<home>/worktrees`); migrated at daemon start (§11.4). */
  legacyWorktreesDir: string;
  /** Installed helper scripts (pg-hook). */
  binDir: string;
  /** Short-lived private files (voice dictation WAVs, §22.5). */
  tmpDir: string;
  /** Whisper models the user drops in (voice dictation auto-detection, §22.3). */
  modelsDir: string;
  /** Pasted images, content-addressed (§25). */
  imagesDir: string;
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): PgPaths {
  const home = pgHome(env);
  return {
    home,
    stateDb: path.join(home, "state.db"),
    settingsFile: path.join(home, "settings.json"),
    runsDir: path.join(home, "runs"),
    worktreesDir: pgWorktreesDir(env),
    legacyWorktreesDir: path.join(home, "worktrees"),
    binDir: path.join(home, "bin"),
    tmpDir: path.join(home, "tmp"),
    modelsDir: path.join(home, "models"),
    imagesDir: path.join(home, "images"),
  };
}

export function runDir(paths: PgPaths, runId: string): string {
  return path.join(paths.runsDir, runId);
}

/** Terminal log of a PTY after exit (§7.3). For node PTYs ptyId === nodeRunId. */
export function ptyLogPath(paths: PgPaths, runId: string, ptyId: string): string {
  return path.join(runDir(paths, runId), `${ptyId}.log`);
}

/** hooks.json generated once per run (§7.2); `hooks-bypass.json` for consoles started in bypassPermissions (§7.6). */
export function hooksSettingsPath(paths: PgPaths, runId: string, opts: { bypass?: boolean } = {}): string {
  return path.join(runDir(paths, runId), opts.bypass ? "hooks-bypass.json" : "hooks.json");
}

/**
 * Whether the realpath `p` is a worktrees root or inside one (DESIGN §4.2): a lane worktree is never a
 * repository of its own. Checks the current root and the legacy one (a worktree that could not be migrated),
 * each as configured and as its realpath (either may be a link).
 */
export function isInWorktreesDir(paths: PgPaths, p: string): boolean {
  const roots = new Set<string>();
  for (const dir of [paths.worktreesDir, paths.legacyWorktreesDir]) {
    roots.add(path.resolve(dir));
    try {
      roots.add(fs.realpathSync(dir));
    } catch {
      // Not created yet: nothing can be inside it but the configured path.
    }
  }
  return [...roots].some((root) => p === root || p.startsWith(root + path.sep));
}

/**
 * Where a Claude node run's pasted images are copied for Claude to read (§25): next to the run's lane worktrees
 * (`<worktreesDir>/<repo>/<run>/.images/<nodeRun>`), so the run's cleanup removes them with the worktrees.
 */
export function nodeRunImagesDir(laneWorktreePath: string, nodeRunId: string): string {
  return path.join(path.dirname(laneWorktreePath), ".images", nodeRunId);
}

export function worktreePath(paths: PgPaths, repoName: string, runId: string, laneId: string): string {
  return path.join(paths.worktreesDir, repoName, runId, laneId);
}

/** Graph files live in the target repo. */
export function graphsDir(repoPath: string): string {
  return path.join(repoPath, ".promptgraph", "graphs");
}

/** Claude Code's global config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` (SPIKE A5). */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json` (read-only). */
export function claudeUserSettingsFile(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), "settings.json") : path.join(homeDir, ".claude", "settings.json");
}

/** packages/server root (works from src/ via tsx and from dist/). */
export const SERVER_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shipped pg-hook script; installed into binDir at startup. */
export const PG_HOOK_SOURCE = path.join(SERVER_PACKAGE_DIR, "assets", "pg-hook");

/** Built web assets served by the server. `PG_WEB_DIST` overrides. */
export function webDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PG_WEB_DIST ? path.resolve(env.PG_WEB_DIST) : path.resolve(SERVER_PACKAGE_DIR, "..", "web", "dist");
}

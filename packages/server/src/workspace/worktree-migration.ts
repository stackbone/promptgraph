import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDir, projectDirName } from "../chat/transcript.js";
import type { PgPaths } from "../config/paths.js";
import { READ_ONLY_GIT_CONFIG } from "../git/exec.js";
import type { Store } from "../store/store.js";
import { errorMessage } from "../util/text.js";

export interface WorktreeMigrationResult {
  /** Run directories moved (`<repo-name>/<run-id>`). */
  moved: string[];
  /** Run directories left in the legacy root, with the reason. */
  failed: Array<{ run: string; error: string }>;
  /** Lane worktrees whose git links `git worktree repair` could not fix (the files were moved). */
  repairFailed: string[];
  /** Claude project dirs copied so "Reopen session" (`--resume`) finds the transcripts at the new cwd. */
  transcriptDirsCopied: number;
}

export interface WorktreeMigrationOptions {
  store: Store;
  paths: PgPaths;
  /** For `CLAUDE_CONFIG_DIR` (where Claude Code keeps its transcripts). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * Moves lane worktrees from the legacy root (`<PG_HOME>/worktrees`) to `paths.worktreesDir` (DESIGN §11.4). Runs
 * once per daemon start, before any repository context exists, so no PTY or git call uses a worktree meanwhile.
 * Idempotent and per run: a run directory whose target already exists, or that cannot be moved, stays where it
 * is, keeps its stored paths and still works (paths in the store are absolute). For each moved run:
 * 1. the run directory (lane worktrees, `.images`) is renamed, or copied then removed across filesystems;
 * 2. `git worktree repair` in each lane worktree points the repository's admin entry at the new location;
 * 3. the lanes' `worktree_path` is rewritten;
 * 4. each lane's Claude project dir (`~/.claude/projects/<cwd as dir name>`) is copied to the one of the new cwd,
 *    never moved (it is Claude Code's data), and the node runs' `transcript_path` is rewritten to the copy.
 * Empty legacy directories are removed at the end.
 */
export function migrateLegacyWorktrees(opts: WorktreeMigrationOptions): WorktreeMigrationResult {
  const { store, paths } = opts;
  const log = opts.log ?? ((line: string) => console.warn(`[worktrees] ${line}`));
  const result: WorktreeMigrationResult = { moved: [], failed: [], repairFailed: [], transcriptDirsCopied: 0 };
  const from = path.resolve(paths.legacyWorktreesDir);
  const to = path.resolve(paths.worktreesDir);
  if (from === to || !isDir(from)) return result;
  const projects = claudeProjectsDir(opts.env ?? process.env);

  for (const repoName of subdirs(from)) {
    for (const runId of subdirs(path.join(from, repoName))) {
      const run = `${repoName}/${runId}`;
      const src = path.join(from, repoName, runId);
      const dst = path.join(to, repoName, runId);
      if (fs.existsSync(dst)) {
        result.failed.push({ run, error: `${dst} already exists` });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        moveDir(src, dst);
      } catch (err) {
        result.failed.push({ run, error: errorMessage(err) });
        continue;
      }
      result.moved.push(run);
      for (const lane of subdirs(dst).filter((d) => !d.startsWith("."))) {
        const wt = path.join(dst, lane);
        if (!fs.existsSync(path.join(wt, ".git"))) continue;
        const res = spawnSync("git", [...READ_ONLY_GIT_CONFIG, "worktree", "repair"], {
          cwd: wt,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          encoding: "utf8",
        });
        if (res.status !== 0) result.repairFailed.push(wt);
        const oldProject = path.join(projects, projectDirName(path.join(src, lane)));
        const newProject = path.join(projects, projectDirName(wt));
        if (isDir(oldProject)) {
          try {
            if (!fs.existsSync(newProject)) {
              fs.cpSync(oldProject, newProject, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
              result.transcriptDirsCopied++;
            }
            store.rewriteTranscriptDir(oldProject, newProject);
          } catch (err) {
            log(`could not copy the Claude sessions of ${wt}: ${errorMessage(err)} (Reopen session may start a new one)`);
          }
        }
      }
      store.rewriteWorktreePaths(src, dst);
    }
    removeIfEmpty(path.join(from, repoName));
  }
  removeIfEmpty(from);

  if (result.moved.length) log(`moved ${result.moved.length} run(s) from ${from} to ${to}`);
  for (const f of result.failed) log(`kept ${f.run} in ${from}: ${f.error}`);
  for (const wt of result.repairFailed) log(`git worktree repair failed in ${wt}; run it there by hand`);
  return result;
}

/** rename, or a copy then removal when `src` and `dst` are on different filesystems. */
function moveDir(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty (a run that stayed) or already gone.
  }
}

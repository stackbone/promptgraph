import fs from "node:fs";
import path from "node:path";

export interface CopyFilesResult {
  /** Copied into the worktree. */
  copied: string[];
  /** Not in the main checkout (nothing to copy). */
  missing: string[];
  /** Already in the worktree (tracked by git, or copied before): left as they are. */
  kept: string[];
}

/** Whether `p` is `root` or inside it (both resolved). */
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Lane preparation (DESIGN §26.6): copies `files` (paths relative to the repository root: files or directories,
 * usually ignored by git, such as `.env`) from the main checkout into a new worktree. A path missing in the checkout
 * is skipped; one that already exists in the worktree is never overwritten. Symbolic links are copied as links.
 * @throws on a path that leaves either root, or an I/O error.
 */
export function copyRepoFiles(repoPath: string, worktreePath: string, files: readonly string[]): CopyFilesResult {
  const result: CopyFilesResult = { copied: [], missing: [], kept: [] };
  for (const file of files) {
    const src = path.resolve(repoPath, file);
    const dest = path.resolve(worktreePath, file);
    if (!inside(repoPath, src) || !inside(worktreePath, dest) || src === path.resolve(repoPath)) {
      throw new Error(`Cannot copy "${file}": not a path inside the repository`);
    }
    if (!fs.existsSync(src)) {
      result.missing.push(file);
      continue;
    }
    if (fs.existsSync(dest)) {
      result.kept.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
    result.copied.push(file);
  }
  return result;
}

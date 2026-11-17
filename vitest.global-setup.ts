// Global vitest setup (registered in the root vitest.config.ts): every run gets a fresh, throwaway
// PG_HOME so no test, and no promptgraph process a test spawns with the inherited env, can fall back
// to the user's real ~/.promptgraph (AGENTS.md: tests never touch the user's real state).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-home-"));
  process.env.PG_HOME = home;
  return () => {
    fs.rmSync(home, { recursive: true, force: true });
    // Lane worktrees live next to an explicit PG_HOME (pgWorktreesDir).
    fs.rmSync(`${home}-worktrees`, { recursive: true, force: true });
  };
}

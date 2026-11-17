import type { GitHead, GitLogCommit, GitLogResponse } from "@promptgraph/shared";
import { layoutGraph, type GraphLayout, type LayoutCommit } from "./git-graph/layout";

/** A row of the Git graph (DESIGN §13.7): a commit, or the uncommitted changes above HEAD. */
export type GitGraphItem = { kind: "commit"; commit: GitLogCommit; isHead: boolean } | { kind: "worktree" };

export interface GitGraphModel {
  items: GitGraphItem[];
  layout: GraphLayout;
}

/** Hash of the uncommitted-changes row in the layout: not a valid commit hash. */
const WORKTREE = "*worktree";

export function hasWorktreeChanges(log: GitLogResponse): boolean {
  const s = log.status;
  return s.added + s.modified + s.deleted > 0;
}

/**
 * The rows and their lane layout. Uncommitted changes in the main checkout are a first row whose dashed line runs to
 * the HEAD commit; that row, HEAD and HEAD's first parents form the mainline, drawn straight in the first lane.
 */
export function buildGitGraph(log: GitLogResponse): GitGraphModel {
  const items: GitGraphItem[] = [];
  const input: LayoutCommit[] = [];
  if (log.head.hash && hasWorktreeChanges(log)) {
    items.push({ kind: "worktree" });
    input.push({ hash: WORKTREE, parents: [log.head.hash], dashed: true });
  }
  for (const commit of log.commits) {
    items.push({ kind: "commit", commit, isHead: commit.hash === log.head.hash });
    input.push({ hash: commit.hash, parents: commit.parents });
  }
  return { items, layout: layoutGraph(input, { mainline: input[0]?.hash === WORKTREE ? WORKTREE : log.head.hash }) };
}

/** Short name of the checked-out branch; null when HEAD is detached. */
export function branchName(head: GitHead): string | null {
  return head.ref ? head.ref.replace(/^refs\/heads\//, "") : null;
}

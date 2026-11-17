import { z } from "zod";

/**
 * GET /api/repos/:repoId/git/log?limit= (DESIGN §12.1, §13.7): the repository's commit history for the Git graph
 * panel. Local branches, remote-tracking branches, tags and HEAD, newest first in topological order; promptgraph's
 * hidden snapshot refs (`refs/promptgraph/*`) are never included.
 */
export const GIT_LOG_DEFAULT_LIMIT = 500;
export const GIT_LOG_MAX_LIMIT = 5000;

export const GitLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GIT_LOG_MAX_LIMIT).optional(),
});
export type GitLogQuery = z.infer<typeof GitLogQuerySchema>;

export const GitRefKindSchema = z.enum(["branch", "remote", "tag"]);
export type GitRefKind = z.infer<typeof GitRefKindSchema>;

/** A ref pointing at a commit. */
export const GitRefSchema = z.object({
  kind: GitRefKindSchema,
  /** Full name, e.g. `refs/heads/main`, `refs/remotes/origin/main`, `refs/tags/v1.0`. */
  ref: z.string(),
  /** Short name, e.g. `main`, `origin/main`, `v1.0`. */
  name: z.string(),
});
export type GitRef = z.infer<typeof GitRefSchema>;

export const GitLogCommitSchema = z.object({
  hash: z.string(),
  /** Parent hashes, first parent first; empty for a root commit. */
  parents: z.array(z.string()),
  /** First line of the commit message. */
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  /** ISO 8601. */
  authorDate: z.string(),
  /** ISO 8601. */
  committerDate: z.string(),
  /** The ref the commit was reached from (`git log --source`, short form, e.g. `main` or `origin/HEAD`). */
  source: z.string(),
  /** Refs pointing at this commit (local branches first, then remote branches, then tags). */
  refs: z.array(GitRefSchema),
});
export type GitLogCommit = z.infer<typeof GitLogCommitSchema>;

/** Uncommitted changes of the repository's main worktree (`git status`). */
export const GitWorktreeStatusSchema = z.object({
  added: z.number().int(),
  modified: z.number().int(),
  deleted: z.number().int(),
});
export type GitWorktreeStatus = z.infer<typeof GitWorktreeStatusSchema>;

/** The checked-out branch's upstream (`branch.<name>.merge`), compared with the branch. */
export const GitUpstreamSchema = z.object({
  /** Short name, e.g. `origin/main`. */
  name: z.string(),
  /** Commits on the branch and not on the upstream. */
  ahead: z.number().int(),
  /** Commits on the upstream and not on the branch. */
  behind: z.number().int(),
  /** The upstream branch no longer exists (deleted on the remote and pruned). */
  gone: z.boolean(),
});
export type GitUpstream = z.infer<typeof GitUpstreamSchema>;

export const GitHeadSchema = z.object({
  /** Full ref HEAD points to (`refs/heads/main`); null when HEAD is detached. */
  ref: z.string().nullable(),
  /** Commit HEAD points to; null in a repository without commits. */
  hash: z.string().nullable(),
  /** The checked-out branch's upstream; null when detached or the branch tracks nothing. */
  upstream: GitUpstreamSchema.nullable(),
});
export type GitHead = z.infer<typeof GitHeadSchema>;

/**
 * GET /api/repos/:repoId/git/state: what the graph depends on, cheap to read (HEAD, the shown refs, the uncommitted
 * changes) and its `signature`. The panel polls it and re-reads the log only when the signature changes.
 */
export const GitStateResponseSchema = z.object({
  head: GitHeadSchema,
  status: GitWorktreeStatusSchema,
  /** Opaque hash of HEAD, every shown ref and its target, and the status counts. */
  signature: z.string(),
});
export type GitStateResponse = z.infer<typeof GitStateResponseSchema>;

export const GitLogResponseSchema = GitStateResponseSchema.extend({
  commits: z.array(GitLogCommitSchema),
  /** More commits exist past `limit`. */
  hasMore: z.boolean(),
});
export type GitLogResponse = z.infer<typeof GitLogResponseSchema>;

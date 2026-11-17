import { createHash } from "node:crypto";
import {
  GIT_LOG_DEFAULT_LIMIT,
  type GitHead,
  type GitLogCommit,
  type GitLogResponse,
  type GitRef,
  type GitStateResponse,
  type GitUpstream,
  type GitWorktreeStatus,
} from "@promptgraph/shared";
import { git, GitError } from "./exec.js";

/** Unit and record separators of the `git log` format: never part of a ref name, hash, name or date. */
const US = "\x1f";
const RS = "\x1e";
const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%S", "%D", "%s"].join("%x1f") + "%x1e";

/** The history is read in one go; a runaway output (huge subjects) is cut here and reported as `hasMore`. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;

/**
 * Which refs the graph shows: local and remote branches and tags. The decoration filters keep promptgraph's hidden
 * snapshot refs (`refs/promptgraph/*`, §10) and symbolic remote HEADs (`origin/HEAD`) out of the labels.
 */
const DECORATE_ARGS = [
  "--decorate=full",
  "--decorate-refs=refs/heads/",
  "--decorate-refs=refs/remotes/",
  "--decorate-refs=refs/tags/",
  "--decorate-refs-exclude=refs/remotes/*/HEAD",
];

const REF_ORDER: Record<GitRef["kind"], number> = { branch: 0, remote: 1, tag: 2 };

/** One `%D` entry (`refs/heads/main`, `tag: refs/tags/v1`, `HEAD -> refs/heads/main`) as a ref, or null for HEAD. */
export function parseDecoration(entry: string): GitRef | null {
  let ref = entry.trim();
  if (ref.startsWith("HEAD -> ")) ref = ref.slice("HEAD -> ".length);
  if (ref.startsWith("tag: ")) ref = ref.slice("tag: ".length);
  if (ref.startsWith("refs/heads/")) return { kind: "branch", ref, name: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/remotes/")) return { kind: "remote", ref, name: ref.slice("refs/remotes/".length) };
  if (ref.startsWith("refs/tags/")) return { kind: "tag", ref, name: ref.slice("refs/tags/".length) };
  return null;
}

/** Parses the output of `git log --format=LOG_FORMAT`. A truncated last record is dropped. */
export function parseGitLog(stdout: string): GitLogCommit[] {
  const commits: GitLogCommit[] = [];
  for (const raw of stdout.split(RS)) {
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const f = record.split(US);
    if (f.length !== 9) continue;
    const [hash, parents, authorName, authorEmail, authorDate, committerDate, source, decorations, subject] = f as [
      string, string, string, string, string, string, string, string, string,
    ];
    if (!/^[0-9a-f]{40,64}$/.test(hash)) continue;
    const refs = decorations
      .split(", ")
      .map(parseDecoration)
      .filter((r): r is GitRef => r !== null)
      .sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind] || a.name.localeCompare(b.name));
    commits.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      subject,
      authorName,
      authorEmail,
      authorDate,
      committerDate,
      source,
      refs,
    });
  }
  return commits;
}

/** Counts `git status --porcelain=v1 -z` entries: untracked and added files are added, staged or unstaged deletions deleted. */
export function parseStatus(stdout: string): GitWorktreeStatus {
  const status: GitWorktreeStatus = { added: 0, modified: 0, deleted: 0 };
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // A rename or copy is followed by its source path as a separate entry.
    if (xy[0] === "R" || xy[0] === "C") i++;
    if (xy === "??" || xy.includes("A")) status.added++;
    else if (xy.includes("D")) status.deleted++;
    else status.modified++;
  }
  return status;
}

/** Parses `%(upstream:short)|%(upstream:track)` of one branch: `origin/main|[ahead 1, behind 2]`, `|` without upstream. */
export function parseUpstream(line: string): GitUpstream | null {
  const sep = line.indexOf("|");
  const name = (sep >= 0 ? line.slice(0, sep) : line).trim();
  if (!name) return null;
  const track = sep >= 0 ? line.slice(sep + 1) : "";
  const count = (word: string) => Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0);
  return { name, ahead: count("ahead"), behind: count("behind"), gone: track.includes("gone") };
}

async function readHead(repoPath: string): Promise<GitHead> {
  const [hash, ref] = await Promise.all([
    git(repoPath, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { readOnly: true }),
    git(repoPath, ["symbolic-ref", "-q", "HEAD"], { readOnly: true }),
  ]);
  const branch = ref.code === 0 ? ref.stdout.trim() || null : null;
  // One for-each-ref gives the upstream and how far the branch is from it (git computes ahead/behind).
  const upstream = branch
    ? await git(repoPath, ["for-each-ref", "--format=%(upstream:short)|%(upstream:track)", branch], { readOnly: true })
    : null;
  return {
    hash: hash.code === 0 ? hash.stdout.trim() || null : null,
    ref: branch,
    upstream: upstream && upstream.code === 0 ? parseUpstream(upstream.stdout.trim()) : null,
  };
}

/**
 * What the graph depends on (DESIGN §13.7), cheap enough to poll: HEAD, every shown ref with its target (one
 * `for-each-ref`), the uncommitted changes, and a signature of all of it. Read-only: no fsmonitor, no optional locks.
 */
export async function readGitState(repoPath: string): Promise<GitStateResponse> {
  const [head, refs, statusRes] = await Promise.all([
    readHead(repoPath),
    git(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/remotes/", "refs/tags/"], { readOnly: true }),
    git(repoPath, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { readOnly: true }),
  ]);
  const status = statusRes.code === 0 ? parseStatus(statusRes.stdout) : { added: 0, modified: 0, deleted: 0 };
  const signature = createHash("sha256")
    .update(JSON.stringify([head, refs.stdout, status]))
    .digest("hex")
    .slice(0, 32);
  return { head, status, signature };
}

/**
 * The repository's history for the Git graph (DESIGN §13.7): every local branch, remote branch and tag plus HEAD,
 * newest first in topological order, at most `limit` commits, with the state (and signature) it was read at.
 */
export async function readGitLog(repoPath: string, limit = GIT_LOG_DEFAULT_LIMIT): Promise<GitLogResponse> {
  const state = await readGitState(repoPath);
  const revs = ["--branches", "--remotes", "--tags", ...(state.head.hash ? ["HEAD"] : [])];
  const log = await git(
    repoPath,
    ["log", ...revs, "--topo-order", "--source", ...DECORATE_ARGS, `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, "--"],
    { readOnly: true, maxStdoutBytes: MAX_LOG_BYTES },
  );
  // A repository without any commit (no HEAD, no refs) has no history to show.
  if (log.code !== 0 && state.head.hash) throw new GitError(["log"], log.code, log.stderr);
  const all = log.code === 0 ? parseGitLog(log.stdout) : [];
  return { ...state, commits: all.slice(0, limit), hasMore: all.length > limit || !!log.truncated };
}

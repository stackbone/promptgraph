import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitLogResponseSchema, GitStateResponseSchema } from "@promptgraph/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseDecoration, parseGitLog, parseStatus, parseUpstream, readGitLog, readGitState } from "../src/git/log.js";
import { createHttpApp } from "../src/http/app.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { createTestDaemon, TEST_TOKEN } from "./support/test-daemon.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function repoWithHistory(): { repo: string; run: (...args: string[]) => string } {
  const { repo, cleanup } = createTempRepo();
  cleanups.push(cleanup);
  // Distinct, increasing dates, so the order of parallel branches is deterministic.
  let tick = 0;
  const run = (...args: string[]) => {
    const date = `${1_800_000_000 + tick++ * 60} +0000`;
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    return execFileSync("git", args, { cwd: repo, stdio: "pipe", env }).toString().trim();
  };
  run("checkout", "-qb", "feature");
  run("commit", "-q", "--allow-empty", "-m", "feature work");
  run("tag", "v1");
  run("checkout", "-q", "main");
  run("commit", "-q", "--allow-empty", "-m", "main work");
  run("merge", "-q", "--no-ff", "feature", "-m", "Merge feature");
  return { repo, run };
}

describe("parseDecoration", () => {
  it("classifies branches, remotes and tags and skips HEAD", () => {
    expect(parseDecoration("HEAD -> refs/heads/main")).toEqual({ kind: "branch", ref: "refs/heads/main", name: "main" });
    expect(parseDecoration("refs/remotes/origin/feat/x")).toEqual({ kind: "remote", ref: "refs/remotes/origin/feat/x", name: "origin/feat/x" });
    expect(parseDecoration("tag: refs/tags/v1.0")).toEqual({ kind: "tag", ref: "refs/tags/v1.0", name: "v1.0" });
    expect(parseDecoration("HEAD")).toBeNull();
    expect(parseDecoration("refs/promptgraph/run/lane")).toBeNull();
  });
});

describe("parseGitLog", () => {
  const h = (c: string) => c.repeat(40);
  const rec = (fields: string[]) => fields.join("\x1f") + "\x1e";

  it("parses records with parents, refs and subjects", () => {
    const out =
      rec([h("a"), `${h("b")} ${h("c")}`, "Ann", "ann@x", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", "main", "tag: refs/tags/v2, refs/heads/main, refs/remotes/origin/main", "Merge, with a comma"]) +
      "\n" +
      rec([h("b"), "", "Bob", "bob@x", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "main", "", "root"]);
    const commits = parseGitLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: h("a"), parents: [h("b"), h("c")], subject: "Merge, with a comma", authorName: "Ann", source: "main" });
    expect(commits[0]!.refs.map((r) => r.name)).toEqual(["main", "origin/main", "v2"]);
    expect(commits[1]).toMatchObject({ parents: [], refs: [] });
  });

  it("drops a truncated last record", () => {
    const out = rec([h("a"), "", "A", "a@x", "d", "d", "main", "", "one"]) + `${h("b")}\x1f\x1fA`;
    expect(parseGitLog(out).map((c) => c.hash)).toEqual([h("a")]);
  });
});

describe("parseStatus", () => {
  it("counts added, modified and deleted entries; a rename is one modified entry", () => {
    expect(parseStatus("?? new.txt\0A  staged.txt\0 M edit.txt\0D  gone.txt\0R  to.txt\0from.txt\0")).toEqual({ added: 2, modified: 2, deleted: 1 });
    expect(parseStatus("")).toEqual({ added: 0, modified: 0, deleted: 0 });
  });
});

describe("readGitLog", () => {
  it("reads branches, tags and HEAD in topological order (a merged branch before its base) without promptgraph refs", async () => {
    const { repo, run } = repoWithHistory();
    // A snapshot ref (§10) and a remote with a symbolic HEAD.
    const snapshot = run("commit-tree", "-p", "HEAD", "-m", "snapshot", "HEAD^{tree}");
    run("update-ref", "refs/promptgraph/run1/lane1", snapshot);
    run("update-ref", "refs/remotes/origin/main", "HEAD~1");
    run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const log = GitLogResponseSchema.parse(await readGitLog(repo));
    expect(log.head).toEqual({ ref: "refs/heads/main", hash: run("rev-parse", "HEAD"), upstream: null });
    expect(log.commits.map((c) => c.subject)).toEqual(["Merge feature", "feature work", "main work", "init"]);
    expect(log.commits.some((c) => c.hash === snapshot)).toBe(false);
    expect(log.commits[0]!.refs).toEqual([{ kind: "branch", ref: "refs/heads/main", name: "main" }]);
    expect(log.commits[1]!.refs.map((r) => r.name)).toEqual(["feature", "v1"]);
    expect(log.commits[2]!.refs).toEqual([{ kind: "remote", ref: "refs/remotes/origin/main", name: "origin/main" }]);
    expect(log.commits[0]!.parents).toHaveLength(2);
    expect(log.hasMore).toBe(false);
    expect(log.status).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it("limits the history and reports more", async () => {
    const { repo } = repoWithHistory();
    const log = await readGitLog(repo, 2);
    expect(log.commits).toHaveLength(2);
    expect(log.hasMore).toBe(true);
  });

  it("reports a detached HEAD and uncommitted changes", async () => {
    const { repo, run } = repoWithHistory();
    run("checkout", "-q", "--detach", "HEAD~1");
    fs.writeFileSync(path.join(repo, "new.txt"), "x");
    fs.writeFileSync(path.join(repo, "README.md"), "changed");
    const log = await readGitLog(repo);
    expect(log.head).toEqual({ ref: null, hash: run("rev-parse", "HEAD"), upstream: null });
    expect(log.status).toEqual({ added: 1, modified: 1, deleted: 0 });
  });

  it("returns an empty history for a repository without commits", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const log = await readGitLog(dir);
    expect(log).toMatchObject({ head: { ref: "refs/heads/main", hash: null }, commits: [], hasMore: false, status: { added: 0, modified: 0, deleted: 0 } });
  });
});

describe("parseUpstream", () => {
  it("reads the upstream and how far the branch is from it", () => {
    expect(parseUpstream("|")).toBeNull();
    expect(parseUpstream("")).toBeNull();
    expect(parseUpstream("origin/main|")).toEqual({ name: "origin/main", ahead: 0, behind: 0, gone: false });
    expect(parseUpstream("origin/main|[ahead 3]")).toEqual({ name: "origin/main", ahead: 3, behind: 0, gone: false });
    expect(parseUpstream("origin/main|[behind 12]")).toEqual({ name: "origin/main", ahead: 0, behind: 12, gone: false });
    expect(parseUpstream("up/feat|[ahead 1, behind 2]")).toEqual({ name: "up/feat", ahead: 1, behind: 2, gone: false });
    expect(parseUpstream("origin/old|[gone]")).toEqual({ name: "origin/old", ahead: 0, behind: 0, gone: true });
  });
});

describe("readGitState", () => {
  it("compares the checked-out branch with its upstream", async () => {
    const { repo, run } = repoWithHistory();
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
    run("remote", "add", "origin", dir);
    run("push", "-q", "-u", "origin", "main");
    expect((await readGitState(repo)).head.upstream).toEqual({ name: "origin/main", ahead: 0, behind: 0, gone: false });
    run("commit", "-q", "--allow-empty", "-m", "local 1");
    run("commit", "-q", "--allow-empty", "-m", "local 2");
    expect((await readGitState(repo)).head.upstream).toEqual({ name: "origin/main", ahead: 2, behind: 0, gone: false });
    run("checkout", "-q", "--detach");
    expect((await readGitState(repo)).head.upstream).toBeNull();
  });

  it("has a signature that changes with commits, refs and uncommitted changes only", async () => {
    const { repo, run } = repoWithHistory();
    const first = GitStateResponseSchema.parse(await readGitState(repo));
    expect(first.head.ref).toBe("refs/heads/main");
    expect((await readGitState(repo)).signature).toBe(first.signature);
    expect((await readGitLog(repo)).signature).toBe(first.signature);

    run("branch", "topic");
    const branched = (await readGitState(repo)).signature;
    expect(branched).not.toBe(first.signature);

    fs.writeFileSync(path.join(repo, "README.md"), "changed");
    const dirty = await readGitState(repo);
    expect(dirty.status.modified).toBe(1);
    expect(dirty.signature).not.toBe(branched);

    run("commit", "-qam", "change");
    expect((await readGitState(repo)).signature).not.toBe(dirty.signature);
  });

  it("ignores promptgraph snapshot refs", async () => {
    const { repo, run } = repoWithHistory();
    const before = (await readGitState(repo)).signature;
    run("update-ref", "refs/promptgraph/run1/lane1", "HEAD~1");
    expect((await readGitState(repo)).signature).toBe(before);
  });
});

describe("GET /api/repos/:repoId/git/log", () => {
  it("serves the log, validates the limit and requires credentials", async () => {
    const { repo } = repoWithHistory();
    const t = tempDir();
    cleanups.push(t.cleanup);
    const daemon = await createTestDaemon({ root: t.dir, repos: [repo], mockEngines: true, env: { PG_WEB_DIST: path.join(t.dir, "dist") } });
    cleanups.push(() => daemon.close());
    const app = createHttpApp(daemon.ctx);
    const R = `/api/repos/${daemon.repoIds[0]!}`;
    const headers = { host: "127.0.0.1:4777", authorization: `Bearer ${TEST_TOKEN}` };

    const res = await app.request(`${R}/git/log?limit=2`, { headers });
    expect(res.status).toBe(200);
    const body = GitLogResponseSchema.parse(await res.json());
    expect(body.commits.map((c) => c.subject)).toEqual(["Merge feature", "feature work"]);
    expect(body.hasMore).toBe(true);

    expect((await app.request(`${R}/git/log?limit=0`, { headers })).status).toBe(400);
    const state = GitStateResponseSchema.parse(await (await app.request(`${R}/git/state`, { headers })).json());
    expect(state.signature).toBe(body.signature);
    expect((await app.request(`${R}/git/log`, { headers: { host: headers.host } })).status).toBe(401);
  });
});

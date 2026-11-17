import { GitLogQuerySchema, type GitLogResponse, type GitStateResponse } from "@promptgraph/shared";
import { readGitLog, readGitState } from "../../git/log.js";
import { REPO_PREFIX, repoOf, type App } from "../repo-scope.js";

const P = REPO_PREFIX;

/** Under /api/repos/:repoId: GET …/git/log · GET …/git/state (the Git graph panel, DESIGN §13.7). */
export function registerGitRoutes(app: App): void {
  app.get(`${P}/git/log`, async (c) => {
    const { limit } = GitLogQuerySchema.parse(c.req.query());
    return c.json<GitLogResponse>(await readGitLog(repoOf(c).repo.path, limit));
  });
  app.get(`${P}/git/state`, async (c) => c.json<GitStateResponse>(await readGitState(repoOf(c).repo.path)));
}

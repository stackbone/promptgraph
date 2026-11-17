import { EMPTY_REPO_SETTINGS, NODE_TYPES, type NodeType, type RepoSettings } from "@promptgraph/shared";
import type { AppManager } from "../apps/app-manager.js";
import type { PgPaths } from "../config/paths.js";
import type { OwnedPtys } from "../pty/pty-manager.js";
import type { LaneManager } from "../workspace/lane-manager.js";
import { AppRunner } from "./app-runner.js";
import { ApprovalRunner } from "./approval-runner.js";
import type { ClaudeRunner } from "./claude/claude-runner.js";
import { ConditionRunner } from "./condition-runner.js";
import { LinearUpdateRunner, type LinearWriter } from "./linear-runner.js";
import { CommitRunner } from "./git/commit-runner.js";
import { MergeRunner } from "./git/merge-runner.js";
import { PrRunner } from "./git/pr-runner.js";
import { ShellRunner } from "./shell-runner.js";
import { TestRunner } from "./test-runner.js";
import type { RunnerRegistry } from "./types.js";

export interface RunnerRegistryDeps {
  claude: ClaudeRunner;
  ptys: OwnedPtys;
  lanes: LaneManager;
  paths: PgPaths;
  /** Base env for child processes; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The daemon's Linear connection (`linear` nodes, §24.5). */
  linear: LinearWriter;
  /** The repository's started applications (`app` nodes, §26.3). */
  apps: AppManager;
  /** The repository settings now (`app` / `test` nodes, §26.1); default: none configured. */
  repoSettings?: () => RepoSettings;
}

/** Node types createRunnerRegistry implements (GET /api/daemon `supportedNodeTypes`; Engine.supportedNodeTypes per repository). */
export const RUNNER_NODE_TYPES: readonly NodeType[] = NODE_TYPES.filter((t) =>
  (["prompt", "command", "shell", "app", "test", "commit", "merge", "pr", "approval", "condition", "linear"] as readonly string[]).includes(t),
);

/**
 * Maps every implemented node type to its runner (prompt/command share the ClaudeRunner; merge uses it
 * for conflicts; condition judges and linear proposals run headless claude; test runs its script through the
 * ShellRunner).
 */
export function createRunnerRegistry(deps: RunnerRegistryDeps): RunnerRegistry {
  const shell = new ShellRunner({ ptys: deps.ptys, paths: deps.paths, env: deps.env });
  const settings = deps.repoSettings ?? (() => EMPTY_REPO_SETTINGS);
  return {
    prompt: deps.claude,
    command: deps.claude,
    shell,
    app: new AppRunner({ apps: deps.apps, settings }),
    test: new TestRunner({ shell, ptys: deps.ptys, settings }),
    commit: new CommitRunner({ lanes: deps.lanes, env: deps.env }),
    merge: new MergeRunner({ lanes: deps.lanes, ptys: deps.ptys, claude: deps.claude, paths: deps.paths, env: deps.env }),
    pr: new PrRunner({ lanes: deps.lanes, env: deps.env }),
    approval: new ApprovalRunner(),
    condition: new ConditionRunner({ env: deps.env }),
    linear: new LinearUpdateRunner({ linear: deps.linear, env: deps.env }),
  };
}

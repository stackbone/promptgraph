import type { GraphNode, GraphNodeOf, NodeRunOutput, RepoCheck, RepoSettings } from "@promptgraph/shared";
import type { OwnedPtys } from "../pty/pty-manager.js";
import { stripAnsi } from "../util/text.js";
import type { ShellRunner } from "./shell-runner.js";
import type { NodeExecution, Runner, RunnerContext, RunnerResult } from "./types.js";

export interface TestRunnerDeps {
  shell: ShellRunner;
  ptys: OwnedPtys;
  /** The repository settings now (§26.1). */
  settings: () => RepoSettings;
  now?: () => number;
}

type CheckResult = NonNullable<NodeRunOutput["checks"]>[number];

/** Single-quotes a string for sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MARKER = "[promptgraph] check";
const START_RE = /^\[promptgraph\] check (\d+)\/\d+ running: /;
const END_RE = /^\[promptgraph\] check (\d+)\/\d+ (passed|failed \(exit (\d+)\))\s*$/;

/**
 * The script a `test` node runs (§26.3): every check in order, each in its directory (relative to the worktree), with
 * `timeout` when it has a timeout (exit 124), a start and an end marker line per check, and exit 1 when any failed.
 * Without `continueOnFailure` it stops at the first failure.
 */
export function testScript(checks: readonly RepoCheck[], continueOnFailure: boolean): string {
  const n = checks.length;
  const lines = ["pg_failed=0"];
  checks.forEach((c, i) => {
    const k = i + 1;
    const cmd = c.timeoutSec ? `timeout -k 5 ${c.timeoutSec} sh -c ${shQuote(c.run)}` : `sh -c ${shQuote(c.run)}`;
    const dir = c.cwd ? shQuote(c.cwd) : ".";
    lines.push(
      `printf '\\n\\033[1m%s\\033[0m\\n$ %s\\n\\n' ${shQuote(`${MARKER} ${k}/${n} running: ${c.name}`)} ${shQuote(c.run)}`,
      `(cd ${dir} && ${cmd}); pg_code=$?`,
      `if [ "$pg_code" -eq 0 ]; then printf '%s\\n' ${shQuote(`${MARKER} ${k}/${n} passed`)}; else printf '${MARKER} ${k}/${n} failed (exit %d)\\n' "$pg_code"; pg_failed=1; fi`,
    );
    if (!continueOnFailure && k < n) lines.push(`if [ "$pg_failed" -ne 0 ]; then exit 1; fi`);
  });
  lines.push(`exit "$pg_failed"`);
  return lines.join("\n");
}

/**
 * `test` nodes (DESIGN §26.3): run the selected checks of the repository settings in the lane through the
 * ShellRunner (one PTY, id = node run id) and report one result per check (`output.checks`, from the marker lines of
 * testScript, timed as they appear). Succeeds when every check passed.
 */
export class TestRunner implements Runner {
  constructor(private readonly deps: TestRunnerDeps) {}

  start(ctx: RunnerContext): NodeExecution {
    const node = ctx.node as GraphNodeOf<"test">;
    if (node.type !== "test") throw new Error(`TestRunner cannot run ${ctx.node.type} nodes`);
    const all = this.deps.settings().checks;
    const wanted = node.config.checks?.length ? node.config.checks : null;
    const checks = wanted ? all.filter((c) => wanted.includes(c.id)) : all;
    const noop = () => undefined;
    if (checks.length === 0) {
      const error = wanted ? `The repository settings have none of the checks ${wanted.join(", ")}` : "No test or check is configured in the repository settings";
      return { result: Promise.resolve({ status: "failed", error }), controls: { done: noop, fail: noop, setHold: noop, cancel: async () => undefined } };
    }

    const shellNode: GraphNode = {
      id: node.id,
      type: "shell",
      label: node.label,
      position: node.position,
      config: { run: testScript(checks, node.config.continueOnFailure) },
    };
    const exec = this.deps.shell.start({ ...ctx, node: shellNode });

    const now = this.deps.now ?? Date.now;
    const started = new Map<number, number>();
    const results = new Map<number, CheckResult>();
    let pending = "";
    const onLine = (line: string) => {
      const start = START_RE.exec(line);
      if (start) {
        const k = Number(start[1]);
        started.set(k, now());
        const check = checks[k - 1];
        if (check) ctx.update({ activity: `Running ${check.name}` });
        return;
      }
      const end = END_RE.exec(line);
      if (!end) return;
      const k = Number(end[1]);
      const check = checks[k - 1];
      if (!check) return;
      const t0 = started.get(k);
      const passed = end[2] === "passed";
      results.set(k, { id: check.id, name: check.name, status: passed ? "passed" : "failed", exitCode: passed ? 0 : Number(end[3]), durationMs: t0 === undefined ? null : now() - t0 });
    };
    const handle = this.deps.ptys.get(ctx.nodeRun.id);
    const off = handle?.onData((chunk) => {
      pending += stripAnsi(chunk.toString("utf8"));
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() ?? "";
      for (const p of parts) onLine(p.trim());
    });

    const result = exec.result.then((r): RunnerResult => {
      off?.();
      if (pending.trim()) onLine(pending.trim());
      if (r.status === "cancelled") return r;
      const list: CheckResult[] = checks.map(
        (c, i) => results.get(i + 1) ?? { id: c.id, name: c.name, status: "skipped", exitCode: null, durationMs: null },
      );
      const output = { ...(r.output ?? {}), checks: list };
      const failed = list.filter((c) => c.status === "failed");
      if (r.status === "succeeded" && failed.length === 0) {
        return { status: "succeeded", output: { ...output, text: `${list.length === 1 ? "The check" : `All ${list.length} checks`} passed` } };
      }
      const error =
        failed.length > 0
          ? `${failed.length} of ${list.length} check${list.length === 1 ? "" : "s"} failed: ${failed.map((c) => c.name).join(", ")}`
          : r.status === "failed"
            ? r.error
            : "The checks did not finish";
      return { status: "failed", error, output };
    });
    return { result, controls: exec.controls };
  }
}

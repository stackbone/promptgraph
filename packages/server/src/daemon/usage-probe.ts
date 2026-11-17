import { execFile } from "node:child_process";
import type { UsageWindow } from "@promptgraph/shared";
import { childEnv, claudeBin } from "../config/child-env.js";
import { errorMessage } from "../util/text.js";
import type { UsageLimitsTracker } from "./usage-limits.js";

/**
 * Usage limits on demand (DESIGN §23.3): `claude -p /usage` answers locally, without a model call (no tokens, about
 * 2 s), with the same text the `/usage` command shows. The text is not a documented format, so parsing is strict and a
 * text it cannot read changes nothing: the limits then come only from the chat's `rate_limit_event` lines.
 */

const PROBE_TIMEOUT_MS = 30_000;
/** A refresh within this time of the last probe reuses it (rapid clicks, several clients opening at once). */
const MIN_INTERVAL_MS = 30_000;
/** Probes triggered by activity (a Claude node finished a turn) are spaced at least this much. */
const AUTO_INTERVAL_MS = 2 * 60_000;

/**
 * Bare call (as the run brief's, §13.6): no tools, no CLAUDE.md, skills, plugins, hooks or MCP servers, no transcript.
 * `/usage` is the positional prompt so the fake CLI of the tests can answer it before logging a session.
 */
export const USAGE_PROBE_ARGS = ["-p", "/usage", "--output-format", "json", "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"];

/** Runs `claude -p /usage`; resolves the text it printed (`result` of the JSON envelope) or rejects. */
export type UsageProbeRunner = (env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;

export const runUsageCommand: UsageProbeRunner = (env, cwd) =>
  new Promise((resolve, reject) => {
    execFile(claudeBin(env), USAGE_PROBE_ARGS, { env: childEnv({}, env), cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("The claude command was not found on PATH"));
      const lines = stdout.trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown };
          if (parsed.type !== "result") continue;
          if (parsed.is_error || typeof parsed.result !== "string") return reject(new Error("claude /usage returned an error"));
          return resolve(parsed.result);
        } catch {
          // Not JSON: keep looking.
        }
      }
      reject(err ?? new Error("claude /usage printed no result"));
    });
  });

/** Title of a `/usage` line → window name of `rate_limit_info` (Claude Code 2.1.326). */
function windowName(title: string): string | null {
  if (title === "Current session") return "five_hour";
  if (title === "Current week (all models)") return "seven_day";
  const scoped = /^Current week \((.+?)(?: only)?\)$/.exec(title);
  if (!scoped) return null;
  const model = scoped[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return model ? `seven_day_${model}` : null;
}

const LINE = /^(Current [^:]+): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** `Nov 18, 1pm (Europe/Madrid)`, `Nov 18, 12:59pm (…)`, `Jan 2, 2027, 1pm (…)`; the zone is optional. */
const RESET = /^([A-Za-z]{3}) (\d{1,2}), (?:(\d{4}), )?(\d{1,2})(?::(\d{2}))?\s?([ap]m)(?: \(([^)]+)\))?$/i;

/**
 * The usage windows of a `/usage` text; null when it has none (not a subscription, an unknown format). Utilization
 * is a fraction like `rate_limit_info`'s; a window at 100% or more is `rejected`.
 */
export function parseUsageText(text: string, now: number): Record<string, UsageWindow> | null {
  const windows: Record<string, UsageWindow> = {};
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const name = windowName(m[1]!);
    if (!name) continue;
    const utilization = Number(m[2]) / 100;
    windows[name] = { utilization, resetsAt: m[3] ? parseResetTime(m[3].trim(), now) : null, status: utilization >= 1 ? "rejected" : null };
  }
  return Object.keys(windows).length > 0 ? windows : null;
}

/** Epoch ms of a reset time as `/usage` prints it; null when it cannot be read. Without a year: the current one. */
export function parseResetTime(text: string, now: number): number | null {
  const m = RESET.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month === -1) return null;
  const day = Number(m[2]);
  let hour = Number(m[4]);
  const minute = m[5] ? Number(m[5]) : 0;
  if (hour < 1 || hour > 12 || minute > 59 || day < 1 || day > 31) return null;
  if (m[6]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (m[6]!.toLowerCase() === "am" && hour === 12) hour = 0;
  const zone = m[7] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const year = m[3] ? Number(m[3]) : zonedParts(now, zone).year;
    return zonedTimeToEpoch(year, month, day, hour, minute, zone);
  } catch {
    return null; // An unknown time zone.
  }
}

function zonedParts(epoch: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The instant whose wall time in `zone` is the given one (two passes, so a DST change between guess and result is honoured). */
function zonedTimeToEpoch(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (epoch: number) => {
    const p = zonedParts(epoch, zone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000;
  };
  let epoch = wall - offsetAt(wall);
  epoch = wall - offsetAt(epoch);
  return epoch;
}

/**
 * Asks Claude Code for the usage limits and hands them to the tracker. Concurrent refreshes share one probe; a refresh
 * shortly after the last one reuses it. Failures are kept as `lastError` and change nothing.
 */
export class UsageProbe {
  private pending: Promise<void> | null = null;
  private lastAt = 0;
  lastError: string | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly tracker: UsageLimitsTracker,
    private readonly opts: { run?: UsageProbeRunner; cwd: () => string; now?: () => number },
  ) {}

  /** Probes unless one ran within the minimum interval (`auto`: the longer interval of activity-triggered probes). */
  refresh(opts: { auto?: boolean } = {}): Promise<void> {
    if (this.pending) return this.pending;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastAt < (opts.auto ? AUTO_INTERVAL_MS : MIN_INTERVAL_MS)) return Promise.resolve();
    this.lastAt = now;
    const run = this.opts.run ?? runUsageCommand;
    this.pending = run(this.env, this.opts.cwd())
      .then((text) => {
        const windows = parseUsageText(text, (this.opts.now ?? Date.now)());
        this.lastError = windows ? null : "claude /usage reported no usage limits";
        if (windows) this.tracker.observeSnapshot(windows);
      })
      .catch((err: unknown) => {
        this.lastError = errorMessage(err);
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageLimits } from "@promptgraph/shared";
import { describe, expect, it } from "vitest";
import { UsageLimitsTracker } from "../src/daemon/usage-limits.js";
import { parseResetTime, parseUsageText, runUsageCommand, UsageProbe } from "../src/daemon/usage-probe.js";
import { EventBus } from "../src/events/bus.js";
import { openDatabase, Store } from "../src/store/store.js";

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude");

/** Nov 17 2026, 08:00 UTC (09:00 in Madrid). */
const NOW = Date.UTC(2026, 10, 17, 8, 0);

/** As printed by Claude Code 2.1.326 (`claude -p /usage`), with the session window added. */
const TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 12% used · resets 2pm (Europe/Madrid)
Current week (all models): 59% used · resets Nov 18, 12:59pm (Europe/Madrid)
Current week (Sonnet only): 3% used · resets Nov 18, 1pm (Europe/Madrid)
Current week (Fable): 100% used · resets Jan 2, 2027, 1am (Europe/Madrid)

What's contributing to your usage?
Last 24h · 3976 requests · 25 sessions
  82%  Review sessions active over many hours · whole sessions with requests in 8 or more separate hours`;

describe("parseResetTime (DESIGN §23.3)", () => {
  it("reads the date forms of /usage in their time zone", () => {
    expect(parseResetTime("Nov 18, 12:59pm (Europe/Madrid)", NOW)).toBe(Date.UTC(2026, 10, 18, 11, 59));
    expect(parseResetTime("Nov 18, 1pm (UTC)", NOW)).toBe(Date.UTC(2026, 10, 18, 13, 0));
    expect(parseResetTime("Jan 2, 2027, 12am (America/New_York)", NOW)).toBe(Date.UTC(2027, 0, 2, 5, 0));
    // Summer time: Madrid is UTC+2.
    expect(parseResetTime("Jul 1, 12pm (Europe/Madrid)", NOW)).toBe(Date.UTC(2026, 6, 1, 10, 0));
  });

  it("returns null for a time it cannot read", () => {
    expect(parseResetTime("2pm (Europe/Madrid)", NOW)).toBeNull();
    expect(parseResetTime("Foo 18, 1pm (UTC)", NOW)).toBeNull();
    expect(parseResetTime("Nov 18, 1pm (Not/AZone)", NOW)).toBeNull();
    expect(parseResetTime("Nov 18, 13pm (UTC)", NOW)).toBeNull();
  });
});

describe("parseUsageText", () => {
  it("maps each line to the window names of rate_limit_info, as fractions", () => {
    expect(parseUsageText(TEXT, NOW)).toEqual({
      five_hour: { utilization: 0.12, resetsAt: null, status: null },
      seven_day: { utilization: 0.59, resetsAt: Date.UTC(2026, 10, 18, 11, 59), status: null },
      seven_day_sonnet: { utilization: 0.03, resetsAt: Date.UTC(2026, 10, 18, 12, 0), status: null },
      seven_day_fable: { utilization: 1, resetsAt: Date.UTC(2027, 0, 2, 0, 0), status: "rejected" },
    });
  });

  it("returns null without usage lines (an API key, an unknown format)", () => {
    expect(parseUsageText("You are currently using your subscription to power your Claude Code usage", NOW)).toBeNull();
    expect(parseUsageText("", NOW)).toBeNull();
  });
});

function tracker(now = () => NOW) {
  const store = new Store(openDatabase(":memory:"));
  const bus = new EventBus();
  const emitted: UsageLimits[] = [];
  bus.on("usage:limits", ({ limits }) => emitted.push(limits));
  return { tracker: new UsageLimitsTracker(store, bus, now), emitted };
}

describe("UsageProbe", () => {
  it("replaces the windows with the probe's, keeps the overage and spaces the probes", async () => {
    let now = NOW;
    const { tracker: t, emitted } = tracker(() => now);
    t.observe({ status: "allowed_warning", overageStatus: "rejected", unifiedWindows: { seven_day_opus: { utilization: 0.5, resetsAt: NOW / 1000 + 3600 } } });
    let calls = 0;
    let release!: () => void;
    const probe = new UsageProbe({}, t, {
      cwd: () => "/",
      now: () => now,
      run: () => {
        calls++;
        return new Promise((resolve) => (release = () => resolve(TEXT)));
      },
    });

    const a = probe.refresh();
    const b = probe.refresh();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(t.current()).toMatchObject({ status: "rejected", overage: { status: "rejected", inUse: false }, observedAt: NOW });
    expect(Object.keys(t.current()!.windows).sort()).toEqual(["five_hour", "seven_day", "seven_day_fable", "seven_day_sonnet"]);
    expect(emitted).toHaveLength(2);

    now += 10_000;
    await probe.refresh();
    expect(calls).toBe(1);
    now += 30_000;
    await probe.refresh({ auto: true });
    expect(calls).toBe(1);
    const next = probe.refresh();
    release();
    await next;
    expect(calls).toBe(2);
  });

  it("keeps the limits and records the error when the probe fails or reads nothing", async () => {
    let now = NOW;
    const { tracker: t, emitted } = tracker(() => now);
    let result: Promise<string> = Promise.reject(new Error("boom"));
    const probe = new UsageProbe({}, t, { cwd: () => "/", now: () => now, run: () => result });
    await probe.refresh();
    expect(probe.lastError).toBe("boom");
    now += 60_000;
    result = Promise.resolve("Not a subscription");
    await probe.refresh();
    expect(probe.lastError).toMatch(/no usage limits/);
    expect(t.current()).toBeNull();
    expect(emitted).toEqual([]);
  });
});

describe("runUsageCommand", () => {
  it("reads the result of `claude -p /usage --output-format json` (fake CLI)", async () => {
    const env = { ...process.env, PG_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_USAGE_TEXT: "Current session: 7% used" };
    await expect(runUsageCommand(env, process.cwd())).resolves.toBe("Current session: 7% used");
  });
});

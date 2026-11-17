// @vitest-environment jsdom
import type { ClaudeAuthInfo, UsageLimits } from "@promptgraph/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonApi } from "../../api/rest";
import { createDispatcher } from "../../store/dispatcher";
import { useDaemonStore } from "../../store/daemon-store";
import { createTestView } from "../../store/view/test-view";
import { BillingBadge, TICKER_ROTATE_MS, UsageTicker } from "./BillingBadge";

const NOW = Date.now();

function authOf(patch: Partial<ClaudeAuthInfo> = {}): ClaudeAuthInfo {
  return {
    billingMode: "subscription",
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    apiKeySource: null,
    plan: "max",
    planTier: "max_20x",
    apiKeyOverridesLogin: false,
    error: null,
    checkedAt: NOW,
    ...patch,
  };
}

const LIMITS: UsageLimits = {
  status: "allowed",
  windows: {
    seven_day: { utilization: 0.1, resetsAt: NOW + 3 * 86_400_000, status: "allowed" },
    five_hour: { utilization: 0.85, resetsAt: NOW + 3_600_000, status: "allowed_warning" },
  },
  overage: null,
  observedAt: NOW - 60_000,
};

function renderBadge(auth: ClaudeAuthInfo) {
  const claudeAuth = vi.fn(async () => auth);
  const view = createTestView({ api: { claudeAuth } });
  view.render(<BillingBadge />);
  return { view, claudeAuth };
}

beforeEach(() => {
  useDaemonStore.setState({ usageLimits: null, usageLimitsChecking: false });
  vi.spyOn(daemonApi, "usageLimits").mockResolvedValue({ limits: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BillingBadge (DESIGN §23.4)", () => {
  it("shows the plan, and on open re-checks and shows the usage windows in order", async () => {
    vi.spyOn(daemonApi, "refreshUsageLimits").mockResolvedValue({ limits: null });
    const { claudeAuth } = renderBadge(authOf());
    const trigger = await screen.findByRole("button", { name: "Claude billing: Max 20x" });
    expect(claudeAuth).toHaveBeenCalledWith(false);

    act(() => useDaemonStore.getState().applyUsageLimits(LIMITS));
    // A window at 85% turns the badge into a warning.
    expect(trigger.className).toContain("text-amber-700");
    await userEvent.setup().click(trigger);
    expect(claudeAuth).toHaveBeenLastCalledWith(true);
    const meters = await screen.findAllByRole("meter");
    expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
      ["5-hour usage", "85"],
      ["Weekly usage", "10"],
    ]);
    expect(screen.getByText(/Costs are shown as an API-price equivalent/)).toBeTruthy();
  });

  it("asks the daemon for the limits on mount when it has none, and again when opened", async () => {
    const refresh = vi.spyOn(daemonApi, "refreshUsageLimits").mockResolvedValue({ limits: { ...LIMITS, observedAt: Date.now() } });
    renderBadge(authOf());
    const trigger = await screen.findByRole("button", { name: "Claude billing: Max 20x" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useDaemonStore.getState().usageLimits?.windows.five_hour?.utilization).toBe(0.85));
    await userEvent.setup().click(trigger);
    expect(await screen.findAllByRole("meter")).toHaveLength(2);
    expect(screen.getByText(/Last checked/)).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("does not check the limits on mount while they are fresh, nor without a subscription", async () => {
    const refresh = vi.spyOn(daemonApi, "refreshUsageLimits").mockResolvedValue({ limits: null });
    useDaemonStore.setState({ usageLimits: { ...LIMITS, observedAt: Date.now() } });
    renderBadge(authOf());
    await screen.findByRole("button", { name: "Claude billing: Max 20x" });
    cleanup();
    useDaemonStore.setState({ usageLimits: null });
    renderBadge(authOf({ billingMode: "api", authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY", plan: null, planTier: null }));
    await screen.findByRole("button", { name: "Claude billing: API key" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("warns when an API key overrides a claude.ai login and shows no usage limits", async () => {
    renderBadge(authOf({ billingMode: "api", authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY", plan: null, planTier: null, apiKeyOverridesLogin: true }));
    const trigger = await screen.findByRole("button", { name: "Claude billing: API key" });
    await userEvent.setup().click(trigger);
    expect((await screen.findByRole("alert")).textContent).toContain("ANTHROPIC_API_KEY");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("renders nothing until the check answers", () => {
    const view = createTestView({ api: { claudeAuth: () => new Promise(() => undefined) } });
    view.render(<BillingBadge />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("UsageTicker", () => {
  it("rotates through every reported window every 20 s, whatever the plan", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      render(<UsageTicker limits={LIMITS} />);
      const ticker = screen.getByTestId("usage-ticker");
      // Display order: the 5-hour window first (shown on Max too: only an unreported window is left out).
      expect(ticker.textContent).toBe(`5h${"━".repeat(9)}${"─".repeat(1)}85% · 1h 0m`);
      act(() => vi.advanceTimersByTime(TICKER_ROTATE_MS));
      expect(ticker.textContent).toBe(`week${"━".repeat(1)}${"─".repeat(9)}10% · 2d 23h`);
      act(() => vi.advanceTimersByTime(TICKER_ROTATE_MS));
      expect(ticker.textContent).toContain("5h");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing without reported windows", () => {
    render(<UsageTicker limits={{ ...LIMITS, windows: {} }} />);
    expect(screen.queryByTestId("usage-ticker")).toBeNull();
  });
});

describe("usage:limits", () => {
  it("is applied to the daemon store by the dispatcher", async () => {
    createDispatcher().handle({ type: "usage:limits", limits: LIMITS });
    await waitFor(() => expect(useDaemonStore.getState().usageLimits).toEqual(LIMITS));
  });
});

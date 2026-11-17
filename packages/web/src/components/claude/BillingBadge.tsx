import { billingModeLabel, usageWindowShortLabel, usageWindowsOf, type ClaudeAuthInfo, type UsageLimits } from "@promptgraph/shared";
import { AlertTriangleIcon, CloudIcon, CreditCardIcon, GaugeIcon, KeyRoundIcon, RefreshCwIcon, UserXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { formatDateTime, formatDuration, formatTimeLeft } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useDaemonStore } from "../../store/daemon-store";
import { getRepoCache, useRepoCache } from "../../store/repo-cache";
import { useView } from "../../store/view/context";
import { Button } from "../common/ui";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** A window above this fraction is shown as a warning. */
const WARN_UTILIZATION = 0.8;
/** Limits older than this are checked again when the badge mounts. */
const STALE_LIMITS_MS = 5 * 60_000;
/** The badge's ticker shows the next usage window after this long. */
export const TICKER_ROTATE_MS = 20_000;
/** Segments of the ticker's bar. */
const TICKER_SEGMENTS = 10;

/**
 * Header badge (DESIGN §23.4): how Claude is billed in this repository (subscription plan, API key, cloud) and, on a
 * subscription, the last observed usage limits. Mounting it checks the limits when they are missing or stale; opening it
 * re-checks `claude auth status` and the limits (the daemon spaces the checks).
 */
export function BillingBadge() {
  const { repoId } = useView();
  const auth = useRepoCache(repoId, (s) => s.claudeAuth);
  const limits = useDaemonStore((s) => s.usageLimits);
  const subscription = auth?.billingMode === "subscription";
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void getRepoCache(repoId).getState().loadClaudeAuth();
    void useDaemonStore.getState().loadUsageLimits();
  }, [repoId]);

  useEffect(() => {
    if (!subscription) return;
    const { usageLimits } = useDaemonStore.getState();
    if (!usageLimits || Date.now() - usageLimits.observedAt > STALE_LIMITS_MS) void useDaemonStore.getState().refreshUsageLimits();
  }, [subscription]);

  const refresh = async () => {
    setRefreshing(true);
    const usage = subscription ? useDaemonStore.getState().refreshUsageLimits() : Promise.resolve();
    await Promise.all([getRepoCache(repoId).getState().loadClaudeAuth(true), usage]);
    setRefreshing(false);
  };

  if (!auth) return null;
  const warn = needsAttention(auth, limits);
  const label = billingModeLabel(auth);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Claude billing: ${label}`}
          className={cn("gap-1.5", warn ? "text-amber-700" : "text-muted-foreground")}
        >
          {warn ? <AlertTriangleIcon /> : <ModeIcon auth={auth} />}
          <span className="hidden lg:inline">{label}</span>
          {auth.billingMode === "subscription" && <UsageTicker limits={limits} />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-3 text-sm">
        <div className="flex items-start gap-2">
          <ModeIcon auth={auth} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{label}</div>
            <p className="text-xs text-muted-foreground">{modeDescription(auth)}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Check again" title="Check again" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
        {auth.apiKeyOverridesLogin && (
          <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700">
            You are signed in to claude.ai, but <code>{auth.apiKeySource ?? "an API key"}</code> is set in promptgraph's environment.
            Chat and generated messages use the key and are billed to the API; node terminals ask once whether to use it. To use your
            subscription, remove the key from your shell profile and restart promptgraph (<code>promptgraph stop</code>).
          </p>
        )}
        {auth.error && <p className="text-xs text-destructive">Could not check: {auth.error}</p>}
        {auth.billingMode === "subscription" && <UsageLimitsView limits={limits} />}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One usage window at a time, next to the plan: `week ━━━━━━──── 59% · 1d 4h` (name, bar, utilization, time to
 * reset). Rotates through the windows every TICKER_ROTATE_MS; the full list is in the popover.
 */
export function UsageTicker({ limits }: { limits: UsageLimits | null }) {
  const now = useNow(limits !== null);
  const windows = limits ? usageWindowsOf(limits, now) : [];
  const [index, setIndex] = useState(0);
  const count = windows.length;
  useEffect(() => {
    if (count < 2) return;
    const timer = setInterval(() => setIndex((i) => i + 1), TICKER_ROTATE_MS);
    return () => clearInterval(timer);
  }, [count]);
  if (count === 0) return null;
  const { name, window } = windows[index % count]!;
  const pct = Math.min(100, Math.round(window.utilization * 100));
  const filled = Math.min(TICKER_SEGMENTS, Math.round(window.utilization * TICKER_SEGMENTS));
  const high = window.utilization >= WARN_UTILIZATION || window.status === "rejected";
  return (
    <span data-testid="usage-ticker" aria-hidden className="hidden items-center gap-1.5 font-mono text-[11px] md:inline-flex">
      <span>{usageWindowShortLabel(name)}</span>
      <span className="tracking-[-0.15em]">
        <span className={high ? "text-amber-600" : "text-primary"}>{"━".repeat(filled)}</span>
        <span className="text-muted-foreground/40">{"─".repeat(TICKER_SEGMENTS - filled)}</span>
      </span>
      <span>
        {pct}%{window.resetsAt !== null && ` · ${formatTimeLeft(window.resetsAt - now)}`}
      </span>
    </span>
  );
}

function ModeIcon({ auth }: { auth: ClaudeAuthInfo }) {
  const className = "size-4 shrink-0";
  switch (auth.billingMode) {
    case "subscription":
      return <GaugeIcon className={className} />;
    case "api":
      return <KeyRoundIcon className={className} />;
    case "cloud":
      return <CloudIcon className={className} />;
    case "none":
      return <UserXIcon className={className} />;
    default:
      return <CreditCardIcon className={className} />;
  }
}

function modeDescription(auth: ClaudeAuthInfo): string {
  switch (auth.billingMode) {
    case "subscription":
      return "Claude subscription: runs count against your plan's usage limits. Costs are shown as an API-price equivalent (≈).";
    case "api":
      return `Anthropic API key (${auth.apiKeySource ?? auth.authMethod}): every token is billed at API prices.`;
    case "cloud":
      return "Billed by your cloud provider. Costs are estimated at Anthropic list prices.";
    case "none":
      return "Claude Code is not signed in: run `claude` in a terminal and sign in.";
    default:
      return `Authenticated with ${auth.authMethod}: billing depends on that token (often an LLM gateway).`;
  }
}

function needsAttention(auth: ClaudeAuthInfo, limits: UsageLimits | null): boolean {
  if (auth.apiKeyOverridesLogin || auth.billingMode === "none") return true;
  if (auth.billingMode !== "subscription" || !limits) return false;
  return limits.status !== "allowed" || Object.values(limits.windows).some((w) => w.utilization >= WARN_UTILIZATION);
}

/** The last observed usage windows; observations, so their age is shown. */
export function UsageLimitsView({ limits }: { limits: UsageLimits | null }) {
  const now = useNow(limits !== null);
  const checking = useDaemonStore((s) => s.usageLimitsChecking);
  const windows = limits ? usageWindowsOf(limits, now) : [];
  if (!limits || windows.length === 0) {
    return <p className="text-xs text-muted-foreground">{checking ? "Checking usage limits…" : "No usage limits reported yet."}</p>;
  }
  return (
    <div className="space-y-2">
      {limits.status === "rejected" && <p className="text-xs font-medium text-destructive">Usage limit reached: Claude will refuse new turns until it resets.</p>}
      {windows.map(({ name, label, window }) => {
        const pct = Math.min(100, Math.round(window.utilization * 100));
        const high = window.utilization >= WARN_UTILIZATION || window.status === "rejected";
        return (
          <div key={name} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span>{label}</span>
              <span className={cn("font-mono", high ? "text-amber-700" : "text-muted-foreground")}>{pct}%</span>
            </div>
            <div
              role="meter"
              aria-label={`${label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className={cn("h-full rounded-full", high ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
            </div>
            {window.resetsAt !== null && <div className="text-[11px] text-muted-foreground">Resets {formatDateTime(window.resetsAt)}</div>}
          </div>
        );
      })}
      {limits.overage?.inUse && <p className="text-xs text-amber-700">Using extra usage beyond your plan.</p>}
      <p className="text-[11px] text-muted-foreground">Last checked {formatDuration(Math.max(0, now - limits.observedAt))} ago.</p>
    </div>
  );
}

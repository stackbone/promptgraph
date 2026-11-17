import { nodeDisplayLabel, type GraphNode, type NodeStatus, type RunBriefEntry, type RunStatus } from "@promptgraph/shared";
import type { ReactNode } from "react";
import { formatTime } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { NODE_STATUS_STYLE, RUN_STATUS_STYLE } from "../../lib/status-style";
import { useRun, useView } from "../../store/view/context";
import { Icons } from "../common/icons";
import { Section } from "../common/ui";

const EMPTY: RunBriefEntry[] = [];

/** Dot colour of an entry: how its step (NodeStatus) or the run (RunStatus) ended. */
function outcomeDot(entry: RunBriefEntry): string {
  if (entry.kind !== "node") return RUN_STATUS_STYLE[entry.outcome as RunStatus]?.dot ?? "bg-muted-foreground";
  return NODE_STATUS_STYLE[entry.outcome as NodeStatus]?.dot ?? "bg-muted-foreground";
}

export function briefStepLabel(entry: RunBriefEntry, nodes: readonly GraphNode[] | undefined): string {
  const node = entry.nodeId ? nodes?.find((n) => n.id === entry.nodeId) : undefined;
  return node ? nodeDisplayLabel(node) : (entry.nodeId ?? "");
}

/**
 * The entries of a run brief (DESIGN §13.6) as a timeline, oldest first. `step` renders the name of a step entry
 * (a button or a link to the node); the run entry is labelled with the run's result.
 */
export function BriefTimeline({ entries, step }: { entries: readonly RunBriefEntry[]; step: (entry: RunBriefEntry) => ReactNode }) {
  return (
    <ol className="relative space-y-4 border-l border-border pl-4" aria-label="Run brief">
      {entries.map((entry) => (
        <li key={entry.id} className="relative" data-testid="brief-entry">
          <span className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-background ${outcomeDot(entry)}`} />
          <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
            {entry.kind === "run" ? (
              <span className="font-semibold text-foreground/80">Run {RUN_STATUS_STYLE[entry.outcome as RunStatus]?.label.toLowerCase() ?? entry.outcome}</span>
            ) : (
              step(entry)
            )}
            <span className="ml-auto shrink-0 tabular-nums">{formatTime(entry.createdAt)}</span>
          </div>
          {entry.status === "pending" && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icons.refresh className="size-3 animate-spin" /> Summarising…
            </p>
          )}
          {entry.status === "failed" && <p className="mt-1 text-xs text-muted-foreground italic">No summary: {entry.error}</p>}
          {entry.status === "ready" && (
            <>
              <p className="mt-0.5 text-sm font-medium text-foreground">{entry.title}</p>
              {entry.summary && <Markdown text={entry.summary} className="mt-1 text-xs! text-foreground/85" />}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The run's current status in the run inspector (DESIGN §13.6, brief entries of kind "status"): the newest ready
 * one, rewritten after every step; *Updating…* while a newer one is being written. Renders nothing before the
 * first one.
 */
export function RunStatusBrief() {
  const entries = useRun((s) => s.detail?.brief ?? EMPTY);
  const statuses = entries.filter((e) => e.kind === "status");
  const current = statuses.filter((e) => e.status === "ready").at(-1);
  const updating = statuses.at(-1)?.status === "pending";
  if (!current && !updating) return null;
  return (
    <Section title="Status">
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2" data-testid="brief-status" aria-label="Run status">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {current && <span className={`size-2 shrink-0 rounded-full ${outcomeDot(current)}`} />}
          <span className="font-semibold text-foreground/80">Now</span>
          {updating ? (
            <span className="ml-auto flex items-center gap-1">
              <Icons.refresh className="size-3 animate-spin" /> Updating…
            </span>
          ) : (
            current && <span className="ml-auto shrink-0 tabular-nums">{formatTime(current.updatedAt)}</span>
          )}
        </div>
        {current ? (
          <>
            <p className="mt-0.5 text-sm font-medium text-foreground">{current.title}</p>
            {current.summary && <Markdown text={current.summary} className="mt-1 text-xs! text-foreground/85" />}
          </>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">Writing the status…</p>
        )}
      </div>
    </Section>
  );
}

/**
 * The run brief in the run inspector (nothing selected): the timeline of the steps and the closing entry (the
 * current status is RunStatusBrief, above the usage); follows the run live (`brief:update`). Clicking a step's
 * name selects its node.
 */
export function RunBrief() {
  const view = useView();
  const enabled = useRun((s) => s.detail?.run.graphSnapshot.settings.brief.enabled ?? false);
  const nodes = useRun((s) => s.detail?.run.graphSnapshot.nodes);
  const all = useRun((s) => s.detail?.brief ?? EMPTY);
  const entries = all.filter((e) => e.kind !== "status");
  if (!enabled && all.length === 0) {
    return (
      <Section title="Brief">
        <p className="text-xs text-muted-foreground">
          Turn on <span className="font-medium">Run brief</span> in the graph settings to get a short summary of each step as the run goes.
        </p>
      </Section>
    );
  }
  return (
    <Section title="Brief">
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Each step gets a summary here when it finishes.</p>
      ) : (
        <BriefTimeline
          entries={entries}
          step={(entry) => (
            <button type="button" className="truncate font-semibold text-foreground/80 hover:underline" onClick={() => view.run.getState().selectNode(entry.nodeId)}>
              {briefStepLabel(entry, nodes)}
            </button>
          )}
        />
      )}
    </Section>
  );
}

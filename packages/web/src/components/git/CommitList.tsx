import type { GitRef, GitWorktreeStatus } from "@promptgraph/shared";
import { ArrowDownIcon, ArrowUpIcon, CircleDotIcon, GitBranchIcon, TagIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../../lib/format";
import type { GitGraphModel } from "../../lib/git-log";
import { useTheme } from "../../lib/theme";
import { GraphCell, ROW_HEIGHT } from "./GraphCell";

/** Rows rendered above and below the visible ones, so a scroll never shows an empty gap. */
const OVERSCAN = 12;
/** At most this many lanes are drawn; wider rows are clipped (rare, and the text matters more). */
const MAX_COLUMNS = 12;
/** Rows from the end at which the next page of history is requested. */
const LOAD_MORE_THRESHOLD = 40;

/** Lane colours: the app's 400 shades in the dark theme, 600 in the light one. */
const LANE_COLOURS = {
  dark: ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#2dd4bf", "#fb923c", "#f87171"],
  light: ["#2563eb", "#059669", "#d97706", "#db2777", "#7c3aed", "#0d9488", "#ea580c", "#dc2626"],
} as const;

/**
 * The Git graph's commit list (DESIGN §13.7): virtualised (only the rows in view, plus OVERSCAN, are in the DOM; rows
 * have a fixed height), each row its graph cell, ref badges, subject and date. A listbox: click or ↑/↓ select, Esc
 * clears. Asks for more history (`onNearEnd`) when the view nears the last row. The checked-out commit (HEAD) is
 * highlighted; while it is scrolled out of view a pill at that edge jumps back to it, as does a new `revealHead`.
 */
export function CommitList({
  model,
  status,
  selected,
  onSelect,
  onNearEnd,
  headName,
  revealHead = 0,
}: {
  model: GitGraphModel;
  status: GitWorktreeStatus;
  selected: number | null;
  onSelect(index: number | null): void;
  onNearEnd(): void;
  /** Short name of the checked-out branch; null when HEAD is detached. */
  headName: string | null;
  /** Bumped to scroll HEAD into the middle of the view. */
  revealHead?: number;
}) {
  const theme = useTheme();
  const colours = LANE_COLOURS[theme];
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);
  const count = model.items.length;
  const columns = Math.min(Math.max(model.layout.width, 1), MAX_COLUMNS);
  const headIndex = model.items.findIndex((it) => it.kind === "commit" && it.isHead);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setViewHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    if (last >= count - LOAD_MORE_THRESHOLD) onNearEnd();
  }, [last, count, onNearEnd]);

  // Keep the selected row in view when it moves with the keyboard.
  useEffect(() => {
    const el = scroller.current;
    if (selected === null || !el) return;
    const top = selected * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [selected]);

  const scrollToHead = () => {
    const el = scroller.current;
    if (!el || headIndex < 0) return;
    el.scrollTop = headIndex * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT / 2;
    setScrollTop(el.scrollTop);
  };
  useEffect(() => {
    if (revealHead > 0) scrollToHead();
  }, [revealHead]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where HEAD is relative to the view: shown, or above / below it (only known once the list has a height).
  const headTop = headIndex * ROW_HEIGHT;
  const headOffscreen =
    headIndex < 0 || viewHeight === 0 ? null : headTop + ROW_HEIGHT <= scrollTop ? "above" : headTop >= scrollTop + viewHeight ? "below" : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      onSelect(Math.min(count - 1, Math.max(0, (selected ?? (step > 0 ? -1 : count)) + step)));
    } else if (e.key === "Escape" && selected !== null) {
      e.preventDefault();
      onSelect(null);
    }
  };

  const rows = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <Row
        key={i}
        index={i}
        model={model}
        status={status}
        columns={columns}
        colours={colours}
        selected={i === selected}
        onSelect={onSelect}
        headName={headName}
      />,
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="listbox"
        aria-label="Commits"
        aria-activedescendant={selected !== null ? `git-row-${selected}` : undefined}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="relative" style={{ height: count * ROW_HEIGHT }}>
          {rows}
        </div>
      </div>
      {headOffscreen && (
        <button
          type="button"
          aria-label="Scroll to HEAD"
          className={cn(
            "absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-2.5 py-1 text-[11px] font-medium shadow-md hover:bg-accent",
            headOffscreen === "above" ? "top-2" : "bottom-2",
          )}
          onClick={() => {
            scrollToHead();
            onSelect(headIndex);
          }}
        >
          {headOffscreen === "above" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />}
          HEAD
          <span className="text-muted-foreground">{headName ?? "detached"}</span>
        </button>
      )}
    </div>
  );
}

const Row = memo(function Row({
  index,
  model,
  status,
  columns,
  colours,
  selected,
  onSelect,
  headName,
}: {
  index: number;
  model: GitGraphModel;
  status: GitWorktreeStatus;
  columns: number;
  colours: readonly string[];
  selected: boolean;
  onSelect(index: number | null): void;
  headName: string | null;
}) {
  const item = model.items[index]!;
  const row = model.layout.rows[index]!;
  const isHead = item.kind === "commit" && item.isHead;
  const laneColour = colours[row.colour % colours.length]!;
  const node = item.kind === "worktree" ? "worktree" : item.isHead ? "head" : item.commit.parents.length > 1 ? "merge" : "commit";
  return (
    <div
      id={`git-row-${index}`}
      role="option"
      aria-selected={selected}
      data-commit={item.kind === "commit" ? item.commit.hash : undefined}
      data-head={isHead || undefined}
      className={cn(
        "absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-2 pl-1 text-xs",
        selected ? "bg-accent text-accent-foreground" : isHead ? "bg-primary/[0.07] hover:bg-muted/60" : "hover:bg-muted/60",
      )}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onClick={() => onSelect(selected ? null : index)}
    >
      {isHead && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: laneColour }} />}
      <GraphCell row={row} columns={columns} colours={colours} node={node} />
      {item.kind === "worktree" ? (
        <span className="truncate text-muted-foreground italic">
          Uncommitted changes{" "}
          <span className="not-italic">
            ({[status.added && `+${status.added}`, status.modified && `~${status.modified}`, status.deleted && `−${status.deleted}`].filter(Boolean).join(" ")})
          </span>
        </span>
      ) : (
        <>
          {item.isHead && <HeadBadge name={headName} colour={laneColour} />}
          {item.commit.refs
            .filter((r) => !(item.isHead && r.kind === "branch" && r.name === headName))
            .map((r) => (
              <RefBadge key={r.ref} gitRef={r} head={false} colour={laneColour} />
            ))}
          <span className={cn("min-w-0 flex-1 truncate", item.isHead && "font-medium")} title={item.commit.subject}>
            {item.commit.subject}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{formatDateTime(Date.parse(item.commit.committerDate))}</span>
        </>
      )}
    </div>
  );
});

/** The checked-out position: filled in HEAD's lane colour, "HEAD › branch" or "HEAD detached". */
export function HeadBadge({ name, colour }: { name: string | null; colour: string }) {
  return (
    <span
      title={name ? `HEAD → ${name} (checked out)` : "HEAD is detached at this commit (no branch checked out)"}
      style={{ backgroundColor: colour, borderColor: colour }}
      className="flex max-w-40 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-4 font-semibold text-background"
    >
      <CircleDotIcon className="size-2.5 shrink-0" />
      HEAD
      <span className="opacity-70">›</span>
      <span className="truncate">{name ?? "detached"}</span>
    </span>
  );
}

export function RefBadge({ gitRef, head, colour }: { gitRef: GitRef; head: boolean; colour?: string }) {
  const Icon = gitRef.kind === "tag" ? TagIcon : GitBranchIcon;
  return (
    <span
      title={gitRef.ref}
      style={gitRef.kind === "branch" && colour ? { borderColor: colour } : undefined}
      className={cn(
        "flex max-w-32 shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] leading-4",
        gitRef.kind === "branch" && "bg-background text-foreground",
        gitRef.kind === "remote" && "border-border bg-muted text-muted-foreground",
        gitRef.kind === "tag" && "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        head && "font-semibold",
      )}
    >
      <Icon className="size-2.5 shrink-0" />
      <span className="truncate">{gitRef.name}</span>
    </span>
  );
}


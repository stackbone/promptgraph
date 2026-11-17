import { GIT_LOG_DEFAULT_LIMIT, GIT_LOG_MAX_LIMIT, type GitHead, type GitLogCommit, type GitLogResponse } from "@promptgraph/shared";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CircleDotIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/rest";
import { formatDateTime } from "../../lib/format";
import { branchName, buildGitGraph } from "../../lib/git-log";
import { useView } from "../../store/view/context";
import { Button } from "../common/ui";
import { SidePanelResizeHandle, useSidePanelWidth, type SidePanelSize } from "../common/side-panel-resize";
import { CommitList, RefBadge } from "./CommitList";
import { CopyButton } from "./CopyButton";

/** The docked Git graph's width (DESIGN §13.7). */
export const GIT_GRAPH_SIZE: SidePanelSize = { key: "pg.gitGraph.width", min: 320, default: 480 };

/** While the panel's tab and the page are visible, it checks this often whether the history changed. */
const POLL_MS = 4_000;

/**
 * The repository's Git graph (DESIGN §13.7): every branch, remote branch and tag as a commit graph, laid out by our
 * own lane algorithm (`lib/git-graph/layout.ts`) and drawn as a virtualised list. Docked right of the tab's panel.
 * It polls the cheap `git/state` signature and re-reads the log only when it changed.
 */
export function GitGraphPanel({ active = true, onClose }: { active?: boolean; onClose(): void }) {
  const { api, repoId } = useView();
  const [width, setWidth] = useSidePanelWidth(GIT_GRAPH_SIZE);
  const [log, setLog] = useState<GitLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(GIT_LOG_DEFAULT_LIMIT);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [worktreeSelected, setWorktreeSelected] = useState(false);
  const [revealHead, setRevealHead] = useState(0);
  const inFlight = useRef(false);
  /** Signature of the shown log; null until one is loaded (or after a repository switch). */
  const signature = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await api.gitLog(limit);
      signature.current = next.signature;
      setLog(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [api, limit]);

  const check = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    try {
      const state = await api.gitState();
      if (state.signature !== signature.current) await load();
    } catch {
      // The next poll retries; a failing log read shows its error.
    }
  }, [api, load]);

  // The first read, a new page size (`load` changes with `limit`) and a repository switch read the log; a hidden
  // tab (kept alive) does not poll and re-checks the signature when it is shown again.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${repoId}:${limit}`;
    if (loadedFor.current !== key && active) {
      if (loadedFor.current?.split(":")[0] !== repoId) {
        signature.current = null;
        setLog(null);
        setSelectedHash(null);
        setWorktreeSelected(false);
      }
      loadedFor.current = key;
      void load();
    } else if (active) void check();
  }, [repoId, limit, active, load, check]);

  useEffect(() => {
    if (!active) return;
    const tick = () => void check();
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, check]);

  const model = useMemo(() => (log ? buildGitGraph(log) : null), [log]);
  // The selection follows its commit across refreshes (rows move when commits are added).
  const selectedIndex = useMemo(() => {
    if (!model) return null;
    if (worktreeSelected) return model.items[0]?.kind === "worktree" ? 0 : null;
    if (!selectedHash) return null;
    const i = model.items.findIndex((it) => it.kind === "commit" && it.commit.hash === selectedHash);
    return i >= 0 ? i : null;
  }, [model, selectedHash, worktreeSelected]);
  const selectedItem = selectedIndex !== null ? model?.items[selectedIndex] : undefined;

  const select = useCallback(
    (index: number | null) => {
      const item = index !== null ? model?.items[index] : undefined;
      setWorktreeSelected(item?.kind === "worktree");
      setSelectedHash(item?.kind === "commit" ? item.commit.hash : null);
    },
    [model],
  );

  const hasMore = !!log?.hasMore;
  const loadMore = useCallback(() => {
    if (hasMore && !inFlight.current) setLimit((l) => Math.min(l + GIT_LOG_DEFAULT_LIMIT, GIT_LOG_MAX_LIMIT));
  }, [hasMore]);

  return (
    <section
      aria-label="Git graph"
      style={{ width }}
      className="nokey relative ml-1.5 flex h-full max-w-[60vw] min-w-80 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xs"
    >
      <SidePanelResizeHandle size={GIT_GRAPH_SIZE} width={width} onResize={setWidth} label="Resize Git graph" />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <h2 className="text-sm font-medium">Git graph</h2>
        {log && (
          <CheckoutChip
            head={log.head}
            onClick={() => {
              const i = model?.items.findIndex((it) => it.kind === "commit" && it.isHead) ?? -1;
              if (i >= 0) select(i);
              setRevealHead((n) => n + 1);
            }}
          />
        )}
        {log?.head.ref && <CopyButton text={branchName(log.head)!} label="Copy branch name" className="-ml-1" />}
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh Git graph" title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close Git graph" title="Close (Ctrl+Shift+G)" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </header>
      {error && (
        <p role="alert" className="border-b bg-red-500/10 px-3 py-1.5 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {!log && !error && <p className="px-3 py-2 text-xs text-muted-foreground">Loading history…</p>}
      {log && model && model.items.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No commits yet.</p>}
      {log && model && model.items.length > 0 && (
        <CommitList
          model={model}
          status={log.status}
          selected={selectedIndex}
          onSelect={select}
          onNearEnd={loadMore}
          headName={branchName(log.head)}
          revealHead={revealHead}
        />
      )}
      {hasMore && loading && <p className="border-t px-3 py-1 text-[11px] text-muted-foreground">Loading more commits…</p>}
      {selectedItem?.kind === "commit" && (
        <CommitDetails commit={selectedItem.commit} isHead={selectedItem.isHead} onClose={() => select(null)} />
      )}
    </section>
  );
}

/**
 * Where the main checkout is: its branch (or a detached HEAD), the commit, and how the branch compares with its
 * upstream. A click scrolls the graph to HEAD and selects it.
 */
function CheckoutChip({ head, onClick }: { head: GitHead; onClick(): void }) {
  const name = branchName(head);
  const short = head.hash?.slice(0, 7);
  const up = head.upstream;
  const sync = !up
    ? name
      ? "No upstream branch"
      : null
    : up.gone
      ? `Upstream ${up.name} is gone`
      : up.ahead === 0 && up.behind === 0
        ? `Up to date with ${up.name}`
        : [up.ahead && `${up.ahead} ahead of`, up.behind && `${up.behind} behind`].filter(Boolean).join(", ") + ` ${up.name}`;
  const title = [name ? `Checked out: ${name}` : "Detached HEAD (no branch checked out)", short && `at ${short}`, sync].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      aria-label={`Checkout: ${title}. Show HEAD`}
      title={`${title}\nClick to show HEAD`}
      disabled={!head.hash}
      className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/60 px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:pointer-events-none"
      onClick={onClick}
    >
      <CircleDotIcon className="size-3 shrink-0 text-primary" />
      <span className={cn("truncate font-semibold", !name && "text-amber-600 dark:text-amber-400")}>{name ?? "detached HEAD"}</span>
      {short && <code className="shrink-0 font-mono text-muted-foreground">{short}</code>}
      {up && !up.gone && (up.ahead > 0 || up.behind > 0) && (
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          {up.ahead > 0 && (
            <span className="flex items-center">
              <ArrowUpIcon className="size-3" />
              {up.ahead}
            </span>
          )}
          {up.behind > 0 && (
            <span className="flex items-center">
              <ArrowDownIcon className="size-3" />
              {up.behind}
            </span>
          )}
        </span>
      )}
      {up && !up.gone && up.ahead === 0 && up.behind === 0 && <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />}
      {up?.gone && <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />}
    </button>
  );
}

function CommitDetails({ commit, isHead, onClose }: { commit: GitLogCommit; isHead: boolean; onClose(): void }) {
  return (
    <footer aria-label="Commit details" className="shrink-0 border-t px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 font-medium break-words">{commit.subject}</p>
        <Button variant="ghost" size="icon-sm" aria-label="Close commit details" className="-mt-1 -mr-1.5 shrink-0" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {commit.refs.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
          {commit.refs.map((r) => (
            <span key={r.ref} className="flex items-center gap-0.5">
              <RefBadge gitRef={r} head={isHead && r.kind === "branch"} />
              <CopyButton text={r.name} label={`Copy ${r.kind === "tag" ? "tag" : "branch"} name ${r.name}`} />
            </span>
          ))}
        </div>
      )}
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <dt>Commit</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <code className="truncate font-mono text-foreground">{commit.hash}</code>
          <CopyButton text={commit.hash} label="Copy commit hash" />
        </dd>
        <dt>Author</dt>
        <dd className="truncate">
          {commit.authorName} <span>&lt;{commit.authorEmail}&gt;</span>
        </dd>
        <dt>Date</dt>
        <dd>{formatDateTime(Date.parse(commit.committerDate))}</dd>
        {commit.parents.length > 0 && (
          <>
            <dt>{commit.parents.length > 1 ? "Parents" : "Parent"}</dt>
            <dd className="font-mono">{commit.parents.map((p) => p.slice(0, 7)).join(" ")}</dd>
          </>
        )}
      </dl>
    </footer>
  );
}

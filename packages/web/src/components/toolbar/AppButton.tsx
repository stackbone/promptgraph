import type { AppProcess } from "@promptgraph/shared";
import { ChevronDownIcon, ExternalLinkIcon, FlaskConicalIcon, LoaderCircleIcon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/rest";
import { openAppUrl } from "../../lib/open-url";
import { getRepoCache, useRepoCache } from "../../store/repo-cache";
import { openRepoSettings } from "../../store/repo-settings-dialog";
import { toast } from "../../store/toast-store";
import { useView, type View } from "../../store/view/context";
import { Button } from "../common/ui";

const FLOATING = "bg-card shadow-soft ring-1 ring-border";
const EMPTY: AppProcess[] = [];

/** Runs the repository's checks once by hand (§26.7), in the main checkout or a step's worktree, in a terminal tab. */
export async function runChecksIn(view: Pick<View, "repoId" | "ui">, nodeRunId?: string): Promise<void> {
  try {
    const { ptyId, title } = await getRepoCache(view.repoId).getState().api.runChecks(nodeRunId ? { nodeRunId } : {});
    view.ui.getState().openTerminal(ptyId, { title, nodeRunId: null });
  } catch (err) {
    toast("error", `Could not run the tests: ${errorMessage(err)}`);
  }
}

/** The terminal of an app process, in the view's drawer. */
export function openAppTerminal(view: Pick<View, "ui">, p: AppProcess): void {
  view.ui.getState().openTerminal(p.ptyId, { title: p.worktree ? `${p.name} (${p.worktree.branch})` : `${p.name} (app)`, nodeRunId: null });
}

/**
 * The canvas's Run app button (DESIGN §26.4), top right: starts the repository's configured applications in its main
 * checkout, each in a terminal of the drawer, and follows them. While one starts it shows Starting…; once one is
 * reachable it becomes **Open app** (its URL in a new browser tab). The menu next to it lists every app with its URL
 * and terminal, and stops them. Without configured apps it opens the repository settings.
 */
export function AppButton() {
  const view = useView();
  const { repoId } = view;
  const configured = useRepoCache(repoId, (s) => s.repoSettings?.settings.apps.length ?? 0);
  const loaded = useRepoCache(repoId, (s) => s.repoSettings !== null);
  const all = useRepoCache(repoId, (s) => s.apps) ?? EMPTY;
  const [busy, setBusy] = useState(false);
  // The button follows the apps it started in the main checkout; the run's `app` nodes have their own terminals.
  const mine = all.filter((p) => p.runId === null && p.worktree === null && p.status !== "exited");
  const checkCount = useRepoCache(repoId, (s) => s.repoSettings?.settings.checks.length ?? 0);
  const ready = mine.filter((p) => p.status === "ready" && p.url);
  const starting = mine.filter((p) => p.status === "starting");
  if (!loaded) return null;

  const start = async () => {
    setBusy(true);
    try {
      const { apps } = await getRepoCache(repoId).getState().api.startApps();
      getRepoCache(repoId).getState().setApps(apps);
      const started = apps.filter((p) => p.runId === null && p.worktree === null && p.status !== "exited");
      started.forEach((p) => openAppTerminal(view, p));
    } catch (err) {
      toast("error", `Could not start the app: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (ptyId?: string) => {
    try {
      const { apps } = await getRepoCache(repoId).getState().api.stopApps(ptyId);
      getRepoCache(repoId).getState().setApps(apps);
    } catch (err) {
      toast("error", `Could not stop the app: ${errorMessage(err)}`);
    }
  };

  if (configured === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className={cn(FLOATING, "text-muted-foreground")} onClick={() => openRepoSettings(repoId)}>
            <PlayIcon /> Run app
          </Button>
        </TooltipTrigger>
        <TooltipContent>No app is configured: set up how this repository starts</TooltipContent>
      </Tooltip>
    );
  }

  let main;
  if (ready.length > 0) {
    const first = ready[0]!;
    main = (
      <Button variant="ghost" size="sm" className="rounded-r-none text-green-700 dark:text-green-500" onClick={() => void openAppUrl(first.url!)} title={first.url!}>
        <ExternalLinkIcon /> Open app
      </Button>
    );
  } else if (starting.length > 0 || busy) {
    main = (
      <Button variant="ghost" size="sm" className="rounded-r-none" onClick={() => starting[0] && openAppTerminal(view, starting[0])}>
        <LoaderCircleIcon className="animate-spin" /> Starting…
      </Button>
    );
  } else if (mine.length > 0) {
    // Running but no URL known (it printed none and none is configured): its terminal tells.
    main = (
      <Button variant="ghost" size="sm" className="rounded-r-none" onClick={() => openAppTerminal(view, mine[0]!)}>
        <TerminalIcon /> App running
      </Button>
    );
  } else {
    main = (
      <Button variant="ghost" size="sm" className="rounded-r-none" disabled={busy} onClick={() => void start()}>
        <PlayIcon /> Run app
      </Button>
    );
  }

  const exited = all.filter((p) => p.runId === null && p.worktree === null && p.status === "exited").slice(0, 3);
  return (
    <div className={cn("flex items-center rounded-md", FLOATING)}>
      {main}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Apps" className="h-8 w-6 rounded-l-none border-l border-border/60">
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-[11px] font-semibold tracking-wider uppercase">Apps</DropdownMenuLabel>
          {mine.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Not running. Run app starts every configured app in the main checkout.</p>}
          {mine.map((p) => (
            <div key={p.ptyId} className="space-y-0.5 px-2 py-1">
              <div className="flex items-center gap-2 text-xs">
                <span className={cn("size-1.5 shrink-0 rounded-full", p.status === "ready" ? "bg-green-500" : "animate-pulse bg-amber-500")} />
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="text-[10px] text-muted-foreground">{p.status === "ready" ? "running" : "starting"}</span>
              </div>
              {p.url && <div className="truncate pl-3.5 font-mono text-[10px] text-muted-foreground">{p.url}</div>}
            </div>
          ))}
          {mine.length > 0 && <DropdownMenuSeparator />}
          {ready.map((p) => (
            <DropdownMenuItem key={`open-${p.ptyId}`} onSelect={() => void openAppUrl(p.url!)}>
              <ExternalLinkIcon /> Open {p.name}
            </DropdownMenuItem>
          ))}
          {mine.map((p) => (
            <DropdownMenuItem key={`term-${p.ptyId}`} onSelect={() => openAppTerminal(view, p)}>
              <TerminalIcon /> {p.name}&apos;s terminal
            </DropdownMenuItem>
          ))}
          {mine.length === 0 ? (
            <DropdownMenuItem disabled={busy} onSelect={() => void start()}>
              <PlayIcon /> Run app
            </DropdownMenuItem>
          ) : (
            <>
              {mine.length < configured && (
                <DropdownMenuItem disabled={busy} onSelect={() => void start()}>
                  <PlayIcon /> Start the other apps
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void stop()} className="text-red-600 focus:text-red-600">
                <SquareIcon /> Stop {mine.length === 1 ? "app" : "all apps"}
              </DropdownMenuItem>
            </>
          )}
          {exited.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {exited.map((p) => (
                <DropdownMenuItem key={`exit-${p.ptyId}`} onSelect={() => openAppTerminal(view, p)} className="text-muted-foreground">
                  <TerminalIcon /> {p.name} exited{p.exitCode !== null ? ` (${p.exitCode})` : ""}
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={checkCount === 0} onSelect={() => void runChecksIn(view)}>
            <FlaskConicalIcon /> Run tests in this checkout
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openRepoSettings(repoId)}>Repository settings…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

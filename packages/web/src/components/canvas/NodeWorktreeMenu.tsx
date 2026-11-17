import type { AppProcess, NodeRun } from "@promptgraph/shared";
import { ExternalLinkIcon, FlaskConicalIcon, LoaderCircleIcon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "../../api/rest";
import { openAppUrl } from "../../lib/open-url";
import { getRepoCache, useRepoCache } from "../../store/repo-cache";
import { openRepoSettings } from "../../store/repo-settings-dialog";
import { toast } from "../../store/toast-store";
import { useRun, useView } from "../../store/view/context";
import { openAppTerminal, runChecksIn } from "../toolbar/AppButton";

export interface NodeMenuTarget {
  x: number;
  y: number;
  nodeRun: NodeRun;
  label: string;
}

const EMPTY: AppProcess[] = [];

/**
 * A run node's context menu (DESIGN §26.7): with the step's worktree still on disk, run the repository's tests in it,
 * or start its apps there (a terminal per app in the drawer) and open them once reachable, to check that lane's work
 * by hand. These processes are not part of the run; they stop when the worktree is removed.
 */
export function NodeWorktreeMenu({ target, onClose }: { target: NodeMenuTarget; onClose: () => void }) {
  const view = useView();
  const { nodeRun } = target;
  const lane = useRun((s) => (nodeRun.laneId ? s.lanes[nodeRun.laneId] : undefined));
  const apps = useRepoCache(view.repoId, (s) => s.repoSettings?.settings.apps.length ?? 0);
  const checks = useRepoCache(view.repoId, (s) => s.repoSettings?.settings.checks.length ?? 0);
  const all = useRepoCache(view.repoId, (s) => s.apps) ?? EMPTY;
  const [busy, setBusy] = useState(false);
  const here = lane ? all.filter((p) => p.worktree?.runId === lane.runId && p.worktree.laneId === lane.id && p.status !== "exited") : [];
  const hasWorktree = !!lane && lane.status !== "removed";

  const startApps = async () => {
    setBusy(true);
    try {
      const { apps: list } = await getRepoCache(view.repoId).getState().api.startApps({ nodeRunId: nodeRun.id });
      getRepoCache(view.repoId).getState().setApps(list);
      list.filter((p) => p.worktree?.laneId === lane?.id && p.worktree?.runId === lane?.runId && p.status !== "exited").forEach((p) => openAppTerminal(view, p));
    } catch (err) {
      toast("error", `Could not start the app: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const stop = async (ptyId: string) => {
    try {
      const { apps: list } = await getRepoCache(view.repoId).getState().api.stopApps(ptyId);
      getRepoCache(view.repoId).getState().setApps(list);
    } catch (err) {
      toast("error", `Could not stop the app: ${errorMessage(err)}`);
    }
  };

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      {/* An invisible anchor at the pointer: the menu opens where the user right-clicked. */}
      <DropdownMenuTrigger asChild>
        <span aria-hidden="true" className="pointer-events-none fixed size-0" style={{ left: target.x, top: target.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" aria-label={`${target.label} worktree`}>
        <DropdownMenuLabel className="space-y-0.5">
          <span className="block truncate text-xs font-semibold">{target.label}</span>
          <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">{lane ? lane.branch : "No worktree"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!hasWorktree ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {lane ? "This step's worktree was removed when the run was cleaned up." : "This step has no worktree yet."}
          </p>
        ) : (
          <>
            <DropdownMenuItem disabled={checks === 0} onSelect={() => void runChecksIn(view, nodeRun.id)}>
              <FlaskConicalIcon /> Run tests in this worktree
            </DropdownMenuItem>
            {here.map((p) =>
              p.status === "ready" && p.url ? (
                <DropdownMenuItem key={`open-${p.ptyId}`} onSelect={() => void openAppUrl(p.url!)}>
                  <ExternalLinkIcon /> Open {p.name} <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{p.url}</span>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={`wait-${p.ptyId}`} onSelect={() => openAppTerminal(view, p)}>
                  <LoaderCircleIcon className="animate-spin" /> {p.name} is starting…
                </DropdownMenuItem>
              ),
            )}
            {here.length < apps && (
              <DropdownMenuItem disabled={busy} onSelect={() => void startApps()}>
                <PlayIcon /> {here.length === 0 ? "Start the app in this worktree" : "Start the other apps here"}
              </DropdownMenuItem>
            )}
            {apps === 0 && (
              <DropdownMenuItem disabled>
                <PlayIcon /> Start the app (none configured)
              </DropdownMenuItem>
            )}
            {here.map((p) => (
              <DropdownMenuItem key={`term-${p.ptyId}`} onSelect={() => openAppTerminal(view, p)}>
                <TerminalIcon /> {p.name}&apos;s terminal
              </DropdownMenuItem>
            ))}
            {here.map((p) => (
              <DropdownMenuItem key={`stop-${p.ptyId}`} className="text-red-600 focus:text-red-600" onSelect={() => void stop(p.ptyId)}>
                <SquareIcon /> Stop {p.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {(apps === 0 || checks === 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openRepoSettings(view.repoId)}>Repository settings…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

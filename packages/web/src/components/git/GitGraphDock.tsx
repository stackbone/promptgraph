import { GitGraphIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { onGitGraphShortcut } from "../../lib/chat-shortcut";
import { useTabContext } from "../tabs/tab-context";
import { Button } from "../common/ui";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { GitGraphPanel } from "./GitGraphPanel";

const OPEN_KEY = "pg.gitGraph.open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/**
 * The Git graph of a repository tab (DESIGN §13.7): an icon toggle in the tab's bottom bar, after the chats, Ask
 * Claude and the chat history and before the approvals and settings, Ctrl+Shift+G, and, when open, a panel docked to the right of the tab's panel, between the
 * inspector and a docked chat. Repository views only: Home has no bottom bar and renders no RepoView.
 */
export function GitGraphDock() {
  const tab = useTabContext();
  const active = tab?.active ?? true;
  const [open, setOpen] = useState(readOpen);
  const toggle = () =>
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });

  useEffect(() => {
    if (!active) return;
    return onGitGraphShortcut(toggle);
  }, [active]);

  const button = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Git graph"
          aria-pressed={open}
          // Bottom bar, right group: chats, Ask Claude and the chat history (0), this toggle (1), approvals (2), settings (3).
          className={cn("order-1 shrink-0", open ? "bg-accent text-foreground" : "text-muted-foreground")}
          onClick={toggle}
        >
          <GitGraphIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {open ? "Hide" : "Show"} the Git graph
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>Shift</Kbd>
          <Kbd>G</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
  // In the side slot after the inspector (order-first) and before a docked chat (both may be open side by side).
  const panel = open && (
    <div className="-order-1 flex h-full min-h-0">
      <GitGraphPanel active={active} onClose={toggle} />
    </div>
  );

  if (!tab) {
    return (
      <>
        <div className="flex h-9 items-center px-1">{button}</div>
        {panel}
      </>
    );
  }
  return (
    <>
      {tab.bottomBar && createPortal(button, tab.bottomBar)}
      {panel && tab.sidePanel && createPortal(panel, tab.sidePanel)}
    </>
  );
}

import { LAYOUT_DY, type NodeType } from "@promptgraph/shared";
import { useState } from "react";
import { NODE_TYPE_META, PALETTE_ORDER } from "../../lib/node-meta";
import { useRepoCache } from "../../store/repo-cache";
import { openRepoSettings } from "../../store/repo-settings-dialog";
import { cn } from "@/lib/utils";
import { useEditor, useRun, useView } from "../../store/view/context";
import { isReadOnly } from "../../store/view/editor-store";
import { PALETTE_MIME } from "../canvas/Canvas";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icons, NodeTypeIcon } from "../common/icons";
import { Button } from "../common/ui";

/**
 * The toolbar's Nodes button (§13): opens the palette above the toolbar. A click on a node type adds it and closes
 * the menu; dragging one hides the menu (so the drop lands on the canvas underneath) and closes it once dropped.
 * Disabled while nothing can be added: no graph, a load error, or a run shown on the canvas.
 */
export function NodesMenu() {
  const runMode = useRun((s) => s.selectedRunId !== null);
  const readOnly = useEditor(isReadOnly) || runMode;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const label = runMode ? "Viewing a run: switch to the editor to add nodes" : readOnly ? "This graph cannot be edited" : "Add a node";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDragging(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events: the wrapper keeps the tooltip working. */}
          <span className="inline-flex">
            <PopoverTrigger asChild>
              <Button variant={open ? "secondary" : "ghost"} size="icon" aria-label="Nodes" disabled={readOnly}>
                <Icons.plus />
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        aria-label="Nodes"
        // Hidden (not unmounted) while a node type is dragged out of it: the drag source must stay in the DOM.
        className={cn("nokey max-h-[min(32rem,70vh)] w-80 overflow-y-auto p-0", dragging && "pointer-events-none opacity-0")}
      >
        <Palette
          onAdded={() => setOpen(false)}
          // Deferred: the browser takes the drag image from the element as it is when the drag starts.
          onDragStart={() => requestAnimationFrame(() => setDragging(true))}
          onDragEnd={() => {
            setDragging(false);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Node types to drag onto the canvas (click adds one below the last node). */
export function Palette({ onAdded, onDragStart, onDragEnd }: { onAdded?(): void; onDragStart?(): void; onDragEnd?(): void } = {}) {
  const view = useView();
  // A run shown on the canvas is its snapshot: nothing can be added to it.
  const runMode = useRun((s) => s.selectedRunId !== null);
  const readOnly = useEditor(isReadOnly) || runMode;
  const phase = useEditor((s) => s.phase);
  const supported = useEditor((s) => s.supportedNodeTypes);
  const editorHint = useEditor((s) =>
    !s.graph
      ? s.loadError
        ? "This graph could not be loaded."
        : "Create or select a graph to add nodes."
      : s.activeRunId
        ? "The graph is read-only while a run is active."
        : "Drag onto the canvas, or click to append.",
  );
  const hint = runMode ? "Viewing a run: switch to the editor to add nodes." : editorHint;
  // Start app / Run tests need the repository settings (§26.3): unavailable until they name an app / a check.
  const appCount = useRepoCache(view.repoId, (s) => s.repoSettings?.settings.apps.length ?? 0);
  const checkCount = useRepoCache(view.repoId, (s) => s.repoSettings?.settings.checks.length ?? 0);
  const notConfigured = (type: NodeType) => (type === "app" && appCount === 0) || (type === "test" && checkCount === 0);

  const addByClick = (type: NodeType) => {
    const g = view.editor.getState().graph;
    if (!g) return;
    // Appended below the lowest node: graphs flow top to bottom.
    const last = g.nodes.reduce((m, n) => (n.position.y > m.y ? n.position : m), { x: 96, y: -LAYOUT_DY });
    const id = view.editor.getState().addNode(type, { x: last.x, y: last.y + LAYOUT_DY });
    if (id) view.ui.getState().revealNode(id);
    onAdded?.();
  };

  return (
    <div className="space-y-1 p-2">
      <p className="px-2 pt-1 pb-2 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      {PALETTE_ORDER.map((type) => {
        const meta = NODE_TYPE_META[type];
        const needsPhase2 = meta.phase2 && phase < 2;
        const notYet = !needsPhase2 && supported !== null && !supported.includes(type);
        const unsupported = needsPhase2 || notYet;
        const unconfigured = notConfigured(type);
        if (unconfigured) {
          return (
            <div key={type} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left">
              <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-sm opacity-40 ${meta.accent}`}>
                <NodeTypeIcon type={type} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-foreground/50">{meta.title}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {type === "app" ? "No app configured. " : "No tests configured. "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => {
                      onAdded?.();
                      openRepoSettings(view.repoId);
                    }}
                  >
                    Set up…
                  </button>
                </span>
              </span>
            </div>
          );
        }
        return (
          <Button
            key={type}
            variant="ghost"
            draggable={!readOnly}
            disabled={readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_MIME, type);
              e.dataTransfer.effectAllowed = "copy";
              onDragStart?.();
            }}
            onDragEnd={() => onDragEnd?.()}
            onClick={() => addByClick(type)}
            title={
              needsPhase2
                ? `${meta.description} (needs Phase 2: the current engine will reject it)`
                : notYet
                  ? `${meta.description} (not available in this version yet: graphs with it cannot run)`
                  : meta.description
            }
            // Disabled entries keep their title tooltip and not-allowed cursor (shadcn disables pointer events);
            // icons keep their 1em size.
            className="group h-auto w-full cursor-grab justify-start gap-2.5 rounded-md px-2 py-1.5 text-left font-normal whitespace-normal hover:border-border active:cursor-grabbing disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40 [&_svg:not([class*='size-'])]:size-[1em]"
          >
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-sm ${meta.accent}`}>
              <NodeTypeIcon type={type} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/90">
                {meta.title}
                {unsupported && (
                  <Badge variant="secondary" className="h-auto rounded px-1 py-px text-[9px] font-normal tracking-wide text-muted-foreground uppercase">
                    {needsPhase2 ? "phase 2" : "coming soon"}
                  </Badge>
                )}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">{meta.description}</span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}

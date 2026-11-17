import { Separator } from "@/components/ui/separator";
import { useEditor } from "../../store/view/context";
import { ArrangeButton, ProblemsButton, RunButton, RunSelector, ShownRunInfo, UndoRedoControls } from "../header/RunControls";
import { NodesMenu } from "../palette/Palette";

/**
 * The canvas toolbar (§13), floating at the bottom centre of the canvas while a graph is open, like a design tool's:
 * the Nodes menu and the run menu (the
 * editor or one of the graph's runs, with the shown run's cost and Report);
 * then Undo, Redo and Arrange; then Run / Cancel (and Resume). Every button is an icon with a tooltip except the run
 * menu and the run action. Its menus open upwards. While the editor has problems, their badge sits centred just above
 * the toolbar, outside it, so the toolbar keeps its size and position. The row itself lets pointer events through, so
 * only the toolbar and the badge cover the canvas.
 */
export function CanvasToolbar() {
  const hasGraph = useEditor((s) => s.graph !== null);
  if (!hasGraph) return null;
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-3 z-10 flex justify-center">
      {/* nokey: Backspace/Delete on its buttons must not delete canvas items. */}
      <div className="nokey pointer-events-auto relative max-w-full">
      <div role="toolbar" aria-label="Graph toolbar" className="flex max-w-full items-center gap-1 rounded-xl bg-card p-1 shadow-soft ring-1 ring-border">
        <NodesMenu />
        <RunSelector />
        <ShownRunInfo />
        <ToolbarSeparator />
        <UndoRedoControls />
        <ArrangeButton />
        <ToolbarSeparator />
        <RunButton />
      </div>
      <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2">
        <ProblemsButton />
      </div>
      </div>
    </div>
  );
}

function ToolbarSeparator() {
  return <Separator orientation="vertical" className="mx-1 h-5 data-vertical:self-center" />;
}

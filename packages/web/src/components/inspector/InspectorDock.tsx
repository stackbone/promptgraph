import { createPortal } from "react-dom";
import { SidePanelResizeHandle, useSidePanelWidth, type SidePanelSize } from "../common/side-panel-resize";
import { useTabContext } from "../tabs/tab-context";
import { Inspector } from "./Inspector";

/** The docked inspector's width (DESIGN §13). */
export const INSPECTOR_SIZE: SidePanelSize = { key: "pg.inspector.width", min: 280, default: 320 };

/**
 * The inspector of the graph editor and run views (DESIGN §13), docked right of the tab's panel like the Git graph
 * and a docked chat, closest to the canvas. It is always shown while the view is (it has no collapse); its left edge
 * resizes it. Outside a tab (tests) it renders in place. nokey: Backspace/Delete on its buttons, checkboxes and tabs
 * must not delete canvas items.
 */
export function InspectorDock({ hidden = false }: { hidden?: boolean }) {
  const tab = useTabContext();
  const [width, setWidth] = useSidePanelWidth(INSPECTOR_SIZE);
  if (hidden) return null;
  const panel = (
    <div className="order-first flex h-full min-h-0">
      <section
        aria-label="Inspector"
        style={{ width }}
        className="nokey relative ml-1.5 flex h-full max-w-[60vw] min-w-70 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xs"
      >
        <SidePanelResizeHandle size={INSPECTOR_SIZE} width={width} onResize={setWidth} label="Resize inspector" />
        <div className="min-h-0 flex-1">
          <Inspector />
        </div>
      </section>
    </div>
  );
  if (!tab) return panel;
  return tab.sidePanel ? createPortal(panel, tab.sidePanel) : null;
}

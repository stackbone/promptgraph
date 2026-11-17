import { webRoutes } from "@promptgraph/shared";
import { Suspense, lazy, useState, type CSSProperties, type ReactNode } from "react";
import { Canvas } from "../components/canvas/Canvas";
import { Banners } from "../components/common/Banners";
import { NewGraphDialog } from "../components/home/RepoDialogs";
import { Icons } from "../components/common/icons";
import { Button } from "../components/common/ui";
import { LinearIssueLinks } from "../components/common/LinearIssueLink";
import { SaveIndicator } from "../components/header/RunControls";
import { InspectorDock } from "../components/inspector/InspectorDock";
import { RunReport, useAutoOpenReport } from "../components/report/RunReport";
import { TerminalDrawer } from "../components/terminal/TerminalDrawer";
import { CanvasToolbar } from "../components/toolbar/CanvasToolbar";
import type { RepoRoute } from "../lib/router/routes";
import { createGraph } from "../store/view/actions";
import { Link } from "../lib/router/Link";
import { useEditor, useRepo, useRun, useView, useViewUi } from "../store/view/context";

/** Lazy: the dialog pulls in diff2html, which the rest of the app does not need. */
const ApprovalDialog = lazy(() => import("../components/approval/ApprovalDialog").then((m) => ({ default: m.ApprovalDialog })));
const DiffDialog = lazy(() => import("../components/approval/DiffDialog").then((m) => ({ default: m.DiffDialog })));

/**
 * Graph editor and run views (§13): banners / canvas / terminal drawer, with the inspector docked right of the tab's
 * panel (InspectorDock). There is no top bar and no left sidebar: graphs are picked in the overview (§13.3), the canvas toolbar at the bottom of the canvas holds the node
 * palette, the run menu and the run controls (CanvasToolbar), and the linked issues float over the canvas
 * (CanvasOverlay). The report route replaces the canvas row (which stays mounted) with the run report.
 */
export function Workspace({ route }: { route: RepoRoute }) {
  const reportRunId = route.kind === "report" ? route.runId : null;
  useAutoOpenReport(route);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background text-foreground">
      <Banners />
      {reportRunId && <RunReport runId={reportRunId} />}
      <div className={`relative flex min-h-0 flex-1 overflow-hidden ${reportRunId ? "hidden" : ""}`}>
        <main className="relative flex min-w-0 flex-1 flex-col">
          <CanvasOverlay />
          <div className="relative min-h-0 flex-1">
            <CanvasArea />
            <CanvasToolbar />
          </div>
          <TerminalDrawer />
        </main>
        {/* Docked right of the tab's panel (in place outside a tab); hidden with the canvas row on the report route. */}
        <InspectorDock hidden={reportRunId !== null} />
      </div>
      <ApprovalGate />
      <DiffGate />
    </div>
  );
}

function ApprovalGate() {
  const nodeRunId = useViewUi((s) => s.approvalNodeRunId);
  if (!nodeRunId) return null;
  return (
    <Suspense fallback={null}>
      <ApprovalDialog key={nodeRunId} nodeRunId={nodeRunId} />
    </Suspense>
  );
}

function DiffGate() {
  const target = useViewUi((s) => s.diffTarget);
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <DiffDialog target={target} />
    </Suspense>
  );
}

/**
 * Controls floating over the top corners of the canvas. Top left: the graph's linked Linear issues (§24.3). Top
 * right: the autosave indicator. Everything else sits in
 * the canvas toolbar at the bottom (CanvasToolbar). The rows themselves let pointer events through, so only their
 * contents cover the canvas.
 */
export function CanvasOverlay() {
  const issues = useEditor((s) => s.graph?.issues);
  return (
    <>
      {issues?.length ? (
        <div className="pointer-events-none absolute top-2 left-2 z-10 flex max-w-[calc(100%-20rem)] min-w-0 items-center gap-2 *:pointer-events-auto">
          <LinearIssueLinks issues={issues} variant="canvas" className="min-w-0" />
        </div>
      ) : null}
      <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-2 *:pointer-events-auto">
        <SaveIndicator />
      </div>
    </>
  );
}

function CanvasArea() {
  const view = useView();
  const hasGraph = useEditor((s) => s.graph !== null);
  const loading = useEditor((s) => s.loading);
  const loadError = useEditor((s) => s.loadError);
  const runMode = useRun((s) => s.selectedRunId !== null);
  const graphCount = useRepo((s) => s.graphs?.length ?? 0);
  const [creating, setCreating] = useState(false);

  // The run canvas shows the run's snapshot, whatever state the graph file is in.
  if (runMode) return <Canvas />;
  if (loading) return <Centered>Loading graph…</Centered>;
  if (loadError) {
    return (
      <Centered>
        <div className="max-w-lg space-y-2 text-center">
          <Icons.alert className="mx-auto text-2xl text-red-600" />
          <p className="text-sm font-medium text-red-700">This graph cannot be loaded</p>
          <pre className="rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap text-muted-foreground">{loadError}</pre>
          <p className="text-xs text-muted-foreground">
            Fix the JSON file in .promptgraph/graphs/ or delete it from{" "}
            <Link to={webRoutes.repo(view.repoId)} className="underline underline-offset-2 hover:text-foreground">
              the repository&apos;s graphs
            </Link>
            .
          </p>
        </div>
      </Centered>
    );
  }
  if (!hasGraph) {
    return (
      <Centered>
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{graphCount ? "No graph is open." : "No graphs in this repository yet."}</p>
          <div className="flex items-center justify-center gap-2">
            {graphCount > 0 && (
              <Link to={webRoutes.repo(view.repoId)} className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm ring-1 ring-border hover:bg-accent">
                <Icons.layers /> All graphs
              </Link>
            )}
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Icons.plus /> New graph
            </Button>
          </div>
        </div>
        {creating && <NewGraphDialog repoId={view.repoId} create={(v) => createGraph(view, v)} onClose={() => setCreating(false)} />}
      </Centered>
    );
  }
  return <Canvas />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-muted-foreground">{children}</div>;
}

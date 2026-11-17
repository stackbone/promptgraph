import type { LoopSpec } from "@promptgraph/shared";
import { createStore, type StoreApi } from "zustand/vanilla";

/** UI chrome of one view: terminal drawer tabs/height, open dialogs. */
export interface UiState {
  /** ptyIds open as terminal tabs, in order. */
  terminalTabs: string[];
  activeTerminal: string | null;
  drawerHeight: number;
  approvalNodeRunId: string | null;
  /** Diff dialog: one node's changes (with a switch to its whole lane), or a lane of a run. */
  diffTarget: DiffTarget | null;
}

export type DiffTarget =
  | { kind: "node"; nodeRunId: string; title: string }
  | { kind: "lane"; runId: string; laneId: string; title: string };

export interface TerminalTabMeta {
  title: string;
  /** Node run the terminal belongs to (null for ad-hoc PTYs such as Reopen session). */
  nodeRunId: string | null;
}


export interface UiStore extends UiState {
  tabMeta: Record<string, TerminalTabMeta>;
  drawerOpen: boolean;
  /** Node the edit canvas should pan to when it is outside the viewport (palette click-to-append). */
  revealNodeId: string | null;
  /** Bumped to ask the canvas to fit the graph in view (e.g. after Arrange); 0 = never asked. */
  fitRequest: number;
  /** Edge id → the loop spec it had before "loop back-edge" was unticked (restored when ticked again). */
  lastLoopSpec: Record<string, LoopSpec>;

  revealNode(nodeId: string | null): void;
  requestFit(): void;
  openTerminal(ptyId: string, meta: TerminalTabMeta): void;
  closeTerminal(ptyId: string): void;
  setActiveTerminal(ptyId: string): void;
  closeAllTerminals(): void;
  setDrawerOpen(open: boolean): void;
  setDrawerHeight(px: number): void;
  openApproval(nodeRunId: string | null): void;
  openDiff(target: DiffTarget | null): void;
  rememberLoopSpec(edgeId: string, spec: LoopSpec): void;
}

export type ViewUiStoreApi = StoreApi<UiStore>;

export const MIN_DRAWER_HEIGHT = 120;

export function clampDrawerHeight(px: number, viewport: number): number {
  return Math.round(Math.max(MIN_DRAWER_HEIGHT, Math.min(px, Math.max(MIN_DRAWER_HEIGHT, viewport - 160))));
}

/** One per view (DESIGN §13.4). */
export function createViewUiStore(): ViewUiStoreApi {
  return createStore<UiStore>()((set, get) => ({
    terminalTabs: [],
    activeTerminal: null,
    drawerHeight: 300,
    approvalNodeRunId: null,
    diffTarget: null,
    tabMeta: {},
    drawerOpen: false,
    revealNodeId: null,
    fitRequest: 0,
    lastLoopSpec: {},

    revealNode(nodeId) {
      set({ revealNodeId: nodeId });
    },

    requestFit() {
      set({ fitRequest: get().fitRequest + 1 });
    },

    openTerminal(ptyId, meta) {
      const s = get();
      set({
        terminalTabs: s.terminalTabs.includes(ptyId) ? s.terminalTabs : [...s.terminalTabs, ptyId],
        tabMeta: { ...s.tabMeta, [ptyId]: meta },
        activeTerminal: ptyId,
        drawerOpen: true,
      });
    },

    closeTerminal(ptyId) {
      const s = get();
      const i = s.terminalTabs.indexOf(ptyId);
      if (i === -1) return;
      const terminalTabs = s.terminalTabs.filter((t) => t !== ptyId);
      const { [ptyId]: _closed, ...tabMeta } = s.tabMeta;
      const activeTerminal = s.activeTerminal === ptyId ? (terminalTabs[Math.min(i, terminalTabs.length - 1)] ?? null) : s.activeTerminal;
      set({ terminalTabs, tabMeta, activeTerminal, drawerOpen: terminalTabs.length > 0 && s.drawerOpen });
    },

    setActiveTerminal(ptyId) {
      if (get().terminalTabs.includes(ptyId)) set({ activeTerminal: ptyId, drawerOpen: true });
    },

    closeAllTerminals() {
      set({ terminalTabs: [], tabMeta: {}, activeTerminal: null, drawerOpen: false });
    },

    setDrawerOpen(open) {
      set({ drawerOpen: open });
    },

    setDrawerHeight(px) {
      set({ drawerHeight: px });
    },

    openApproval(nodeRunId) {
      set({ approvalNodeRunId: nodeRunId });
    },


    openDiff(target) {
      set({ diffTarget: target });
    },



    rememberLoopSpec(edgeId, spec) {
      set({ lastLoopSpec: { ...get().lastLoopSpec, [edgeId]: spec } });
    },
  }));
}

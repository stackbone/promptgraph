import { create } from "zustand";

/**
 * Which repository's settings dialog is open (DESIGN §25.1): one per window, opened from the settings menu, from a
 * node form or the Run app button, and right after a repository is added on Home (`intro`, which offers the analysis
 * up front).
 */
export const useRepoSettingsDialog = create<{
  repoId: string | null;
  intro: boolean;
  open(repoId: string, opts?: { intro?: boolean }): void;
  close(): void;
}>()((set) => ({
  repoId: null,
  intro: false,
  open: (repoId, opts) => set({ repoId, intro: opts?.intro ?? false }),
  close: () => set({ repoId: null, intro: false }),
}));

export function openRepoSettings(repoId: string, opts?: { intro?: boolean }): void {
  useRepoSettingsDialog.getState().open(repoId, opts);
}

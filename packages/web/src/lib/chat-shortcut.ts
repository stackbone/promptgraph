/**
 * The chat shortcut (Ctrl+J / Alt+J, DESIGN §21.11) reaches the chat bar of the active tab: the keymap emits, the
 * active tab's ChatDock listens. Tabs without a chat bar (Home) ignore it.
 */
const listeners = new Set<() => void>();

export function onChatShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function emitChatShortcut(): void {
  for (const l of listeners) l();
}

/** The Git graph shortcut (Ctrl+Shift+G / Alt+Shift+G, DESIGN §13.7), heard by the active tab's GitGraphDock. */
const gitGraphListeners = new Set<() => void>();

export function onGitGraphShortcut(listener: () => void): () => void {
  gitGraphListeners.add(listener);
  return () => void gitGraphListeners.delete(listener);
}

export function emitGitGraphShortcut(): void {
  for (const l of gitGraphListeners) l();
}

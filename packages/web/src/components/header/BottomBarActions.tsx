import { createPortal } from "react-dom";
import { useDaemonStore } from "../../store/daemon-store";
import { useView } from "../../store/view/context";
import { SettingsMenu } from "../settings/SettingsMenu";
import { useTabContext } from "../tabs/tab-context";
import { PendingApprovals } from "./RunControls";

/**
 * The end of a repository tab's bottom bar (DESIGN §13.4): the pending approvals of this view's repository, then the
 * settings menu, right of the chats and the Git graph toggle. Only the active tab's view renders the settings menu
 * (its open state and the voice-settings event are global); Home, which has no bottom bar, keeps it in the tab
 * strip. Outside the tabbed app (tests) the approvals render inline.
 */
export function BottomBarActions() {
  const tab = useTabContext();
  const { repoId } = useView();
  const repoPath = useDaemonStore((s) => s.repos?.find((r) => r.id === repoId)?.path ?? null);
  if (!tab) return <PendingApprovals />;
  if (!tab.bottomBar) return null;
  return (
    <>
      {createPortal(
        <div className="order-2 flex shrink-0 items-center">
          <PendingApprovals side="top" />
        </div>,
        tab.bottomBar,
      )}
      {tab.active &&
        createPortal(
          <div className="order-3 flex shrink-0 items-center">
            <SettingsMenu repoPath={repoPath} side="top" />
          </div>,
          tab.bottomBar,
        )}
    </>
  );
}

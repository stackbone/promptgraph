import { toast } from "../store/toast-store";
import { getDesktopBridge, isExternalUrlAllowed } from "./desktop";

/**
 * Opens an application's URL (§25.4) in a new browser tab. The desktop window hands only `https:` URLs to the system
 * browser (§20.2), so a local `http:` URL is copied to the clipboard there instead, with a toast saying so.
 */
export async function openAppUrl(url: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (!bridge.isDesktop) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  if (isExternalUrlAllowed(url)) {
    await bridge.openExternal(url).catch(() => undefined);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("info", `Copied ${url}: paste it in your browser.`);
  } catch {
    toast("info", `The app is at ${url}`);
  }
}

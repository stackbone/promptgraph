import { useState } from "react";

/** A panel docked to the right of the tab's panel (chat, Git graph): its width, remembered per browser under `key`. */
export interface SidePanelSize {
  /** localStorage key of the width. */
  key: string;
  min: number;
  default: number;
}

function readWidth(size: SidePanelSize): number {
  try {
    const n = Number(localStorage.getItem(size.key));
    return Number.isFinite(n) && n >= size.min ? n : size.default;
  } catch {
    return size.default;
  }
}

export function useSidePanelWidth(size: SidePanelSize): [number, (width: number) => void] {
  return useState(() => readWidth(size));
}

/** A docked panel's left edge: drag (or ←/→) to resize, from `size.min` to 60 % of the window; the width is remembered per browser. */
export function SidePanelResizeHandle({
  size,
  width,
  onResize,
  label,
}: {
  size: SidePanelSize;
  width: number;
  onResize(width: number): void;
  label: string;
}) {
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, size.min), window.innerWidth * 0.6));
  const commit = (w: number) => {
    onResize(w);
    try {
      localStorage.setItem(size.key, String(w));
    } catch {
      // Storage unavailable: the width lasts for this page only.
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={size.min}
      tabIndex={0}
      className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let last = startWidth;
        const move = (ev: PointerEvent) => {
          last = clamp(startWidth + startX - ev.clientX);
          onResize(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          commit(last);
        };
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        commit(clamp(width + (e.key === "ArrowLeft" ? 32 : -32)));
      }}
    />
  );
}

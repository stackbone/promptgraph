import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Copies `text` to the clipboard; the icon turns into a check for a moment once it is copied. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? "Copied" : label}
      className={cn("shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground", className)}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

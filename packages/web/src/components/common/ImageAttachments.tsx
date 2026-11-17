import { imageLabel, MAX_IMAGES_PER_PROMPT } from "@promptgraph/shared";
import { ImageIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useRef, useState, type ClipboardEvent } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { errorMessage } from "../../api/rest";
import { clipboardImages, uploadImage, useImagePreview } from "../../lib/images";
import { toast } from "../../store/toast-store";

/**
 * Pasting images into a prompt field (DESIGN §25), as in Claude Code: Ctrl+V with an image on the clipboard adds it as
 * an "Image #N" chip instead of text. A paste that also carries plain text (cells copied from a spreadsheet) stays
 * text. Returns the textarea's onPaste and the number of uploads in flight. An upload that finishes after `owner`
 * changed (the inspector shows another node) is dropped, so it never lands on the wrong prompt.
 */
export function useImagePaste({
  owner,
  images,
  onChange,
  disabled = false,
}: {
  owner: string;
  images: readonly string[];
  onChange: (images: string[]) => void;
  disabled?: boolean;
}): { onPaste: (e: ClipboardEvent<HTMLElement>) => void; uploading: number } {
  const [uploading, setUploading] = useState(0);
  // Uploads finish one by one: each adds to the latest list, not to the one of its paste.
  const latest = useRef(images);
  latest.current = images;
  const change = useRef(onChange);
  change.current = onChange;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;

  const onPaste = (e: ClipboardEvent<HTMLElement>) => {
    if (disabled) return;
    const files = clipboardImages(e.clipboardData);
    if (files.length === 0 || e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    const room = MAX_IMAGES_PER_PROMPT - latest.current.length - uploading;
    if (room <= 0) {
      toast("error", `At most ${MAX_IMAGES_PER_PROMPT} images per prompt.`);
      return;
    }
    const pasteOwner = owner;
    if (files.length > room) toast("error", `At most ${MAX_IMAGES_PER_PROMPT} images per prompt: only the first ${room} were added.`);
    for (const file of files.slice(0, room)) {
      setUploading((n) => n + 1);
      uploadImage(file)
        .then((id) => {
          if (currentOwner.current !== pasteOwner || latest.current.length >= MAX_IMAGES_PER_PROMPT) return;
          const next = [...latest.current, id];
          latest.current = next;
          change.current(next);
        })
        .catch((err: unknown) => toast("error", `Image not added: ${errorMessage(err)}`))
        .finally(() => setUploading((n) => n - 1));
    }
  };
  return { onPaste, uploading };
}

/** The "Image #N" chips of a prompt; hovering or focusing one previews the image above it. */
export function ImageAttachments({
  images,
  onRemove,
  uploading = 0,
  className,
}: {
  images: readonly string[];
  /** Absent: read-only chips (no ×). */
  onRemove?: (index: number) => void;
  uploading?: number;
  className?: string;
}) {
  if (images.length === 0 && uploading === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1", className)} aria-label="Attached images">
      {images.map((id, i) => (
        <li key={`${id}-${i}`}>
          <ImageChip id={id} index={i} onRemove={onRemove ? () => onRemove(i) : undefined} />
        </li>
      ))}
      {uploading > 0 && (
        <li className="flex h-6 items-center gap-1 rounded-md border border-dashed px-1.5 text-[11px] text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
          {uploading === 1 ? "Adding image…" : `Adding ${uploading} images…`}
        </li>
      )}
    </ul>
  );
}

function ImageChip({ id, index, onRemove }: { id: string; index: number; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const label = imageLabel(index);
  return (
    <span className="flex h-6 items-center rounded-md border bg-muted/60 text-[11px] text-foreground" data-testid="image-chip">
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button type="button" className="flex h-full items-center gap-1 rounded-md px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${label} (preview)`}>
            <ImageIcon className="size-3 text-muted-foreground" aria-hidden="true" />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-none border bg-popover p-1 text-popover-foreground shadow-md [&_svg]:hidden">
          <ImagePreview id={id} label={label} enabled={open} />
        </TooltipContent>
      </Tooltip>
      {onRemove && (
        <button
          type="button"
          className="mr-0.5 flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          <XIcon className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function ImagePreview({ id, label, enabled }: { id: string; label: string; enabled: boolean }) {
  const url = useImagePreview(id, enabled);
  if (url === undefined) return <div className="flex size-24 items-center justify-center text-[11px] text-muted-foreground">Loading…</div>;
  if (url === null) return <div className="px-2 py-1 text-[11px] text-muted-foreground">The image is no longer available.</div>;
  return <img src={url} alt={label} className="block max-h-64 max-w-[min(20rem,80vw)] rounded object-contain" />;
}

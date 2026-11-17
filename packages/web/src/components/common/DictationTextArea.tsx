import { useId, useRef, type KeyboardEvent } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDictation } from "../../lib/voice/use-dictation";
import { useDaemonStore } from "../../store/daemon-store";
import { DictationPreview, DictationStatus, MicButton } from "../chat/Dictation";
import { ImageAttachments, useImagePaste } from "./ImageAttachments";

/**
 * A prompt textarea with voice dictation (DESIGN §22.6), the same UX as the chat composer: mic button, Space on an
 * empty field or Alt+Space, the partial transcript previewed dimmed at the cursor, Esc cancels. The transcript is
 * inserted at the cursor and never sent (voice.autoSubmit only applies to the chat). With `onImagesChange`, pasting an
 * image adds it as an "Image #N" chip below the field (§25).
 */
export function DictationTextArea({
  owner,
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  images,
  onImagesChange,
  "aria-label": ariaLabel,
}: {
  /** Identifies the field in the voice store (e.g. `prompt:<nodeId>`); changing it drops a recording in progress. */
  owner: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** Pasted images (ids of the daemon's image store), shown as chips; pasting needs onImagesChange. */
  images?: readonly string[];
  onImagesChange?: (images: string[]) => void;
  "aria-label"?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const statusId = useId();
  const connected = useDaemonStore((s) => s.connection === "open");
  const dictation = useDictation({ owner, inputRef, value, setValue: onChange, disabled: !connected || disabled === true });
  const listening = dictation.state === "recording" || dictation.state === "requesting_mic";
  const preview = dictation.insertion && dictation.partial ? dictation.insertion : null;
  const imageList = images ?? [];
  const canPasteImages = !!onImagesChange && disabled !== true;
  const paste = useImagePaste({ owner, images: imageList, onChange: (next) => onImagesChange?.(next), disabled: !canPasteImages });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    void dictation.onKeyDown(e);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1">
        <div className="relative grid min-w-0 flex-1">
          <Textarea
            ref={inputRef}
            aria-label={ariaLabel}
            aria-describedby={statusId}
            // leading-relaxed must come after the font-size classes, or cn drops it as a conflict.
            className={cn("field-sizing-fixed [grid-area:1/1] min-h-0 resize-y leading-relaxed", preview && "text-transparent caret-transparent")}
            rows={rows}
            value={value}
            placeholder={
              // No placeholder under the preview: both would be drawn at the same spot.
              preview ? "" : listening ? "Listening… speak now" : dictation.state === "transcribing" ? "Transcribing…" : placeholder
            }
            disabled={disabled}
            // Frozen while dictating: the transcript goes where the cursor was, Esc restores the text as it was.
            readOnly={dictation.active}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => void dictation.onKeyUp(e)}
            onPaste={paste.onPaste}
          />
          {preview && (
            <DictationPreview
              value={value}
              insertion={preview}
              partial={dictation.partial}
              textarea={inputRef.current}
              className="max-h-96 text-base leading-relaxed md:text-sm"
            />
          )}
        </div>
        {!disabled && <MicButton dictation={dictation} disabled={!connected} size="icon-sm" />}
      </div>
      <ImageAttachments
        images={imageList}
        uploading={paste.uploading}
        onRemove={canPasteImages ? (i) => onImagesChange?.(imageList.filter((_, j) => j !== i)) : undefined}
      />
      <div id={statusId}>
        <DictationStatus dictation={dictation} />
      </div>
    </div>
  );
}

import { z } from "zod";

/**
 * Pasted images (DESIGN §25): the chat composer and the prompt field of `prompt` nodes accept images from the
 * clipboard. The browser uploads each one to the daemon (`POST /api/images`), which keeps it content-addressed in
 * `~/.promptgraph/images/<sha256>.<ext>`; chat messages and node configs refer to it by that id.
 */

/** Image types Claude accepts, with the file extension the daemon stores them under. */
export const IMAGE_MEDIA_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageMediaType = keyof typeof IMAGE_MEDIA_TYPES;
export const ImageMediaTypeSchema = z.enum(Object.keys(IMAGE_MEDIA_TYPES) as [ImageMediaType, ...ImageMediaType[]]);

/** Largest image the daemon stores (the Claude API refuses images above 5 MB once base64-encoded). */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Most images one chat message or one prompt node carries. */
export const MAX_IMAGES_PER_PROMPT = 10;

/** `<sha256 of the bytes, hex>.<extension>`: the id names the file and gives its media type. */
export const ImageIdSchema = z.string().regex(/^[0-9a-f]{64}\.(png|jpg|gif|webp)$/, "Invalid image id");
export type ImageId = z.infer<typeof ImageIdSchema>;

export const ImageIdListSchema = z.array(ImageIdSchema).max(MAX_IMAGES_PER_PROMPT);

/** The media type of a stored image, from the extension in its id. */
export function imageMediaType(id: ImageId): ImageMediaType {
  const ext = id.slice(id.lastIndexOf(".") + 1);
  const entry = Object.entries(IMAGE_MEDIA_TYPES).find(([, e]) => e === ext);
  if (!entry) throw new Error(`Invalid image id: ${id}`);
  return entry[0] as ImageMediaType;
}

/** POST /api/images: the image bytes, base64 (API writes are JSON only, §14). */
export const UploadImageRequestSchema = z.object({ mediaType: ImageMediaTypeSchema, data: z.string().min(1) });
export type UploadImageRequest = z.infer<typeof UploadImageRequestSchema>;

/** POST /api/images → the stored image's id; GET /api/images/:id → the id, media type and base64 bytes. */
export const UploadImageResponseSchema = z.object({ id: ImageIdSchema, bytes: z.number().int().nonnegative() });
export type UploadImageResponse = z.infer<typeof UploadImageResponseSchema>;
export const GetImageResponseSchema = z.object({ id: ImageIdSchema, mediaType: ImageMediaTypeSchema, data: z.string() });
export type GetImageResponse = z.infer<typeof GetImageResponseSchema>;

/** "Image #1": how the UI and the prompt sent to Claude name the n-th image (1-based), as Claude Code does. */
export const imageLabel = (index: number) => `Image #${index + 1}`;

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IMAGE_MEDIA_TYPES, ImageIdSchema, MAX_IMAGE_BYTES, imageMediaType, type ImageId, type ImageMediaType } from "@promptgraph/shared";

/** An image upload the store refuses (bad type, too large, unknown id). */
export class ImageError extends Error {
  constructor(
    readonly code: "invalid_image" | "image_too_large" | "image_not_found",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The media type the bytes really are, from their signature: the declared type is never trusted, so a file
 * stored as `.png` is a PNG. null when the bytes are none of the accepted types.
 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  const starts = (sig: number[], offset = 0) => bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** The id an image gets in the store: sha256 of its bytes + the extension of its type. */
export function imageIdOf(bytes: Uint8Array, mediaType: ImageMediaType): ImageId {
  return `${crypto.createHash("sha256").update(bytes).digest("hex")}.${IMAGE_MEDIA_TYPES[mediaType]}`;
}

/**
 * Content-addressed store of pasted images (DESIGN §25): `<dir>/<sha256>.<ext>`, directory 0700, files 0600,
 * written atomically. The same image pasted twice is stored once. Images are never deleted: a graph file or a
 * chat transcript may still refer to them.
 */
export class ImageStore {
  constructor(readonly dir: string) {}

  /** Stores the image and returns its id; the type comes from the bytes, `declared` must match it. */
  put(bytes: Uint8Array, declared?: ImageMediaType): { id: ImageId; bytes: number } {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageError("image_too_large", `Images are limited to ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(2)} MB`);
    }
    const type = sniffImageType(bytes);
    if (!type) throw new ImageError("invalid_image", "Not a PNG, JPEG, GIF or WebP image");
    if (declared && declared !== type) throw new ImageError("invalid_image", `The image is ${type}, not ${declared}`);
    const id = imageIdOf(bytes, type);
    const file = this.file(id);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, bytes, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return { id, bytes: bytes.length };
  }

  has(id: string): boolean {
    return ImageIdSchema.safeParse(id).success && fs.existsSync(this.file(id));
  }

  /** The image's bytes and type; ImageError `image_not_found` when the id is invalid or not stored. */
  read(id: string): { mediaType: ImageMediaType; bytes: Buffer } {
    if (!ImageIdSchema.safeParse(id).success) throw new ImageError("image_not_found", `Invalid image id: ${id}`);
    try {
      return { mediaType: imageMediaType(id), bytes: fs.readFileSync(this.file(id)) };
    } catch {
      throw new ImageError("image_not_found", `Image ${id} is not in the image store`);
    }
  }

  /** Absolute path of a stored image (validated id). */
  file(id: string): string {
    if (!ImageIdSchema.safeParse(id).success) throw new ImageError("image_not_found", `Invalid image id: ${id}`);
    return path.join(this.dir, id);
  }
}

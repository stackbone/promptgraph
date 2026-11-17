import { API, MAX_IMAGE_BYTES, UploadImageRequestSchema, type GetImageResponse, type UploadImageResponse } from "@promptgraph/shared";
import type { DaemonContext } from "../../daemon/context.js";
import { ImageError } from "../../images/image-store.js";
import { readBody } from "../errors.js";
import type { App } from "../repo-scope.js";

/** Longest base64 text of an image the store accepts (4 characters per 3 bytes, padded). */
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * Pasted images (DESIGN §25), daemon-wide: POST /api/images stores one (JSON `{mediaType, data}` with the bytes in
 * base64, since API writes are JSON only) and returns its content-addressed id; GET /api/images/:id returns it,
 * base64 again, for the UI's previews (an `<img src>` to the API would be refused by the Fetch Metadata rule).
 */
export function registerImageRoutes(app: App, daemon: DaemonContext): void {
  app.post(API.images, async (c) => {
    const body = await readBody(c, UploadImageRequestSchema);
    if (body.data.length > MAX_BASE64_CHARS) throw new ImageError("image_too_large", `Images are limited to ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(2)} MB`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new ImageError("invalid_image", "The image data is not base64");
    return c.json<UploadImageResponse>(daemon.images.put(Buffer.from(body.data, "base64"), body.mediaType));
  });
  app.get("/api/images/:id", (c) => {
    const id = c.req.param("id");
    const { mediaType, bytes } = daemon.images.read(id);
    return c.json<GetImageResponse>({ id, mediaType, data: bytes.toString("base64") });
  });
}

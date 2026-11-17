import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, type ImageMediaType } from "@promptgraph/shared";
import { useEffect, useState } from "react";
import { daemonApi } from "../api/rest";

/**
 * Pasted images (DESIGN §25): files taken from a paste, uploaded to the daemon's image store, and previews of stored
 * images. An image of another type (BMP, TIFF…), larger than the store accepts, or wider than Claude reads well is
 * re-encoded in the browser first.
 */

const isAccepted = (type: string): type is ImageMediaType => type in IMAGE_MEDIA_TYPES;

/** Longest side Claude reads at full detail; larger images are scaled down before they are sent. */
const MAX_IMAGE_SIDE = 2000;

/** The image files of a paste (screenshots, copied images); text or other files give []. */
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) for (const file of Array.from(data.files ?? [])) if (file.type.startsWith("image/")) files.push(file);
  return files;
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Re-encodes an image through a canvas: at most MAX_IMAGE_SIDE wide or high, PNG, or JPEG when the PNG is too large. */
async function reencode(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot convert the image");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) =>
    new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), type, quality));
  const png = await encode("image/png");
  return png.size <= MAX_IMAGE_BYTES ? png : encode("image/jpeg", 0.85);
}

async function needsReencode(file: Blob): Promise<boolean> {
  if (!isAccepted(file.type) || file.size > MAX_IMAGE_BYTES) return true;
  if (typeof createImageBitmap !== "function") return false;
  try {
    const bitmap = await createImageBitmap(file);
    const large = Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_SIDE;
    bitmap.close();
    // An animated GIF would lose its frames: only scale a GIF that the store would refuse anyway.
    return large && file.type !== "image/gif";
  } catch {
    return false;
  }
}

const previews = new Map<string, Promise<string>>();

/** Uploads a pasted image; resolves to its id in the image store. */
export async function uploadImage(file: Blob): Promise<string> {
  const blob = (await needsReencode(file)) ? await reencode(file) : file;
  if (!isAccepted(blob.type)) throw new Error("Only PNG, JPEG, GIF and WebP images can be sent");
  const data = base64(await blob.arrayBuffer());
  const { id } = await daemonApi.uploadImage({ mediaType: blob.type, data });
  // The preview is known already: no round trip when the chip is hovered.
  if (!previews.has(id)) previews.set(id, Promise.resolve(`data:${blob.type};base64,${data}`));
  return id;
}

/** A data URL of a stored image, fetched once per id. */
export function imagePreview(id: string): Promise<string> {
  let p = previews.get(id);
  if (!p) {
    p = daemonApi.getImage(id).then((img) => `data:${img.mediaType};base64,${img.data}`);
    p.catch(() => previews.delete(id));
    previews.set(id, p);
  }
  return p;
}

/** The preview of image `id` while `enabled` (e.g. while its tooltip is open): undefined while loading, null on failure. */
export function useImagePreview(id: string, enabled = true): string | null | undefined {
  const [state, setState] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    imagePreview(id).then(
      (url) => live && setState({ id, url }),
      () => live && setState({ id, url: null }),
    );
    return () => {
      live = false;
    };
  }, [id, enabled]);
  return state?.id === id ? state.url : undefined;
}

/** Test seam. */
export function clearImagePreviews(): void {
  previews.clear();
}

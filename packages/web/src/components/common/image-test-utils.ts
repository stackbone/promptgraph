/** Test helpers for pasted images (§25). */

/** A stored image id (any sha256 hex works: the store is mocked). */
export const IMAGE_ID = `${"ab".repeat(32)}.png`;

/** The clipboardData of a paste carrying `file` and, optionally, plain text. */
export function clipboardWith(file: File, text = ""): Pick<DataTransfer, "items" | "files" | "getData"> {
  const items = [{ kind: "file", type: file.type, getAsFile: () => file }] as unknown as DataTransferItemList;
  return { items, files: [file] as unknown as FileList, getData: (format: string) => (format === "text/plain" ? text : "") };
}

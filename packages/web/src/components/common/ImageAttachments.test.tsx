// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as plainRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonApi } from "../../api/rest";
import { clearImagePreviews } from "../../lib/images";
import { useDaemonStore } from "../../store/daemon-store";
import { createTestView } from "../../store/view/test-view";
import { DictationTextArea } from "./DictationTextArea";
import { clipboardWith, IMAGE_ID } from "./image-test-utils";
import { ImageAttachments } from "./ImageAttachments";

/** DictationTextArea reads the view (voice dictation); the chips alone do not. */
const render = (ui: ReactElement) => createTestView().render(ui);

const png = () => new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });

function PromptField({ initial = [], onImages, disabled }: { initial?: string[]; onImages?: (images: string[]) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState(initial);
  return (
    <DictationTextArea
      owner="prompt:n1"
      aria-label="Prompt"
      value={value}
      onChange={setValue}
      disabled={disabled}
      images={images}
      onImagesChange={(next) => {
        setImages(next);
        onImages?.(next);
      }}
    />
  );
}

describe("pasted images", () => {
  beforeEach(() => {
    clearImagePreviews();
    useDaemonStore.setState({ connection: "open" });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("adds pasted images to a prompt as numbered chips, in order, and removes them", async () => {
    let n = 0;
    vi.spyOn(daemonApi, "uploadImage").mockImplementation(async () => ({ id: `${String(++n).repeat(64)}.png`, bytes: 4 }));
    const onImages = vi.fn();
    const user = userEvent.setup();
    render(<PromptField onImages={onImages} />);
    const box = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.paste(box, { clipboardData: clipboardWith(png()) });
    fireEvent.paste(box, { clipboardData: clipboardWith(png()) });
    await waitFor(() => expect(screen.getAllByTestId("image-chip")).toHaveLength(2));
    expect(onImages).toHaveBeenLastCalledWith([`${"1".repeat(64)}.png`, `${"2".repeat(64)}.png`]);
    expect(screen.getByRole("button", { name: "Image #2 (preview)" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove Image #1" }));
    expect(onImages).toHaveBeenLastCalledWith([`${"2".repeat(64)}.png`]);
    // The remaining image is renumbered.
    expect(screen.getByRole("button", { name: "Image #1 (preview)" })).toBeTruthy();
  });

  it("previews the image above its chip on hover, fetched once", async () => {
    const get = vi.spyOn(daemonApi, "getImage").mockResolvedValue({ id: IMAGE_ID, mediaType: "image/png", data: "AQID" });
    const user = userEvent.setup();
    plainRender(<ImageAttachments images={[IMAGE_ID]} />);
    expect(get).not.toHaveBeenCalled();
    await user.hover(screen.getByRole("button", { name: "Image #1 (preview)" }));
    const [img] = await screen.findAllByRole("img", { name: "Image #1" });
    expect(img!.getAttribute("src")).toBe("data:image/png;base64,AQID");
    expect(document.querySelector('[data-slot="tooltip-content"]')?.getAttribute("data-side")).toBe("top");
    await user.unhover(screen.getByRole("button", { name: "Image #1 (preview)" }));
    await user.hover(screen.getByRole("button", { name: "Image #1 (preview)" }));
    await screen.findAllByRole("img", { name: "Image #1" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("says when a stored image is gone", async () => {
    vi.spyOn(daemonApi, "getImage").mockRejectedValue(new Error("404"));
    plainRender(<ImageAttachments images={[IMAGE_ID]} />);
    act(() => screen.getByRole("button", { name: "Image #1 (preview)" }).focus());
    expect((await screen.findAllByText("The image is no longer available.")).length).toBeGreaterThan(0);
  });

  it("a disabled prompt shows its images read-only and takes no paste", () => {
    const upload = vi.spyOn(daemonApi, "uploadImage");
    render(<PromptField initial={[IMAGE_ID]} disabled />);
    expect(screen.getByRole("button", { name: "Image #1 (preview)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Image #1" })).toBeNull();
    fireEvent.paste(screen.getByRole("textbox", { name: "Prompt" }), { clipboardData: clipboardWith(png()) });
    expect(upload).not.toHaveBeenCalled();
  });

  it("drops an upload that finishes after the field moved to another prompt", async () => {
    let finish: (v: { id: string; bytes: number }) => void = () => {};
    vi.spyOn(daemonApi, "uploadImage").mockImplementation(() => new Promise((r) => (finish = r)));
    const onImages = vi.fn();
    function Switching({ owner }: { owner: string }) {
      return <DictationTextArea owner={owner} aria-label="Prompt" value="" onChange={() => {}} images={[]} onImagesChange={onImages} />;
    }
    const r = render(<Switching owner="prompt:a" />);
    fireEvent.paste(screen.getByRole("textbox", { name: "Prompt" }), { clipboardData: clipboardWith(png()) });
    await waitFor(() => expect(daemonApi.uploadImage).toHaveBeenCalled());
    r.rerender(<Switching owner="prompt:b" />);
    await act(async () => finish({ id: IMAGE_ID, bytes: 4 }));
    expect(onImages).not.toHaveBeenCalled();
  });
});

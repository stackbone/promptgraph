// @vitest-environment jsdom
import type { ClientMessage, Graph, SaveGraphResponse, VoiceStatus } from "@promptgraph/shared";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearGraph, voiceStatusOf } from "../../test-fixtures";
import { useDaemonStore } from "../../store/daemon-store";
import { createDispatcher } from "../../store/dispatcher";
import { createTestView, type TestView } from "../../store/view/test-view";
import { resetVoiceStore, setVoiceDeps, useVoiceStore } from "../../store/voice-store";
import { DictationTextArea } from "./DictationTextArea";

let view: TestView;
let dispatcher = createDispatcher();
const voiceSent: ClientMessage[] = [];
let ids = 0;

function Field({ owner, label, initial = "" }: { owner: string; label: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <DictationTextArea owner={owner} aria-label={label} value={value} onChange={setValue} />;
}

function Harness({ firstOwner = "prompt:a" }: { firstOwner?: string }) {
  return (
    <>
      <Field owner={firstOwner} label="First" initial="Fix the bug" />
      <Field owner="prompt:b" label="Second" />
    </>
  );
}

const box = (name: string) => screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
const recording = () => useVoiceStore.getState().state === "recording";

async function renderFields(voice: Partial<VoiceStatus> = {}) {
  const status = voiceStatusOf(voice);
  setVoiceDeps({ getStatus: async () => status });
  useVoiceStore.setState({ status });
  const user = userEvent.setup();
  const r = view.render(<Harness />);
  return { user, r };
}

describe("DictationTextArea", () => {
  beforeEach(async () => {
    voiceSent.length = 0;
    ids = 0;
    resetVoiceStore();
    setVoiceDeps({
      send: (msg) => {
        voiceSent.push(msg);
        return true;
      },
      sendBinary: () => true,
      startCapture: async () => ({ stop: vi.fn((): Uint8Array<ArrayBuffer> | null => null) }),
      newId: () => `v${++ids}`,
    });
    const graph: Graph = linearGraph();
    dispatcher = createDispatcher();
    view = createTestView({
      graphId: "g1",
      persistence: {
        load: async () => ({ graph, hash: "h0", modifiedOutside: false, activeRunId: null }),
        save: async (g: Graph): Promise<SaveGraphResponse> => ({ graph: g, hash: "h1" }),
      },
    });
    await view.editor.getState().load();
    useDaemonStore.setState({ connection: "open" });
  });
  afterEach(() => {
    cleanup();
    resetVoiceStore();
  });

  it("Alt+Space dictates into the prompt at the cursor; autoSubmit never applies", async () => {
    const { user } = await renderFields({ mode: "tap", autoSubmit: true });
    box("First").focus();
    box("First").setSelectionRange(11, 11);
    await user.keyboard("{Alt>}[Space]{/Alt}");
    await waitFor(() => expect(recording()).toBe(true));
    expect(useVoiceStore.getState().owner).toBe("prompt:a");
    act(() => dispatcher.handle({ type: "voice:partial", voiceId: "v1", text: "in the parser" }));
    expect(screen.getByTestId("dictation-preview").textContent).toBe("Fix the bug in the parser");
    expect(box("First").value).toBe("Fix the bug");
    await user.keyboard("{Alt>}[Space]{/Alt}");
    expect(voiceSent.at(-1)).toEqual({ type: "voice:stop", voiceId: "v1" });
    act(() => dispatcher.handle({ type: "voice:final", voiceId: "v1", text: "in the parser" }));
    expect(box("First").value).toBe("Fix the bug in the parser");
    expect(useVoiceStore.getState().notice).toBeNull();
  });

  it("only the field that started the recording shows it, and another field cannot start a second one", async () => {
    const { user } = await renderFields({ mode: "tap" });
    box("First").focus();
    box("First").setSelectionRange(11, 11);
    await user.keyboard("{Alt>}[Space]{/Alt}");
    await waitFor(() => expect(recording()).toBe(true));
    expect(screen.getAllByRole("button", { name: "Stop dictation" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(1);
    expect(screen.getAllByTestId("dictation-status").filter((s) => /Listening/.test(s.textContent ?? ""))).toHaveLength(1);
    expect(box("Second").readOnly).toBe(false);

    // The second field's mic does not stop or replace the first field's recording.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Dictate" }), { button: 0 });
    fireEvent.pointerUp(screen.getByRole("button", { name: "Dictate" }), { button: 0 });
    await act(async () => undefined);
    expect(recording()).toBe(true);
    expect(useVoiceStore.getState().owner).toBe("prompt:a");
    expect(voiceSent.filter((m) => m.type === "voice:start")).toHaveLength(1);

    act(() => dispatcher.handle({ type: "voice:final", voiceId: "v1", text: "now" }));
    expect(box("First").value).toBe("Fix the bug now");
    expect(box("Second").value).toBe("");
  });

  it("a field that becomes another node's drops its recording", async () => {
    const { user, r } = await renderFields({ mode: "tap" });
    box("First").focus();
    await user.keyboard("{Alt>}[Space]{/Alt}");
    await waitFor(() => expect(recording()).toBe(true));
    r.rerender(<Harness firstOwner="prompt:c" />);
    expect(useVoiceStore.getState().state).toBe("idle");
    expect(voiceSent.at(-1)).toEqual({ type: "voice:cancel", voiceId: "v1" });
    expect(box("First").value).toBe("Fix the bug");
  });

  it("a disabled field has no mic button", async () => {
    view.render(<DictationTextArea owner="prompt:x" aria-label="Locked" value="" onChange={() => undefined} disabled />);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });
});

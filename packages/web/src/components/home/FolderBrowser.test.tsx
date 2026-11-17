// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListDirsResponse } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDaemon, resetGlobals } from "../../test-daemon";
import { FolderBrowser } from "./FolderPicker";

const HOME = "/home/you";

/** A fake tree: each listed directory and its subfolders. */
const TREE: Record<string, string[]> = {
  [HOME]: ["Desktop", "Documents", "app-routes", "Projects", "Pictures"],
  [`${HOME}/Projects`]: ["promptgraph", "other"],
  [`${HOME}/Projects/promptgraph`]: [],
};

function listing(path: string): ListDirsResponse {
  const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  return {
    path,
    parent,
    home: HOME,
    isGitRepo: path.endsWith("promptgraph"),
    entries: (TREE[path] ?? []).map((name) => ({ name, path: `${path}/${name}`, isGitRepo: name === "promptgraph" })),
  };
}

function install() {
  installFakeDaemon({
    override: (method, path) => {
      if (method !== "GET" || !path.startsWith("/api/fs/dirs")) return undefined;
      const p = new URL(path, "http://x").searchParams.get("path") ?? HOME;
      return new Response(JSON.stringify(listing(p)), { status: 200 });
    },
  });
}

const folders = () => within(screen.getByRole("listbox", { name: "Folders" }));
const highlighted = () => folders().getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;
const current = () => screen.getByRole("navigation", { name: "Current folder" }).querySelector("[aria-current]")?.textContent;

beforeEach(() => resetGlobals());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FolderBrowser type-to-find (DESIGN §13.3)", () => {
  it("filters as you type, highlights the best match and enters it with Enter", async () => {
    install();
    const user = userEvent.setup();
    render(<FolderBrowser onSelect={() => {}} onClose={() => {}} />);
    await folders().findByText("Desktop");
    const filter = screen.getByRole("combobox", { name: "Filter folders" });
    expect(document.activeElement).toBe(filter);

    await user.keyboard("pr");
    expect(highlighted()).toBe("Projects");
    expect(folders().queryByText("Desktop")).toBeNull();
    expect(folders().getAllByRole("option").map((o) => o.textContent)).toEqual(["Projects", "Pictures", "app-routes"]);

    await user.keyboard("{ArrowUp}");
    expect(highlighted()).toBe("app-routes");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(current()).toBe("Projects"));
    expect((filter as HTMLInputElement).value).toBe("");
    expect(highlighted()).toBeUndefined();

    await user.keyboard("{Backspace}");
    await waitFor(() => expect(current()).toBe("~"));
  });

  it("adds the current folder with Ctrl+Enter and clears the filter before closing on Escape", async () => {
    install();
    const user = userEvent.setup();
    const selected: string[] = [];
    let closed = 0;
    render(<FolderBrowser initialPath={`${HOME}/Projects`} onSelect={(p) => selected.push(p)} onClose={() => closed++} />);
    await folders().findByText("other");

    await user.keyboard("zzz");
    expect(folders().getByText(/No folder matches/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect((screen.getByRole("combobox", { name: "Filter folders" }) as HTMLInputElement).value).toBe("");
    expect(closed).toBe(0);

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(selected).toEqual([`${HOME}/Projects`]);
    await user.keyboard("{Escape}");
    expect(closed).toBe(1);
  });
});

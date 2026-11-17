import fs from "node:fs";
import path from "node:path";
import { API, MAX_IMAGE_BYTES, type ChatContext } from "@promptgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatError, ChatManager } from "../src/chat/chat-manager.js";
import type { ChatMcpLaunch } from "../src/chat/launch.js";
import { userTurnLine } from "../src/chat/protocol.js";
import { chatItemsFromTranscript } from "../src/chat/transcript.js";
import { EventBus } from "../src/events/bus.js";
import { createHttpApp } from "../src/http/app.js";
import { ImageError, ImageStore, imageIdOf, sniffImageType } from "../src/images/image-store.js";
import { openDatabase, Store } from "../src/store/store.js";
import { createTempRepo, tempDir } from "./helpers.js";
import { fakeSpawner } from "./support/fake-chat-child.js";
import { createTestDaemon, TEST_TOKEN, type TestDaemon } from "./support/test-daemon.js";

/** A 1×1 transparent PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function store(): ImageStore {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return new ImageStore(path.join(t.dir, "images"));
}

describe("ImageStore", () => {
  it("knows image types by their signature, never by the declared type", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(Buffer.from("<svg/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF0000WAVE"))).toBeNull();
  });

  it("stores images content-addressed and privately, once", () => {
    const s = store();
    const { id, bytes } = s.put(PNG, "image/png");
    expect(id).toBe(imageIdOf(PNG, "image/png"));
    expect(id).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(bytes).toBe(PNG.length);
    expect(s.put(PNG).id).toBe(id);
    expect(fs.readdirSync(s.dir)).toEqual([id]);
    expect(fs.statSync(s.file(id)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(s.has(id)).toBe(true);
    expect(s.read(id)).toEqual({ mediaType: "image/png", bytes: PNG });
  });

  it("refuses what is not an accepted image, too large or mislabelled", () => {
    const s = store();
    expect(() => s.put(Buffer.from("<svg onload=alert(1)/>"))).toThrow(ImageError);
    expect(() => s.put(PNG, "image/jpeg")).toThrow(/is image\/png/);
    expect(() => s.put(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).toThrow(expect.objectContaining({ code: "image_too_large" }));
    expect(() => s.read("../token")).toThrow(expect.objectContaining({ code: "image_not_found" }));
    expect(() => s.file("../../token.png")).toThrow(ImageError);
    expect(() => s.read(`${"0".repeat(64)}.png`)).toThrow(expect.objectContaining({ code: "image_not_found" }));
    expect(s.has("nope")).toBe(false);
  });
});

describe("image routes", () => {
  const HEADERS = { host: "127.0.0.1:4777", authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };
  let daemon: TestDaemon;

  beforeEach(async () => {
    const t = tempDir();
    const r = createTempRepo();
    cleanups.push(t.cleanup, r.cleanup);
    daemon = await createTestDaemon({ root: t.dir, repos: [r.repo], mockEngines: true });
    cleanups.push(() => daemon.close());
  });

  it("uploads and reads images behind the token", async () => {
    const app = createHttpApp(daemon.ctx);
    const body = JSON.stringify({ mediaType: "image/png", data: PNG.toString("base64") });
    expect((await app.request(API.images, { method: "POST", headers: { host: HEADERS.host, "content-type": "application/json" }, body })).status).toBe(401);

    const res = await app.request(API.images, { method: "POST", headers: HEADERS, body });
    expect(res.status).toBe(200);
    const { id, bytes } = (await res.json()) as { id: string; bytes: number };
    expect(bytes).toBe(PNG.length);
    expect(fs.existsSync(path.join(daemon.ctx.paths.home, "images", id))).toBe(true);

    const got = await app.request(API.image(id), { headers: HEADERS });
    expect(await got.json()).toEqual({ id, mediaType: "image/png", data: PNG.toString("base64") });
    expect((await app.request(API.image(`${"a".repeat(64)}.png`), { headers: HEADERS })).status).toBe(404);
    expect((await app.request(API.image("..%2Ftoken"), { headers: HEADERS })).status).toBe(404);
  });

  it("refuses bad uploads", async () => {
    const app = createHttpApp(daemon.ctx);
    const post = (b: unknown) => app.request(API.images, { method: "POST", headers: HEADERS, body: JSON.stringify(b) });
    expect((await post({ mediaType: "image/svg+xml", data: "PHN2Zy8+" })).status).toBe(400);
    expect((await post({ mediaType: "image/png", data: "not base64!" })).status).toBe(400);
    expect((await post({ mediaType: "image/png", data: Buffer.from("hello").toString("base64") })).status).toBe(400);
    expect((await post({ mediaType: "image/png", data: "A".repeat(MAX_IMAGE_BYTES * 2) })).status).toBe(413);
  });
});

describe("chat images", () => {
  const MCP: ChatMcpLaunch = { pluginDir: "/opt/pg/plugins/promptgraph", mcpConfig: null, toolPrefix: "mcp__plugin_promptgraph_promptgraph__", env: {} };
  const CONTEXT: ChatContext = { graphId: null, selectedNodeIds: [], selectedEdgeIds: [], runId: null, readOnly: true };

  it("encodes image blocks before the text of a user turn", () => {
    expect(JSON.parse(userTurnLine("look", [{ mediaType: "image/png", data: "AAAA" }]))).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "look" },
        ],
      },
    });
  });

  it("sends stored images with the message, image-only messages included, and refuses missing ones", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const images = new ImageStore(path.join(t.dir, "images"));
    const { id } = images.put(PNG);
    const db = new Store(openDatabase(":memory:"));
    cleanups.push(() => {
      db.db.close();
    });
    const fake = fakeSpawner();
    const env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: path.join(t.dir, "claude"), PG_CLAUDE_BIN: "/fake/claude" };
    const manager = new ChatManager({ store: db, bus: new EventBus(), repoId: "r-0123abcd", repoPath: "/repo", env, mcp: () => MCP, spawner: fake.spawner, newSessionId: () => "s1", images });
    manager.create();

    expect(() => manager.send("s1", "  ", CONTEXT)).toThrow(ChatError);
    expect(() => manager.send("s1", "x", CONTEXT, [`${"b".repeat(64)}.png`])).toThrow(/Image not sent/);
    expect(manager.get("s1")!.items).toEqual([]);

    manager.send("s1", "", CONTEXT, [id]);
    const content = (fake.last().writtenJson[0] as { message: { content: Array<Record<string, unknown>> } }).message.content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(content[1]).toMatchObject({ type: "text" });
    expect(manager.get("s1")!.items).toMatchObject([{ kind: "user", text: "", images: [id] }]);
    expect(manager.list()[0]!.title).toBe("Image");

    // Without an image store, a message with images is refused.
    const plain = new ChatManager({ store: db, bus: new EventBus(), repoId: "r-0123abcd", repoPath: "/repo", env, mcp: () => MCP, spawner: fake.spawner, newSessionId: () => "s2" });
    plain.create();
    expect(() => plain.send("s2", "x", CONTEXT, [id])).toThrow(/cannot receive images/);
  });

  it("gives the image ids back when the history is rebuilt from the transcript", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = path.join(t.dir, "s.jsonl");
    const user = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
          { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
          { type: "text", text: '<promptgraph-context graph="none" selected-nodes="" selected-edges="" run="none" read-only="true" />\n\n' },
        ],
      },
    };
    fs.writeFileSync(file, `${JSON.stringify(user)}\n`);
    expect(chatItemsFromTranscript(file)).toMatchObject([{ kind: "user", text: "", images: [imageIdOf(PNG, "image/png")] }]);
  });
});

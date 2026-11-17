import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageMediaTypeSchema, MAX_IMAGES_PER_PROMPT, stripChatContext, type ChatItem } from "@promptgraph/shared";
import { imageIdOf } from "../images/image-store.js";
import { ChatNormalizer } from "./normalize.js";

/** Transcripts larger than this are not read back into the chat. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), "projects") : path.join(os.homedir(), ".claude", "projects");
}

/** Claude Code's project dir name for a cwd: every non-alphanumeric character becomes "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Transcript of a chat session: `<projects>/<project dir of cwd>/<sessionId>.jsonl`; when that file is
 * missing (Claude Code shortens very long dir names), any `<projects>/*\/<sessionId>.jsonl`. Null if none.
 */
export function findChatTranscript(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const root = claudeProjectsDir(env);
  const file = `${sessionId}.jsonl`;
  const direct = path.join(root, projectDirName(cwd), file);
  if (fs.existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  return dirs.map((d) => path.join(root, d, file)).find((p) => fs.existsSync(p)) ?? null;
}

interface TranscriptLine {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

/** User text Claude Code writes itself (slash command echoes, caveats): not shown. */
const SYNTHETIC_USER_TEXT = /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/**
 * Chat items rebuilt from a Claude transcript JSONL (after a server restart, §21.8): user messages
 * (context block stripped), assistant text, tool uses and tool results. Permission prompts, results
 * and notices are not in the transcript. Missing or unreadable file → [].
 */
export function chatItemsFromTranscript(file: string, cwd?: string): ChatItem[] {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let n = 0;
  let ts = 0;
  const newId = () => `t${++n}`;
  const normalizer = new ChatNormalizer({ newId, now: () => ts, cwd });
  const items: ChatItem[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if (!line || typeof line !== "object" || line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) continue;
    if (line.type !== "user" && line.type !== "assistant") continue;
    const parsedTs = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (!Number.isNaN(parsedTs)) ts = parsedTs;
    if (line.type === "user") {
      const content = line.message?.content;
      const userText = userTextOf(content);
      const images = userImagesOf(content);
      if (userText !== null || images.length) {
        items.push({ id: newId(), ts, kind: "user", text: userText ?? "", ...(images.length ? { images } : {}) });
      }
    }
    for (const event of normalizer.handle(line)) if (event.kind === "item") items.push(event.item);
  }
  return items;
}

/**
 * Ids of the images a user message carried (§25). The transcript holds their bytes, and the image store is
 * content-addressed, so hashing them gives back the ids the message was sent with.
 */
function userImagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content as unknown[]) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") continue;
    const source = (block as { source?: { type?: unknown; media_type?: unknown; data?: unknown } }).source;
    const type = ImageMediaTypeSchema.safeParse(source?.media_type);
    if (source?.type !== "base64" || !type.success || typeof source.data !== "string") continue;
    ids.push(imageIdOf(Buffer.from(source.data, "base64"), type.data));
  }
  return ids.slice(0, MAX_IMAGES_PER_PROMPT);
}

function userTextOf(content: unknown): string | null {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type: "text"; text: string } => !!b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } else return null;
  if (!text.trim() || SYNTHETIC_USER_TEXT.test(text)) return null;
  return stripChatContext(text);
}

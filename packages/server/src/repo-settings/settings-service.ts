import fs from "node:fs";
import path from "node:path";
import {
  EMPTY_REPO_SETTINGS,
  IDLE_ANALYSIS,
  REPO_SETTINGS_FILE,
  RepoSettingsSchema,
  type RepoAnalysis,
  type RepoSettings,
  type RepoSettingsResponse,
} from "@promptgraph/shared";
import { hashContent } from "../graphs/graph-store.js";
import { errorMessage } from "../util/text.js";
import { analyzeRepository, type AnalyzeRepositoryOptions } from "./analyzer.js";

export class RepoSettingsError extends Error {
  constructor(
    readonly code: "settings_conflict" | "analysis_running",
    message: string,
  ) {
    super(message);
  }
}

export interface RepoSettingsServiceDeps {
  repoPath: string;
  /** Base env of the analysis' claude process. */
  env?: NodeJS.ProcessEnv;
  /** Called after every change of the file or of the analysis (the daemon broadcasts `repo-settings:update`). */
  onChange?: (state: RepoSettingsResponse) => void;
  /** Test seam: replaces the headless Claude call. */
  analyze?: (opts: AnalyzeRepositoryOptions) => Promise<RepoSettings>;
  now?: () => number;
}

interface FileState {
  settings: RepoSettings;
  exists: boolean;
  hash: string | null;
  error: string | null;
}

/**
 * The repository settings (DESIGN §25.1): `.promptgraph/repo-settings.json` in the main checkout, read on every call
 * (a hand edit or a `git pull` is picked up), written atomically (temp file + rename), with optimistic concurrency
 * on the file's hash. Also runs the analysis (§25.2): one at a time per repository, its state kept in memory.
 */
export class RepoSettingsService {
  private analysis: RepoAnalysis = IDLE_ANALYSIS;
  private running: AbortController | null = null;

  constructor(private readonly deps: RepoSettingsServiceDeps) {}

  get file(): string {
    return path.join(this.deps.repoPath, REPO_SETTINGS_FILE);
  }

  /** The current settings (empty when the file is missing or invalid). */
  settings(): RepoSettings {
    return this.read().settings;
  }

  /** Ids of the configured apps and checks, for graph validation (ValidateOptions.repoCommands). */
  commandIds(): { apps: string[]; checks: string[] } {
    const s = this.settings();
    return { apps: s.apps.map((a) => a.id), checks: s.checks.map((c) => c.id) };
  }

  state(): RepoSettingsResponse {
    return { ...this.read(), analysis: this.analysis };
  }

  /**
   * Replaces the file. `baseHash` (the hash the client read; null = it read no file) must match the file now, else
   * `settings_conflict`; undefined skips the check.
   */
  save(input: RepoSettings, baseHash?: string | null): RepoSettingsResponse {
    if (baseHash !== undefined) {
      const current = this.read().hash;
      if (current !== baseHash) throw new RepoSettingsError("settings_conflict", "The repository settings changed since they were loaded; reload them");
    }
    this.write(RepoSettingsSchema.parse(input));
    return this.changed();
  }

  /** Starts the analysis in the background; its result replaces the file (§25.2). */
  analyze(): RepoSettingsResponse {
    if (this.running) throw new RepoSettingsError("analysis_running", "The repository is already being analysed");
    const controller = new AbortController();
    this.running = controller;
    const now = this.deps.now ?? Date.now;
    this.analysis = { status: "running", startedAt: now(), finishedAt: null, error: null };
    const analyze = this.deps.analyze ?? analyzeRepository;
    void analyze({ repoPath: this.deps.repoPath, env: this.deps.env, signal: controller.signal, current: this.settings() })
      .then((settings) => {
        if (controller.signal.aborted) return;
        this.write({ ...settings, analyzedAt: now() });
        this.analysis = { ...this.analysis, status: "succeeded", finishedAt: now() };
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        this.analysis = { ...this.analysis, status: "failed", finishedAt: now(), error: errorMessage(err) };
      })
      .finally(() => {
        if (this.running === controller) this.running = null;
        if (!controller.signal.aborted) this.changed();
      });
    return this.changed();
  }

  /** Stops a running analysis (repository removed, daemon stopping). */
  dispose(): void {
    this.running?.abort();
    this.running = null;
  }

  private changed(): RepoSettingsResponse {
    const state = this.state();
    this.deps.onChange?.(state);
    return state;
  }

  private read(): FileState {
    let content: string;
    try {
      content = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: EMPTY_REPO_SETTINGS, exists: false, hash: null, error: null };
      return { settings: EMPTY_REPO_SETTINGS, exists: true, hash: null, error: errorMessage(err) };
    }
    const hash = hashContent(content);
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (err) {
      return { settings: EMPTY_REPO_SETTINGS, exists: true, hash, error: `${REPO_SETTINGS_FILE} is not valid JSON: ${errorMessage(err)}` };
    }
    const parsed = RepoSettingsSchema.safeParse(json);
    if (!parsed.success) {
      return { settings: EMPTY_REPO_SETTINGS, exists: true, hash, error: `${REPO_SETTINGS_FILE} is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}` };
    }
    return { settings: parsed.data, exists: true, hash, error: null };
  }

  private write(settings: RepoSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

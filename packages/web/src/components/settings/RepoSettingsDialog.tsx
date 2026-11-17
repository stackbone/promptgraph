import {
  REPO_SETTINGS_FILE,
  RepoSettingsSchema,
  repoCommandId,
  type RepoApp,
  type RepoCheck,
  type RepoSettings,
  type RepoSettingsResponse,
} from "@promptgraph/shared";
import { LoaderCircleIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ApiRequestError, errorMessage } from "../../api/rest";
import { getRepoCache, useRepoCache } from "../../store/repo-cache";
import { useRepoSettingsDialog } from "../../store/repo-settings-dialog";
import { toast } from "../../store/toast-store";
import { Button, Modal } from "../common/ui";

/** One editable row; `id` is empty for a new one (derived from the name on save). */
interface AppDraft {
  id: string;
  name: string;
  run: string;
  cwd: string;
  url: string;
}
interface CheckDraft {
  id: string;
  name: string;
  run: string;
  cwd: string;
  timeoutSec: string;
}
interface Draft {
  apps: AppDraft[];
  checks: CheckDraft[];
  setup: string;
  /** One path per line. */
  copyFiles: string;
}

function toDraft(s: RepoSettings): Draft {
  return {
    apps: s.apps.map((a) => ({ id: a.id, name: a.name, run: a.run, cwd: a.cwd, url: a.url ?? "" })),
    checks: s.checks.map((c) => ({ id: c.id, name: c.name, run: c.run, cwd: c.cwd, timeoutSec: c.timeoutSec ? String(c.timeoutSec) : "" })),
    setup: s.setup ?? "",
    copyFiles: s.copyFiles.join("\n"),
  };
}

/**
 * The draft as settings: blank rows are dropped, new rows get an id from their name (existing ids are kept, so the
 * `app` / `test` nodes that name them stay valid), then the shared schema validates it.
 */
export function draftToSettings(draft: Draft, base: RepoSettings): { settings: RepoSettings } | { error: string } {
  const filled = <T extends { name: string; run: string }>(rows: T[]) => rows.filter((r) => r.name.trim() || r.run.trim());
  const appIds = draft.apps.map((a) => a.id).filter(Boolean);
  const apps: RepoApp[] = filled(draft.apps).map((a) => {
    const id = a.id || repoCommandId(a.name || a.run, appIds);
    if (!a.id) appIds.push(id);
    return { id, name: a.name.trim(), run: a.run.trim(), cwd: a.cwd.trim(), ...(a.url.trim() ? { url: a.url.trim() } : {}) };
  });
  const checkIds = draft.checks.map((c) => c.id).filter(Boolean);
  const checks: RepoCheck[] = filled(draft.checks).map((c) => {
    const id = c.id || repoCommandId(c.name || c.run, checkIds);
    if (!c.id) checkIds.push(id);
    const timeout = Number(c.timeoutSec);
    return { id, name: c.name.trim(), run: c.run.trim(), cwd: c.cwd.trim(), ...(c.timeoutSec.trim() && timeout > 0 ? { timeoutSec: Math.round(timeout) } : {}) };
  });
  const copyFiles = [...new Set(draft.copyFiles.split("\n").map((l) => l.trim().replace(/^(\.\/)+/, "")).filter(Boolean))];
  const { setup: _oldSetup, ...rest } = base;
  const parsed = RepoSettingsSchema.safeParse({ ...rest, apps, checks, copyFiles, ...(draft.setup.trim() ? { setup: draft.setup.trim() } : {}) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const head = issue?.path[0];
    const where =
      head === "apps" || head === "checks"
        ? `${head === "apps" ? "App" : "Check"} ${Number(issue!.path[1]) + 1}, ${String(issue!.path[2] ?? "")}: `
        : head === "copyFiles"
          ? "Files to copy: "
          : head === "setup"
            ? "Setup command: "
            : "";
    return { error: `${where}${issue?.message ?? "invalid settings"}` };
  }
  return { settings: parsed.data };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Mounted once per window (App): the dialog of the repository `useRepoSettingsDialog` names, if any. */
export function RepoSettingsGate() {
  const repoId = useRepoSettingsDialog((s) => s.repoId);
  const intro = useRepoSettingsDialog((s) => s.intro);
  if (!repoId) return null;
  return <RepoSettingsDialog key={repoId} repoId={repoId} intro={intro} onClose={() => useRepoSettingsDialog.getState().close()} />;
}

/**
 * Repository settings (DESIGN §26.1): how the repository's applications start and how its tests and checks run, for
 * `app` / `test` nodes and the canvas's Run app button. **Analyse with Claude** runs a headless Claude session with
 * Haiku that reads the repository and fills them in (§26.2); the result is saved by the daemon and loads here.
 */
export function RepoSettingsDialog({ repoId, intro, onClose }: { repoId: string; intro: boolean; onClose: () => void }) {
  const state = useRepoCache(repoId, (s) => s.repoSettings);
  const repoName = useRepoCache(repoId, (s) => s.info?.name ?? s.summary?.name ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const loadedFrom = useRef<RepoSettingsResponse | null>(null);

  useEffect(() => {
    void getRepoCache(repoId).getState().loadRepoSettings();
  }, [repoId]);

  // Take the file's content while there is nothing unsaved; with unsaved edits, a newer file shows a notice instead.
  const dirty = draft !== null && loadedFrom.current !== null && !sameDraft(draft, toDraft(loadedFrom.current.settings));
  useEffect(() => {
    if (!state) return;
    if (draft === null || !dirty) {
      loadedFrom.current = state;
      setDraft(toDraft(state.settings));
      setBaseHash(state.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new server state reloads the draft
  }, [state]);

  const analysing = state?.analysis.status === "running";
  const changedOutside = dirty && state !== null && state.hash !== baseHash;

  const analyse = async () => {
    setError(null);
    setStarting(true);
    try {
      const next = await getRepoCache(repoId).getState().api.analyzeRepo();
      getRepoCache(repoId).getState().setRepoSettings(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const reload = () => {
    if (!state) return;
    loadedFrom.current = state;
    setDraft(toDraft(state.settings));
    setBaseHash(state.hash);
  };

  const save = async () => {
    if (!draft || !state) return;
    const result = draftToSettings(draft, state.settings);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await getRepoCache(repoId).getState().api.saveRepoSettings(result.settings, baseHash);
      loadedFrom.current = next;
      setDraft(toDraft(next.settings));
      setBaseHash(next.hash);
      getRepoCache(repoId).getState().setRepoSettings(next);
      toast("info", "Repository settings saved.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError && err.body.code === "settings_conflict" ? "The settings changed since you opened them (another window, or the analysis). Reload them first." : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const update = (fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d));
  const empty = draft !== null && draft.apps.length === 0 && draft.checks.length === 0 && !draft.setup.trim() && !draft.copyFiles.trim();

  return (
    <Modal
      title={intro ? `Set up ${repoName ?? "the repository"}` : `Repository settings${repoName ? ` · ${repoName}` : ""}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {intro && empty ? "Skip for now" : "Close"}
          </Button>
          <Button variant="primary" disabled={!draft || saving || !dirty} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <p className="text-xs leading-relaxed text-muted-foreground">
          How this repository&apos;s applications start and how its tests and checks run. <b className="font-medium text-foreground/80">Start app</b> and{" "}
          <b className="font-medium text-foreground/80">Run tests</b> steps and the canvas&apos;s <b className="font-medium text-foreground/80">Run app</b> button
          use them; they stay unavailable until something is configured here. Saved in <code className="font-mono text-[11px]">{REPO_SETTINGS_FILE}</code>
          {" "}(commit it to share it).
        </p>

        <div className={cn("flex flex-wrap items-start gap-3 rounded-lg p-3 ring-1 ring-border", intro && empty && "bg-accent/40")}>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[13px] font-medium">Analyse the repository with Claude</p>
            <p className="text-[11px] leading-snug text-muted-foreground">
              A background Claude Code session with Haiku reads the project&apos;s manifests, scripts and docs (read-only, no commands) and fills in the
              commands below. It replaces them: check the result before you rely on it.
            </p>
            {analysing && (
              <p className="flex items-center gap-1.5 text-[11px] text-blue-600">
                <LoaderCircleIcon className="size-3 animate-spin" /> Analysing… this usually takes under a minute. You can close this dialog.
              </p>
            )}
            {state?.analysis.status === "failed" && <p className="text-[11px] text-red-600">The analysis failed: {state.analysis.error}</p>}
            {state?.analysis.status === "succeeded" && !analysing && <p className="text-[11px] text-green-700">Analysis done: review the commands below.</p>}
            {state?.settings.notes && !analysing && <p className="text-[11px] leading-snug text-amber-700/90">Note: {state.settings.notes}</p>}
          </div>
          <Button variant={empty ? "primary" : "secondary"} disabled={analysing || starting || !state} onClick={() => void analyse()}>
            {analysing || starting ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
            {analysing ? "Analysing…" : state?.analysis.status === "succeeded" || !empty ? "Analyse again" : "Analyse with Claude"}
          </Button>
        </div>

        {state?.error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700">{state.error} Saving replaces the file.</p>}
        {changedOutside && (
          <p className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
            The settings changed while you were editing (the analysis finished, or another window saved).
            <Button size="xs" variant="secondary" onClick={reload}>
              Discard my edits and reload
            </Button>
          </p>
        )}

        {!draft ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <RowsSection
              title="Applications"
              hint="Each runs in a terminal of its own; Run app opens the URL it prints (or the one set here) once it is reachable."
              addLabel="Add app"
              onAdd={() => update((d) => ({ ...d, apps: [...d.apps, { id: "", name: "", run: "", cwd: "", url: "" }] }))}
              empty="No application yet."
            >
              {draft.apps.map((a, i) => (
                <Row
                  key={i}
                  onRemove={() => update((d) => ({ ...d, apps: d.apps.filter((_, j) => j !== i) }))}
                  fields={[
                    { label: "Name", value: a.name, placeholder: "Web app", width: "w-36", set: (name) => update((d) => ({ ...d, apps: d.apps.map((x, j) => (j === i ? { ...x, name } : x)) })) },
                    { label: "Command", value: a.run, placeholder: "pnpm dev", mono: true, width: "flex-1 min-w-48", set: (run) => update((d) => ({ ...d, apps: d.apps.map((x, j) => (j === i ? { ...x, run } : x)) })) },
                    { label: "Directory", value: a.cwd, placeholder: "repository root", mono: true, width: "w-36", set: (cwd) => update((d) => ({ ...d, apps: d.apps.map((x, j) => (j === i ? { ...x, cwd } : x)) })) },
                    { label: "URL (optional)", value: a.url, placeholder: "from its output", mono: true, width: "w-48", set: (url) => update((d) => ({ ...d, apps: d.apps.map((x, j) => (j === i ? { ...x, url } : x)) })) },
                  ]}
                />
              ))}
            </RowsSection>
            <RowsSection
              title="Tests and checks"
              hint="Each must finish on its own (no watch mode); exit code 0 means it passed. Run tests steps run them in order in their lane."
              addLabel="Add check"
              onAdd={() => update((d) => ({ ...d, checks: [...d.checks, { id: "", name: "", run: "", cwd: "", timeoutSec: "" }] }))}
              empty="No test or check yet."
            >
              {draft.checks.map((c, i) => (
                <Row
                  key={i}
                  onRemove={() => update((d) => ({ ...d, checks: d.checks.filter((_, j) => j !== i) }))}
                  fields={[
                    { label: "Name", value: c.name, placeholder: "Unit tests", width: "w-36", set: (name) => update((d) => ({ ...d, checks: d.checks.map((x, j) => (j === i ? { ...x, name } : x)) })) },
                    { label: "Command", value: c.run, placeholder: "pnpm test", mono: true, width: "flex-1 min-w-48", set: (run) => update((d) => ({ ...d, checks: d.checks.map((x, j) => (j === i ? { ...x, run } : x)) })) },
                    { label: "Directory", value: c.cwd, placeholder: "repository root", mono: true, width: "w-36", set: (cwd) => update((d) => ({ ...d, checks: d.checks.map((x, j) => (j === i ? { ...x, cwd } : x)) })) },
                    { label: "Timeout (s)", value: c.timeoutSec, placeholder: "none", width: "w-24", set: (timeoutSec) => update((d) => ({ ...d, checks: d.checks.map((x, j) => (j === i ? { ...x, timeoutSec } : x)) })) },
                  ]}
                />
              ))}
            </RowsSection>
            <section className="space-y-2">
              <div>
                <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Worktree preparation</h3>
                <p className="text-[11px] text-muted-foreground/80">
                  Runs work in separate git worktrees, which hold only what git tracks: no <code className="font-mono">.env</code>, no installed
                  dependencies. Each new worktree first gets these files from this checkout, then runs the setup command (a graph&apos;s own
                  workspace setup replaces it). The Run app button uses this checkout as it is.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="flex min-w-60 flex-1 flex-col gap-1">
                  <span className="text-[10px] font-medium text-muted-foreground">Setup command</span>
                  <Input
                    value={draft.setup}
                    placeholder="pnpm install --frozen-lockfile"
                    className="h-8 font-mono text-xs md:text-xs"
                    onChange={(e) => update((d) => ({ ...d, setup: e.target.value }))}
                  />
                </label>
                <label className="flex min-w-60 flex-1 flex-col gap-1">
                  <span className="text-[10px] font-medium text-muted-foreground">Files to copy (one path per line, relative to the repository)</span>
                  <Textarea
                    value={draft.copyFiles}
                    rows={3}
                    placeholder={".env\napps/web/.env.local"}
                    className="field-sizing-fixed min-h-0 resize-y font-mono text-xs md:text-xs"
                    onChange={(e) => update((d) => ({ ...d, copyFiles: e.target.value }))}
                  />
                </label>
              </div>
            </section>
          </>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

function RowsSection({ title, hint, addLabel, onAdd, empty, children }: { title: string; hint: string; addLabel: string; onAdd: () => void; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
          <p className="text-[11px] text-muted-foreground/80">{hint}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onAdd}>
          <PlusIcon /> {addLabel}
        </Button>
      </div>
      {children.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}

interface RowField {
  label: string;
  value: string;
  placeholder: string;
  mono?: boolean;
  width: string;
  set: (v: string) => void;
}

function Row({ fields, onRemove }: { fields: RowField[]; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-2">
      {fields.map((f) => (
        <label key={f.label} className={cn("flex flex-col gap-1", f.width)}>
          <span className="text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <Input value={f.value} placeholder={f.placeholder} className={cn("h-8", f.mono && "font-mono text-xs md:text-xs")} onChange={(e) => f.set(e.target.value)} />
        </label>
      ))}
      <Button variant="ghost" size="icon-sm" aria-label="Remove" className="text-muted-foreground hover:text-red-600" onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

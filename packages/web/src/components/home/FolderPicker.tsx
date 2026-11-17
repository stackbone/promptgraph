import type { ListDirsResponse } from "@promptgraph/shared";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { daemonApi, errorMessage } from "../../api/rest";
import { Icons } from "../common/icons";
import { Button, Modal } from "../common/ui";

/** Most suggestions shown under the path field. */
const MAX_SUGGESTIONS = 50;
/** Debounce of the directory listing while typing. */
const LIST_DELAY_MS = 120;

/**
 * Splits what the user typed into the directory to list and the name prefix to match in it:
 * `~/pro` → `~/` + `pro`, `/home/a/` → `/home/a/` + ``, `~` → `~/` + ``. Null for a path that is not
 * absolute nor `~`-prefixed (nothing to suggest).
 */
export function splitTypedPath(value: string): { dir: string; prefix: string } | null {
  if (value === "~") return { dir: "~/", prefix: "" };
  if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  const slash = value.lastIndexOf("/");
  return { dir: value.slice(0, slash + 1), prefix: value.slice(slash + 1) };
}

/** `path` with the home directory shown as `~`. */
export function tildePath(path: string, home: string): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * The repository path field of Home's "Add repository" (DESIGN §13.3): a combobox that suggests the
 * subdirectories of what is typed (`GET /api/fs/dirs`). ↑/↓ highlight, Tab or Enter on a highlighted
 * suggestion complete it, Escape closes the list; Enter without a highlighted suggestion submits the form.
 */
export function PathInput({
  value,
  onChange,
  disabled,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Extra classes of the input (e.g. a borderless field inside a card). */
  inputClassName?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<{ dir: string; hidden: boolean; res: ListDirsResponse | null } | null>(null);
  const [highlight, setHighlight] = useState(-1);

  const split = splitTypedPath(value);
  const hidden = split?.prefix.startsWith(".") ?? false;
  const wanted = split && open ? { dir: split.dir, hidden } : null;

  useEffect(() => {
    if (!wanted) return;
    if (listing && listing.dir === wanted.dir && listing.hidden === wanted.hidden) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      daemonApi.listDirs(wanted.dir, wanted.hidden).then(
        (res) => !cancelled && setListing({ ...wanted, res }),
        () => !cancelled && setListing({ ...wanted, res: null }),
      );
    }, LIST_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `listing` is read only to skip a refetch of the same directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted?.dir, wanted?.hidden]);

  const current = wanted && listing?.dir === wanted.dir && listing.hidden === wanted.hidden ? listing.res : null;
  const prefix = split?.prefix.toLowerCase() ?? "";
  const suggestions = current ? current.entries.filter((e) => e.name.toLowerCase().startsWith(prefix)).slice(0, MAX_SUGGESTIONS) : [];
  const shown = open && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0]!.name === split?.prefix);

  useEffect(() => setHighlight(-1), [value]);

  const complete = (name: string) => {
    if (!split) return;
    onChange(`${split.dir}${name}/`);
    setHighlight(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!shown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      complete(suggestions[Math.max(highlight, 0)]!.name);
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      complete(suggestions[highlight]!.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        role="combobox"
        aria-label="Repository path"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="/home/you/project or ~/project"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={cn("font-mono text-xs", inputClassName)}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Folder suggestions"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.path}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                complete(s.name);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center gap-2 px-2.5 py-1 font-mono text-xs ${i === highlight ? "bg-accent text-accent-foreground" : ""}`}
            >
              <Icons.folder className="shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
              {s.isGitRepo && <GitBadge />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GitBadge() {
  return <Badge className="ml-auto h-4 shrink-0 bg-emerald-500/15 px-1.5 font-sans text-[10px] font-normal text-emerald-700">git</Badge>;
}

/**
 * Folder browser of Home's "Add repository" (DESIGN §13.3), served by the daemon (`GET /api/fs/dirs`), so
 * it works the same in a browser and in the desktop shell. Starts at `initialPath` (home when empty or
 * unreadable); a click on a folder enters it; "Add this folder" hands the current folder to `onSelect`.
 *
 * Typing filters the folders like VS Code's quick open: fuzzy matches, best first, the best one highlighted.
 * ↑/↓ move the highlight, Enter enters the highlighted folder, Backspace in an empty filter goes to the parent,
 * Ctrl/Cmd+Enter adds the current folder.
 */
export function FolderBrowser({ initialPath, onSelect, onClose }: { initialPath?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [data, setData] = useState<ListDirsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const listId = useId();
  const filterRef = useRef<HTMLInputElement>(null);

  const load = (path: string | undefined, showHidden = hidden, fallbackHome = false) => {
    const n = ++seq.current;
    setLoading(true);
    daemonApi.listDirs(path, showHidden).then(
      (res) => {
        if (n !== seq.current) return;
        setData(res);
        setError(null);
        setLoading(false);
        setQuery("");
        setActive(-1);
        // Keep typing working after a click on a folder, a breadcrumb or "Show hidden".
        filterRef.current?.focus();
      },
      (err: unknown) => {
        if (n !== seq.current) return;
        setLoading(false);
        if (fallbackHome) return load(undefined, showHidden);
        setError(errorMessage(err));
      },
    );
  };

  useEffect(() => {
    load(initialPath?.trim() || undefined, false, Boolean(initialPath?.trim()));
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = data ? breadcrumbs(data.path, data.home) : [];
  const results = data ? fuzzyFilter(data.entries, query.trim(), (e) => e.name) : [];

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const onFilterChange = (value: string) => {
    setQuery(value);
    // Like quick open: while filtering, the best match is highlighted so Enter takes it.
    setActive(value.trim() ? 0 : -1);
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      const last = results.length - 1;
      setActive((i) => (e.key === "ArrowDown" ? (i >= last ? 0 : i + 1) : i <= 0 ? last : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (data) onSelect(data.path);
      } else if (active >= 0 && results[active]) {
        load(results[active].item.path);
      }
    } else if (e.key === "Backspace" && query === "" && data?.parent) {
      e.preventDefault();
      load(data.parent);
    } else if (e.key === "Escape") {
      // The dialog leaves Escape to an expanded combobox: clear the filter first, close when it is empty.
      e.preventDefault();
      if (query) onFilterChange("");
      else onClose();
    }
  };

  return (
    <Modal
      title="Choose a repository folder"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!data} onClick={() => data && onSelect(data.path)}>
            Add this folder
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Parent folder" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)}>
            <Icons.arrowUp />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Home folder" disabled={!data} onClick={() => load(undefined)}>
            <Icons.home />
          </Button>
          <nav aria-label="Current folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-xs">
            {crumbs.map((c, i) => (
              <span key={c.path} className="inline-flex items-center gap-0.5">
                {i > 0 && <Icons.chevronRight className="text-[10px] text-muted-foreground" />}
                {i === crumbs.length - 1 ? (
                  <span aria-current="location" className="px-1 font-medium text-foreground">
                    {c.label}
                  </span>
                ) : (
                  <button type="button" className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => load(c.path)}>
                    {c.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                if (data) load(data.path, e.target.checked);
              }}
            />
            Show hidden
          </label>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        {data?.isGitRepo && <p className="text-xs text-emerald-700">This folder is a git repository.</p>}

        <Input
          ref={filterRef}
          type="search"
          autoFocus
          role="combobox"
          aria-label="Filter folders"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active >= 0 && results[active] ? `${listId}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Type to find a folder · Enter opens it · Ctrl+Enter adds the current folder"
          value={query}
          onChange={(e) => onFilterChange(e.target.value)}
          onKeyDown={onFilterKeyDown}
          className="font-mono text-xs"
        />

        <ul id={listId} role="listbox" aria-label="Folders" aria-busy={loading} className="h-80 overflow-y-auto rounded-md border py-1">
          {data && data.entries.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No subfolders.</li>}
          {data && data.entries.length > 0 && results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No folder matches “{query.trim()}”.</li>}
          {!data && !error && <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>}
          {results.map(({ item: e, match }, i) => (
            <li
              key={e.path}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              title={e.path}
              // mousedown, not click, keeps the focus in the filter.
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => load(e.path)}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-xs", i === active && "bg-accent text-accent-foreground")}
            >
              <Icons.folder className="shrink-0 text-muted-foreground" />
              <span className="truncate">{highlightMatch(e.name, match.indices)}</span>
              {e.isGitRepo && <GitBadge />}
            </li>
          ))}
        </ul>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={data?.path}>
          {data ? tildePath(data.path, data.home) : ""}
        </p>
      </div>
    </Modal>
  );
}

/** `text` with the characters at `indices` emphasised (the fuzzy-matched part of a folder name). */
function highlightMatch(text: string, indices: number[]): ReactNode {
  if (indices.length === 0) return text;
  const marked = new Set(indices);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(
      runMarked ? (
        <mark key={key} className="bg-transparent font-semibold text-primary">
          {run}
        </mark>
      ) : (
        run
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = marked.has(i);
    if (m !== runMarked) {
      flush(i);
      runMarked = m;
    }
    run += text[i];
  }
  flush(text.length);
  return parts;
}

/** Clickable segments of `path`; under the home directory it starts at `~`. */
export function breadcrumbs(path: string, home: string): { label: string; path: string }[] {
  const underHome = home && home !== "/" && (path === home || path.startsWith(`${home}/`));
  const base = underHome ? home : "/";
  const out = [{ label: underHome ? "~" : "/", path: base }];
  const rest = path.slice(base.length).split("/").filter(Boolean);
  let acc = base;
  for (const part of rest) {
    acc = acc.endsWith("/") ? `${acc}${part}` : `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

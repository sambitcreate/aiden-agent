// Add ▸ Page from app… (design mode v2 Phase 3b, S87): the person picks one
// of their app's routes, filling any [bracket] with a value, and main places
// it as their own live frame on the page on screen. Main resolves the app and
// the box; the person never types an origin. Route text from the app's files
// is data: it is shown as text only.

import * as React from "react";
import { Dialog, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui";
import { cn } from "../lib/ui-utils";
import {
  fillRoute,
  isConcreteRoute,
  isParamValue,
  isRoutePattern,
  patternParams,
  type AppRouteEntry,
  type AppRouteList,
  type RouteParam,
} from "../shared/design-canvas/app-routes";

export type AppRoutesAnswer =
  | { apps: { appRoot: string; label: string }[]; appRoot: string; list: AppRouteList }
  | { error: "unavailable" | "no-app" };

export type AppRoutePlaceAnswer =
  | { placed: string; pageId: string }
  | { already: string; pageId: string }
  // `unsaved` is the renderer's own: the canvas's pending save didn't land, so main wasn't asked.
  | { error: "unavailable" | "bad-route" | "unknown-root" | "full" | "unsaved" };

export type AppRouteSource = {
  load(appRoot?: string): Promise<AppRoutesAnswer>;
  place(appRoot: string, route: string): Promise<AppRoutePlaceAnswer>;
};

/** The rows shown at most; past it, the person refines the filter. */
export const APP_ROUTE_PICKER_ROWS = 200;

const PLACE_ERRORS: Record<"unavailable" | "bad-route" | "unknown-root" | "full" | "unsaved", string> = {
  "bad-route": "That address isn't a page of this app.",
  full: "This page is full. Remove a frame or use another page.",
  "unknown-root": "That app isn't in this workspace any more.",
  unavailable: "Pages from your app can't be added right now.",
  unsaved: "The canvas couldn't be saved, so the page wasn't added. Try again in a moment.",
};

const SOURCE_LINES: Record<AppRouteList["source"], string> = {
  discovered: "From your app's files",
  config: "From .aiden/canvas.json",
  fallback: "Only / found: list routes in .aiden/canvas.json",
};

const TRUNCATED_LINE = "Not every route is listed: type /path, or list routes in .aiden/canvas.json";

/**
 * The person's Add, in order (M6.3): the canvas's pending save lands first, so
 * main's write can't conflict with it, then main places on the page on screen.
 * When the save doesn't land (false or a rejection), main isn't asked: its copy
 * is older than the screen.
 */
export function appRoutePlacer(deps: {
  flush(): Promise<boolean>;
  place(request: { appRoot: string; route: string; pageId: string; viewSize?: { w: number; h: number } }): Promise<AppRoutePlaceAnswer>;
  pageId(): string;
  viewSize(): { w: number; h: number } | undefined;
}): AppRouteSource["place"] {
  return async (appRoot, route) => {
    const saved = await deps.flush().catch(() => false);
    if (saved !== true) return { error: "unsaved" };
    const viewSize = deps.viewSize();
    return deps.place({ appRoot, route, pageId: deps.pageId(), ...(viewSize ? { viewSize } : {}) });
  };
}

/** A dynamic row's values from the first route the list filled from the same pattern (canvas.json's `params`). */
function prefilled(pattern: string, routes: readonly AppRouteEntry[]): Record<string, string> {
  const params = patternParams(pattern);
  if (params.length !== 1) return {};
  const filled = routes.find((entry) => entry.pattern === pattern && isConcreteRoute(entry.route));
  if (!filled) return {};
  const parts = pattern.split("/");
  const index = parts.findIndex((segment) => segment.includes("["));
  // A catch-all stops where the pattern's own segments after it begin.
  const after = parts.length - 1 - index;
  const segments = filled.route.split("/");
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const value = params[0]!.catchAll ? segments.slice(index, after > 0 ? -after : undefined).map(decode).join("/") : decode(segments[index] ?? "");
  return { [params[0]!.name]: value };
}

type Row = { key: string; route: string; params: RouteParam[]; typed?: true };

function rowsFor(list: AppRouteList, filter: string): { rows: Row[]; hidden: number } {
  const needle = filter.trim().toLowerCase();
  const matching = list.routes.filter((entry) => needle === "" || entry.route.toLowerCase().includes(needle));
  const rows: Row[] = matching.map((entry) => ({
    key: entry.route,
    route: entry.route,
    params: isConcreteRoute(entry.route) ? [] : isRoutePattern(entry.route) ? patternParams(entry.route) : [],
  }));
  const typed = filter.trim();
  const shown = rows.slice(0, APP_ROUTE_PICKER_ROWS);
  if (typed.startsWith("/") && isConcreteRoute(typed) && !list.routes.some((entry) => entry.route === typed)) {
    shown.push({ key: `typed:${typed}`, route: typed, params: [], typed: true });
  }
  return { rows: shown, hidden: Math.max(0, rows.length - APP_ROUTE_PICKER_ROWS) };
}

/** The concrete route a row places, or null while a value is missing or unsafe. */
function routeOf(row: Row, values: Record<string, string>): string | null {
  if (row.params.length === 0) return isConcreteRoute(row.route) ? row.route : null;
  for (const param of row.params) {
    const value = values[param.name] ?? "";
    if (param.optional && value === "") continue;
    if (!isParamValue(value, param.catchAll)) return null;
  }
  return fillRoute(row.route, values);
}

export function AppRoutePicker({
  open,
  onOpenChange,
  source,
  returnFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  source: AppRouteSource;
  /** Where focus goes when the dialog closes: the Add trigger. */
  returnFocus?: () => HTMLElement | null;
}) {
  const [answer, setAnswer] = React.useState<AppRoutesAnswer | null>(null);
  const [filter, setFilter] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, Record<string, string>>>({});
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const listId = React.useId();
  // Only the newest load answers: a slower one for another app, or from before the dialog closed, is dropped.
  const loadSeq = React.useRef(0);
  // Set by an arrow key, so only keyboard moves scroll the list.
  const keyedMove = React.useRef(false);

  const load = React.useCallback(
    (appRoot?: string) => {
      const seq = ++loadSeq.current;
      const live = () => seq === loadSeq.current;
      setAnswer(null);
      setProblem(null);
      source.load(appRoot).then(
        (next) => {
          if (!live()) return;
          setAnswer(next);
          setActive(0);
          if (!("error" in next)) {
            const seeded: Record<string, Record<string, string>> = {};
            for (const entry of next.list.routes) {
              if (!isConcreteRoute(entry.route) && isRoutePattern(entry.route)) seeded[entry.route] = prefilled(entry.route, next.list.routes);
            }
            setValues(seeded);
          }
        },
        () => {
          if (live()) setAnswer({ error: "unavailable" });
        },
      );
      // Closing drops every load still reading, this one or a later app switch's.
      return () => {
        loadSeq.current += 1;
      };
    },
    [source],
  );

  React.useEffect(() => {
    if (!open) return;
    setFilter("");
    return load();
  }, [open, load]);

  const loaded = answer && !("error" in answer) ? answer : null;
  const { rows, hidden } = loaded ? rowsFor(loaded.list, filter) : { rows: [], hidden: 0 };
  const index = Math.min(active, Math.max(0, rows.length - 1));
  const current = rows[index];
  const currentRoute = current ? routeOf(current, values[current.route] ?? {}) : null;
  const optionId = (at: number) => `${listId}-option-${at}`;

  React.useEffect(() => {
    if (!keyedMove.current) return;
    keyedMove.current = false;
    document.getElementById(`${listId}-option-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, listId]);

  const add = async (row: Row | undefined = current) => {
    if (!loaded || !row || busy) return;
    const route = routeOf(row, values[row.route] ?? {});
    if (route === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const placed = await source.place(loaded.appRoot, route);
      if ("error" in placed) setProblem(PLACE_ERRORS[placed.error]);
      else onOpenChange(false);
    } catch {
      setProblem(PLACE_ERRORS.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const onFilterKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      keyedMove.current = true;
      setActive((index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void add();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a page from your app"
      confirmLabel="Add"
      confirmDisabled={currentRoute === null}
      busy={busy}
      onConfirm={() => add()}
      {...(returnFocus ? { returnFocus } : {})}
    >
      <div className="flex flex-col gap-3">
        {loaded && loaded.apps.length >= 2 ? (
          <Select value={loaded.appRoot} onValueChange={(appRoot) => load(appRoot)}>
            <SelectTrigger aria-label="App">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {loaded.apps.map((app) => (
                <SelectItem key={app.appRoot} value={app.appRoot}>
                  {app.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Input
          aria-label="Filter routes"
          placeholder="Filter routes, or type /path"
          value={filter}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={current ? optionId(index) : undefined}
          onChange={(event) => {
            setFilter(event.target.value);
            setActive(0);
          }}
          onKeyDown={onFilterKey}
          // The filter is the dialog's first stop.
          autoFocus
        />
        {answer === null ? (
          <p role="status" className="text-small text-secondary">
            Reading your app's routes…
          </p>
        ) : "error" in answer ? (
          <p role="status" className="text-small text-secondary">
            {answer.error === "no-app" ? "No web app in this workspace" : PLACE_ERRORS.unavailable}
          </p>
        ) : (
          <>
            <div id={listId} role="listbox" aria-label="Routes" className="max-h-[min(20rem,48vh)] overflow-y-auto overscroll-contain">
              {rows.map((row, at) => {
                const selected = at === index;
                const rowValues = values[row.route] ?? {};
                return (
                  <div
                    key={row.key}
                    id={optionId(at)}
                    role="option"
                    aria-selected={selected}
                    data-selected={selected || undefined}
                    onPointerMove={() => {
                      // A pointer passing over never takes the row the person is typing a value into.
                      const focused = document.activeElement;
                      if (focused instanceof HTMLInputElement && focused.closest('[role="option"]')) return;
                      setActive(at);
                    }}
                    onClick={() => setActive(at)}
                    onDoubleClick={() => void add(row)}
                    className={cn(
                      "flex min-h-9 cursor-default flex-wrap items-center gap-2 rounded-menu px-2.5 py-1 transition-colors",
                      selected ? "bg-control" : "hover:bg-list-hover",
                    )}
                  >
                    <span className="min-w-0 truncate text-regular text-primary">{row.typed ? `Go to ${row.route}` : row.route}</span>
                    {row.params.map((param) => (
                      <Input
                        key={param.name}
                        aria-label={param.name}
                        placeholder={param.name}
                        value={rowValues[param.name] ?? ""}
                        className="h-7 w-32"
                        onFocus={() => setActive(at)}
                        // Double-clicking selects a word to edit; only the row itself adds on double-click.
                        onDoubleClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setValues((all) => ({ ...all, [row.route]: { ...(all[row.route] ?? {}), [param.name]: event.target.value } }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void add(row);
                          }
                        }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
            {hidden > 0 ? <p className="text-small text-secondary">{`${hidden} more: refine the filter`}</p> : null}
            {loaded!.list.truncated ? <p className="text-small text-secondary">{TRUNCATED_LINE}</p> : null}
            <p className="text-small text-tertiary">{SOURCE_LINES[loaded!.list.source]}</p>
          </>
        )}
        {problem ? (
          <p role="alert" className="text-small text-status-red">
            {problem}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

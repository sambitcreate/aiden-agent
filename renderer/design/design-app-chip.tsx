// The live app status chip (design mode v2, Phase 2c, D2–D3). It sits before
// the canvas view toolbar and says, in a few words, whether the workspace's
// app runs: "Vite · :5173", "Starting…", "Crashed", "Connect". Its menu
// starts, stops, restarts, retries, disconnects and connects, shows logs, and
// opens the Choose and Connect sheets. Reads are cache-first; actions are
// instant and settle on the invoke's own answer (the instant rule, B-M1).

import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "../components/ui";
import { useAppCapabilities } from "../lib/app-capabilities";
import { designAppApi } from "../lib/ipc";
import { cn } from "../lib/ui-utils";
import {
  designAppRootClass,
  designAppRootText,
  designAppAnnouncement,
  designAppChip,
  designAppProblemMessage,
  designAppRetryable,
  type DesignAppChip as ChipModel,
  type DesignAppProblem,
  type DesignAppsSnapshot,
  type DesignAppStatus,
} from "../shared/design-app";
import { DesignAppChooseSheet, DesignAppConnectSheet } from "./design-app-sheets";

const ACTION_FAILED = "Aiden couldn't do that.";
const CRASHED = "The app's dev server stopped.";

// ── The snapshot, cache-first ──

/** The last snapshot of each workspace, and each chat's workspace, for the whole window. */
const snapshots = new Map<string, DesignAppsSnapshot>();
const chatWorkspaces = new Map<string, string>();

/** For tests: forget every cached snapshot. */
export function resetDesignAppChipForTests(): void {
  snapshots.clear();
  chatWorkspaces.clear();
}

function cachedFor(chatId: string): DesignAppsSnapshot | undefined {
  const workspaceId = chatWorkspaces.get(chatId);
  return workspaceId === undefined ? undefined : snapshots.get(workspaceId);
}

/**
 * A status read answered from main's state when it was asked; a broadcast may
 * have brought a newer state of some app meanwhile. Each app keeps whichever
 * is newer by `revision` (B7). Broadcasts arrive in order and replace as they are.
 */
function newerApps(read: DesignAppsSnapshot, known: DesignAppsSnapshot | undefined): DesignAppsSnapshot {
  if (!known || known.workspaceId !== read.workspaceId) return read;
  const knownByRoot = new Map(known.apps.map((app) => [app.appRoot, app]));
  return {
    ...read,
    apps: read.apps.map((app) => {
      const other = knownByRoot.get(app.appRoot);
      return other && other.revision > app.revision ? other : app;
    }),
  };
}

/**
 * The chat's workspace snapshot: the last one known at once, then a fresh read
 * once per mount, then every broadcast for that workspace. `undefined` until
 * the first read answers with nothing cached; `null` when live apps are off.
 */
export function useDesignAppsSnapshot(chatId: string, enabled: boolean): DesignAppsSnapshot | null | undefined {
  const [snapshot, setSnapshot] = React.useState<DesignAppsSnapshot | null | undefined>(() => (enabled ? cachedFor(chatId) : null));
  React.useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    setSnapshot(cachedFor(chatId));
    let live = true;
    const unsubscribe = designAppApi.onStatus((next) => {
      if (!next || typeof next.workspaceId !== "string" || !Array.isArray(next.apps)) return;
      snapshots.set(next.workspaceId, next);
      if (live && chatWorkspaces.get(chatId) === next.workspaceId) setSnapshot(next);
    });
    designAppApi.status(chatId).then(
      (answer) => {
        if (!live) return;
        const read = newerApps(answer, snapshots.get(answer.workspaceId));
        chatWorkspaces.set(chatId, read.workspaceId);
        snapshots.set(read.workspaceId, read);
        setSnapshot(read);
      },
      () => {
        // A chat that can't run apps (a Bot's, no folder, the flag off) shows no chip.
        if (live) setSnapshot(null);
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [chatId, enabled]);
  return snapshot;
}

// ── The optimistic layer (B-M1) ──

interface Pending {
  /** What the chip shows until the answer or a newer broadcast. */
  status: DesignAppStatus;
  /** The app's revision when the action began: only a broadcast above it replaces the pending state. */
  revision: number;
  /** The phase before the action: an answer with a problem and this phase is a refusal. */
  phase: DesignAppStatus["phase"];
}

type Action = "start" | "stop" | "restart" | "retry" | "connect" | "disconnect";

const OPTIMISTIC_PHASE: Record<Action, DesignAppStatus["phase"]> = {
  start: "starting",
  stop: "stopped",
  restart: "starting",
  retry: "starting",
  connect: "starting",
  disconnect: "stopped",
};

function stateWords(app: DesignAppStatus): string {
  switch (app.phase) {
    case "running":
      return app.source === "attached"
        ? `connected to your server${app.port !== undefined ? ` at port ${app.port}` : ""}`
        : `running${app.port !== undefined ? ` at port ${app.port}` : ""}`;
    case "starting":
      return "starting";
    case "installing":
      return "installing";
    case "consent":
      return "waiting for approval";
    case "crashed":
      return "crashed";
    case "stopped":
      return app.problem ? "not running" : "stopped";
  }
}

function triggerLabel(chip: ChipModel): string {
  if (chip.connectOnly) return "Live app: connect a running server";
  if (chip.apps.length === 1) return `Live app: ${chip.apps[0]!.frameworkLabel}, ${stateWords(chip.apps[0]!)}`;
  return `Live app: ${chip.label}`;
}

/** One app's line in the menu and the logs drawer's header: its state, or its problem's fixed message. */
export function designAppStatusLine(app: DesignAppStatus, problem?: DesignAppProblem): string {
  const shown = problem ?? app.problem;
  if (shown) return designAppProblemMessage(shown);
  const address = app.origin?.replace(/^http:\/\//u, "");
  switch (app.phase) {
    case "running":
      return app.source === "attached" ? `Connected to your server at ${address ?? `:${app.port}`}` : `Running at ${address ?? `:${app.port}`}`;
    case "starting":
      return app.source === "attached" ? "Connecting…" : "Starting…";
    case "installing":
      return "Installing dependencies…";
    case "consent":
      return "Waiting for your approval";
    case "crashed":
      return CRASHED;
    case "stopped":
      return app.source === "attached" ? "Not connected" : "Not running";
  }
}

const TONE_DOT: Record<ChipModel["tone"], string> = {
  running: "bg-status-green",
  busy: "bg-tertiary",
  neutral: "bg-tertiary",
  problem: "bg-status-red",
};

export function DesignAppStatusChip({ chatId, onShowLogs }: { chatId: string; onShowLogs?: (appRoot: string) => void }) {
  const { designLive } = useAppCapabilities();
  const snapshot = useDesignAppsSnapshot(chatId, designLive);
  const [pending, setPending] = React.useState<ReadonlyMap<string, Pending>>(new Map());
  const [problems, setProblems] = React.useState<ReadonlyMap<string, DesignAppProblem>>(new Map());
  const [announcement, setAnnouncement] = React.useState("");
  const [sheet, setSheet] = React.useState<{ kind: "choose" } | { kind: "connect"; filterRoot?: string } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const previous = React.useRef<Map<string, DesignAppStatus>>(new Map());
  /** The app Show logs picked: the drawer opens once the menu has closed, so its focus trap can't take focus back. */
  const logsFor = React.useRef<string | null>(null);

  // A broadcast with a newer revision for an app replaces its pending state and its inline problem;
  // an app no longer in the snapshot drops its pending state.
  React.useEffect(() => {
    if (!snapshot) return;
    const newer = (root: string, revision: number) =>
      (snapshot.apps.find((app) => app.appRoot === root)?.revision ?? Number.POSITIVE_INFINITY) > revision;
    setPending((current) => {
      const kept = new Map([...current].filter(([root, entry]) => !newer(root, entry.revision)));
      return kept.size === current.size ? current : kept;
    });
    // Announce a crash or a disconnect, from what main says, never from the chip's guesses.
    const said: string[] = [];
    for (const app of snapshot.apps) {
      const before = previous.current.get(app.appRoot);
      if (before && app.revision > before.revision) {
        const line = designAppAnnouncement(before, app);
        if (line) said.push(line);
        setProblems((current) => {
          if (!current.has(app.appRoot)) return current;
          const next = new Map(current);
          next.delete(app.appRoot);
          return next;
        });
      }
      if (!before || app.revision >= before.revision) previous.current.set(app.appRoot, app);
    }
    if (said.length) setAnnouncement(said.join(" "));
  }, [snapshot]);

  if (!designLive || snapshot === null) return null;
  if (snapshot === undefined) {
    return (
      <div role="group" aria-label="Live app" className="glass-surface flex items-center rounded-button p-1 shadow-control">
        <span role="status" aria-label="Reading the live app" className="flex h-7 w-24 items-center px-3">
          <span className="block h-2.5 w-full animate-pulse rounded-pill bg-control" />
        </span>
      </div>
    );
  }

  const apps = snapshot.apps.map((app) => pending.get(app.appRoot)?.status ?? app);
  const chip = designAppChip({ ...snapshot, apps });
  if (!chip) return null;

  const act = async (app: DesignAppStatus, action: Action) => {
    const base = snapshot.apps.find((candidate) => candidate.appRoot === app.appRoot) ?? app;
    const root = app.appRoot;
    setProblems((current) => {
      if (!current.has(root)) return current;
      const next = new Map(current);
      next.delete(root);
      return next;
    });
    setPending((current) =>
      new Map(current).set(root, {
        status: { ...base, phase: OPTIMISTIC_PHASE[action], problem: undefined },
        revision: base.revision,
        phase: base.phase,
      }),
    );
    const settle = (next: DesignAppStatus | null) =>
      setPending((current) => {
        const entry = current.get(root);
        if (!entry) return current;
        const kept = new Map(current);
        if (next) kept.set(root, { ...entry, status: next, revision: Math.max(entry.revision, next.revision - 1) });
        else kept.delete(root);
        return kept;
      });
    try {
      const result =
        action === "start" || action === "connect"
          ? await designAppApi.start(chatId, root)
          : action === "stop" || action === "disconnect"
            ? await designAppApi.stop(chatId, root)
            : action === "restart"
              ? await designAppApi.restart(chatId, root)
              : await designAppApi.retry(chatId, root);
      if (result.problem && result.phase === base.phase) {
        // A refusal: nothing changed. Roll back and say why in the menu, without a toast.
        settle(null);
        const problem = result.problem;
        setProblems((current) => new Map(current).set(root, problem));
        return;
      }
      settle(result);
    } catch (error) {
      settle(null);
      toast.error(error instanceof Error && error.message ? error.message : ACTION_FAILED);
    }
  };

  const returnFocus = () => triggerRef.current;
  const items = (app: DesignAppStatus) => {
    const list: Array<{ label: string; run: () => void }> = [];
    if (app.source === "attached") {
      if (app.phase === "running" || app.phase === "starting" || app.phase === "consent") list.push({ label: "Disconnect", run: () => void act(app, "disconnect") });
      else if (app.url !== undefined && !(app.problem?.problem === "attach-url-invalid")) list.push({ label: "Connect", run: () => void act(app, "connect") });
      else if (app.url === undefined) list.push({ label: "Connect again", run: () => setSheet({ kind: "connect", filterRoot: app.appRoot }) });
      return list;
    }
    if (app.phase === "stopped") list.push({ label: "Start", run: () => void act(app, "start") });
    if (app.phase === "running" || app.phase === "starting" || app.phase === "installing" || app.phase === "consent") {
      list.push({ label: "Stop", run: () => void act(app, "stop") });
    }
    if (app.phase === "running" || app.phase === "crashed") list.push({ label: "Restart", run: () => void act(app, "restart") });
    if (designAppRetryable(app)) list.push({ label: "Retry", run: () => void act(app, "retry") });
    if (onShowLogs && app.revision > 0 && app.phase !== "consent") {
      list.push({
        label: "Show logs",
        run: () => {
          logsFor.current = app.appRoot;
        },
      });
    }
    return list;
  };

  return (
    <div role="group" aria-label="Live app" className="glass-surface flex items-center rounded-button p-1 shadow-control">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="bar" size="small" aria-label={triggerLabel(chip)} data-design-app-chip="">
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[chip.tone])} />
            <span key={chip.label} className="design-app-chip-label">
              {chip.label}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-72"
          onCloseAutoFocus={(event) => {
            // Show logs hands focus to the drawer's output; anything else returns it to the chip.
            const root = logsFor.current;
            logsFor.current = null;
            if (root === null || !onShowLogs) return;
            event.preventDefault();
            onShowLogs(root);
          }}
        >
          {chip.connectOnly
            ? null
            : chip.apps.map((app, index) => (
                <React.Fragment key={app.appRoot}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel className="flex flex-col gap-0.5 py-1.5 font-normal">
                    <span className="text-small font-medium text-primary">
                      {app.frameworkLabel} · <span className={designAppRootClass(app.appRoot)}>{designAppRootText(app.appRoot)}</span>
                    </span>
                    <span className="text-small whitespace-normal break-words text-secondary">{designAppStatusLine(app, problems.get(app.appRoot))}</span>
                  </DropdownMenuLabel>
                  {items(app).map((item) => (
                    <DropdownMenuItem key={item.label} onSelect={item.run}>
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </React.Fragment>
              ))}
          {chip.connectOnly ? null : <DropdownMenuSeparator />}
          {chip.choose ? <DropdownMenuItem onSelect={() => setSheet({ kind: "choose" })}>Choose apps…</DropdownMenuItem> : null}
          <DropdownMenuItem onSelect={() => setSheet({ kind: "connect" })}>Connect running server…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <DesignAppChooseSheet
        open={sheet?.kind === "choose"}
        onOpenChange={(open) => setSheet(open ? { kind: "choose" } : null)}
        chatId={chatId}
        snapshot={snapshot}
        returnFocus={returnFocus}
      />
      <DesignAppConnectSheet
        open={sheet?.kind === "connect"}
        onOpenChange={(open) => setSheet((current) => (open ? current : null))}
        chatId={chatId}
        {...(sheet?.kind === "connect" && sheet.filterRoot !== undefined ? { filterRoot: sheet.filterRoot } : {})}
        returnFocus={returnFocus}
      />
    </div>
  );
}

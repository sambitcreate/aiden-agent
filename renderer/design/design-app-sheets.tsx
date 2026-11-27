// The live app chip's two sheets (design mode v2, Phase 2c). Choose apps…
// picks which of a monorepo's web apps design mode runs; each Run goes through
// `choose`, so the run-app card still asks first. Connect running server…
// lists the person's own dev servers in the workspace's folder, read only
// when the sheet opens or the person presses Refresh, and attaches the one
// they pick. Main checks every pick again; the sheet only selects.

import * as React from "react";
import { Button, Dialog, Separator, Text } from "../components/ui";
import { designAppApi } from "../lib/ipc";
import {
  consentDisplayText,
  designAppRootClass,
  designAppRootText,
  designAppProblemMessage,
  type DesignAppProblem,
  type DesignAppRunningScan,
  type DesignAppRunningServer,
  type DesignAppsSnapshot,
  type DesignAppStatus,
} from "../shared/design-app";

const CONNECT_FAILED = "Aiden couldn't connect to that server.";
const CHOOSE_FAILED = "Aiden couldn't start that app.";

/** Why a listed server can't be connected, in the person's words (D6). */
const WHY: Record<NonNullable<DesignAppRunningServer["why"]>, string> = {
  "beyond-loopback":
    "It listens beyond this computer. Restart it bound to 127.0.0.1 (for example with --host 127.0.0.1 or --hostname 127.0.0.1), then refresh.",
  "other-address": "It listens on another loopback address, not 127.0.0.1 or ::1, so there's no address to show it at.",
  "other-user": "Part of this server runs as another user, so Aiden can't check where it listens.",
  "already-running": "Aiden already runs this app. Stop it first, then connect.",
};

/** A phase in which the app is running or on its way there: Run would only join it. */
function busy(status: DesignAppStatus | undefined): boolean {
  return !!status && status.phase !== "stopped" && status.phase !== "crashed";
}

function rowAddress(server: DesignAppRunningServer): string {
  return server.origin ? server.origin.replace(/^http:\/\//u, "") : `:${server.port}`;
}

/** How a Run from Choose apps… ended, when it didn't go ahead: a refusal main gave, or a call that failed. */
export type DesignAppChooseOutcome = { appRoot: string; problem: DesignAppProblem } | { appRoot: string; message: string };

export function DesignAppChooseSheet({
  open,
  onOpenChange,
  chatId,
  snapshot,
  onOutcome,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  snapshot: DesignAppsSnapshot;
  /**
   * A refusal or a failed call. The sheet has closed by then (the run-app card
   * comes next and `choose` waits for it), so the chip shows it, never the sheet.
   */
  onOutcome: (outcome: DesignAppChooseOutcome) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const run = async (appRoot: string) => {
    // The card comes next; the sheet's job is done.
    onOpenChange(false);
    try {
      const status = await designAppApi.choose(chatId, appRoot);
      if (status.problem && status.phase === "stopped") onOutcome({ appRoot, problem: status.problem });
    } catch (cause) {
      onOutcome({ appRoot, message: cause instanceof Error && cause.message ? cause.message : CHOOSE_FAILED });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose apps"
      description="Pick the apps design mode runs. The first run of each asks you on a card."
      confirmHidden
      cancelLabel="Close"
      {...(returnFocus ? { returnFocus } : {})}
    >
      <ul className="flex flex-col" aria-label="Web apps in this workspace">
        {snapshot.candidates.map((candidate, index) => {
          const status = snapshot.apps.find((app) => app.appRoot === candidate.appRoot);
          const running = busy(status);
          const root = consentDisplayText(candidate.appRoot);
          return (
            <li key={candidate.appRoot}>
              {index > 0 ? <Separator className="mx-3 w-auto" /> : null}
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <Text variant="strong" truncate className="block">
                    {candidate.frameworkLabel} · <span className="font-mono">{root}</span>
                  </Text>
                  <Text variant="small" color="tertiary" className="mt-0.5 block break-words">
                    {[candidate.name ? consentDisplayText(candidate.name) : null, candidate.script ? `runs ${consentDisplayText(candidate.script)}` : null]
                      .filter(Boolean)
                      .join(" · ") || "No dev script found"}
                  </Text>
                </div>
                <Button
                  variant="filled"
                  size="small"
                  disabled={running}
                  aria-label={running ? `${root} is running` : `Run ${root}`}
                  onClick={() => void run(candidate.appRoot)}
                >
                  {running ? "Running" : "Run"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

type ScanState = { kind: "reading" } | { kind: "read"; scan: DesignAppRunningScan } | { kind: "failed" };

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-3" aria-hidden="true">
      <div className="min-w-0 flex-1 space-y-2">
        <span className="block h-2.5 w-2/5 animate-pulse rounded-pill bg-control" />
        <span className="block h-2 w-3/5 animate-pulse rounded-pill bg-control" />
      </div>
      <span className="h-7 w-16 animate-pulse rounded-control bg-control" />
    </div>
  );
}

export function DesignAppConnectSheet({
  open,
  onOpenChange,
  chatId,
  filterRoot,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  /** Connect again for a detached pick: only that root's rows, with a way to show every row (B-m3). */
  filterRoot?: string;
  returnFocus?: () => HTMLElement | null;
}) {
  const [state, setState] = React.useState<ScanState>({ kind: "reading" });
  const [showAll, setShowAll] = React.useState(false);
  const [connecting, setConnecting] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<ReadonlyMap<string, string>>(new Map());
  const reads = React.useRef(0);
  /** Each open and each close starts a new lifetime: a connect from an earlier one settles into nothing. */
  const lifetime = React.useRef(0);

  const scan = React.useCallback(async () => {
    const read = ++reads.current;
    setState({ kind: "reading" });
    setErrors(new Map());
    try {
      const result = await designAppApi.running(chatId);
      if (read === reads.current) setState(result.ok ? { kind: "read", scan: result } : { kind: "failed" });
    } catch {
      if (read === reads.current) setState({ kind: "failed" });
    }
  }, [chatId]);

  React.useEffect(() => {
    lifetime.current += 1;
    if (!open) {
      reads.current += 1;
      return;
    }
    setShowAll(false);
    setConnecting(null);
    void scan();
  }, [open, scan]);

  const connect = async (server: DesignAppRunningServer) => {
    const key = `${server.port}:${server.pid}`;
    const begun = lifetime.current;
    setConnecting(key);
    setErrors((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    let message: string | null = null;
    try {
      const status = await designAppApi.connect(chatId, { port: server.port, pid: server.pid });
      if (status.problem || status.phase !== "running") message = status.problem ? designAppProblemMessage(status.problem) : CONNECT_FAILED;
    } catch (cause) {
      message = cause instanceof Error && cause.message ? cause.message : CONNECT_FAILED;
    }
    // The sheet closed (and maybe opened again) meanwhile: this answer is no longer its to show or act on.
    if (begun !== lifetime.current) return;
    setConnecting(null);
    if (message === null) {
      onOpenChange(false);
      return;
    }
    const shown = message;
    setErrors((current) => new Map(current).set(key, shown));
  };

  const servers = state.kind === "read" ? state.scan.servers : [];
  const filtered = filterRoot !== undefined && !showAll;
  const shown = filtered ? servers.filter((server) => server.appRoot === filterRoot) : servers;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect running server"
      description="Servers you started from this workspace's folder that listen only on this computer."
      confirmHidden
      cancelLabel="Close"
      {...(returnFocus ? { returnFocus } : {})}
    >
      {state.kind === "reading" ? (
        <div role="status" aria-label="Reading running servers" aria-busy="true">
          <SkeletonRow />
          <Separator className="mx-3 w-auto" />
          <SkeletonRow />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {state.kind === "failed" ? (
            <Text variant="small" color="secondary" className="block px-3">
              Aiden couldn't read the running servers.
            </Text>
          ) : shown.length === 0 ? (
            <Text variant="small" color="secondary" className="block px-3">
              {filtered ? `No server of yours is running for ${consentDisplayText(filterRoot!)}.` : "No server of yours is running in this workspace's folder."}
            </Text>
          ) : (
            <ul className="flex flex-col" aria-label="Running servers">
              {shown.map((server, index) => {
                const key = `${server.port}:${server.pid}`;
                const address = rowAddress(server);
                const error = errors.get(key);
                const reasonId = `design-app-server-${key}`;
                return (
                  <li key={key}>
                    {index > 0 ? <Separator className="mx-3 w-auto" /> : null}
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Text variant="strong" className="block font-mono">
                          {address}
                        </Text>
                        <Text variant="small" color="secondary" className="mt-0.5 block break-words">
                          {consentDisplayText(server.processName)} · <span className={designAppRootClass(server.folder)}>{designAppRootText(server.folder)}</span>
                        </Text>
                        <Text variant="small" color="tertiary" className="mt-0.5 block break-words">
                          App <span className={designAppRootClass(server.appRoot)}>{designAppRootText(server.appRoot)}</span>
                        </Text>
                        {!server.connectable && server.why ? (
                          <Text id={reasonId} variant="small" color="secondary" className="mt-1 block">
                            {WHY[server.why]}
                          </Text>
                        ) : null}
                        {error ? (
                          <Text role="alert" variant="small" color="status-red" className="mt-1 block">
                            {error}
                          </Text>
                        ) : null}
                      </div>
                      <Button
                        variant="filled"
                        size="small"
                        disabled={!server.connectable || connecting !== null}
                        aria-label={`Connect to ${address}`}
                        {...(!server.connectable && server.why ? { "aria-describedby": reasonId } : {})}
                        onClick={() => void connect(server)}
                      >
                        {connecting === key ? "Connecting…" : "Connect"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {state.kind === "read" && state.scan.incomplete ? (
            <Text variant="small" color="tertiary" className="block px-3">
              Some servers may be missing.
            </Text>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 px-1.5">
            {filtered && servers.length > shown.length ? (
              <Button variant="transparent" size="small" onClick={() => setShowAll(true)}>
                Show all servers
              </Button>
            ) : null}
            {state.kind === "failed" || shown.length === 0 ? (
              <Button variant="transparent" size="small" onClick={() => void scan()}>
                Refresh
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

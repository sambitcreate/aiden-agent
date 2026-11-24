// Aiden's `design_app` tool (design mode v2, Phase 2b): status, start, stop,
// restart, logs and choose for the workspace's web apps, through the one
// `DesignAppServers` service the person's controls also use. A start asks the
// person on the run-app card first (the service sends it to the turn's
// window); the tool only waits for the answer and the attempt, and an aborted
// turn stops the waiting, never the server. It runs only an app's own dev
// script, so the approval gate lets its calls through without a per-call card
// (`REVIEWED_CARDLESS_TOOLS`).

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  designAppProblemMessage,
  type DesignAppProblem,
  type DesignAppsSnapshot,
  type DesignAppStatus,
} from "../../../../renderer/shared/design-app.js";
import { fenceAsData } from "../../../../renderer/shared/agent-notices.js";
import { declareOnDemandSummary } from "../../on-demand-tools.js";
import { declarePiRuntimeReplay } from "../../pi-runtime-tool.js";
import type { WorkspaceGatePermission } from "../../approval-gate/workspace-tool-approval.js";
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import { DESIGN_APP_CONSENT_TIMEOUT_MS, type DesignAppConsentOwner } from "./app-consent.js";
import { lastLines, missingModuleHint } from "./app-launch-core.js";
import { DESIGN_APP_LOG_MAX_BYTES, type DesignAppServers } from "./app-server-main.js";

export const DESIGN_APP_TOOL_NAME = "design_app";
/** D16: starts, restarts and chooses per turn; the fifth is refused without acting. */
export const DESIGN_APP_STARTS_PER_TURN = 4;
/** After the card, how long a start waits for the attempt to settle. */
export const DESIGN_APP_SETTLE_MS = 90_000;
const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 200;
const LOG_CHARS_MAX = 8_000;
const TAIL_CHARS_MAX = 2_000;

const ACTIONS = ["status", "start", "stop", "restart", "logs", "choose"] as const;
type Action = (typeof ACTIONS)[number];
const STARTING_ACTIONS: ReadonlySet<Action> = new Set(["start", "restart", "choose"]);

export type DesignAppToolServers = Pick<
  DesignAppServers,
  "snapshot" | "start" | "stop" | "restart" | "choose" | "logs" | "onStatus"
>;

export interface DesignAppToolDeps {
  workspaceId: string;
  chatId: string;
  /** The turn's workspace access; the service checks the workspace again before every spawn. */
  permission: WorkspaceGatePermission;
  /** The window that owns the turn: the run-app card goes there. */
  owner(): DesignAppConsentOwner | undefined;
  /** Design mode is still on in this chat, in the same folder, with access, and the flag is on. */
  stillAvailable(): Promise<boolean>;
  servers: DesignAppToolServers;
  /** For tests: the card's own time and the settle time after it. */
  waits?: { consentMs: number; settleMs: number };
}

type Json = Record<string, unknown>;
const result = (value: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null });
const error = (message: string) => result({ status: "error", message });

const UNAVAILABLE = {
  status: "unavailable",
  message: "Design mode is off in this chat, or its workspace folder is no longer available, so design_app can't act.",
};

/** The answers to a card that wasn't Allow, each with what Aiden does next. */
const CONSENT_OUTCOMES: Partial<Record<DesignAppProblem["problem"], { status: string; next: string }>> = {
  "consent-declined": {
    status: "declined",
    next: "The person chose Not now for running this app. Carry on without the live app and don't start it again; they can start it themselves from the canvas.",
  },
  "consent-unanswered": {
    status: "unanswered",
    next: "Nobody answered the run-app card. Carry on without the live app; the person can start it themselves from the canvas.",
  },
  "consent-unavailable": {
    status: "unavailable",
    next: "No Aiden window could show the run-app card. Carry on without the live app; the person can start it from the canvas.",
  },
  "desktop-only": {
    status: "desktop-only",
    next: "Only an Aiden window on this computer can start the app. Carry on without the live app.",
  },
};

function crashMessage(app: DesignAppStatus): string {
  if (typeof app.exitCode === "number") return `The app's dev server stopped (exit code ${app.exitCode}).`;
  if (app.signal) return `The app's dev server stopped (${app.signal}).`;
  return "The app's dev server stopped.";
}

/** A problem's message, its fenced output and the missing-module hint; or a crash's. */
function trouble(app: DesignAppStatus): Json {
  const tail =
    app.phase === "crashed"
      ? app.tail
      : app.problem && "tail" in app.problem
        ? app.problem.tail
        : undefined;
  const message = app.problem ? designAppProblemMessage(app.problem) : app.phase === "crashed" ? crashMessage(app) : undefined;
  const kept = tail ? lastLines(tail, LOG_LINES_MAX, TAIL_CHARS_MAX) : "";
  const hint = kept ? missingModuleHint(kept) : undefined;
  return {
    ...(app.problem ? { problem: app.problem.problem } : {}),
    ...(message ? { message } : {}),
    ...(kept ? { output: fenceAsData("Server output", kept) } : {}),
    ...(hint ? { hint } : {}),
  };
}

function describeApp(app: DesignAppStatus): Json {
  return {
    root: app.appRoot,
    framework: app.frameworkLabel,
    ...(app.script ? { script: app.script } : {}),
    phase: app.phase,
    ...(app.startedBy ? { startedBy: app.startedBy } : {}),
    ...(app.phase === "running" && app.origin ? { url: app.origin } : {}),
    ...trouble(app),
  };
}

/** What a start, restart or choose answers for the status it ended on (or the wait ended on). */
function attemptResult(app: DesignAppStatus): Json {
  const consent = app.problem ? CONSENT_OUTCOMES[app.problem.problem] : undefined;
  if (consent) return { ...consent, root: app.appRoot };
  if (app.phase === "running" && app.origin) return { status: "running", root: app.appRoot, url: app.origin };
  if (app.phase === "consent") {
    return {
      status: "consent",
      root: app.appRoot,
      next: "The person hasn't answered the card yet; check status in a moment and don't start again.",
    };
  }
  if (app.phase === "installing" || app.phase === "starting") {
    return { status: app.phase, root: app.appRoot, next: "It is still starting; check with status in a moment." };
  }
  if (app.problem) return { status: "failed", root: app.appRoot, ...trouble(app) };
  if (app.phase === "crashed") return { status: "crashed", root: app.appRoot, ...trouble(app) };
  return { status: app.phase, root: app.appRoot };
}

/**
 * Waits for an attempt the way the person would: while a card for this
 * workspace is open, up to the card's own time; otherwise up to the settle
 * time since the last change. Ends early with null when the turn is aborted.
 */
function waitForAttempt(
  servers: DesignAppToolServers,
  workspaceId: string,
  appRoot: string | undefined,
  attempt: Promise<DesignAppStatus>,
  waits: { consentMs: number; settleMs: number },
  signal: AbortSignal | undefined,
): Promise<{ settled: DesignAppStatus } | { latest: DesignAppStatus | undefined } | null> {
  return new Promise((resolve) => {
    let latest: DesignAppStatus | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (value: { settled: DesignAppStatus } | { latest: DesignAppStatus | undefined } | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ latest }), ms);
    };
    const aborted = () => finish(null);
    const unsubscribe = servers.onStatus((snapshot: DesignAppsSnapshot) => {
      if (snapshot.workspaceId !== workspaceId) return;
      const apps = snapshot.apps.filter((app) => appRoot === undefined || app.appRoot === appRoot);
      const card = apps.find((app) => app.phase === "consent");
      const moving = card ?? apps.find((app) => app.phase === "installing" || app.phase === "starting");
      if (!moving) return;
      const wasCard = latest?.phase === "consent";
      latest = moving;
      if (card && !wasCard) arm(waits.consentMs);
      else if (!card && wasCard) arm(waits.settleMs);
    });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return finish(null);
    arm(waits.settleMs);
    attempt.then(
      (settled) => finish({ settled }),
      () => finish({ latest }),
    );
  });
}

export function createDesignAppTool(deps: DesignAppToolDeps): AgentTool {
  const waits = deps.waits ?? { consentMs: DESIGN_APP_CONSENT_TIMEOUT_MS, settleMs: DESIGN_APP_SETTLE_MS };
  let starts = 0;

  const knownRoots = (snapshot: DesignAppsSnapshot, candidatesOnly: boolean) =>
    new Set([
      ...snapshot.candidates.map((candidate) => candidate.appRoot),
      ...(candidatesOnly ? [] : [...snapshot.apps.map((app) => app.appRoot), ...snapshot.chosen]),
    ]);

  const execute = async (args: Json, signal: AbortSignal | undefined) => {
    const action = args.action as Action;
    if (!ACTIONS.includes(action)) return error(`action must be one of ${ACTIONS.join(", ")}.`);
    const { root, script, install, lines } = args;
    if (root !== undefined && (!isSafeWorkspaceRelativePath(root) || root.length > 200)) {
      return error('root must be an app root from status, such as "." or "apps/web".');
    }
    if (action !== "status" && action !== "start" && root === undefined) return error(`${action} needs root, an app root from status.`);
    if (install !== undefined && typeof install !== "boolean") return error("install must be true or false.");
    if (script !== undefined && (typeof script !== "string" || script.length === 0 || script.length > 200)) {
      return error("script must name a script in the app's package.json.");
    }
    if (lines !== undefined && !(Number.isInteger(lines) && (lines as number) >= 1 && (lines as number) <= LOG_LINES_MAX)) {
      return error(`lines must be a whole number from 1 to ${LOG_LINES_MAX}.`);
    }
    if (!(await deps.stillAvailable())) return result(UNAVAILABLE);
    if (STARTING_ACTIONS.has(action) && starts >= DESIGN_APP_STARTS_PER_TURN) {
      return error(
        `design_app already started, restarted or chose apps ${DESIGN_APP_STARTS_PER_TURN} times in this turn. Check status, and leave further starts to the person or a later turn.`,
      );
    }

    const snapshot = await deps.servers.snapshot(deps.workspaceId);
    if (action === "status") {
      return result({
        status: "ok",
        target: snapshot.target,
        apps: snapshot.apps.map(describeApp),
        candidates: snapshot.candidates.map((candidate) => ({
          root: candidate.appRoot,
          framework: candidate.frameworkLabel,
          ...(candidate.script ? { script: candidate.script } : {}),
          ...(candidate.name ? { name: candidate.name } : {}),
        })),
        chosen: snapshot.chosen,
      });
    }
    const appRoot = root as string | undefined;
    if (appRoot !== undefined && !knownRoots(snapshot, action === "choose").has(appRoot)) {
      return error(
        action === "choose"
          ? `${appRoot} isn't one of this workspace's web apps; choose a root from status's candidates.`
          : `${appRoot} isn't one of this workspace's apps; use a root from status.`,
      );
    }

    if (action === "stop") return result(attemptResult(await deps.servers.stop(deps.workspaceId, appRoot!)));
    if (action === "logs") {
      // The newest output: find where the log ends, then read its last window.
      const end = (await deps.servers.logs(deps.workspaceId, appRoot!, { after: Number.MAX_SAFE_INTEGER, maxBytes: 0 })).next;
      const read = await deps.servers.logs(deps.workspaceId, appRoot!, {
        after: Math.max(0, end - DESIGN_APP_LOG_MAX_BYTES),
        maxBytes: DESIGN_APP_LOG_MAX_BYTES,
      });
      const kept = lastLines(read.text, (lines as number | undefined) ?? LOG_LINES_DEFAULT, LOG_CHARS_MAX);
      return result({ status: "ok", root: appRoot, output: fenceAsData("Server output", kept) });
    }

    starts += 1;
    const base = {
      workspaceId: deps.workspaceId,
      chatId: deps.chatId,
      by: "aiden" as const,
      permission: deps.permission,
      ...(deps.owner() ? { owner: deps.owner()! } : {}),
    };
    // No signal: an aborted turn stops the wait below, never the attempt or the server.
    const attempt =
      action === "start"
        ? deps.servers.start({ ...base, ...(appRoot !== undefined ? { appRoot } : {}) })
        : action === "restart"
          ? deps.servers.restart({ ...base, appRoot: appRoot!, ...(install !== undefined ? { install: install as boolean } : {}) })
          : deps.servers.choose({ ...base, appRoot: appRoot!, ...(script !== undefined ? { script: script as string } : {}) });
    const waited = await waitForAttempt(deps.servers, deps.workspaceId, appRoot, attempt, waits, signal);
    if (waited === null) return error("The turn stopped while the app was starting; the attempt goes on. Check status later.");
    if ("settled" in waited) return result(attemptResult(waited.settled));
    if (waited.latest) return result(attemptResult(waited.latest));
    return result({ status: "starting", ...(appRoot ? { root: appRoot } : {}), next: "It is still starting; check with status in a moment." });
  };

  return declareOnDemandSummary(
    declarePiRuntimeReplay(
      {
        name: DESIGN_APP_TOOL_NAME,
        label: "Design app",
        description:
          "Run this workspace's web app for design mode: status, start, stop, restart, logs, or choose which app in a monorepo. The first start asks the person on a card. It runs only the app's own dev script, never other commands; use run_command for those.",
        parameters: Type.Object({
          action: Type.Union(ACTIONS.map((name) => Type.Literal(name))),
          root: Type.Optional(Type.String({ maxLength: 200, description: 'An app root from status, such as "." or "apps/web".' })),
          script: Type.Optional(Type.String({ maxLength: 200, description: "choose: the package.json script that runs the app." })),
          install: Type.Optional(Type.Boolean({ description: "restart: install the dependencies first." })),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: LOG_LINES_MAX, description: `logs: how many of the newest lines, default ${LOG_LINES_DEFAULT}.` })),
        }),
        execute: async (_id, args, signal) => {
          try {
            return await execute((args ?? {}) as Json, signal);
          } catch (cause) {
            return error(cause instanceof Error && cause.message ? cause.message : "design_app failed.");
          }
        },
      },
      "never",
    ),
    "Run this workspace's web app for design mode: status, start, stop, restart, logs, or choose the app.",
  );
}

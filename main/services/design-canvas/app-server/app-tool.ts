// Aiden's `design_app` tool (design mode v2, Phase 2b): status, start, stop,
// restart, logs and choose for the workspace's web apps, through the one
// `DesignAppServers` service the person's controls also use. A start asks the
// person on the run-app card first (the service sends it to the turn's
// window); the tool only waits for the answer and the attempt, and an aborted
// turn stops the waiting, never the server. It runs only an app's own dev
// script, so the approval gate lets its calls through without a per-call card
// (`REVIEWED_CARDLESS_TOOLS`).
//
// 3d (S102, S112, S113): `scaffold` adds a design app to a workspace with no
// web app, after the person's Allow on the scaffold card, which is also the
// launch consent. It takes no root, counts as a start, and its wait follows the
// card, then the write and the start.
//
// 2c (D11): a root with a url in `.aiden/canvas.json` is a server the person
// runs. `start` connects to it after the attach card, `stop` disconnects, and
// `logs` is refused: Aiden never starts, stops or reads that server.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  designAppProblemMessage,
  mockRefusalMessage,
  toolchainProblemMessage,
  type DesignAppProblem,
  type DesignAppScaffoldResult,
  type DesignAppsSnapshot,
  type DesignAppStatus,
  type DesignMockState,
} from "../../../../renderer/shared/design-app.js";
import { fenceAsData } from "../../../../renderer/shared/agent-notices.js";
import { declareOnDemandSummary } from "../../on-demand-tools.js";
import { declarePiRuntimeReplay } from "../../pi-runtime-tool.js";
import type { WorkspaceGatePermission } from "../../approval-gate/workspace-tool-approval.js";
import { isSafeWorkspaceRelativePath } from "../canvas-config.js";
import { DESIGN_APP_CONSENT_TIMEOUT_MS, type DesignAppConsentOwner } from "./app-consent.js";
import { lastLines, missingModuleHint } from "./app-launch-core.js";
import { DESIGN_APP_LOG_MAX_BYTES, type DesignAppScaffoldPage, type DesignAppServers } from "./app-server-main.js";

export const DESIGN_APP_TOOL_NAME = "design_app";
/** D16: starts, restarts and chooses per turn; the fifth is refused without acting. */
export const DESIGN_APP_STARTS_PER_TURN = 4;
/** After the card, how long a start waits for the attempt to settle. */
export const DESIGN_APP_SETTLE_MS = 90_000;
/** How long past the card's own time the wait lasts, so an unanswered card answers unanswered, not consent. */
export const DESIGN_APP_CONSENT_GRACE_MS = 5_000;
const LOG_LINES_DEFAULT = 50;
const LOG_LINES_MAX = 200;
const LOG_CHARS_MAX = 8_000;
const TAIL_CHARS_MAX = 2_000;

const ACTIONS = ["status", "start", "stop", "restart", "logs", "choose", "routes", "scaffold"] as const;
type Action = (typeof ACTIONS)[number];
const STARTING_ACTIONS: ReadonlySet<Action> = new Set(["start", "restart", "choose", "scaffold"]);
/** The actions that take no root. */
const ROOTLESS_ACTIONS: ReadonlySet<Action> = new Set(["status", "start", "routes", "scaffold"]);

export type DesignAppToolServers = Pick<
  DesignAppServers,
  "snapshot" | "start" | "stop" | "restart" | "choose" | "logs" | "onStatus" | "routes" | "scaffold"
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
  /** 3d: the page a design app's `/` goes on, the turn's (S84). Without it, `scaffold` is unavailable. */
  scaffoldPage?(): DesignAppScaffoldPage;
  /** 3d: after a scaffold wrote its files, so the turn's later route writes find the new app. */
  onScaffolded?(): void;
  /** For tests: the card's own time, the settle time after it, and the grace past the card's time. */
  waits?: { consentMs: number; settleMs: number; graceMs?: number };
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
  const message = app.problem ? designAppProblemMessage(app.problem, { mock: app.mock === true }) : app.phase === "crashed" ? crashMessage(app) : undefined;
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
    ...(app.source === "attached" ? { source: "attached" } : {}),
    framework: app.frameworkLabel,
    ...(app.script ? { script: app.script } : {}),
    ...(app.source === "attached" && app.url ? { configUrl: app.url } : {}),
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
  if (app.phase === "running" && app.origin) {
    return { status: "running", root: app.appRoot, ...(app.source === "attached" ? { source: "attached" } : {}), url: app.origin };
  }
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
 * workspace is open, up to the card's own time and a grace; otherwise up to the settle
 * time since the last change. Ends early with null when the turn is aborted.
 */
function waitForAttempt(
  servers: DesignAppToolServers,
  workspaceId: string,
  appRoot: string | undefined,
  attempt: Promise<DesignAppStatus>,
  waits: { consentMs: number; settleMs: number; graceMs?: number },
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
      if (card && !wasCard) arm(waits.consentMs + (waits.graceMs ?? DESIGN_APP_CONSENT_GRACE_MS));
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

/** The snapshot's design app offer, for status: the refusal's and the toolchain problem's fixed messages. */
function describeMock(mock: DesignMockState): Json {
  const { problem, ...offer } = mock;
  return {
    ...offer,
    ...(offer.offer === "refused" ? { message: mockRefusalMessage(offer.why, offer.folder) } : {}),
    ...(problem ? { problem: problem.problem, message: toolchainProblemMessage(problem) } : {}),
  };
}

/** What a scaffold's card answered when it wasn't Allow, and the problems before it, each with what Aiden does next. */
const SCAFFOLD_OUTCOMES: Partial<Record<DesignAppProblem["problem"], { status: string; next: string }>> = {
  "consent-declined": {
    status: "declined",
    next: "The person chose Not now for adding a design app. Carry on without one and don't ask again; they can add it from the canvas's app chip.",
  },
  "consent-unanswered": {
    status: "unanswered",
    next: "Nobody answered the design app card, so nothing was written. Carry on without a design app; the person can add one from the canvas.",
  },
  "consent-unavailable": {
    status: "unavailable",
    next: "No Aiden window could show the design app card, so nothing was written. Carry on without a design app.",
  },
  "desktop-only": {
    status: "desktop-only",
    next: "Only an Aiden window on this computer can add a design app. Carry on without one.",
  },
};

function scaffoldResult(answer: DesignAppScaffoldResult): Json {
  if (answer.status === "problem") {
    const { problem } = answer;
    const outcome = SCAFFOLD_OUTCOMES[problem.problem];
    if (outcome) return outcome;
    if (problem.problem === "unavailable") return UNAVAILABLE;
    if (problem.problem === "scaffold-refused") return { status: "refused", why: problem.why, message: mockRefusalMessage(problem.why) };
    return { status: "failed", problem: problem.problem, message: designAppProblemMessage(problem) };
  }
  if (answer.status === "existing") {
    return {
      status: "existing",
      root: answer.root,
      phase: answer.app.phase,
      ...(answer.app.phase === "running" && answer.app.origin ? { url: answer.app.origin } : {}),
      next: "This workspace already has a design app. Use design_app start with this root, and write its pages in src/routes.",
    };
  }
  const { app } = answer;
  return {
    status: "scaffolded",
    root: answer.root,
    kind: answer.kind,
    phase: app.phase,
    ...(app.phase === "running" && app.origin ? { url: app.origin } : {}),
    placed: answer.placed,
    aliases: answer.aliases,
    stubs: answer.stubs,
    globals: answer.globals,
    designMd: answer.designMd,
    styleSources: answer.styleSources,
    ...trouble(app),
  };
}

type ScaffoldPhase = "card" | "writing" | "app";

/**
 * A scaffold's wait (S102): up to the settle time before the card, the card's
 * own time and a grace while it's open, then the settle time from the write
 * and again from the start. Ends with null when the turn is aborted; the card,
 * the write and the start go on either way.
 */
function waitForScaffold(
  start: (onPhase: (phase: ScaffoldPhase) => void) => Promise<DesignAppScaffoldResult>,
  waits: { consentMs: number; settleMs: number; graceMs?: number },
  signal: AbortSignal | undefined,
): Promise<{ done: DesignAppScaffoldResult; phase: ScaffoldPhase | undefined } | { phase: ScaffoldPhase | undefined } | null> {
  return new Promise((resolve) => {
    let phase: ScaffoldPhase | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    type Ending = { done: DesignAppScaffoldResult; phase: ScaffoldPhase | undefined } | { phase: ScaffoldPhase | undefined } | null;
    const finish = (value: Ending) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ phase }), ms);
    };
    const aborted = () => finish(null);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return finish(null);
    arm(waits.settleMs);
    start((next) => {
      if (finished) return;
      phase = next;
      arm(next === "card" ? waits.consentMs + (waits.graceMs ?? DESIGN_APP_CONSENT_GRACE_MS) : waits.settleMs);
    }).then(
      (done) => finish({ done, phase }),
      () => finish({ phase }),
    );
  });
}

/**
 * 3b (S82): an app's pages, read-only. Route strings come from the person's
 * files and config, so they go back only as JSON values, never as prose.
 */
function routesResult(answer: Awaited<ReturnType<DesignAppToolServers["routes"]>>, root: string | undefined) {
  if ("error" in answer) {
    if (answer.error === "unavailable") return result(UNAVAILABLE);
    const roots = JSON.stringify(answer.roots);
    return answer.error === "choose-root"
      ? error(`This workspace has several apps; name root, one of ${roots}.`)
      : error(`${JSON.stringify(root ?? ".")} isn't one of this workspace's apps; use a root from ${roots}.`);
  }
  return result({
    status: "routes",
    root: answer.appRoot,
    ...(answer.framework ? { framework: answer.framework } : {}),
    source: answer.source,
    truncated: answer.truncated,
    routes: answer.routes.map((entry) => (entry.pattern !== undefined ? { route: entry.route, pattern: entry.pattern } : { route: entry.route })),
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

  const noAccess = (appRoot?: string) =>
    deps.permission === "read-only" || deps.permission === "none"
      ? result({
          status: "failed",
          ...(appRoot !== undefined ? { root: appRoot } : {}),
          problem: "no-access",
          message: designAppProblemMessage({ problem: "no-access" }),
        })
      : undefined;

  const scaffold = async (signal: AbortSignal | undefined) => {
    const refused = noAccess();
    if (refused) return refused;
    const page = deps.scaffoldPage?.();
    if (!page) return result(UNAVAILABLE);
    starts += 1;
    const owner = deps.owner();
    // No signal for the service: an aborted turn stops this wait, never the card, the write or the start.
    const waited = await waitForScaffold(
      (onPhase) =>
        deps.servers.scaffold({
          workspaceId: deps.workspaceId,
          chatId: deps.chatId,
          by: "aiden",
          permission: deps.permission,
          ...(owner ? { owner } : {}),
          page,
          onPhase,
        }),
      waits,
      signal,
    );
    const wrote = waited !== null && (("done" in waited && waited.done.status === "scaffolded") || waited.phase === "app");
    if (wrote) deps.onScaffolded?.();
    if (waited === null) return error("The turn stopped while the design app was being added; the card and the start go on. Check status later.");
    if ("done" in waited) return result(scaffoldResult(waited.done));
    if (waited.phase === "card") {
      return result({ status: "consent", next: "The person hasn't answered the design app card yet; check status in a moment and don't scaffold again." });
    }
    return result({ status: "starting", next: "The design app is being written and started; check with status in a moment, and don't scaffold again." });
  };

  const execute = async (args: Json, signal: AbortSignal | undefined) => {
    const action = args.action as Action;
    if (!ACTIONS.includes(action)) return error(`action must be one of ${ACTIONS.join(", ")}.`);
    const { root, script, install, lines } = args;
    if (root !== undefined && (!isSafeWorkspaceRelativePath(root) || root.length > 200)) {
      return error('root must be an app root from status, such as "." or "apps/web".');
    }
    if (!ROOTLESS_ACTIONS.has(action) && root === undefined) return error(`${action} needs root, an app root from status.`);
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

    if (action === "routes") return routesResult(await deps.servers.routes(deps.workspaceId, root as string | undefined), root as string | undefined);

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
        ...(snapshot.mock ? { mock: describeMock(snapshot.mock) } : {}),
      });
    }
    if (action === "scaffold") return scaffold(signal);
    const appRoot = root as string | undefined;
    if (appRoot !== undefined && !knownRoots(snapshot, action === "choose").has(appRoot)) {
      return error(
        action === "choose"
          ? `${appRoot} isn't one of this workspace's web apps; choose a root from status's candidates.`
          : `${appRoot} isn't one of this workspace's apps; use a root from status.`,
      );
    }

    const current = snapshot.apps.find((app) => app.appRoot === appRoot);
    if (action === "stop") {
      const stopped = await deps.servers.stop(deps.workspaceId, appRoot!);
      // Stopping an attached app only disconnects it: the person's server keeps running (D9).
      const disconnected = current?.source === "attached" && current.phase === "running" && stopped.phase === "stopped";
      return result({ ...attemptResult(stopped), ...(disconnected ? { next: "Disconnected. The server keeps running." } : {}) });
    }
    if (action === "logs") {
      if (current?.source === "attached") return error("Aiden doesn't read the output of a server it didn't start.");
      // The newest output: find where the run's log ends, then read that run's last window.
      const probe = await deps.servers.logs(deps.workspaceId, appRoot!, { after: 0, maxBytes: 0 });
      const read = await deps.servers.logs(deps.workspaceId, appRoot!, {
        after: Math.max(0, probe.end - DESIGN_APP_LOG_MAX_BYTES),
        ...(probe.run !== undefined ? { run: probe.run } : {}),
        maxBytes: DESIGN_APP_LOG_MAX_BYTES,
      });
      const kept = lastLines(read.text, (lines as number | undefined) ?? LOG_LINES_DEFAULT, LOG_CHARS_MAX);
      return result({ status: "ok", root: appRoot, output: fenceAsData("Server output", kept) });
    }

    // A turn that can't write to the workspace never runs its app: the same answer the service gives.
    const refused = noAccess(appRoot);
    if (refused) return refused;
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
          "Run this workspace's web app for design mode: status, start, stop, restart, logs, or choose which app in a monorepo. routes lists the app's pages (from its files or .aiden/canvas.json); a route with [brackets] is a pattern that needs a value. The first start asks the person on a card. It runs only the app's own dev script, never other commands; use run_command for those. When status says there's no web app and offers a design app (mock), scaffold adds a small React app in design-app/ after the person allows it on a card (don't ask first; the card is the question), starts it and puts its / on the canvas; then each design is a route file in its src/routes. A root with a url in .aiden/canvas.json is a server the person runs: start connects to it after the person approves, stop disconnects, and Aiden never starts, stops or reads the output of that server.",
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
    "Run this workspace's web app for design mode: status, start, stop, restart, logs, choose the app, list its routes, or add a design app.",
  );
}

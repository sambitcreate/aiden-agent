/**
 * Design mode's live apps (plan 2b D2–D17): one dev server per app root of a
 * workspace, started only by the person or `design_app`, after consent, on
 * 127.0.0.1 only, and stopped 60 s after the workspace's last visible canvas
 * goes.
 *
 * Every action on an app key runs through one queue; a start while one is
 * pending joins it, so the person never sees two cards for one app. Each
 * attempt holds one workspace admission until the server runs or the attempt
 * ends, and rebuilds every argv from what is on disk right before each spawn.
 * One shared poller reads every design job's sockets: every 500 ms while any
 * server is starting, every 2 s while they run, never while none does. Every
 * external effect goes through `deps`, so constructing the service, restoring
 * views and presence changes never start, probe or read anything.
 */
import path from "node:path";
import {
  type DesignAppCandidate,
  type DesignAppLogs,
  type DesignAppPhase,
  type DesignAppProblem,
  type DesignAppsSnapshot,
  type DesignAppStatus,
  type FrameworkId,
  type PackageManagerName,
} from "../../../../renderer/shared/design-app.js";
import type { WorkspaceGatePermission } from "../../approval-gate/workspace-tool-approval.js";
import {
  BackgroundJobLimitError,
  type DesignJobView,
  type DesignLogRead,
  type StartDesignJobInput,
} from "../../follow-through/background-jobs.js";
import type { JobSockets } from "../../follow-through/listening-ports.js";
import type { WorkspaceMutationGate } from "../../workspace-mutation-gate.js";
import { configuredRoots, type CanvasConfig } from "../canvas-config.js";
import { isDesktopOwner, type DesignAppConsent, type DesignAppConsentOwner, type LaunchConsentCard } from "./app-consent.js";
import type { LaunchSurfaceProblem, LaunchSurfaceRead } from "./app-fingerprint.js";
import {
  exposedSockets,
  isAddressInUse,
  lastLines,
  launchEnvironment,
  launchPlan,
  needsInstall,
  readyPort,
} from "./app-launch-core.js";
import type { DesignAppRecords } from "./app-records.js";
import {
  designTarget,
  FRAMEWORKS,
  installCommand,
  isSafeScriptName,
  type DetectedApp,
  type WebAppDetection,
} from "./app-server-core.js";
import type { AppToolchain } from "./app-toolchain.js";

export const DESIGN_APP_PRESENCE_GRACE_MS = 60_000;
export const DESIGN_APP_READY_IDLE_MS = 120_000;
export const DESIGN_APP_READY_CAP_MS = 10 * 60_000;
export const DESIGN_APP_INSTALL_TIMEOUT_MS = 15 * 60_000;
export const DESIGN_APP_POLL_STARTING_MS = 500;
export const DESIGN_APP_POLL_RUNNING_MS = 2_000;
/** Failed socket reads in a row that stop a running server. */
export const DESIGN_APP_EXPOSURE_FAILURES = 3;
/** The most log bytes one read returns. */
export const DESIGN_APP_LOG_MAX_BYTES = 64 * 1024;
const TAIL_LINES = 20;
const TAIL_CHARS = 2_000;

export interface DesignWorkspace {
  id: string;
  /** The workspace folder; absent for a workspace without one. */
  path?: string;
  permission: WorkspaceGatePermission;
}

export interface DesignAppJobs {
  startDesign(input: StartDesignJobInput): DesignJobView;
  stopDesign(jobId: string): Promise<DesignJobView>;
  getDesign(jobId: string): DesignJobView | undefined;
  designTail(jobId: string): string;
  designSockets(jobIds: readonly string[]): Promise<Map<string, JobSockets>>;
  readDesignLog(jobId: string, options: { after: number; maxBytes: number }): Promise<DesignLogRead>;
}

export interface DesignAppServersDeps {
  jobs: DesignAppJobs;
  onJobChange(listener: (view: DesignJobView) => void): () => void;
  detect(workspaceRoot: string): Promise<WebAppDetection>;
  readConfig(workspaceRoot: string): Promise<CanvasConfig | null>;
  saveConfigApp(workspaceRoot: string, app: { root: string; script: string }, signal?: AbortSignal): Promise<"saved" | "unknown-version">;
  toolchain(app: DetectedApp): Promise<AppToolchain>;
  fingerprint(workspaceRoot: string, app: DetectedApp): Promise<LaunchSurfaceRead | LaunchSurfaceProblem>;
  records: DesignAppRecords;
  choosePort(input: { sticky?: number; fallback: number }): Promise<number>;
  osPort(): Promise<number>;
  consent: Pick<DesignAppConsent, "request" | "forgetDecline" | "closeAll">;
  views: { visible(workspaceId: string): number; onPresence(listener: (workspaceId: string, visibleCount: number) => void): () => void };
  workspace(workspaceId: string): Promise<DesignWorkspace | undefined>;
  gate: Pick<WorkspaceMutationGate, "admit">;
  /** Settles true once the last session's leftover processes are reaped. */
  recoveryReady: Promise<boolean>;
  /** The base environment and the provider key names to scrub from it (D7). */
  launchEnv(): { env: NodeJS.ProcessEnv; providerKeys: Iterable<string> };
  report(event: { framework: FrameworkId; manager?: PackageManagerName; outcome: "running" | "crashed" | "failed" }): void;
  /** False while the flag is off. */
  enabled?(): boolean;
  platform?: NodeJS.Platform;
  now?(): number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  log?(event: string, detail?: Record<string, unknown>): void;
  /** Shorter limits, for tests against real processes. */
  limits?: Partial<DesignAppLimits>;
}

export interface DesignAppLimits {
  readyIdleMs: number;
  readyCapMs: number;
  graceMs: number;
  installTimeoutMs: number;
}

export interface DesignAppStartInput {
  workspaceId: string;
  appRoot?: string;
  by: "person" | "aiden";
  chatId: string;
  owner?: DesignAppConsentOwner;
  permission: WorkspaceGatePermission;
  install?: boolean;
  signal?: AbortSignal;
}

export interface DesignAppChooseInput extends Omit<DesignAppStartInput, "appRoot" | "install"> {
  appRoot: string;
  script?: string;
}

interface AttemptInput {
  by: "person" | "aiden";
  chatId: string;
  owner?: DesignAppConsentOwner;
  install?: boolean;
  keepPort?: number;
  choose?: { script?: string };
  signal?: AbortSignal;
}

type StartOutcome = { kind: "ready"; port: number } | { kind: "exited"; view: DesignJobView } | { kind: "problem"; problem: DesignAppProblem };

interface ServerWatch {
  jobId: string;
  planned: number;
  workspacePath: string;
  running: boolean;
  stopping?: boolean;
  failedReads: number;
  outputBytes: number;
  held: Array<{ address: string; port: number }>;
  idleTimer?: unknown;
  capTimer?: unknown;
  settle?: (outcome: StartOutcome) => void;
}

interface Attempt {
  controller: AbortController;
  promise: Promise<DesignAppStatus>;
  jobId?: string;
}

interface Entry {
  key: string;
  workspaceId: string;
  appRoot: string;
  status: DesignAppStatus;
  meta: Pick<DesignAppStatus, "framework" | "frameworkLabel" | "manager" | "script" | "startedBy">;
  queue: Promise<void>;
  attempt?: Attempt;
  server?: ServerWatch;
  lastJobId?: string;
  /** The port the server last ran on, kept by restart. */
  port?: number;
}

const STOP = "stop";
const GATE = "gate";

class Aborted extends Error {
  constructor() {
    super("The app's start was stopped.");
  }
}

/** How an attempt ended without running. */
class End extends Error {
  constructor(
    readonly problem: DesignAppProblem | undefined,
    readonly outcome?: "crashed" | "failed",
    readonly phase: "stopped" | "crashed" = "stopped",
    readonly extra: Partial<DesignAppStatus> = {},
  ) {
    super(problem?.problem ?? phase);
  }
}

function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function frameworkLabel(framework: FrameworkId | undefined): string {
  return FRAMEWORKS.find((spec) => spec.id === framework)?.label ?? "App";
}

function defaultPort(framework: FrameworkId | undefined): number {
  return FRAMEWORKS.find((spec) => spec.id === framework)?.defaultPort ?? 5173;
}

function absolute(workspacePath: string, relative: string): string {
  return relative === "." ? workspacePath : path.join(workspacePath, ...relative.split("/"));
}

function isIpv4Loopback(address: string): boolean {
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare);
}

/** Loopback URL ports the server printed: the job must also hold one for it to count. */
function printedPorts(tail: string): number[] {
  const ports: number[] = [];
  for (const match of tail.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})\b/gu)) ports.push(Number(match[1]));
  return ports.reverse();
}

const keyOf = (workspaceId: string, appRoot: string) => `${workspaceId}\0${appRoot}`;

export class DesignAppServers {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, { detection: WebAppDetection; config: CanvasConfig | null }>();
  private readonly served = new Map<string, Set<string>>();
  private readonly presenceTimers = new Map<string, unknown>();
  private readonly jobWaiters = new Map<string, (view: DesignJobView) => void>();
  private readonly statusListeners = new Set<(snapshot: DesignAppsSnapshot) => void>();
  private readonly originListeners = new Set<() => void>();
  private pollTimer: unknown;
  private pollDelay = 0;
  private polling = false;
  private readonly now: () => number;
  private readonly limits: DesignAppLimits;
  private readonly timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

  constructor(private readonly deps: DesignAppServersDeps) {
    this.now = deps.now ?? Date.now;
    this.limits = {
      readyIdleMs: DESIGN_APP_READY_IDLE_MS,
      readyCapMs: DESIGN_APP_READY_CAP_MS,
      graceMs: DESIGN_APP_PRESENCE_GRACE_MS,
      installTimeoutMs: DESIGN_APP_INSTALL_TIMEOUT_MS,
      ...deps.limits,
    };
    this.timers = deps.timers ?? {
      set: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    deps.onJobChange((view) => this.jobChanged(view));
    deps.views.onPresence((workspaceId, count) => this.presence(workspaceId, count));
  }

  // ── Public API ──

  async snapshot(workspaceId: string): Promise<DesignAppsSnapshot> {
    if (this.available()) {
      const workspace = await this.deps.workspace(workspaceId);
      if (workspace?.path && workspace.permission !== "none") await this.detectFor(workspace.id, workspace.path);
      else this.cache.delete(workspaceId);
    }
    return this.snapshotNow(workspaceId);
  }

  async start(input: DesignAppStartInput): Promise<DesignAppStatus> {
    const refusal = this.refusal(input.workspaceId, input.appRoot ?? ".", input);
    if (refusal) return refusal;
    let appRoot = input.appRoot;
    if (appRoot === undefined) {
      if (!(await this.recovered())) return this.statusWith(input.workspaceId, ".", { problem: "recovery-failed" });
      const workspace = await this.deps.workspace(input.workspaceId);
      if (!workspace?.path || workspace.permission === "none") return this.statusWith(input.workspaceId, ".", { problem: "no-access" });
      const cached = await this.detectFor(workspace.id, workspace.path);
      appRoot = this.toggleRoots(cached.detection, cached.config)[0];
      if (appRoot === undefined) return this.statusWith(input.workspaceId, ".", { problem: "not-web" });
    }
    return this.begin(this.ensure(input.workspaceId, appRoot), input);
  }

  async stop(workspaceId: string, appRoot: string): Promise<DesignAppStatus> {
    const entry = this.entries.get(keyOf(workspaceId, appRoot));
    if (!entry) return this.statusWith(workspaceId, appRoot);
    return this.enqueue(entry, async () => {
      await this.halt(entry);
      return { ...entry.status };
    });
  }

  async restart(input: DesignAppStartInput & { appRoot: string }): Promise<DesignAppStatus> {
    const refusal = this.refusal(input.workspaceId, input.appRoot, input);
    if (refusal) return refusal;
    const entry = this.ensure(input.workspaceId, input.appRoot);
    const keepPort = entry.port;
    await this.stop(input.workspaceId, input.appRoot);
    return this.begin(entry, { ...input, ...(keepPort !== undefined ? { keepPort } : {}) });
  }

  async choose(input: DesignAppChooseInput): Promise<DesignAppStatus> {
    const refusal = this.refusal(input.workspaceId, input.appRoot, input);
    if (refusal) return refusal;
    const entry = this.ensure(input.workspaceId, input.appRoot);
    if (entry.server?.running && input.script !== undefined && entry.status.script !== input.script) {
      await this.stop(input.workspaceId, input.appRoot);
    }
    return this.begin(entry, { ...input, choose: { ...(input.script !== undefined ? { script: input.script } : {}) } });
  }

  async logs(workspaceId: string, appRoot: string, options: { after?: number; maxBytes: number }): Promise<DesignAppLogs> {
    const jobId = this.entries.get(keyOf(workspaceId, appRoot))?.lastJobId;
    if (!jobId) return { text: "", from: 0, next: 0, truncated: false };
    const maxBytes = Math.max(0, Math.min(DESIGN_APP_LOG_MAX_BYTES, Math.floor(options.maxBytes)));
    return this.deps.jobs.readDesignLog(jobId, { after: options.after ?? 0, maxBytes });
  }

  /** D4: the person turned design mode on; starts the configured roots or the single web app. Fire and forget. */
  designModeEntered(input: { chatId: string; workspaceId: string; owner: DesignAppConsentOwner }): void {
    void (async () => {
      if (!this.available() || !isDesktopOwner(input.owner)) return;
      if (!(await this.recovered())) return;
      const workspace = await this.deps.workspace(input.workspaceId);
      if (!workspace?.path || workspace.permission === "none" || workspace.permission === "read-only") return;
      const cached = await this.detectFor(workspace.id, workspace.path);
      for (const appRoot of this.toggleRoots(cached.detection, cached.config)) {
        await this.start({ workspaceId: workspace.id, appRoot, by: "person", chatId: input.chatId, owner: input.owner, permission: workspace.permission });
      }
    })().catch((error: unknown) => this.deps.log?.("design-app-toggle-failed", { error: String(error) }));
  }

  async forgetWorkspace(workspaceId: string): Promise<void> {
    this.clearPresence(workspaceId);
    const entries = [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId);
    let hadRunning = false;
    for (const entry of entries) {
      hadRunning ||= entry.server?.running === true;
      await this.halt(entry, { quiet: true });
    }
    for (const entry of entries) this.entries.delete(entry.key);
    this.served.delete(workspaceId);
    this.cache.delete(workspaceId);
    this.deps.consent.closeAll(`${workspaceId}\0`);
    await this.deps.records.forgetWorkspace(workspaceId);
    if (hadRunning) this.originsChanged();
    this.emit(workspaceId);
  }

  appForOrigin(origin: string): { workspaceId: string; appRoot: string } | undefined {
    const url = this.parseOrigin(origin);
    if (!url || url.protocol !== "http:") return undefined;
    const port = Number(url.port);
    const host = url.hostname;
    if (host !== "127.0.0.1" && host !== "[::1]") return undefined;
    for (const entry of this.entries.values()) {
      const watch = entry.server;
      if (!watch?.running || entry.status.port !== port) continue;
      const held = watch.held.some(
        (socket) => socket.port === port && (host === "127.0.0.1" ? socket.address === "127.0.0.1" || socket.address === "::ffff:127.0.0.1" : socket.address === "::1"),
      );
      if (held) return { workspaceId: entry.workspaceId, appRoot: entry.appRoot };
    }
    return undefined;
  }

  isAppOrigin(origin: string): boolean {
    const url = this.parseOrigin(origin);
    if (!url) return false;
    for (const origins of this.served.values()) if (origins.has(url.origin)) return true;
    return false;
  }

  onOriginsChanged(listener: () => void): () => void {
    this.originListeners.add(listener);
    return () => this.originListeners.delete(listener);
  }

  onStatus(listener: (snapshot: DesignAppsSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ── Starting ──

  private available(): boolean {
    return (this.deps.platform ?? process.platform) !== "win32" && (this.deps.enabled?.() ?? true);
  }

  private recovered(): Promise<boolean> {
    return this.deps.recoveryReady.then(
      (ready) => ready === true,
      () => false,
    );
  }

  /** D5's refusals, before anything is read. */
  private refusal(
    workspaceId: string,
    appRoot: string,
    input: { owner?: DesignAppConsentOwner; permission: WorkspaceGatePermission },
  ): DesignAppStatus | undefined {
    if (!this.available()) return this.statusWith(workspaceId, appRoot, { problem: "unavailable" });
    if (!isDesktopOwner(input.owner)) return this.statusWith(workspaceId, appRoot, { problem: "desktop-only" });
    if (input.permission === "none" || input.permission === "read-only") return this.statusWith(workspaceId, appRoot, { problem: "no-access" });
    return undefined;
  }

  private ensure(workspaceId: string, appRoot: string): Entry {
    const key = keyOf(workspaceId, appRoot);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        workspaceId,
        appRoot,
        meta: { frameworkLabel: "App" },
        status: this.blankStatus(workspaceId, appRoot),
        queue: Promise.resolve(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private blankStatus(workspaceId: string, appRoot: string, app?: DetectedApp): DesignAppStatus {
    return {
      workspaceId,
      appRoot,
      source: "started",
      ...(app?.framework ? { framework: app.framework } : {}),
      frameworkLabel: frameworkLabel(app?.framework),
      ...(app?.packageManager.name ? { manager: app.packageManager.name } : {}),
      ...(app?.script ? { script: app.script } : {}),
      phase: "stopped",
      since: 0,
      revision: 0,
    };
  }

  /** The current status with a problem, for an answer that changes nothing. */
  private statusWith(workspaceId: string, appRoot: string, problem?: DesignAppProblem): DesignAppStatus {
    const current = this.entries.get(keyOf(workspaceId, appRoot))?.status ?? this.blankStatus(workspaceId, appRoot);
    return { ...current, ...(problem ? { problem } : {}) };
  }

  private enqueue<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const result = entry.queue.then(run, run);
    entry.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** A new attempt, or the pending one (D2): one card and one job per key. */
  private begin(entry: Entry, input: AttemptInput): Promise<DesignAppStatus> {
    const created = entry.queue.then(() => {
      if (entry.attempt) return { promise: entry.attempt.promise };
      if (entry.server?.running) return { promise: Promise.resolve({ ...entry.status }) };
      const attempt: Attempt = { controller: new AbortController(), promise: Promise.resolve(entry.status) };
      entry.attempt = attempt;
      attempt.promise = this.runAttempt(entry, input, attempt).finally(() => {
        if (entry.attempt === attempt) entry.attempt = undefined;
      });
      return { promise: attempt.promise };
    });
    entry.queue = created.then(
      () => undefined,
      () => undefined,
    );
    return created.then(({ promise }) => promise);
  }

  private async runAttempt(entry: Entry, input: AttemptInput, attempt: Attempt): Promise<DesignAppStatus> {
    const { controller } = attempt;
    const signal = controller.signal;
    const callerAbort = () => controller.abort(STOP);
    input.signal?.addEventListener("abort", callerAbort, { once: true });
    let admission: { signal: AbortSignal; release(): void } | undefined;
    let framework: FrameworkId | undefined;
    let manager: PackageManagerName | undefined;
    entry.meta = { ...entry.meta, startedBy: input.by };
    const report = (outcome: "running" | "crashed" | "failed") => {
      if (framework) this.deps.report({ framework, ...(manager ? { manager } : {}), outcome });
    };
    try {
      if (!(await race(this.recovered(), signal))) throw new End({ problem: "recovery-failed" });
      const workspace = await race(this.deps.workspace(entry.workspaceId), signal);
      if (!workspace?.path || workspace.permission === "none") throw new End({ problem: "no-access" });
      const workspacePath = workspace.path;
      try {
        admission = this.deps.gate.admit(entry.workspaceId);
      } catch {
        throw new End({ problem: "interrupted" });
      }
      const onGate = () => controller.abort(GATE);
      admission.signal.addEventListener("abort", onGate, { once: true });
      if (admission.signal.aborted) onGate();

      let installDone = false;
      let port = input.keepPort;
      let portChosen = false;
      let retried = false;
      let chooseAsked = false;
      /** A card was allowed in this attempt, so a missing record means the repo changed since. */
      let allowed = false;
      let shown: { fingerprint: string; installShown: boolean; script: string } | undefined;
      let saved = false;
      for (;;) {
        // Read everything again: what runs is what is on disk now (D5).
        const cached = await race(this.detectFor(entry.workspaceId, workspacePath), signal);
        const app = this.resolveApp(cached.detection, cached.config, entry.appRoot, input.choose?.script);
        if (!app) throw new End({ problem: "not-web" });
        framework = app.framework;
        entry.meta = {
          ...entry.meta,
          ...(app.framework ? { framework: app.framework } : {}),
          frameworkLabel: frameworkLabel(app.framework),
          script: app.script!,
          ...(app.packageManager.name ? { manager: app.packageManager.name } : {}),
        };
        const toolchain = await race(this.deps.toolchain(app), signal);
        if (!toolchain.ok) {
          const { ok: _ok, ...problem } = toolchain;
          throw new End(problem, "failed");
        }
        manager = toolchain.manager.name;
        const surface = await race(this.deps.fingerprint(workspacePath, app), signal);
        if ("problem" in surface) throw new End(surface);
        const installRecord = await race(this.deps.records.installOf(entry.workspaceId, app.installRoot), signal);
        const install = needsInstall({
          installed: app.installed,
          lockfileLevelsUp: app.packageManager.lockfileLevelsUp,
          record: installRecord,
          lockHash: surface.lockHash,
          manager: toolchain.manager.name,
          forced: input.install === true && !installDone,
        });
        if (install === "outside-workspace") throw new End({ problem: "install-outside-workspace" }, "failed");
        const willInstall = install === "install";

        // Allow approves only what the card showed, and only while it is still what's on disk.
        if (shown) {
          const stored = await race(
            this.deps.records.approveShown(entry.workspaceId, entry.appRoot, { script: shown.script, installShown: shown.installShown }, shown.fingerprint, surface.fingerprint),
            signal,
          );
          shown = undefined;
          if (stored && input.choose) chooseAsked = true;
        }
        const consent = await race(this.deps.records.consentOf(entry.workspaceId, entry.appRoot), signal);
        const reason: LaunchConsentCard["reason"] | undefined =
          input.choose && !chooseAsked
            ? "choose"
            : !consent
              ? allowed
                ? "changed"
                : "first"
              : consent.fingerprint !== surface.fingerprint
                ? "changed"
                : willInstall && !consent.installShown
                  ? "install"
                  : undefined;
        if (reason) {
          const card: LaunchConsentCard = {
            kind: "launch",
            chatId: input.chatId,
            workspaceId: entry.workspaceId,
            appRoot: entry.appRoot,
            ...(surface.packageName ? { packageName: surface.packageName } : {}),
            frameworkLabel: frameworkLabel(app.framework),
            reason,
            runCommand: surface.surface.runArgv.join(" "),
            ...(willInstall ? { installCommand: (() => {
              const command = installCommand(app.packageManager);
              return [command.command, ...command.args].join(" ");
            })() } : {}),
            scripts: surface.scripts,
            launchFiles: surface.launchFiles,
            savesChoice: input.choose !== undefined,
          };
          if (input.by === "person") this.deps.consent.forgetDecline(entry.key);
          this.setPhase(entry, "consent");
          const answer = await this.deps.consent.request({ key: entry.key, by: input.by, request: card, ...(input.owner ? { owner: input.owner } : {}), signal });
          if (signal.aborted) throw new Aborted();
          if (answer !== "allow") {
            throw new End({
              problem: answer === "decline" ? "consent-declined" : answer === "unanswered" ? "consent-unanswered" : "consent-unavailable",
            });
          }
          shown = { fingerprint: surface.fingerprint, installShown: willInstall, script: app.script! };
          allowed = true;
          continue;
        }

        // Right before a spawn: the workspace is still there, with the same folder.
        const current = await race(this.deps.workspace(entry.workspaceId), signal);
        if (!current?.path || current.permission === "none") throw new End({ problem: "no-access" });
        if (current.path !== workspacePath) throw new End({ problem: "interrupted" });
        if (input.choose && !saved) {
          saved = true;
          try {
            await race(this.deps.saveConfigApp(workspacePath, { root: entry.appRoot, script: app.script! }, signal), signal);
          } catch (error) {
            if (error instanceof Aborted) throw error;
            this.deps.log?.("design-app-choice-not-saved", { error: String(error) });
          }
        }
        const { env, providerKeys } = this.deps.launchEnv();
        const binDirs = [path.dirname(toolchain.node), path.dirname(toolchain.manager.path)];
        const keys = [...providerKeys];
        const platform = this.deps.platform ?? process.platform;

        if (willInstall) {
          await race(this.deps.records.markInstall(entry.workspaceId, app.installRoot, { state: "started", manager: toolchain.manager.name, lockHash: surface.lockHash }), signal);
          this.setPhase(entry, "installing");
          const command = installCommand(app.packageManager);
          const job = this.spawn(entry, attempt, {
            workspaceId: entry.workspaceId,
            appRoot: entry.appRoot,
            cwd: absolute(workspacePath, app.installRoot),
            argv: { file: toolchain.manager.path, args: command.args },
            display: [command.command, ...command.args].join(" "),
            description: "Install the app's dependencies",
            env: launchEnvironment(env, { binDirs, providerKeys: keys, platform }),
          });
          const ended = await this.waitInstall(job.id, signal);
          if (ended.state !== "exited" || ended.exitCode !== 0) {
            throw new End(
              { problem: "install-failed", exitCode: ended.exitCode ?? null, tail: lastLines(this.deps.jobs.designTail(job.id), TAIL_LINES, TAIL_CHARS) },
              "failed",
            );
          }
          await race(this.deps.records.markInstall(entry.workspaceId, app.installRoot, { state: "done", manager: toolchain.manager.name, lockHash: surface.lockHash }), signal);
          installDone = true;
          continue;
        }

        if (port === undefined || !portChosen) {
          const sticky = port ?? (await race(this.deps.records.portOf(entry.workspaceId, entry.appRoot), signal));
          port = await race(this.deps.choosePort({ ...(sticky !== undefined ? { sticky } : {}), fallback: defaultPort(app.framework) }), signal);
          portChosen = true;
        }
        const script = app.script!;
        const plan = launchPlan(app, { [script]: surface.surface.scripts[`app:${script}`] ?? undefined }, port, env, { binDirs, providerKeys: keys, platform });
        this.setPhase(entry, "starting");
        const job = this.spawn(entry, attempt, {
          workspaceId: entry.workspaceId,
          appRoot: entry.appRoot,
          cwd: absolute(workspacePath, entry.appRoot),
          argv: { file: toolchain.manager.path, args: plan.run.args },
          display: surface.surface.runArgv.join(" "),
          description: "Run the app's dev server",
          env: plan.env,
        });
        const outcome = await this.watchStart(entry, job.id, port, workspacePath, signal);
        if (outcome.kind === "ready") {
          entry.port = outcome.port;
          admission.release();
          await this.deps.records.setPort(entry.workspaceId, entry.appRoot, outcome.port).catch(() => undefined);
          const watch = entry.server;
          if (!watch || watch.jobId !== job.id || !watch.running) {
            // It stopped or crashed while the port was recorded.
            return { ...entry.status };
          }
          this.serve(entry, outcome.port, watch.held);
          const status = this.setPhase(entry, "running", { origin: `http://127.0.0.1:${outcome.port}`, port: outcome.port });
          this.originsChanged();
          report("running");
          return status;
        }
        if (outcome.kind === "problem") {
          await this.deps.jobs.stopDesign(job.id).catch(() => undefined);
          this.clearWatch(entry);
          throw new End(outcome.problem, "failed");
        }
        this.clearWatch(entry);
        const tail = lastLines(this.deps.jobs.designTail(job.id), TAIL_LINES, TAIL_CHARS);
        if (!retried && outcome.view.state !== "stopped" && isAddressInUse(tail)) {
          retried = true;
          port = await race(this.deps.osPort(), signal);
          continue;
        }
        if (outcome.view.state === "stopped") throw new End(undefined);
        throw new End(undefined, "crashed", "crashed", {
          exitCode: outcome.view.exitCode ?? null,
          ...(outcome.view.signal ? { signal: outcome.view.signal } : {}),
          tail,
        });
      }
    } catch (error) {
      if (entry.server && !entry.server.running) this.clearWatch(entry);
      const jobId = attempt.jobId;
      this.jobWaiters.delete(jobId ?? "");
      if (jobId && this.deps.jobs.getDesign(jobId)?.state === "running") await this.deps.jobs.stopDesign(jobId).catch(() => undefined);
      if (error instanceof Aborted || signal.aborted) {
        let problem: DesignAppProblem | undefined;
        if (signal.reason === GATE) {
          const workspace = await this.deps.workspace(entry.workspaceId).catch(() => undefined);
          problem = !workspace?.path || workspace.permission === "none" ? { problem: "no-access" } : { problem: "interrupted" };
        }
        return this.setPhase(entry, "stopped", problem ? { problem } : {});
      }
      if (error instanceof End) {
        if (error.outcome) report(error.outcome);
        return this.setPhase(entry, error.phase, { ...error.extra, ...(error.problem ? { problem: error.problem } : {}) });
      }
      this.deps.log?.("design-app-start-failed", { error: error instanceof Error ? error.name : "unknown" });
      return this.setPhase(entry, "stopped", { problem: { problem: "unavailable" } });
    } finally {
      input.signal?.removeEventListener("abort", callerAbort);
      admission?.release();
    }
  }

  private spawn(entry: Entry, attempt: Attempt, input: StartDesignJobInput): DesignJobView {
    let job: DesignJobView;
    try {
      job = this.deps.jobs.startDesign(input);
    } catch (error) {
      if (error instanceof BackgroundJobLimitError) throw new End({ problem: "job-limit" }, "failed");
      throw error;
    }
    attempt.jobId = job.id;
    entry.lastJobId = job.id;
    return job;
  }

  private waitInstall(jobId: string, signal: AbortSignal): Promise<DesignJobView> {
    return new Promise<DesignJobView>((resolve, reject) => {
      const cleanup = () => {
        this.jobWaiters.delete(jobId);
        this.timers.clear(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Aborted());
      };
      const timer = this.timers.set(() => {
        cleanup();
        void this.deps.jobs
          .stopDesign(jobId)
          .catch(() => undefined)
          .then(() => reject(new End({ problem: "install-timeout" }, "failed")));
      }, this.limits.installTimeoutMs);
      this.jobWaiters.set(jobId, (view) => {
        cleanup();
        resolve(view);
      });
      signal.addEventListener("abort", abort, { once: true });
      const view = this.deps.jobs.getDesign(jobId);
      if (view && view.state !== "running") this.jobWaiters.get(jobId)?.(view);
    });
  }

  /** Waits until the server is ready on a port it holds, exits, or fails its readiness or exposure check (D8, D9). */
  private watchStart(entry: Entry, jobId: string, planned: number, workspacePath: string, signal: AbortSignal): Promise<StartOutcome> {
    return new Promise<StartOutcome>((resolve, reject) => {
      const watch: ServerWatch = { jobId, planned, workspacePath, running: false, failedReads: 0, outputBytes: 0, held: [] };
      entry.server = watch;
      const notReady = () => watch.settle?.({ kind: "problem", problem: { problem: "not-ready", tail: lastLines(this.deps.jobs.designTail(jobId), TAIL_LINES, TAIL_CHARS) } });
      const stopTimers = () => {
        this.timers.clear(watch.idleTimer);
        this.timers.clear(watch.capTimer);
        watch.idleTimer = undefined;
        watch.capTimer = undefined;
        signal.removeEventListener("abort", abort);
        watch.settle = undefined;
      };
      const abort = () => {
        stopTimers();
        reject(new Aborted());
      };
      watch.settle = (outcome) => {
        stopTimers();
        resolve(outcome);
      };
      watch.capTimer = this.timers.set(notReady, this.limits.readyCapMs);
      this.armIdle(watch, notReady);
      signal.addEventListener("abort", abort, { once: true });
      this.ensurePoller();
      const view = this.deps.jobs.getDesign(jobId);
      if (view && view.state !== "running") watch.settle({ kind: "exited", view });
    });
  }

  private armIdle(watch: ServerWatch, fire?: () => void): void {
    const notReady =
      fire ??
      (() =>
        watch.settle?.({
          kind: "problem",
          problem: { problem: "not-ready", tail: lastLines(this.deps.jobs.designTail(watch.jobId), TAIL_LINES, TAIL_CHARS) },
        }));
    this.timers.clear(watch.idleTimer);
    watch.idleTimer = this.timers.set(notReady, this.limits.readyIdleMs);
  }

  // ── Running ──

  private jobChanged(view: DesignJobView): void {
    if (view.state !== "running") this.jobWaiters.get(view.id)?.(view);
    const entry = [...this.entries.values()].find((candidate) => candidate.server?.jobId === view.id);
    const watch = entry?.server;
    if (!entry || !watch) return;
    if (view.state === "running") {
      this.noteOutput(watch, view.outputBytes);
      return;
    }
    if (!watch.running) {
      watch.settle?.({ kind: "exited", view });
      return;
    }
    if (watch.stopping) return;
    const tail = lastLines(this.deps.jobs.designTail(view.id), TAIL_LINES, TAIL_CHARS);
    this.clearWatch(entry);
    if (view.state === "stopped") this.setPhase(entry, "stopped");
    else this.setPhase(entry, "crashed", { exitCode: view.exitCode ?? null, ...(view.signal ? { signal: view.signal } : {}), tail });
    this.originsChanged();
  }

  /** Stops a pending attempt, then the running server. A stop someone asked for leaves no problem. */
  private async halt(entry: Entry, options: { problem?: DesignAppProblem; quiet?: boolean } = {}): Promise<void> {
    const attempt = entry.attempt;
    if (attempt) {
      attempt.controller.abort(STOP);
      await attempt.promise.catch(() => undefined);
    }
    const watch = entry.server;
    if (!watch) return;
    watch.stopping = true;
    await this.deps.jobs.stopDesign(watch.jobId).catch(() => undefined);
    if (entry.server !== watch) return;
    const wasRunning = watch.running;
    this.clearWatch(entry);
    if (!options.quiet) this.setPhase(entry, "stopped", options.problem ? { problem: options.problem } : {});
    if (wasRunning && !options.quiet) this.originsChanged();
  }

  private clearWatch(entry: Entry): void {
    const watch = entry.server;
    if (!watch) return;
    this.timers.clear(watch.idleTimer);
    this.timers.clear(watch.capTimer);
    entry.server = undefined;
    if (!this.watches().length && this.pollTimer !== undefined) {
      this.timers.clear(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private watches(): ServerWatch[] {
    return [...this.entries.values()].flatMap((entry) => (entry.server ? [entry.server] : []));
  }

  private ensurePoller(): void {
    if (this.polling) return;
    const delay = this.watches().some((watch) => !watch.running) ? DESIGN_APP_POLL_STARTING_MS : DESIGN_APP_POLL_RUNNING_MS;
    if (this.pollTimer !== undefined && this.pollDelay <= delay) return;
    if (this.pollTimer !== undefined) this.timers.clear(this.pollTimer);
    this.schedulePoll();
  }

  private schedulePoll(): void {
    this.pollTimer = undefined;
    const watches = this.watches();
    if (!watches.length) return;
    this.pollDelay = watches.some((watch) => !watch.running) ? DESIGN_APP_POLL_STARTING_MS : DESIGN_APP_POLL_RUNNING_MS;
    this.pollTimer = this.timers.set(() => {
      this.pollTimer = undefined;
      void this.tick();
    }, this.pollDelay);
  }

  /** One `designSockets` call for every design job; never overlapping (D9). */
  private async tick(): Promise<void> {
    this.polling = true;
    try {
      const entries = [...this.entries.values()].filter((entry) => entry.server);
      if (!entries.length) return;
      const ids = entries.map((entry) => entry.server!.jobId);
      let results: Map<string, JobSockets>;
      try {
        results = await this.deps.jobs.designSockets(ids);
      } catch {
        results = new Map();
      }
      for (const entry of entries) {
        const watch = entry.server;
        if (!watch || !ids.includes(watch.jobId)) continue;
        await this.checkSockets(entry, watch, results.get(watch.jobId) ?? { ok: false, reason: "not read" });
      }
    } catch (error) {
      this.deps.log?.("design-app-poll-failed", { error: String(error) });
    } finally {
      this.polling = false;
      if (this.pollTimer === undefined) this.schedulePoll();
    }
  }

  /** New output while starting restarts the inactivity timer (D8): a slow compile that keeps logging isn't stopped. */
  private noteOutput(watch: ServerWatch, outputBytes: number | undefined): void {
    if (watch.running || outputBytes === undefined || outputBytes === watch.outputBytes) return;
    watch.outputBytes = outputBytes;
    if (watch.settle) this.armIdle(watch);
  }

  private async checkSockets(entry: Entry, watch: ServerWatch, result: JobSockets): Promise<void> {
    // Output is no job change event, so each tick reads how much there is.
    this.noteOutput(watch, this.deps.jobs.getDesign(watch.jobId)?.outputBytes);
    if (!result.ok) {
      // A failed read never marks a server ready; three in a row stop a running one.
      if (watch.running && ++watch.failedReads >= DESIGN_APP_EXPOSURE_FAILURES) await this.halt(entry, { problem: { problem: "exposure-unknown" } });
      return;
    }
    watch.failedReads = 0;
    if (exposedSockets(result.sockets).length > 0) {
      if (watch.running) await this.halt(entry, { problem: { problem: "exposed" } });
      else watch.settle?.({ kind: "problem", problem: { problem: "exposed" } });
      return;
    }
    watch.held = result.sockets.map((socket) => ({ address: socket.address, port: socket.port }));
    if (!watch.running) {
      const owned = result.sockets.filter((socket) => isIpv4Loopback(socket.address)).map((socket) => socket.port);
      const port = readyPort({ owned, printed: printedPorts(this.deps.jobs.designTail(watch.jobId)), planned: watch.planned });
      if (port !== undefined && watch.settle) {
        watch.running = true;
        watch.settle({ kind: "ready", port });
      }
      return;
    }
    if (entry.status.port !== undefined) this.serve(entry, entry.status.port, watch.held);
    const workspace = await this.deps.workspace(entry.workspaceId).catch(() => undefined);
    if (entry.server !== watch) return;
    if (!workspace?.path || workspace.permission === "none") await this.halt(entry, { problem: { problem: "no-access" } });
    else if (workspace.path !== watch.workspacePath) await this.halt(entry, { problem: { problem: "interrupted" } });
  }

  /** Every origin this session served stays an app origin until the workspace is forgotten (3a). */
  private serve(entry: Entry, port: number, held: ReadonlyArray<{ address: string; port: number }>): void {
    const origins = this.served.get(entry.workspaceId) ?? new Set<string>();
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
    if (held.some((socket) => socket.port === port && socket.address === "::1")) origins.add(`http://[::1]:${port}`);
    this.served.set(entry.workspaceId, origins);
  }

  // ── Presence (D12) ──

  private presence(workspaceId: string, count: number): void {
    if (count > 0) {
      this.clearPresence(workspaceId);
      return;
    }
    if (this.activeIn(workspaceId)) this.armPresence(workspaceId);
  }

  private activeIn(workspaceId: string): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.workspaceId === workspaceId && (entry.attempt !== undefined || entry.server !== undefined),
    );
  }

  private armPresence(workspaceId: string): void {
    if (this.presenceTimers.has(workspaceId)) return;
    this.presenceTimers.set(
      workspaceId,
      this.timers.set(() => {
        this.presenceTimers.delete(workspaceId);
        if (this.deps.views.visible(workspaceId) > 0) return;
        for (const entry of [...this.entries.values()]) {
          if (entry.workspaceId === workspaceId && (entry.attempt || entry.server)) void this.stop(workspaceId, entry.appRoot);
        }
      }, this.limits.graceMs),
    );
  }

  private clearPresence(workspaceId: string): void {
    const timer = this.presenceTimers.get(workspaceId);
    if (timer === undefined) return;
    this.timers.clear(timer);
    this.presenceTimers.delete(workspaceId);
  }

  // ── Detection and status ──

  private async detectFor(workspaceId: string, workspacePath: string) {
    const [detection, config] = await Promise.all([this.deps.detect(workspacePath), this.deps.readConfig(workspacePath).catch(() => null)]);
    const cached = { detection, config };
    this.cache.set(workspaceId, cached);
    return cached;
  }

  /** A web candidate at `appRoot` with a script it may run: the choice's, else a configured one, else 2a's pick. */
  private resolveApp(detection: WebAppDetection, config: CanvasConfig | null, appRoot: string, chosen?: string): DetectedApp | undefined {
    const app = detection.apps.find((candidate) => candidate.root === appRoot && candidate.kind === "web");
    if (!app) return undefined;
    const runnable = (script: string | undefined): script is string => !!script && isSafeScriptName(script) && app.scripts.includes(script);
    if (chosen !== undefined) return runnable(chosen) ? { ...app, script: chosen } : undefined;
    const configured = config?.apps.find((entry) => entry.root === appRoot && runnable(entry.script))?.script;
    const script = configured ?? app.script;
    return runnable(script) ? { ...app, script } : undefined;
  }

  /** D4: the configured roots with a script they may run, else the single web app, else nothing. */
  private toggleRoots(detection: WebAppDetection, config: CanvasConfig | null): string[] {
    const configured = configuredRoots(config, detection);
    if (configured.length > 0) {
      return configured.filter((root) => {
        const entry = config?.apps.find((candidate) => candidate.root === root && candidate.script);
        return entry?.script !== undefined && this.resolveApp(detection, null, root, entry.script) !== undefined;
      });
    }
    const target = designTarget(detection);
    return target.kind === "single" && this.resolveApp(detection, config, target.app.root) ? [target.app.root] : [];
  }

  private setPhase(entry: Entry, phase: DesignAppPhase, extra: Partial<DesignAppStatus> = {}): DesignAppStatus {
    entry.status = {
      workspaceId: entry.workspaceId,
      appRoot: entry.appRoot,
      source: "started",
      ...(entry.meta.framework ? { framework: entry.meta.framework } : {}),
      frameworkLabel: entry.meta.frameworkLabel,
      ...(entry.meta.manager ? { manager: entry.meta.manager } : {}),
      ...(entry.meta.script ? { script: entry.meta.script } : {}),
      ...(entry.meta.startedBy ? { startedBy: entry.meta.startedBy } : {}),
      phase,
      since: this.now(),
      revision: entry.status.revision + 1,
      ...extra,
    };
    if (phase === "starting" && this.deps.views.visible(entry.workspaceId) === 0) this.armPresence(entry.workspaceId);
    this.emit(entry.workspaceId);
    return { ...entry.status };
  }

  private snapshotNow(workspaceId: string): DesignAppsSnapshot {
    const cached = this.cache.get(workspaceId);
    const known = [...this.entries.values()].filter((entry) => entry.workspaceId === workspaceId);
    const apps = known.map((entry) => ({ ...entry.status }));
    const target: DesignAppsSnapshot["target"] = !this.available() ? "unavailable" : cached ? designTarget(cached.detection).kind : "none";
    const candidates: DesignAppCandidate[] = [];
    let chosen: string[] = [];
    if (cached) {
      for (const app of cached.detection.apps) {
        if (app.kind !== "web") continue;
        candidates.push({
          appRoot: app.root,
          ...(app.framework ? { framework: app.framework } : {}),
          frameworkLabel: frameworkLabel(app.framework),
          ...(app.script ? { script: app.script } : {}),
          ...(app.name ? { name: app.name } : {}),
        });
      }
      chosen = configuredRoots(cached.config, cached.detection);
      for (const root of this.toggleRoots(cached.detection, cached.config)) {
        if (known.some((entry) => entry.appRoot === root)) continue;
        apps.push(this.blankStatus(workspaceId, root, this.resolveApp(cached.detection, cached.config, root)));
      }
    }
    return { workspaceId, target, apps, candidates, chosen };
  }

  private emit(workspaceId: string): void {
    if (!this.statusListeners.size) return;
    const snapshot = this.snapshotNow(workspaceId);
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.deps.log?.("design-app-status-listener-failed", { error: String(error) });
      }
    }
  }

  private originsChanged(): void {
    for (const listener of this.originListeners) {
      try {
        listener();
      } catch (error) {
        this.deps.log?.("design-app-origins-listener-failed", { error: String(error) });
      }
    }
  }

  private parseOrigin(origin: string): URL | undefined {
    if (typeof origin !== "string" || origin.length > 256) return undefined;
    try {
      const url = new URL(origin);
      return url.origin === origin ? url : undefined;
    } catch {
      return undefined;
    }
  }
}

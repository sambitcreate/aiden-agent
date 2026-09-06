import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import * as fs from "node:fs/promises";
import { get as httpGet } from "node:http";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import {
  aidenTailscaleCanonicalRouteSnapshot,
  aidenTailscaleHealthEndpoint,
  classifyAidenTailscaleRoute,
  planAidenTailscaleConnect,
  planAidenTailscaleDisconnect,
  type AidenTailscaleOwnership,
  type AidenTailscaleStatus,
} from "./aiden-remote-tailscale-route.js";
import { isTailscalePermissionDeniedError } from "./aiden-remote-desktop-errors.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
] as const;
const MAX_STATUS_BYTES = 256 * 1_024;
const MAX_HEALTH_BYTES = 1_024;
const HEALTH_TIMEOUT_MS = 800;
const TAKEOVER_REVIEW_TTL_MS = 30_000;
const MAX_TAKEOVER_REVIEWS = 16;
const ROUTE_LOCK_ATTEMPTS = 20;
const ROUTE_LOCK_RETRY_MS = 50;
const ROUTE_LOCK_PORT = 49_191;
const POST_MUTATION_STATUS_ATTEMPTS = 3;
const POST_MUTATION_STATUS_RETRY_MS = 50;
const STATUS_READ_ATTEMPTS = 3;
const STATUS_READ_RETRY_MS = 75;

export interface AidenTailscaleCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

export type AidenTailscaleStatusReadFailureCategory =
  | "command-failed"
  | "invalid-response"
  | "timed-out";

export type AidenTailscaleCommandExecutor = (
  binary: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string }>;

export interface AidenTailscaleSystemRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  execute?: AidenTailscaleCommandExecutor;
  resolveBinary?: () => Promise<string | null>;
}

export interface AidenTailscaleConnectionStatus {
  installed: boolean;
  dnsName?: string;
  httpsAvailable?: boolean;
  serveStatus?: AidenTailscaleStatus;
  errorCode?: "not_installed" | "not_connected" | "https_unavailable" | "status_unavailable";
}

export type AidenTailscaleRouteState =
  | "available"
  | "owned"
  | "other_aiden_live"
  | "other_aiden_stale"
  | "unrelated_conflict"
  | "funnel_conflict"
  | "reconciliation_required"
  | "unavailable";

export interface AidenTailscalePendingRouteOutcome {
  operation: "connect" | "takeover" | "disconnect";
  target: string;
  previousTarget?: string;
  beforeFingerprint: string;
  preservedFingerprint: string;
  normalizeListenerScaffolding: boolean;
  createdAt: number;
}

export interface AidenTailscaleOutcomeStore {
  begin(outcome: AidenTailscalePendingRouteOutcome): Promise<void>;
  snapshot(): Promise<AidenTailscalePendingRouteOutcome | undefined>;
  commit(ownership: AidenTailscaleOwnership | undefined): Promise<void>;
  clear(): Promise<void>;
}

export interface AidenTailscaleRouteAssessment {
  state: AidenTailscaleRouteState;
  errorCode?: AidenTailscaleConnectionStatus["errorCode"];
}

export interface AidenTailscaleRouteInspection {
  connectionStatus: AidenTailscaleConnectionStatus;
  assessment: AidenTailscaleRouteAssessment;
}

export interface AidenTailscaleTakeoverReview {
  token: string;
  expiresAt: number;
}

interface AidenTailscaleTakeoverRecord {
  target: string;
  incumbentTarget: string;
  serveFingerprint: string;
  monotonicExpiresAt: number;
}

export interface AidenRemoteTailscaleControllerOptions {
  now?: () => number;
  monotonicNow?: () => number;
  probeHealth?: (target: string) => Promise<boolean>;
  randomToken?: () => string;
  withRouteLock?: <T>(action: () => Promise<T>) => Promise<T>;
  outcomeStore?: AidenTailscaleOutcomeStore;
  onStatusReadFailure?: (input: {
    phase: "node" | "serve";
    attempt: number;
    final: boolean;
    category: AidenTailscaleStatusReadFailureCategory;
  }) => void;
}

export interface AidenTailscaleRouteLockOptions {
  port?: number;
  attempts?: number;
  retryMs?: number;
}

interface AidenTailscaleNodeStatus {
  dnsName?: string;
  httpsAvailable: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBoundedJson(serialized: string, label: string): unknown {
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATUS_BYTES) {
    throw new Error("tailscale_status_invalid_response");
  }
  try {
    return parseAidenRemoteJson(serialized, label);
  } catch {
    throw new Error("tailscale_status_invalid_response");
  }
}

function normalizeDnsName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const dnsName = value.trim().replace(/\.$/u, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(dnsName)
    ? dnsName
    : undefined;
}

function parseNodeStatus(serialized: string): AidenTailscaleNodeStatus {
  const root = record(parseBoundedJson(serialized, "Tailscale status"));
  const self = record(root?.Self);
  const dnsName = normalizeDnsName(self?.DNSName);
  const certDomains = Array.isArray(root?.CertDomains)
    ? root.CertDomains.map(normalizeDnsName).filter((value): value is string => value !== undefined)
    : [];
  return {
    ...(dnsName ? { dnsName } : {}),
    // An exact certificate-domain match proves that the tailnet owner has
    // already enabled HTTPS. Aiden never follows or accepts Tailscale's
    // interactive authorization flow on the owner's behalf.
    httpsAvailable: dnsName !== undefined && certDomains.includes(dnsName),
  };
}

function parseServeStatus(serialized: string): AidenTailscaleStatus {
  const value = parseBoundedJson(serialized, "Tailscale Serve status");
  if (!record(value)) throw new Error("tailscale_status_invalid_response");
  return value as AidenTailscaleStatus;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function serveFingerprint(status: AidenTailscaleStatus): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(status)), "utf8")
    .digest("hex");
}

function preservedServeFingerprint(status: AidenTailscaleStatus): string {
  return serveFingerprint(aidenTailscaleCanonicalRouteSnapshot(status).preservedStatus);
}

function preservedServeFingerprintForListenerTransition(status: AidenTailscaleStatus): string {
  const preservedStatus = structuredClone(
    aidenTailscaleCanonicalRouteSnapshot(status).preservedStatus,
  );
  const tcp443 = preservedStatus.TCP?.["443"];
  if (
    preservedStatus.Web === undefined
    && tcp443?.HTTPS === true
    && Object.keys(tcp443).length === 1
    && Object.keys(preservedStatus.TCP ?? {}).length === 1
    && Object.keys(preservedStatus).every((key) => key === "TCP")
  ) {
    delete preservedStatus.TCP;
  }
  return serveFingerprint(preservedStatus);
}

function permitsHttpsListenerScaffoldingChange(
  before: AidenTailscaleStatus,
  nextTarget: string | undefined,
): boolean {
  const snapshot = aidenTailscaleCanonicalRouteSnapshot(before);
  if (nextTarget !== undefined) {
    return snapshot.target === undefined
      && before.TCP?.["443"] === undefined
      && Object.keys(snapshot.preservedStatus).length === 0;
  }
  return snapshot.target !== undefined
    && preservedServeFingerprintForListenerTransition(before)
      === serveFingerprint({});
}

async function probeLoopbackHealth(target: string): Promise<boolean> {
  const endpoint = aidenTailscaleHealthEndpoint(target);
  return new Promise((resolve) => {
    let settled = false;
    let request: ReturnType<typeof httpGet> | undefined;
    const deadline = setTimeout(() => {
      request?.destroy();
      finish(false);
    }, HEALTH_TIMEOUT_MS);
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(healthy);
    };
    request = httpGet(endpoint, {
      headers: { accept: "application/json", connection: "close" },
      timeout: HEALTH_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_HEALTH_BYTES) {
          request?.destroy();
          finish(false);
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return finish(false);
        try {
          const parsed = parseAidenRemoteJson(Buffer.concat(chunks).toString("utf8"), "Aiden health response");
          const health = record(parsed);
          finish(
            health?.ok === true
            && health.protocolVersion === 1
            && Object.keys(health).length === 2,
          );
        } catch {
          finish(false);
        }
      });
      response.once("aborted", () => finish(false));
      response.once("error", () => finish(false));
    });
    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
  });
}

export async function withAidenTailscaleRouteLock<T>(
  action: () => Promise<T>,
  options: AidenTailscaleRouteLockOptions = {},
): Promise<T> {
  const port = options.port ?? ROUTE_LOCK_PORT;
  const attempts = options.attempts ?? ROUTE_LOCK_ATTEMPTS;
  const retryMs = options.retryMs ?? ROUTE_LOCK_RETRY_MS;
  let lockSocket: ReturnType<typeof createSocket> | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // The UDP namespace cannot collide with Aiden's retained TCP listener
    // ports, while the kernel still releases this process-owned mutex on exit.
    const candidate = createSocket({ type: "udp4", reuseAddr: false });
    candidate.unref();
    const acquired = await new Promise<boolean>((resolve, reject) => {
      candidate.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      candidate.bind({ address: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (acquired) {
      lockSocket = candidate;
      break;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  if (!lockSocket) throw new Error("tailscale_route_busy");
  try {
    return await action();
  } finally {
    await new Promise<void>((resolve) => lockSocket?.close(() => resolve()));
  }
}

export async function resolveTailscaleBinary(): Promise<string | null> {
  for (const candidate of TAILSCALE_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through fixed, trusted installation locations.
    }
  }
  return null;
}

export async function createSystemTailscaleCommandRunner(
  options: AidenTailscaleSystemRunnerOptions = {},
): Promise<AidenTailscaleCommandRunner | null> {
  const binary = await (options.resolveBinary ?? resolveTailscaleBinary)();
  if (!binary) return null;
  const execute = options.execute ?? (async (command, args, execOptions) => {
    const { stdout } = await execFileAsync(command, [...args], execOptions);
    return { stdout };
  });
  const environment = options.environment ?? process.env;
  return {
    run: async (args) => {
      const { stdout } = await execute(binary, args, {
        encoding: "utf8",
        env: {
          ...environment,
          // Tailscale's macOS app and CLI share one executable. Finder-launched
          // apps do not inherit TERM/SHLVL, so force the documented CLI mode
          // instead of relying on Tailscale's terminal-environment heuristic.
          TAILSCALE_BE_CLI: "1",
        },
        maxBuffer: MAX_STATUS_BYTES,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout;
    },
  };
}

function statusReadFailureCategory(error: unknown): AidenTailscaleStatusReadFailureCategory {
  if (error instanceof Error && error.message === "tailscale_status_invalid_response") {
    return "invalid-response";
  }
  const details = error !== null && typeof error === "object"
    ? error as { code?: unknown; killed?: unknown }
    : undefined;
  if (details?.code === "ETIMEDOUT" || details?.killed === true) return "timed-out";
  return "command-failed";
}

export class AidenRemoteTailscaleController {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly probeHealth: (target: string) => Promise<boolean>;
  private readonly randomToken: () => string;
  private readonly withRouteLock: <T>(action: () => Promise<T>) => Promise<T>;
  private readonly outcomeStore?: AidenTailscaleOutcomeStore;
  private readonly onStatusReadFailure?: AidenRemoteTailscaleControllerOptions["onStatusReadFailure"];
  private readonly takeoverReviews = new Map<string, AidenTailscaleTakeoverRecord>();
  private connectionStatusRead: Promise<AidenTailscaleConnectionStatus> | null = null;

  constructor(
    private readonly runner: AidenTailscaleCommandRunner | null,
    options: AidenRemoteTailscaleControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.probeHealth = options.probeHealth ?? probeLoopbackHealth;
    this.randomToken = options.randomToken ?? (() => randomBytes(24).toString("base64url"));
    this.withRouteLock = options.withRouteLock
      ?? ((action) => withAidenTailscaleRouteLock(action));
    this.outcomeStore = options.outcomeStore;
    this.onStatusReadFailure = options.onStatusReadFailure;
  }

  private async serveStatus(): Promise<AidenTailscaleStatus> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    return parseServeStatus(await this.runner.run(["serve", "status", "--json"]));
  }

  private async nodeStatus(): Promise<AidenTailscaleNodeStatus> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    // Peer inventory is irrelevant to Serve ownership and can be large and
    // volatile on busy tailnets. Request only this node's bounded status.
    return parseNodeStatus(await this.runner.run(["status", "--json", "--peers=false"]));
  }

  private connectionStatus(
    nodeStatus: AidenTailscaleNodeStatus,
    serveStatus: AidenTailscaleStatus,
  ): AidenTailscaleConnectionStatus {
    const errorCode = !nodeStatus.dnsName
      ? "not_connected" as const
      : !nodeStatus.httpsAvailable
        ? "https_unavailable" as const
        : undefined;
    return {
      installed: true,
      ...(nodeStatus.dnsName ? { dnsName: nodeStatus.dnsName } : {}),
      httpsAvailable: nodeStatus.httpsAvailable,
      ...(errorCode ? { errorCode } : {}),
      serveStatus,
    };
  }

  private async readConnectionStatusWithRetry(): Promise<AidenTailscaleConnectionStatus> {
    for (let attempt = 1; attempt <= STATUS_READ_ATTEMPTS; attempt += 1) {
      let phase: "node" | "serve" = "node";
      try {
        const nodeStatus = await this.nodeStatus();
        phase = "serve";
        const serveStatus = await this.serveStatus();
        return this.connectionStatus(nodeStatus, serveStatus);
      } catch (error) {
        try {
          this.onStatusReadFailure?.({
            phase,
            attempt,
            final: attempt === STATUS_READ_ATTEMPTS,
            category: statusReadFailureCategory(error),
          });
        } catch {
          // Diagnostics must never change the fail-closed inspection result.
        }
        if (attempt < STATUS_READ_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, STATUS_READ_RETRY_MS));
        }
      }
    }
    throw new Error("tailscale_status_unavailable");
  }

  private async readConnectionStatus(): Promise<AidenTailscaleConnectionStatus> {
    if (this.connectionStatusRead) return this.connectionStatusRead;
    const read = this.readConnectionStatusWithRetry();
    this.connectionStatusRead = read;
    try {
      return await read;
    } finally {
      if (this.connectionStatusRead === read) this.connectionStatusRead = null;
    }
  }

  async status(): Promise<AidenTailscaleConnectionStatus> {
    if (!this.runner) return { installed: false, errorCode: "not_installed" };
    try {
      return await this.readConnectionStatus();
    } catch {
      return { installed: true, errorCode: "status_unavailable" };
    }
  }

  private async nodeAndServeStatus(): Promise<{
    nodeStatus: AidenTailscaleNodeStatus;
    serveStatus: AidenTailscaleStatus;
  }> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    const nodeStatus = await this.nodeStatus();
    const serveStatus = await this.serveStatus();
    if (!nodeStatus.dnsName) throw new Error("tailscale_not_connected");
    if (!nodeStatus.httpsAvailable) throw new Error("tailscale_https_unavailable");
    return { nodeStatus, serveStatus };
  }

  private async assessmentFromStatus(
    serveStatus: AidenTailscaleStatus,
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<AidenTailscaleRouteAssessment> {
    const classification = classifyAidenTailscaleRoute(serveStatus, target, ownership);
    if (classification.kind === "other_aiden") {
      return {
        state: await this.probeHealth(classification.target)
          ? "other_aiden_live"
          : "other_aiden_stale",
      };
    }
    return { state: classification.kind };
  }

  async assessRoute(
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<AidenTailscaleRouteAssessment> {
    if (!this.runner) return { state: "unavailable", errorCode: "not_installed" };
    try {
      const connectionStatus = await this.readConnectionStatus();
      const serveStatus = connectionStatus.serveStatus;
      if (!serveStatus) throw new Error("tailscale_status_invalid");
      const classification = classifyAidenTailscaleRoute(serveStatus, target, ownership);
      const errorCode = connectionStatus.errorCode;
      if (classification.kind === "owned") {
        return { state: "owned", ...(errorCode ? { errorCode } : {}) };
      }
      if (errorCode) return { state: "unavailable", errorCode };
      return this.assessmentFromStatus(serveStatus, target, ownership);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      return {
        state: "unavailable",
        errorCode: code === "tailscale_not_connected"
          ? "not_connected"
          : code === "tailscale_https_unavailable"
            ? "https_unavailable"
            : "status_unavailable",
      };
    }
  }

  /**
   * Read node identity, HTTPS eligibility, Serve state, and route ownership as
   * one coherent snapshot. Settings must not combine independent CLI reads.
   */
  async inspectRoute(
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<AidenTailscaleRouteInspection> {
    if (!this.runner) {
      const errorCode = "not_installed" as const;
      return {
        connectionStatus: { installed: false, errorCode },
        assessment: { state: "unavailable", errorCode },
      };
    }
    try {
      const connectionStatus = await this.readConnectionStatus();
      const serveStatus = connectionStatus.serveStatus;
      if (!serveStatus) throw new Error("tailscale_status_invalid");
      const classification = classifyAidenTailscaleRoute(serveStatus, target, ownership);
      const errorCode = connectionStatus.errorCode;
      let assessment: AidenTailscaleRouteAssessment;
      if (classification.kind === "owned") {
        assessment = { state: "owned", ...(errorCode ? { errorCode } : {}) };
      } else if (errorCode) {
        assessment = { state: "unavailable", errorCode };
      } else {
        assessment = await this.assessmentFromStatus(serveStatus, target, ownership);
      }
      return { connectionStatus, assessment };
    } catch {
      const errorCode = "status_unavailable" as const;
      return {
        connectionStatus: { installed: true, errorCode },
        assessment: { state: "unavailable", errorCode },
      };
    }
  }

  private async setExactRoute(target: string): Promise<void> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    await this.runner.run([
      "serve", "--yes", "--bg", "--https=443",
      `--set-path=/api/aiden/v1`, target,
    ]);
  }

  private async clearExactRoute(): Promise<void> {
    if (!this.runner) throw new Error("tailscale_not_installed");
    await this.runner.run([
      "serve", "--https=443", `--set-path=/api/aiden/v1`, "off",
    ]);
  }

  private async conditionalRecoverRoute(
    expectedCurrentFingerprint: string,
    expectedCurrentTarget: string | undefined,
    previousTarget: string | undefined,
  ): Promise<void> {
    const current = await this.serveStatusAfterMutation("tailscale_route_recovery_failed");
    const currentSnapshot = aidenTailscaleCanonicalRouteSnapshot(current);
    if (
      serveFingerprint(current) !== expectedCurrentFingerprint
      || currentSnapshot.funnel
      || currentSnapshot.target !== expectedCurrentTarget
    ) {
      throw new Error("tailscale_route_recovery_failed");
    }
    const permitsScaffoldingChange = permitsHttpsListenerScaffoldingChange(
      current,
      previousTarget,
    );
    const preserved = permitsScaffoldingChange
      ? preservedServeFingerprintForListenerTransition(current)
      : preservedServeFingerprint(current);
    try {
      if (previousTarget) await this.setExactRoute(previousTarget);
      else await this.clearExactRoute();
    } catch {
      // Reconcile below: the CLI may fail after the daemon applied the route.
    }
    const recovered = await this.serveStatusAfterMutation("tailscale_route_recovery_failed");
    const recoveredSnapshot = aidenTailscaleCanonicalRouteSnapshot(recovered);
    if (
      recoveredSnapshot.funnel
      || recoveredSnapshot.target !== previousTarget
      || (previousTarget !== undefined && recovered.TCP?.["443"]?.HTTPS !== true)
      || (permitsScaffoldingChange
        ? preservedServeFingerprintForListenerTransition(recovered)
        : preservedServeFingerprint(recovered)) !== preserved
    ) {
      throw new Error("tailscale_route_recovery_failed");
    }
  }

  private async serveStatusAfterMutation(failureCode: string): Promise<AidenTailscaleStatus> {
    for (let attempt = 0; attempt < POST_MUTATION_STATUS_ATTEMPTS; attempt += 1) {
      try {
        return await this.serveStatus();
      } catch {
        if (attempt + 1 < POST_MUTATION_STATUS_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, POST_MUTATION_STATUS_RETRY_MS));
        }
      }
    }
    throw new Error(failureCode);
  }

  private async applyExactRouteMutation(
    before: AidenTailscaleStatus,
    nextTarget: string | undefined,
    operation: AidenTailscalePendingRouteOutcome["operation"],
  ): Promise<string> {
    const beforeSnapshot = aidenTailscaleCanonicalRouteSnapshot(before);
    const permitsScaffoldingChange = permitsHttpsListenerScaffoldingChange(before, nextTarget);
    const preserved = permitsScaffoldingChange
      ? preservedServeFingerprintForListenerTransition(before)
      : preservedServeFingerprint(before);
    await this.outcomeStore?.begin({
      operation,
      target: nextTarget ?? beforeSnapshot.target ?? "",
      ...(beforeSnapshot.target ? { previousTarget: beforeSnapshot.target } : {}),
      beforeFingerprint: serveFingerprint(before),
      preservedFingerprint: preserved,
      normalizeListenerScaffolding: permitsScaffoldingChange,
      createdAt: this.now(),
    });
    let commandError: unknown;
    try {
      if (nextTarget) await this.setExactRoute(nextTarget);
      else await this.clearExactRoute();
    } catch (error) {
      commandError = error;
    }
    const observed = await this.serveStatusAfterMutation("tailscale_route_outcome_unknown");
    const observedSnapshot = aidenTailscaleCanonicalRouteSnapshot(observed);
    const observedFingerprint = serveFingerprint(observed);
    if (
      observedSnapshot.funnel
      || observedSnapshot.target !== nextTarget
      || (nextTarget !== undefined && observed.TCP?.["443"]?.HTTPS !== true)
      || (permitsScaffoldingChange
        ? preservedServeFingerprintForListenerTransition(observed)
        : preservedServeFingerprint(observed)) !== preserved
    ) {
      if (!observedSnapshot.funnel && observedSnapshot.target === nextTarget) {
        try {
          await this.conditionalRecoverRoute(
            observedFingerprint,
            nextTarget,
            beforeSnapshot.target,
          );
        } catch {
          throw new Error("tailscale_route_recovery_failed");
        }
        await this.outcomeStore?.clear();
      } else if (observedFingerprint === serveFingerprint(before)) {
        await this.outcomeStore?.clear();
        if (commandError && isTailscalePermissionDeniedError(commandError)) {
          throw new Error("tailscale_permission_denied");
        }
      }
      throw new Error(commandError
        ? "tailscale_route_outcome_unknown"
        : "tailscale_route_verification_failed");
    }
    return observedFingerprint;
  }

  async connect(
    target: string,
    ownership?: AidenTailscaleOwnership,
    persistOwnership?: (ownership: AidenTailscaleOwnership) => Promise<void>,
  ): Promise<AidenTailscaleOwnership> {
    return this.withRouteLock(async () => {
      const { nodeStatus, serveStatus } = await this.nodeAndServeStatus();
      const plan = planAidenTailscaleConnect(
        serveStatus,
        target,
        ownership,
        nodeStatus.httpsAvailable,
      );
      let committedRouteFingerprint = serveFingerprint(serveStatus);
      if (plan.action === "set") {
        committedRouteFingerprint = await this.applyExactRouteMutation(serveStatus, target, "connect");
      }
      if (persistOwnership) {
        try {
          await persistOwnership(plan.ownership);
        } catch {
          if (plan.action === "set") {
            try {
              await this.conditionalRecoverRoute(
                committedRouteFingerprint,
                target,
                undefined,
              );
            } catch {
              throw new Error("tailscale_route_recovery_failed");
            }
            await this.outcomeStore?.clear();
          }
          throw new Error("tailscale_ownership_commit_failed");
        }
      }
      return plan.ownership;
    });
  }

  async reviewTakeover(
    target: string,
    ownership?: AidenTailscaleOwnership,
  ): Promise<AidenTailscaleTakeoverReview> {
    const { serveStatus } = await this.nodeAndServeStatus();
    const classification = classifyAidenTailscaleRoute(serveStatus, target, ownership);
    if (classification.kind !== "other_aiden") {
      throw new Error("tailscale_takeover_unavailable");
    }
    if (await this.probeHealth(classification.target)) {
      throw new Error("tailscale_route_live");
    }
    const now = this.now();
    const monotonicNow = this.monotonicNow();
    for (const [token, review] of this.takeoverReviews) {
      if (review.monotonicExpiresAt <= monotonicNow) this.takeoverReviews.delete(token);
    }
    while (this.takeoverReviews.size >= MAX_TAKEOVER_REVIEWS) {
      const oldest = this.takeoverReviews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.takeoverReviews.delete(oldest);
    }
    let token = this.randomToken();
    for (let attempt = 0; this.takeoverReviews.has(token) && attempt < 4; attempt += 1) {
      token = this.randomToken();
    }
    if (!/^[A-Za-z0-9_-]{32}$/u.test(token) || this.takeoverReviews.has(token)) {
      throw new Error("tailscale_takeover_token_failed");
    }
    const expiresAt = now + TAKEOVER_REVIEW_TTL_MS;
    this.takeoverReviews.set(token, {
      target,
      incumbentTarget: classification.target,
      serveFingerprint: serveFingerprint(serveStatus),
      monotonicExpiresAt: monotonicNow + TAKEOVER_REVIEW_TTL_MS,
    });
    return { token, expiresAt };
  }

  async takeOver(
    target: string,
    token: string,
    persistOwnership: (ownership: AidenTailscaleOwnership) => Promise<void>,
  ): Promise<AidenTailscaleOwnership> {
    return this.withRouteLock(async () => {
      const review = this.takeoverReviews.get(token);
      this.takeoverReviews.delete(token);
      if (!review || review.target !== target || review.monotonicExpiresAt <= this.monotonicNow()) {
        throw new Error("tailscale_takeover_expired");
      }
      const { serveStatus } = await this.nodeAndServeStatus();
      if (serveFingerprint(serveStatus) !== review.serveFingerprint) {
        throw new Error("tailscale_takeover_changed");
      }
      const classification = classifyAidenTailscaleRoute(serveStatus, target);
      if (
        classification.kind !== "other_aiden"
        || classification.target !== review.incumbentTarget
      ) {
        throw new Error("tailscale_takeover_changed");
      }
      if (await this.probeHealth(classification.target)) {
        throw new Error("tailscale_route_live");
      }
      const immediateStatus = await this.serveStatus();
      if (serveFingerprint(immediateStatus) !== review.serveFingerprint) {
        throw new Error("tailscale_takeover_changed");
      }
      const immediateClassification = classifyAidenTailscaleRoute(immediateStatus, target);
      if (
        immediateClassification.kind !== "other_aiden"
        || immediateClassification.target !== review.incumbentTarget
      ) {
        throw new Error("tailscale_takeover_changed");
      }
      const nextOwnership = { path: "/api/aiden/v1", target } as const;
      const committedRouteFingerprint = await this.applyExactRouteMutation(
        immediateStatus,
        target,
        "takeover",
      );
      try {
        await persistOwnership(nextOwnership);
      } catch {
        try {
          await this.conditionalRecoverRoute(
            committedRouteFingerprint,
            target,
            review.incumbentTarget,
          );
        } catch {
          throw new Error("tailscale_route_recovery_failed");
        }
        await this.outcomeStore?.clear();
        throw new Error("tailscale_ownership_commit_failed");
      }
      return nextOwnership;
    });
  }

  async disconnect(
    target: string,
    ownership?: AidenTailscaleOwnership,
    clearOwnership?: () => Promise<void>,
  ): Promise<void> {
    await this.withRouteLock(async () => {
      if (!this.runner) throw new Error("tailscale_not_installed");
      const serveStatus = await this.serveStatus();
      const plan = planAidenTailscaleDisconnect(serveStatus, target, ownership);
      let committedRouteFingerprint = serveFingerprint(serveStatus);
      if (plan.action === "clear") {
        committedRouteFingerprint = await this.applyExactRouteMutation(serveStatus, undefined, "disconnect");
      }
      if (clearOwnership) {
        try {
          await clearOwnership();
        } catch {
          if (plan.action === "clear") {
            try {
              await this.conditionalRecoverRoute(
                committedRouteFingerprint,
                undefined,
                target,
              );
            } catch {
              throw new Error("tailscale_route_recovery_failed");
            }
            await this.outcomeStore?.clear();
          }
          throw new Error("tailscale_ownership_commit_failed");
        }
      }
    });
  }

  async reconcilePendingOutcome(): Promise<"connected" | "disconnected" | "not_applied"> {
    return this.withRouteLock(async () => {
      const pending = await this.outcomeStore?.snapshot();
      if (!pending || !this.outcomeStore) throw new Error("tailscale_reconciliation_unavailable");
      const status = await this.serveStatus();
      if (serveFingerprint(status) === pending.beforeFingerprint) {
        const confirmed = await this.serveStatus();
        if (serveFingerprint(confirmed) !== pending.beforeFingerprint) {
          throw new Error("tailscale_reconciliation_conflict");
        }
        await this.outcomeStore.clear();
        return "not_applied";
      }
      const snapshot = aidenTailscaleCanonicalRouteSnapshot(status);
      const expectedTarget = pending.operation === "disconnect" ? undefined : pending.target;
      const preserved = pending.normalizeListenerScaffolding
        ? preservedServeFingerprintForListenerTransition(status)
        : preservedServeFingerprint(status);
      if (
        snapshot.funnel
        || snapshot.target !== expectedTarget
        || preserved !== pending.preservedFingerprint
        || (expectedTarget !== undefined && status.TCP?.["443"]?.HTTPS !== true)
      ) {
        throw new Error("tailscale_reconciliation_conflict");
      }
      if (expectedTarget !== undefined) {
        if (!await this.probeHealth(expectedTarget)) {
          throw new Error("tailscale_reconciliation_unhealthy");
        }
        const confirmed = await this.serveStatus();
        if (serveFingerprint(confirmed) !== serveFingerprint(status)) {
          throw new Error("tailscale_reconciliation_conflict");
        }
        await this.outcomeStore.commit({ path: "/api/aiden/v1", target: expectedTarget });
        return "connected";
      }
      const confirmed = await this.serveStatus();
      if (serveFingerprint(confirmed) !== serveFingerprint(status)) {
        throw new Error("tailscale_reconciliation_conflict");
      }
      await this.outcomeStore.commit(undefined);
      return "disconnected";
    });
  }
}

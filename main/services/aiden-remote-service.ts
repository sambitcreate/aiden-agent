import { spawn, type ChildProcess } from "node:child_process";
import Bonjour from "bonjour-service";
import { createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import { AIDEN_REMOTE_BASE_PATH } from "./aiden-remote-protocol.js";
import {
  AidenRemotePairingService,
  type AidenRemoteDesktopPairing,
  type AidenRemotePairingBootstrap,
  type AidenRemotePairingWindowStatus,
} from "./aiden-remote-pairing.js";
import {
  createAidenRemoteRequestHandler,
  type AidenRemoteRouterDependencies,
} from "./aiden-remote-router.js";
import type {
  AidenRemoteConnectionMode,
  AidenRemoteStateDocument,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";
import type { AidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import { fetchTlsServerSpkiSha256 } from "./aiden-remote-tls-identity.js";
import type {
  AidenRemoteTailscaleController,
  AidenTailscaleConnectionStatus,
  AidenTailscaleRouteState,
  AidenTailscaleTakeoverReview,
} from "./aiden-remote-tailscale.js";
import {
  aidenTailscaleCanonicalLoopbackTargets,
  planAidenTailscaleConnect,
} from "./aiden-remote-tailscale-route.js";
import type { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import type { AidenRemoteChatService } from "./aiden-remote-chats.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import type { AidenRemoteFileService } from "./aiden-remote-files.js";
import type { AidenRemoteBotFileService } from "./aiden-remote-bot-files.js";
import type { AidenRemoteGitService } from "./aiden-remote-git.js";
import type { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import type { AidenRemoteBotService } from "./aiden-remote-bots.js";
import type { AidenRemoteSpeechService } from "./aiden-remote-speech.js";
import type { UsageDateRange, UsageSummary } from "./types.js";
import type {
  BotNoticeAcknowledgement,
  BotNoticeStatus,
} from "../../renderer/shared/bot-capabilities.js";
import {
  AIDEN_REMOTE_PRODUCTION_LAN_PORT,
  aidenRemotePortCandidatesForRange,
} from "./aiden-remote-ports.js";

const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 30_000;

export class AidenRemotePortInUseError extends Error {
  readonly code = "remote_port_in_use" as const;

  constructor(readonly lanPort: number) {
    super(
      `Aiden Remote cannot use private port ${lanPort}. Stop the other Aiden profile using it, then try again.`,
    );
    this.name = "AidenRemotePortInUseError";
  }
}

class AidenRemoteRelocationPreflightError extends Error {
  constructor() {
    super("Aiden couldn't verify existing Tailscale routes before moving this endpoint. Try again when Tailscale is available.");
    this.name = "AidenRemoteRelocationPreflightError";
  }
}

export function aidenRemotePortCandidates(preferredPort: number): number[] {
  return aidenRemotePortCandidatesForRange(
    preferredPort,
    AIDEN_REMOTE_PRODUCTION_LAN_PORT,
  );
}

export interface AidenRemoteBonjourPublisher {
  start(
    input: { instanceId: string; displayName: string; port: number },
    onUnexpectedFailure: (error: Error) => void,
  ): Promise<void>;
  stop(): void;
}

export interface AidenRemoteServiceLogEntry {
  level: "info" | "warn" | "error";
  event: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export function aidenRemoteBonjourServiceName(
  displayName: string,
  instanceId: string,
): string {
  const publicSuffix = createHash("sha256")
    .update(instanceId, "utf8")
    .digest("hex")
    .slice(0, 6);
  const suffix = ` [${publicSuffix}]`;
  let label = displayName;
  while (Buffer.byteLength(`${label}${suffix}`, "utf8") > 63) {
    label = [...label].slice(0, -1).join("");
  }
  return `${label || "Aiden"}${suffix}`;
}

export interface AidenRemoteServiceOptions {
  state: AidenRemoteStateRegistry;
  appVersion: string;
  botCapabilitiesSupported?: () => boolean;
  hostname?: string;
  loadTlsIdentity(): Promise<AidenRemoteTlsIdentity>;
  resolveTlsEndpointPin?: (hostname: string, port?: number) => Promise<string>;
  tailscale: Pick<AidenRemoteTailscaleController, "status" | "connect" | "disconnect">
    & Partial<Pick<AidenRemoteTailscaleController, "inspectRoute" | "assessRoute" | "reviewTakeover" | "takeOver" | "reconcilePendingOutcome">>;
  bonjour: AidenRemoteBonjourPublisher;
  notifyPairingChanged?: () => void;
  workspaceApi?: (
    instanceId: string,
  ) =>
    | {
        workspaces: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
        workspaceBrowser: Pick<
          AidenRemoteWorkspaceBrowserService,
          "listRoots" | "listChildren" | "createSelection"
        >;
        chats?: Pick<AidenRemoteChatService, "list" | "classify" | "authorizeRetainedBotChat" | "runMutation" | "get" | "create" | "rename" | "move" | "remove" | "startTurn">;
        models?: Pick<AidenRemoteModelService, "list">;
        streams?: Pick<AidenRemoteStreamService, "streamChatId" | "status" | "pendingApproval" | "approvalChatId" | "approvalRequiredCapability" | "cancel" | "respondApproval" | "openEvents">;
        files?: Pick<AidenRemoteFileService, "list" | "read" | "write">;
        botFiles?: Pick<AidenRemoteBotFileService, "list" | "read" | "write">;
        git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
        schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
        usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
        speech?: Pick<AidenRemoteSpeechService, "status" | "select" | "startDownload" | "cancelDownload" | "deleteModel" | "transcribe">;
        botNotice?: {
          status(deviceId: string): Promise<BotNoticeStatus>;
          acknowledge(
            deviceId: string,
            acknowledgement: BotNoticeAcknowledgement,
          ): Promise<BotNoticeStatus>;
        };
        bots?: Pick<
          AidenRemoteBotService,
          | "list"
          | "get"
          | "create"
          | "updateIdentity"
          | "archive"
          | "restore"
          | "capabilityCatalog"
          | "updateAccess"
          | "createChat"
          | "getChatAccess"
          | "updateChatAccess"
          | "favorites"
          | "updateFavorites"
        > & Partial<Pick<
          AidenRemoteBotService,
          "listConversations" | "putAvatar" | "deleteAvatar" | "avatarContent"
        >>;
        settle?: () => Promise<void>;
      }
    | Promise<{
        workspaces: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
        workspaceBrowser: Pick<
          AidenRemoteWorkspaceBrowserService,
          "listRoots" | "listChildren" | "createSelection"
        >;
        chats?: Pick<AidenRemoteChatService, "list" | "classify" | "authorizeRetainedBotChat" | "runMutation" | "get" | "create" | "rename" | "move" | "remove" | "startTurn">;
        models?: Pick<AidenRemoteModelService, "list">;
        streams?: Pick<AidenRemoteStreamService, "streamChatId" | "status" | "pendingApproval" | "approvalChatId" | "approvalRequiredCapability" | "cancel" | "respondApproval" | "openEvents">;
        files?: Pick<AidenRemoteFileService, "list" | "read" | "write">;
        botFiles?: Pick<AidenRemoteBotFileService, "list" | "read" | "write">;
        git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
        schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
        usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
        speech?: Pick<AidenRemoteSpeechService, "status" | "select" | "startDownload" | "cancelDownload" | "deleteModel" | "transcribe">;
        botNotice?: {
          status(deviceId: string): Promise<BotNoticeStatus>;
          acknowledge(
            deviceId: string,
            acknowledgement: BotNoticeAcknowledgement,
          ): Promise<BotNoticeStatus>;
        };
        bots?: Pick<
          AidenRemoteBotService,
          | "list"
          | "get"
          | "create"
          | "updateIdentity"
          | "archive"
          | "restore"
          | "capabilityCatalog"
          | "updateAccess"
          | "createChat"
          | "getChatAccess"
          | "updateChatAccess"
          | "favorites"
          | "updateFavorites"
        > & Partial<Pick<
          AidenRemoteBotService,
          "listConversations" | "putAvatar" | "deleteAvatar" | "avatarContent"
        >>;
        settle?: () => Promise<void>;
      }>;
  now?: () => number;
  portCandidates?: (preferredPort: number) => readonly number[];
  afterListenerBound?: (input: {
    transport: "lan" | "tailscale";
    port: number;
  }) => Promise<void>;
  log?: (entry: AidenRemoteServiceLogEntry) => void;
}

export interface AidenRemoteServiceStatus {
  enabled: boolean;
  running: boolean;
  connectionMode: AidenRemoteConnectionMode;
  lanPort: number;
  lanEndpoint?: string;
  tailscaleEndpoint?: string;
  tailscaleRoutePreview?: string;
  tailscaleConnected: boolean;
  tailscaleInstalled: boolean;
  tailscaleRouteState: AidenTailscaleRouteState;
  tailscaleErrorCode?: AidenTailscaleConnectionStatus["errorCode"];
  pairedDeviceCount: number;
  approvedRootCount: number;
  errorCode?: "remote_port_in_use";
  error?: string;
}

function normalizedHostname(raw: string): string {
  const value = raw.trim().replace(/\.$/u, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) return "localhost";
  return value;
}

function localDnsName(hostname: string): string {
  return hostname.includes(".") ? hostname : `${hostname}.local`;
}

function tailscaleLoopbackPort(lanPort: number): number {
  return lanPort === 65_535 ? 49_221 : lanPort + 1;
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}

function configureServer(server: HttpServer | HttpsServer): void {
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
}

async function listen(
  server: NetServer,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: NetServer | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Stop admitting sockets before forcing existing HTTP(S) connections
    // closed. Reversing this order leaves a race where a new connection can
    // arrive after closeAllConnections() and keep server.close() pending.
    if ("closeIdleConnections" in server) {
      (server as HttpServer).closeIdleConnections?.();
      (server as HttpServer).closeAllConnections?.();
    }
  });
}

async function ipv4LoopbackPortIsAvailable(port: number): Promise<boolean> {
  const probe = createNetServer();
  try {
    await listen(probe, port, "127.0.0.1");
    return true;
  } catch (error) {
    if (isAddressInUse(error)) return false;
    throw error;
  } finally {
    await closeServer(probe);
  }
}

export class DnsSdAidenRemoteBonjourPublisher implements AidenRemoteBonjourPublisher {
  private child: ChildProcess | null = null;

  constructor(
    private readonly log: (entry: AidenRemoteServiceLogEntry) => void = () => undefined,
  ) {}

  async start(
    input: { instanceId: string; displayName: string; port: number },
    onUnexpectedFailure: (error: Error) => void,
  ): Promise<void> {
    this.stop();
    const serviceName = aidenRemoteBonjourServiceName(
      input.displayName,
      input.instanceId,
    );
    const child = spawn(
      "/usr/bin/dns-sd",
      [
        "-R", serviceName, "_aiden-agent._tcp", "local.",
        String(input.port), "v=1", `instance=${input.instanceId}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let failed = false;
      let readinessTimer: NodeJS.Timeout | undefined;
      const fail = (error: Error) => {
        if (failed) return;
        const isCurrent = this.child === child;
        if (ready && !isCurrent) return;
        failed = true;
        if (readinessTimer) clearTimeout(readinessTimer);
        if (isCurrent) this.child = null;
        this.log({ level: "warn", event: "bonjour_failed", details: { message: error.message } });
        if (!ready) reject(error);
        else if (isCurrent) onUnexpectedFailure(error);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        fail(new Error(`Local discovery exited (${code ?? signal ?? "unknown"}).`));
      });
      child.once("spawn", () => {
        // dns-sd has no registration acknowledgement. Remaining alive through
        // a bounded launch window catches missing binaries and immediate
        // registration failures before listeners are declared ready.
        readinessTimer = setTimeout(() => {
          ready = true;
          resolve();
        }, 150);
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
}

export class NodeAidenRemoteBonjourPublisher implements AidenRemoteBonjourPublisher {
  private bonjour: Bonjour | null = null;
  private generation = 0;

  constructor(
    private readonly log: (entry: AidenRemoteServiceLogEntry) => void = () => undefined,
  ) {}

  async start(
    input: { instanceId: string; displayName: string; port: number },
    onUnexpectedFailure: (error: Error) => void,
  ): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    let ready = false;
    let failed = false;
    let rejectStartup: (error: Error) => void = () => undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const fail = (value: unknown) => {
      if (failed || this.generation !== generation) return;
      failed = true;
      const error = value instanceof Error ? value : new Error(String(value));
      this.log({
        level: "warn",
        event: "bonjour_failed",
        details: { message: error.message },
      });
      if (!ready) rejectStartup(error);
      else onUnexpectedFailure(error);
    };
    const bonjour = new Bonjour(undefined, fail);
    this.bonjour = bonjour;
    const service = bonjour.publish({
      name: aidenRemoteBonjourServiceName(input.displayName, input.instanceId),
      type: "aiden-agent",
      protocol: "tcp",
      port: input.port,
      txt: { v: "1", instance: input.instanceId },
    });
    const readySignal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Local discovery did not become ready in time.")),
        3_000,
      );
      timer.unref();
      service.once("up", () => {
        clearTimeout(timer);
        if (this.generation !== generation) {
          reject(new Error("Local discovery was stopped before it became ready."));
          return;
        }
        ready = true;
        resolve();
      });
    });
    await Promise.race([readySignal, startupFailure]).catch((error: unknown) => {
      this.stop();
      throw error;
    });
  }

  stop(): void {
    this.generation += 1;
    const bonjour = this.bonjour;
    this.bonjour = null;
    bonjour?.destroy();
  }
}

export function aidenRemoteBonjourBackend(
  platform: NodeJS.Platform = process.platform,
): "dns-sd" | "node" {
  return platform === "darwin" ? "dns-sd" : "node";
}

export function createAidenRemoteBonjourPublisher(
  log: (entry: AidenRemoteServiceLogEntry) => void = () => undefined,
  platform: NodeJS.Platform = process.platform,
): AidenRemoteBonjourPublisher {
  return aidenRemoteBonjourBackend(platform) === "dns-sd"
    ? new DnsSdAidenRemoteBonjourPublisher(log)
    : new NodeAidenRemoteBonjourPublisher(log);
}

export class AidenRemoteService {
  private lanServer: HttpsServer | null = null;
  private tailscaleServer: HttpServer | null = null;
  private readonly lanConnections = new Set<Duplex>();
  private readonly tailscaleConnections = new Set<Duplex>();
  private pairing: AidenRemotePairingService | null = null;
  private tlsIdentity: AidenRemoteTlsIdentity | null = null;
  private activeState: AidenRemoteStateDocument | null = null;
  private lastError: string | undefined;
  private lastErrorCode: "remote_port_in_use" | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private settleRemoteApi: (() => Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly hostname: string;

  constructor(private readonly options: AidenRemoteServiceOptions) {
    this.now = options.now ?? Date.now;
    this.hostname = normalizedHostname(options.hostname ?? os.hostname());
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      const state = await this.options.state.initialize();
      if (state.enabled) await this.startConfigured(state);
    });
  }

  private async startConfigured(
    state: AidenRemoteStateDocument,
    options: { allowEndpointRelocation?: boolean } = {},
  ): Promise<void> {
    await this.stopListeners();
    this.lastError = undefined;
    this.lastErrorCode = undefined;
    try {
      const tlsIdentity = await this.options.loadTlsIdentity();
      const pairing = new AidenRemotePairingService(
        state.instanceId,
        this.options.state,
        undefined,
        this.options.notifyPairingChanged,
        () => this.activeState?.displayName ?? state.displayName,
        this.options.botCapabilitiesSupported,
      );
      const workspaceApi = await this.options.workspaceApi?.(state.instanceId);
      this.settleRemoteApi = workspaceApi?.settle;
      const routerDependencies: AidenRemoteRouterDependencies = {
        instanceId: state.instanceId,
        displayName: () => this.activeState?.displayName ?? state.displayName,
        appVersion: this.options.appVersion,
        devices: this.options.state,
        pairing,
        ...(workspaceApi ?? {}),
        connectionMode: () => this.activeState?.connectionMode ?? state.connectionMode,
        now: this.now,
        log: (entry) => {
          this.options.log?.({
            level: entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info",
            event: "request",
            details: {
              requestId: entry.requestId,
              route: entry.route,
              status: entry.status,
              latencyMs: entry.latencyMs,
              deviceIdSuffix: entry.deviceIdSuffix,
              errorCode: entry.errorCode,
            },
          });
        },
      };

      const mayMoveFreshProfile = !state.lanPortCommitted
        && state.devices.length === 0
        && state.tailscaleOwnership === undefined;
      const maySelectAlternatePort = mayMoveFreshProfile
        || options.allowEndpointRelocation === true;
      const externallyReservedPorts = new Set<number>();
      try {
        const tailscaleStatus = await this.options.tailscale.status();
        for (const configured of tailscaleStatus.serveStatus
          ? aidenTailscaleCanonicalLoopbackTargets(tailscaleStatus.serveStatus)
          : []) {
          if (state.tailscaleOwnership?.target !== configured.target) {
            externallyReservedPorts.add(configured.port);
          }
        }
      } catch {
        if (options.allowEndpointRelocation) {
          throw new AidenRemoteRelocationPreflightError();
        }
        // A missing/unavailable local Tailscale CLI must not prevent LAN-only
        // startup. Exact route conflicts are still handled before mutation.
      }
      const candidates = maySelectAlternatePort
        ? [...(this.options.portCandidates?.(state.lanPort)
          ?? aidenRemotePortCandidates(state.lanPort))]
        : [state.lanPort];
      let selectedPort: number | undefined;
      let selectedLanServer: HttpsServer | null = null;
      let selectedTailscaleServer: HttpServer | null = null;
      for (const candidate of candidates) {
        const validFreshPair = Number.isInteger(candidate)
          && candidate >= 1
          && candidate < 65_535
          && candidate % 2 === 0;
        const validCommittedLegacy = !maySelectAlternatePort
          && Number.isInteger(candidate)
          && candidate >= 1
          && candidate <= 65_535;
        if (!validFreshPair && !validCommittedLegacy) continue;
        if (
          externallyReservedPorts.has(candidate)
          || externallyReservedPorts.has(tailscaleLoopbackPort(candidate))
        ) continue;
        // On macOS an IPv4 loopback listener can coexist with an IPv6
        // wildcard listener on the same numeric port. Without this probe,
        // Aiden can report its HTTPS listener as ready while 127.0.0.1 still
        // reaches the unrelated plaintext service. Reserve both address
        // families as one endpoint pair before committing the port.
        if (!(await ipv4LoopbackPortIsAvailable(candidate))) {
          if (maySelectAlternatePort) continue;
          throw new AidenRemotePortInUseError(state.lanPort);
        }
        let lanServer: HttpsServer | null = null;
        let tailscaleServer: HttpServer | null = null;
        try {
          const lanHandler = createAidenRemoteRequestHandler(routerDependencies);
          lanServer = createHttpsServer(
            { key: tlsIdentity.privateKey, cert: tlsIdentity.certificateChain },
            (request, response) => {
              const mode = this.activeState?.connectionMode ?? state.connectionMode;
              if (mode === "tailscale") {
                response.writeHead(404).end();
                return;
              }
              lanHandler(request, response);
            },
          );
          lanServer.prependListener("connection", (socket) => {
            const mode = this.activeState?.connectionMode ?? state.connectionMode;
            if (mode === "tailscale") {
              socket.destroy();
              return;
            }
            this.lanConnections.add(socket);
            socket.once("close", () => this.lanConnections.delete(socket));
          });
          configureServer(lanServer);
          // macOS Bonjour commonly resolves both A and AAAA records. The IPv6
          // wildcard is dual-stack by default, so one listener serves both.
          await listen(lanServer, candidate, "::");
          await this.options.afterListenerBound?.({ transport: "lan", port: candidate });

          const tailscaleHandler = createAidenRemoteRequestHandler({
            ...routerDependencies,
            acceptStrippedBasePath: true,
          });
          tailscaleServer = createHttpServer((request, response) => {
            const mode = this.activeState?.connectionMode ?? state.connectionMode;
            if (mode === "lan") {
              response.writeHead(404).end();
              return;
            }
            tailscaleHandler(request, response);
          });
          tailscaleServer.prependListener("connection", (socket) => {
            const mode = this.activeState?.connectionMode ?? state.connectionMode;
            if (mode === "lan") {
              socket.destroy();
              return;
            }
            this.tailscaleConnections.add(socket);
            socket.once("close", () => this.tailscaleConnections.delete(socket));
          });
          configureServer(tailscaleServer);
          await listen(tailscaleServer, tailscaleLoopbackPort(candidate), "127.0.0.1");
          await this.options.afterListenerBound?.({
            transport: "tailscale",
            port: tailscaleLoopbackPort(candidate),
          });
          selectedPort = candidate;
          selectedLanServer = lanServer;
          selectedTailscaleServer = tailscaleServer;
          break;
        } catch (error) {
          this.destroyConnections(this.lanConnections);
          this.destroyConnections(this.tailscaleConnections);
          await Promise.all([
            closeServer(lanServer),
            closeServer(tailscaleServer),
          ]);
          if (isAddressInUse(error) && maySelectAlternatePort) continue;
          if (isAddressInUse(error)) throw new AidenRemotePortInUseError(state.lanPort);
          throw error;
        }
      }
      if (selectedPort === undefined) {
        throw new AidenRemotePortInUseError(state.lanPort);
      }
      if (!state.lanPortCommitted || state.lanPort !== selectedPort) {
        try {
          await this.options.state.commitLanPort(selectedPort);
        } catch (error) {
          this.destroyConnections(this.lanConnections);
          this.destroyConnections(this.tailscaleConnections);
          await Promise.all([
            closeServer(selectedLanServer),
            closeServer(selectedTailscaleServer),
          ]);
          throw error;
        }
      }
      const committedState = {
        ...state,
        lanPort: selectedPort,
        lanPortCommitted: true,
      };
      this.lanServer = selectedLanServer;
      this.tailscaleServer = selectedTailscaleServer;
      this.tlsIdentity = tlsIdentity;
      this.pairing = pairing;
      this.activeState = structuredClone(committedState);
      if (state.connectionMode === "lan" || state.connectionMode === "both") {
        await this.publishBonjour({
          instanceId: committedState.instanceId,
          displayName: committedState.displayName,
          port: committedState.lanPort,
        });
      }
      this.options.log?.({
        level: "info",
        event: "started",
        details: { mode: committedState.connectionMode, lanPort: committedState.lanPort },
      });
    } catch (error) {
      if (
        error instanceof AidenRemotePortInUseError
        || error instanceof AidenRemoteRelocationPreflightError
      ) {
        this.lastErrorCode = "remote_port_in_use";
        this.lastError = error.message;
      } else if (!this.lastError) {
        this.lastError = error instanceof Error ? error.message : "Aiden Remote failed to start.";
      }
      await this.stopListeners();
      throw error;
    }
  }

  private async publishBonjour(
    input: { instanceId: string; displayName: string; port: number },
  ): Promise<void> {
    try {
      await this.options.bonjour.start(input, (error) => {
        void this.serialized(async () => {
          if (
            this.activeState?.instanceId !== input.instanceId
            || this.activeState.lanPort !== input.port
            || !this.lanServer
          ) {
            return;
          }
          this.lastError = "Local network discovery stopped unexpectedly. Restart Remote Access to try again.";
          this.options.log?.({
            level: "warn",
            event: "bonjour_stopped",
            details: { message: error.message },
          });
          await this.stopListeners();
        });
      });
    } catch (error) {
      this.lastError = "Local network discovery could not start. Restart Remote Access to try again.";
      throw error;
    }
  }

  private async stopListeners(): Promise<void> {
    this.pairing?.close();
    this.pairing = null;
    this.options.bonjour.stop();
    const lan = this.lanServer;
    const tailscale = this.tailscaleServer;
    this.lanServer = null;
    this.tailscaleServer = null;
    this.destroyConnections(this.lanConnections);
    this.destroyConnections(this.tailscaleConnections);
    this.activeState = null;
    const settleRemoteApi = this.settleRemoteApi;
    this.settleRemoteApi = undefined;
    await Promise.all([
      closeServer(lan),
      closeServer(tailscale),
      settleRemoteApi?.() ?? Promise.resolve(),
    ]);
  }

  async stopAndSettle(): Promise<void> {
    await this.serialized(() => this.stopListeners());
  }

  stop(): void {
    this.pairing?.close();
    this.options.bonjour.stop();
    this.destroyConnections(this.lanConnections);
    this.destroyConnections(this.tailscaleConnections);
    this.lanServer?.close();
    this.tailscaleServer?.close();
  }

  keepsApplicationAlive(): boolean {
    return this.lanServer !== null || this.tailscaleServer !== null;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.serialized(async () => {
      const current = await this.options.state.snapshot();
      if (enabled) {
        if (!current.enabled || !this.activeState) {
          await this.startConfigured({ ...current, enabled: true });
          try {
            await this.options.state.setEnabled(true);
          } catch (error) {
            await this.stopListeners();
            throw error;
          }
        }
        return;
      }
      let disconnectError: unknown;
      if (current.tailscaleOwnership) {
        try {
          await this.disconnectTailscaleInternal(current);
        } catch (error) {
          disconnectError = error;
        }
      }
      await this.stopListeners();
      await this.options.state.setEnabled(false);
      this.lastError = undefined;
      this.lastErrorCode = undefined;
      if (disconnectError) throw disconnectError;
    });
  }

  /**
   * Explicit recovery for a saved endpoint occupied by another local Aiden
   * profile. Ordinary startup remains stable and fail-closed; only a direct
   * user action may select and persist another available port pair.
   */
  async moveToAvailablePort(): Promise<void> {
    await this.serialized(async () => {
      const current = await this.options.state.snapshot();
      if (current.tailscalePendingOutcome) {
        throw new Error("Verify the pending Tailscale route update before moving this endpoint.");
      }
      if (current.tailscaleOwnership) {
        throw new Error("Disconnect this profile's Tailscale Serve route before moving its endpoint.");
      }
      if (this.lastErrorCode !== "remote_port_in_use") {
        throw new Error("Aiden Remote does not currently need a different port.");
      }
      await this.startConfigured(
        { ...current, enabled: true },
        { allowEndpointRelocation: true },
      );
      if (!current.enabled) {
        try {
          await this.options.state.setEnabled(true);
        } catch (error) {
          await this.stopListeners();
          throw error;
        }
      }
    });
  }

  async setConnectionMode(connectionMode: AidenRemoteConnectionMode): Promise<void> {
    await this.serialized(async () => {
      const current = await this.options.state.snapshot();
      if (current.tailscaleOwnership && connectionMode === "lan") {
        await this.disconnectTailscaleInternal(current);
      }
      await this.options.state.setConnectionMode(connectionMode);
      if (current.enabled) {
        if (!this.activeState || !this.lanServer || !this.tailscaleServer) {
          await this.startConfigured({ ...current, connectionMode });
          return;
        }
        const previouslyAdvertised = current.connectionMode === "lan"
          || current.connectionMode === "both";
        const shouldAdvertise = connectionMode === "lan" || connectionMode === "both";
        this.activeState.connectionMode = connectionMode;
        if (connectionMode === "tailscale") this.destroyConnections(this.lanConnections);
        if (connectionMode === "lan") this.destroyConnections(this.tailscaleConnections);
        if (previouslyAdvertised && !shouldAdvertise) {
          this.options.bonjour.stop();
        } else if (!previouslyAdvertised && shouldAdvertise) {
          try {
            await this.publishBonjour({
              instanceId: this.activeState.instanceId,
              displayName: this.activeState.displayName,
              port: this.activeState.lanPort,
            });
          } catch (error) {
            await this.stopListeners();
            throw error;
          }
        }
      }
    });
  }

  private destroyConnections(connections: Set<Duplex>): void {
    for (const socket of connections) socket.destroy();
    connections.clear();
  }

  async setDisplayName(displayName: string): Promise<void> {
    await this.serialized(async () => {
      await this.options.state.setDisplayName(displayName);
      const state = await this.options.state.snapshot();
      if (this.activeState) this.activeState.displayName = state.displayName;
      if (
        this.lanServer
        && (state.connectionMode === "lan" || state.connectionMode === "both")
      ) {
        try {
          await this.publishBonjour({
            instanceId: state.instanceId,
            displayName: state.displayName,
            port: state.lanPort,
          });
        } catch (error) {
          await this.stopListeners();
          throw error;
        }
      }
    });
  }

  private loopbackTarget(state: AidenRemoteStateDocument): string {
    return `http://127.0.0.1:${tailscaleLoopbackPort(state.lanPort)}${AIDEN_REMOTE_BASE_PATH}`;
  }

  async connectTailscale(): Promise<void> {
    await this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (state.tailscalePendingOutcome) throw new Error("tailscale_reconciliation_required");
      if (!state.enabled || (state.connectionMode !== "tailscale" && state.connectionMode !== "both")) {
        throw new Error("Enable Aiden Remote with Tailscale access before connecting Serve.");
      }
      if (!this.tailscaleServer) throw new Error("Aiden Remote loopback service is not running.");
      const target = this.loopbackTarget(state);
      let ownership = state.tailscaleOwnership;
      if (ownership && ownership.target !== target) {
        // Pre-acceptance builds persisted an origin-only target that cannot
        // route the canonical API after Tailscale strips --set-path. Remove
        // only that exact owned route before creating the corrected one.
        await this.options.tailscale.disconnect(
          ownership.target,
          ownership,
          () => this.options.state.commitTailscaleOutcome(undefined),
        );
        ownership = undefined;
      }
      await this.options.tailscale.connect(
        target,
        ownership,
        (nextOwnership) => this.options.state.commitTailscaleOutcome(nextOwnership),
      );
    });
  }

  async reviewTailscaleTakeover(): Promise<AidenTailscaleTakeoverReview> {
    return this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (state.tailscalePendingOutcome) throw new Error("tailscale_reconciliation_required");
      if (!state.enabled || (state.connectionMode !== "tailscale" && state.connectionMode !== "both")) {
        throw new Error("tailscale_takeover_unavailable");
      }
      if (!this.tailscaleServer || !this.options.tailscale.reviewTakeover) {
        throw new Error("tailscale_takeover_unavailable");
      }
      return this.options.tailscale.reviewTakeover(
        this.loopbackTarget(state),
        state.tailscaleOwnership,
      );
    });
  }

  async takeOverTailscale(token: string): Promise<void> {
    await this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (state.tailscalePendingOutcome) throw new Error("tailscale_reconciliation_required");
      if (!state.enabled || (state.connectionMode !== "tailscale" && state.connectionMode !== "both")) {
        throw new Error("tailscale_takeover_unavailable");
      }
      if (!this.tailscaleServer || !this.options.tailscale.takeOver) {
        throw new Error("tailscale_takeover_unavailable");
      }
      await this.options.tailscale.takeOver(
        this.loopbackTarget(state),
        token,
        (ownership) => this.options.state.commitTailscaleOutcome(ownership),
      );
    });
  }

  private async disconnectTailscaleInternal(state: AidenRemoteStateDocument): Promise<void> {
    if (state.tailscalePendingOutcome) throw new Error("tailscale_reconciliation_required");
    if (!state.tailscaleOwnership) return;
    await this.options.tailscale.disconnect(
      state.tailscaleOwnership.target,
      state.tailscaleOwnership,
      () => this.options.state.commitTailscaleOutcome(undefined),
    );
  }

  async disconnectTailscale(): Promise<void> {
    await this.serialized(async () => {
      await this.disconnectTailscaleInternal(await this.options.state.snapshot());
    });
  }

  async reconcileTailscale(): Promise<void> {
    await this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (!state.tailscalePendingOutcome) {
        throw new Error("tailscale_reconciliation_unavailable");
      }
      if (!state.enabled || !this.tailscaleServer || !this.options.tailscale.reconcilePendingOutcome) {
        throw new Error("tailscale_reconciliation_unavailable");
      }
      await this.options.tailscale.reconcilePendingOutcome();
    });
  }

  async beginPairing(transport: "lan" | "tailscale"): Promise<AidenRemoteDesktopPairing> {
    return this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (!state.enabled || !this.pairing || !this.tlsIdentity) {
        throw new Error("Enable Aiden Remote before pairing a device.");
      }
      let endpoint: string;
      let serverSpkiSha256: string;
      if (transport === "lan") {
        if (
          !this.lanServer
          || (state.connectionMode !== "lan" && state.connectionMode !== "both")
        ) throw new Error("Local-network access is not enabled.");
        endpoint = `https://${localDnsName(this.hostname)}:${state.lanPort}${AIDEN_REMOTE_BASE_PATH}`;
        serverSpkiSha256 = this.tlsIdentity.serverSpkiSha256;
      } else {
        if (state.tailscalePendingOutcome) {
          throw new Error("Verify the previous Tailscale route update before pairing.");
        }
        if (
          !state.tailscaleOwnership
          || !this.tailscaleServer
          || (state.connectionMode !== "tailscale" && state.connectionMode !== "both")
        ) {
          throw new Error("Connect the Aiden Tailscale Serve route before pairing.");
        }
        const inspection = this.options.tailscale.inspectRoute
          ? await this.options.tailscale.inspectRoute(
            this.loopbackTarget(state),
            state.tailscaleOwnership,
          )
          : undefined;
        const status = inspection?.connectionStatus ?? await this.options.tailscale.status();
        if (inspection || this.options.tailscale.assessRoute) {
          const assessment = inspection?.assessment ?? await this.options.tailscale.assessRoute!(
            this.loopbackTarget(state),
            state.tailscaleOwnership,
          );
          if (assessment.state !== "owned" || assessment.errorCode) {
            throw new Error("The Tailscale route is not privately connected to this Aiden profile.");
          }
        } else {
          let connected = false;
          try {
            connected = status.serveStatus !== undefined
              && planAidenTailscaleConnect(
                status.serveStatus,
                this.loopbackTarget(state),
                state.tailscaleOwnership,
                status.httpsAvailable,
              ).action === "noop";
          } catch {
            connected = false;
          }
          if (!connected) {
            throw new Error("The Tailscale route is not privately connected to this Aiden profile.");
          }
        }
        if (!status.dnsName) throw new Error("Tailscale does not report a stable DNS name.");
        endpoint = `https://${status.dnsName}${AIDEN_REMOTE_BASE_PATH}`;
        serverSpkiSha256 = await (
          this.options.resolveTlsEndpointPin ?? fetchTlsServerSpkiSha256
        )(status.dnsName, 443);
      }
      const pairing = this.pairing.begin(endpoint, serverSpkiSha256);
      try {
        const qrPayload = this.pairingQrPayload(pairing.bootstrap, transport);
        this.pairing.sealManualPayload(pairing.sessionId, qrPayload);
        return { ...pairing, qrPayload };
      } catch (error) {
        this.pairing.close(pairing.sessionId);
        throw error;
      }
    });
  }

  async closePairing(sessionId: string): Promise<boolean> {
    return this.serialized(async () => {
      return this.pairing?.close(sessionId) ?? false;
    });
  }

  pairingStatus(): AidenRemotePairingWindowStatus | undefined {
    return this.pairing?.status();
  }

  pairingQrPayload(
    bootstrap: AidenRemotePairingBootstrap,
    transport: "lan" | "tailscale",
  ): string {
    if (!this.tlsIdentity) throw new Error("Aiden Remote transport identity is unavailable.");
    const trust = transport === "lan"
      ? {
          mode: "private-ca" as const,
          caCertificateDerBase64: new X509Certificate(
            this.tlsIdentity.caCertificate,
          ).raw.toString("base64"),
        }
      : { mode: "system" as const };
    const payload = JSON.stringify({
      kind: "aiden-pairing-v1",
      bootstrap,
      trust,
    });
    if (Buffer.byteLength(payload, "utf8") > 4_096) {
      throw new Error("Aiden Remote pairing payload is too large.");
    }
    return payload;
  }

  async status(): Promise<AidenRemoteServiceStatus> {
    await this.operationTail;
    const state = await this.options.state.snapshot();
    let tailscaleStatus: AidenTailscaleConnectionStatus = { installed: false };
    const target = this.loopbackTarget(state);
    const shouldAssessRoute = !state.tailscalePendingOutcome
      && (state.connectionMode === "tailscale" || state.connectionMode === "both");
    const inspection = shouldAssessRoute && this.options.tailscale.inspectRoute
      ? await this.options.tailscale.inspectRoute(target, state.tailscaleOwnership)
      : undefined;
    if (inspection) {
      tailscaleStatus = inspection.connectionStatus;
    } else if (state.connectionMode !== "lan" || state.tailscaleOwnership) {
      tailscaleStatus = await this.options.tailscale.status();
    }
    const lanEndpoint = this.lanServer
      && (state.connectionMode === "lan" || state.connectionMode === "both")
      ? `https://${localDnsName(this.hostname)}:${state.lanPort}${AIDEN_REMOTE_BASE_PATH}`
      : undefined;
    const tailscaleEndpoint = tailscaleStatus.dnsName
      ? `https://${tailscaleStatus.dnsName}${AIDEN_REMOTE_BASE_PATH}`
      : undefined;
    let tailscaleConnected = false;
    let tailscaleRouteState: AidenTailscaleRouteState = "unavailable";
    let tailscaleErrorCode = tailscaleStatus.errorCode;
    if (state.tailscalePendingOutcome) {
      tailscaleRouteState = "reconciliation_required";
    } else if (inspection || (this.options.tailscale.assessRoute && shouldAssessRoute)) {
      const assessment = inspection?.assessment
        ?? await this.options.tailscale.assessRoute!(target, state.tailscaleOwnership);
      tailscaleRouteState = assessment.state;
      tailscaleErrorCode = assessment.errorCode;
      tailscaleConnected = assessment.state === "owned" && assessment.errorCode === undefined;
    } else if (state.tailscaleOwnership && tailscaleStatus.serveStatus) {
      try {
        tailscaleConnected = planAidenTailscaleConnect(
          tailscaleStatus.serveStatus,
          target,
          state.tailscaleOwnership,
        ).action === "noop";
        tailscaleRouteState = tailscaleConnected ? "owned" : "unavailable";
      } catch {
        tailscaleConnected = false;
      }
    } else if (tailscaleStatus.installed) {
      tailscaleRouteState = "available";
    }
    return {
      enabled: state.enabled,
      running: this.lanServer !== null || this.tailscaleServer !== null,
      connectionMode: state.connectionMode,
      lanPort: state.lanPort,
      ...(lanEndpoint ? { lanEndpoint } : {}),
      ...(tailscaleEndpoint ? { tailscaleEndpoint } : {}),
      ...(state.connectionMode === "tailscale" || state.connectionMode === "both"
        ? { tailscaleRoutePreview: `tailscale serve --yes --bg --https=443 --set-path=${AIDEN_REMOTE_BASE_PATH} ${target}` }
        : {}),
      tailscaleConnected,
      tailscaleInstalled: tailscaleStatus.installed,
      tailscaleRouteState,
      ...(tailscaleErrorCode ? { tailscaleErrorCode } : {}),
      pairedDeviceCount: state.devices.length,
      approvedRootCount: state.approvedRoots.length,
      ...(this.lastErrorCode ? { errorCode: this.lastErrorCode } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

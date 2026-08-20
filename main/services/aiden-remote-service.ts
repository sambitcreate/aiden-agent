import { spawn, type ChildProcess } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import os from "node:os";
import { AIDEN_REMOTE_BASE_PATH } from "./aiden-remote-protocol.js";
import { AidenRemotePairingService, type AidenRemotePairingBootstrap } from "./aiden-remote-pairing.js";
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
import type { AidenRemoteTailscaleController, AidenTailscaleConnectionStatus } from "./aiden-remote-tailscale.js";
import { planAidenTailscaleConnect } from "./aiden-remote-tailscale-route.js";
import type { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import type { AidenRemoteChatService } from "./aiden-remote-chats.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import type { AidenRemoteFileService } from "./aiden-remote-files.js";
import type { AidenRemoteGitService } from "./aiden-remote-git.js";
import type { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import type { UsageDateRange, UsageSummary } from "./types.js";

const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 30_000;

export interface AidenRemoteBonjourPublisher {
  start(input: { instanceId: string; port: number }): void;
  stop(): void;
}

export interface AidenRemoteServiceLogEntry {
  level: "info" | "warn" | "error";
  event: string;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface AidenRemoteServiceOptions {
  state: AidenRemoteStateRegistry;
  appVersion: string;
  hostname?: string;
  loadTlsIdentity(): Promise<AidenRemoteTlsIdentity>;
  resolveTlsEndpointPin?: (hostname: string, port?: number) => Promise<string>;
  tailscale: Pick<AidenRemoteTailscaleController, "status" | "connect" | "disconnect">;
  bonjour: AidenRemoteBonjourPublisher;
  workspaceApi?: (
    instanceId: string,
  ) =>
    | {
        workspaces: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
        workspaceBrowser: Pick<
          AidenRemoteWorkspaceBrowserService,
          "listRoots" | "listChildren" | "createSelection"
        >;
        chats?: Pick<AidenRemoteChatService, "list" | "get" | "create" | "rename" | "move" | "remove" | "startTurn">;
        models?: Pick<AidenRemoteModelService, "list">;
        streams?: Pick<AidenRemoteStreamService, "status" | "cancel" | "respondApproval" | "openEvents">;
        files?: Pick<AidenRemoteFileService, "list" | "read" | "write">;
        git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
        schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
        usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
        settle?: () => Promise<void>;
      }
    | Promise<{
        workspaces: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
        workspaceBrowser: Pick<
          AidenRemoteWorkspaceBrowserService,
          "listRoots" | "listChildren" | "createSelection"
        >;
        chats?: Pick<AidenRemoteChatService, "list" | "get" | "create" | "rename" | "move" | "remove" | "startTurn">;
        models?: Pick<AidenRemoteModelService, "list">;
        streams?: Pick<AidenRemoteStreamService, "status" | "cancel" | "respondApproval" | "openEvents">;
        files?: Pick<AidenRemoteFileService, "list" | "read" | "write">;
        git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
        schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
        usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
        settle?: () => Promise<void>;
      }>;
  now?: () => number;
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
  pairedDeviceCount: number;
  approvedRootCount: number;
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

function configureServer(server: HttpServer | HttpsServer): void {
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
}

async function listen(
  server: HttpServer | HttpsServer,
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

async function closeServer(server: HttpServer | HttpsServer | null): Promise<void> {
  if (!server) return;
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export class DnsSdAidenRemoteBonjourPublisher implements AidenRemoteBonjourPublisher {
  private child: ChildProcess | null = null;

  constructor(
    private readonly serviceName = "Aiden Agent",
    private readonly log: (entry: AidenRemoteServiceLogEntry) => void = () => undefined,
  ) {}

  start(input: { instanceId: string; port: number }): void {
    this.stop();
    const child = spawn(
      "/usr/bin/dns-sd",
      [
        "-R", this.serviceName, "_aiden-agent._tcp", "local.",
        String(input.port), "v=1", `instance=${input.instanceId}`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", (error) => {
      this.log({ level: "warn", event: "bonjour_failed", details: { message: error.message } });
      if (this.child === child) this.child = null;
    });
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
}

export class AidenRemoteService {
  private lanServer: HttpsServer | null = null;
  private tailscaleServer: HttpServer | null = null;
  private pairing: AidenRemotePairingService | null = null;
  private tlsIdentity: AidenRemoteTlsIdentity | null = null;
  private activeState: AidenRemoteStateDocument | null = null;
  private lastError: string | undefined;
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

  private async startConfigured(state: AidenRemoteStateDocument): Promise<void> {
    await this.stopListeners();
    this.lastError = undefined;
    try {
      const tlsIdentity = await this.options.loadTlsIdentity();
      const pairing = new AidenRemotePairingService(state.instanceId, this.options.state);
      const workspaceApi = await this.options.workspaceApi?.(state.instanceId);
      this.settleRemoteApi = workspaceApi?.settle;
      const routerDependencies: AidenRemoteRouterDependencies = {
        instanceId: state.instanceId,
        appVersion: this.options.appVersion,
        devices: this.options.state,
        pairing,
        ...(workspaceApi ?? {}),
        connectionMode: () => state.connectionMode,
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

      if (state.connectionMode === "lan" || state.connectionMode === "both") {
        const server = createHttpsServer(
          { key: tlsIdentity.privateKey, cert: tlsIdentity.certificateChain },
          createAidenRemoteRequestHandler(routerDependencies),
        );
        configureServer(server);
        // macOS Bonjour commonly resolves both A and AAAA records. The IPv6
        // wildcard is dual-stack by default, so one listener serves both.
        await listen(server, state.lanPort, "::");
        this.lanServer = server;
        this.options.bonjour.start({ instanceId: state.instanceId, port: state.lanPort });
      }

      if (state.connectionMode === "tailscale" || state.connectionMode === "both") {
        const server = createHttpServer(
          createAidenRemoteRequestHandler({
            ...routerDependencies,
            acceptStrippedBasePath: true,
          }),
        );
        configureServer(server);
        await listen(server, tailscaleLoopbackPort(state.lanPort), "127.0.0.1");
        this.tailscaleServer = server;
      }
      this.tlsIdentity = tlsIdentity;
      this.pairing = pairing;
      this.activeState = structuredClone(state);
      this.options.log?.({ level: "info", event: "started", details: { mode: state.connectionMode } });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Aiden Remote failed to start.";
      await this.stopListeners();
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
    this.lanServer?.close();
    this.tailscaleServer?.close();
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
      if (disconnectError) throw disconnectError;
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
        await this.startConfigured({ ...current, connectionMode });
      }
    });
  }

  private loopbackTarget(state: AidenRemoteStateDocument): string {
    return `http://127.0.0.1:${tailscaleLoopbackPort(state.lanPort)}${AIDEN_REMOTE_BASE_PATH}`;
  }

  async connectTailscale(): Promise<void> {
    await this.serialized(async () => {
      const state = await this.options.state.snapshot();
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
        await this.options.tailscale.disconnect(ownership.target, ownership);
        await this.options.state.setTailscaleOwnership(undefined);
        ownership = undefined;
      }
      const newOwnership = await this.options.tailscale.connect(
        target,
        ownership,
      );
      await this.options.state.setTailscaleOwnership(newOwnership);
    });
  }

  private async disconnectTailscaleInternal(state: AidenRemoteStateDocument): Promise<void> {
    if (!state.tailscaleOwnership) return;
    await this.options.tailscale.disconnect(
      state.tailscaleOwnership.target,
      state.tailscaleOwnership,
    );
    await this.options.state.setTailscaleOwnership(undefined);
  }

  async disconnectTailscale(): Promise<void> {
    await this.serialized(async () => {
      await this.disconnectTailscaleInternal(await this.options.state.snapshot());
    });
  }

  async beginPairing(transport: "lan" | "tailscale"): Promise<AidenRemotePairingBootstrap> {
    return this.serialized(async () => {
      const state = await this.options.state.snapshot();
      if (!state.enabled || !this.pairing || !this.tlsIdentity) {
        throw new Error("Enable Aiden Remote before pairing a device.");
      }
      let endpoint: string;
      let serverSpkiSha256: string;
      if (transport === "lan") {
        if (!this.lanServer) throw new Error("Local-network access is not enabled.");
        endpoint = `https://${localDnsName(this.hostname)}:${state.lanPort}${AIDEN_REMOTE_BASE_PATH}`;
        serverSpkiSha256 = this.tlsIdentity.serverSpkiSha256;
      } else {
        if (!state.tailscaleOwnership || !this.tailscaleServer) {
          throw new Error("Connect the Aiden Tailscale Serve route before pairing.");
        }
        const status = await this.options.tailscale.status();
        if (!status.dnsName) throw new Error("Tailscale does not report a stable DNS name.");
        endpoint = `https://${status.dnsName}${AIDEN_REMOTE_BASE_PATH}`;
        serverSpkiSha256 = await (
          this.options.resolveTlsEndpointPin ?? fetchTlsServerSpkiSha256
        )(status.dnsName, 443);
      }
      return this.pairing.begin(endpoint, serverSpkiSha256);
    });
  }

  async closePairing(): Promise<void> {
    await this.serialized(async () => {
      this.pairing?.close();
    });
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
    if (state.connectionMode !== "lan" || state.tailscaleOwnership) {
      tailscaleStatus = await this.options.tailscale.status();
    }
    const lanEndpoint = this.lanServer
      ? `https://${localDnsName(this.hostname)}:${state.lanPort}${AIDEN_REMOTE_BASE_PATH}`
      : undefined;
    const tailscaleEndpoint = tailscaleStatus.dnsName
      ? `https://${tailscaleStatus.dnsName}${AIDEN_REMOTE_BASE_PATH}`
      : undefined;
    const target = this.loopbackTarget(state);
    let tailscaleConnected = false;
    if (state.tailscaleOwnership && tailscaleStatus.serveStatus) {
      try {
        tailscaleConnected = planAidenTailscaleConnect(
          tailscaleStatus.serveStatus,
          target,
          state.tailscaleOwnership,
        ).action === "noop";
      } catch {
        tailscaleConnected = false;
      }
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
      pairedDeviceCount: state.devices.length,
      approvedRootCount: state.approvedRoots.length,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

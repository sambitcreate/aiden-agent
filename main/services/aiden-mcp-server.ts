/**
 * Aiden's MCP server: lets other apps on this computer (Claude Code, Codex,
 * ...) read Aiden chats and, when the person allows it, start turns in them.
 *
 * Ported in spirit from T3 Code's MCP server (pingdotgg/t3code#33196) and
 * hardened like `acp/mcp-bridge.ts`: stateless Streamable HTTP with one SDK
 * server per request, a 1 MiB body limit, schema-checked arguments and
 * `aiden_`-prefixed tools. It has its own listener on 127.0.0.1 only, never
 * the Remote Access LAN listener, and it checks Host and Origin so a web page
 * cannot reach it through DNS rebinding. It sends no CORS headers.
 *
 * Only an outside-app credential (device type `agent`) is accepted here, and
 * `/api/aiden/v1` refuses those credentials, so a phone token never works on
 * `/mcp` and an app token never works on the Remote API. See
 * `docs/aiden-mcp-server.md`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import type { AidenMcpApp, AidenMcpToolRunner } from "./aiden-mcp-tools.js";
import type {
  AidenRemoteAgentAccess,
  AidenRemoteAgentAppProjection,
  AidenRemoteAuthenticatedDevice,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";

export const AIDEN_MCP_PATH = "/mcp";
export const AIDEN_MCP_BODY_LIMIT = 1024 * 1024;
const OVERSIZED_DRAIN_MS = 5_000;
/** Loopback ports clear of the Remote Access LAN ranges (49220+ and 50220+). */
export const AIDEN_MCP_PRODUCTION_PORT = 49_400;
export const AIDEN_MCP_DEVELOPMENT_PORT = 50_400;
const DEFAULT_PORT_ATTEMPTS = 8;
const MAX_CONNECTIONS = 16;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/u;

export class AidenMcpPortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Another app is using port ${port}.`);
    this.name = "AidenMcpPortInUseError";
  }
}

export interface AidenMcpServerOptions {
  apps: { authenticate(credential: string): Promise<AidenRemoteAuthenticatedDevice | null> };
  tools: AidenMcpToolRunner;
  appVersion: string;
  /** Category-only events; never a credential, path, chat text or app name. */
  log?(event: string, details?: Record<string, string | number | boolean>): void;
}

/** The ports to try, in order: the one saved earlier, or else the profile default and its neighbours. */
export function aidenMcpPortCandidates(savedPort: number | undefined, defaultPort: number): number[] {
  if (savedPort !== undefined) return [savedPort];
  return Array.from({ length: DEFAULT_PORT_ATTEMPTS }, (_, index) => defaultPort + index);
}

export class AidenMcpServer {
  private server: HttpServer | undefined;
  private boundPort: number | undefined;

  constructor(private readonly options: AidenMcpServerOptions) {}

  get port(): number | undefined {
    return this.boundPort;
  }

  get url(): string | undefined {
    return this.boundPort === undefined ? undefined : `http://127.0.0.1:${this.boundPort}${AIDEN_MCP_PATH}`;
  }

  /**
   * Listens on the first free candidate. A saved port that is busy is an
   * error rather than a silent move, because every connected app has that
   * URL saved; with no saved port, port 0 lets the system choose as a last
   * resort.
   */
  async start(candidates: readonly number[], allowAnyPort = false): Promise<number> {
    if (this.server && this.boundPort !== undefined) return this.boundPort;
    const ports = allowAnyPort ? [...candidates, 0] : [...candidates];
    let lastBusy: number | undefined;
    for (const port of ports) {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch(() => {
          this.options.log?.("request-failed");
          if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Aiden error" } }));
        });
      });
      server.maxConnections = MAX_CONNECTIONS;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          lastBusy = port;
          continue;
        }
        throw error;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("The MCP server could not start.");
      }
      this.server = server;
      this.boundPort = address.port;
      this.options.log?.("started");
      return address.port;
    }
    throw new AidenMcpPortInUseError(lastBusy ?? candidates[0] ?? 0);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.options.log?.("stopped");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = this.boundPort;
    if (port === undefined || !allowedHost(request.headers.host, port) || !allowedOrigin(request.headers.origin, port)) {
      // A DNS-rebinding page arrives with a foreign Host or Origin.
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
      return;
    }
    if (request.url !== AIDEN_MCP_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      // Stateless: no standalone event stream and no sessions to delete.
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const app = await this.authenticate(request.headers.authorization);
    if (!app) {
      response.writeHead(401, { "www-authenticate": 'Bearer realm="aiden"' }).end();
      return;
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Drain what the app is still uploading so the 413 reaches it; closing
        // the socket mid-upload resets it and the app sees only a broken pipe.
        // An upload that keeps going past the grace period is cut off.
        const cutOff = setTimeout(() => request.socket.destroy(), OVERSIZED_DRAIN_MS);
        cutOff.unref();
        request.once("end", () => clearTimeout(cutOff));
        request.once("close", () => clearTimeout(cutOff));
        request.resume();
        response.writeHead(413).end();
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    // A long wait ends as soon as the app hangs up.
    const closed = new AbortController();
    response.once("close", () => closed.abort());

    const protocol = new Server(
      { name: "aiden", version: this.options.appVersion },
      { capabilities: { tools: {} } },
    );
    protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.options.tools.list(app) }));
    protocol.setRequestHandler(CallToolRequestSchema, (call) =>
      this.options.tools.call(app, call.params.name, call.params.arguments, closed.signal),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await protocol.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await transport.close();
      await protocol.close();
    }
  }

  private async authenticate(header: string | undefined): Promise<AidenMcpApp | null> {
    const match = BEARER.exec(header ?? "");
    if (!match) return null;
    const device = await this.options.apps.authenticate(match[1]!);
    // A phone's or Mac's credential reads exactly like an unknown one here.
    if (!device || device.type !== "agent" || device.revoked) return null;
    return { id: device.id, name: device.name, capabilities: device.capabilities };
  }
}

class BodyTooLargeError extends Error {}

/**
 * Reads at most the body limit. Past it, the rest is drained and dropped
 * rather than the request destroyed: destroying it closes the socket, and the
 * app would never see the 413.
 */
function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > AIDEN_MCP_BODY_LIMIT) return Promise.reject(new BodyTooLargeError());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > AIDEN_MCP_BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

/** Command-line apps send no Origin. A browser may only come from this server's own origin. */
function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const value = origin.toLowerCase();
  return value === `http://127.0.0.1:${port}` || value === `http://localhost:${port}`;
}

export type AidenMcpServerProblem = "port_in_use" | "start_failed";

export interface AidenMcpServerStatus {
  /** False where this host cannot offer the MCP server at all. */
  supported: boolean;
  enabled: boolean;
  running: boolean;
  port?: number;
  /** The URL an outside app is configured with. */
  url?: string;
  problem?: AidenMcpServerProblem;
}

type AidenMcpListener = Pick<AidenMcpServer, "start" | "close" | "port" | "url">;

export interface AidenMcpHostDependencies {
  state: Pick<
    AidenRemoteStateRegistry,
    "mcpServerSettings" | "setMcpServerEnabled" | "commitMcpServerPort" | "issueAgentApp" | "listAgentApps" | "authenticate"
  >;
  tools: AidenMcpToolRunner;
  /** `hostPlatformCapabilities().mcpServer`. */
  supported(): boolean;
  /** The first port tried when none is saved yet. */
  defaultPort: number;
  /** The Remote runtime's revocation, which fences the credential and ends its streams. */
  revokeDevice(deviceId: string): Promise<boolean>;
  appVersion: string;
  log?: AidenMcpServerOptions["log"];
}

/**
 * The main-process controls for the MCP server: on and off, and connecting,
 * listing and disconnecting outside apps. It is off until the person turns
 * it on, and it never starts on a host without the `mcpServer` capability.
 */
export class AidenMcpHost {
  private readonly server: AidenMcpListener;
  private problem: AidenMcpServerProblem | undefined;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: AidenMcpHostDependencies) {
    this.server = new AidenMcpServer({
      apps: dependencies.state,
      tools: dependencies.tools,
      appVersion: dependencies.appVersion,
      ...(dependencies.log ? { log: dependencies.log } : {}),
    });
  }

  async status(): Promise<AidenMcpServerStatus> {
    const supported = this.dependencies.supported();
    const settings = await this.dependencies.state.mcpServerSettings();
    const port = this.server.port ?? settings.port;
    return {
      supported,
      enabled: supported && settings.enabled,
      running: this.server.port !== undefined,
      ...(port === undefined ? {} : { port, url: `http://127.0.0.1:${port}${AIDEN_MCP_PATH}` }),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  /** Starts the listener if the person turned it on. Run at launch. */
  initialize(): Promise<AidenMcpServerStatus> {
    return this.serialize(async () => {
      await this.reconcile();
      return this.status();
    });
  }

  setEnabled(enabled: boolean): Promise<AidenMcpServerStatus> {
    return this.serialize(async () => {
      if (typeof enabled !== "boolean") throw new Error("Invalid MCP server setting.");
      if (enabled && !this.dependencies.supported()) {
        throw new Error("This computer cannot run Aiden's MCP server.");
      }
      await this.dependencies.state.setMcpServerEnabled(enabled);
      await this.reconcile();
      return this.status();
    });
  }

  /** Connects an outside app. The credential is returned once; only its digest is kept. */
  async issueApp(input: {
    name: string;
    access: AidenRemoteAgentAccess;
  }): Promise<{ credential: string; app: AidenRemoteAgentAppProjection }> {
    if (!this.dependencies.supported()) throw new Error("This computer cannot run Aiden's MCP server.");
    return this.dependencies.state.issueAgentApp(input);
  }

  listApps(): Promise<AidenRemoteAgentAppProjection[]> {
    return this.dependencies.state.listAgentApps();
  }

  /** Disconnects an app: its token stops working, and its waits and run streams end. */
  async revokeApp(appId: string): Promise<boolean> {
    const apps = await this.dependencies.state.listAgentApps();
    // Only an outside app can be disconnected here, never a phone or a Mac.
    if (!apps.some((app) => app.id === appId)) return false;
    const revoked = await this.dependencies.revokeDevice(appId);
    this.dependencies.tools.revokeApp(appId);
    return revoked;
  }

  stop(): Promise<void> {
    return this.serialize(() => this.server.close());
  }

  private async reconcile(): Promise<void> {
    const settings = await this.dependencies.state.mcpServerSettings();
    if (!settings.enabled || !this.dependencies.supported()) {
      this.problem = undefined;
      await this.server.close();
      return;
    }
    if (this.server.port !== undefined) return;
    try {
      const port = await this.server.start(
        aidenMcpPortCandidates(settings.port, this.dependencies.defaultPort),
        settings.port === undefined,
      );
      this.problem = undefined;
      if (settings.port !== port) await this.dependencies.state.commitMcpServerPort(port);
    } catch (error) {
      this.problem = error instanceof AidenMcpPortInUseError ? "port_in_use" : "start_failed";
      this.dependencies.log?.("start-failed", { problem: this.problem });
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => undefined);
    return next;
  }
}

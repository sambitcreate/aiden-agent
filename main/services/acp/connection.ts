/**
 * Typed ACP client connection over one agent process.
 *
 * Adapted from pi-antigravity-acp-provider src/acp/connection.ts @ 07e369b
 * (MIT), rewritten for ACP SDK 1.x. Every request races its deadline, the
 * caller's signal, and process exit, so no promise outlives the agent.
 */
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import { AcpHarnessError, abortError, errorMessage } from "./errors.js";
import type { AcpProcess } from "./process.js";

export const INITIALIZE_TIMEOUT_MS = 60_000;
export const SESSION_TIMEOUT_MS = 120_000;

export interface AcpClientHandlers {
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  readTextFile?(request: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile?(request: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

export interface AcpClientCapabilityOptions {
  /** Advertise fs read/write so the agent's file tools go through Aiden. */
  fileSystem: boolean;
}

const NO_HANDLERS: AcpClientHandlers = {
  onUpdate() {},
  async onPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
};

export class AcpConnection {
  private handlers: AcpClientHandlers;
  private readonly connection: ClientSideConnection;
  private readonly exitFailure: Promise<never>;

  constructor(
    readonly process: AcpProcess,
    handlers: AcpClientHandlers = NO_HANDLERS,
    private readonly capabilities: AcpClientCapabilityOptions = { fileSystem: false },
  ) {
    this.handlers = handlers;
    const stream = ndJsonStream(process.output, process.input);
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (notification) => {
          try {
            this.handlers.onUpdate(notification);
          } catch {
            // A rendering failure must never break the protocol stream.
          }
        },
        requestPermission: (request) => this.handlers.onPermission(request),
        readTextFile: async (request) => {
          if (!this.capabilities.fileSystem || !this.handlers.readTextFile) {
            throw new AcpHarnessError("unavailable", "File access is not available.");
          }
          return this.handlers.readTextFile(request);
        },
        writeTextFile: async (request) => {
          if (!this.capabilities.fileSystem || !this.handlers.writeTextFile) {
            throw new AcpHarnessError("unavailable", "File access is not available.");
          }
          return this.handlers.writeTextFile(request);
        },
      }),
      stream,
    );
    this.exitFailure = process.exited.then((exit) => {
      const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`;
      throw new AcpHarnessError("process_exit", `The agent stopped unexpectedly (${detail}).`);
    });
    this.exitFailure.catch(() => undefined);
  }

  setHandlers(handlers: AcpClientHandlers): void {
    this.handlers = handlers;
  }

  initialize(signal?: AbortSignal): Promise<InitializeResponse> {
    return this.request(
      () =>
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: this.capabilities.fileSystem, writeTextFile: this.capabilities.fileSystem },
            terminal: false,
          },
          clientInfo: { name: "aiden", title: "Aiden", version: "1" },
        }),
      INITIALIZE_TIMEOUT_MS,
      signal,
      "starting the agent",
    );
  }

  authenticate(methodId: string, signal?: AbortSignal, timeoutMs = SESSION_TIMEOUT_MS): Promise<unknown> {
    return this.request(
      () => this.connection.authenticate({ methodId }),
      timeoutMs,
      signal,
      "signing in",
    );
  }

  newSession(cwd: string, mcpServers: McpServer[], signal?: AbortSignal): Promise<NewSessionResponse> {
    return this.request(
      () => this.connection.newSession({ cwd, mcpServers }),
      SESSION_TIMEOUT_MS,
      signal,
      "starting a session",
    );
  }

  resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    signal?: AbortSignal,
  ): Promise<ResumeSessionResponse> {
    return this.request(
      () => this.connection.resumeSession({ sessionId, cwd, mcpServers }),
      SESSION_TIMEOUT_MS,
      signal,
      "resuming the session",
    );
  }

  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    signal?: AbortSignal,
  ): Promise<LoadSessionResponse> {
    return this.request(
      () => this.connection.loadSession({ sessionId, cwd, mcpServers }),
      SESSION_TIMEOUT_MS,
      signal,
      "loading the session",
    );
  }

  setConfigOption(sessionId: string, configId: string, value: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      () => this.connection.setSessionConfigOption({ sessionId, configId, value }),
      SESSION_TIMEOUT_MS,
      signal,
      "changing a session setting",
    );
  }

  setMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      () => this.connection.setSessionMode({ sessionId, modeId }),
      SESSION_TIMEOUT_MS,
      signal,
      "changing the session mode",
    );
  }

  /** No deadline: a turn may legitimately run for a long time. */
  prompt(request: PromptRequest): Promise<PromptResponse> {
    return Promise.race([this.connection.prompt(request), this.exitFailure]).catch((error: unknown) =>
      this.preferExitError(error),
    );
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.process.alive) return;
    await Promise.race([this.connection.cancel({ sessionId }), this.exitFailure]).catch(() => undefined);
  }

  logout(signal?: AbortSignal): Promise<unknown> {
    return this.request(() => this.connection.logout({}), SESSION_TIMEOUT_MS, signal, "signing out");
  }

  close(): Promise<void> {
    return this.process.close();
  }

  /**
   * The SDK rejects in-flight requests as soon as stdout closes, usually a
   * moment before the exit event. Report the crash rather than the closed
   * stream when the process is on its way out.
   */
  private async preferExitError(error: unknown): Promise<never> {
    if (error instanceof AcpHarnessError) throw error;
    const exited = await Promise.race([
      this.exitFailure.then(
        () => undefined,
        (exit: unknown) => exit,
      ),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 500);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (exited) throw exited;
    throw new AcpHarnessError("protocol", errorMessage(error), { cause: error });
  }

  private request<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new AcpHarnessError("timeout", `The agent took too long ${label}.`))),
        timeoutMs,
      );
      timer.unref?.();
      const onAbort = () => finish(() => reject(abortError()));
      signal?.addEventListener("abort", onAbort, { once: true });
      operation().then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => {
          if (!this.process.alive) {
            void this.preferExitError(error).catch((exit: unknown) => finish(() => reject(exit)));
            return;
          }
          finish(() =>
            reject(
              error instanceof AcpHarnessError
                ? error
                : Object.assign(new AcpHarnessError("protocol", errorMessage(error), { cause: error }), {
                    rpcCode: rpcCodeOf(error),
                  }),
            ),
          );
        },
      );
      this.exitFailure.catch((error: unknown) => finish(() => reject(error)));
    });
  }
}

function rpcCodeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

/** JSON-RPC code carried by a wrapped agent error. */
export function agentErrorCode(error: unknown): number | undefined {
  const own = (error as { rpcCode?: unknown } | undefined)?.rpcCode;
  if (typeof own === "number") return own;
  return rpcCodeOf((error as { cause?: unknown } | undefined)?.cause);
}

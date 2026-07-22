import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  ListToolsResultSchema,
  McpError,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CuaDriverError,
  type CuaDriverToolInfo,
  cuaDriverToolDeclaresSession,
  isAbortError,
  parseCuaDriverTools,
} from "./contract.js";
import { terminateDirectChild } from "./process.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 1_500;
export const CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
export const CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;
const CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE = -32099;
const CUA_LOCAL_REQUEST_TOO_LARGE_MARKER = "aiden.request_too_large.v1";
const CUA_LIST_TOOLS_RESULT_SCHEMA = ListToolsResultSchema.extend({
  tools: ToolSchema.passthrough().array(),
}).passthrough();

function startupTimeoutError(): CuaDriverError {
  return new CuaDriverError(
    "startup_timeout",
    "Aiden Computer Use did not finish starting in time.",
    true,
  );
}

function remainingMilliseconds(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw startupTimeoutError();
  return Math.max(1, remaining);
}

function cancellationError(signal: AbortSignal | undefined, message: string): CuaDriverError {
  return signal?.reason instanceof CuaDriverError
    ? signal.reason
    : new CuaDriverError("cancelled", message);
}

/**
 * Never hand a caller-owned signal to the MCP SDK. Some SDK request paths keep
 * abort listeners until their own lifecycle ends. A fresh controller scopes
 * every request and this forwarding listener is always removed in `finally`.
 */
async function withRequestSignal<T>(
  callerSignal: AbortSignal | undefined,
  operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

export interface CuaDriverCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CuaDriverSessionOptions {
  /** Already authenticated and dynamically verified bridge process. */
  bridge: ChildProcess;
  diagnostic?: () => string;
  onClosed?: (session: CuaDriverSession) => void;
}

function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    timer.unref();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

function isClosedTransportError(error: unknown): boolean {
  return (
    (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) ||
    (error instanceof Error &&
      /closed|not connected|broken pipe|end of stream|eof|transport/i.test(error.message))
  );
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

function isLocalRequestTooLarge(error: unknown): boolean {
  if (!(error instanceof McpError) || error.code !== CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE)
    return false;
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "aidenLocalError" in data &&
    data.aidenLocalError === CUA_LOCAL_REQUEST_TOO_LARGE_MARKER
  );
}

function isJsonRpcRequest(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: number | string; method: string } {
  return (
    "method" in message &&
    "id" in message &&
    (typeof message.id === "number" || typeof message.id === "string")
  );
}

function isToolError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "isError" in result && result.isError);
}

class BoundedMcpLineDecoder {
  private inputChunks: Buffer[] = [];
  private inputBytes = 0;

  constructor(private readonly maximumMessageBytes: number) {
    if (!Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes < 1) {
      throw new RangeError("The MCP message limit must be a positive safe integer.");
    }
  }

  consume(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      this.append(chunk.subarray(offset, end));
      if (newline < 0) return;

      onFrame(this.take());
      offset = newline + 1;
    }
  }

  reset(): void {
    this.inputChunks = [];
    this.inputBytes = 0;
  }

  private append(fragment: Buffer): void {
    if (fragment.length > this.maximumMessageBytes - this.inputBytes) {
      this.reset();
      throw new CuaDriverError(
        "response_too_large",
        "Computer Use returned an oversized MCP message.",
      );
    }
    if (fragment.length > 0) this.inputChunks.push(fragment);
    this.inputBytes += fragment.length;
  }

  private take(): Buffer {
    const frame =
      this.inputChunks.length === 0
        ? Buffer.alloc(0)
        : this.inputChunks.length === 1
          ? this.inputChunks[0]
          : Buffer.concat(this.inputChunks, this.inputBytes);
    this.reset();
    return frame[frame.length - 1] === 0x0d ? frame.subarray(0, frame.length - 1) : frame;
  }
}

/**
 * MCP newline transport over an already-authenticated native bridge. The
 * parameterized byte limit is a narrow framing-test seam; CuaDriverSession
 * always supplies Aiden's fixed 64 MiB production contract.
 */
export class AuthenticatedBridgeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly decoder: BoundedMcpLineDecoder;
  private started = false;
  private didNotifyClose = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly child: ChildProcess,
    maximumMessageBytes: number,
  ) {
    this.decoder = new BoundedMcpLineDecoder(maximumMessageBytes);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Authenticated bridge transport already started.");
    if (this.closePromise) throw new Error("Authenticated bridge transport is closed.");
    if (!this.child.stdin || !this.child.stdout) {
      throw new Error("Authenticated bridge stdio is unavailable.");
    }
    this.started = true;
    this.child.stdout.on("data", this.handleData);
    this.child.stdout.on("error", this.handleStreamError);
    this.child.stdin.on("error", this.handleStreamError);
    this.child.once("error", this.handleProcessError);
    this.child.once("close", this.handleProcessClose);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child.stdin;
    if (!this.started || this.closePromise || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Authenticated bridge is not connected.");
    }
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES) {
      if (isJsonRpcRequest(message)) {
        // MCP SDK 1.29 registers its response handler before Transport.send and
        // does not delete that handler when send rejects. Loop a private local
        // error through the normal response path so the SDK consumes the exact
        // request ID, clears its timeout, and leaves this session usable.
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: CUA_LOCAL_REQUEST_TOO_LARGE_ERROR_CODE,
              message: "Computer Use request exceeds the local MCP message limit.",
              data: { aidenLocalError: CUA_LOCAL_REQUEST_TOO_LARGE_MARKER },
            },
          });
        });
        return;
      }
      throw new CuaDriverError(
        "request_too_large",
        "Computer Use message exceeds the 1 MiB MCP message limit.",
      );
    }
    const payload = `${line}\n`;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        stdin.removeListener("drain", drained);
        reject(error);
      };
      const drained = () => {
        stdin.removeListener("error", failed);
        resolve();
      };
      stdin.once("error", failed);
      if (stdin.write(payload)) {
        stdin.removeListener("error", failed);
        resolve();
      } else {
        stdin.once("drain", drained);
      }
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private readonly handleData = (chunk: Buffer) => {
    try {
      this.decoder.consume(chunk, (frame) => {
        const message = JSONRPCMessageSchema.parse(
          JSON.parse(frame.toString("utf8")),
        );
        this.onmessage?.(message);
      });
    } catch (error) {
      this.fail(
        error instanceof CuaDriverError && error.code === "response_too_large"
          ? error
          : new Error("Computer Use returned malformed MCP data."),
      );
    }
  };

  private readonly handleStreamError = (error: Error) => this.fail(error);
  private readonly handleProcessError = (error: Error) => this.fail(error);
  private readonly handleProcessClose = () => {
    this.notifyClose();
    void this.close();
  };

  private fail(error: Error): void {
    this.onerror?.(error);
    this.notifyClose();
    void this.close();
  }

  private notifyClose(): void {
    if (this.didNotifyClose) return;
    this.didNotifyClose = true;
    this.onclose?.();
  }

  private async closeInternal(): Promise<void> {
    this.child.stdout?.removeListener("data", this.handleData);
    this.child.stdout?.removeListener("error", this.handleStreamError);
    this.child.stdin?.removeListener("error", this.handleStreamError);
    this.child.removeListener("error", this.handleProcessError);
    this.child.removeListener("close", this.handleProcessClose);
    try {
      this.child.stdin?.end();
    } catch {
      // Process teardown below is authoritative.
    }
    if (this.child.connected) {
      try {
        this.child.disconnect();
      } catch {
        // The native bridge may have closed fd 3 concurrently.
      }
    }
    await terminateDirectChild(this.child);
    this.decoder.reset();
    this.notifyClose();
  }
}

export class CuaDriverSession {
  readonly id = `aiden-${randomUUID()}`;
  private readonly transport: AuthenticatedBridgeTransport;
  private client: Client | null = null;
  private tools = new Map<string, CuaDriverToolInfo>();
  private toolSchemaVersion: string | null = null;
  private toolCapabilityVersion: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private didNotifyClosed = false;
  private state: "new" | "connecting" | "ready" | "broken" | "closed" = "new";

  constructor(private readonly options: CuaDriverSessionOptions) {
    this.transport = new AuthenticatedBridgeTransport(
      options.bridge,
      CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES,
    );
  }

  get toolCatalog(): ReadonlyMap<string, CuaDriverToolInfo> {
    return this.tools;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  get schemaVersion(): string | null {
    return this.toolSchemaVersion;
  }

  get capabilityVersion(): string | null {
    return this.toolCapabilityVersion;
  }

  supports(tool: string, capability: string): boolean {
    return this.tools.get(tool)?.capabilities.has(capability) ?? false;
  }

  async connect(
    signal?: AbortSignal,
    deadline = Date.now() + CONNECT_TIMEOUT_MS,
  ): Promise<void> {
    if (this.state !== "new") {
      if (this.state === "ready") return;
      throw new CuaDriverError(
        "invalid_session_state",
        "The cua-driver session cannot be connected again.",
      );
    }
    if (signal?.aborted) {
      await this.breakConnection();
      throw cancellationError(signal, "Computer Use startup was cancelled.");
    }
    this.state = "connecting";
    const client = new Client(
      { name: "aiden-agent-computer-use", version: "1.0.0" },
      { capabilities: {} },
    );
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = null;
      if (this.state === "connecting" || this.state === "ready") this.state = "broken";
      this.notifyClosed();
    };
    this.client = client;
    try {
      await withRequestSignal(signal, (requestSignal) =>
        client.connect(this.transport, {
          signal: requestSignal,
          timeout: remainingMilliseconds(deadline),
        }),
      );
      const listing = await withRequestSignal(signal, (requestSignal) =>
        client
          .request(
            { method: "tools/list", params: {} },
            CUA_LIST_TOOLS_RESULT_SCHEMA,
            { signal: requestSignal, timeout: remainingMilliseconds(deadline) },
          )
          .catch((error: unknown) => {
            if (
              isAbortError(error) ||
              signal?.aborted ||
              isRequestTimeout(error) ||
              isClosedTransportError(error)
            ) {
              throw error;
            }
            throw new CuaDriverError(
              "incompatible_driver",
              "cua-driver returned an incompatible tool catalog.",
            );
          }),
      );
      const catalog = parseCuaDriverTools(listing);
      this.tools = catalog.tools;
      this.toolSchemaVersion = catalog.schemaVersion;
      this.toolCapabilityVersion = catalog.capabilityVersion;
      const startResult = await withRequestSignal(signal, (requestSignal) => {
        const timeout = remainingMilliseconds(deadline);
        return client.callTool(
          { name: "start_session", arguments: { session: this.id } },
          undefined,
          {
            signal: requestSignal,
            timeout,
            maxTotalTimeout: timeout,
          },
        );
      });
      if (isToolError(startResult)) {
        throw new CuaDriverError(
          "session_start_failed",
          "cua-driver rejected Aiden's Computer Use session.",
        );
      }
      if (this.state !== "connecting") {
        throw new CuaDriverError(
          "session_closed",
          "The Computer Use session closed during startup.",
        );
      }
      this.state = "ready";
    } catch (error) {
      await this.breakConnection();
      if (isAbortError(error) || signal?.aborted)
        throw cancellationError(signal, "Computer Use startup was cancelled.");
      if (isRequestTimeout(error)) throw startupTimeoutError();
      const detail = this.options.diagnostic?.().trim().slice(-600);
      throw error instanceof CuaDriverError
        ? error
        : new CuaDriverError(
            "connection_failed",
            `Aiden could not connect to cua-driver${detail ? `: ${detail}` : "."}`,
            true,
          );
    }
  }

  private notifyClosed(): void {
    if (this.didNotifyClosed) return;
    this.didNotifyClosed = true;
    this.options.onClosed?.(this);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: CuaDriverCallOptions = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      void this.breakConnection().catch(() => {});
      throw new CuaDriverError("cancelled", "Computer Use was cancelled.");
    }

    const queued = this.enqueue(async () => {
      if (options.signal?.aborted) {
        await this.breakConnection();
        throw new CuaDriverError("cancelled", "Computer Use was cancelled.");
      }
      if (this.state !== "ready" || !this.client) {
        throw new CuaDriverError(
          "session_unavailable",
          "The Computer Use session is not ready.",
          true,
        );
      }
      const tool = this.tools.get(name);
      if (!tool) {
        throw new CuaDriverError(
          "unsupported_tool",
          `The pinned cua-driver does not expose ${name}.`,
        );
      }
      if (name === "start_session" || name === "end_session") {
        throw new CuaDriverError("reserved_tool", `${name} is owned by Aiden's session lifecycle.`);
      }
      if (Object.keys(args).some((key) => key.startsWith("_aiden_"))) {
        throw new CuaDriverError(
          "reserved_argument",
          "Private Computer Use authentication arguments are owned by Aiden's broker.",
        );
      }
      const declaresSession = cuaDriverToolDeclaresSession(tool);
      if (!declaresSession && Object.prototype.hasOwnProperty.call(args, "session")) {
        throw new CuaDriverError(
          "unsupported_argument",
          `${name} does not accept a Computer Use session argument.`,
        );
      }
      try {
        return await withRequestSignal(options.signal, (requestSignal) =>
          this.client!.callTool(
            { name, arguments: declaresSession ? { ...args, session: this.id } : { ...args } },
            undefined,
            {
              signal: requestSignal,
              timeout: options.timeoutMs ?? CALL_TIMEOUT_MS,
              maxTotalTimeout: options.timeoutMs ?? CALL_TIMEOUT_MS,
            },
          ),
        );
      } catch (error) {
        if (isLocalRequestTooLarge(error)) {
          throw new CuaDriverError(
            "request_too_large",
            "Computer Use request exceeds the 1 MiB MCP message limit.",
          );
        }
        if (isAbortError(error) || options.signal?.aborted) {
          await this.breakConnection();
          throw new CuaDriverError("cancelled", "Computer Use was cancelled.");
        }
        if (isRequestTimeout(error)) {
          await this.breakConnection();
          throw new CuaDriverError(
            "timeout",
            "cua-driver did not finish the Computer Use action in time.",
            true,
          );
        }
        if (isClosedTransportError(error)) {
          await this.breakConnection();
          throw new CuaDriverError(
            "transport_closed",
            "The cua-driver connection closed unexpectedly.",
            true,
          );
        }
        throw error;
      }
    });

    if (!options.signal) return queued;
    const signal = options.signal;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error);
        else resolve(value);
      };
      const aborted = () => {
        if (settled) return;
        // breakConnection changes state and detaches the client synchronously
        // before its first await, so this queued operation can never dispatch.
        void this.breakConnection().catch(() => {});
        finish(new CuaDriverError("cancelled", "Computer Use was cancelled."));
      };
      signal.addEventListener("abort", aborted, { once: true });
      void queued.then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error),
      );
      // Close the check-to-listener race without retaining a second listener.
      if (signal.aborted) aborted();
    });
  }

  private async breakConnection(): Promise<void> {
    if (this.state === "closed" || this.state === "broken") return;
    this.state = "broken";
    const client = this.client;
    this.client = null;
    this.notifyClosed();
    await this.transport.close().catch(() => {});
    await client?.close().catch(() => {});
  }

  invalidate(): void {
    if (this.state === "closed" || this.state === "broken") return;
    this.state = "broken";
    const client = this.client;
    this.client = null;
    this.notifyClosed();
    void this.transport.close().catch(() => {});
    void client?.close().catch(() => {});
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") return;
    const wasReady = this.state === "ready";
    this.state = "closed";
    const client = this.client;
    this.client = null;
    if (client) {
      const queueSettled = await settlesWithin(this.queue, CLOSE_GRACE_MS);
      if (wasReady && queueSettled) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CLOSE_GRACE_MS);
        try {
          await client.callTool(
            { name: "end_session", arguments: { session: this.id } },
            undefined,
            { signal: controller.signal, timeout: CLOSE_GRACE_MS, maxTotalTimeout: CLOSE_GRACE_MS },
          );
        } catch {
          // Process teardown is the hard session boundary.
        } finally {
          clearTimeout(timeout);
        }
      }
      await client.close().catch(() => {});
    } else {
      await this.transport.close().catch(() => {});
    }
    this.notifyClosed();
  }
}

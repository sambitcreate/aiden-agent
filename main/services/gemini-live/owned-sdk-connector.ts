import { createRequire } from "node:module";
import { GoogleGenAI } from "@google/genai";
import type { GoogleGenAIOptions, LiveConnectParameters } from "@google/genai";
import type { GeminiLiveConnector, GeminiLiveWireSession } from "./protocol.js";

interface SdkWebSocketCallbacks {
  onopen(): void;
  onerror(event: unknown): void;
  onmessage(event: unknown): void;
  onclose(event: unknown): void;
}

interface NodeWebSocketLike {
  readonly readyState: number;
  close(): void;
  terminate(): void;
  on(event: "open", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "message", listener: (data: { toString(): string }) => void): this;
  on(
    event: "unexpected-response",
    listener: (
      request: unknown,
      response: { statusCode?: number; resume(): void },
    ) => void,
  ): this;
  on(
    event: "close",
    listener: (code: number, reason: Uint8Array) => void,
  ): this;
  send(message: string): void;
}

interface NodeWebSocketConstructor {
  new (
    url: string,
    options: { headers: Record<string, string>; maxPayload: number },
  ): NodeWebSocketLike;
}

interface SdkOwnedSocket {
  connect(): void;
  send(message: string): void;
  close(): void;
}

interface SdkLiveWithReplaceableFactory {
  connect(params: LiveConnectParameters): Promise<GeminiLiveWireSession>;
  webSocketFactory: {
    create(
      url: string,
      headers: Record<string, string>,
      callbacks: SdkWebSocketCallbacks,
    ): SdkOwnedSocket;
  };
}

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as { WebSocket: NodeWebSocketConstructor };
export const GEMINI_LIVE_MAX_RAW_WEBSOCKET_PAYLOAD_BYTES = 1_048_576;

export type GeminiLiveConnectionFailureCode =
  | "authentication"
  | "quota"
  | "model_unavailable"
  | "service_unavailable"
  | "unsupported_configuration"
  | "network";

/** A fixed, content-free provider failure safe to map at the IPC boundary. */
export class GeminiLiveConnectionError extends Error {
  constructor(readonly code: GeminiLiveConnectionFailureCode) {
    super(`Gemini Live connection failed: ${code}.`);
    this.name = "GeminiLiveConnectionError";
  }
}

export function classifyGeminiLiveConnectionFailure(
  closeCode: number | null,
  reason: string,
): GeminiLiveConnectionFailureCode {
  const normalized = reason.toLowerCase();
  if (
    /api.?key|unauthenticated|permission.?denied|credential|reported as leaked|blocked/u.test(
      normalized,
    ) ||
    (closeCode === 1008 && /access|authoriz/u.test(normalized))
  )
    return "authentication";
  if (/quota|resource.?exhausted|rate.?limit|billing/u.test(normalized))
    return "quota";
  if (
    /model[^.]{0,80}(?:not found|unavailable|unsupported)|not found/u.test(
      normalized,
    )
  )
    return "model_unavailable";
  if (
    /not implemented|not supported|not enabled|invalid[ _]argument|failed[ _]precondition/u.test(
      normalized,
    )
  )
    return "unsupported_configuration";
  if (
    /service.?unavailable|internal|deadline|temporar/u.test(normalized) ||
    closeCode === 1011
  )
    return "service_unavailable";
  return "network";
}

export function classifyGeminiLiveUpgradeFailure(
  statusCode: number | undefined,
): GeminiLiveConnectionFailureCode {
  if (statusCode === 401 || statusCode === 403) return "authentication";
  if (statusCode === 429) return "quota";
  if (statusCode !== undefined && statusCode >= 500)
    return "service_unavailable";
  if (statusCode === 400) return "unsupported_configuration";
  return "network";
}

function providerErrorClassificationText(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const record = error as Record<string, unknown>;
  return [record.code, record.status, record.message]
    .filter((value): value is string | number =>
      ["string", "number"].includes(typeof value),
    )
    .map((value) => String(value).slice(0, 1_024))
    .join(" ");
}

class AbortOwnedWebSocket implements SdkOwnedSocket {
  private socket: NodeWebSocketLike | null = null;
  private finished = false;
  private localCloseRequested = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly callbacks: SdkWebSocketCallbacks,
    private readonly signal: AbortSignal | undefined,
    private readonly onFinished: () => void,
    private readonly onTransportFailure: (error: Error) => void,
    private readonly initialHistoryInClientContent: boolean,
  ) {}

  connect(): void {
    if (this.socket)
      throw new Error("The Live WebSocket is already connected.");
    if (this.signal?.aborted) {
      this.finish();
      return;
    }
    const socket = new WebSocket(this.url, {
      headers: this.headers,
      maxPayload: GEMINI_LIVE_MAX_RAW_WEBSOCKET_PAYLOAD_BYTES,
    });
    this.socket = socket;
    const onAbort = () => this.terminate();
    this.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("open", () => this.callbacks.onopen());
    socket.on("unexpected-response", (_request, response) => {
      const safeError = new GeminiLiveConnectionError(
        classifyGeminiLiveUpgradeFailure(response.statusCode),
      );
      response.resume();
      this.onTransportFailure(safeError);
      this.callbacks.onerror({ error: safeError });
      this.terminate();
    });
    socket.on("message", (data) => {
      const text = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        const safeError = new GeminiLiveConnectionError("network");
        this.onTransportFailure(safeError);
        this.callbacks.onerror({ error: safeError });
        this.terminate();
        return;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "error" in parsed
      ) {
        const safeError = new GeminiLiveConnectionError(
          classifyGeminiLiveConnectionFailure(
            null,
            providerErrorClassificationText(parsed.error),
          ),
        );
        this.onTransportFailure(safeError);
        this.callbacks.onerror({ error: safeError });
        this.terminate();
        return;
      }
      this.callbacks.onmessage({ data: text });
    });
    socket.on("error", (error) => {
      const safeError = new GeminiLiveConnectionError(
        classifyGeminiLiveConnectionFailure(
          null,
          error instanceof Error ? error.message : "",
        ),
      );
      this.onTransportFailure(safeError);
      this.callbacks.onerror({ error: safeError });
    });
    socket.on("close", (code, reason) => {
      this.signal?.removeEventListener("abort", onAbort);
      this.finish();
      const safeReason = Buffer.from(reason).toString("utf8");
      if (!this.localCloseRequested) {
        const safeError = new GeminiLiveConnectionError(
          classifyGeminiLiveConnectionFailure(code, safeReason),
        );
        this.onTransportFailure(safeError);
        // Preserve the fixed, content-free category through the protocol race;
        // never expose the raw provider reason to the SDK callback boundary.
        this.callbacks.onerror({ error: safeError });
      }
      this.callbacks.onclose({
        code,
        reason: safeReason,
        wasClean: code === 1000,
      });
    });
    if (this.signal?.aborted) this.terminate();
  }

  send(message: string): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("The Live WebSocket is not open.");
    }
    if (!this.initialHistoryInClientContent) {
      this.socket.send(message);
      return;
    }
    const parsed: unknown = JSON.parse(message);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("setup" in parsed) ||
      !parsed.setup ||
      typeof parsed.setup !== "object" ||
      Array.isArray(parsed.setup)
    ) {
      this.socket.send(message);
      return;
    }
    this.socket.send(
      JSON.stringify({
        ...parsed,
        setup: {
          ...parsed.setup,
          historyConfig: { initialHistoryInClientContent: true },
        },
      }),
    );
  }

  close(): void {
    this.localCloseRequested = true;
    if (!this.socket) {
      this.finish();
      return;
    }
    if (this.socket.readyState === 0) this.socket.terminate();
    else if (this.socket.readyState < 2) this.socket.close();
  }

  terminate(): void {
    this.localCloseRequested = true;
    try {
      this.socket?.terminate();
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.onFinished();
  }
}

class AbortOwnedWebSocketFactory {
  private readonly sockets = new Set<AbortOwnedWebSocket>();
  readonly failure: Promise<never>;
  private rejectFailure!: (error: Error) => void;

  constructor(
    private readonly signal: AbortSignal | undefined,
    private readonly initialHistoryInClientContent: boolean,
  ) {
    this.failure = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
  }

  create(
    url: string,
    headers: Record<string, string>,
    callbacks: SdkWebSocketCallbacks,
  ): AbortOwnedWebSocket {
    let socket!: AbortOwnedWebSocket;
    socket = new AbortOwnedWebSocket(
      url,
      headers,
      callbacks,
      this.signal,
      () => this.sockets.delete(socket),
      (error) => this.rejectFailure(error),
      this.initialHistoryInClientContent,
    );
    this.sockets.add(socket);
    return socket;
  }

  closeAll(): void {
    for (const socket of [...this.sockets]) socket.terminate();
    this.sockets.clear();
  }
}

function cancellationError(): Error {
  const error = new Error("The Live SDK connection was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Uses the reviewed SDK transforms and Session implementation while replacing
 * its private Node socket factory with an attempt-owned socket. SDK 2.16.0 does
 * not settle `live.connect()` when abort/close happens before setupComplete;
 * this adapter races that promise and always terminates the owned socket.
 */
export function createOwnedGoogleLiveConnector(
  createClient: () => GoogleGenAI,
): GeminiLiveConnector {
  return async (params) => {
    const signal = params.config?.abortSignal;
    if (signal?.aborted) throw cancellationError();
    const client = createClient();
    const live = client.live as unknown as SdkLiveWithReplaceableFactory;
    const factory = new AbortOwnedWebSocketFactory(
      signal,
      params.config?.historyConfig?.initialHistoryInClientContent === true,
    );
    live.webSocketFactory = factory;

    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      rejectAbort(cancellationError());
      factory.closeAll();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const session = await Promise.race([
        live.connect(params as LiveConnectParameters),
        aborted,
        factory.failure,
      ]);
      return {
        sendClientContent: (value) => session.sendClientContent(value),
        sendRealtimeInput: (value) => session.sendRealtimeInput(value),
        sendToolResponse: (value) => session.sendToolResponse(value),
        close: () => {
          try {
            session.close();
          } finally {
            factory.closeAll();
          }
        },
      };
    } catch (error) {
      factory.closeAll();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export function createOwnedGoogleGenAIConnector(
  options: GoogleGenAIOptions,
): GeminiLiveConnector {
  return createOwnedGoogleLiveConnector(() => new GoogleGenAI(options));
}

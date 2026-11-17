import type { FunctionDeclaration } from "@google/genai";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

/**
 * Shared seam for Aiden Live's own function tools (chat tools, app control,
 * ending the session). Computer Use keeps its dedicated bridge; every other
 * Live tool is a provider registered here so the service dispatches by name.
 */
export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LiveToolResponse = Record<string, unknown>;

export interface LiveToolContext {
  readonly sessionId: string;
  readonly owner: RendererDocumentOwner;
  /** Aborted when the call is cancelled, the user interrupts, or the session ends. */
  readonly signal: AbortSignal;
}

export interface LiveToolProvider {
  /** Function declarations this provider owns. Names must be unique across providers. */
  readonly declarations: readonly FunctionDeclaration[];
  /** Extra system-instruction lines Live should follow while these tools exist. */
  readonly instructions?: readonly string[];
  handle(call: LiveToolCall, context: LiveToolContext): Promise<LiveToolResponse>;
  /** The user's voice interrupted Live; in-flight work that should stop must stop. */
  interrupt?(): void;
  close?(): void;
}

export interface LiveToolPrepareInput {
  owner: RendererDocumentOwner;
  sessionId: string;
  signal: AbortSignal;
  /** Sends a renderer-executed tool request for this session (see LiveRendererToolBroker). */
  renderer: LiveRendererToolBroker;
}

export const LIVE_TOOL_ERROR = {
  unknown: "tool_unavailable",
  failed: "tool_failed",
  cancelled: "cancelled",
  timeout: "timeout",
  outcomeUnknown: "outcome_unknown",
} as const;

export function liveToolError(code: string, message: string): LiveToolResponse {
  return { ok: false, error: { code, message } };
}

/**
 * A mutating request reached the window but its result never came back. It
 * may have been carried out, so Live must not repeat it blindly.
 */
export function liveToolOutcomeUnknown(): LiveToolResponse {
  return {
    ...liveToolError(
      LIVE_TOOL_ERROR.outcomeUnknown,
      "Aiden couldn't confirm whether that went through. Check the chat before trying again; do not resend it.",
    ),
    committed: true,
  };
}

/**
 * `committed: true` marks a result whose action was (or may have been) carried
 * out. The registry reports it even when the call was cancelled meanwhile, so
 * Live never hears "cancelled" about something that happened.
 */
export function isCommittedLiveToolResponse(response: LiveToolResponse): boolean {
  return response.committed === true;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** Dispatches Live function calls to the provider that declared the name. */
export class LiveToolRegistry {
  private readonly byName = new Map<string, LiveToolProvider>();
  private readonly inFlight = new Map<string, AbortController>();
  private closed = false;

  constructor(
    private readonly providers: readonly LiveToolProvider[],
    private readonly context: Omit<LiveToolContext, "signal">,
  ) {
    for (const provider of providers) {
      for (const declaration of provider.declarations) {
        const name = declaration.name;
        if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
          throw new Error("Live tool names must be lower snake case.");
        }
        if (this.byName.has(name)) throw new Error(`Duplicate Live tool: ${name}`);
        this.byName.set(name, provider);
      }
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Declarations in provider order, ready for LiveConnectConfig.tools. */
  functionDeclarations(): FunctionDeclaration[] {
    return this.providers.flatMap((provider) => [...provider.declarations]);
  }

  instructions(): string[] {
    return this.providers.flatMap((provider) => [...(provider.instructions ?? [])]);
  }

  /**
   * Runs one call. Always resolves with a response object; a provider that
   * throws is reported to Live as a fixed failure without its message, because
   * provider errors can carry paths or user content.
   */
  async dispatch(call: LiveToolCall): Promise<LiveToolResponse> {
    const provider = this.byName.get(call.name);
    if (!provider || this.closed) {
      return liveToolError(LIVE_TOOL_ERROR.unknown, "That tool is not available in this Live session.");
    }
    const abort = new AbortController();
    this.inFlight.set(call.id, abort);
    try {
      const response = await provider.handle(call, { ...this.context, signal: abort.signal });
      if (abort.signal.aborted && !isCommittedLiveToolResponse(response)) {
        return liveToolError(LIVE_TOOL_ERROR.cancelled, "The request was cancelled.");
      }
      return response;
    } catch {
      if (abort.signal.aborted) {
        return liveToolError(LIVE_TOOL_ERROR.cancelled, "The request was cancelled.");
      }
      return liveToolError(LIVE_TOOL_ERROR.failed, "The tool could not finish.");
    } finally {
      if (this.inFlight.get(call.id) === abort) this.inFlight.delete(call.id);
    }
  }

  cancel(id: string): void {
    this.inFlight.get(id)?.abort();
  }

  interrupt(): void {
    for (const provider of this.providers) provider.interrupt?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const abort of this.inFlight.values()) abort.abort();
    this.inFlight.clear();
    for (const provider of this.providers) {
      try {
        provider.close?.();
      } catch {
        // Teardown continues for every provider.
      }
    }
  }
}

/** Renderer event that asks the attended window to run one renderer-side tool. */
export interface LiveRendererToolRequest {
  type: "tool_request";
  sessionId: string;
  requestId: string;
  name: string;
  args: Record<string, unknown>;
}

const DEFAULT_RENDERER_TOOL_TIMEOUT_MS = 30_000;
/** How long a cancelled mutating request waits for the window's real outcome. */
const DEFAULT_RENDERER_CANCEL_GRACE_MS = 2_000;
const MAX_PENDING_RENDERER_TOOLS = 8;

export interface LiveRendererToolRequestOptions {
  /**
   * The tool changes something (sends, stops, opens). Once the window has the
   * request, a cancel or timeout waits briefly for its real outcome and
   * otherwise reports `outcome_unknown`, never `cancelled`.
   */
  mutating?: boolean;
}

/**
 * Correlates renderer-executed tool requests with their results. The renderer
 * owns the chat on screen and the DOM, so chat and highlight tools run there;
 * main validates the result shape and enforces a timeout.
 */
export class LiveRendererToolBroker {
  private readonly pending = new Map<
    string,
    { resolve: (response: LiveToolResponse) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly sendToRenderer: (request: LiveRendererToolRequest | { type: "tool_cancel"; sessionId: string; requestId: string }) => void,
    private readonly timeoutMs = DEFAULT_RENDERER_TOOL_TIMEOUT_MS,
    private readonly cancelGraceMs = DEFAULT_RENDERER_CANCEL_GRACE_MS,
  ) {}

  request(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options: LiveRendererToolRequestOptions = {},
  ): Promise<LiveToolResponse> {
    if (this.closed) {
      return Promise.resolve(liveToolError(LIVE_TOOL_ERROR.cancelled, "The Live session ended."));
    }
    if (this.pending.size >= MAX_PENDING_RENDERER_TOOLS) {
      return Promise.resolve(liveToolError(LIVE_TOOL_ERROR.failed, "Too many requests are waiting."));
    }
    this.sequence += 1;
    const requestId = `r${this.sequence}`;
    return new Promise((resolve) => {
      let forwarded = false;
      let givenUp = false;
      const finish = (response: LiveToolResponse) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      // The window's answer. One that arrives after a mutating request was
      // given up on is its real outcome: anything but its own "cancelled"
      // means it happened.
      const answer = (response: LiveToolResponse) => {
        const cancelledThere =
          (response.error as { code?: unknown } | undefined)?.code === LIVE_TOOL_ERROR.cancelled;
        finish(givenUp && !cancelledThere ? { ...response, committed: true } : response);
      };
      const giveUp = (fallback: LiveToolResponse) => {
        const entry = this.pending.get(requestId);
        if (!entry || givenUp) return;
        givenUp = true;
        signal?.removeEventListener("abort", onAbort);
        if (forwarded) {
          try {
            this.sendToRenderer({ type: "tool_cancel", sessionId: this.sessionId, requestId });
          } catch {
            // The window is gone; the result below still resolves.
          }
        }
        if (!forwarded || !options.mutating) {
          finish(fallback);
          return;
        }
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => finish(liveToolOutcomeUnknown()), this.cancelGraceMs);
      };
      const onAbort = () => giveUp(liveToolError(LIVE_TOOL_ERROR.cancelled, "The request was cancelled."));
      const timer = setTimeout(
        () => giveUp(liveToolError(LIVE_TOOL_ERROR.timeout, "Aiden's window did not answer in time.")),
        this.timeoutMs,
      );
      this.pending.set(requestId, { resolve: answer, timer });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.sendToRenderer({ type: "tool_request", sessionId: this.sessionId, requestId, name, args });
        forwarded = true;
      } catch {
        finish(liveToolError(LIVE_TOOL_ERROR.failed, "Aiden's window is not available."));
      }
    });
  }

  /** Returns false when the request is unknown or already settled. */
  resolve(requestId: string, response: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve(
      response && typeof response === "object" && !Array.isArray(response)
        ? (response as LiveToolResponse)
        : liveToolError(LIVE_TOOL_ERROR.failed, "Aiden's window sent an invalid result."),
    );
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Each entry's resolver clears its own timer, listener and map slot.
    for (const entry of [...this.pending.values()]) {
      entry.resolve(liveToolError(LIVE_TOOL_ERROR.cancelled, "The Live session ended."));
    }
  }
}

// Shared renderer seam for Aiden Live. The Live hook publishes the current
// session and the user's finalized speech here; chat panes, the approval
// layer and app control subscribe without importing the hook, and register the
// renderer-side tools main asks for.

export type LiveRendererToolResult = Record<string, unknown>;

export interface LiveRendererToolContext {
  sessionId: string;
  signal: AbortSignal;
  /**
   * The handler is about to carry the action out (a send handed to the chat).
   * Check `signal` right before calling it. From then on a cancel no longer
   * hides the result: the bus reports the real outcome when it arrives.
   */
  commit(): void;
  /**
   * Runs `listener` once this result has been handed to main, which passes it
   * straight on to Live. It does not run when the result never goes out (a
   * cancel answered first, or a session that changed).
   */
  afterReport?(listener: () => void): void;
}

export type LiveRendererToolHandler = (
  args: Record<string, unknown>,
  context: LiveRendererToolContext,
) => Promise<LiveRendererToolResult> | LiveRendererToolResult;

export interface LiveSessionTransport {
  toolResult(sessionId: string, requestId: string, response: LiveRendererToolResult): Promise<boolean>;
  note(sessionId: string, text: string, options?: LiveNoteOptions): Promise<boolean>;
}

export interface LiveNoteOptions {
  /**
   * Resolve only once main has handed this note to Live, and false if it was
   * refused, dropped or cleared first. Without it, true means only "queued".
   */
  awaitDelivery?: boolean;
}

/** One finalized utterance from the user's microphone, in arrival order. */
export interface LiveVoiceInput {
  /** Monotonic within the renderer; later speech always has a larger id. */
  id: number;
  /**
   * Start mark taken when the utterance's first fragment arrived, on the
   * same counter as `voiceInputFence()`. Speech already under way at a fence
   * has a mark at or below it, however late it finishes.
   */
  startedAt: number;
  text: string;
}

type Listener<T> = (value: T) => void;

function toolError(code: string, message: string): LiveRendererToolResult {
  return { ok: false, error: { code, message } };
}

export class LiveSessionBus {
  private sessionId: string | null = null;
  private transport: LiveSessionTransport | null = null;
  private readonly sessionListeners = new Set<Listener<string | null>>();
  private readonly voiceListeners = new Set<Listener<LiveVoiceInput>>();
  private readonly fenceListeners = new Set<Listener<number>>();
  private readonly tools = new Map<string, LiveRendererToolHandler>();
  private readonly inFlight = new Map<string, { abort: AbortController; committed: boolean; reported: boolean }>();
  private lastVoiceInputId = 0;
  private lastVoiceStart = 0;

  /** Called by the Live hook whenever its session starts or ends. */
  setSession(sessionId: string | null, transport: LiveSessionTransport | null): void {
    if (this.sessionId === sessionId && this.transport === transport) return;
    if (this.sessionId !== sessionId) {
      for (const entry of this.inFlight.values()) entry.abort.abort();
      this.inFlight.clear();
    }
    this.sessionId = sessionId;
    this.transport = sessionId ? transport : null;
    for (const listener of [...this.sessionListeners]) listener(sessionId);
  }

  currentSessionId(): string | null {
    return this.sessionId;
  }

  onSession(listener: Listener<string | null>): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  /** Latest voice input id seen so far; speech after a prompt has a larger id. */
  latestVoiceInputId(): number {
    return this.lastVoiceInputId;
  }

  /** Called on an utterance's first fragment; its mark goes with the finished input. */
  beginVoiceInput(): number {
    return ++this.lastVoiceStart;
  }

  /** Latest start mark: only speech that begins after this point has a larger `startedAt`. */
  voiceInputFence(): number {
    const fence = this.lastVoiceStart;
    for (const listener of [...this.fenceListeners]) listener(fence);
    return fence;
  }

  /** Called with each fence as it is taken (the microphone's onset tracker listens). */
  onVoiceInputFence(listener: Listener<number>): () => void {
    this.fenceListeners.add(listener);
    return () => this.fenceListeners.delete(listener);
  }

  /** Publishes a finished utterance; without a start mark it counts as starting now. */
  publishVoiceInput(text: string, startedAt?: number): LiveVoiceInput {
    const input = { id: ++this.lastVoiceInputId, startedAt: startedAt ?? this.beginVoiceInput(), text };
    for (const listener of [...this.voiceListeners]) listener(input);
    return input;
  }

  onVoiceInput(listener: Listener<LiveVoiceInput>): () => void {
    this.voiceListeners.add(listener);
    return () => this.voiceListeners.delete(listener);
  }

  /** Sends a short spoken-update note to Live; false when no session or it was dropped. */
  async note(text: string, options?: LiveNoteOptions): Promise<boolean> {
    const sessionId = this.sessionId;
    const transport = this.transport;
    if (!sessionId || !transport) return false;
    try {
      return await (options ? transport.note(sessionId, text, options) : transport.note(sessionId, text));
    } catch {
      return false;
    }
  }

  /** Registers the window-side handler for one Live tool; the last registration wins. */
  registerTool(name: string, handler: LiveRendererToolHandler): () => void {
    this.tools.set(name, handler);
    return () => {
      if (this.tools.get(name) === handler) this.tools.delete(name);
    };
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Runs one tool request from main and reports its result exactly once. */
  async runToolRequest(request: {
    sessionId: string;
    requestId: string;
    name: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    const transport = this.transport;
    if (!transport || request.sessionId !== this.sessionId) return;
    const handler = this.tools.get(request.name);
    const entry = {
      abort: new AbortController(),
      committed: false,
      reported: false,
      afterReport: [] as Array<() => void>,
    };
    this.inFlight.set(request.requestId, entry);
    let response: LiveRendererToolResult;
    try {
      response = handler
        ? await handler(request.args, {
            sessionId: request.sessionId,
            signal: entry.abort.signal,
            commit: () => {
              entry.committed = true;
            },
            afterReport: (listener) => {
              entry.afterReport.push(listener);
            },
          })
        : toolError("tool_unavailable", "That part of Aiden is not open right now.");
    } catch {
      response = toolError("tool_failed", "The action could not finish.");
    } finally {
      if (this.inFlight.get(request.requestId) === entry) this.inFlight.delete(request.requestId);
    }
    // A cancel before the commit was already answered; after it, the real
    // outcome still goes to main.
    if (entry.reported || (entry.abort.signal.aborted && !entry.committed)) return;
    if (request.sessionId !== this.sessionId) return;
    entry.reported = true;
    await this.report(transport, request.sessionId, request.requestId, response);
    // A failed hand-off may still have reached Live, so the listeners run either way.
    for (const listener of entry.afterReport) {
      try {
        listener();
      } catch {
        // One listener's failure does not skip the others.
      }
    }
  }

  /**
   * Main gave up on a request (the call was cancelled or timed out). One that
   * has not committed is answered "cancelled" at once; a committed one keeps
   * running and reports what really happened.
   */
  cancelToolRequest(sessionId: string, requestId: string): void {
    if (sessionId !== this.sessionId) return;
    const entry = this.inFlight.get(requestId);
    if (!entry) return;
    entry.abort.abort();
    if (entry.committed || entry.reported) return;
    entry.reported = true;
    this.inFlight.delete(requestId);
    const transport = this.transport;
    if (transport) {
      void this.report(transport, sessionId, requestId, toolError("cancelled", "The request was cancelled."));
    }
  }

  private async report(
    transport: LiveSessionTransport,
    sessionId: string,
    requestId: string,
    response: LiveRendererToolResult,
  ): Promise<void> {
    try {
      await transport.toolResult(sessionId, requestId, response);
    } catch {
      // Main times the request out on its side.
    }
  }
}

export const liveSessionBus = new LiveSessionBus();

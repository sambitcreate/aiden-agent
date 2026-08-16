import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export const PI_RUNTIME_EVENT_VERSION = 1 as const;

export type PiRuntimeLane = "foreground" | "child";

export interface PiRuntimeIdentity {
  runId: string;
  sessionId: string;
  lane: PiRuntimeLane;
  parentRunId?: string;
}

/** Closed, renderer-safe projection. Tool arguments/results, reasoning, diagnostics, and errors stay private. */
export type PiRuntimeAgentEvent =
  | { type: "agent_start" | "agent_end" | "turn_start" }
  | { type: "turn_end"; messageRole: AgentMessage["role"]; toolResultCount: number }
  | {
      type: "message_start" | "message_end";
      messageRole: AgentMessage["role"];
      stopReason?: string;
    }
  | {
      type: "message_update";
      update:
        | "start"
        | "text_start"
        | "text_delta"
        | "text_end"
        | "thinking_start"
        | "thinking_delta"
        | "thinking_end"
        | "toolcall_start"
        | "toolcall_delta"
        | "toolcall_end"
        | "done"
        | "error";
      contentIndex?: number;
      /** Only public assistant prose is projected; hidden reasoning/tool JSON is never included. */
      delta?: string;
      reason?: string;
    }
  | { type: "tool_execution_start" | "tool_execution_update"; toolCallId: string; toolName: string }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

export function projectPiRuntimeAgentEvent(event: AgentEvent): PiRuntimeAgentEvent {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
      return { type: event.type };
    case "turn_end":
      return {
        type: event.type,
        messageRole: event.message.role,
        toolResultCount: event.toolResults.length,
      };
    case "message_start":
    case "message_end":
      return {
        type: event.type,
        messageRole: event.message.role,
        ...(event.message.role === "assistant" ? { stopReason: event.message.stopReason } : {}),
      };
    case "message_update": {
      const update = event.assistantMessageEvent;
      return {
        type: event.type,
        update: update.type,
        ...(Object.prototype.hasOwnProperty.call(update, "contentIndex")
          ? { contentIndex: (update as { contentIndex: number }).contentIndex }
          : {}),
        ...(update.type === "text_delta" ? { delta: update.delta } : {}),
        ...(update.type === "done" || update.type === "error" ? { reason: update.reason } : {}),
      };
    }
    case "tool_execution_start":
    case "tool_execution_update":
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
  }
}

export type PiRuntimeEventPayload =
  | { type: "run_start"; input: "append-and-run" | "continue-durable-tail" }
  | { type: "agent_event"; event: PiRuntimeAgentEvent; durable: boolean }
  | {
      type: "retry";
      attempt: 2;
      reason: "provider" | "overflow";
      delayMs: number;
    }
  | {
      type: "run_end";
      outcome: "completed" | "app_cancelled" | "provider_failed" | "host_failed";
      attempts: 0 | 1 | 2;
      reason?: string;
    };

export interface PiRuntimeEventEnvelope {
  version: typeof PI_RUNTIME_EVENT_VERSION;
  identity: PiRuntimeIdentity;
  sequence: number;
  attempt: 0 | 1 | 2;
  turn: { id: string; index: number } | null;
  timestamp: number;
  payload: PiRuntimeEventPayload;
}

export interface PiRuntimeEventState {
  lastSequence: number;
  phase: "idle" | "running" | "settled";
  attempt: 0 | 1 | 2;
  turnIndex: number;
  durableMessageCount: number;
  activeToolCalls: ReadonlySet<string>;
  outcome?: Extract<PiRuntimeEventPayload, { type: "run_end" }>;
}

export function initialPiRuntimeEventState(): PiRuntimeEventState {
  return {
    lastSequence: 0,
    phase: "idle",
    attempt: 0,
    turnIndex: -1,
    durableMessageCount: 0,
    activeToolCalls: new Set(),
  };
}

/** Pure critical reducer. Projection observers never own this state. */
export function reducePiRuntimeEventState(
  state: PiRuntimeEventState,
  envelope: PiRuntimeEventEnvelope,
): PiRuntimeEventState {
  if (envelope.sequence !== state.lastSequence + 1) {
    throw new Error("Pi runtime event sequence is not contiguous.");
  }
  const activeToolCalls = new Set(state.activeToolCalls);
  let phase = state.phase;
  let turnIndex = state.turnIndex;
  let durableMessageCount = state.durableMessageCount;
  let outcome = state.outcome;
  if (envelope.payload.type === "run_start") {
    if (state.phase === "running") throw new Error("Pi runtime run start was duplicated.");
    phase = "running";
    turnIndex = -1;
    activeToolCalls.clear();
    outcome = undefined;
  } else if (envelope.payload.type === "agent_event") {
    const event = envelope.payload.event;
    if (event.type === "turn_start") turnIndex += 1;
    if (event.type === "tool_execution_start") activeToolCalls.add(event.toolCallId);
    if (event.type === "tool_execution_end") activeToolCalls.delete(event.toolCallId);
    if (event.type === "message_end" && envelope.payload.durable) durableMessageCount += 1;
  } else if (envelope.payload.type === "run_end") {
    phase = "settled";
    activeToolCalls.clear();
    outcome = envelope.payload;
  }
  return {
    lastSequence: envelope.sequence,
    phase,
    attempt: envelope.attempt,
    turnIndex,
    durableMessageCount,
    activeToolCalls,
    ...(outcome ? { outcome } : {}),
  };
}

export type PiRuntimeEventObserver = (
  event: PiRuntimeEventEnvelope,
  signal: AbortSignal,
) => Promise<void> | void;

/**
 * Main-process canonical event channel. The reducer runs synchronously first;
 * ordered observers are cloned, best-effort, and cannot delay or fail the run.
 */
export class PiRuntimeEventChannel {
  private static readonly MAX_PENDING_OBSERVER_EVENTS = 256;
  private state = initialPiRuntimeEventState();
  private sequence = 0;
  private attempt: 0 | 1 | 2 = 0;
  private turnIndex = -1;
  private readonly observers = new Set<PiRuntimeEventObserver>();
  private readonly observerQueue: Array<{
    envelope: PiRuntimeEventEnvelope;
    observers: readonly PiRuntimeEventObserver[];
  }> = [];
  private observerDrain: Promise<void> | undefined;
  private readonly observerAbort = new AbortController();

  readonly identity: Readonly<PiRuntimeIdentity>;

  constructor(
    identity: PiRuntimeIdentity,
    private readonly onObserverError: (error: unknown) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.identity = Object.freeze(structuredClone(identity));
  }

  observe(observer: PiRuntimeEventObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  setAttempt(attempt: 0 | 1 | 2): void {
    this.attempt = attempt;
  }

  emit(payload: PiRuntimeEventPayload): PiRuntimeEventEnvelope {
    if (payload.type === "run_start") {
      this.turnIndex = -1;
    } else if (payload.type === "agent_event" && payload.event.type === "turn_start") {
      this.turnIndex += 1;
    }
    const envelope: PiRuntimeEventEnvelope = {
      version: PI_RUNTIME_EVENT_VERSION,
      identity: { ...this.identity },
      sequence: ++this.sequence,
      attempt: this.attempt,
      turn:
        this.turnIndex < 0
          ? null
          : {
              id: `${this.identity.runId}:turn:${this.turnIndex}`,
              index: this.turnIndex,
            },
      timestamp: this.now(),
      payload: structuredClone(payload),
    };
    this.state = reducePiRuntimeEventState(this.state, envelope);
    const observers = [...this.observers];
    if (observers.length > 0) {
      if (this.observerQueue.length >= PiRuntimeEventChannel.MAX_PENDING_OBSERVER_EVENTS) {
        this.observerQueue.shift();
      }
      this.observerQueue.push({ envelope: structuredClone(envelope), observers });
      this.startObserverDrain();
    }
    return envelope;
  }

  snapshot(): PiRuntimeEventState {
    return {
      ...this.state,
      activeToolCalls: new Set(this.state.activeToolCalls),
      ...(this.state.outcome ? { outcome: structuredClone(this.state.outcome) } : {}),
    };
  }

  async settleObservers(): Promise<void> {
    for (;;) {
      const drain = this.observerDrain;
      if (!drain) {
        if (this.observerQueue.length === 0) return;
        this.startObserverDrain();
        continue;
      }
      await drain;
    }
  }

  close(): void {
    this.observerAbort.abort(new Error("Pi runtime event observation ended."));
    this.observers.clear();
    this.observerQueue.splice(0);
  }

  private startObserverDrain(): void {
    if (this.observerDrain || this.observerQueue.length === 0) return;
    const drain = (async () => {
      while (!this.observerAbort.signal.aborted) {
        const next = this.observerQueue.shift();
        if (!next) return;
        for (const observer of next.observers) {
          try {
            await observer(structuredClone(next.envelope), this.observerAbort.signal);
          } catch (error) {
            try {
              this.onObserverError(error);
            } catch {
              // Diagnostics are observational too.
            }
          }
        }
      }
    })();
    this.observerDrain = drain;
    void drain.finally(() => {
      if (this.observerDrain === drain) this.observerDrain = undefined;
      this.startObserverDrain();
    });
  }
}

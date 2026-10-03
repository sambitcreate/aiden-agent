import type { ServerResponse } from "node:http";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";
import {
  parseToolApprovalScope,
  type ToolApprovalScope,
} from "../../renderer/shared/tool-approval-scope.js";
import {
  ASSISTANT_AUTOMATION_EDIT_TOOL_NAME,
  ASSISTANT_AUTOMATION_TOOL_NAME,
  isAssistantAutomationApprovalDetails,
  isScheduledTaskApprovalDetails,
  isSubagentMcpMutationApprovalDetails,
  isSubagentShellApprovalDetails,
  isSubagentRunGrantApprovalDetails,
  isSubagentWorkspaceWriteApprovalDetails,
} from "../../renderer/shared/assistant.js";
import {
  createRemoteChatGenerationOwner,
  type RemoteChatGenerationOwnerController,
} from "./chat-generation-owner.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AIDEN_REMOTE_PROTOCOL_VERSION,
  parseAidenRemoteStreamEvent,
  parseAidenRemoteStreamInputRequest,
  type AidenRemoteCapability,
  type AidenRemotePendingQuestion,
  type AidenRemoteQuestionRespondRequest,
  type AidenRemoteRunInputMode,
  type AidenRemoteStreamInputResult,
} from "./aiden-remote-protocol.js";
import {
  ASK_USER_QUESTION_VERSION,
  parseAskUserQuestions,
  parseAskUserQuestionResponse,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../../renderer/shared/ask-user-question.js";
import type {
  ChatRunInputAdmissionRequest,
  ChatRunInputAdmissionResult,
} from "./chat-run-input-admission.js";
import {
  boundedText,
  createRunProjectionState,
  ownRecord,
  projectRunContentNotification,
  type RunProjectionState,
} from "./run-event-projection.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  AidenOperationContractError,
} from "./aiden-remote-operation-contract.js";

const MAX_STREAMS = 256;
const STREAM_DRAIN_TIMEOUT_MS = 30_000;
const MAX_EVENTS_PER_STREAM = 4_096;
const MAX_STREAM_EVENT_BYTES = 8 * 1_024 * 1_024;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PERSIST_COALESCE_MS = 250;
const IMMEDIATE_PERSIST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval_required",
  "question_required",
  "cancelled",
  "snapshot",
]);
const APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;
const QUESTION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_ACTIVITY_PROJECTION_CHATS = 200;
export const MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES = 16 * 1_024 * 1_024;

export type AidenRemoteStreamState =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "reconciling"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface AidenRemoteStreamEvent {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface AidenRemoteStreamStatus {
  streamId: string;
  chatId: string;
  turnId: string;
  state: AidenRemoteStreamState;
  lastSequence: number;
  updatedAt: string;
}

export interface AidenRemoteApprovalResolution {
  approvalId: string;
  decision: "allow" | "deny";
  /** Echoed only when the request chose a scope (contract revision 17). */
  scope?: ToolApprovalScope;
  resolvedAt: string;
}

export interface AidenRemotePendingApproval {
  approvalId: string;
  streamId: string;
  chatId: string;
  summary: string;
  toolCallId: string;
  toolName: string;
  expiresAt: string;
  canAllow: boolean;
  /**
   * Allow scopes this approval offers (contract revision 17). Present only
   * when a broader-than-once scope is available; "once" is always implied.
   */
  scopes?: ToolApprovalScope[];
  /** Exact renderer-safe facts are host-only and never enter the mobile wire contract. */
  details?: ToolApprovalDetails;
}

export type AidenRemoteChatActivityProjection =
  | {
      chatId: string;
      activityState: "waiting_for_approval";
      /** True only when this exact paired device owns the pending approval. */
      canRespondToApproval: boolean;
    }
  | {
      chatId: string;
      activityState: "idle" | "queued" | "running" | "reconciling";
      canRespondToApproval: false;
    };

export interface AidenRemoteStreamSnapshot {
  version: 1;
  streams: Array<{
    streamId: string;
    chatId: string;
    turnId: string;
    deviceId: string;
    state: AidenRemoteStreamState;
    updatedAt: number;
    events: AidenRemoteStreamEvent[];
  }>;
  /**
   * Durable public turn identities for remote-created generations. Stream
   * records are pruned after terminal retention, but progress rosters must
   * keep echoing the issued `turnId` for as long as the chat's durable agent
   * history survives.
   */
  turnIndex?: Array<{ streamId: string; chatId: string; turnId: string }>;
}

interface StreamSubscriber {
  flush(): void;
  close(): void;
}

interface StreamRecord {
  streamId: string;
  chatId: string;
  turnId: string;
  deviceId: string;
  state: AidenRemoteStreamState;
  updatedAt: number;
  events: AidenRemoteStreamEvent[];
  eventBytes: number;
  subscribers: Set<StreamSubscriber>;
  evictAfterDelivery?: boolean;
  owner: RemoteChatGenerationOwnerController;
  cancelRequested: boolean;
  cancellationSource: "device" | "server";
  projection: RunProjectionState;
}

interface ApprovalRecord {
  streamId: string;
  deviceId: string;
  ownerDocumentId: string;
  chatId: string;
  summary: string;
  toolCallId: string;
  toolName: string;
  canAllow: boolean;
  scopes?: ToolApprovalScope[];
  details?: ToolApprovalDetails;
  expiresAt: number;
  expiry: ReturnType<typeof setTimeout>;
}

interface QuestionRecord {
  streamId: string;
  deviceId: string;
  ownerDocumentId: string;
  chatId: string;
  toolCallId: string;
  questions: AskUserQuestionV1[];
  expiresAt: number;
  expiry: ReturnType<typeof setTimeout>;
}

function approvalDetails(value: unknown): ToolApprovalDetails | undefined {
  return isAssistantAutomationApprovalDetails(value)
    || isScheduledTaskApprovalDetails(value)
    || isSubagentWorkspaceWriteApprovalDetails(value)
    || isSubagentMcpMutationApprovalDetails(value)
    || isSubagentShellApprovalDetails(value)
    || isSubagentRunGrantApprovalDetails(value)
    ? structuredClone(value)
    : undefined;
}

/** Keep only known scopes, in canonical order, and only when broader than once. */
function offeredScopes(value: unknown): ToolApprovalScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = new Set(value.map(parseToolApprovalScope));
  const scopes = (["once", "chat", "always"] as const).filter((scope) => parsed.has(scope));
  return scopes.some((scope) => scope !== "once")
    ? (["once", ...scopes.filter((scope) => scope !== "once")] as ToolApprovalScope[])
    : undefined;
}

function approvalIsHostOnly(details: ToolApprovalDetails | undefined): boolean {
  return details !== undefined && details.kind !== "scheduled-task";
}

function terminal(state: AidenRemoteStreamState): boolean {
  return state === "done" || state === "error" || state === "cancelled" || state === "interrupted";
}

/**
 * Older v1 journals stored timeline activity as a single renderer-safe label.
 * Normalize that one known local-storage shape without accepting it on the
 * current Remote wire contract or relaxing validation for any other field.
 */
function normalizeLegacyTimelineEvent(value: unknown): unknown {
  const event = ownRecord(value);
  const payload = ownRecord(event?.payload);
  if (event?.type !== "timeline" || !payload || !("label" in payload)) return value;

  const keys = Object.keys(payload);
  if (
    keys.some((key) => key !== "label" && key !== "timeline") ||
    typeof payload.label !== "string" ||
    payload.label.length === 0 ||
    payload.label.length > 120
  ) {
    return value;
  }

  if ("timeline" in payload) {
    return {
      ...event,
      payload: { timeline: structuredClone(payload.timeline) },
    };
  }

  if (
    typeof event.streamId !== "string" ||
    !Number.isSafeInteger(event.sequence) ||
    Number(event.sequence) < 1 ||
    typeof event.timestamp !== "string"
  ) {
    return value;
  }
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return value;
  const sequence = Number(event.sequence);
  const label = payload.label;
  const step = label === "Thinking"
    ? {
        id: `think-${sequence}`,
        order: 0,
        kind: "thinking" as const,
        startedAt: timestamp,
        updatedAt: timestamp,
      }
    : {
        id: `tool-${sequence}`,
        order: 0,
        kind: "tool" as const,
        toolCallId: `call-${sequence}`,
        toolName: "legacy_activity",
        label,
        status: "running" as const,
        startedAt: timestamp,
        updatedAt: timestamp,
      };
  return {
    ...event,
    payload: {
      timeline: {
        version: 2,
        generationId: event.streamId,
        status: "running",
        startedAt: timestamp,
        steps: [step],
      },
    },
  };
}

function parseSnapshot(value: unknown): AidenRemoteStreamSnapshot {
  const record = ownRecord(value);
  if (
    !record ||
    record.version !== 1 ||
    !Array.isArray(record.streams) ||
    record.streams.length > MAX_STREAMS ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES
  ) {
    throw new Error("Invalid Aiden Remote stream snapshot.");
  }
  const streamIds = new Set<string>();
  const streams: AidenRemoteStreamSnapshot["streams"] = [];
  for (const raw of record.streams) {
    const stream = ownRecord(raw);
    if (
      !stream ||
      Object.keys(stream).some((key) => !["streamId", "chatId", "turnId", "deviceId", "state", "updatedAt", "events"].includes(key)) ||
      !["streamId", "chatId", "turnId", "deviceId", "state", "updatedAt", "events"].every((key) => Object.prototype.hasOwnProperty.call(stream, key)) ||
      typeof stream.streamId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(stream.streamId) ||
      streamIds.has(stream.streamId) ||
      typeof stream.chatId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(stream.chatId) ||
      typeof stream.turnId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(stream.turnId) ||
      typeof stream.deviceId !== "string" ||
      stream.deviceId.length === 0 ||
      stream.deviceId.length > 128 ||
      typeof stream.state !== "string" ||
      !["queued", "running", "waiting_for_approval", "reconciling", "done", "error", "cancelled", "interrupted"].includes(stream.state) ||
      !Number.isSafeInteger(stream.updatedAt) ||
      Number(stream.updatedAt) < 0 ||
      !Array.isArray(stream.events) ||
      stream.events.length > MAX_EVENTS_PER_STREAM
    ) {
      throw new Error("Invalid Aiden Remote stream snapshot.");
    }
    let previous = 0;
    const events = stream.events.map((rawEvent) => {
      const normalizedEvent = normalizeLegacyTimelineEvent(rawEvent);
      const event = ownRecord(normalizedEvent);
      const payload = ownRecord(event?.payload);
      if (
        !event ||
        !payload ||
        event.protocolVersion !== AIDEN_REMOTE_PROTOCOL_VERSION ||
        event.streamId !== stream.streamId ||
        !Number.isSafeInteger(event.sequence) ||
        (previous === 0
          ? Number(event.sequence) < 1
          : Number(event.sequence) !== previous + 1) ||
        typeof event.timestamp !== "string" ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        typeof event.type !== "string" ||
        event.type.length === 0 ||
        event.type.length > 80 ||
        typeof event.terminal !== "boolean" ||
        !parseAidenRemoteStreamEvent(normalizedEvent)
      ) {
        throw new Error("Invalid Aiden Remote stream snapshot.");
      }
      previous = Number(event.sequence);
      return structuredClone(normalizedEvent) as AidenRemoteStreamEvent;
    });
    streamIds.add(stream.streamId);
    streams.push({
      streamId: stream.streamId,
      chatId: stream.chatId,
      turnId: stream.turnId,
      deviceId: stream.deviceId,
      state: stream.state as AidenRemoteStreamState,
      updatedAt: stream.updatedAt as number,
      events,
    });
  }
  const identifier = /^[A-Za-z0-9._:-]{1,128}$/u;
  const turnIndex: NonNullable<AidenRemoteStreamSnapshot["turnIndex"]> = [];
  if (record.turnIndex !== undefined) {
    if (!Array.isArray(record.turnIndex) || record.turnIndex.length > MAX_STREAMS * 4) {
      throw new Error("Invalid Aiden Remote stream snapshot.");
    }
    const indexed = new Set<string>();
    for (const rawEntry of record.turnIndex) {
      const entry = ownRecord(rawEntry);
      if (
        !entry ||
        Object.keys(entry).some((key) => !["streamId", "chatId", "turnId"].includes(key)) ||
        typeof entry.streamId !== "string" ||
        !identifier.test(entry.streamId) ||
        indexed.has(entry.streamId) ||
        typeof entry.chatId !== "string" ||
        !identifier.test(entry.chatId) ||
        typeof entry.turnId !== "string" ||
        !identifier.test(entry.turnId)
      ) {
        throw new Error("Invalid Aiden Remote stream snapshot.");
      }
      indexed.add(entry.streamId);
      turnIndex.push({
        streamId: entry.streamId,
        chatId: entry.chatId,
        turnId: entry.turnId,
      });
    }
  }
  return { version: 1, streams, turnIndex };
}

export function normalizeAidenRemoteStreamSnapshot(value: unknown): AidenRemoteStreamSnapshot {
  return parseSnapshot(value);
}

export function removeRevokedDeviceStreams(
  value: unknown,
  revokedDeviceIds: ReadonlySet<string>,
): AidenRemoteStreamSnapshot {
  const snapshot = parseSnapshot(value);
  return {
    version: 1,
    streams: snapshot.streams.filter(({ deviceId }) => !revokedDeviceIds.has(deviceId)),
    // Turn identities are per-chat public facts other paired devices still
    // need for roster correlation after the issuing device is revoked.
    turnIndex: snapshot.turnIndex,
  };
}

function sseFrame(event: AidenRemoteStreamEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class AidenRemoteStreamService {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly eventSizes = new WeakMap<AidenRemoteStreamEvent, number>();
  private readonly turnIndex = new Map<string, { chatId: string; turnId: string }>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly questions = new Map<string, QuestionRecord>();
  private persistTail: Promise<void> = Promise.resolve();
  private persistDirty = false;
  private persistRunning = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceError: unknown;
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(
    private readonly options: {
      now(): number;
      cancel(streamId: string, ownerDocumentId: string): boolean;
      approve(
        approvalId: string,
        decision: "allow" | "deny",
        ownerDocumentId: string,
        scope?: ToolApprovalScope,
      ): boolean;
      /**
       * Host-owned foreground admission (Remote Slice 2). When absent the
       * `/streams/{id}/inputs` route is unadvertised and returns not_found.
       */
      submitInput?(
        input: ChatRunInputAdmissionRequest & { chatId: string },
      ): Promise<ChatRunInputAdmissionResult>;
      /**
       * Host-owned questionnaire settlement. When absent the
       * `/questions/{id}/respond` route is unadvertised and returns not_found.
       */
      respondQuestion?(
        promptId: string,
        response: AskUserQuestionResponseV1,
        ownerDocumentId: string,
      ): boolean;
      notifyChatChanged?: (chatId: string) => void;
      notifyApprovalChanged?: (chatId: string) => void;
      snapshot?: AidenRemoteStreamSnapshot;
      persist?: (snapshot: AidenRemoteStreamSnapshot) => Promise<void>;
      /**
       * Streaming content (deltas, timeline, tool progress) is journaled at
       * most this many milliseconds (default 250) after it arrives; terminal,
       * prompt, cancel, snapshot and state-change events are written at once.
       * A crash can therefore lose up to this window of non-boundary events;
       * restart still recovers the stream as `server_interrupted`.
       */
      persistCoalesceMs?: number;
      idempotency?: AidenIdempotencyLedger;
      persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
      onPersistenceError?: (error: unknown) => void;
    },
  ) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger();
    if (options.snapshot) this.restore(options.snapshot);
  }

  private async executeIdempotent<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!/^[\x21-\x7e]{16,128}$/u.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    if (!this.options.persistIdempotency) {
      try {
        return await this.idempotency.execute(scope, input, action);
      } catch (error) {
        return this.mapIdempotencyError(error);
      }
    }
    let admit!: () => void;
    let reject!: (error: unknown) => void;
    const durable = new Promise<void>((resolve, rejectPromise) => {
      admit = resolve;
      reject = rejectPromise;
    });
    // Replays never invoke the wrapper: keep a sink so a rejected gate cannot
    // surface as an unhandled rejection.
    void durable.catch(() => undefined);
    let actionGated = false;
    const pending = this.idempotency.execute(scope, input, async () => {
      actionGated = true;
      await durable;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      admit();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
      // Only discard when this call created the entry: the wrapper ran but the
      // action provably never did (admit() was never called), so nothing could
      // have committed. Replays and concurrent in-flight entries keep their
      // recorded outcome intact.
      if (actionGated) this.idempotency.discardUnexecuted(scope);
      throw new AidenRemoteServiceError("internal_error", "Aiden could not prepare this stream request.", 500);
    }
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await pending;
    } catch (error) {
      failure = error;
    }
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
    } catch {
      throw new AidenRemoteServiceError("idempotency_in_flight", "The stream request outcome is unknown.", 409);
    }
    if (failure) throw failure;
    return result!;
  }

  private mapIdempotencyError(error: unknown): never {
    if (error instanceof AidenRemoteServiceError) throw error;
    if (error instanceof AidenOperationContractError) {
      throw new AidenRemoteServiceError(
        error.code,
        "This stream request cannot be safely repeated.",
        error.code === "idempotency_capacity" ? 429 : 409,
      );
    }
    throw error;
  }

  private ownerFor(record: Omit<StreamRecord, "owner">): RemoteChatGenerationOwnerController {
    return createRemoteChatGenerationOwner({
      deviceId: record.deviceId,
      streamId: record.streamId,
      publish: (channel, payload) => this.projectNotification(this.streams.get(record.streamId)!, channel, payload),
    });
  }

  private restore(snapshot: AidenRemoteStreamSnapshot): void {
    const parsed = parseSnapshot(snapshot);
    for (const entry of parsed.turnIndex ?? []) {
      this.indexTurn(entry.streamId, entry.chatId, entry.turnId);
    }
    for (const saved of parsed.streams) {
      const base: Omit<StreamRecord, "owner"> = {
        ...saved,
        eventBytes: saved.events.reduce(
          (total, event) => total + this.eventSize(event),
          0,
        ),
        subscribers: new Set(),
        cancelRequested: false,
        cancellationSource: "server",
        projection: createRunProjectionState(),
      };
      const record: StreamRecord = { ...base, owner: this.ownerFor(base) };
      this.streams.set(record.streamId, record);
      this.indexTurn(record.streamId, record.chatId, record.turnId);
      if (!terminal(record.state)) {
        this.append(
          record,
          "error",
          { code: "server_interrupted", message: "Aiden restarted before this response finished." },
          true,
          "interrupted",
        );
      }
    }
  }

  private indexTurn(streamId: string, chatId: string, turnId: string): void {
    if (this.turnIndex.has(streamId)) return;
    // Bounded oldest-first eviction; the index outlives stream records.
    if (this.turnIndex.size >= MAX_STREAMS * 4) {
      this.turnIndex.delete(this.turnIndex.keys().next().value!);
    }
    this.turnIndex.set(streamId, { chatId, turnId });
  }

  private snapshotEnvelope(): AidenRemoteStreamSnapshot {
    return {
      version: 1,
      streams: [...this.streams.values()].map((stream) => ({
        streamId: stream.streamId,
        chatId: stream.chatId,
        turnId: stream.turnId,
        deviceId: stream.deviceId,
        state: stream.state,
        updatedAt: stream.updatedAt,
        events: [],
      })),
      turnIndex: [...this.turnIndex.entries()].map(([streamId, entry]) => ({
        streamId,
        chatId: entry.chatId,
        turnId: entry.turnId,
      })),
    };
  }

  snapshot(): AidenRemoteStreamSnapshot {
    const snapshot = this.snapshotEnvelope();
    for (const stream of snapshot.streams) {
      stream.events = structuredClone(this.streams.get(stream.streamId)!.events);
    }
    return snapshot;
  }

  private eventSize(event: AidenRemoteStreamEvent): number {
    let bytes = this.eventSizes.get(event);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      this.eventSizes.set(event, bytes);
    }
    return bytes;
  }

  private snapshotBytes(): number {
    // Serialize only bounded metadata (256 streams / 1,024 turn identities).
    // The empty arrays already include brackets; add event bytes and commas.
    // Rebuilding this envelope keeps deletion, expiry and delivery cleanup from
    // having to maintain a second, fragile aggregate mutation ledger.
    let bytes = Buffer.byteLength(JSON.stringify(this.snapshotEnvelope()), "utf8");
    for (const stream of this.streams.values()) {
      bytes += stream.eventBytes + Math.max(0, stream.events.length - 1);
    }
    return bytes;
  }

  private persist(): void {
    if (!this.options.persist) return;
    // The snapshot taken below already includes any coalesced events.
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persistDirty = true;
    if (this.persistRunning) return;
    this.persistRunning = true;
    this.persistTail = (async () => {
      while (this.persistDirty) {
        this.persistDirty = false;
        await this.options.persist!(this.snapshot());
        this.persistenceError = undefined;
      }
    })()
      .catch((error: unknown) => {
        this.persistenceError = error;
        this.options.onPersistenceError?.(error);
      })
      .finally(() => {
        this.persistRunning = false;
        if (this.persistDirty) this.persist();
      });
  }

  private schedulePersist(): void {
    if (!this.options.persist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, this.options.persistCoalesceMs ?? DEFAULT_PERSIST_COALESCE_MS);
    this.persistTimer.unref?.();
  }

  async settlePersistence(): Promise<void> {
    while (this.persistTimer || this.persistRunning || this.persistDirty) {
      if (this.persistTimer) this.persist();
      await this.persistTail;
    }
    if (this.persistenceError) throw this.persistenceError;
  }

  private prune(): void {
    const now = this.options.now();
    for (const [approvalId, approval] of this.approvals) {
      if (approval.expiresAt <= now) {
        this.resolveApproval(approvalId, "deny");
      }
    }
    for (const [promptId, question] of this.questions) {
      if (question.expiresAt <= now) {
        this.resolveQuestion(promptId, {
          version: ASK_USER_QUESTION_VERSION,
          promptId,
          cancelled: true,
          answers: [],
        });
      }
    }
    for (const [streamId, stream] of this.streams) {
      if (terminal(stream.state) && stream.updatedAt + TERMINAL_RETENTION_MS <= now) {
        stream.owner.invalidate();
        for (const subscriber of stream.subscribers) {
          subscriber.close();
        }
        this.streams.delete(streamId);
      }
    }
  }

  private pendingApprovalForStream(streamId: string): AidenRemotePendingApproval | undefined {
    const approval = [...this.approvals.entries()].find(([, entry]) => entry.streamId === streamId);
    if (!approval) return undefined;
    const [approvalId, entry] = approval;
    return {
      approvalId,
      streamId: entry.streamId,
      chatId: entry.chatId,
      summary: entry.summary,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      canAllow: entry.canAllow,
      ...(entry.canAllow && entry.scopes ? { scopes: [...entry.scopes] } : {}),
      ...(entry.details ? { details: structuredClone(entry.details) } : {}),
    };
  }

  private resolveApproval(
    approvalId: string,
    decision: "allow" | "deny",
    scope?: ToolApprovalScope,
  ): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;
    clearTimeout(approval.expiry);
    const effectiveScope =
      decision === "allow" && scope && scope !== "once" && approval.scopes?.includes(scope)
        ? scope
        : undefined;
    const resolved = effectiveScope
      ? this.options.approve(approvalId, decision, approval.ownerDocumentId, effectiveScope)
      : this.options.approve(approvalId, decision, approval.ownerDocumentId);
    this.approvals.delete(approvalId);
    const stream = this.streams.get(approval.streamId);
    const nextApproval = stream ? this.pendingApprovalForStream(stream.streamId) : undefined;
    const nextQuestion = !nextApproval && stream
      ? this.pendingQuestionForStream(stream.streamId)
      : undefined;
    if (stream && !terminal(stream.state)) {
      if (!resolved) {
        this.append(stream, "status", { state: "reconciling" }, false, "reconciling");
      } else if (nextApproval) {
        this.append(
          stream,
          "approval_required",
          {
            approvalId: nextApproval.approvalId,
            summary: nextApproval.summary,
            expiresAt: nextApproval.expiresAt,
          },
          false,
          "waiting_for_approval",
        );
      } else if (nextQuestion) {
        // A question may share the stream's waiting_for_approval state;
        // resolving the approval must not drop the surviving prompt.
        this.append(
          stream,
          "question_required",
          {
            promptId: nextQuestion.promptId,
            questions: nextQuestion.questions,
            expiresAt: nextQuestion.expiresAt,
          },
          false,
          "waiting_for_approval",
        );
      } else {
        this.append(stream, "status", { state: "running" }, false, "running");
      }
    }
    this.options.notifyApprovalChanged?.(approval.chatId);
    return resolved;
  }

  private pendingQuestionForStream(streamId: string): AidenRemotePendingQuestion | undefined {
    const found = [...this.questions.entries()].find(([, entry]) => entry.streamId === streamId);
    if (!found) return undefined;
    const [promptId, entry] = found;
    return {
      promptId,
      streamId: entry.streamId,
      chatId: entry.chatId,
      toolCallId: entry.toolCallId,
      questions: structuredClone(entry.questions),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  private resolveQuestion(
    promptId: string,
    response: AskUserQuestionResponseV1 | "settled_by_host",
  ): boolean {
    const question = this.questions.get(promptId);
    if (!question) return false;
    clearTimeout(question.expiry);
    const resolved = response === "settled_by_host"
      ? true
      : this.options.respondQuestion
        ? this.options.respondQuestion(promptId, response, question.ownerDocumentId)
        : false;
    this.questions.delete(promptId);
    const stream = this.streams.get(question.streamId);
    const nextQuestion = stream ? this.pendingQuestionForStream(stream.streamId) : undefined;
    const nextApproval = !nextQuestion && stream
      ? this.pendingApprovalForStream(stream.streamId)
      : undefined;
    if (stream && !terminal(stream.state)) {
      if (!resolved) {
        this.append(stream, "status", { state: "reconciling" }, false, "reconciling");
      } else if (nextQuestion) {
        this.append(
          stream,
          "question_required",
          {
            promptId: nextQuestion.promptId,
            questions: nextQuestion.questions,
            expiresAt: nextQuestion.expiresAt,
          },
          false,
          "waiting_for_approval",
        );
      } else if (nextApproval) {
        // An approval may share the stream's waiting_for_approval state;
        // resolving the question must not drop the surviving prompt.
        this.append(
          stream,
          "approval_required",
          {
            approvalId: nextApproval.approvalId,
            summary: nextApproval.summary,
            expiresAt: nextApproval.expiresAt,
          },
          false,
          "waiting_for_approval",
        );
      } else {
        this.append(stream, "status", { state: "running" }, false, "running");
      }
    }
    this.options.notifyApprovalChanged?.(question.chatId);
    return resolved;
  }

  private requireStream(deviceId: string, streamId: string): StreamRecord {
    this.prune();
    const stream = this.streams.get(streamId);
    if (!stream || stream.deviceId !== deviceId) {
      throw new AidenRemoteServiceError("not_found", "This Aiden stream is unavailable.", 404);
    }
    return stream;
  }

  create(deviceId: string, streamId: string, chatId: string, turnId: string): RemoteChatGenerationOwnerController {
    this.prune();
    if (this.streams.has(streamId)) {
      throw new AidenRemoteServiceError("already_exists", "That stream already exists.", 409);
    }
    if (this.streams.size >= MAX_STREAMS) {
      throw new AidenRemoteServiceError("rate_limited", "Too many remote streams are retained.", 429, true);
    }
    const base: Omit<StreamRecord, "owner"> = {
      streamId,
      chatId,
      turnId,
      deviceId,
      state: "queued",
      updatedAt: this.options.now(),
      events: [],
      eventBytes: 0,
      subscribers: new Set(),
      cancelRequested: false,
      cancellationSource: "device",
      projection: createRunProjectionState(),
    };
    const owner = this.ownerFor(base);
    const record: StreamRecord = { ...base, owner };
    this.streams.set(streamId, record);
    this.indexTurn(streamId, chatId, turnId);
    this.append(record, "status", { state: "queued" }, false, "queued");
    return owner;
  }

  private append(
    stream: StreamRecord,
    type: string,
    payload: Record<string, unknown>,
    isTerminal: boolean,
    state?: AidenRemoteStreamState,
  ): AidenRemoteStreamEvent {
    if (terminal(stream.state)) return stream.events[stream.events.length - 1]!;
    // A new journal, any state transition, and every event a client must not
    // miss across a crash are durable boundaries; plain content is coalesced.
    const boundary =
      isTerminal ||
      IMMEDIATE_PERSIST_EVENT_TYPES.has(type) ||
      stream.events.length === 0 ||
      (state !== undefined && state !== stream.state);
    const event: AidenRemoteStreamEvent = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      streamId: stream.streamId,
      sequence: (stream.events[stream.events.length - 1]?.sequence ?? 0) + 1,
      timestamp: new Date(this.options.now()).toISOString(),
      type,
      terminal: isTerminal,
      // Journal events own their payload: callers must not invalidate cached
      // sizes (or change already-published replay) by mutating nested values.
      payload: structuredClone(payload),
    };
    const bytes = this.eventSize(event);
    stream.events.push(event);
    stream.eventBytes += bytes;
    while (
      stream.events.length > MAX_EVENTS_PER_STREAM ||
      (stream.eventBytes > MAX_STREAM_EVENT_BYTES && stream.events.length > 1)
    ) {
      const removed = stream.events.shift();
      if (removed) stream.eventBytes -= this.eventSize(removed);
    }
    stream.state = state ?? stream.state;
    stream.updatedAt = this.options.now();
    this.enforceAggregateBudget(stream.streamId);
    for (const subscriber of [...stream.subscribers]) subscriber.flush();
    if (isTerminal) {
      stream.owner.invalidate();
      for (const [approvalId, approval] of this.approvals) {
        if (approval.streamId === stream.streamId) {
          clearTimeout(approval.expiry);
          this.approvals.delete(approvalId);
          this.options.notifyApprovalChanged?.(approval.chatId);
        }
      }
      for (const [promptId, question] of this.questions) {
        if (question.streamId === stream.streamId) {
          clearTimeout(question.expiry);
          this.questions.delete(promptId);
          this.options.notifyApprovalChanged?.(question.chatId);
        }
      }
      this.options.notifyChatChanged?.(stream.chatId);
    }
    if (boundary) this.persist();
    else this.schedulePersist();
    return event;
  }

  private enforceAggregateBudget(currentStreamId: string): void {
    if (this.snapshotBytes() <= MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) return;
    const terminalStreams = [...this.streams.values()]
      .filter((entry) => entry.streamId !== currentStreamId && terminal(entry.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const entry of terminalStreams) {
      if (entry.subscribers.size > 0 || entry.evictAfterDelivery) {
        // Keep accepted terminal bytes and replay state until delivery settles.
        // A disconnected or timed-out subscriber may not have received it.
        // Defer until successful delivery or normal retention expiry, even if
        // further pressure arrives with no subscribers. Trimming still bounds
        // journal bytes; undelivered records legitimately consume stream slots.
        entry.evictAfterDelivery = true;
        continue;
      }
      entry.owner.invalidate();
      this.streams.delete(entry.streamId);
      if (this.snapshotBytes() <= MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) return;
    }
    while (this.snapshotBytes() > MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) {
      const candidate = [...this.streams.values()]
        .filter((entry) => entry.events.length > 0)
        .sort((left, right) => right.eventBytes - left.eventBytes)[0];
      if (!candidate) break;
      if (candidate.events.length > 1) {
        const removed = candidate.events.shift();
        if (removed) candidate.eventBytes -= this.eventSize(removed);
        continue;
      }
      const retained = candidate.events[0]!;
      if (retained.terminal || retained.type === "snapshot") break;
      const replacement: AidenRemoteStreamEvent = {
        ...retained,
        type: "snapshot",
        payload: {
          chatId: candidate.chatId,
          turnId: candidate.turnId,
          nextSequence: retained.sequence + 1,
        },
      };
      candidate.events[0] = replacement;
      candidate.eventBytes = this.eventSize(replacement);
    }
  }

  private projectNotification(
    stream: StreamRecord,
    channel: NotificationChannel,
    rawPayload: unknown,
  ): void {
    const payload = ownRecord(rawPayload) ?? {};
    if (channel === "chat:approval") {
      const approvalId = boundedText(payload.approvalId, 128);
      if (!approvalId) return;
      const previousApproval = this.approvals.get(approvalId);
      if (previousApproval) clearTimeout(previousApproval.expiry);
      const summary = boundedText(payload.summary, 2_000) || "Aiden needs approval.";
      const toolCallId = boundedText(payload.toolCallId, 128) || "remote-tool";
      const toolName = boundedText(payload.toolName, 120) || "Tool";
      const details = approvalDetails(payload.details);
      const claimsStructuredDetails = ownRecord(payload.details)?.kind !== undefined;
      const scopes = offeredScopes(payload.scopes);
      const expiresAt = this.options.now() + APPROVAL_LIFETIME_MS;
      const expiry = setTimeout(() => {
        const current = this.approvals.get(approvalId);
        if (!current || current.expiresAt !== expiresAt) return;
        this.resolveApproval(approvalId, "deny");
      }, APPROVAL_LIFETIME_MS);
      expiry.unref?.();
      this.approvals.set(approvalId, {
        streamId: stream.streamId,
        deviceId: stream.deviceId,
        ownerDocumentId: stream.owner.owner.documentId,
        chatId: stream.chatId,
        summary,
        toolCallId,
        toolName,
        canAllow: !claimsStructuredDetails || details !== undefined,
        ...(scopes ? { scopes } : {}),
        ...(details ? { details } : {}),
        expiresAt,
        expiry,
      });
      this.append(
        stream,
        "approval_required",
        {
          approvalId,
          summary,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        false,
        "waiting_for_approval",
      );
      this.options.notifyApprovalChanged?.(stream.chatId);
      return;
    }
    if (channel === "chat:questionnaire") {
      // The publish payload is produced by the main-owned questionnaire
      // coordinator. Remote stream ids do not share the renderer "s-" prefix,
      // so the full prompt parser cannot run here; bind the prompt to this
      // stream and re-validate the bounded question grammar instead.
      const promptId = boundedText(payload.promptId, 128);
      const questions = parseAskUserQuestions(payload.questions);
      if (
        !promptId ||
        !questions ||
        payload.streamId !== stream.streamId ||
        !boundedText(payload.toolCallId, 128)
      ) {
        throw new Error("The questionnaire prompt is not bound to this stream.");
      }
      if (this.questions.has(promptId) || this.pendingQuestionForStream(stream.streamId)) {
        throw new Error("A questionnaire is already pending on this stream.");
      }
      // The coordinator stamps the agent-facing deadline on the prompt. Use it
      // so the phone card expires at the instant the agent stops waiting, but
      // never extend past the Remote question lifetime.
      const now = this.options.now();
      const agentDeadline =
        typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
      const expiresAt = Number.isFinite(agentDeadline)
        ? Math.min(Math.max(agentDeadline, now), now + QUESTION_LIFETIME_MS)
        : now + QUESTION_LIFETIME_MS;
      const expiry = setTimeout(() => {
        const current = this.questions.get(promptId);
        if (!current || current.expiresAt !== expiresAt) return;
        // The host settles a past-deadline prompt as timed out, not closed.
        this.resolveQuestion(promptId, {
          version: ASK_USER_QUESTION_VERSION,
          promptId,
          cancelled: true,
          answers: [],
        });
      }, expiresAt - now);
      expiry.unref?.();
      this.questions.set(promptId, {
        streamId: stream.streamId,
        deviceId: stream.deviceId,
        ownerDocumentId: stream.owner.owner.documentId,
        chatId: stream.chatId,
        toolCallId: boundedText(payload.toolCallId, 128),
        questions,
        expiresAt,
        expiry,
      });
      this.append(
        stream,
        "question_required",
        {
          promptId,
          questions: structuredClone(questions),
          expiresAt: new Date(expiresAt).toISOString(),
        },
        false,
        "waiting_for_approval",
      );
      this.options.notifyApprovalChanged?.(stream.chatId);
      return;
    }
    const projected = projectRunContentNotification(stream.projection, channel, payload, {
      chatId: stream.chatId,
      turnId: stream.turnId,
      lastSequence: stream.events[stream.events.length - 1]?.sequence ?? 0,
      cancelRequested: stream.cancelRequested,
      cancellationSource: stream.cancellationSource,
    });
    if (projected.kind === "event") {
      this.append(stream, projected.type, projected.payload, projected.terminal, projected.state);
    }
  }

  markRunning(deviceId: string, streamId: string): void {
    const stream = this.requireStream(deviceId, streamId);
    this.append(stream, "status", { state: "running" }, false, "running");
  }

  markStartError(deviceId: string, streamId: string, error: unknown): void {
    const stream = this.requireStream(deviceId, streamId);
    if (stream.cancelRequested) {
      this.append(
        stream,
        "cancelled",
        { source: stream.cancellationSource },
        true,
        "cancelled",
      );
      return;
    }
    void error;
    this.append(
      stream,
      "error",
      {
        code: "internal_error",
        message: "Aiden could not start this response.",
      },
      true,
      "error",
    );
  }

  /** Server-side identity correlation; not a device-authorized read. */
  turnIdFor(chatId: string, streamId: string): string | undefined {
    const stream = this.streams.get(streamId);
    if (stream) return stream.chatId === chatId ? stream.turnId : undefined;
    const indexed = this.turnIndex.get(streamId);
    return indexed?.chatId === chatId ? indexed.turnId : undefined;
  }

  status(deviceId: string, streamId: string): AidenRemoteStreamStatus {
    const stream = this.requireStream(deviceId, streamId);
    return {
      streamId: stream.streamId,
      chatId: stream.chatId,
      turnId: stream.turnId,
      state: stream.state,
      lastSequence: stream.events[stream.events.length - 1]?.sequence ?? 0,
      updatedAt: new Date(stream.updatedAt).toISOString(),
    };
  }

  /**
   * Project a bounded inbox batch with one stream-registry scan. This does not
   * expose stream ids, turn ids, event payloads, or another device's approval
   * authority.
   */
  projectChatActivities(
    deviceId: string,
    chatIds: readonly string[],
  ): AidenRemoteChatActivityProjection[] {
    this.prune();
    if (
      typeof deviceId !== "string" ||
      deviceId.length === 0 ||
      deviceId.length > 128 ||
      chatIds.length > MAX_ACTIVITY_PROJECTION_CHATS ||
      new Set(chatIds).size !== chatIds.length ||
      chatIds.some((chatId) => !/^[A-Za-z0-9._:-]{1,128}$/u.test(chatId))
    ) {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "The Bot inbox activity request is invalid.",
        400,
      );
    }
    const requested = new Set(chatIds);
    const latest = new Map<string, StreamRecord>();
    for (const stream of this.streams.values()) {
      if (!requested.has(stream.chatId) || terminal(stream.state)) continue;
      const retained = latest.get(stream.chatId);
      if (
        !retained ||
        stream.updatedAt > retained.updatedAt ||
        (stream.updatedAt === retained.updatedAt && stream.streamId > retained.streamId)
      ) {
        latest.set(stream.chatId, stream);
      }
    }
    return chatIds.map((chatId) => {
      const stream = latest.get(chatId);
      if (!stream) {
        return { chatId, activityState: "idle", canRespondToApproval: false };
      }
      if (stream.state === "waiting_for_approval") {
        const approval = this.pendingApprovalForStream(stream.streamId);
        return {
          chatId,
          activityState: "waiting_for_approval",
          canRespondToApproval:
            approval !== undefined &&
            stream.deviceId === deviceId &&
            approval.expiresAt > new Date(this.options.now()).toISOString(),
        };
      }
      if (
        stream.state === "queued" ||
        stream.state === "running" ||
        stream.state === "reconciling"
      ) {
        return {
          chatId,
          activityState: stream.state,
          canRespondToApproval: false,
        };
      }
      return { chatId, activityState: "idle", canRespondToApproval: false };
    });
  }

  streamChatId(deviceId: string, streamId: string): string {
    return this.requireStream(deviceId, streamId).chatId;
  }

  pendingApproval(deviceId: string, streamId: string): AidenRemotePendingApproval | null {
    const stream = this.requireStream(deviceId, streamId);
    const approval = this.pendingApprovalForStream(stream.streamId);
    if (!approval) return null;
    const { details: _hostOnly, scopes, ...mobile } = approval;
    const canAllow = approvalIsHostOnly(approval.details) ? false : approval.canAllow;
    return {
      ...mobile,
      canAllow,
      ...(canAllow && scopes ? { scopes } : {}),
    };
  }

  approvalChatId(deviceId: string, approvalId: string): string {
    this.prune();
    const approval = this.approvals.get(approvalId);
    if (
      !approval ||
      approval.deviceId !== deviceId ||
      approval.expiresAt <= this.options.now()
    ) {
      throw new AidenRemoteServiceError(
        "approval_expired",
        "This approval is no longer available.",
        409,
      );
    }
    return approval.chatId;
  }

  approvalRequiredCapability(
    deviceId: string,
    approvalId: string,
  ): AidenRemoteCapability | undefined {
    this.prune();
    const approval = this.approvals.get(approvalId);
    if (
      !approval ||
      approval.deviceId !== deviceId ||
      approval.expiresAt <= this.options.now()
    ) {
      throw new AidenRemoteServiceError(
        "approval_expired",
        "This approval is no longer available.",
        409,
      );
    }
    return approval.toolName === ASSISTANT_AUTOMATION_TOOL_NAME ||
      approval.toolName === ASSISTANT_AUTOMATION_EDIT_TOOL_NAME
      ? "schedule:write"
      : undefined;
  }

  pendingQuestion(deviceId: string, streamId: string): AidenRemotePendingQuestion | null {
    const stream = this.requireStream(deviceId, streamId);
    return this.pendingQuestionForStream(stream.streamId) ?? null;
  }

  questionChatId(deviceId: string, promptId: string): string {
    this.prune();
    const question = this.questions.get(promptId);
    if (
      !question ||
      question.deviceId !== deviceId ||
      question.expiresAt <= this.options.now()
    ) {
      throw new AidenRemoteServiceError(
        "question_expired",
        "This question is no longer available.",
        409,
      );
    }
    return question.chatId;
  }

  supportsQuestionPrompts(): boolean {
    return this.options.respondQuestion !== undefined;
  }

  /**
   * `runAccess` wraps the router's chat-access mutation around the fresh
   * resolution and stays inside the ledger action so a settled outcome still
   * replays after the question record is resolved away. Required so no
   * caller can silently skip authorization (tests pass a passthrough).
   */
  async respondQuestion(
    deviceId: string,
    promptId: string,
    input: AidenRemoteQuestionRespondRequest,
    key: string,
    runAccess: (
      chatId: string,
      action: () => Promise<{ promptId: string; resolvedAt: string }>,
    ) => Promise<{ promptId: string; resolvedAt: string }>,
  ): Promise<{ promptId: string; resolvedAt: string }> {
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /questions/{id}/respond", resourceId: promptId, key },
        { promptId, cancelled: input.cancelled, answers: input.answers },
        async () => {
          this.prune();
          const question = this.questions.get(promptId);
          if (!question || question.deviceId !== deviceId || question.expiresAt <= this.options.now()) {
            throw new AidenRemoteServiceError(
              "question_expired",
              "This question is no longer available.",
              409,
            );
          }
          const response = parseAskUserQuestionResponse(
            {
              version: ASK_USER_QUESTION_VERSION,
              promptId,
              cancelled: input.cancelled,
              answers: input.answers,
            },
            {
              version: ASK_USER_QUESTION_VERSION,
              promptId,
              streamId: question.streamId,
              toolCallId: question.toolCallId,
              questions: question.questions,
            },
          );
          if (!response) {
            throw new AidenRemoteServiceError(
              "invalid_request",
              "The question response is invalid.",
              400,
            );
          }
          return runAccess(question.chatId, async () => {
            if (!this.resolveQuestion(promptId, response)) {
              throw new AidenRemoteServiceError(
                "question_already_resolved",
                "This question was already resolved.",
                409,
              );
            }
            return { promptId, resolvedAt: new Date(this.options.now()).toISOString() };
          });
        },
      );
    } catch (error) {
      return this.mapIdempotencyError(error);
    }
  }

  pendingApprovalForChat(chatId: string): AidenRemotePendingApproval | null {
    this.prune();
    for (const stream of this.streams.values()) {
      if (stream.chatId !== chatId || terminal(stream.state)) continue;
      const approval = this.pendingApprovalForStream(stream.streamId);
      if (approval) return approval;
    }
    return null;
  }

  respondApprovalFromHost(
    chatId: string,
    approvalId: string,
    decision: "allow" | "deny",
    scope?: ToolApprovalScope,
  ): boolean {
    this.prune();
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.chatId !== chatId || approval.expiresAt <= this.options.now()) {
      return false;
    }
    return this.resolveApproval(approvalId, decision, scope);
  }

  /**
   * A paired controller already settled this device-owned question through
   * host authority. Retire the device record and advance the device stream
   * exactly as an owner answer would, without settling the prompt twice.
   */
  retireQuestionSettledByHost(promptId: string): void {
    this.resolveQuestion(promptId, "settled_by_host");
  }

  async cancel(deviceId: string, streamId: string, key: string): Promise<AidenRemoteStreamStatus> {
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /streams/{id}/cancel", resourceId: streamId, key },
        { streamId },
        async () => {
          const stream = this.requireStream(deviceId, streamId);
          if (!terminal(stream.state) && !stream.cancelRequested) {
            stream.cancelRequested = true;
            stream.cancellationSource = "device";
            for (const [approvalId, approval] of [...this.approvals]) {
              if (approval.streamId !== stream.streamId) continue;
              clearTimeout(approval.expiry);
              this.options.approve(approvalId, "deny", approval.ownerDocumentId);
              this.approvals.delete(approvalId);
              this.options.notifyApprovalChanged?.(approval.chatId);
            }
            for (const [promptId, question] of [...this.questions]) {
              if (question.streamId !== stream.streamId) continue;
              clearTimeout(question.expiry);
              this.options.respondQuestion?.(
                promptId,
                {
                  version: ASK_USER_QUESTION_VERSION,
                  promptId,
                  cancelled: true,
                  answers: [],
                },
                question.ownerDocumentId,
              );
              this.questions.delete(promptId);
              this.options.notifyApprovalChanged?.(question.chatId);
            }
            this.options.cancel(streamId, stream.owner.owner.documentId);
            this.append(stream, "status", { state: "reconciling" }, false, "reconciling");
          }
          return this.status(deviceId, streamId);
        },
      );
    } catch (error) {
      return this.mapIdempotencyError(error);
    }
  }

  /** True only while the host wires the main-owned run-input admission path. */
  supportsRunInput(): boolean {
    return this.options.submitInput !== undefined;
  }

  /**
   * Feature-gated shared foreground admission (Remote Slice 2). Domain
   * rejections resolve as `status: "rejected"` so the durable idempotency
   * ledger replays the original admission outcome for a retried request UUID.
   * `runAccess` wraps fresh admissions in the router's chat-access validation;
   * it stays inside the ledger action so a settled outcome still replays after
   * the stream record is evicted or the chat becomes unavailable. Required so
   * no caller can silently skip authorization (tests pass a passthrough).
   */
  async submitInput(
    deviceId: string,
    streamId: string,
    rawInput: unknown,
    key: string,
    runAccess: (
      chatId: string,
      action: () => Promise<AidenRemoteStreamInputResult>,
    ) => Promise<AidenRemoteStreamInputResult>,
  ): Promise<AidenRemoteStreamInputResult> {
    let parsed: { mode: AidenRemoteRunInputMode; text: string };
    try {
      parsed = parseAidenRemoteStreamInputRequest(rawInput);
    } catch {
      throw new AidenRemoteServiceError(
        "invalid_request",
        "The stream input request is invalid.",
        400,
      );
    }
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /streams/{id}/inputs", resourceId: streamId, key },
        { streamId, mode: parsed.mode, text: parsed.text },
        async () => {
          const stream = this.requireStream(deviceId, streamId);
          const execute = async (): Promise<AidenRemoteStreamInputResult> => {
            const base = {
              streamId: stream.streamId,
              chatId: stream.chatId,
              turnId: stream.turnId,
              mode: parsed.mode,
            } as const;
            if (terminal(stream.state)) {
              return {
                ...base,
                status: "rejected" as const,
                reason: "run_not_active" as const,
                committed: false,
              };
            }
            if (stream.cancelRequested) {
              return {
                ...base,
                status: "rejected" as const,
                reason: "cancelled" as const,
                committed: false,
              };
            }
            if (!this.options.submitInput) {
              throw new AidenRemoteServiceError(
                "not_found",
                "This endpoint is unavailable.",
                404,
              );
            }
            const admission = await this.options.submitInput({
              streamId: stream.streamId,
              chatId: stream.chatId,
              mode: parsed.mode,
              text: parsed.text,
              ownerDocumentId: stream.owner.owner.documentId,
            });
            // A queued input while a prompt is pending does not resume the
            // run — emitting running would clobber waiting_for_approval and
            // hide the outstanding approval/question from clients.
            if (
              admission.admitted &&
              !this.pendingApprovalForStream(stream.streamId) &&
              !this.pendingQuestionForStream(stream.streamId)
            ) {
              this.append(stream, "status", { state: "running" }, false, "running");
            }
            if (admission.committed) {
              this.options.notifyChatChanged?.(stream.chatId);
            }
            return {
              ...base,
              status: admission.admitted ? ("admitted" as const) : ("rejected" as const),
              ...(admission.queue === undefined ? {} : { queue: admission.queue }),
              ...(admission.reason === undefined ? {} : { reason: admission.reason }),
              committed: admission.committed,
              ...(admission.messageId === undefined
                ? {}
                : { messageId: admission.messageId }),
            };
          };
          return runAccess(stream.chatId, execute);
        },
      );
    } catch (error) {
      return this.mapIdempotencyError(error);
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    for (const [approvalId, approval] of this.approvals) {
      if (approval.deviceId !== deviceId) continue;
      clearTimeout(approval.expiry);
      this.options.approve(approvalId, "deny", approval.ownerDocumentId);
      this.approvals.delete(approvalId);
      this.options.notifyApprovalChanged?.(approval.chatId);
    }
    for (const [promptId, question] of this.questions) {
      if (question.deviceId !== deviceId) continue;
      clearTimeout(question.expiry);
      this.options.respondQuestion?.(
        promptId,
        { version: ASK_USER_QUESTION_VERSION, promptId, cancelled: true, answers: [] },
        question.ownerDocumentId,
      );
      this.questions.delete(promptId);
      this.options.notifyApprovalChanged?.(question.chatId);
    }
    for (const [streamId, stream] of this.streams) {
      if (stream.deviceId !== deviceId) continue;
      if (!terminal(stream.state)) {
        stream.cancelRequested = true;
        stream.cancellationSource = "server";
        this.options.cancel(stream.streamId, stream.owner.owner.documentId);
        this.append(stream, "cancelled", { source: "server" }, true, "cancelled");
      }
      stream.owner.invalidate();
      stream.projection.activeTools.clear();
      for (const subscriber of stream.subscribers) {
        subscriber.close();
      }
      stream.subscribers.clear();
      this.streams.delete(streamId);
    }
    this.persist();
    await this.settlePersistence();
  }

  async respondApproval(
    deviceId: string,
    approvalId: string,
    decision: "allow" | "deny",
    key: string,
    runAccess: (
      chatId: string,
      action: () => Promise<AidenRemoteApprovalResolution>,
    ) => Promise<AidenRemoteApprovalResolution>,
    scope?: ToolApprovalScope,
  ): Promise<AidenRemoteApprovalResolution> {
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /approvals/{id}/respond", resourceId: approvalId, key },
        scope ? { approvalId, decision, scope } : { approvalId, decision },
        async () => {
          this.prune();
          const approval = this.approvals.get(approvalId);
          if (!approval || approval.deviceId !== deviceId || approval.expiresAt <= this.options.now()) {
            throw new AidenRemoteServiceError("approval_expired", "This approval is no longer available.", 409);
          }
          if (decision === "allow" && (approvalIsHostOnly(approval.details) || !approval.canAllow)) {
            throw new AidenRemoteServiceError(
              "capability_denied",
              "This approval can only be allowed from the Aiden desktop app.",
              403,
            );
          }
          if (scope && scope !== "once" && !approval.scopes?.includes(scope)) {
            throw new AidenRemoteServiceError(
              "invalid_request",
              "This approval cannot be remembered with that scope.",
              400,
            );
          }
          return runAccess(approval.chatId, async () => {
            if (!this.resolveApproval(approvalId, decision, scope)) {
              throw new AidenRemoteServiceError("approval_already_resolved", "This approval was already resolved.", 409);
            }
            return {
              approvalId,
              decision,
              ...(scope ? { scope } : {}),
              resolvedAt: new Date(this.options.now()).toISOString(),
            };
          });
        },
      );
    } catch (error) {
      return this.mapIdempotencyError(error);
    }
  }

  openEvents(deviceId: string, streamId: string, after: number, response: ServerResponse): void {
    const stream = this.requireStream(deviceId, streamId);
    const lastSequence = stream.events[stream.events.length - 1]?.sequence ?? 0;
    if (after > lastSequence) {
      throw new AidenRemoteServiceError("invalid_request", "The stream cursor is ahead of Aiden.", 400);
    }
    const earliest = stream.events[0]?.sequence ?? 1;
    if (after < earliest - 1) {
      const snapshot = this.append(
        stream,
        "snapshot",
        {
          chatId: stream.chatId,
          turnId: stream.turnId,
          nextSequence: (stream.events[stream.events.length - 1]?.sequence ?? 0) + 2,
        },
        false,
      );
      after = snapshot.sequence - 1;
    }
    // The retained journal is also the pending-output queue. Never duplicate
    // it into Node's writable buffer while a client is waiting for drain.
    let closed = false;
    let blocked = false;
    let ending = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(drainTimeout);
      response.off("close", cleanup);
      response.off("error", abort);
      response.off("drain", onDrain);
      response.off("finish", onFinish);
      stream.subscribers.delete(subscriber);
    };
    const abort = () => {
      cleanup();
      response.destroy();
    };
    const onFinish = () => {
      cleanup();
      // Only fully flushed terminal delivery can satisfy deferred eviction.
      // Disconnect/error/timeout cleanup must leave replay available.
      if (stream.evictAfterDelivery && stream.subscribers.size === 0 && this.streams.get(streamId) === stream) {
        stream.owner.invalidate();
        this.streams.delete(streamId);
        this.persist();
      }
    };
    const close = () => {
      if (closed || ending) return;
      ending = true;
      response.once("finish", onFinish);
      drainTimeout = setTimeout(abort, STREAM_DRAIN_TIMEOUT_MS);
      drainTimeout.unref?.();
      try {
        response.end();
      } catch {
        abort();
      }
    };
    const write = (frame: string): boolean => {
      try {
        if (response.destroyed || response.writableEnded) {
          cleanup();
          return false;
        }
        if (!response.write(frame)) {
          blocked = true;
          drainTimeout = setTimeout(abort, STREAM_DRAIN_TIMEOUT_MS);
          drainTimeout.unref?.();
        }
      } catch {
        abort();
        return false;
      }
      return !blocked && !closed;
    };
    const flush = () => {
      if (closed || blocked || ending) return;
      const firstSequence = stream.events[0]?.sequence ?? 1;
      if (after < firstSequence - 1) {
        // The client fell behind retention. Reconnect uses the existing
        // snapshot recovery path instead of silently skipping events.
        abort();
        return;
      }
      for (let index = Math.max(0, after - firstSequence + 1); index < stream.events.length; index++) {
        const event = stream.events[index]!;
        after = event.sequence;
        if (!write(sseFrame(event))) return;
      }
      if (terminal(stream.state)) close();
    };
    const onDrain = () => {
      if (closed || ending) return;
      blocked = false;
      clearTimeout(drainTimeout);
      drainTimeout = undefined;
      flush();
    };
    const subscriber: StreamSubscriber = { flush, close: abort };
    stream.subscribers.add(subscriber);
    response.once("close", cleanup);
    response.once("error", abort);
    response.on("drain", onDrain);
    try {
      response.writeHead(200, {
        "aiden-protocol-version": String(AIDEN_REMOTE_PROTOCOL_VERSION),
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      flush();
      if (!closed) {
        heartbeat = setInterval(() => {
          if (!closed && !blocked && !ending) write(": heartbeat\n\n");
        }, 15_000);
        heartbeat.unref?.();
      }
    } catch {
      abort();
    }
  }
}

import type { ServerResponse } from "node:http";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import type { ToolApprovalDetails } from "../../renderer/shared/assistant.js";
import {
  isAssistantAutomationApprovalDetails,
  isSubagentMcpMutationApprovalDetails,
  isSubagentShellApprovalDetails,
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
} from "./aiden-remote-protocol.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
  AidenOperationContractError,
} from "./aiden-remote-operation-contract.js";

const MAX_STREAMS = 256;
const MAX_EVENTS_PER_STREAM = 4_096;
const MAX_STREAM_EVENT_BYTES = 8 * 1_024 * 1_024;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;
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

export interface AidenRemotePendingApproval {
  approvalId: string;
  streamId: string;
  chatId: string;
  summary: string;
  toolCallId: string;
  toolName: string;
  expiresAt: string;
  canAllow: boolean;
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
}

interface StreamSubscriber {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
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
  owner: RemoteChatGenerationOwnerController;
  cancelRequested: boolean;
  cancellationSource: "device" | "server";
  activeTools: Map<string, string[]>;
  toolCounter: number;
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
  details?: ToolApprovalDetails;
  expiresAt: number;
  expiry: ReturnType<typeof setTimeout>;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const sliced = value.slice(0, maximum);
  let result = "";
  for (let index = 0; index < sliced.length; index += 1) {
    const code = sliced.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = sliced.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += sliced[index] + sliced[index + 1];
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += sliced[index];
    }
  }
  return result;
}

function approvalDetails(value: unknown): ToolApprovalDetails | undefined {
  return isAssistantAutomationApprovalDetails(value)
    || isSubagentWorkspaceWriteApprovalDetails(value)
    || isSubagentMcpMutationApprovalDetails(value)
    || isSubagentShellApprovalDetails(value)
    ? structuredClone(value)
    : undefined;
}

function terminal(state: AidenRemoteStreamState): boolean {
  return state === "done" || state === "error" || state === "cancelled" || state === "interrupted";
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
      const event = ownRecord(rawEvent);
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
        !parseAidenRemoteStreamEvent(rawEvent)
      ) {
        throw new Error("Invalid Aiden Remote stream snapshot.");
      }
      previous = Number(event.sequence);
      return structuredClone(rawEvent) as AidenRemoteStreamEvent;
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
  return { version: 1, streams };
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
  };
}

function sseFrame(event: AidenRemoteStreamEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class AidenRemoteStreamService {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private persistTail: Promise<void> = Promise.resolve();
  private persistDirty = false;
  private persistRunning = false;
  private persistenceError: unknown;
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(
    private readonly options: {
      now(): number;
      cancel(streamId: string, ownerDocumentId: string): boolean;
      approve(approvalId: string, decision: "allow" | "deny", ownerDocumentId: string): boolean;
      notifyChatChanged?: (chatId: string) => void;
      notifyApprovalChanged?: (chatId: string) => void;
      snapshot?: AidenRemoteStreamSnapshot;
      persist?: (snapshot: AidenRemoteStreamSnapshot) => Promise<void>;
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
    const pending = this.idempotency.execute(scope, input, async () => {
      await durable;
      return action();
    });
    try {
      await this.options.persistIdempotency(this.idempotency.snapshot());
      admit();
    } catch (error) {
      reject(error);
      await pending.catch(() => undefined);
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
    for (const saved of parseSnapshot(snapshot).streams) {
      const base: Omit<StreamRecord, "owner"> = {
        ...saved,
        eventBytes: saved.events.reduce(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
          0,
        ),
        subscribers: new Set(),
        cancelRequested: false,
        cancellationSource: "server",
        activeTools: new Map(),
        toolCounter: 0,
      };
      const record: StreamRecord = { ...base, owner: this.ownerFor(base) };
      this.streams.set(record.streamId, record);
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

  snapshot(): AidenRemoteStreamSnapshot {
    return {
      version: 1,
      streams: [...this.streams.values()].map((stream) => ({
        streamId: stream.streamId,
        chatId: stream.chatId,
        turnId: stream.turnId,
        deviceId: stream.deviceId,
        state: stream.state,
        updatedAt: stream.updatedAt,
        events: structuredClone(stream.events),
      })),
    };
  }

  private persist(): void {
    if (!this.options.persist) return;
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

  async settlePersistence(): Promise<void> {
    while (this.persistRunning || this.persistDirty) await this.persistTail;
    if (this.persistenceError) throw this.persistenceError;
  }

  private prune(): void {
    const now = this.options.now();
    for (const [approvalId, approval] of this.approvals) {
      if (approval.expiresAt <= now) {
        this.resolveApproval(approvalId, "deny");
      }
    }
    for (const [streamId, stream] of this.streams) {
      if (terminal(stream.state) && stream.updatedAt + TERMINAL_RETENTION_MS <= now) {
        stream.owner.invalidate();
        for (const subscriber of stream.subscribers) {
          clearInterval(subscriber.heartbeat);
          subscriber.response.end();
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
      ...(entry.details ? { details: structuredClone(entry.details) } : {}),
    };
  }

  private resolveApproval(approvalId: string, decision: "allow" | "deny"): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;
    clearTimeout(approval.expiry);
    const resolved = this.options.approve(approvalId, decision, approval.ownerDocumentId);
    this.approvals.delete(approvalId);
    const stream = this.streams.get(approval.streamId);
    const nextApproval = stream ? this.pendingApprovalForStream(stream.streamId) : undefined;
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
      } else {
        this.append(stream, "status", { state: "running" }, false, "running");
      }
    }
    this.options.notifyApprovalChanged?.(approval.chatId);
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
      activeTools: new Map(),
      toolCounter: 0,
    };
    const owner = this.ownerFor(base);
    const record: StreamRecord = { ...base, owner };
    this.streams.set(streamId, record);
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
    const event: AidenRemoteStreamEvent = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      streamId: stream.streamId,
      sequence: (stream.events[stream.events.length - 1]?.sequence ?? 0) + 1,
      timestamp: new Date(this.options.now()).toISOString(),
      type,
      terminal: isTerminal,
      payload,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    stream.events.push(event);
    stream.eventBytes += bytes;
    while (
      stream.events.length > MAX_EVENTS_PER_STREAM ||
      (stream.eventBytes > MAX_STREAM_EVENT_BYTES && stream.events.length > 1)
    ) {
      const removed = stream.events.shift();
      if (removed) stream.eventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
    this.enforceAggregateBudget(stream.streamId);
    stream.state = state ?? stream.state;
    stream.updatedAt = this.options.now();
    const frame = sseFrame(event);
    for (const subscriber of [...stream.subscribers]) {
      if (!subscriber.response.write(frame)) {
        // Node applies backpressure. The durable in-memory journal remains the
        // source of truth, so the client can reconnect from its last event ID.
      }
      if (isTerminal) {
        clearInterval(subscriber.heartbeat);
        subscriber.response.end();
        stream.subscribers.delete(subscriber);
      }
    }
    if (isTerminal) {
      stream.owner.invalidate();
      for (const [approvalId, approval] of this.approvals) {
        if (approval.streamId === stream.streamId) {
          clearTimeout(approval.expiry);
          this.approvals.delete(approvalId);
          this.options.notifyApprovalChanged?.(approval.chatId);
        }
      }
      this.options.notifyChatChanged?.(stream.chatId);
    }
    this.persist();
    return event;
  }

  private enforceAggregateBudget(currentStreamId: string): void {
    const snapshotBytes = () => Buffer.byteLength(JSON.stringify(this.snapshot()), "utf8");
    if (snapshotBytes() <= MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) return;
    const terminalStreams = [...this.streams.values()]
      .filter((entry) => entry.streamId !== currentStreamId && terminal(entry.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const entry of terminalStreams) {
      entry.owner.invalidate();
      this.streams.delete(entry.streamId);
      if (snapshotBytes() <= MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) return;
    }
    while (snapshotBytes() > MAX_AIDEN_REMOTE_STREAM_SNAPSHOT_BYTES) {
      const candidate = [...this.streams.values()]
        .filter((entry) => entry.events.length > 0)
        .sort((left, right) => right.eventBytes - left.eventBytes)[0];
      if (!candidate) break;
      if (candidate.events.length > 1) {
        const removed = candidate.events.shift();
        if (removed) candidate.eventBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
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
      candidate.eventBytes = Buffer.byteLength(JSON.stringify(replacement), "utf8");
    }
  }

  private projectNotification(
    stream: StreamRecord,
    channel: NotificationChannel,
    rawPayload: unknown,
  ): void {
    const payload = ownRecord(rawPayload) ?? {};
    if (channel === "chat:delta") {
      if (payload.reset === true) {
        const nextSequence = (stream.events[stream.events.length - 1]?.sequence ?? 0) + 2;
        this.append(
          stream,
          "snapshot",
          { chatId: stream.chatId, turnId: stream.turnId, nextSequence },
          false,
          "reconciling",
        );
        return;
      }
      const text = boundedText(payload.delta, 200_000);
      if (text) this.append(stream, "text_delta", { text }, false, "running");
      return;
    }
    if (channel === "chat:reasoning-delta") {
      const text = boundedText(payload.delta, 200_000);
      if (text) this.append(stream, "reasoning_delta", { text }, false, "running");
      return;
    }
    if (channel === "chat:status") {
      this.append(stream, "status", { state: "running" }, false, "running");
      return;
    }
    if (channel === "chat:tool") {
      const name = boundedText(payload.toolName, 120) || "Tool";
      const phase = payload.phase;
      if (phase === "call") {
        const toolId = `tool_${++stream.toolCounter}`;
        const queue = stream.activeTools.get(name) ?? [];
        queue.push(toolId);
        stream.activeTools.set(name, queue);
        this.append(stream, "tool_started", { toolId, name }, false, "running");
      } else {
        const queue = stream.activeTools.get(name) ?? [];
        const toolId = queue.shift() ?? `tool_${++stream.toolCounter}`;
        if (queue.length === 0) stream.activeTools.delete(name);
        const status = phase === "result" ? "succeeded" : "failed";
        this.append(stream, "tool_finished", { toolId, status }, false, "running");
      }
      return;
    }
    if (channel === "chat:timeline") {
      const timeline = parseGenerationTimeline(payload.timeline);
      if (timeline) this.append(stream, "timeline", { timeline }, false, "running");
      return;
    }
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
    if (channel === "chat:error") {
      const finalTimeline = parseGenerationTimeline(payload.timeline);
      if (
        stream.cancelRequested ||
        payload.cancelled === true ||
        finalTimeline?.status === "cancelled"
      ) {
        this.append(
          stream,
          "cancelled",
          { source: stream.cancelRequested ? stream.cancellationSource : "server" },
          true,
          "cancelled",
        );
        return;
      }
      this.append(
        stream,
        "error",
        { code: "internal_error", message: "The model provider could not complete this response." },
        true,
        "error",
      );
      return;
    }
    if (channel === "chat:done") {
      const finalTimeline = parseGenerationTimeline(payload.timeline);
      if (
        stream.cancelRequested ||
        payload.cancelled === true ||
        finalTimeline?.status === "cancelled"
      ) {
        this.append(
          stream,
          "cancelled",
          { source: stream.cancelRequested ? stream.cancellationSource : "server" },
          true,
          "cancelled",
        );
        return;
      }
      const chat = ownRecord(payload.chat);
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      const assistant = [...messages].reverse().find((message) => ownRecord(message)?.role === "assistant");
      const messageId = boundedText(ownRecord(assistant)?.id, 128) || `assistant_${stream.turnId}`;
      this.append(stream, "done", { messageId }, true, "done");
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
    const { details: _hostOnly, ...mobile } = approval;
    return { ...mobile, canAllow: approval.details ? false : approval.canAllow };
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
  ): boolean {
    this.prune();
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.chatId !== chatId || approval.expiresAt <= this.options.now()) {
      return false;
    }
    return this.resolveApproval(approvalId, decision);
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

  async revokeDevice(deviceId: string): Promise<void> {
    for (const [approvalId, approval] of this.approvals) {
      if (approval.deviceId !== deviceId) continue;
      clearTimeout(approval.expiry);
      this.options.approve(approvalId, "deny", approval.ownerDocumentId);
      this.approvals.delete(approvalId);
      this.options.notifyApprovalChanged?.(approval.chatId);
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
      stream.activeTools.clear();
      for (const subscriber of stream.subscribers) {
        clearInterval(subscriber.heartbeat);
        subscriber.response.end();
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
  ): Promise<{ approvalId: string; decision: "allow" | "deny"; resolvedAt: string }> {
    try {
      return await this.executeIdempotent(
        { deviceId, route: "POST /approvals/{id}/respond", resourceId: approvalId, key },
        { approvalId, decision },
        async () => {
          this.prune();
          const approval = this.approvals.get(approvalId);
          if (!approval || approval.deviceId !== deviceId || approval.expiresAt <= this.options.now()) {
            throw new AidenRemoteServiceError("approval_expired", "This approval is no longer available.", 409);
          }
          if (decision === "allow" && (approval.details !== undefined || !approval.canAllow)) {
            throw new AidenRemoteServiceError(
              "capability_denied",
              "This approval can only be allowed from the Mac.",
              403,
            );
          }
          if (!this.resolveApproval(approvalId, decision)) {
            throw new AidenRemoteServiceError("approval_already_resolved", "This approval was already resolved.", 409);
          }
          return { approvalId, decision, resolvedAt: new Date(this.options.now()).toISOString() };
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
    response.writeHead(200, {
      "aiden-protocol-version": String(AIDEN_REMOTE_PROTOCOL_VERSION),
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    for (const event of stream.events) {
      if (event.sequence > after) response.write(sseFrame(event));
    }
    if (terminal(stream.state)) {
      response.end();
      return;
    }
    const subscriber: StreamSubscriber = {
      response,
      heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15_000),
    };
    subscriber.heartbeat.unref?.();
    stream.subscribers.add(subscriber);
    response.once("close", () => {
      clearInterval(subscriber.heartbeat);
      stream.subscribers.delete(subscriber);
    });
  }
}

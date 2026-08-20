import type { ServerResponse } from "node:http";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { GenerationTimeline } from "../../renderer/shared/generation-timeline.js";
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
  expiresAt: number;
  expiry: ReturnType<typeof setTimeout>;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maximum: number, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, maximum) : fallback;
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

function sseFrame(event: AidenRemoteStreamEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class AidenRemoteStreamService {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private persistTail: Promise<void> = Promise.resolve();
  private persistDirty = false;
  private persistRunning = false;
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(
    private readonly options: {
      now(): number;
      cancel(streamId: string, ownerDocumentId: string): boolean;
      approve(approvalId: string, decision: "allow" | "deny", ownerDocumentId: string): boolean;
      notifyChatChanged?: (chatId: string) => void;
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
      }
    })()
      .catch((error: unknown) => this.options.onPersistenceError?.(error))
      .finally(() => {
        this.persistRunning = false;
        if (this.persistDirty) this.persist();
      });
  }

  async settlePersistence(): Promise<void> {
    while (this.persistRunning || this.persistDirty) await this.persistTail;
  }

  private prune(): void {
    const now = this.options.now();
    for (const [approvalId, approval] of this.approvals) {
      if (approval.expiresAt <= now) {
        clearTimeout(approval.expiry);
        this.options.approve(approvalId, "deny", approval.ownerDocumentId);
        this.approvals.delete(approvalId);
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
        }
      }
      this.options.notifyChatChanged?.(stream.chatId);
    }
    this.persist();
    return event;
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
      this.append(stream, "text_delta", { text: boundedText(payload.delta, 200_000) }, false, "running");
      return;
    }
    if (channel === "chat:reasoning-delta") {
      this.append(stream, "reasoning_delta", { text: boundedText(payload.delta, 200_000) }, false, "running");
      return;
    }
    if (channel === "chat:status") {
      this.append(stream, "status", { state: "running" }, false, "running");
      return;
    }
    if (channel === "chat:tool") {
      const name = boundedText(payload.toolName, 120, "Tool");
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
      const timeline = ownRecord(payload.timeline) as GenerationTimeline | null;
      const last = timeline?.steps?.[timeline.steps.length - 1];
      const label = last?.kind === "tool" ? last.label : "Thinking";
      this.append(stream, "timeline", { label: boundedText(label, 500, "Activity") }, false, "running");
      return;
    }
    if (channel === "chat:approval") {
      const approvalId = boundedText(payload.approvalId, 128);
      if (!approvalId) return;
      const previousApproval = this.approvals.get(approvalId);
      if (previousApproval) clearTimeout(previousApproval.expiry);
      const expiresAt = this.options.now() + APPROVAL_LIFETIME_MS;
      const expiry = setTimeout(() => {
        const current = this.approvals.get(approvalId);
        if (!current || current.expiresAt !== expiresAt) return;
        this.options.approve(approvalId, "deny", current.ownerDocumentId);
        this.approvals.delete(approvalId);
      }, APPROVAL_LIFETIME_MS);
      expiry.unref?.();
      this.approvals.set(approvalId, {
        streamId: stream.streamId,
        deviceId: stream.deviceId,
        ownerDocumentId: stream.owner.owner.documentId,
        expiresAt,
        expiry,
      });
      this.append(
        stream,
        "approval_required",
        {
          approvalId,
          summary: boundedText(payload.summary, 2_000, "Aiden needs approval."),
          expiresAt: new Date(expiresAt).toISOString(),
        },
        false,
        "waiting_for_approval",
      );
      return;
    }
    if (channel === "chat:error") {
      this.append(
        stream,
        "error",
        { code: "internal_error", message: boundedText(payload.message, 2_000, "Generation failed.") },
        true,
        "error",
      );
      return;
    }
    if (channel === "chat:done") {
      if (stream.cancelRequested) {
        this.append(stream, "cancelled", { source: stream.cancellationSource }, true, "cancelled");
        return;
      }
      const chat = ownRecord(payload.chat);
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      const assistant = [...messages].reverse().find((message) => ownRecord(message)?.role === "assistant");
      const messageId = boundedText(ownRecord(assistant)?.id, 128, `assistant_${stream.turnId}`);
      this.append(stream, "done", { messageId }, true, "done");
    }
  }

  markRunning(deviceId: string, streamId: string): void {
    const stream = this.requireStream(deviceId, streamId);
    this.append(stream, "status", { state: "running" }, false, "running");
  }

  markStartError(deviceId: string, streamId: string, error: unknown): void {
    const stream = this.requireStream(deviceId, streamId);
    this.append(
      stream,
      "error",
      {
        code: "internal_error",
        message: error instanceof Error ? error.message.slice(0, 2_000) : "Generation could not start.",
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
            this.options.cancel(streamId, stream.owner.owner.documentId);
          }
          return this.status(deviceId, streamId);
        },
      );
    } catch (error) {
      return this.mapIdempotencyError(error);
    }
  }

  revokeDevice(deviceId: string): void {
    for (const stream of this.streams.values()) {
      if (stream.deviceId !== deviceId || terminal(stream.state)) continue;
      stream.cancelRequested = true;
      stream.cancellationSource = "server";
      this.options.cancel(stream.streamId, stream.owner.owner.documentId);
      this.append(stream, "cancelled", { source: "server" }, true, "cancelled");
    }
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
          if (!this.options.approve(approvalId, decision, approval.ownerDocumentId)) {
            clearTimeout(approval.expiry);
            this.approvals.delete(approvalId);
            throw new AidenRemoteServiceError("approval_already_resolved", "This approval was already resolved.", 409);
          }
          clearTimeout(approval.expiry);
          this.approvals.delete(approvalId);
          const stream = this.requireStream(deviceId, approval.streamId);
          if (!terminal(stream.state)) {
            this.append(stream, "status", { state: "running" }, false, "running");
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

import type { ServerResponse } from "node:http";
import {
  parseToolApprovalScope,
  type ToolApprovalScope,
} from "../../renderer/shared/tool-approval-scope.js";
import type { ChatRunInputAdmissionResult } from "../../renderer/shared/chat-run-input.js";
import {
  AIDEN_REMOTE_PROTOCOL_VERSION,
  type AidenRemoteCapability,
  type AidenRemoteErrorCode,
  type AidenRemoteErrorEnvelope,
  type AidenRemoteRunInputMode,
  type AidenRemoteRunState,
} from "./aiden-remote-protocol.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AidenIdempotencyLedger,
  AidenOperationContractError,
} from "./aiden-remote-operation-contract.js";
import { openCursorSse, sseFrame, type CursorSseHandle, type CursorSsePull } from "./aiden-remote-sse.js";
import type {
  HostRunEvent,
  HostRunRegistry,
  HostRunSummary,
} from "./host-run-registry.js";
import type { AskUserQuestionRespondOutcome } from "./ask-user-question-coordinator.js";

/** Response header carrying the host-run journal epoch (process lifetime). */
export const AIDEN_REMOTE_RUN_EPOCH_HEADER = "aiden-run-epoch";

/** Most journal events written per pump turn; the journal stays the queue. */
const MAX_EVENTS_PER_PULL = 64;

/** One event on `GET /runs/{runId}/events` and `GET /chats/{chatId}/runs/current/events`. */
export interface AidenRemoteRunEvent {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  /** The run ID; run streams reuse the `/streams` envelope. */
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface AidenRemoteRunCancelResult {
  runId: string;
  chatId: string;
  state: AidenRemoteRunState;
  cancelRequested: boolean;
}

export interface AidenRemoteRunApprovalResult {
  runId: string;
  approvalId: string;
  decision: "allow" | "deny";
  scope?: ToolApprovalScope;
  resolvedAt: string;
}

export interface AidenRemoteRunQuestionResult {
  runId: string;
  promptId: string;
  outcome: "answered" | "expired";
  resolvedAt: string;
}

export interface AidenRemoteRunInputResult {
  runId: string;
  chatId: string;
  mode: AidenRemoteRunInputMode;
  status: "admitted" | "rejected";
  queue?: ChatRunInputAdmissionResult["queue"];
  reason?: ChatRunInputAdmissionResult["reason"];
  committed: boolean;
  messageId?: string;
}

/** Host-authority effects. Each is first-responder-wins and never checks an owner document. */
export interface AidenRemoteHostRunControls {
  /** Stop a run whoever started it. False when it already stopped. */
  cancel(runId: string): boolean;
  /**
   * Settle an approval. Device-owned (phone) approvals must settle through the
   * stream service so its records stay consistent; the implementation routes.
   */
  approve(input: {
    runId: string;
    chatId: string;
    approvalId: string;
    decision: "allow" | "deny";
    scope?: ToolApprovalScope;
  }): boolean;
  answer(input: {
    runId: string;
    chatId: string;
    promptId: string;
    response: unknown;
  }): AskUserQuestionRespondOutcome;
  admitInput(input: {
    streamId: string;
    chatId: string;
    mode: AidenRemoteRunInputMode;
    text: string;
  }): Promise<ChatRunInputAdmissionResult>;
}

export type AidenRemoteHostRunRegistry = Pick<
  HostRunRegistry,
  | "epoch"
  | "summary"
  | "currentRunForChat"
  | "read"
  | "subscribe"
  | "resolution"
  | "runForPrompt"
  | "pendingPrompt"
>;

export interface AidenRemoteHostRunDevice {
  id: string;
  capabilities: ReadonlySet<AidenRemoteCapability>;
}

/** Chat-access check supplied by the router, run inside the idempotent action. */
export type AidenRemoteRunChatAccess = <T>(chatId: string, action: () => Promise<T>) => Promise<T>;

type ControlOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: AidenRemoteErrorCode;
        message: string;
        status: number;
        retryable: boolean;
        details?: AidenRemoteErrorEnvelope["error"]["details"];
      };
    };

function runGone(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("run_gone", "This run is no longer available on this Aiden host.", 404);
}

function staleRun(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("operation_stale", "This run has already finished.", 409);
}

function isTerminal(state: AidenRemoteRunState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Strip host-only approval facts for observers without `runs:control`. Those
 * observers keep the mobile summary projection; controllers get the details
 * they need to decide.
 */
function projectPayload(
  type: string,
  payload: Record<string, unknown>,
  fullDetails: boolean,
): Record<string, unknown> {
  if (type !== "approval_required" || fullDetails) return payload;
  const { details: _details, detailsOmitted: _omitted, ...summary } = payload;
  return summary;
}

/**
 * A controller may allow only what it could see: an approval whose details
 * were too large to journal can be denied remotely but must be allowed on the
 * host, and a scope must be one the prompt offered.
 */
function requireInformedAllow(payload: Record<string, unknown>, scope: ToolApprovalScope | undefined): void {
  if (payload.detailsOmitted === true) {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "Review this approval on the Aiden host; its details are too large to send.",
      403,
    );
  }
  const offered = Array.isArray(payload.scopes) ? payload.scopes : [];
  if (scope !== undefined && scope !== "once" && !offered.includes(scope)) {
    throw new AidenRemoteServiceError("invalid_request", "That approval scope was not offered.", 400);
  }
}

function parseRunApproval(value: unknown): { decision: "allow" | "deny"; scope?: ToolApprovalScope } {
  const record = ownRecord(value);
  const scope = record && "scope" in record ? parseToolApprovalScope(record.scope) : undefined;
  if (
    !record ||
    Object.keys(record).some((key) => key !== "decision" && key !== "scope") ||
    (record.decision !== "allow" && record.decision !== "deny") ||
    ("scope" in record && (!scope || record.decision !== "allow"))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The approval response is invalid.", 400);
  }
  return scope ? { decision: record.decision, scope } : { decision: record.decision };
}

function parseRunInput(value: unknown): { mode: AidenRemoteRunInputMode; text: string } {
  const record = ownRecord(value);
  if (
    !record ||
    Object.keys(record).some((key) => key !== "mode" && key !== "text") ||
    (record.mode !== "steer" && record.mode !== "queue") ||
    typeof record.text !== "string" ||
    record.text.trim().length === 0 ||
    record.text.length > 200_000
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The run input request is invalid.", 400);
  }
  return { mode: record.mode, text: record.text };
}

export interface AidenRemoteHostRunServiceOptions {
  registry: AidenRemoteHostRunRegistry;
  controls: AidenRemoteHostRunControls;
  now(): number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  /**
   * Run-control replay ledger. Runs are process-lifetime, so the ledger is
   * in memory: a key replayed after a restart meets `run_gone` instead.
   */
  idempotency?: AidenIdempotencyLedger;
}

/**
 * Host-wide run streams and controls for paired desktops (contract revision
 * 19). Reads come straight from the HostRunRegistry with wake-then-read; the
 * device stream journal stays independent and unchanged for phones.
 */
export class AidenRemoteHostRunService {
  private readonly subscriptions = new Map<string, Set<CursorSseHandle>>();
  private readonly idempotency: AidenIdempotencyLedger;

  constructor(private readonly options: AidenRemoteHostRunServiceOptions) {
    this.idempotency = options.idempotency ?? new AidenIdempotencyLedger(undefined, {
      ttlMs: 10 * 60_000,
      now: options.now,
    });
  }

  /** The chat a live or retained run belongs to; `run_gone` otherwise. */
  chatIdForRun(runId: string): string {
    const summary = this.options.registry.summary(runId);
    if (!summary) throw runGone();
    return summary.chatId;
  }

  /** The newest retained run for a chat; `run_gone` when none is retained. */
  currentRunId(chatId: string): string {
    const summary = this.options.registry.currentRunForChat(chatId);
    if (!summary) throw runGone();
    return summary.runId;
  }

  /**
   * Open a resumable run stream. `after` is the last delivered sequence
   * (decimal `Last-Event-ID`); a cursor older than retention yields a
   * `snapshot` first, a cursor past the head is a 400, and an unknown run is
   * `404 run_gone`. The stream ends after `run.ended`.
   */
  openRunEvents(
    device: AidenRemoteHostRunDevice,
    runId: string,
    after: number,
    response: ServerResponse,
  ): void {
    const registry = this.options.registry;
    const initial = registry.summary(runId);
    if (!initial) throw runGone();
    if (after > initial.lastSequence) {
      throw new AidenRemoteServiceError("invalid_request", "The run cursor is ahead of Aiden.", 400);
    }
    const fullDetails = device.capabilities.has("runs:control");
    let cursor = after;
    let endedSent = false;
    let unsubscribe: () => void = () => {};
    const pull = (): CursorSsePull => {
      if (endedSent) return { frames: [], end: true };
      let read;
      try {
        read = registry.read(runId, cursor, MAX_EVENTS_PER_PULL);
      } catch {
        // The run was evicted while observed: drop so a reconnect learns run_gone.
        return { abort: true };
      }
      const frames: string[] = [];
      if (read.kind === "snapshot_required") {
        const resume = read.nextSequence - 1;
        frames.push(this.frame(read.summary, resume, "snapshot", {
          runId,
          chatId: read.summary.chatId,
          reason: "gap",
          epoch: read.epoch,
          state: read.summary.state,
          pendingApprovalIds: read.summary.pendingApprovalIds,
          pendingQuestionIds: read.summary.pendingQuestionIds,
          approvals: read.prompts
            .filter((prompt) => prompt.type === "approval_required")
            .map((prompt) => projectPayload(prompt.type, prompt.payload, fullDetails)),
          questions: read.prompts
            .filter((prompt) => prompt.type === "question_required")
            .map((prompt) => prompt.payload),
          nextSequence: read.nextSequence,
        }, read.summary.updatedAt));
        cursor = resume;
        return { frames };
      }
      for (const event of read.events) {
        frames.push(this.eventFrame(event, read.summary.chatId, fullDetails));
        cursor = event.sequence;
      }
      if (
        isTerminal(read.summary.state) &&
        cursor === read.summary.lastSequence
      ) {
        endedSent = true;
        frames.push(this.frame(read.summary, cursor, "run.ended", {
          runId,
          chatId: read.summary.chatId,
          state: read.summary.state,
        }, read.summary.updatedAt, true));
        return { frames, end: true };
      }
      return { frames };
    };
    const handle = openCursorSse(response, {
      pull,
      headers: { [AIDEN_REMOTE_RUN_EPOCH_HEADER]: registry.epoch },
      heartbeatMs: this.options.heartbeatMs,
      drainTimeoutMs: this.options.drainTimeoutMs,
      onClose: () => {
        unsubscribe();
        const owned = this.subscriptions.get(device.id);
        owned?.delete(handle);
        if (owned?.size === 0) this.subscriptions.delete(device.id);
      },
    });
    if (handle.closed) return;
    unsubscribe = registry.subscribe(runId, () => handle.wake());
    const owned = this.subscriptions.get(device.id) ?? new Set<CursorSseHandle>();
    owned.add(handle);
    this.subscriptions.set(device.id, owned);
    // An event committed between the first pull and the subscription is not missed.
    handle.wake();
  }

  /** Close every run stream a revoked device holds. Runs are never cancelled here. */
  revokeDevice(deviceId: string): void {
    const owned = this.subscriptions.get(deviceId);
    if (!owned) return;
    this.subscriptions.delete(deviceId);
    for (const handle of [...owned]) handle.close();
  }

  async cancel(
    deviceId: string,
    runId: string,
    key: string,
    access: AidenRemoteRunChatAccess,
  ): Promise<AidenRemoteRunCancelResult> {
    return this.control(
      { deviceId, route: "POST /runs/{id}/cancel", resourceId: runId, key },
      { runId },
      async () => {
        const summary = this.liveRun(runId);
        return access(summary.chatId, async () => {
          const cancelRequested = this.options.controls.cancel(runId);
          const current = this.options.registry.summary(runId) ?? summary;
          return { runId, chatId: summary.chatId, state: current.state, cancelRequested };
        });
      },
    );
  }

  async respondApproval(
    deviceId: string,
    runId: string,
    approvalId: string,
    body: unknown,
    key: string,
    access: AidenRemoteRunChatAccess,
  ): Promise<AidenRemoteRunApprovalResult> {
    const { decision, scope } = parseRunApproval(body);
    return this.control(
      {
        deviceId,
        route: "POST /runs/{id}/approvals/{approvalId}/respond",
        resourceId: `${runId}/${approvalId}`,
        key,
      },
      scope ? { runId, approvalId, decision, scope } : { runId, approvalId, decision },
      async () => {
        const summary = this.promptRun(runId, approvalId);
        return access(summary.chatId, async () => {
          const prompt = this.options.registry.pendingPrompt(approvalId);
          if (prompt && decision === "allow") requireInformedAllow(prompt.payload, scope);
          if (
            summary.pendingApprovalIds.includes(approvalId) &&
            this.options.controls.approve({ runId, chatId: summary.chatId, approvalId, decision, scope })
          ) {
            return {
              runId,
              approvalId,
              decision,
              ...(scope ? { scope } : {}),
              resolvedAt: this.options.registry.resolution(approvalId)?.resolvedAt
                ?? new Date(this.options.now()).toISOString(),
            };
          }
          throw this.approvalLost(runId, approvalId);
        });
      },
    );
  }

  async respondQuestion(
    deviceId: string,
    runId: string,
    promptId: string,
    body: unknown,
    key: string,
    access: AidenRemoteRunChatAccess,
  ): Promise<AidenRemoteRunQuestionResult> {
    const record = ownRecord(body);
    if (
      !record ||
      Object.keys(record).some((name) => name !== "cancelled" && name !== "answers") ||
      typeof record.cancelled !== "boolean" ||
      !Array.isArray(record.answers)
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The question response is invalid.", 400);
    }
    const input = { cancelled: record.cancelled, answers: record.answers };
    return this.control(
      {
        deviceId,
        route: "POST /runs/{id}/questions/{promptId}/respond",
        resourceId: `${runId}/${promptId}`,
        key,
      },
      { runId, promptId, ...input },
      async () => {
        const summary = this.promptRun(runId, promptId);
        return access(summary.chatId, async () => {
          if (summary.pendingQuestionIds.includes(promptId)) {
            const outcome = this.options.controls.answer({
              runId,
              chatId: summary.chatId,
              promptId,
              response: { version: 1, promptId, ...input },
            });
            if (outcome === "answered" || outcome === "expired") {
              return {
                runId,
                promptId,
                outcome,
                resolvedAt: this.options.registry.resolution(promptId)?.resolvedAt
                  ?? new Date(this.options.now()).toISOString(),
              };
            }
            if (this.options.registry.summary(runId)?.pendingQuestionIds.includes(promptId)) {
              // Still pending after a rejected answer: the body did not match the prompt.
              throw new AidenRemoteServiceError("invalid_request", "The question response is invalid.", 400);
            }
          }
          throw this.questionLost(runId, promptId);
        });
      },
    );
  }

  async submitInput(
    deviceId: string,
    runId: string,
    body: unknown,
    key: string,
    access: AidenRemoteRunChatAccess,
  ): Promise<AidenRemoteRunInputResult> {
    const parsed = parseRunInput(body);
    return this.control(
      { deviceId, route: "POST /runs/{id}/inputs", resourceId: runId, key },
      { runId, mode: parsed.mode, text: parsed.text },
      async () => {
        const summary = this.liveRun(runId);
        return access(summary.chatId, async () => {
          const admission = await this.options.controls.admitInput({
            streamId: runId,
            chatId: summary.chatId,
            mode: parsed.mode,
            text: parsed.text,
          });
          return {
            runId,
            chatId: summary.chatId,
            mode: parsed.mode,
            status: admission.admitted ? "admitted" as const : "rejected" as const,
            ...(admission.queue === undefined ? {} : { queue: admission.queue }),
            ...(admission.reason === undefined ? {} : { reason: admission.reason }),
            committed: admission.committed,
            ...(admission.messageId === undefined ? {} : { messageId: admission.messageId }),
          };
        });
      },
    );
  }

  /** The run must exist and still be running; identity is the run ID itself. */
  private liveRun(runId: string): HostRunSummary {
    const summary = this.options.registry.summary(runId);
    if (!summary) throw runGone();
    if (isTerminal(summary.state)) throw staleRun();
    return summary;
  }

  /** The prompt must belong to this run; a resolved prompt reports its winner. */
  private promptRun(runId: string, promptId: string): HostRunSummary {
    const summary = this.options.registry.summary(runId);
    if (!summary) throw runGone();
    if (this.options.registry.runForPrompt(promptId) !== runId) {
      throw new AidenRemoteServiceError("not_found", "This prompt does not belong to that run.", 404);
    }
    return summary;
  }

  private approvalLost(runId: string, approvalId: string): AidenRemoteServiceError {
    const resolution = this.options.registry.resolution(approvalId);
    if (resolution?.kind === "approval" && resolution.runId === runId) {
      return new AidenRemoteServiceError(
        "approval_resolved",
        "Another responder already resolved this approval.",
        409,
        false,
        { decision: resolution.decision, resolvedAt: resolution.resolvedAt },
      );
    }
    return isTerminal(this.options.registry.summary(runId)?.state ?? "done")
      ? staleRun()
      : new AidenRemoteServiceError("approval_expired", "This approval is no longer available.", 409);
  }

  private questionLost(runId: string, promptId: string): AidenRemoteServiceError {
    const resolution = this.options.registry.resolution(promptId);
    if (resolution?.kind === "question" && resolution.runId === runId) {
      return new AidenRemoteServiceError(
        "question_already_resolved",
        "Another responder already resolved this question.",
        409,
        false,
        { outcome: resolution.outcome, resolvedAt: resolution.resolvedAt },
      );
    }
    return isTerminal(this.options.registry.summary(runId)?.state ?? "done")
      ? staleRun()
      : new AidenRemoteServiceError("question_expired", "This question is no longer available.", 409);
  }

  /**
   * Execute once per Idempotency-Key. Domain failures are recorded as data so
   * a replay of a losing response returns the same 409 with the same winner.
   */
  private async control<T>(
    scope: { deviceId: string; route: string; resourceId: string; key: string },
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!/^[\x21-\x7e]{16,128}$/u.test(scope.key)) {
      throw new AidenRemoteServiceError("invalid_request", "Idempotency-Key is invalid.", 400);
    }
    let outcome: ControlOutcome<T>;
    try {
      outcome = await this.idempotency.execute(scope, input, async (): Promise<ControlOutcome<T>> => {
        try {
          return { ok: true, value: await action() };
        } catch (error) {
          if (!(error instanceof AidenRemoteServiceError)) throw error;
          return {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
              retryable: error.retryable,
              ...(error.details ? { details: { ...error.details } } : {}),
            },
          };
        }
      });
    } catch (error) {
      if (error instanceof AidenOperationContractError) {
        throw new AidenRemoteServiceError(
          error.code,
          "This run request cannot be safely repeated.",
          error.code === "idempotency_capacity" ? 429 : 409,
        );
      }
      throw error;
    }
    if (outcome.ok) return outcome.value;
    throw new AidenRemoteServiceError(
      outcome.error.code,
      outcome.error.message,
      outcome.error.status,
      outcome.error.retryable,
      outcome.error.details,
    );
  }

  private eventFrame(event: HostRunEvent, chatId: string, fullDetails: boolean): string {
    const type = event.type === "run_started" ? "run.started" : event.type;
    const payload = event.type === "run_started"
      ? { runId: event.runId, chatId, origin: event.payload.origin }
      : event.type === "snapshot"
        ? { runId: event.runId, chatId, reason: "reset", nextSequence: event.sequence + 1 }
        : projectPayload(event.type, event.payload, fullDetails);
    const wire: AidenRemoteRunEvent = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      streamId: event.runId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      type,
      terminal: event.terminal,
      payload,
    };
    return sseFrame(String(event.sequence), type, wire);
  }

  private frame(
    summary: HostRunSummary,
    sequence: number,
    type: string,
    payload: Record<string, unknown>,
    timestamp: string,
    terminal = false,
  ): string {
    const wire: AidenRemoteRunEvent = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      streamId: summary.runId,
      sequence,
      timestamp,
      type,
      terminal,
      payload,
    };
    return sseFrame(String(sequence), type, wire);
  }
}

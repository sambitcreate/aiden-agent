import { randomUUID } from "node:crypto";
import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { parseAskUserQuestions } from "../../renderer/shared/ask-user-question.js";
import { parseToolApprovalScope } from "../../renderer/shared/tool-approval-scope.js";
import {
  boundedText,
  createRunProjectionState,
  isCoalescibleDelta,
  MAX_COALESCED_DELTA_EVENT_BYTES,
  mergeDeltaPayload,
  ownRecord,
  projectApprovalDetails,
  projectRunContentNotification,
  type RunContentProjection,
  type RunProjectionState,
} from "./run-event-projection.js";

export type HostRunOrigin = "renderer" | "remote" | "headless";
export type HostRunState =
  | "working" | "needs_approval" | "needs_input" | "done" | "failed" | "cancelled";

export interface HostRunEvent {
  runId: string;
  /** 1-based, contiguous per run. */
  sequence: number;
  timestamp: string;
  type: string;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface HostRunSummary {
  runId: string;
  chatId: string;
  origin: HostRunOrigin;
  state: HostRunState;
  startedAt: string;
  updatedAt: string;
  lastSequence: number;
  /** Pending prompt ids in arrival order. */
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
}

/** How a run prompt settled, kept briefly so a losing responder learns the winner. */
export type HostRunPromptResolution =
  | { kind: "approval"; decision: "allow" | "deny" | "expired" | "cancelled" }
  | { kind: "question"; outcome: "answered" | "expired" | "cancelled" };

export type HostRunResolvedPrompt = HostRunPromptResolution & {
  runId: string;
  promptId: string;
  resolvedAt: string;
};

/** A prompt still waiting for an answer, as it was journaled. */
export interface HostRunPendingPrompt {
  type: "approval_required" | "question_required";
  payload: Record<string, unknown>;
}

export type HostRunRead =
  | { kind: "events"; epoch: string; events: HostRunEvent[]; summary: HostRunSummary }
  | {
      kind: "snapshot_required";
      epoch: string;
      summary: HostRunSummary;
      /** The oldest sequence still retained; resume from `nextSequence - 1`. */
      nextSequence: number;
      /** Every pending prompt in arrival order, even when its event was trimmed. */
      prompts: HostRunPendingPrompt[];
    };

export interface HostRunRegistryOptions {
  now(): number;
  epoch?: string;
  maxEventsPerRun?: number;
  /**
   * A run always keeps its newest event, and a pending prompt is never
   * dropped. Prompts are bounded by their parsers, but a maximal question set
   * can serialize to roughly 150 KiB, so budgets below that per run (or below
   * `maxRuns` times that in total) can be exceeded by a run's sole prompt.
   * The defaults hold every bounded prompt.
   */
  maxEventBytesPerRun?: number;
  maxTotalEventBytes?: number;
  maxRuns?: number;
  terminalRetentionMs?: number;
  /** Bound on remembered prompt resolutions (count and age). */
  maxResolutions?: number;
  resolutionRetentionMs?: number;
  /**
   * Consecutive text or reasoning deltas that no observer has read yet fold
   * into one event for up to this many milliseconds (default 250), so a long
   * answer costs a few journal events per second rather than one per token.
   * Zero disables folding.
   */
  deltaCoalesceMs?: number;
}

type ContentState = Extract<RunContentProjection, { kind: "event" }>["state"];

interface RunRecord {
  runId: string;
  chatId: string;
  origin: HostRunOrigin;
  state: HostRunState;
  startedAt: number;
  updatedAt: number;
  lastSequence: number;
  events: HostRunEvent[];
  eventBytes: number;
  pendingApprovalIds: string[];
  pendingQuestionIds: string[];
  /** Pending prompt payloads, kept outside the trimmable journal. */
  prompts: Map<string, HostRunPendingPrompt>;
  projection: RunProjectionState;
  subscribers: Set<() => void>;
  /** The newest delta event while no `read` has returned it. */
  openDelta?: { sequence: number; openedAt: number };
}

interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
  terminal: boolean;
  /** Terminal outcome; live runs derive their state from pending prompts. */
  outcome?: HostRunState;
}

const DEFAULT_MAX_EVENTS_PER_RUN = 4_096;
const DEFAULT_MAX_EVENT_BYTES_PER_RUN = 4 * 1_024 * 1_024;
const DEFAULT_MAX_TOTAL_EVENT_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_MAX_RUNS = 128;
const DEFAULT_TERMINAL_RETENTION_MS = 10 * 60_000;
const DEFAULT_MAX_RESOLUTIONS = 512;
const DEFAULT_RESOLUTION_RETENTION_MS = 10 * 60_000;
const DEFAULT_DELTA_COALESCE_MS = 250;
const MAX_PROMPT_ID_LENGTH = 128;
// Approval details carry caller-supplied text (workspace names, commands) that
// nothing upstream bounds. A prompt can be a run's only retained event, which
// retention never trims, so details are kept only while the whole prompt fits
// an allowance derived from the configured budgets: half a run's budget, and
// half an equal share of the total.
const MAX_APPROVAL_PAYLOAD_BYTES = 64 * 1_024;
const MAX_APPROVAL_SUMMARY_LENGTH = 2_000;

function isTerminalState(state: HostRunState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function outcomeFor(state: ContentState): HostRunState | undefined {
  if (state === "done") return "done";
  if (state === "cancelled") return "cancelled";
  if (state === "error" || state === "interrupted") return "failed";
  return undefined;
}

function promptId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROMPT_ID_LENGTH
    ? value
    : undefined;
}

function knownScopes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = [...new Set(value.map(parseToolApprovalScope))].filter(
    (scope): scope is NonNullable<typeof scope> => scope !== undefined,
  );
  return scopes.length > 0 ? scopes : undefined;
}

function approvalEvent(
  payload: Record<string, unknown>,
  approvalId: string,
  maximumPayloadBytes: number,
): PendingEvent {
  const scopes = knownScopes(payload.scopes);
  const summary = boundedText(payload.summary, MAX_APPROVAL_SUMMARY_LENGTH);
  const prompt: Record<string, unknown> = {
    approvalId,
    summary: summary || "Aiden needs approval.",
    toolCallId: boundedText(payload.toolCallId, 128),
    toolName: boundedText(payload.toolName, 120) || "Tool",
    ...(scopes ? { scopes } : {}),
  };
  // A generic command approval carries the whole command in its summary. A
  // shortened summary hides part of what would be allowed, so it is withheld
  // like oversized details: a controller can deny it but not allow it.
  const summaryShortened = typeof payload.summary === "string" && summary.length < payload.summary.length;
  if (summaryShortened) return { type: "approval_required", payload: { ...prompt, detailsOmitted: true }, terminal: false };
  // Details pass the same allowlist as Remote approvals: unrecognized kinds and
  // undeclared fields (such as classifier state) are never journaled, so no
  // observer of this host can read them.
  const supplied = ownRecord(payload.details) !== null;
  const details = projectApprovalDetails(payload.details);
  if (!details) {
    return {
      type: "approval_required",
      payload: supplied ? { ...prompt, detailsOmitted: true } : prompt,
      terminal: false,
    };
  }
  const withDetails = { ...prompt, details };
  let fits = false;
  try {
    fits = Buffer.byteLength(JSON.stringify(withDetails)) <= maximumPayloadBytes;
  } catch {
    // Unserializable details are treated like oversized ones.
  }
  return {
    type: "approval_required",
    payload: fits ? withDetails : { ...prompt, detailsOmitted: true },
    terminal: false,
  };
}

function questionEvent(payload: Record<string, unknown>, id: string): PendingEvent | undefined {
  const questions = parseAskUserQuestions(payload.questions);
  const toolCallId = boundedText(payload.toolCallId, 128);
  if (!questions || !toolCallId) return undefined;
  const deadline = typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  return {
    type: "question_required",
    payload: {
      promptId: id,
      questions,
      toolCallId,
      ...(Number.isFinite(deadline) ? { expiresAt: new Date(deadline).toISOString() } : {}),
    },
    terminal: false,
  };
}

/**
 * Host-wide, in-memory journal of every generation run, whoever started it.
 * Observers are woken synchronously and pull with `read`, so a slow observer
 * only ever costs bounded journal memory, never back-pressure on the run.
 */
export class HostRunRegistry {
  readonly epoch: string;
  private readonly runs = new Map<string, RunRecord>();
  private readonly promptRuns = new Map<string, string>();
  private readonly resolutions = new Map<string, HostRunResolvedPrompt & { at: number }>();
  private readonly eventSizes = new WeakMap<HostRunEvent, number>();
  private readonly listeners = new Set<(summary: HostRunSummary, removed: boolean) => void>();
  private totalEventBytes = 0;
  private readonly maxEventsPerRun: number;
  private readonly maxEventBytesPerRun: number;
  private readonly maxTotalEventBytes: number;
  private readonly maxRuns: number;
  private readonly terminalRetentionMs: number;
  private readonly maxApprovalPayloadBytes: number;
  private readonly deltaCoalesceMs: number;

  constructor(private readonly options: HostRunRegistryOptions) {
    this.epoch = options.epoch ?? randomUUID();
    this.maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
    this.maxEventBytesPerRun = options.maxEventBytesPerRun ?? DEFAULT_MAX_EVENT_BYTES_PER_RUN;
    this.maxTotalEventBytes = options.maxTotalEventBytes ?? DEFAULT_MAX_TOTAL_EVENT_BYTES;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.deltaCoalesceMs = options.deltaCoalesceMs ?? DEFAULT_DELTA_COALESCE_MS;
    this.maxApprovalPayloadBytes = Math.min(
      MAX_APPROVAL_PAYLOAD_BYTES,
      Math.floor(this.maxEventBytesPerRun / 2),
      Math.floor(this.maxTotalEventBytes / (2 * this.maxRuns)),
    );
  }

  begin(input: { runId: string; chatId: string; origin: HostRunOrigin }): void {
    this.pruneExpired();
    if (this.runs.has(input.runId)) return;
    while (this.runs.size >= this.maxRuns) {
      const victim = this.oldestEvictable();
      if (!victim) break;
      this.remove(victim);
    }
    const now = this.options.now();
    const run: RunRecord = {
      runId: input.runId,
      chatId: input.chatId,
      origin: input.origin,
      state: "working",
      startedAt: now,
      updatedAt: now,
      lastSequence: 0,
      events: [],
      eventBytes: 0,
      pendingApprovalIds: [],
      pendingQuestionIds: [],
      prompts: new Map(),
      projection: createRunProjectionState(),
      subscribers: new Set(),
    };
    this.runs.set(run.runId, run);
    this.append(run, {
      type: "run_started",
      payload: { chatId: input.chatId, origin: input.origin },
      terminal: false,
    });
    this.notifyChange(run, false);
  }

  publish(runId: string, channel: NotificationChannel, rawPayload: unknown): void {
    this.pruneExpired();
    const run = this.runs.get(runId);
    if (!run || isTerminalState(run.state)) return;
    let pending: PendingEvent | undefined;
    let approvalId: string | undefined;
    let questionId: string | undefined;
    try {
      const payload = ownRecord(rawPayload) ?? {};
      if (channel === "chat:approval") {
        approvalId = promptId(payload.approvalId);
        if (!approvalId || this.promptRuns.has(approvalId)) return;
        pending = approvalEvent(payload, approvalId, this.maxApprovalPayloadBytes);
      } else if (channel === "chat:questionnaire") {
        questionId = promptId(payload.promptId);
        if (!questionId || this.promptRuns.has(questionId)) return;
        pending = questionEvent(payload, questionId);
      } else {
        const projected = projectRunContentNotification(run.projection, channel, payload, {
          chatId: run.chatId,
          turnId: run.runId,
          lastSequence: run.lastSequence,
          cancelRequested: false,
          cancellationSource: "server",
        });
        if (projected.kind !== "event") return;
        pending = {
          type: projected.type,
          payload: structuredClone(projected.payload),
          terminal: projected.terminal,
          outcome: projected.terminal ? (outcomeFor(projected.state) ?? "failed") : undefined,
        };
      }
    } catch {
      // A malformed notification must never break the generation feeding it.
      return;
    }
    if (!pending) return;
    if (approvalId) {
      run.pendingApprovalIds.push(approvalId);
      this.promptRuns.set(approvalId, run.runId);
      run.prompts.set(approvalId, { type: "approval_required", payload: pending.payload });
    }
    if (questionId) {
      run.pendingQuestionIds.push(questionId);
      this.promptRuns.set(questionId, run.runId);
      run.prompts.set(questionId, { type: "question_required", payload: pending.payload });
    }
    this.commit(run, pending, Boolean(approvalId || questionId));
  }

  /**
   * Settle a pending prompt. The optional resolution is remembered (bounded by
   * count and age) so a responder that lost the race learns the winning
   * decision, and is carried on the journaled `*_resolved` event.
   */
  resolveAttention(id: string, resolution?: HostRunPromptResolution): void {
    const runId = this.promptRuns.get(id);
    if (runId === undefined) return;
    this.promptRuns.delete(id);
    const run = this.runs.get(runId);
    if (!run) return;
    run.prompts.delete(id);
    const approvalIndex = run.pendingApprovalIds.indexOf(id);
    if (approvalIndex >= 0) {
      run.pendingApprovalIds.splice(approvalIndex, 1);
      const decision = resolution?.kind === "approval" ? resolution.decision : undefined;
      this.remember(runId, id, decision ? { kind: "approval", decision } : undefined);
      this.commit(run, {
        type: "approval_resolved",
        payload: { approvalId: id, ...(decision ? { decision } : {}) },
        terminal: false,
      }, true);
      return;
    }
    const questionIndex = run.pendingQuestionIds.indexOf(id);
    if (questionIndex >= 0) {
      run.pendingQuestionIds.splice(questionIndex, 1);
      const outcome = resolution?.kind === "question" ? resolution.outcome : undefined;
      this.remember(runId, id, outcome ? { kind: "question", outcome } : undefined);
      this.commit(run, {
        type: "question_resolved",
        payload: { promptId: id, ...(outcome ? { outcome } : {}) },
        terminal: false,
      }, true);
    }
  }

  /** The run a pending or recently resolved prompt belongs to. */
  runForPrompt(id: string): string | undefined {
    this.pruneResolutions();
    return this.promptRuns.get(id) ?? this.resolutions.get(id)?.runId;
  }

  /** A prompt that is still waiting, as journaled (details included when they fit). */
  pendingPrompt(id: string): HostRunPendingPrompt | undefined {
    const runId = this.promptRuns.get(id);
    const prompt = runId === undefined ? undefined : this.runs.get(runId)?.prompts.get(id);
    return prompt ? structuredClone(prompt) : undefined;
  }

  /** The remembered settlement of a recently resolved prompt, if any. */
  resolution(id: string): HostRunResolvedPrompt | undefined {
    this.pruneResolutions();
    const entry = this.resolutions.get(id);
    if (!entry) return undefined;
    const { at: _at, ...resolved } = entry;
    return { ...resolved };
  }

  settle(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || isTerminalState(run.state)) return;
    this.commit(run, {
      type: "error",
      payload: {
        code: "run_ended_without_outcome",
        message: "The run ended without reporting an outcome.",
      },
      terminal: true,
      outcome: "failed",
    }, true);
  }

  summary(runId: string): HostRunSummary | undefined {
    this.pruneExpired();
    const run = this.runs.get(runId);
    return run ? this.summarize(run) : undefined;
  }

  currentRunForChat(chatId: string): HostRunSummary | undefined {
    this.pruneExpired();
    let newest: RunRecord | undefined;
    for (const run of this.runs.values()) {
      if (run.chatId !== chatId) continue;
      if (
        !newest ||
        run.startedAt > newest.startedAt ||
        (run.startedAt === newest.startedAt && run.runId > newest.runId)
      ) {
        newest = run;
      }
    }
    return newest ? this.summarize(newest) : undefined;
  }

  list(): HostRunSummary[] {
    this.pruneExpired();
    return [...this.runs.values()].map((run) => this.summarize(run));
  }

  /**
   * Events after `afterSequence`, oldest first, at most `limit` of them. A
   * cursor older than retention returns `snapshot_required` with the pending
   * prompts so the observer can rebuild its attention state.
   */
  read(runId: string, afterSequence: number, limit = Number.POSITIVE_INFINITY): HostRunRead {
    this.pruneExpired();
    const run = this.runs.get(runId);
    if (!run) throw new RangeError("Unknown host run.");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > run.lastSequence) {
      throw new RangeError("The run cursor is outside its journal.");
    }
    const summary = this.summarize(run);
    const firstRetained = run.events[0]?.sequence ?? run.lastSequence + 1;
    if (afterSequence < firstRetained - 1) {
      return {
        kind: "snapshot_required",
        epoch: this.epoch,
        summary,
        nextSequence: firstRetained,
        prompts: [...run.prompts.values()].map((prompt) => structuredClone(prompt)),
      };
    }
    // Sequences are contiguous, so the first unread event sits at a fixed offset.
    const start = afterSequence - (firstRetained - 1);
    const end = Number.isFinite(limit) ? start + Math.max(1, Math.floor(limit)) : run.events.length;
    const events = run.events
      .slice(start, end)
      .map((event) => structuredClone(event));
    // A returned event is final: the reader's cursor now covers it, so
    // later deltas must take a new sequence rather than extend it.
    if (events.length > 0) run.openDelta = undefined;
    return { kind: "events", epoch: this.epoch, events, summary };
  }

  subscribe(runId: string, wake: () => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.subscribers.add(wake);
    return () => {
      run.subscribers.delete(wake);
    };
  }

  onChange(listener: (summary: HostRunSummary, removed: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private remember(runId: string, promptId: string, resolution: HostRunPromptResolution | undefined): void {
    if (!resolution) return;
    const at = this.options.now();
    this.resolutions.delete(promptId);
    this.resolutions.set(promptId, {
      ...resolution,
      runId,
      promptId,
      resolvedAt: new Date(at).toISOString(),
      at,
    });
    this.pruneResolutions();
  }

  private pruneResolutions(): void {
    const maximum = this.options.maxResolutions ?? DEFAULT_MAX_RESOLUTIONS;
    const cutoff = this.options.now() - (this.options.resolutionRetentionMs ?? DEFAULT_RESOLUTION_RETENTION_MS);
    for (const [id, entry] of this.resolutions) {
      if (this.resolutions.size > maximum || entry.at < cutoff) this.resolutions.delete(id);
      else break;
    }
  }

  /** Append, settle the run state, then wake observers and announce any change. */
  private commit(run: RunRecord, pending: PendingEvent, attentionChanged: boolean): void {
    const previousState = run.state;
    if (pending.terminal) {
      for (const id of [...run.pendingApprovalIds, ...run.pendingQuestionIds]) {
        this.promptRuns.delete(id);
      }
      run.prompts.clear();
      attentionChanged ||= run.pendingApprovalIds.length + run.pendingQuestionIds.length > 0;
      run.pendingApprovalIds = [];
      run.pendingQuestionIds = [];
      run.state = pending.outcome ?? "failed";
    } else {
      run.state = run.pendingApprovalIds.length > 0
        ? "needs_approval"
        : run.pendingQuestionIds.length > 0
          ? "needs_input"
          : "working";
    }
    this.append(run, pending);
    if (attentionChanged || run.state !== previousState) this.notifyChange(run, false);
  }

  private append(run: RunRecord, pending: PendingEvent): void {
    const now = this.options.now();
    if (!pending.terminal && this.extendOpenDelta(run, pending, now)) return;
    const event: HostRunEvent = {
      runId: run.runId,
      sequence: run.lastSequence + 1,
      timestamp: new Date(now).toISOString(),
      type: pending.type,
      terminal: pending.terminal,
      payload: pending.payload,
    };
    run.events.push(event);
    run.lastSequence = event.sequence;
    run.updatedAt = now;
    run.openDelta = isCoalescibleDelta(event.type) ? { sequence: event.sequence, openedAt: now } : undefined;
    this.addBytes(run, this.eventSize(event));
    this.trimRun(run);
  }

  /**
   * Fold a delta into the run's unread tail delta. It keeps its sequence:
   * no reader's cursor has reached it, so nobody can miss the added text,
   * and ordering against prompts, tools and the outcome is unchanged
   * because any other event closes the tail first.
   */
  private extendOpenDelta(run: RunRecord, pending: PendingEvent, now: number): boolean {
    const open = run.openDelta;
    const tail = run.events[run.events.length - 1];
    if (!open || !tail || tail.sequence !== open.sequence || tail.type !== pending.type) return false;
    if (now - open.openedAt >= this.deltaCoalesceMs) return false;
    const merged = mergeDeltaPayload(pending.type, tail.payload, pending.payload);
    if (!merged) return false;
    // Replace rather than mutate: cached sizes are keyed on the event object.
    const event: HostRunEvent = { ...tail, payload: merged };
    const bytes = this.eventSize(event);
    if (bytes > MAX_COALESCED_DELTA_EVENT_BYTES) return false;
    run.events[run.events.length - 1] = event;
    run.updatedAt = now;
    this.addBytes(run, bytes - this.eventSize(tail));
    this.trimRun(run);
    return true;
  }

  private trimRun(run: RunRecord): void {
    while (
      run.events.length > this.maxEventsPerRun ||
      (run.eventBytes > this.maxEventBytesPerRun && run.events.length > 1)
    ) {
      this.dropOldest(run);
    }
    this.enforceTotalBudget(run);
    this.wake(run);
  }

  private enforceTotalBudget(current: RunRecord): void {
    if (this.totalEventBytes <= this.maxTotalEventBytes) return;
    const terminalRuns = [...this.runs.values()]
      .filter((run) => run !== current && isTerminalState(run.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const run of terminalRuns) {
      this.remove(run);
      if (this.totalEventBytes <= this.maxTotalEventBytes) return;
    }
    while (this.totalEventBytes > this.maxTotalEventBytes) {
      const trimmable = [...this.runs.values()].filter((run) => run.events.length > 1);
      const live = trimmable.filter((run) => !isTerminalState(run.state));
      const candidate = (live.length > 0 ? live : trimmable)
        .sort((left, right) => right.eventBytes - left.eventBytes)[0];
      if (!candidate) return;
      this.dropOldest(candidate);
    }
  }

  private pruneExpired(): void {
    const cutoff = this.options.now() - this.terminalRetentionMs;
    for (const run of [...this.runs.values()]) {
      if (isTerminalState(run.state) && run.updatedAt < cutoff) this.remove(run);
    }
  }

  private oldestEvictable(): RunRecord | undefined {
    const runs = [...this.runs.values()];
    const terminalRuns = runs.filter((run) => isTerminalState(run.state));
    const pool = terminalRuns.length > 0 ? terminalRuns : runs;
    return pool.reduce<RunRecord | undefined>(
      (oldest, run) => (!oldest || run.updatedAt < oldest.updatedAt ? run : oldest),
      undefined,
    );
  }

  private remove(run: RunRecord): void {
    if (!this.runs.delete(run.runId)) return;
    for (const id of [...run.pendingApprovalIds, ...run.pendingQuestionIds]) {
      this.promptRuns.delete(id);
    }
    this.totalEventBytes -= run.eventBytes;
    // Woken observers find the run gone and must snapshot from elsewhere.
    this.wake(run);
    run.subscribers.clear();
    this.notifyChange(run, true);
  }

  private dropOldest(run: RunRecord): void {
    const removed = run.events.shift();
    if (removed) this.addBytes(run, -this.eventSize(removed));
  }

  private addBytes(run: RunRecord, bytes: number): void {
    run.eventBytes += bytes;
    this.totalEventBytes += bytes;
  }

  private eventSize(event: HostRunEvent): number {
    let bytes = this.eventSizes.get(event);
    if (bytes === undefined) {
      bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      this.eventSizes.set(event, bytes);
    }
    return bytes;
  }

  private wake(run: RunRecord): void {
    for (const wake of [...run.subscribers]) {
      try {
        wake();
      } catch {
        // An observer fault must not stop the journal or other observers.
      }
    }
  }

  private notifyChange(run: RunRecord, removed: boolean): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.summarize(run), removed);
      } catch {
        // Same isolation as wake().
      }
    }
  }

  private summarize(run: RunRecord): HostRunSummary {
    return {
      runId: run.runId,
      chatId: run.chatId,
      origin: run.origin,
      state: run.state,
      startedAt: new Date(run.startedAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
      lastSequence: run.lastSequence,
      pendingApprovalIds: [...run.pendingApprovalIds],
      pendingQuestionIds: [...run.pendingQuestionIds],
    };
  }
}

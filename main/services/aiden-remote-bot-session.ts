// Remote surface of the durable Bot runtime (contract revision 25).
//
// - `GET /bots/{id}/session` and its SSE stream project the Bot's one Pi Durable
//   conversation: displayable entries, the in-flight partial and the paused
//   (`interrupted`) state. Every frame carries `(epoch, seq)`; the epoch is
//   minted per attachment to the conversation, so a reopened harness (idle
//   close, restart, corrupt-file reset) always reaches clients as a new epoch.
// - Send, Resume, Dismiss and Stop are idempotent per request UUID through the
//   shared Bot idempotency ledger; the UUID is also the session `requestId`.
// - A waiting A–E question is the snapshot's `question` and a `question` frame,
//   published through the same serialized projection as entries and state.
//   Answering it is idempotent per request UUID; another UUID for a question
//   that is no longer waiting is `question_expired`.
// - Routines, connection requests and starter presets call their main services.

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
  connectionSuggestionFor,
  type ConnectCardEntry,
  type ConnectCardStatus,
} from "../../renderer/shared/bot-connections.js";
import type { BotPreset } from "../../renderer/shared/bot-presets.js";
import { formatBotRoutineLabel } from "../../renderer/shared/bot-routine-label.js";
import { botRoutineCron } from "../../renderer/shared/bot-routine-schedule.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AIDEN_REMOTE_BOT_PRESETS_MAX,
  AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES,
  AIDEN_REMOTE_BOT_SESSION_MAX_TEXT_CHARS,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  parseAidenRemoteBotConnectionRequest,
  parseAidenRemoteBotMessageRequest,
  parseAidenRemoteBotRoutine,
  parseAidenRemoteBotRoutineCreateRequest,
  parseAidenRemoteBotRoutineList,
  parseAidenRemoteBotRoutineUpdateRequest,
  parseAidenRemoteBotPresetCreateRequest,
  parseAidenRemoteBotPresetList,
  parseAidenRemoteBotQuestionAnswerRequest,
  parseAidenRemoteBotSession,
  parseAidenRemoteEmptyRequest,
  type AidenRemoteBotConnectionRequestReceipt,
  type AidenRemoteBotMessageReceipt,
  type AidenRemoteBotPresetCreateResult,
  type AidenRemoteBotPresetList,
  type AidenRemoteBotQuestion,
  type AidenRemoteBotQuestionAnswerReceipt,
  type AidenRemoteBotRoutine,
  type AidenRemoteBotRoutineList,
  type AidenRemoteBotSession,
  type AidenRemoteBotSessionEntry,
  type AidenRemoteBotSessionEvent,
  type AidenRemoteBotSessionStateKind,
  type AidenRemoteBotSessionStateView,
  type AidenRemoteBotSummary,
} from "./aiden-remote-protocol.js";
import { openCursorSse, sseFrame, type CursorSseHandle } from "./aiden-remote-sse.js";
import type { BotQuestions } from "./bot-runtime/bot-questions.js";
import { BotSessionError, type BotSessionState } from "./bot-runtime/bot-session-service.js";
import { livePartialText, projectBotTranscript } from "./bot-runtime/live-projection.js";
import {
  BOT_ROUTINE_SILENT_INSTRUCTION,
  type BotRoutine,
  type BotRoutineService,
} from "./scheduled-bot-routines.js";

/** Kind of the typed connect card entry `suggest_connection` appends. */
export { BOT_CONNECT_CARD_ENTRY_KIND } from "./bot-runtime/live-projection.js";
const ctx = BACKGROUND_CONTEXT;
const MAX_SESSION_JSON_BYTES = 768 * 1_024;
const MAX_PENDING_FRAMES = 256;
const PROJECTOR_IDLE_MS = 60_000;

export interface AidenRemoteBotSessionRuntime {
  send(
    botId: string,
    input: { text: string; requestId: string },
  ): Promise<{ submissionId: string; deduped: boolean }>;
  resume(botId: string, requestId: string): Promise<BotSessionState>;
  dismiss(botId: string, requestId: string): Promise<BotSessionState>;
  /** Ends a running turn (serialized with send/resume/dismiss); a paused turn is left for Dismiss. */
  stop(botId: string): Promise<BotSessionState>;
  state(botId: string): Promise<BotSessionState>;
  conversation(botId: string): Promise<Conversation>;
}

export interface AidenRemoteBotSessionServiceOptions {
  /** The live Bot lookup and the shared idempotency ledger (`AidenRemoteBotService`). */
  bots: {
    bot(botId: string): Promise<BotDefinition>;
    summaryOf(botId: string): Promise<AidenRemoteBotSummary>;
    executeIdempotent<Result>(
      scope: { deviceId: string; route: string; resourceId: string; key: string },
      input: unknown,
      action: () => Promise<Result>,
    ): Promise<Result>;
  };
  runtime(): Promise<AidenRemoteBotSessionRuntime>;
  /** The Bot's waiting A–E questions (the same bridge the desktop answers through). */
  questions?: Pick<BotQuestions, "pending" | "answer" | "onChange">;
  routines?: Pick<BotRoutineService, "list" | "create" | "update" | "delete">;
  presets?: {
    list(): readonly BotPreset[];
    /**
     * Start Chat on a starter Bot. Must be the process-wide starter the desktop
     * uses too (`botStarter()`), so a Mac tap and a phone tap converge on one
     * Bot and only the creating call sends the self-intro.
     */
    create(presetId: string, options: { audienceId: string }): Promise<{ botId: string; created: boolean }>;
  };
  /**
   * What a connect card shows now (connected, or answered with Not now since
   * it was offered). The desktop live view uses the same resolver.
   */
  connectCardStatus?(botId: string, card: ConnectCardEntry): Promise<ConnectCardStatus>;
  /** Raise the Mac notification that opens connection setup for `pluginId`. */
  connectionRequested?(input: { botId: string; pluginId: string; name: string }): Promise<void>;
  defaultTimezone?(): string;
  notifyBotsChanged?(botId?: string): void;
  now?(): number;
  projectorIdleMs?: number;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Wire-safe text: lone UTF-16 surrogates (which the strict parsers reject, and
 * which would make the whole snapshot unservable) become U+FFFD, and the text
 * is cut by code point so a cut never splits a surrogate pair.
 */
function wireText(text: string, maximum: number): string {
  const wellFormed = text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
    "�",
  );
  const points = [...wellFormed];
  return points.length > maximum ? points.slice(0, maximum).join("") : wellFormed;
}

function bounded(text: string): string {
  return wireText(text, AIDEN_REMOTE_BOT_SESSION_MAX_TEXT_CHARS);
}

function stripRoutineInstruction(text: string): string {
  const suffix = `\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`;
  if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  return text.endsWith(BOT_ROUTINE_SILENT_INSTRUCTION)
    ? text.slice(0, -BOT_ROUTINE_SILENT_INSTRUCTION.length).trimEnd()
    : text;
}

function isoOf(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : undefined;
}

/** Shown when a turn failed before writing any text; the details stay on the Mac. */
export const BOT_REMOTE_FAILED_REPLY_TEXT = "I couldn't finish that reply. Try sending it again.";

const wireEntryId = (id: string) => `entry_${id}`;

/**
 * Displayable wire entries of a conversation, oldest first. Derived from the
 * desktop transcript (`projectBotTranscript`), so a phone shows exactly what
 * the Mac shows: the hidden self-intro prompt and whole `[SILENT]` routine
 * turns are left out, tool traffic stays on the Mac, a failed turn surfaces,
 * and each plugin has one connect card (latest status at the first card's place).
 */
export function projectBotSessionEntries(entries: readonly EntryRecord[]): AidenRemoteBotSessionEntry[] {
  const output: AidenRemoteBotSessionEntry[] = [];
  const cards = new Map<string, number>();
  for (const entry of projectBotTranscript(entries)) {
    const id = wireEntryId(entry.id);
    switch (entry.type) {
      case "user":
      case "routine": {
        const createdAt = isoOf(entry.at);
        const label = entry.type === "routine" ? wireText(entry.label, 120).trim() : "";
        output.push({
          type: "message",
          id,
          role: "user",
          text: bounded(entry.type === "routine" ? stripRoutineInstruction(entry.text) : entry.text),
          ...(createdAt ? { createdAt } : {}),
          ...(label ? { label } : {}),
        });
        break;
      }
      case "assistant": {
        const failed = entry.stopReason === "error";
        const text = entry.text.trim() ? entry.text : failed ? BOT_REMOTE_FAILED_REPLY_TEXT : "";
        // A tool-only step has no text to show; its activity stays on the Mac.
        if (!text) break;
        const createdAt = isoOf(entry.at);
        output.push({
          type: "message",
          id,
          role: "assistant",
          text: bounded(text),
          ...(createdAt ? { createdAt } : {}),
          ...(entry.stopReason === "aborted" ? { interrupted: true as const } : {}),
        });
        break;
      }
      case "question_answer": {
        // The person's choice on a quick-reply card reads as their message.
        const createdAt = isoOf(entry.at);
        output.push({ type: "message", id, role: "user", text: bounded(entry.text), ...(createdAt ? { createdAt } : {}) });
        break;
      }
      case "notice":
        if (entry.notice === "session_reset") {
          output.push({ type: "notice", id, notice: "session_reset" });
        } else {
          const last = [...output].reverse().find((item) => item.type === "message");
          if (last?.type === "message" && last.role === "assistant") last.interrupted = true;
        }
        break;
      case "connect_card": {
        const suggestion = connectionSuggestionFor(entry.card.pluginId);
        if (!suggestion) break;
        const projected: AidenRemoteBotSessionEntry = {
          type: "connect_card",
          id,
          pluginId: suggestion.pluginId,
          name: suggestion.name,
          iconId: suggestion.iconId,
          reason: wireText(entry.card.reason.trim(), 280) || `Connect ${suggestion.name}.`,
          status: entry.card.status,
        };
        const index = cards.get(suggestion.pluginId);
        if (index === undefined) {
          cards.set(suggestion.pluginId, output.length);
          output.push(projected);
        } else {
          output[index] = { ...projected, id: output[index]!.id };
        }
        break;
      }
      default:
        break;
    }
  }
  return output;
}

/** Text of the in-flight (or paused) assistant partial, if any. A reply heading for `[SILENT]` is never shown. */
export function projectBotSessionPartial(view: Pick<ConversationView, "docs">): string | undefined {
  const text = livePartialText(view.docs);
  return text ? bounded(text) : undefined;
}

export function projectBotSessionState(state: BotSessionState): AidenRemoteBotSessionStateView {
  if (state.kind === "interrupted") {
    return { state: "interrupted", interrupted: true, ...(state.blocked ? { blocked: state.blocked } : {}) };
  }
  // A model that exists but cannot run right now is `unavailable` on the wire;
  // its message stays on the Mac.
  if (state.kind === "model_error") return { state: "unavailable", interrupted: false };
  return { state: state.kind as AidenRemoteBotSessionStateKind, interrupted: false };
}

function windowed(entries: AidenRemoteBotSessionEntry[]): { entries: AidenRemoteBotSessionEntry[]; hasOlder: boolean } {
  let start = Math.max(0, entries.length - AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES);
  let window = entries.slice(start);
  while (window.length > 1 && Buffer.byteLength(JSON.stringify(window), "utf8") > MAX_SESSION_JSON_BYTES) {
    start += Math.max(1, Math.floor(window.length / 4));
    window = entries.slice(start);
  }
  return { entries: window, hasOlder: start > 0 };
}

// ---------------------------------------------------------------------------
// Live projector: one per Bot, shared by every client.
// ---------------------------------------------------------------------------

interface Subscriber {
  frames: string[];
  handle?: CursorSseHandle;
  overflowed: boolean;
}

class BotLiveProjector {
  readonly epoch = `epoch_${randomUUID().replace(/-/gu, "")}`;
  seq = 0;
  entries: AidenRemoteBotSessionEntry[] = [];
  partial: string | undefined;
  state: AidenRemoteBotSessionStateView = { state: "idle", interrupted: false };
  question: AidenRemoteBotQuestion | null = null;
  readonly subscribers = new Set<Subscriber>();
  private view: ConversationView | undefined;
  private stopWatch: (() => Promise<unknown>) | undefined;
  private lane: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(
    readonly botId: string,
    private readonly readState: () => Promise<AidenRemoteBotSessionStateView>,
    private readonly resolveEntries: (entries: AidenRemoteBotSessionEntry[]) => Promise<AidenRemoteBotSessionEntry[]>,
    private readonly idleMs: number,
    private readonly onClosed: () => void,
    private readonly readQuestion: () => AidenRemoteBotQuestion | null = () => null,
  ) {}

  async attach(conversation: Conversation): Promise<void> {
    const watch = await conversation.watch(ctx);
    this.stopWatch = () => watch.stop();
    this.view = watch.value;
    this.entries = await this.resolveEntries(projectBotSessionEntries(watch.value.entries));
    this.partial = projectBotSessionPartial(watch.value);
    this.state = await this.readState();
    this.question = this.readQuestion();
    watch.start(async (view) => {
      await this.advance(view);
    });
    void watch.closed.then(() => this.close(), () => this.close());
    this.armIdle();
  }

  snapshot(): AidenRemoteBotSession {
    return parseAidenRemoteBotSession({
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...this.state,
      ...(this.partial !== undefined ? { partial: this.partial } : {}),
      ...windowed(this.entries),
      question: this.question,
    });
  }

  /** The `snapshot` frame for the current seq (first frame of a stream, or a history rewrite). */
  snapshotFrame(): string {
    const session = this.snapshot();
    return sseFrame(`${session.epoch}:${session.seq}`, "snapshot", {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: session.botId,
      epoch: session.epoch,
      seq: session.seq,
      type: "snapshot",
      payload: { session },
    });
  }

  private broadcast(text: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.frames.length >= MAX_PENDING_FRAMES) {
        // A stalled client is dropped; it reconnects and gets a fresh snapshot.
        subscriber.overflowed = true;
      } else {
        subscriber.frames.push(text);
      }
      subscriber.handle?.wake();
    }
  }

  private frame(event: Omit<AidenRemoteBotSessionEvent, "protocolVersion" | "botId" | "epoch" | "seq">): void {
    this.seq += 1;
    const data = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...event,
    };
    this.broadcast(sseFrame(`${this.epoch}:${this.seq}`, event.type, data));
  }

  /**
   * Watch callbacks and refreshes both project asynchronously. They run one at
   * a time so a slow, older read can never publish after a newer one: frames
   * stay in causal order and every seq is exactly one more than the last.
   */
  private serial<Result>(action: () => Promise<Result>): Promise<Result> {
    const run = this.lane.then(action, action);
    this.lane = run.then(() => undefined, () => undefined);
    return run;
  }

  advance(view: ConversationView): Promise<void> {
    return this.serial(async () => {
      this.view = view;
      await this.publish(view);
    });
  }

  /**
   * Re-project the latest view and re-read the state: Resume, Dismiss, Stop,
   * a lock change or a connection finished on the Mac change what a client
   * should see without committing to the conversation.
   */
  refresh(): Promise<void> {
    return this.serial(async () => {
      if (this.view) await this.publish(this.view);
    });
  }

  private async publish(view: ConversationView): Promise<void> {
    if (this.closed) return;
    const next = await this.resolveEntries(projectBotSessionEntries(view.entries));
    const partial = projectBotSessionPartial(view);
    const state = await this.readState().catch(() => this.state);
    const question = this.readQuestion();
    if (this.closed) return;

    const previous = this.entries;
    const previousById = new Map(previous.map((entry) => [entry.id, JSON.stringify(entry)]));
    const nextIds = new Set(next.map((entry) => entry.id));
    // Appends and in-place updates are entry events; anything that removes or
    // reorders shown history (a `[SILENT]` routine turn hiding its input) is a snapshot.
    const kept = previous.filter((entry) => nextIds.has(entry.id)).map((entry) => entry.id);
    const order = next.filter((entry) => previousById.has(entry.id)).map((entry) => entry.id);
    const rewritten = kept.length !== previous.length || kept.some((id, index) => order[index] !== id);

    this.entries = next;
    if (rewritten) {
      this.partial = partial;
      this.state = state;
      this.question = question;
      this.seq += 1;
      this.broadcast(this.snapshotFrame());
      return;
    }
    for (const entry of next) {
      if (previousById.get(entry.id) === JSON.stringify(entry)) continue;
      this.frame({ type: "entry", payload: { entry } });
    }
    if (partial !== this.partial) {
      this.partial = partial;
      // Always explicit: an empty text clears the partial, so a client never
      // has to guess whether an appended entry replaced it.
      this.frame({ type: "partial", payload: { text: partial ?? "" } });
    }
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      this.state = state;
      this.frame({ type: "state", payload: state });
    }
    if (question?.waitId !== this.question?.waitId) {
      this.question = question;
      this.frame({ type: "question", payload: { question } });
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    clearTimeout(this.idleTimer);
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      this.armIdle();
    };
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.closed || this.subscribers.size > 0) return;
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.frame({ type: "closed", payload: {} });
    this.onClosed();
    await this.stopWatch?.().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function mapSessionError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  if (error instanceof BotSessionError) {
    switch (error.reason) {
      case "bot_missing":
      case "bot_deleted":
        throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
      case "access_changed":
        throw new AidenRemoteServiceError("capability_denied", error.message, 403);
      case "needs_model":
      case "unavailable":
      case "bot_paused":
        throw new AidenRemoteServiceError("operation_stale", error.message, 409);
    }
  }
  throw error;
}

/**
 * A routine failure message for a phone: local file paths are replaced (they
 * name the Mac user and Aiden's private folders), as is anything shaped like
 * an API key, and the text is cut to the wire bound.
 */
export function redactRemoteError(message: string): string {
  const redacted = message
    .replace(/(?:file:\/\/)?(?:~|\/(?:Users|home|private|var|tmp|Volumes|Library|opt))(?:\/[^\s'"`)\]]*)+/gu, "[path]")
    .replace(/\b[A-Za-z]:\\[^\s'"`)\]]+/gu, "[path]")
    .replace(/\b(?:sk|pk|rk|xox[abpr]|gh[pousr]|AIza)[-_A-Za-z0-9]{12,}/gu, "[redacted]");
  return wireText(redacted, 500).trim() || "This routine failed.";
}

function routineRevision(routine: BotRoutine): string {
  return `routine_revision_${routine.updatedAt}`;
}

function iso(timestamp: number | undefined): string | undefined {
  return timestamp === undefined || !Number.isFinite(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function projectAidenRemoteBotRoutine(routine: BotRoutine): AidenRemoteBotRoutine {
  const nextRunAt = iso(routine.nextRunAt);
  const lastRunAt = iso(routine.lastRunAt);
  return parseAidenRemoteBotRoutine({
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    message: routine.prompt,
    schedule: routine.schedule,
    timezone: routine.timezone,
    label: routine.label,
    enabled: routine.enabled,
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(routine.lastResult ? { lastResult: routine.lastResult } : {}),
    ...(routine.lastError ? { lastError: redactRemoteError(routine.lastError) } : {}),
    updatedAt: new Date(routine.updatedAt).toISOString(),
    revision: routineRevision(routine),
  });
}

function routineError(error: unknown): never {
  if (error instanceof AidenRemoteServiceError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/no longer exists/u.test(message)) {
    throw new AidenRemoteServiceError("not_found", "This routine no longer exists.", 404);
  }
  if (/changed/u.test(message)) {
    throw new AidenRemoteServiceError(
      "revision_conflict",
      "This routine changed. Refresh it before trying again.",
      409,
    );
  }
  if (/^Invalid /u.test(message)) {
    throw new AidenRemoteServiceError("invalid_request", "The routine is invalid.", 400);
  }
  throw error;
}

function parseOrInvalid<Result>(parser: (value: unknown) => Result, value: unknown, message: string): Result {
  try {
    return parser(value);
  } catch {
    throw new AidenRemoteServiceError("invalid_request", message, 400);
  }
}

export class AidenRemoteBotSessionService {
  private readonly projectors = new Map<string, Promise<BotLiveProjector>>();
  private readonly subscriptions = new Map<string, Set<CursorSseHandle>>();

  constructor(private readonly options: AidenRemoteBotSessionServiceOptions) {
    // A question asked or settled is published in order with entries and state.
    options.questions?.onChange((botId) => {
      void this.projectors.get(botId)?.then((projector) => projector.refresh(), () => undefined);
    });
  }

  get supportsRoutines(): boolean {
    return Boolean(this.options.routines);
  }

  get supportsPresets(): boolean {
    return Boolean(this.options.presets);
  }

  get supportsConnectionRequests(): boolean {
    return Boolean(this.options.connectionRequested);
  }

  private async stateView(botId: string): Promise<AidenRemoteBotSessionStateView> {
    return projectBotSessionState(await (await this.options.runtime()).state(botId));
  }

  /** The Bot's one waiting question, in the wire shape. */
  private questionOf(botId: string): AidenRemoteBotQuestion | null {
    const prompt = this.options.questions?.pending(botId)[0];
    return prompt === undefined
      ? null
      : { waitId: prompt.waitId, toolCallId: prompt.toolCallId, questions: prompt.questions };
  }

  private questionService() {
    if (!this.options.questions) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return this.options.questions;
  }

  /**
   * Answer the Bot's waiting question. Idempotent per request UUID: a repeat
   * gets the same receipt. An answer the question does not accept is
   * `invalid_request`; a question that is no longer waiting is `question_expired`.
   */
  async answerQuestion(
    deviceId: string,
    botId: string,
    waitId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotQuestionAnswerReceipt> {
    const questions = this.questionService();
    const parsed = parseOrInvalid(parseAidenRemoteBotQuestionAnswerRequest, input, "The question answer is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      return await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/questions/{waitId}/answer", resourceId: `${bot.id}:${waitId}`, key },
        { waitId, ...parsed },
        async () => {
          const outcome = questions.answer(bot.id, waitId, {
            version: 1,
            promptId: waitId,
            cancelled: parsed.cancelled,
            answers: parsed.answers,
          });
          if (outcome === "invalid") {
            throw new AidenRemoteServiceError("invalid_request", "The answer does not match the question.", 400);
          }
          if (outcome === "not_waiting") {
            throw new AidenRemoteServiceError("question_expired", "This question prompt is no longer available.", 409);
          }
          return { waitId };
        },
      );
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      return mapSessionError(error);
    }
  }

  /** Pending connect cards show what is true now (connected, or Not now). */
  private async resolveCards(
    botId: string,
    entries: AidenRemoteBotSessionEntry[],
  ): Promise<AidenRemoteBotSessionEntry[]> {
    const resolve = this.options.connectCardStatus;
    if (!resolve) return entries;
    return Promise.all(entries.map(async (entry) => {
      if (entry.type !== "connect_card" || entry.status !== "pending") return entry;
      const status = await resolve(botId, { type: "connect_card", pluginId: entry.pluginId, reason: entry.reason, status: "pending" })
        .catch(() => entry.status);
      return status === entry.status ? entry : { ...entry, status };
    }));
  }

  private projector(botId: string): Promise<BotLiveProjector> {
    const existing = this.projectors.get(botId);
    if (existing) return existing;
    const created = (async () => {
      const runtime = await this.options.runtime();
      const conversation = await runtime.conversation(botId);
      const projector = new BotLiveProjector(
        botId,
        () => this.stateView(botId),
        (entries) => this.resolveCards(botId, entries),
        this.options.projectorIdleMs ?? PROJECTOR_IDLE_MS,
        () => {
          if (this.projectors.get(botId) === created) this.projectors.delete(botId);
        },
        () => this.questionOf(botId),
      );
      await projector.attach(conversation);
      return projector;
    })();
    this.projectors.set(botId, created);
    created.catch(() => {
      if (this.projectors.get(botId) === created) this.projectors.delete(botId);
    });
    return created;
  }

  /** A projector whose watch already ended is replaced by a fresh epoch. */
  private async liveProjector(botId: string): Promise<BotLiveProjector> {
    const projector = await this.projector(botId);
    return projector.closed ? this.projector(botId) : projector;
  }

  async session(botId: string): Promise<AidenRemoteBotSession> {
    const bot = await this.options.bots.bot(botId);
    try {
      const state = await this.stateView(bot.id);
      if (state.state === "unavailable") {
        // Bots are held by another Aiden process: nothing can be opened.
        return parseAidenRemoteBotSession({
          botId: bot.id, epoch: "epoch_unavailable", seq: 0, ...state, entries: [], hasOlder: false, question: null,
        });
      }
      const projector = await this.liveProjector(bot.id);
      // A state change without a commit (a desktop Stop, a lock change) is not
      // seen by the watch; a fetch always reports the current state.
      await projector.refresh();
      return projector.snapshot();
    } catch (error) {
      return mapSessionError(error);
    }
  }

  /** SSE: a `snapshot` first, then `partial` / `entry` / `state`, and `closed` when the session closes. */
  async openEvents(
    deviceId: string,
    botId: string,
    response: ServerResponse,
    admit: () => void = () => {},
  ): Promise<void> {
    const bot = await this.options.bots.bot(botId);
    let projector: BotLiveProjector;
    try {
      projector = await this.liveProjector(bot.id);
    } catch (error) {
      return mapSessionError(error);
    }
    // A new subscriber sees current card statuses and state, not the last commit's.
    await projector.refresh();
    if (projector.closed) {
      // Deleted while attaching: a 404 tells the client to leave the chat.
      await this.options.bots.bot(bot.id);
      throw new AidenRemoteServiceError("operation_stale", "This Bot's chat closed. Try again.", 409, true);
    }
    admit();
    const subscriber: Subscriber = { frames: [projector.snapshotFrame()], overflowed: false };
    const unsubscribe = projector.subscribe(subscriber);
    const handle = openCursorSse(response, {
      pull: () => {
        if (subscriber.overflowed) return { abort: true };
        const frames = subscriber.frames.splice(0, subscriber.frames.length);
        const ended = frames.some((frame) => frame.startsWith(`id: ${projector.epoch}:`) && frame.includes("\nevent: closed\n"));
        return ended ? { frames, end: true } : { frames };
      },
      onClose: () => {
        unsubscribe();
        const owned = this.subscriptions.get(deviceId);
        owned?.delete(handle);
        if (owned?.size === 0) this.subscriptions.delete(deviceId);
      },
    });
    subscriber.handle = handle;
    if (handle.closed) return;
    const owned = this.subscriptions.get(deviceId) ?? new Set<CursorSseHandle>();
    owned.add(handle);
    this.subscriptions.set(deviceId, owned);
    handle.wake();
  }

  revokeDevice(deviceId: string): void {
    const owned = this.subscriptions.get(deviceId);
    if (!owned) return;
    this.subscriptions.delete(deviceId);
    for (const handle of [...owned]) handle.close();
  }

  async close(): Promise<void> {
    for (const deviceId of [...this.subscriptions.keys()]) this.revokeDevice(deviceId);
    const projectors = await Promise.allSettled([...this.projectors.values()]);
    for (const result of projectors) if (result.status === "fulfilled") await result.value.close();
  }

  private async afterAction(botId: string): Promise<void> {
    const projector = await this.projectors.get(botId)?.catch(() => undefined);
    await projector?.refresh();
    this.options.notifyBotsChanged?.(botId);
  }

  async send(deviceId: string, botId: string, key: string, input: unknown): Promise<AidenRemoteBotMessageReceipt> {
    const parsed = parseOrInvalid(parseAidenRemoteBotMessageRequest, input, "The Bot message is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      const receipt = await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/messages", resourceId: bot.id, key },
        parsed,
        async () => {
          const runtime = await this.options.runtime();
          // The request UUID is the session request id: a resubmission dedupes.
          const sent = await runtime.send(bot.id, { text: parsed.text, requestId: `remote:${deviceId}:${key}` });
          return { ...sent, ...projectBotSessionState(await runtime.state(bot.id)) };
        },
      );
      await this.afterAction(bot.id);
      return receipt;
    } catch (error) {
      return mapSessionError(error);
    }
  }

  private async control(
    action: "resume" | "dismiss" | "stop",
    deviceId: string,
    botId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotSessionStateView> {
    parseOrInvalid((value) => parseAidenRemoteEmptyRequest(value, "Bot request"), input ?? {}, "The Bot request is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      const view = await this.options.bots.executeIdempotent(
        { deviceId, route: `POST /bots/{id}/${action}`, resourceId: bot.id, key },
        {},
        async () => {
          const runtime = await this.options.runtime();
          const requestId = `remote:${deviceId}:${key}`;
          if (action === "resume") return projectBotSessionState(await runtime.resume(bot.id, requestId));
          if (action === "dismiss") return projectBotSessionState(await runtime.dismiss(bot.id, requestId));
          // Stop ends a running turn; a paused one belongs to Dismiss.
          return projectBotSessionState(await runtime.stop(bot.id));
        },
      );
      await this.afterAction(bot.id);
      return view;
    } catch (error) {
      return mapSessionError(error);
    }
  }

  resume(deviceId: string, botId: string, key: string, input: unknown) {
    return this.control("resume", deviceId, botId, key, input);
  }

  dismiss(deviceId: string, botId: string, key: string, input: unknown) {
    return this.control("dismiss", deviceId, botId, key, input);
  }

  stop(deviceId: string, botId: string, key: string, input: unknown) {
    return this.control("stop", deviceId, botId, key, input);
  }

  // --- Routines -------------------------------------------------------------

  private routineService() {
    if (!this.options.routines) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return this.options.routines;
  }

  async listRoutines(botId: string): Promise<AidenRemoteBotRoutineList> {
    const routines = this.routineService();
    const bot = await this.options.bots.bot(botId);
    try {
      return parseAidenRemoteBotRoutineList({
        routines: (await routines.list(bot.id)).map(projectAidenRemoteBotRoutine),
      });
    } catch (error) {
      return routineError(error);
    }
  }

  async createRoutine(deviceId: string, botId: string, key: string, input: unknown): Promise<AidenRemoteBotRoutine> {
    const routines = this.routineService();
    const parsed = parseOrInvalid(parseAidenRemoteBotRoutineCreateRequest, input, "The routine is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      botRoutineCron(parsed.schedule);
      return await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/routines", resourceId: bot.id, key },
        parsed,
        async () => projectAidenRemoteBotRoutine(await routines.create({
          botId: bot.id,
          name: parsed.name.trim(),
          schedule: parsed.schedule,
          prompt: parsed.message.trim(),
          ...(parsed.timezone ? { timezone: parsed.timezone } : {}),
        })),
      );
    } catch (error) {
      return routineError(error);
    }
  }

  private async ownedRoutine(botId: string, routineId: string, expectedRevision: string): Promise<BotRoutine> {
    const routine = (await this.routineService().list(botId)).find((candidate) => candidate.id === routineId);
    if (!routine) throw new AidenRemoteServiceError("not_found", "This routine no longer exists.", 404);
    if (routineRevision(routine) !== expectedRevision) {
      throw new AidenRemoteServiceError(
        "revision_conflict",
        "This routine changed. Refresh it before trying again.",
        409,
        false,
        { currentRevision: routineRevision(routine) },
      );
    }
    return routine;
  }

  async updateRoutine(
    botId: string,
    routineId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<AidenRemoteBotRoutine> {
    const routines = this.routineService();
    const parsed = parseOrInvalid(parseAidenRemoteBotRoutineUpdateRequest, input, "The routine change is invalid.");
    const bot = await this.options.bots.bot(botId);
    const existing = await this.ownedRoutine(bot.id, routineId, expectedRevision);
    try {
      return projectAidenRemoteBotRoutine(await routines.update({
        botId: bot.id,
        id: existing.id,
        expectedUpdatedAt: existing.updatedAt,
        ...(parsed.name !== undefined ? { name: parsed.name.trim() } : {}),
        ...(parsed.schedule !== undefined ? { schedule: parsed.schedule } : {}),
        ...(parsed.message !== undefined ? { prompt: parsed.message.trim() } : {}),
        ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
        ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      }));
    } catch (error) {
      return routineError(error);
    }
  }

  async deleteRoutine(botId: string, routineId: string, expectedRevision: string): Promise<void> {
    const routines = this.routineService();
    const bot = await this.options.bots.bot(botId);
    const existing = await this.ownedRoutine(bot.id, routineId, expectedRevision);
    try {
      await routines.delete({ botId: bot.id, id: existing.id, expectedUpdatedAt: existing.updatedAt });
    } catch (error) {
      return routineError(error);
    }
  }

  // --- Connection requests ----------------------------------------------------

  async requestConnection(
    deviceId: string,
    botId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotConnectionRequestReceipt> {
    if (!this.options.connectionRequested) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    const parsed = parseOrInvalid(parseAidenRemoteBotConnectionRequest, input, "The connection request is invalid.");
    const suggestion = connectionSuggestionFor(parsed.pluginId);
    if (!suggestion) {
      throw new AidenRemoteServiceError("not_found", "Aiden can't connect that app.", 404);
    }
    const bot = await this.options.bots.bot(botId);
    return this.options.bots.executeIdempotent(
      { deviceId, route: "POST /bots/{id}/connection-requests", resourceId: bot.id, key },
      parsed,
      async () => {
        await this.options.connectionRequested!({ botId: bot.id, pluginId: suggestion.pluginId, name: suggestion.name });
        return { pluginId: suggestion.pluginId, name: suggestion.name, status: "sent" as const };
      },
    );
  }

  // --- Presets -------------------------------------------------------------------

  presets(): AidenRemoteBotPresetList {
    if (!this.options.presets) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    const currentYear = new Date(this.options.now?.() ?? Date.now()).getFullYear();
    return parseAidenRemoteBotPresetList({
      presets: this.options.presets.list().slice(0, AIDEN_REMOTE_BOT_PRESETS_MAX).map((preset) => {
        const chips = preset.suggestedConnections
          .map((pluginId) => connectionSuggestionFor(pluginId))
          .filter((chip) => chip !== null)
          .slice(0, 8)
          .map((chip) => ({ pluginId: chip.pluginId, name: chip.name, iconId: chip.iconId }));
        const routine = preset.suggestedRoutine;
        return {
          id: preset.id,
          name: preset.name,
          subtitle: preset.subtitle,
          avatar: { version: 1, shape: preset.avatar.shape, color: preset.avatar.color },
          suggestedConnections: chips,
          ...(routine
            ? {
                suggestedRoutine: {
                  name: routine.name,
                  label: formatBotRoutineLabel(presetRoutineSchedule(routine.schedule), { currentYear }),
                },
              }
            : {}),
        };
      }),
    });
  }

  async createFromPreset(deviceId: string, key: string, input: unknown): Promise<AidenRemoteBotPresetCreateResult> {
    if (!this.options.presets) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    const parsed = parseOrInvalid(parseAidenRemoteBotPresetCreateRequest, input, "The starter Bot request is invalid.");
    if (!this.options.presets.list().some((preset) => preset.id === parsed.presetId)) {
      throw new AidenRemoteServiceError("not_found", "That starter Bot isn't available.", 404);
    }
    const { botId, created } = await this.options.bots.executeIdempotent(
      { deviceId, route: "POST /bots/from-preset", resourceId: parsed.presetId, key },
      parsed,
      // Remote creations resolve access against the requesting device's audience,
      // like `POST /bots`.
      () => this.options.presets!.create(parsed.presetId, { audienceId: deviceId }),
    );
    if (created) this.options.notifyBotsChanged?.(botId);
    return { created, bot: await this.options.bots.summaryOf(botId) };
  }
}

/** The preset's friendly schedule in the routines backend's shape. */
function presetRoutineSchedule(
  schedule: NonNullable<BotPreset["suggestedRoutine"]>["schedule"],
): Parameters<typeof formatBotRoutineLabel>[0] {
  const [hour, minute] = schedule.time.split(":");
  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  return schedule.frequency === "weekly"
    ? { kind: "weekly", days: [...schedule.days], time }
    : { kind: schedule.frequency, time };
}

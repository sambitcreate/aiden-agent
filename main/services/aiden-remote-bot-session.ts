// Remote surface of the durable Bot runtime (contract revision 25).
//
// - `GET /bots/{id}/session` and its SSE stream project the Bot's one Pi Durable
//   conversation: displayable entries, the in-flight partial and the paused
//   (`interrupted`) state. Every frame carries `(epoch, seq)`; the epoch is
//   minted per attachment to the conversation, so a reopened harness (idle
//   close, restart, corrupt-file reset) always reaches clients as a new epoch.
// - Send, Resume, Dismiss and Stop are idempotent per request UUID through the
//   shared Bot idempotency ledger; the UUID is also the session `requestId`.
// - Routines, connection requests and starter presets call their main services.

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { connectionSuggestionFor, type ConnectCardEntry } from "../../renderer/shared/bot-connections.js";
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
  parseAidenRemoteBotSession,
  parseAidenRemoteEmptyRequest,
  type AidenRemoteBotConnectionRequestReceipt,
  type AidenRemoteBotMessageReceipt,
  type AidenRemoteBotPresetCreateResult,
  type AidenRemoteBotPresetList,
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
import {
  BOT_NOTICE_ENTRY_KIND,
  BotSessionError,
  type BotNotice,
  type BotSessionState,
} from "./bot-runtime/bot-session-service.js";
import {
  BOT_ROUTINE_SILENT_INSTRUCTION,
  BOT_ROUTINE_SILENT_TOKEN,
  type BotRoutine,
  type BotRoutineService,
} from "./scheduled-bot-routines.js";

/** Kind of the typed connect card entry `suggest_connection` appends. */
export const BOT_CONNECT_CARD_ENTRY_KIND = "aiden.connect-card";
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
  routines?: Pick<BotRoutineService, "list" | "create" | "update" | "delete">;
  presets?: {
    list(): readonly BotPreset[];
    create(presetId: string): Promise<{ botId: string; created: boolean }>;
  };
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

type TextPart = { type: "text"; text: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextPart => Boolean(part) && (part as TextPart).type === "text" &&
      typeof (part as TextPart).text === "string")
    .map((part) => part.text)
    .join("");
}

function bounded(text: string): string {
  return [...text].length > AIDEN_REMOTE_BOT_SESSION_MAX_TEXT_CHARS
    ? [...text].slice(0, AIDEN_REMOTE_BOT_SESSION_MAX_TEXT_CHARS).join("")
    : text;
}

function stripRoutineInstruction(text: string): string {
  const suffix = `\n\n${BOT_ROUTINE_SILENT_INSTRUCTION}`;
  if (text.endsWith(suffix)) return text.slice(0, -suffix.length);
  return text.endsWith(BOT_ROUTINE_SILENT_INSTRUCTION)
    ? text.slice(0, -BOT_ROUTINE_SILENT_INSTRUCTION.length).trimEnd()
    : text;
}

function timestampOf(message: unknown): string | undefined {
  const timestamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : undefined;
}

const wireEntryId = (entry: EntryRecord) => `entry_${String(entry.id)}`;

/**
 * Displayable wire entries of a conversation view, oldest first: user and
 * assistant text, one connect card per plugin (latest status at the first
 * card's place), and a reset notice. Tool traffic, prompts and `[SILENT]`
 * routine answers stay on the Mac.
 */
export function projectBotSessionEntries(entries: readonly EntryRecord[]): AidenRemoteBotSessionEntry[] {
  const output: AidenRemoteBotSessionEntry[] = [];
  const cards = new Map<string, number>();
  let pendingLabel: string | undefined;
  for (const entry of entries) {
    const message = entry.model?.[0] as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (entry.kind === "pi.user" && message) {
      const text = bounded(stripRoutineInstruction(textOf(message.content)));
      const createdAt = timestampOf(message);
      output.push({
        type: "message",
        id: wireEntryId(entry),
        role: "user",
        text,
        ...(createdAt ? { createdAt } : {}),
        ...(pendingLabel ? { label: pendingLabel } : {}),
      });
      pendingLabel = undefined;
    } else if (entry.kind === "pi.assistant" && message) {
      const text = textOf(message.content);
      if (!text.trim() || text.trim() === BOT_ROUTINE_SILENT_TOKEN) continue;
      const createdAt = timestampOf(message);
      output.push({
        type: "message",
        id: wireEntryId(entry),
        role: "assistant",
        text: bounded(text),
        ...(createdAt ? { createdAt } : {}),
        ...(message.stopReason === "aborted" ? { interrupted: true as const } : {}),
      });
    } else if (entry.kind === BOT_NOTICE_ENTRY_KIND) {
      const notice = entry.data as BotNotice | undefined;
      if (notice?.notice === "routine") pendingLabel = notice.label.slice(0, 120);
      else if (notice?.notice === "session_reset") {
        output.push({ type: "notice", id: wireEntryId(entry), notice: "session_reset" });
      } else if (notice?.notice === "interrupted") {
        const last = [...output].reverse().find((item) => item.type === "message");
        if (last?.type === "message" && last.role === "assistant") last.interrupted = true;
      }
    } else if (entry.kind === BOT_CONNECT_CARD_ENTRY_KIND) {
      const card = entry.data as Partial<ConnectCardEntry> | undefined;
      const suggestion = card?.pluginId ? connectionSuggestionFor(card.pluginId) : null;
      if (!card || !suggestion || !["pending", "connected", "dismissed"].includes(card.status ?? "")) continue;
      const projected: AidenRemoteBotSessionEntry = {
        type: "connect_card",
        id: wireEntryId(entry),
        pluginId: suggestion.pluginId,
        name: suggestion.name,
        iconId: suggestion.iconId,
        reason: (card.reason ?? "").trim().slice(0, 280) || `Connect ${suggestion.name}.`,
        status: card.status as ConnectCardEntry["status"],
      };
      const index = cards.get(suggestion.pluginId);
      if (index === undefined) {
        cards.set(suggestion.pluginId, output.length);
        output.push(projected);
      } else {
        output[index] = { ...projected, id: output[index]!.id };
      }
    }
  }
  return output;
}

/** Text of the in-flight (or paused) assistant partial, if any. */
export function projectBotSessionPartial(view: Pick<ConversationView, "docs">): string | undefined {
  const live = view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined;
  const text = textOf(live?.generation?.message?.content);
  return text ? bounded(text) : undefined;
}

export function projectBotSessionState(state: BotSessionState): AidenRemoteBotSessionStateView {
  if (state.kind === "interrupted") {
    return { state: "interrupted", interrupted: true, ...(state.blocked ? { blocked: state.blocked } : {}) };
  }
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
  readonly subscribers = new Set<Subscriber>();
  private stopWatch: (() => Promise<unknown>) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(
    readonly botId: string,
    private readonly readState: () => Promise<AidenRemoteBotSessionStateView>,
    private readonly idleMs: number,
    private readonly onClosed: () => void,
  ) {}

  async attach(conversation: Conversation): Promise<void> {
    const watch = await conversation.watch(ctx);
    this.stopWatch = () => watch.stop();
    this.entries = projectBotSessionEntries(watch.value.entries);
    this.partial = projectBotSessionPartial(watch.value);
    this.state = await this.readState();
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
    });
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
    const text = sseFrame(`${this.epoch}:${this.seq}`, event.type, data);
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

  async advance(view: ConversationView): Promise<void> {
    if (this.closed) return;
    const next = projectBotSessionEntries(view.entries);
    const previous = new Map(this.entries.map((entry) => [entry.id, JSON.stringify(entry)]));
    this.entries = next;
    let appended = false;
    for (const entry of next) {
      const before = previous.get(entry.id);
      if (before === JSON.stringify(entry)) continue;
      appended = true;
      this.frame({ type: "entry", payload: { entry } });
    }
    const partial = projectBotSessionPartial(view);
    if (partial !== this.partial) {
      this.partial = partial;
      // An appended answer replaces the partial; an empty partial clears it.
      if (!(appended && partial === undefined)) this.frame({ type: "partial", payload: { text: partial ?? "" } });
    }
    const state = await this.readState().catch(() => this.state);
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      this.state = state;
      this.frame({ type: "state", payload: state });
    }
  }

  /** Re-read the session state (Resume, Dismiss and Stop change it without a commit). */
  async refreshState(): Promise<void> {
    const state = await this.readState().catch(() => this.state);
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      this.state = state;
      this.frame({ type: "state", payload: state });
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
    ...(routine.lastError ? { lastError: routine.lastError.slice(0, 500) } : {}),
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

  constructor(private readonly options: AidenRemoteBotSessionServiceOptions) {}

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

  private projector(botId: string): Promise<BotLiveProjector> {
    const existing = this.projectors.get(botId);
    if (existing) return existing;
    const created = (async () => {
      const runtime = await this.options.runtime();
      const conversation = await runtime.conversation(botId);
      const projector = new BotLiveProjector(
        botId,
        () => this.stateView(botId),
        this.options.projectorIdleMs ?? PROJECTOR_IDLE_MS,
        () => {
          if (this.projectors.get(botId) === created) this.projectors.delete(botId);
        },
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
          botId: bot.id, epoch: "epoch_unavailable", seq: 0, ...state, entries: [], hasOlder: false,
        });
      }
      return (await this.liveProjector(bot.id)).snapshot();
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
    admit();
    const snapshot = projector.snapshot();
    const subscriber: Subscriber = {
      frames: [sseFrame(`${snapshot.epoch}:${snapshot.seq}`, "snapshot", {
        protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
        botId: snapshot.botId,
        epoch: snapshot.epoch,
        seq: snapshot.seq,
        type: "snapshot",
        payload: { session: snapshot },
      })],
      overflowed: false,
    };
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
    await projector?.refreshState();
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
          const state = await runtime.state(bot.id);
          // Stop ends a running turn; a paused one belongs to Dismiss.
          if (state.kind === "running") await (await runtime.conversation(bot.id)).abort(ctx);
          return projectBotSessionState(await runtime.state(bot.id));
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
      () => this.options.presets!.create(parsed.presetId),
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

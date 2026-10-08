// Live projection of each Bot's durable conversation to renderer windows
// (spec §6.5, plan Task 1.4).
//
// One feed per Bot runs `conversation.watch(ctx)` and turns each committed
// frame into `BotLiveEvent`s: new transcript entries, the in-flight partial
// reply (`pi.live`), and session state. Subscribers get a full snapshot first
// and then events numbered `(epoch, seq)`:
//
// - `epoch` is minted per feed. A feed ends when the Bot's harness closes
//   (idle close, delete, shutdown); the next one, on reopen, has a new epoch
//   and pushes a snapshot to every subscriber still listening.
// - Each subscriber's undelivered events are bounded. More than `maxPending`
//   collapses to one snapshot at the next flush.
// - A change that rewrites history (a `[SILENT]` routine answer hides its
//   turn, a connection status changed) is sent as a snapshot too.
//
// A feed also runs without subscribers while a reply is running, so the end
// of every run is observed and reported (`onRunSettled`) for list rows.

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { Conversation, ConversationWatch, EntryRecord } from "@earendil-works/pi-durable";
import type { ConnectCardEntry, ConnectCardStatus } from "../../../renderer/shared/bot-connections.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../../renderer/shared/ask-user-question.js";
import {
  BOT_SILENT_REPLY,
  botFailedTurnId,
  botQuestionAnswerText,
  botTranscriptPreview,
  type BotLiveEvent,
  type BotPendingQuestion,
  type BotLiveEventBody,
  type BotLiveSnapshot,
  type BotLiveSummary,
  type BotTranscriptEntry,
} from "../../../renderer/shared/bot-live.js";
import { parseProducedFile } from "../../../renderer/shared/produced-file.js";
import { BOT_SHARED_IMAGE_ENTRY_KIND } from "./bot-images.js";
import { BOT_NOTICE_ENTRY_KIND, type BotNotice, type BotSessionState } from "./bot-session-service.js";

export const BOT_CONNECT_CARD_ENTRY_KIND = "aiden.connect-card";
export const BOT_LIVE_MAX_PENDING_EVENTS = 100;

/* ------------------------------------------------------------------------- */
/* Transcript mapping                                                        */
/* ------------------------------------------------------------------------- */

function textOf(content: ReadonlyArray<TextContent | ImageContent | { type: string }> | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function imageCount(content: UserContent): number {
  return typeof content === "string" ? 0 : content.filter((part) => part.type === "image").length;
}

type UserContent = string | ReadonlyArray<TextContent | ImageContent>;

function firstMessage(entry: EntryRecord): Message | undefined {
  return entry.model?.[0];
}

function stopReasonOf(message: AssistantMessage): Extract<BotTranscriptEntry, { type: "assistant" }>["stopReason"] {
  switch (message.stopReason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return message.stopReason;
    default:
      return "other";
  }
}

/** File tools whose confirmed results become file chips. */
const BOT_FILE_CHIP_TOOLS = new Set(["write_file", "edit_file"]);

function sharedImageOf(data: unknown): Omit<Extract<BotTranscriptEntry, { type: "shared_image" }>, "id" | "type"> | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    !record.mimeType.startsWith("image/") ||
    typeof record.data !== "string" ||
    typeof record.size !== "number"
  ) {
    return null;
  }
  return { name: record.name, mimeType: record.mimeType, size: record.size, data: record.data };
}

function isNotice(entry: EntryRecord): entry is EntryRecord & { data: BotNotice } {
  return entry.kind === BOT_NOTICE_ENTRY_KIND && typeof entry.data === "object" && entry.data !== null;
}

function isSilentAnswer(entry: BotTranscriptEntry): boolean {
  return entry.type === "assistant" && entry.toolCalls.length === 0 && entry.text.trim() === BOT_SILENT_REPLY;
}

function connectCardOf(data: unknown): ConnectCardEntry | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.pluginId !== "string" || typeof record.reason !== "string") return null;
  const status = record.status === "connected" || record.status === "dismissed" ? record.status : "pending";
  return { type: "connect_card", pluginId: record.pluginId, reason: record.reason, status };
}

/**
 * Map raw Pi Durable entries to what a Bot chat shows. Pure: the same entries
 * always give the same view, so a full re-projection can be diffed safely.
 *
 * - `pi.user` → a user bubble; a routine's input → a `routine` label; a
 *   hidden (self-intro) prompt → nothing.
 * - `pi.assistant` / `pi.tool-result` → assistant text and tool activity. A
 *   reply that ended in an error becomes a `failed_turn` (after any text it
 *   wrote), carrying the turn's typed message for Retry.
 * - `aiden.connect-card` → a connect card; `aiden.bot-shared-image` → an image.
 * - A confirmed `write_file` / `edit_file` result in the Bot's folder → a file.
 * - `aiden.bot-notice` → `interrupted` and `session_reset` notices; routine,
 *   silent and hidden markers only shape the entries around them.
 * - A `[SILENT]` answer hides its whole turn (input label included).
 * - System, reset and compaction entries are not shown.
 */
export function projectBotTranscript(entries: readonly EntryRecord[]): BotTranscriptEntry[] {
  /** `retryText`: the typed message Retry resends if this turn fails. */
  type Turn = { start: number; silent: boolean; retryText: string | null };
  const mapped: Array<{ entry: BotTranscriptEntry; turn: Turn | null }> = [];
  let pendingRoutine: string | undefined;
  let pendingHidden = false;
  /** File tool calls aimed at the default location (the Bot's folder), by call id. */
  const homeFileCalls = new Set<string>();
  let turn: Turn | null = null;

  for (const record of entries) {
    const id = String(record.id);
    if (isNotice(record)) {
      const notice = record.data;
      if (notice.notice === "routine") pendingRoutine = notice.label;
      else if (notice.notice === "hidden_input") pendingHidden = true;
      else if (notice.notice === "interrupted" || notice.notice === "session_reset") {
        mapped.push({ entry: { id, type: "notice", notice: notice.notice }, turn });
      }
      continue;
    }
    if (record.kind === BOT_CONNECT_CARD_ENTRY_KIND) {
      const card = connectCardOf(record.data);
      if (card) mapped.push({ entry: { id, type: "connect_card", card }, turn });
      continue;
    }
    if (record.kind === BOT_SHARED_IMAGE_ENTRY_KIND) {
      const image = sharedImageOf(record.data);
      if (image) mapped.push({ entry: { id, type: "shared_image", ...image }, turn });
      continue;
    }
    const message = firstMessage(record);
    if (record.kind === "pi.user" && message?.role === "user") {
      const content = message.content as UserContent;
      const text = textOf(content);
      turn = {
        start: mapped.length,
        silent: false,
        retryText: pendingHidden || pendingRoutine !== undefined || !text.trim() ? null : text,
      };
      if (pendingHidden) {
        pendingHidden = false;
        pendingRoutine = undefined;
        continue;
      }
      if (pendingRoutine !== undefined) {
        mapped.push({ entry: { id, type: "routine", label: pendingRoutine, text, at: message.timestamp }, turn });
        pendingRoutine = undefined;
        continue;
      }
      mapped.push({ entry: { id, type: "user", text, imageCount: imageCount(content), at: message.timestamp }, turn });
      continue;
    }
    if (record.kind === "pi.assistant" && message?.role === "assistant") {
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      for (const call of calls) {
        if (BOT_FILE_CHIP_TOOLS.has(call.name) && (call.arguments as { location?: unknown } | undefined)?.location === undefined) {
          homeFileCalls.add(call.id);
        }
      }
      const toolCalls = calls.map((call) => ({ id: call.id, name: call.name }));
      const stopReason = stopReasonOf(message);
      const text = textOf(message.content);
      if (stopReason === "error") {
        // A failed reply is a typed entry; any text it wrote before failing stays above it.
        if (text.trim() || toolCalls.length > 0) {
          mapped.push({ entry: { id, type: "assistant", text, toolCalls, stopReason, at: message.timestamp }, turn });
        }
        mapped.push({
          entry: {
            id: botFailedTurnId(id),
            type: "failed_turn",
            retryText: turn?.retryText ?? null,
            ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
            at: message.timestamp,
          },
          turn,
        });
        continue;
      }
      const entry: BotTranscriptEntry = {
        id,
        type: "assistant",
        text,
        toolCalls,
        stopReason,
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        at: message.timestamp,
      };
      if (isSilentAnswer(entry) && turn) turn.silent = true;
      mapped.push({ entry, turn });
      continue;
    }
    if (record.kind === "pi.tool-result" && message?.role === "toolResult") {
      // The person's answer to a quick-reply card reads as their reply. A
      // stopped question (an error result) records no answer and stays hidden.
      const answerText =
        message.toolName === ASK_USER_QUESTION_TOOL_NAME && !message.isError
          ? botQuestionAnswerText(message.details)
          : undefined;
      if (answerText !== undefined) {
        mapped.push({ entry: { id, type: "question_answer", text: answerText, at: message.timestamp }, turn });
        continue;
      }
      mapped.push({
        entry: {
          id,
          type: "tool_result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
        },
        turn,
      });
      // A file the Bot wrote in its folder, as the tool result confirms it.
      const produced =
        !message.isError && homeFileCalls.has(message.toolCallId)
          ? parseProducedFile((message.details as { producedFile?: unknown } | undefined)?.producedFile, message.toolName)
          : undefined;
      if (produced) {
        mapped.push({
          entry: { id: `${id}:file`, type: "file", path: produced.relativePath, operation: produced.operation, at: message.timestamp },
          turn,
        });
      }
    }
  }
  return mapped
    .filter(({ entry, turn: owner }) => !(owner?.silent && entry.type !== "connect_card") && !isSilentAnswer(entry))
    .map(({ entry }) => entry);
}

/** The in-flight reply text from `pi.live`, or null. A reply heading for `[SILENT]` is never shown. */
export function livePartialText(docs: Readonly<Record<string, unknown>>): string | null {
  const live = docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined;
  const content = live?.generation?.message?.content;
  if (!Array.isArray(content)) return null;
  const text = textOf(content as TextContent[]);
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (BOT_SILENT_REPLY.startsWith(trimmed)) return null;
  return text;
}

function liveRunActive(docs: Readonly<Record<string, unknown>>): boolean {
  const live = docs["pi.live"] as { run?: unknown } | undefined;
  return live?.run !== undefined;
}

/* ------------------------------------------------------------------------- */
/* Feeds and subscribers                                                     */
/* ------------------------------------------------------------------------- */

export interface BotLiveSink {
  send(event: BotLiveEvent): void;
}

export interface BotLiveProjectionDeps {
  conversation(botId: string): Promise<Conversation>;
  state(botId: string): Promise<BotSessionState>;
  /** The question the Bot is waiting on right now, if any. */
  question?(botId: string): BotPendingQuestion | null;
  /** The current status of a connect card (connected or dismissed since it was offered). */
  connectCardStatus?(botId: string, card: ConnectCardEntry): Promise<ConnectCardStatus>;
  /** Schedules a subscriber flush. Defaults to the next macrotask. */
  schedule?(flush: () => void): void;
  maxPending?: number;
  newEpoch?(): string;
  /** A reply finished (or the Bot paused): list rows refresh from this. */
  onRunSettled?(botId: string, state: BotSessionState): void;
  onError?(botId: string, error: unknown): void;
}

export interface BotLiveSubscription {
  snapshot: BotLiveSnapshot;
  unsubscribe(): void;
}

export interface BotLiveProjection {
  subscribe(botId: string, sink: BotLiveSink): Promise<BotLiveSubscription>;
  /** The session state changed (send, resume, dismiss, stop). Starts a feed for a running reply. */
  notifyState(botId: string, state: BotSessionState): void;
  /** Re-read the transcript and push a snapshot, e.g. after a connection status changed. */
  refresh(botId: string): Promise<void>;
  /** The Bot's pending question changed (asked, answered, withdrawn): push a `question` event. */
  refreshQuestion(botId: string): Promise<void>;
  /** Preview, time and state for a list row. */
  summary(botId: string): Promise<BotLiveSummary>;
  /** Stop every feed (the Bot was deleted, or the app is quitting). */
  close(botId?: string): Promise<void>;
}

interface Subscriber {
  sink: BotLiveSink;
  pending: BotLiveEvent[];
  overflowed: boolean;
  scheduled: boolean;
  closed: boolean;
}

interface Feed {
  botId: string;
  epoch: string;
  seq: number;
  entries: BotTranscriptEntry[];
  partial: string | null;
  state: BotSessionState;
  question: BotPendingQuestion | null;
  runActive: boolean;
  watch: ConversationWatch;
  cancel: () => void;
  ended: boolean;
  /** Serializes frame handling with refreshes and state changes. */
  queue: Promise<void>;
}

function sameEntry(left: BotTranscriptEntry, right: BotTranscriptEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createBotLiveProjection(deps: BotLiveProjectionDeps): BotLiveProjection {
  const maxPending = deps.maxPending ?? BOT_LIVE_MAX_PENDING_EVENTS;
  const schedule = deps.schedule ?? ((flush: () => void) => void setTimeout(flush, 0));
  const newEpoch = deps.newEpoch ?? (() => randomUUID());
  const feeds = new Map<string, Feed>();
  const opening = new Map<string, Promise<Feed>>();
  const subscribers = new Map<string, Set<Subscriber>>();
  /** Where each Bot's last feed stopped, so `seq` keeps rising across epochs. */
  const lastSeq = new Map<string, number>();

  const report = (botId: string, error: unknown) => deps.onError?.(botId, error);

  function snapshotOf(feed: Feed): BotLiveSnapshot {
    return {
      botId: feed.botId,
      epoch: feed.epoch,
      seq: feed.seq,
      entries: feed.entries,
      partial: feed.partial,
      state: feed.state,
      question: feed.question,
    };
  }

  function flush(subscriber: Subscriber, botId: string): void {
    subscriber.scheduled = false;
    if (subscriber.closed) return;
    if (subscriber.overflowed) {
      subscriber.overflowed = false;
      subscriber.pending = [];
      const feed = feeds.get(botId);
      if (feed) {
        const snapshot = snapshotOf(feed);
        safeSend(subscriber, { botId, epoch: feed.epoch, seq: feed.seq, type: "snapshot", snapshot });
      }
      return;
    }
    const events = subscriber.pending;
    subscriber.pending = [];
    for (const event of events) safeSend(subscriber, event);
  }

  function safeSend(subscriber: Subscriber, event: BotLiveEvent): void {
    try {
      subscriber.sink.send(event);
    } catch (error) {
      subscriber.closed = true;
      report(event.botId, error);
    }
  }

  function enqueue(subscriber: Subscriber, botId: string, event: BotLiveEvent): void {
    if (subscriber.closed) return;
    if (subscriber.overflowed) return;
    subscriber.pending.push(event);
    if (subscriber.pending.length > maxPending) {
      subscriber.overflowed = true;
      subscriber.pending = [];
    }
    if (!subscriber.scheduled) {
      subscriber.scheduled = true;
      schedule(() => flush(subscriber, botId));
    }
  }

  function emit(feed: Feed, body: BotLiveEventBody): void {
    feed.seq += 1;
    lastSeq.set(feed.botId, feed.seq);
    const event = { botId: feed.botId, epoch: feed.epoch, seq: feed.seq, ...body } as BotLiveEvent;
    for (const subscriber of subscribers.get(feed.botId) ?? []) enqueue(subscriber, feed.botId, event);
  }

  function emitSnapshot(feed: Feed): void {
    feed.seq += 1;
    lastSeq.set(feed.botId, feed.seq);
    const snapshot = snapshotOf(feed);
    const event: BotLiveEvent = { botId: feed.botId, epoch: feed.epoch, seq: feed.seq, type: "snapshot", snapshot };
    for (const subscriber of subscribers.get(feed.botId) ?? []) enqueue(subscriber, feed.botId, event);
  }

  async function resolveCards(botId: string, entries: BotTranscriptEntry[]): Promise<BotTranscriptEntry[]> {
    if (!deps.connectCardStatus) return entries;
    const resolved: BotTranscriptEntry[] = [];
    // The newest card for a plugin carries its live status; older ones keep theirs.
    for (const entry of entries) {
      if (entry.type !== "connect_card" || entry.card.status !== "pending") {
        resolved.push(entry);
        continue;
      }
      const status = await deps.connectCardStatus(botId, entry.card).catch(() => entry.card.status);
      resolved.push(status === entry.card.status ? entry : { ...entry, card: { ...entry.card, status } });
    }
    return resolved;
  }

  /** Apply a re-projected transcript: append-only changes become entry events, anything else a snapshot. */
  function applyEntries(feed: Feed, next: BotTranscriptEntry[]): void {
    const previous = feed.entries;
    const prefixKept =
      next.length >= previous.length && previous.every((entry, index) => sameEntry(entry, next[index]!));
    feed.entries = next;
    if (!prefixKept) {
      emitSnapshot(feed);
      return;
    }
    for (const entry of next.slice(previous.length)) emit(feed, { type: "entry", entry });
  }

  async function onFrame(feed: Feed, entries: readonly EntryRecord[], docs: Readonly<Record<string, unknown>>) {
    if (feed.ended) return;
    applyEntries(feed, await resolveCards(feed.botId, projectBotTranscript(entries)));
    const partial = livePartialText(docs);
    if (partial !== feed.partial) {
      feed.partial = partial;
      emit(feed, { type: "partial", text: partial });
    }
    const runActive = liveRunActive(docs);
    if (runActive !== feed.runActive) {
      feed.runActive = runActive;
      const state = await deps.state(feed.botId).catch(() => feed.state);
      setState(feed, state);
      if (!runActive) {
        deps.onRunSettled?.(feed.botId, state);
        void closeIfUnwatched(feed);
      }
    }
  }

  function setState(feed: Feed, state: BotSessionState): void {
    if (JSON.stringify(state) === JSON.stringify(feed.state)) return;
    feed.state = state;
    emit(feed, { type: "state", state });
  }

  function enqueueWork(feed: Feed, work: () => Promise<void>): Promise<void> {
    const next = feed.queue.then(work).catch((error) => report(feed.botId, error));
    feed.queue = next;
    return next;
  }

  async function openFeed(botId: string): Promise<Feed> {
    const existing = feeds.get(botId);
    if (existing && !existing.ended) return existing;
    const pending = opening.get(botId);
    if (pending) return pending;
    const promise = (async () => {
      const conversation = await deps.conversation(botId);
      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
      const watch = await conversation.watch(context);
      const initial = watch.value;
      const feed: Feed = {
        botId,
        epoch: newEpoch(),
        seq: lastSeq.get(botId) ?? 0,
        entries: await resolveCards(botId, projectBotTranscript(initial.entries)),
        partial: livePartialText(initial.docs),
        state: await deps.state(botId),
        question: deps.question?.(botId) ?? null,
        runActive: liveRunActive(initial.docs),
        watch,
        cancel: () => cancel(new Error("Bot live feed closed.")),
        ended: false,
        queue: Promise.resolve(),
      };
      feeds.set(botId, feed);
      watch.start((value) => enqueueWork(feed, () => onFrame(feed, value.entries, value.docs)));
      void watch.closed.then(() => {
        feed.ended = true;
        if (feeds.get(botId) === feed) feeds.delete(botId);
      });
      return feed;
    })();
    opening.set(botId, promise);
    try {
      const feed = await promise;
      // Subscribers that outlived the previous feed move to this epoch.
      for (const subscriber of subscribers.get(botId) ?? []) {
        enqueue(subscriber, botId, {
          botId,
          epoch: feed.epoch,
          seq: feed.seq,
          type: "snapshot",
          snapshot: snapshotOf(feed),
        });
      }
      return feed;
    } finally {
      if (opening.get(botId) === promise) opening.delete(botId);
    }
  }

  /** Re-read the transcript and resolve connect cards against their current status. */
  function reproject(feed: Feed): Promise<void> {
    return enqueueWork(feed, async () => {
      const conversation = await deps.conversation(feed.botId);
      const view = await conversation.context(BACKGROUND_CONTEXT);
      applyEntries(feed, await resolveCards(feed.botId, projectBotTranscript(view.entries)));
    });
  }

  async function stopFeed(feed: Feed): Promise<void> {
    feed.ended = true;
    if (feeds.get(feed.botId) === feed) feeds.delete(feed.botId);
    await feed.watch.stop().catch(() => undefined);
    feed.cancel();
  }

  async function closeIfUnwatched(feed: Feed): Promise<void> {
    if (feed.runActive) return;
    if ((subscribers.get(feed.botId)?.size ?? 0) > 0) return;
    await stopFeed(feed);
  }

  /** Push a `question` event when the Bot's waiting question differs from the feed's. */
  function syncQuestion(feed: Feed): Promise<void> {
    return enqueueWork(feed, async () => {
      const question = deps.question?.(feed.botId) ?? null;
      if (question?.waitId === feed.question?.waitId) return;
      feed.question = question;
      emit(feed, { type: "question", question });
    });
  }

  return {
    async subscribe(botId, sink) {
      const subscriber: Subscriber = { sink, pending: [], overflowed: false, scheduled: false, closed: false };
      const feed = await openFeed(botId);
      // A new subscriber gets current connect-card statuses, not the feed's last view.
      await reproject(feed).catch((error) => report(botId, error));
      // A question asked or settled while no feed was open is caught up here.
      await syncQuestion(feed).catch((error) => report(botId, error));
      let set = subscribers.get(botId);
      if (!set) subscribers.set(botId, (set = new Set()));
      set.add(subscriber);
      return {
        snapshot: snapshotOf(feed),
        unsubscribe() {
          subscriber.closed = true;
          const current = subscribers.get(botId);
          current?.delete(subscriber);
          if (current && current.size === 0) subscribers.delete(botId);
          const live = feeds.get(botId);
          if (live) void closeIfUnwatched(live);
        },
      };
    },

    notifyState(botId, state) {
      const feed = feeds.get(botId);
      if (feed && !feed.ended) {
        void enqueueWork(feed, async () => setState(feed, state));
        return;
      }
      const wanted = state.kind === "running" || (subscribers.get(botId)?.size ?? 0) > 0;
      if (!wanted || state.kind === "unavailable") return;
      void openFeed(botId).then(
        (opened) => enqueueWork(opened, async () => setState(opened, state)),
        (error) => report(botId, error),
      );
    },

    async refresh(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await reproject(feed);
    },

    async refreshQuestion(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await syncQuestion(feed);
    },

    async summary(botId) {
      const feed = feeds.get(botId);
      if (feed && !feed.ended) {
        await feed.queue;
        const preview = botTranscriptPreview(feed.entries);
        return { botId, preview: preview?.text ?? null, updatedAt: preview?.at ?? null, state: feed.state };
      }
      const state = await deps.state(botId);
      if (state.kind === "unavailable") return { botId, preview: null, updatedAt: null, state };
      const view = await (await deps.conversation(botId)).context(BACKGROUND_CONTEXT);
      const preview = botTranscriptPreview(projectBotTranscript(view.entries));
      return { botId, preview: preview?.text ?? null, updatedAt: preview?.at ?? null, state };
    },

    async close(botId) {
      const targets = botId === undefined ? [...feeds.values()] : [feeds.get(botId)].filter((feed): feed is Feed => !!feed);
      // Closed subscribers get nothing more, not even a flush already scheduled.
      for (const [id, set] of subscribers) {
        if (botId !== undefined && id !== botId) continue;
        for (const subscriber of set) subscriber.closed = true;
        subscribers.delete(id);
        lastSeq.delete(id);
      }
      await Promise.all(targets.map(stopFeed));
    },
  };
}

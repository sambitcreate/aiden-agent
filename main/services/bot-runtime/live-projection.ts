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
  BOT_HANDOFF_RESULT_ENTRY_KIND,
  BOT_HANDOFF_TOOL_NAME,
  BOT_SIGN_IN_TOOL_NAME,
  botHandoffResultOf,
  type BotHandoffResultDetails,
  type BotPendingHandoff,
} from "../../../renderer/shared/bot-handoffs.js";
import {
  BOT_SILENT_REPLY,
  botFailedTurnId,
  botQuestionAnswerText,
  botLastReplyAt,
  botTranscriptPreview,
  type BotLiveActivity,
  type BotLiveEvent,
  type BotPendingQuestion,
  type BotQueuedMessage,
  type BotLiveEventBody,
  type BotLiveSnapshot,
  type BotLiveSummary,
  type BotToolResultStatus,
  type BotTranscriptEntry,
} from "../../../renderer/shared/bot-live.js";
import { botPhaseWord, pickActiveToolSlot, type BotActivityPhase } from "../../../renderer/shared/bot-activity.js";
import { parseProducedFile } from "../../../renderer/shared/produced-file.js";
import {
  BOT_MEMORY_REVIEW_ENTRY_KIND,
  type BotMemorySource,
  type BotMemoryTarget,
} from "../../../renderer/shared/bot-memory.js";
import {
  BOT_ROUTINE_PROPOSAL_ENTRY_KIND,
  BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND,
  type BotRoutineProposalEntryData,
  type BotRoutineProposalStatusEntryData,
} from "../../../renderer/shared/bot-routine-proposals.js";
import { botStepDescriptor } from "./bot-activity-detail.js";
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

/** Entries that stay visible when the turn they follow is hidden as `[SILENT]`. */
const OUTLIVES_SILENT_TURN = new Set<BotTranscriptEntry["type"]>(["connect_card", "memory_update", "routine_proposal"]);

function isSilentAnswer(entry: BotTranscriptEntry): boolean {
  return entry.type === "assistant" && entry.toolCalls.length === 0 && entry.text.trim() === BOT_SILENT_REPLY;
}

/** The tool whose successful saves show "Memory updated". */
const MEMORY_TOOL_NAME = "bot_memory";

function memoryTargetsOf(value: unknown): BotMemoryTarget[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((target): target is BotMemoryTarget => target === "memory" || target === "user"))];
}

/** A review or compaction flush that added something; null otherwise. */
function memoryReviewOf(data: unknown): { source: BotMemorySource; targets: BotMemoryTarget[] } | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.source !== "review" && record.source !== "compaction") return null;
  if (typeof record.added !== "number" || record.added <= 0) return null;
  return { source: record.source, targets: memoryTargetsOf(record.targets) };
}

/** Targets an in-turn `bot_memory` result changed; null when it changed nothing. */
function memorySaveOf(details: unknown): BotMemoryTarget[] | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as { changed?: unknown; targets?: unknown };
  if (typeof record.changed !== "number" || record.changed <= 0) return null;
  return memoryTargetsOf(record.targets);
}

function proposalOf(data: unknown): BotRoutineProposalEntryData | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ["proposalId", "name", "prompt", "timezone", "label"] as const) {
    if (typeof record[key] !== "string") return null;
  }
  if (typeof record.schedule !== "object" || record.schedule === null) return null;
  if (record.reason !== undefined && typeof record.reason !== "string") return null;
  return data as BotRoutineProposalEntryData;
}

function proposalStatusOf(data: unknown): BotRoutineProposalStatusEntryData | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.proposalId !== "string") return null;
  if (record.status !== "accepted" && record.status !== "dismissed") return null;
  if (record.routineId !== undefined && typeof record.routineId !== "string") return null;
  return {
    proposalId: record.proposalId,
    status: record.status,
    ...(record.routineId === undefined ? {} : { routineId: record.routineId }),
  };
}

function connectCardOf(data: unknown): ConnectCardEntry | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.pluginId !== "string" || typeof record.reason !== "string") return null;
  const status = record.status === "connected" || record.status === "dismissed" ? record.status : "pending";
  return { type: "connect_card", pluginId: record.pluginId, reason: record.reason, status };
}

/**
 * `blocked` when Pi's `beforeTool` refused the call (policy, a denied approval,
 * ingress); `stopped` when the run was stopped or interrupted mid-call; any
 * other error failed.
 */
function toolResultStatus(record: EntryRecord, isError: boolean): BotToolResultStatus {
  if (!isError) return "ok";
  const diagnostics = (record.data as { diagnostics?: unknown } | undefined)?.diagnostics;
  const codes = new Set(
    Array.isArray(diagnostics) ? diagnostics.map((item) => (item as { code?: unknown } | null)?.code) : [],
  );
  if (codes.has("blocked")) return "blocked";
  if (codes.has("aborted") || codes.has("interrupted")) return "stopped";
  return "failed";
}

/** Counts each tool call id an assistant message issues; a provider may reuse one in every turn. */
function countIssuedCalls(record: EntryRecord, issued: Map<string, number>): void {
  const message = firstMessage(record);
  if (record.kind !== "pi.assistant" || message?.role !== "assistant") return;
  for (const part of message.content) {
    if (part.type === "toolCall") issued.set(part.id, (issued.get(part.id) ?? 0) + 1);
  }
}

/** A call id as issued for the nth time so far: what an answer or a result pairs with. */
function callKey(issued: ReadonlyMap<string, number>, toolCallId: string): string {
  return `${issued.get(toolCallId) ?? 0}:${toolCallId}`;
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
 * - A settled `ask_user_question` → `question_answer`; a settled `hand_off` or
 *   `sign_in` → `handoff_result` (id `handoff:<toolCallId>`; a later answer
 *   for a call id a provider reused gets `handoff:<toolCallId>:<entry id>`).
 *   Their error results (stopped, refused) stay tool results.
 * - `aiden.connect-card` → a connect card; `aiden.bot-shared-image` → an image.
 * - A successful `bot_memory` result that changed something, or an
 *   `aiden.memory-review` entry that added something → `memory_update`.
 * - `aiden.routine-proposal` → a `routine_proposal` card whose status is the
 *   newest `aiden.routine-proposal-status` for its `proposalId` (pending
 *   without one); status entries themselves are not shown.
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
  /** When the answer that made each call was written, for its duration. */
  const callStartedAt = new Map<string, number>();
  let turn: Turn | null = null;
  /** The newest decision on each proposal: cards show what is true now. */
  const proposalStatus = new Map<string, BotRoutineProposalStatusEntryData>();
  /**
   * The person's answer to each rule hand-off, by the call the rule stopped
   * (the last entry for a call wins), and the calls whose blocked result is
   * in the transcript: the answer reads right after that result. Both are
   * keyed by `callKey`: a provider may reuse a call id in every turn.
   */
  const ruleHandoffs = new Map<string, { record: EntryRecord; result: BotHandoffResultDetails }>();
  const resultCallKeys = new Set<string>();
  const emittedRuleHandoffs = new Set<string>();
  const handoffRowIds = new Set<string>();
  /** The first answer for a call id keeps `handoff:<toolCallId>`; a reused id's later ones add their entry id. */
  const handoffRowId = (toolCallId: string, record: EntryRecord): string => {
    const base = `handoff:${toolCallId}`;
    const rowId = handoffRowIds.has(base) ? `${base}:${String(record.id)}` : base;
    handoffRowIds.add(rowId);
    return rowId;
  };
  const issued = new Map<string, number>();
  for (const record of entries) {
    if (record.kind === BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND) {
      const status = proposalStatusOf(record.data);
      if (status) proposalStatus.set(status.proposalId, status);
    } else if (record.kind === BOT_HANDOFF_RESULT_ENTRY_KIND) {
      const result = botHandoffResultOf(record.data);
      if (result?.toolCallId !== undefined && result.rule !== undefined) {
        ruleHandoffs.set(callKey(issued, result.toolCallId), { record, result });
      }
    } else if (record.kind === "pi.tool-result") {
      const message = firstMessage(record);
      if (message?.role === "toolResult") resultCallKeys.add(callKey(issued, message.toolCallId));
    } else {
      countIssuedCalls(record, issued);
    }
  }
  issued.clear();
  const ruleHandoffRow = (key: string, at: number | undefined): BotTranscriptEntry | undefined => {
    const found = ruleHandoffs.get(key);
    if (found === undefined || emittedRuleHandoffs.has(key)) return undefined;
    emittedRuleHandoffs.add(key);
    const { record, result } = found;
    return {
      id: handoffRowId(result.toolCallId!, record),
      type: "handoff_result",
      kind: result.kind,
      outcome: result.outcome,
      action: result.action,
      ...(result.note === undefined ? {} : { note: result.note }),
      ...(result.origin === undefined ? {} : { origin: result.origin }),
      ...(at === undefined ? {} : { at }),
    };
  };

  for (const record of entries) {
    const id = String(record.id);
    if (isNotice(record)) {
      const notice = record.data;
      if (notice.notice === "routine") pendingRoutine = notice.label;
      else if (notice.notice === "hidden_input") pendingHidden = true;
      else if (notice.notice === "interrupted" || notice.notice === "session_reset") {
        mapped.push({ entry: { id, type: "notice", notice: notice.notice }, turn });
      } else if (notice.notice === "routines_skipped" && typeof notice.since === "number" && Array.isArray(notice.routines)) {
        // Written on unpause, between turns: no turn owns it, so a [SILENT] turn never hides it.
        const routines = notice.routines.flatMap((routine) =>
          typeof routine?.routineId === "string" &&
          typeof routine.name === "string" &&
          Number.isSafeInteger(routine.count) &&
          routine.count > 0
            ? [{ routineId: routine.routineId, name: routine.name, count: routine.count }]
            : [],
        );
        if (routines.length > 0) {
          mapped.push({ entry: { id, type: "routines_skipped", since: notice.since, routines }, turn: null });
        }
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
    if (record.kind === BOT_MEMORY_REVIEW_ENTRY_KIND) {
      const review = memoryReviewOf(record.data);
      if (review) mapped.push({ entry: { id, type: "memory_update", targets: review.targets, source: review.source }, turn });
      continue;
    }
    if (record.kind === BOT_ROUTINE_PROPOSAL_ENTRY_KIND) {
      const proposal = proposalOf(record.data);
      if (proposal) {
        const decided = proposalStatus.get(proposal.proposalId);
        mapped.push({
          entry: {
            id,
            type: "routine_proposal",
            proposal,
            status: decided?.status ?? "pending",
            ...(decided?.routineId === undefined ? {} : { routineId: decided.routineId }),
          },
          turn,
        });
      }
      continue;
    }
    if (record.kind === BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_HANDOFF_RESULT_ENTRY_KIND) {
      // Read after the blocked call's result; here only when that result never landed.
      const result = botHandoffResultOf(record.data);
      const toolCallId = result?.toolCallId;
      const key = toolCallId === undefined ? undefined : callKey(issued, toolCallId);
      if (key !== undefined && !resultCallKeys.has(key) && ruleHandoffs.get(key)?.record === record) {
        const row = ruleHandoffRow(key, undefined);
        if (row) mapped.push({ entry: row, turn });
      }
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
      countIssuedCalls(record, issued);
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      for (const call of calls) {
        if (BOT_FILE_CHIP_TOOLS.has(call.name) && (call.arguments as { location?: unknown } | undefined)?.location === undefined) {
          homeFileCalls.add(call.id);
        }
      }
      for (const call of calls) {
        if (typeof message.timestamp === "number") callStartedAt.set(call.id, message.timestamp);
      }
      const toolCalls = calls.map((call) => ({ id: call.id, name: call.name, ...botStepDescriptor(call.name, call.arguments) }));
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
      // The person's Done or Skip on a hand-off card reads as their side of the chat.
      const handoff =
        (message.toolName === BOT_HANDOFF_TOOL_NAME || message.toolName === BOT_SIGN_IN_TOOL_NAME) && !message.isError
          ? botHandoffResultOf(message.details)
          : undefined;
      if (handoff !== undefined) {
        mapped.push({
          entry: {
            id: handoffRowId(message.toolCallId, record),
            type: "handoff_result",
            kind: handoff.kind,
            outcome: handoff.outcome,
            action: handoff.action,
            ...(handoff.note === undefined ? {} : { note: handoff.note }),
            ...(handoff.origin === undefined ? {} : { origin: handoff.origin }),
            at: message.timestamp,
          },
          turn,
        });
        continue;
      }
      const startedAt = callStartedAt.get(message.toolCallId);
      const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
      mapped.push({
        entry: {
          id,
          type: "tool_result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          status: toolResultStatus(record, message.isError),
          ...(startedAt !== undefined && at !== undefined ? { durationMs: Math.max(0, at - startedAt) } : {}),
          ...(at === undefined ? {} : { at }),
        },
        turn,
      });
      // A rule handed this call to the person: their Done or Skip reads next.
      const ruleRow = ruleHandoffRow(callKey(issued, message.toolCallId), at);
      if (ruleRow) mapped.push({ entry: ruleRow, turn });
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
      // The Bot saved something itself: a quiet "Memory updated" line.
      const saved = message.toolName === MEMORY_TOOL_NAME && !message.isError ? memorySaveOf(message.details) : null;
      if (saved) {
        mapped.push({
          entry: { id: `${id}:memory`, type: "memory_update", targets: saved, source: "turn", at: message.timestamp },
          turn,
        });
      }
    }
  }
  return mapped
    .filter(({ entry, turn: owner }) => !(owner?.silent && !OUTLIVES_SILENT_TURN.has(entry.type)) && !isSilentAnswer(entry))
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

/**
 * The turn's identity, or null when no run: its first input. A queued follow-up
 * starts a new run (fresh inputs) while `pi.live.run` stays present; steering
 * appends to the inputs and a tool round hands the run to a new generation
 * task, so neither changes the key (and neither is a new turn). Remote
 * projectors scope a run's start time and Stop by the same key.
 */
export function liveRunKey(docs: Readonly<Record<string, unknown>>): string | null {
  const live = docs["pi.live"] as { run?: { inputs?: unknown } } | undefined;
  const run = live?.run;
  if (run === undefined) return null;
  const first = Array.isArray(run.inputs) ? run.inputs[0] : undefined;
  return String(first);
}

/**
 * When each Bot's current run started, as first seen by any live surface in
 * this process. The desktop feed and every Remote projector share one, so a
 * surface that opens mid-run, or reopens after an idle close, shows the run's
 * real elapsed time instead of restarting the clock. Nothing durable records
 * a run's start, so a run already going when Aiden started is timed from when
 * a surface first saw it.
 */
export interface BotRunStarts {
  /**
   * The start of `botId`'s run `runKey` (`liveRunKey`), recorded from `now`
   * the first time it is asked for. A null key (the run is not in `pi.live`
   * yet, or is just leaving) belongs to the run already recorded.
   */
  startedAt(botId: string, runKey: string | null, now: () => number): number;
  /** A surface saw `botId` not running: its next run, even a Resume of the same one, starts afresh. */
  ended(botId: string): void;
}

export function createBotRunStarts(): BotRunStarts {
  // One run per Bot: a new run replaces the last, so this stays bounded by the Bots.
  const runs = new Map<string, { runKey: string | null; at: number }>();
  return {
    startedAt(botId, runKey, now) {
      const known = runs.get(botId);
      if (known && (known.runKey === runKey || known.runKey === null || runKey === null)) {
        if (known.runKey === null) known.runKey = runKey;
        return known.at;
      }
      const at = now();
      runs.set(botId, { runKey, at });
      return at;
    },
    ended(botId) {
      runs.delete(botId);
    },
  };
}

function liveRunActive(docs: Readonly<Record<string, unknown>>): boolean {
  const live = docs["pi.live"] as { run?: unknown } | undefined;
  return live?.run !== undefined;
}

interface LiveDocView {
  run?: unknown;
  generation?: { message?: { content?: unknown } };
  tools?: Array<{ callId: string; name: string; status: string }>;
  compactions?: Array<{ blocking?: boolean }>;
}

export interface BotLiveActivityInput {
  entries: readonly EntryRecord[];
  docs: Readonly<Record<string, unknown>>;
  /** An approval or A–E question is open. */
  waiting: boolean;
  /** The person pressed Stop and the run has not ended. */
  stopping: boolean;
  /** This run is a Resume and has not moved on yet. */
  resuming: boolean;
  /**
   * `pi.live` as it was when the Resume began, serialized once then
   * (`JSON.stringify`). While it is unchanged nothing live has happened since,
   * so a killed run's partial text or tool still in it predates the Resume and
   * is not the resumed run's work.
   */
  resumedFrom?: string;
  startedAt: number;
}

/** Whether the newest input already has an assistant entry after it. */
function inputAnswered(entries: readonly EntryRecord[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const kind = entries[index]!.kind;
    if (kind === "pi.assistant") return true;
    if (kind === "pi.user") return false;
  }
  return false;
}

/** The arguments of tool call `callId`, from the answer that made it. */
function callArguments(entries: readonly EntryRecord[], callId: string): unknown {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = firstMessage(entries[index]!);
    if (message?.role !== "assistant") continue;
    const call = message.content.find((part): part is ToolCall => part.type === "toolCall" && part.id === callId);
    if (call) return call.arguments;
  }
  return undefined;
}

/**
 * The phase of a run from `pi.live` (spec §5): Stop, then an open card,
 * then a Resume nothing live has happened since, then compaction inside the
 * turn, then the newest running tool (§5.2), then the reply's text, then
 * Resume, then thinking (or "getting ready" before the model produced
 * anything). Thinking content is read only to know the model is generating;
 * its text is never copied.
 */
export function liveBotActivity(input: BotLiveActivityInput): BotLiveActivity | null {
  const live = input.docs["pi.live"] as LiveDocView | undefined;
  if (live?.run === undefined) return null;
  const at = (phase: BotActivityPhase): BotLiveActivity => ({ phase, startedAt: input.startedAt });
  if (input.stopping) return at("stopping");
  if (input.waiting) return at("waiting");
  // After a crash the paused run's text stays in `pi.live` until the resumed run's first event.
  if (input.resuming && input.resumedFrom !== undefined && input.resumedFrom === JSON.stringify(live)) {
    return at("resuming");
  }
  if (live.compactions?.some((compaction) => compaction.blocking === true)) return at("tidying");
  const slot = pickActiveToolSlot(live.tools);
  if (slot) {
    const step = botStepDescriptor(slot.name, callArguments(input.entries, slot.callId));
    return {
      phase: step.kind,
      startedAt: input.startedAt,
      ...(step.app ? { app: step.app } : {}),
      step: { kind: step.kind, label: botPhaseWord(step.kind, step.app), ...(step.detail ? { detail: step.detail } : {}) },
    };
  }
  const content = live.generation?.message?.content;
  if (Array.isArray(content) && textOf(content as TextContent[]).trim()) return at("writing");
  if (input.resuming) return at("resuming");
  if (Array.isArray(content) && content.length > 0) return at("thinking");
  return at(inputAnswered(input.entries) ? "thinking" : "preparing");
}

/** The submission ids of inputs (not passive writes) waiting in `pi.inbox`. */
export function liveQueuedInputIds(docs: Readonly<Record<string, unknown>>): string[] {
  const items = (docs["pi.inbox"] as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  for (const value of items) {
    const item = value as { id?: unknown; mode?: unknown };
    if (item.mode !== "steer" && item.mode !== "followUp") continue;
    if (typeof item.id === "number" || typeof item.id === "string") ids.push(String(item.id));
  }
  return ids;
}

/**
 * Inputs waiting in `pi.inbox` that the person sent. Only ids in `personal`
 * (classified as the person's own, `createQueuedInputClassifier`) are listed,
 * so a routine's or the self-intro's input, or one not classified yet, never
 * shows: the list is private by construction.
 */
export function liveQueuedMessages(
  docs: Readonly<Record<string, unknown>>,
  personal: ReadonlySet<string>,
): BotQueuedMessage[] {
  const items = (docs["pi.inbox"] as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const queued: BotQueuedMessage[] = [];
  for (const value of items) {
    const item = value as { id?: unknown; mode?: unknown; content?: unknown };
    if (item.mode !== "steer" && item.mode !== "followUp") continue;
    if (typeof item.id !== "number" && typeof item.id !== "string") continue;
    const submissionId = String(item.id);
    const content = item.content as UserContent | undefined;
    if (content === undefined || !personal.has(submissionId)) continue;
    queued.push({ submissionId, mode: item.mode, text: textOf(content), imageCount: imageCount(content) });
  }
  return queued;
}

export interface QueuedInputClassifierDeps {
  /**
   * `quietInputs` for one Bot: `true` for a routine's input or the hidden
   * self-intro, `false` for the person's own. An id it cannot find is left out.
   */
  classify(submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  now(): number;
  /** Pause before a failed or incomplete classification is tried again. */
  retryMs: number;
  /** A classification failed: called once per failing streak. */
  report(error: unknown): void;
  /** The pause is over: project again (on the caller's own serial lane), even if no frame arrives. */
  retry(): void;
}

export interface QueuedInputClassifier {
  /**
   * The ids of the inputs waiting in `docs` that are known to be the person's
   * own. Each id is asked about once. One with no answer yet, or whose lookup
   * failed, is left out (fail closed) and asked again after the pause, never
   * on every frame.
   */
  personal(docs: Readonly<Record<string, unknown>>): Promise<ReadonlySet<string>>;
  /** Cancel a pending retry. */
  close(): void;
}

/** The queued-input classification the desktop feed and every Remote projector share. */
export function createQueuedInputClassifier(deps: QueuedInputClassifierDeps): QueuedInputClassifier {
  /** Queued submission ids already classified as quiet (true) or the person's (false). */
  const kinds = new Map<string, boolean>();
  let failing = false;
  /** No classification before this time: a persistent failure is not retried on every frame. */
  let notBefore = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function scheduleRetry(): void {
    notBefore = Math.max(notBefore, deps.now() + deps.retryMs);
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      notBefore = 0;
      deps.retry();
    }, deps.retryMs);
    timer.unref?.();
  }

  return {
    async personal(docs) {
      const ids = liveQueuedInputIds(docs);
      for (const id of [...kinds.keys()]) if (!ids.includes(id)) kinds.delete(id);
      const unknown = ids.filter((id) => !kinds.has(id));
      if (unknown.length > 0 && deps.now() >= notBefore) {
        try {
          const answers = await deps.classify(unknown);
          for (const id of unknown) {
            const quiet = answers.get(id);
            if (quiet !== undefined) kinds.set(id, quiet);
          }
          failing = false;
        } catch (error) {
          if (!failing) deps.report(error);
          failing = true;
        }
        if (unknown.some((id) => !kinds.has(id))) scheduleRetry();
      } else if (unknown.length > 0) {
        scheduleRetry();
      }
      return new Set(ids.filter((id) => kinds.get(id) === false));
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
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
  /** The hand-off card the Bot is waiting on right now, if any. */
  handoff?(botId: string): BotPendingHandoff | null;
  /**
   * Classify queued submission ids: `true` for a routine's input or the hidden
   * self-intro, `false` for the person's own message. Decided from durable
   * request ids. An id the session cannot find is left out of the answer; an
   * id with no answer, or a failure, stays hidden and is retried.
   */
  quietInputs(botId: string, submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** Whether a tool approval is waiting on the person. */
  approvalPending?(botId: string): boolean;
  /** Clock for `startedAt`; defaults to `Date.now`. */
  now?(): number;
  /**
   * Run start times shared with the Remote projectors (`botRunStarts`), so
   * every surface times a run from the same moment. Defaults to this
   * projection's own.
   */
  runStarts?: BotRunStarts;
  /** The current status of a connect card (connected or dismissed since it was offered). */
  connectCardStatus?(botId: string, card: ConnectCardEntry): Promise<ConnectCardStatus>;
  /** Schedules a subscriber flush. Defaults to the next macrotask. */
  schedule?(flush: () => void): void;
  maxPending?: number;
  /** Pause before a failed queued-message classification is tried again. Defaults to one second. */
  classifyRetryMs?: number;
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
  /** The Bot's pending hand-off changed (opened, answered, withdrawn): push a `handoff` event. */
  refreshHandoff(botId: string): Promise<void>;
  /** The person pressed Stop: the running turn reads "Stopping" until it ends. Ignored when nothing runs. */
  notifyStopping(botId: string): void;
  /**
   * The session resumed an interrupted turn (called by the service, inside its per-Bot
   * serialization, only when this call resumed it): the run reads "Picking up where it left off"
   * until it moves on.
   */
  notifyResuming(botId: string): void;
  /** The Stop did not take (it failed): the run goes on and no longer reads "Stopping". */
  cancelStopping(botId: string): void;
  /** An approval appeared or settled: re-derive the activity. */
  refreshActivity(botId: string): Promise<void>;
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
  handoff: BotPendingHandoff | null;
  activity: BotLiveActivity | null;
  queued: BotQueuedMessage[];
  /** Which queued inputs are the person's own (fail closed, throttled retries). */
  classifier: QueuedInputClassifier;
  /** When the current running turn started. */
  startedAt: number;
  stopping: boolean;
  resuming: boolean;
  /** `pi.live` when this run's Resume began, serialized (`BotLiveActivityInput.resumedFrom`). */
  resumedFrom: string | undefined;
  /** The newest frame, so approvals, questions and Stop can re-derive the activity. */
  frame: { entries: readonly EntryRecord[]; docs: Readonly<Record<string, unknown>> };
  runActive: boolean;
  /** Identity of the current run; a follow-up turn replaces the run without a gap. */
  runKey: string | null;
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
  const now = deps.now ?? Date.now;
  const runStarts = deps.runStarts ?? createBotRunStarts();
  /** Bots whose next run is a Resume. */
  const resumingBots = new Set<string>();
  const feeds = new Map<string, Feed>();
  const opening = new Map<string, Promise<Feed>>();
  const subscribers = new Map<string, Set<Subscriber>>();
  /** Where each Bot's last feed stopped, so `seq` keeps rising across epochs. */
  const lastSeq = new Map<string, number>();

  const report = (botId: string, error: unknown) => deps.onError?.(botId, error);
  const classifyRetryMs = deps.classifyRetryMs ?? 1_000;

  function snapshotOf(feed: Feed): BotLiveSnapshot {
    return {
      botId: feed.botId,
      epoch: feed.epoch,
      seq: feed.seq,
      entries: feed.entries,
      partial: feed.partial,
      state: feed.state,
      question: feed.question,
      handoff: feed.handoff,
      activity: feed.activity,
      queued: feed.queued,
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

  function waitingOn(feed: Feed): boolean {
    return feed.question !== null || feed.handoff !== null || deps.approvalPending?.(feed.botId) === true;
  }

  /** Null unless the session is running: a paused Bot keeps `pi.live.run` but is not working. */
  function computeActivity(feed: Feed): BotLiveActivity | null {
    if (feed.state.kind !== "running") return null;
    return (
      liveBotActivity({
        ...feed.frame,
        waiting: waitingOn(feed),
        stopping: feed.stopping,
        resuming: feed.resuming,
        resumedFrom: feed.resumedFrom,
        startedAt: feed.startedAt,
      }) ?? { phase: "preparing", startedAt: feed.startedAt }
    );
  }

  function updateActivity(feed: Feed): void {
    const activity = computeActivity(feed);
    if (activity && activity.phase !== "resuming") feed.resuming = false;
    if (JSON.stringify(activity) === JSON.stringify(feed.activity)) return;
    feed.activity = activity;
    emit(feed, { type: "activity", activity });
  }

  /** A new run began: its start time, Stop and Resume marks belong to it alone. */
  function startRun(feed: Feed): void {
    // A run another surface already saw keeps the time it started.
    feed.startedAt = runStarts.startedAt(feed.botId, liveRunKey(feed.frame.docs), now);
    feed.stopping = false;
    feed.resuming = resumingBots.delete(feed.botId);
    feed.resumedFrom = feed.resuming ? JSON.stringify(feed.frame.docs["pi.live"]) : undefined;
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

  /** The person's queued messages: only inputs classified as theirs (`createQueuedInputClassifier`). */
  async function queuedFor(feed: Feed, docs: Readonly<Record<string, unknown>>): Promise<BotQueuedMessage[]> {
    return liveQueuedMessages(docs, await feed.classifier.personal(docs));
  }

  /** The classification pause is over: list the queued messages again, through the feed queue. */
  function requeue(feed: Feed): void {
    void enqueueWork(feed, async () => {
      if (feed.ended) return;
      const queued = await queuedFor(feed, feed.frame.docs);
      if (JSON.stringify(queued) !== JSON.stringify(feed.queued)) {
        feed.queued = queued;
        emit(feed, { type: "queued", queued });
      }
    });
  }

  async function onFrame(feed: Feed, entries: readonly EntryRecord[], docs: Readonly<Record<string, unknown>>) {
    if (feed.ended) return;
    feed.frame = { entries, docs };
    const runKey = liveRunKey(docs);
    // A queued follow-up replaces the run without the feed ever seeing it end.
    if (runKey !== null && feed.runKey !== null && runKey !== feed.runKey && feed.state.kind === "running") {
      startRun(feed);
    }
    feed.runKey = runKey;
    // Records the run's key as soon as it shows, so a replacing run is told apart from this one.
    if (feed.state.kind === "running") feed.startedAt = runStarts.startedAt(feed.botId, runKey, now);
    applyEntries(feed, await resolveCards(feed.botId, projectBotTranscript(entries)));
    const partial = livePartialText(docs);
    if (partial !== feed.partial) {
      feed.partial = partial;
      emit(feed, { type: "partial", text: partial });
    }
    const queued = await queuedFor(feed, docs);
    if (JSON.stringify(queued) !== JSON.stringify(feed.queued)) {
      feed.queued = queued;
      emit(feed, { type: "queued", queued });
    }
    const runActive = liveRunActive(docs);
    if (runActive === feed.runActive) {
      updateActivity(feed);
      return;
    }
    feed.runActive = runActive;
    // The run's end is reported with its new state, so the line never flashes a phase after the reply.
    const state = await deps.state(feed.botId).catch(() => feed.state);
    setState(feed, state);
    updateActivity(feed);
    if (!runActive) {
      feed.stopping = false;
      feed.resuming = false;
      resumingBots.delete(feed.botId);
      deps.onRunSettled?.(feed.botId, state);
      void closeIfUnwatched(feed);
    }
  }

  function setState(feed: Feed, state: BotSessionState): void {
    if (JSON.stringify(state) === JSON.stringify(feed.state)) return;
    const wasRunning = feed.state.kind === "running";
    feed.state = state;
    if (state.kind === "running" && !wasRunning) startRun(feed);
    if (state.kind !== "running") {
      feed.stopping = false;
      feed.resuming = false;
      runStarts.ended(feed.botId);
    }
    emit(feed, { type: "state", state });
    updateActivity(feed);
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
      let opened: Feed | undefined;
      const classifier = createQueuedInputClassifier({
        classify: (ids) => deps.quietInputs(botId, ids),
        now,
        retryMs: classifyRetryMs,
        report: (error) => report(botId, error),
        retry: () => {
          if (opened) requeue(opened);
        },
      });
      const feed: Feed = {
        botId,
        epoch: newEpoch(),
        seq: lastSeq.get(botId) ?? 0,
        entries: await resolveCards(botId, projectBotTranscript(initial.entries)),
        partial: livePartialText(initial.docs),
        state: await deps.state(botId),
        question: deps.question?.(botId) ?? null,
        handoff: deps.handoff?.(botId) ?? null,
        activity: null,
        queued: [],
        classifier,
        startedAt: now(),
        stopping: false,
        resuming: false,
        resumedFrom: undefined,
        frame: { entries: initial.entries, docs: initial.docs },
        runActive: liveRunActive(initial.docs),
        runKey: liveRunKey(initial.docs),
        watch,
        cancel: () => cancel(new Error("Bot live feed closed.")),
        ended: false,
        queue: Promise.resolve(),
      };
      opened = feed;
      if (feed.state.kind === "running") startRun(feed);
      else runStarts.ended(botId);
      feed.activity = computeActivity(feed);
      feed.queued = await queuedFor(feed, initial.docs);
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
    feed.classifier.close();
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
      updateActivity(feed);
    });
  }

  /** Push a `handoff` event when the Bot's waiting hand-off differs from the feed's. */
  function syncHandoff(feed: Feed): Promise<void> {
    return enqueueWork(feed, async () => {
      const handoff = deps.handoff?.(feed.botId) ?? null;
      if (handoff?.waitId === feed.handoff?.waitId) return;
      feed.handoff = handoff;
      emit(feed, { type: "handoff", handoff });
      updateActivity(feed);
    });
  }

  return {
    async subscribe(botId, sink) {
      const subscriber: Subscriber = { sink, pending: [], overflowed: false, scheduled: false, closed: false };
      const feed = await openFeed(botId);
      // A new subscriber gets current connect-card statuses, not the feed's last view.
      await reproject(feed).catch((error) => report(botId, error));
      // A question or hand-off asked or settled while no feed was open is caught up here.
      await syncQuestion(feed).catch((error) => report(botId, error));
      await syncHandoff(feed).catch((error) => report(botId, error));
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
      if (state.kind !== "running") resumingBots.delete(botId);
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

    notifyStopping(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      void enqueueWork(feed, async () => {
        if (feed.state.kind !== "running") return;
        feed.stopping = true;
        updateActivity(feed);
      });
    },

    notifyResuming(botId) {
      resumingBots.add(botId);
    },

    cancelStopping(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      void enqueueWork(feed, async () => {
        feed.stopping = false;
        updateActivity(feed);
      });
    },

    async refreshActivity(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await enqueueWork(feed, async () => updateActivity(feed));
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

    async refreshHandoff(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await syncHandoff(feed);
    },

    async summary(botId) {
      // Read right before each return, so a slow summary never reports a stale wait. It uses the
      // same sources as the chat, so a row agrees with it whether or not a chat is open.
      const needsYouNow = () =>
        (deps.question?.(botId) ?? null) !== null ||
        (deps.handoff?.(botId) ?? null) !== null ||
        deps.approvalPending?.(botId) === true;
      const feed = feeds.get(botId);
      if (feed && !feed.ended) {
        await feed.queue;
        const preview = botTranscriptPreview(feed.entries);
        return {
          botId,
          preview: preview?.text ?? null,
          updatedAt: preview?.at ?? null,
          state: feed.state,
          needsYou: needsYouNow(),
          lastReplyAt: botLastReplyAt(feed.entries),
        };
      }
      const state = await deps.state(botId);
      if (state.kind === "unavailable") {
        return { botId, preview: null, updatedAt: null, state, needsYou: false, lastReplyAt: null };
      }
      const view = await (await deps.conversation(botId)).context(BACKGROUND_CONTEXT);
      const entries = projectBotTranscript(view.entries);
      const preview = botTranscriptPreview(entries);
      return {
        botId,
        preview: preview?.text ?? null,
        updatedAt: preview?.at ?? null,
        state,
        needsYou: needsYouNow(),
        lastReplyAt: botLastReplyAt(entries),
      };
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

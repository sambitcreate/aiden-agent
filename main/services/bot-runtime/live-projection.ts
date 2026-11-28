import { BOT_PEER_MESSAGE_ENTRY_KIND, parseBotPeerTranscriptData } from "../../../renderer/shared/bot-peers.js";
import {
  BOT_SETTINGS_CHANGE_ENTRY_KIND,
  BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND,
  botSettingsChangeOf,
  botSettingsChangeStatusOf,
  type BotSettingsChangeStatus,
} from "../../../renderer/shared/bot-settings-changes.js";
import { BOT_PEER_INPUT_KIND, } from "./bot-input-entry.js";
import type { BotPlanView } from "../../../renderer/shared/bot-plans.js";
import type { BotPendingAccessRequest } from "../../../renderer/shared/bot-access-requests.js";
import { BOT_MESSAGE_LIMITS, BOT_MESSAGE_STATUS_ENTRY_KIND, type BotMessageStatusEntryData } from "../../../renderer/shared/bot-messages.js";
import { BOT_MESSAGE_INPUT_KIND, isBotInputEntryKind } from "./bot-input-entry.js";
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

import {
  BOT_LESSON_LEARNED_ENTRY_KIND,
  BOT_LESSON_PROPOSAL_ENTRY_KIND,
  BOT_LESSON_STATUS_ENTRY_KIND,
  botLessonCardOf,
  botLessonStatusOf,
} from "../../../renderer/shared/bot-lessons.js";
import {
  BOT_SKILL_PROPOSAL_ENTRY_KIND,
  BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND,
  botSkillProposalOf,
  botSkillProposalStatusOf,
} from "../../../renderer/shared/bot-skill-proposals.js";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
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
  botRecentReplyTimes,
  botLastTurnEnd,
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
import {
  BOT_ISSUE_ENTRY_KIND,
  BOT_ISSUE_STATUS_ENTRY_KIND,
  botIssueOf,
  botIssueStatusOf,
  type BotIssueResolution,
} from "../../../renderer/shared/bot-issues.js";
import { watchActiveConversation, type ActiveConversationWatch } from "./active-transcript-watch.js";
import { botStepDescriptor } from "./bot-activity-detail.js";
import { BOT_SHARED_IMAGE_ENTRY_KIND } from "./bot-images.js";
import { BOT_WAKE_UP_ENTRY_KIND } from "../../../renderer/shared/bot-wake-ups.js";
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

/** Display only the clean metadata committed atomically with the admitted input. */
function botMessageInputOf(value: unknown): Omit<Extract<BotTranscriptEntry, {type: "bot_message"}>, "id" | "at"> | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (
    (data.kind !== "request" && data.kind !== "reply") ||
    typeof data.deliveryId !== "string" || !data.deliveryId ||
    typeof data.botId !== "string" || !data.botId ||
    typeof data.botName !== "string" || typeof data.text !== "string" ||
    typeof data.deadline !== "number" || !Number.isFinite(data.deadline)
  ) return null;
  return {
    type: "bot_message", kind: data.kind, botId: data.botId,
    botName: data.botName.slice(0, 80),
    text: data.text.slice(0, data.kind === "request" ? BOT_MESSAGE_LIMITS.messageChars : BOT_MESSAGE_LIMITS.replyChars),
  };
}

/** Entries that stay visible when the turn they follow is hidden as `[SILENT]`. */
const OUTLIVES_SILENT_TURN = new Set<BotTranscriptEntry["type"]>(["bot_message_status", "connect_card", "memory_update", "routine_proposal", "skill_proposal", "settings_change", "lesson_proposal", "lesson_learned", "memory_tidy", "wake_up"]);

/** Host-owned saved notices still validate and bound text before reaching any display. */
function botMessageStatusOf(value: unknown): BotMessageStatusEntryData | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.deliveryId !== "string" || typeof data.botId !== "string" || typeof data.botName !== "string" ||
    typeof data.outcome !== "string" ||
    !["waiting_approval", "silent", "expired", "gave_up", "failed", "replied_while_paused"].includes(data.outcome)
  ) return null;
  if (data.waitId !== undefined && typeof data.waitId !== "string") return null;
  return {
    deliveryId: data.deliveryId,
    botId: data.botId,
    botName: data.botName.slice(0, 80),
    outcome: data.outcome as BotMessageStatusEntryData["outcome"],
    ...(typeof data.waitId === "string" ? { waitId: data.waitId } : {}),
    ...(typeof data.summary === "string" ? { summary: data.summary.slice(0, 160) } : {}),
    ...(typeof data.text === "string" ? { text: data.text.slice(0, BOT_MESSAGE_LIMITS.replyChars) } : {}),
  };
}

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
  for (const key of ["proposalId", "name", "prompt", "label"] as const) {
    if (typeof record[key] !== "string") return null;
  }
  if (record.reason !== undefined && typeof record.reason !== "string") return null;
  // A schedule card (with its timezone) or a trigger card, never both.
  const trigger = typeof record.trigger === "object" && record.trigger !== null;
  const schedule = typeof record.schedule === "object" && record.schedule !== null && typeof record.timezone === "string";
  if (trigger === schedule) return null;
  if (trigger && (record.schedule !== undefined || record.timezone !== undefined)) return null;
  return data as BotRoutineProposalEntryData;
}

function proposalStatusOf(data: unknown): BotRoutineProposalStatusEntryData | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.proposalId !== "string") return null;
  if (record.status !== "accepted" && record.status !== "dismissed") return null;
  if (record.routineId !== undefined && typeof record.routineId !== "string") return null;
  if (record.supersededBy !== undefined && typeof record.supersededBy !== "string") return null;
  return {
    proposalId: record.proposalId,
    status: record.status,
    ...(record.routineId === undefined ? {} : { routineId: record.routineId }),
    ...(record.status === "dismissed" && record.supersededBy !== undefined ? { supersededBy: record.supersededBy } : {}),
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
  if (record.kind !== "pi.assistant") return;
  const message = firstMessage(record);
  if (message?.role !== "assistant") return;
  for (const part of message.content) {
    if (part.type === "toolCall") issued.set(part.id, (issued.get(part.id) ?? 0) + 1);
  }
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
 * - `aiden.bot-issue` → an `issue` card whose status is the newest
 *   `aiden.bot-issue-status` for its `issueId` (`open` without one); status
 *   entries themselves are not shown.
 * - A confirmed `write_file` / `edit_file` result in the Bot's folder → a file.
 * - `aiden.bot-notice` → `interrupted` and `session_reset` notices; routine,
 *   silent and hidden markers only shape the entries around them.
 * - A `[SILENT]` answer hides its whole turn (input label included).
 * - System, reset and compaction entries are not shown.
 */
const CHECKPOINT_BRAND: unique symbol = Symbol("BotTranscriptCheckpoint");

/**
 * Stateful active-turn checkpoint for `projectBotTranscript`. Holds the settled
 * transcript prefix and cross-turn status/call maps before the active turn's
 * opening input so step commits only scan and allocate the active turn tail.
 */
export interface BotTranscriptCheckpoint {
  readonly [CHECKPOINT_BRAND]: true;
}

/** `retryText`: the typed message Retry resends if this turn fails. */
type ProjectedTurn = { start: number; silent: boolean; retryText: string | null };

interface ChangedStatusKeys {
  proposals: Set<string>;
  skills: Set<string>;
  settings: Set<string>;
  lessons: Set<string>;
  issues: Set<string>;
}

interface TranscriptCheckpointState extends BotTranscriptCheckpoint {
  rawPrefix: EntryRecord[];
  prefixEntries: BotTranscriptEntry[];
  proposalIndices: Map<string, number[]>;
  skillIndices: Map<string, number[]>;
  settingsIndices: Map<string, number[]>;
  lessonIndices: Map<string, number[]>;
  issueIndices: Map<string, number[]>;
  proposalStatus: Map<string, BotRoutineProposalStatusEntryData>;
  skillStatus: Map<string, "added" | "dismissed">;
  settingsStatus: Map<string, BotSettingsChangeStatus>;
  lessonStatus: Map<string, "active" | "dismissed" | "retired">;
  issueStatus: Map<string, BotIssueResolution>;
  issued: Map<string, number>;
  prefixCallKeys: Set<string>;
  ruleHandoffs: Map<string, { record: EntryRecord; result: BotHandoffResultDetails }>;
  resultCallKeys: Set<string>;
  seenBotStatuses: Set<string>;
  pendingRoutine: string | undefined;
  pendingHidden: boolean;
  homeFileCalls: Set<string>;
  callStartedAt: Map<string, number>;
  emittedRuleHandoffs: Set<string>;
  handoffRowIds: Set<string>;
}

export function createBotTranscriptCheckpoint(): BotTranscriptCheckpoint {
  const state: TranscriptCheckpointState = {
    [CHECKPOINT_BRAND]: true,
    rawPrefix: [],
    prefixEntries: [],
    proposalIndices: new Map(),
    skillIndices: new Map(),
    settingsIndices: new Map(),
    lessonIndices: new Map(),
    issueIndices: new Map(),
    proposalStatus: new Map(),
    skillStatus: new Map(),
    settingsStatus: new Map(),
    lessonStatus: new Map(),
    issueStatus: new Map(),
    issued: new Map(),
    prefixCallKeys: new Set(),
    ruleHandoffs: new Map(),
    resultCallKeys: new Set(),
    seenBotStatuses: new Set(),
    pendingRoutine: undefined,
    pendingHidden: false,
    homeFileCalls: new Set(),
    callStartedAt: new Map(),
    emittedRuleHandoffs: new Set(),
    handoffRowIds: new Set(),
  };
  return state;
}

function isTranscriptCheckpoint(value: unknown): value is TranscriptCheckpointState {
  return typeof value === "object" && value !== null && CHECKPOINT_BRAND in value;
}

function resetCheckpointState(state: TranscriptCheckpointState): void {
  state.rawPrefix = [];
  state.prefixEntries = [];
  state.proposalIndices.clear();
  state.skillIndices.clear();
  state.settingsIndices.clear();
  state.lessonIndices.clear();
  state.issueIndices.clear();
  state.proposalStatus.clear();
  state.skillStatus.clear();
  state.settingsStatus.clear();
  state.lessonStatus.clear();
  state.issueStatus.clear();
  state.issued.clear();
  state.prefixCallKeys.clear();
  state.ruleHandoffs.clear();
  state.resultCallKeys.clear();
  state.seenBotStatuses.clear();
  state.pendingRoutine = undefined;
  state.pendingHidden = false;
  state.homeFileCalls.clear();
  state.callStartedAt.clear();
  state.emittedRuleHandoffs.clear();
  state.handoffRowIds.clear();
}

function findActiveTurnBoundary(entries: readonly EntryRecord[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const record = entries[i]!;
    if (record.kind === BOT_PEER_INPUT_KIND) return i;
    if (isBotInputEntryKind(record.kind) && firstMessage(record)?.role === "user") return i;
  }
  return 0;
}

function hasSameRawPrefix(entries: readonly EntryRecord[], prefix: readonly EntryRecord[]): boolean {
  if (entries.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (entries[i] !== prefix[i]) return false;
  }
  return true;
}

function pushCardIndex(map: Map<string, number[]>, key: string, index: number): void {
  const list = map.get(key);
  if (list) list.push(index);
  else map.set(key, [index]);
}

function indexSettledCard(state: TranscriptCheckpointState, entry: BotTranscriptEntry, index: number): void {
  if (entry.type === "routine_proposal") pushCardIndex(state.proposalIndices, entry.proposal.proposalId, index);
  else if (entry.type === "skill_proposal") pushCardIndex(state.skillIndices, entry.proposal.proposalId, index);
  else if (entry.type === "settings_change") pushCardIndex(state.settingsIndices, entry.change.changeId, index);
  else if (entry.type === "lesson_proposal" || entry.type === "lesson_learned") {
    pushCardIndex(state.lessonIndices, entry.lesson.lessonId, index);
  } else if (entry.type === "issue") {
    pushCardIndex(state.issueIndices, entry.issue.id, index);
  }
}

function tailReferencesPrefixCall(
  entries: readonly EntryRecord[],
  startIndex: number,
  cp: TranscriptCheckpointState,
): boolean {
  if (cp.prefixCallKeys.size === 0) return false;
  let localIssued: Map<string, number> | undefined;
  const currentKey = (toolCallId: string): string => {
    const count = localIssued?.get(toolCallId) ?? cp.issued.get(toolCallId) ?? 0;
    return `${count}:${toolCallId}`;
  };
  for (let i = startIndex; i < entries.length; i += 1) {
    const record = entries[i]!;
    if (record.kind === BOT_HANDOFF_RESULT_ENTRY_KIND) {
      const result = botHandoffResultOf(record.data);
      if (result?.toolCallId !== undefined && result.rule !== undefined && cp.prefixCallKeys.has(currentKey(result.toolCallId))) {
        return true;
      }
    } else if (record.kind === "pi.tool-result") {
      const message = firstMessage(record);
      if (message?.role === "toolResult" && cp.prefixCallKeys.has(currentKey(message.toolCallId))) return true;
    } else if (record.kind === "pi.assistant") {
      const message = firstMessage(record);
      if (message?.role === "assistant") {
        for (const part of message.content) {
          if (part.type === "toolCall") {
            localIssued ??= new Map();
            const prev = localIssued.get(part.id) ?? cp.issued.get(part.id) ?? 0;
            localIssued.set(part.id, prev + 1);
          }
        }
      }
    }
  }
  return false;
}

function revisePrefixCards(
  prefixEntries: BotTranscriptEntry[],
  cp: TranscriptCheckpointState,
  changed: ChangedStatusKeys,
  lookup: {
    proposal(id: string): BotRoutineProposalStatusEntryData | undefined;
    skill(id: string): "added" | "dismissed" | undefined;
    settings(id: string): BotSettingsChangeStatus | undefined;
    lesson(id: string): "active" | "dismissed" | "retired" | undefined;
    issue(id: string): BotIssueResolution | undefined;
  },
  inPlace: boolean,
): BotTranscriptEntry[] {
  let target = prefixEntries;
  let copied = inPlace;
  const writeAt = (index: number, updated: BotTranscriptEntry) => {
    if (!copied) {
      target = [...prefixEntries];
      copied = true;
    }
    target[index] = updated;
  };
  for (const proposalId of changed.proposals) {
    const decided = lookup.proposal(proposalId);
    for (const index of cp.proposalIndices.get(proposalId) ?? []) {
      const current = target[index];
      if (current?.type !== "routine_proposal") continue;
      const nextStatus = decided?.status ?? "pending";
      if (
        current.status === nextStatus &&
        current.routineId === decided?.routineId &&
        current.supersededBy === decided?.supersededBy
      ) {
        continue;
      }
      writeAt(index, {
        id: current.id,
        type: "routine_proposal",
        proposal: current.proposal,
        status: nextStatus,
        ...(decided?.routineId === undefined ? {} : { routineId: decided.routineId }),
        ...(decided?.supersededBy === undefined ? {} : { supersededBy: decided.supersededBy }),
      });
    }
  }
  for (const proposalId of changed.skills) {
    const nextStatus = lookup.skill(proposalId) ?? "pending";
    for (const index of cp.skillIndices.get(proposalId) ?? []) {
      const current = target[index];
      if (current?.type !== "skill_proposal" || current.status === nextStatus) continue;
      writeAt(index, { ...current, status: nextStatus });
    }
  }
  for (const changeId of changed.settings) {
    const nextStatus = lookup.settings(changeId) ?? "pending";
    for (const index of cp.settingsIndices.get(changeId) ?? []) {
      const current = target[index];
      if (current?.type !== "settings_change" || current.status === nextStatus) continue;
      writeAt(index, { ...current, status: nextStatus });
    }
  }
  for (const lessonId of changed.lessons) {
    const decided = lookup.lesson(lessonId);
    for (const index of cp.lessonIndices.get(lessonId) ?? []) {
      const current = target[index];
      if (current?.type !== "lesson_proposal" && current?.type !== "lesson_learned") continue;
      const nextStatus = decided ?? (current.type === "lesson_proposal" ? "pending" : "active");
      if (current.status === nextStatus) continue;
      writeAt(index, { ...current, status: nextStatus });
    }
  }
  for (const issueId of changed.issues) {
    const decided = lookup.issue(issueId);
    for (const index of cp.issueIndices.get(issueId) ?? []) {
      const current = target[index];
      if (current?.type !== "issue") continue;
      const nextStatus = decided ?? current.issue.resolution ?? "open";
      if (current.status === nextStatus) continue;
      writeAt(index, { ...current, status: nextStatus });
    }
  }
  return target;
}

function projectRange(
  entries: readonly EntryRecord[],
  startIndex: number,
  endIndex: number,
  base: TranscriptCheckpointState | null,
  commitToBase: boolean,
): { tail: BotTranscriptEntry[]; prefix?: BotTranscriptEntry[] } {
  const changed: ChangedStatusKeys | null =
    base && base.prefixEntries.length > 0
      ? { proposals: new Set(), skills: new Set(), settings: new Set(), lessons: new Set(), issues: new Set() }
      : null;

  const localProposalStatus = commitToBase && base ? base.proposalStatus : new Map<string, BotRoutineProposalStatusEntryData>();
  const localSkillStatus = commitToBase && base ? base.skillStatus : new Map<string, "added" | "dismissed">();
  const localSettingsStatus = commitToBase && base ? base.settingsStatus : new Map<string, BotSettingsChangeStatus>();
  const localLessonStatus = commitToBase && base ? base.lessonStatus : new Map<string, "active" | "dismissed" | "retired">();
  const localIssueStatus = commitToBase && base ? base.issueStatus : new Map<string, BotIssueResolution>();
  const localRuleHandoffs = commitToBase && base ? base.ruleHandoffs : new Map<string, { record: EntryRecord; result: BotHandoffResultDetails }>();
  const localResultCallKeys = commitToBase && base ? base.resultCallKeys : new Set<string>();
  const pass1Issued = new Map<string, number>();

  const pass1CallKey = (toolCallId: string): string => {
    const count = pass1Issued.get(toolCallId) ?? base?.issued.get(toolCallId) ?? 0;
    return `${count}:${toolCallId}`;
  };
  const bumpIssued = (target: Map<string, number>, record: EntryRecord, recordPrefixKeys: boolean): void => {
    if (record.kind !== "pi.assistant") return;
    const message = firstMessage(record);
    if (message?.role !== "assistant") return;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const next = (target.get(part.id) ?? base?.issued.get(part.id) ?? 0) + 1;
      target.set(part.id, next);
      if (recordPrefixKeys && base) base.prefixCallKeys.add(`${next}:${part.id}`);
    }
  };

  for (let i = startIndex; i < endIndex; i += 1) {
    const record = entries[i]!;
    if (record.kind === BOT_LESSON_STATUS_ENTRY_KIND) {
      const status = botLessonStatusOf(record.data);
      if (status) {
        localLessonStatus.set(status.lessonId, status.status);
        changed?.lessons.add(status.lessonId);
      }
      continue;
    }
    if (record.kind === BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND) {
      const status = proposalStatusOf(record.data);
      if (status) {
        localProposalStatus.set(status.proposalId, status);
        changed?.proposals.add(status.proposalId);
      }
    } else if (record.kind === BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND) {
      const status = botSkillProposalStatusOf(record.data);
      if (status) {
        localSkillStatus.set(status.proposalId, status.status);
        changed?.skills.add(status.proposalId);
      }
    } else if (record.kind === BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND) {
      const status = botSettingsChangeStatusOf(record.data);
      if (status) {
        localSettingsStatus.set(status.changeId, status.status);
        changed?.settings.add(status.changeId);
      }
    } else if (record.kind === BOT_ISSUE_STATUS_ENTRY_KIND) {
      const status = botIssueStatusOf(record.data);
      if (status) {
        localIssueStatus.set(status.issueId, status.resolution);
        changed?.issues.add(status.issueId);
      }
    } else if (record.kind === BOT_HANDOFF_RESULT_ENTRY_KIND) {
      const result = botHandoffResultOf(record.data);
      if (result?.toolCallId !== undefined && result.rule !== undefined) {
        const key = pass1CallKey(result.toolCallId);
        localRuleHandoffs.set(key, { record, result });
        if (commitToBase && base) base.prefixCallKeys.add(key);
      }
    } else if (record.kind === "pi.tool-result") {
      const message = firstMessage(record);
      if (message?.role === "toolResult") {
        const key = pass1CallKey(message.toolCallId);
        localResultCallKeys.add(key);
        if (commitToBase && base) base.prefixCallKeys.add(key);
      }
    } else {
      bumpIssued(pass1Issued, record, commitToBase);
    }
  }

  const getProposalStatus = (id: string) => localProposalStatus.get(id) ?? base?.proposalStatus.get(id);
  const getSkillStatus = (id: string) => localSkillStatus.get(id) ?? base?.skillStatus.get(id);
  const getSettingsStatus = (id: string) => localSettingsStatus.get(id) ?? base?.settingsStatus.get(id);
  const getLessonStatus = (id: string) => localLessonStatus.get(id) ?? base?.lessonStatus.get(id);
  const getIssueStatus = (id: string) => localIssueStatus.get(id) ?? base?.issueStatus.get(id);
  const getRuleHandoff = (key: string) => localRuleHandoffs.get(key) ?? base?.ruleHandoffs.get(key);
  const hasResultCallKey = (key: string) => localResultCallKeys.has(key) || (base?.resultCallKeys.has(key) ?? false);

  let revisedPrefix = base?.prefixEntries;
  if (
    base &&
    changed &&
    (changed.proposals.size > 0 ||
      changed.skills.size > 0 ||
      changed.settings.size > 0 ||
      changed.lessons.size > 0 ||
      changed.issues.size > 0)
  ) {
    revisedPrefix = revisePrefixCards(
      base.prefixEntries,
      base,
      changed,
      {
        proposal: getProposalStatus,
        skill: getSkillStatus,
        settings: getSettingsStatus,
        lesson: getLessonStatus,
        issue: getIssueStatus,
      },
      commitToBase,
    );
  }

  const mapped: Array<{ entry: BotTranscriptEntry; turn: ProjectedTurn | null }> = [];
  const localSeenBotStatuses = commitToBase && base ? base.seenBotStatuses : new Set<string>();
  const hasSeenBotStatus = (key: string) => localSeenBotStatuses.has(key) || (base?.seenBotStatuses.has(key) ?? false);
  let pendingRoutine = base?.pendingRoutine;
  let pendingHidden = base?.pendingHidden ?? false;
  const localHomeFileCalls = commitToBase && base ? base.homeFileCalls : new Set<string>();
  const isHomeFileCall = (id: string) => localHomeFileCalls.has(id) || (base?.homeFileCalls.has(id) ?? false);
  const localCallStartedAt = commitToBase && base ? base.callStartedAt : new Map<string, number>();
  const getCallStartedAt = (id: string) => localCallStartedAt.get(id) ?? base?.callStartedAt.get(id);
  const localEmittedRuleHandoffs = commitToBase && base ? base.emittedRuleHandoffs : new Set<string>();
  const hasEmittedRuleHandoff = (key: string) =>
    localEmittedRuleHandoffs.has(key) || (base?.emittedRuleHandoffs.has(key) ?? false);
  const localHandoffRowIds = commitToBase && base ? base.handoffRowIds : new Set<string>();
  const hasHandoffRowId = (id: string) => localHandoffRowIds.has(id) || (base?.handoffRowIds.has(id) ?? false);
  /** The first answer for a call id keeps `handoff:<toolCallId>`; a reused id's later ones add their entry id. */
  const handoffRowId = (toolCallId: string, record: EntryRecord): string => {
    const rowBase = `handoff:${toolCallId}`;
    const rowId = hasHandoffRowId(rowBase) ? `${rowBase}:${String(record.id)}` : rowBase;
    localHandoffRowIds.add(rowId);
    return rowId;
  };
  const pass2Issued = commitToBase && base ? base.issued : new Map<string, number>();
  const pass2CallKey = (toolCallId: string): string => {
    const count = pass2Issued.get(toolCallId) ?? base?.issued.get(toolCallId) ?? 0;
    return `${count}:${toolCallId}`;
  };
  let turn: ProjectedTurn | null = null;

  const ruleHandoffRow = (key: string, at: number | undefined): BotTranscriptEntry | undefined => {
    const found = getRuleHandoff(key);
    if (found === undefined || hasEmittedRuleHandoff(key)) return undefined;
    localEmittedRuleHandoffs.add(key);
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

  for (let i = startIndex; i < endIndex; i += 1) {
    const record = entries[i]!;
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
    if (record.kind === BOT_MESSAGE_STATUS_ENTRY_KIND) {
      const data = botMessageStatusOf(record.data);
      if (data) {
        const key = JSON.stringify([data.deliveryId, data.outcome, data.waitId ?? ""]);
        if (!hasSeenBotStatus(key)) {
          localSeenBotStatuses.add(key);
          mapped.push({ entry: { id, type: "bot_message_status", data }, turn: null });
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
        const decided = getProposalStatus(proposal.proposalId);
        mapped.push({
          entry: {
            id,
            type: "routine_proposal",
            proposal,
            status: decided?.status ?? "pending",
            ...(decided?.routineId === undefined ? {} : { routineId: decided.routineId }),
            ...(decided?.supersededBy === undefined ? {} : { supersededBy: decided.supersededBy }),
          },
          turn,
        });
      }
      continue;
    }
    if (record.kind === BOT_ROUTINE_PROPOSAL_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_SKILL_PROPOSAL_ENTRY_KIND) {
      const proposal = botSkillProposalOf(record.data);
      if (proposal) {
        mapped.push({ entry: { id, type: "skill_proposal", proposal, status: getSkillStatus(proposal.proposalId) ?? "pending" }, turn });
      }
      continue;
    }
    if (record.kind === BOT_SKILL_PROPOSAL_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_SETTINGS_CHANGE_ENTRY_KIND) {
      const change = botSettingsChangeOf(record.data);
      if (change) mapped.push({ entry: { id, type: "settings_change", change, status: getSettingsStatus(change.changeId) ?? "pending" }, turn });
      continue;
    }
    if (record.kind === BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_LESSON_PROPOSAL_ENTRY_KIND || record.kind === BOT_LESSON_LEARNED_ENTRY_KIND) {
      const lesson = botLessonCardOf(record.data);
      if (lesson) {
        const proposal = record.kind === BOT_LESSON_PROPOSAL_ENTRY_KIND;
        mapped.push({
          entry: {
            id,
            type: proposal ? "lesson_proposal" : "lesson_learned",
            lesson,
            status: getLessonStatus(lesson.lessonId) ?? (proposal ? "pending" : "active"),
          },
          turn: null,
        });
      }
      continue;
    }
    if (record.kind === BOT_LESSON_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_WAKE_UP_ENTRY_KIND) {
      const data = record.data as { wakeUpId?: unknown; fireAt?: unknown } | null;
      if (typeof data?.wakeUpId === "string" && typeof data.fireAt === "number" && Number.isFinite(data.fireAt)) {
        mapped.push({ entry: { id, type: "wake_up", wakeUpId: data.wakeUpId, fireAt: data.fireAt }, turn });
      }
      continue;
    }
    if (record.kind === "aiden.memory-tidy") {
      const data = record.data as { changeId?: unknown } | null;
      const changeId = typeof data?.changeId === "string" ? data.changeId : undefined;
      mapped.push({ entry: { id, type: "memory_tidy", ...(changeId ? { changeId } : {}) }, turn: null });
      continue;
    }
    if (record.kind === BOT_ISSUE_ENTRY_KIND) {
      const issue = botIssueOf(record.data);
      if (issue) {
        // Host entries sit between turns: a [SILENT] routine never hides one.
        mapped.push({
          entry: {
            id,
            type: "issue",
            issue,
            status: getIssueStatus(issue.id) ?? issue.resolution ?? "open",
            at: issue.createdAt,
          },
          turn: null,
        });
      }
      continue;
    }
    if (record.kind === BOT_ISSUE_STATUS_ENTRY_KIND) continue;
    if (record.kind === BOT_HANDOFF_RESULT_ENTRY_KIND) {
      // Read after the blocked call's result; here only when that result never landed.
      const result = botHandoffResultOf(record.data);
      const toolCallId = result?.toolCallId;
      const key = toolCallId === undefined ? undefined : pass2CallKey(toolCallId);
      if (key !== undefined && !hasResultCallKey(key) && getRuleHandoff(key)?.record === record) {
        const row = ruleHandoffRow(key, undefined);
        if (row) mapped.push({ entry: row, turn });
      }
      continue;
    }
    const message = firstMessage(record);
    if (record.kind === BOT_PEER_MESSAGE_ENTRY_KIND || record.kind === BOT_PEER_INPUT_KIND) {
      if (record.kind === BOT_PEER_INPUT_KIND) { turn = { start: mapped.length, silent: false, retryText: null }; pendingHidden = false; pendingRoutine = undefined; }
      try { const peer = parseBotPeerTranscriptData(record.kind === BOT_PEER_INPUT_KIND ? (record.data as { peer?: unknown } | undefined)?.peer : record.data); mapped.push({ entry: { id, type: "peer", ...peer, ...(peer.at === undefined && typeof message?.timestamp === "number" ? { at: message.timestamp } : {}) }, turn }); } catch { /* Invalid private peer bookkeeping never becomes a person bubble. */ }
      continue;
    }
    if (isBotInputEntryKind(record.kind) && message?.role === "user") {
      const content = message.content as UserContent;
      const text = textOf(content);
      turn = {
        start: mapped.length,
        silent: false,
        retryText: pendingHidden || pendingRoutine !== undefined || record.kind === BOT_MESSAGE_INPUT_KIND || !text.trim() ? null : text,
      };
      if (record.kind === BOT_MESSAGE_INPUT_KIND) {
        const input = botMessageInputOf(record.data);
        pendingRoutine = undefined;
        pendingHidden = false;
        if (input) mapped.push({ entry: { ...input, id, at: message.timestamp }, turn });
        continue;
      }
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
      if (commitToBase && base) countIssuedCalls(record, base.issued);
      else bumpIssued(pass2Issued, record, false);
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      for (const call of calls) {
        if (BOT_FILE_CHIP_TOOLS.has(call.name) && (call.arguments as { location?: unknown } | undefined)?.location === undefined) {
          localHomeFileCalls.add(call.id);
        }
      }
      for (const call of calls) {
        if (typeof message.timestamp === "number") localCallStartedAt.set(call.id, message.timestamp);
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
      const startedAt = getCallStartedAt(message.toolCallId);
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
      const ruleRow = ruleHandoffRow(pass2CallKey(message.toolCallId), at);
      if (ruleRow) mapped.push({ entry: ruleRow, turn });
      // A file the Bot wrote in its folder, as the tool result confirms it.
      const produced =
        !message.isError && isHomeFileCall(message.toolCallId)
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

  const tail = mapped
    .filter(({ entry, turn: owner }) => !(owner?.silent && !OUTLIVES_SILENT_TURN.has(entry.type)) && !isSilentAnswer(entry))
    .map(({ entry }) => entry);

  if (commitToBase && base) {
    base.pendingRoutine = pendingRoutine;
    base.pendingHidden = pendingHidden;
    for (const entry of tail) {
      const index = base.prefixEntries.length;
      base.prefixEntries.push(entry);
      indexSettledCard(base, entry, index);
    }
    for (let i = startIndex; i < endIndex; i += 1) {
      base.rawPrefix.push(entries[i]!);
    }
  }

  return { tail, prefix: revisedPrefix };
}

export function projectBotTranscript(
  entries: readonly EntryRecord[],
  checkpoint?: BotTranscriptCheckpoint,
): BotTranscriptEntry[] {
  if (!isTranscriptCheckpoint(checkpoint)) {
    return projectRange(entries, 0, entries.length, null, false).tail;
  }
  if (!hasSameRawPrefix(entries, checkpoint.rawPrefix)) {
    resetCheckpointState(checkpoint);
  }
  const boundary = findActiveTurnBoundary(entries);
  if (tailReferencesPrefixCall(entries, checkpoint.rawPrefix.length, checkpoint)) {
    resetCheckpointState(checkpoint);
  }
  if (boundary > checkpoint.rawPrefix.length) {
    projectRange(entries, checkpoint.rawPrefix.length, boundary, checkpoint, true);
  }
  if (boundary === entries.length) {
    return [...checkpoint.prefixEntries];
  }
  const { prefix, tail } = projectRange(entries, boundary, entries.length, checkpoint, false);
  const settledPrefix = prefix ?? checkpoint.prefixEntries;
  if (settledPrefix.length === 0) return tail;
  if (tail.length === 0) return [...settledPrefix];
  return [...settledPrefix, ...tail];
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
    if (isBotInputEntryKind(kind)) return false;
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

  /**
   * Wake the caller once the pause is over by the classifier's own clock. A
   * timer can fire early against `now()` (a busy event loop schedules from a
   * stale loop time), so an early firing waits out the rest instead of
   * opening the pause.
   */
  function armTimer(delayMs: number): void {
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      const remaining = notBefore - deps.now();
      if (remaining > 0) {
        armTimer(remaining);
        return;
      }
      deps.retry();
    }, delayMs);
    timer.unref?.();
  }

  function scheduleRetry(): void {
    if (timer !== undefined || closed) return;
    armTimer(Math.max(0, notBefore - deps.now()));
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
        if (unknown.some((id) => !kinds.has(id))) {
          notBefore = deps.now() + deps.retryMs;
          scheduleRetry();
        }
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
  /** Public card from the host bridge; authorization never enters this feed. */
  accessRequest?(botId: string): BotPendingAccessRequest | null;
  /** Public waiting-first plan view; never the stored proposal or authorization. */
  plan?(botId: string): Promise<BotPlanView | null>;
  /**
   * Classify queued submission ids: `true` for a routine's input or the hidden
   * self-intro, `false` for the person's own message. Decided from durable
   * request ids. An id the session cannot find is left out of the answer; an
   * id with no answer, or a failure, stays hidden and is retried.
   */
  quietInputs(botId: string, submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** Whether a tool approval is waiting on the person. */
  approvalPending?(botId: string): boolean;
  /** Whether an open "Needs you" issue is waiting on the person for this Bot. */
  issuePending?(botId: string): Promise<boolean> | boolean;
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

export interface BotLiveRunObservation {
  readonly queued: number;
  unsubscribe(): void;
}

export interface BotLiveProjection {
  subscribe(botId: string, sink: BotLiveSink): Promise<BotLiveSubscription>;
  /**
   * Observe live progress and personal queued-input count for a running Bot
   * without projecting transcript entries.
   */
  observeRun(botId: string, onProgress: (update: { queued: number }) => void): Promise<BotLiveRunObservation>;
  /** The session state changed (send, resume, dismiss, stop). Starts a feed for a running reply. */
  notifyState(botId: string, state: BotSessionState): void;
  /** Re-read the transcript and push a snapshot, e.g. after a connection status changed. */
  refresh(botId: string): Promise<void>;
  /** The Bot's pending question changed (asked, answered, withdrawn): push a `question` event. */
  refreshQuestion(botId: string): Promise<void>;
  /** The Bot's pending hand-off changed (opened, answered, withdrawn): push a `handoff` event. */
  refreshHandoff(botId: string): Promise<void>;
  /** Publish the current access-request attempt or its removal. */
  refreshAccessRequest(botId: string): Promise<void>;
  /** Re-read the plan and publish a changed identity, revision or removal. */
  refreshPlan(botId: string): Promise<void>;
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
  /**
   * The summary's `needsYou` alone, without reading the transcript: an open
   * question, hand-off, access request, pending plan, approval or issue, and never for an unavailable Bot
   * with no open feed. The Dock badge reads it on every recount.
   */
  needsYou(botId: string): Promise<boolean>;
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
  accessRequest: BotPendingAccessRequest | null;
  plan: BotPlanView | null;
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
  /** Whether UI transcript entries are actively projected for this feed. */
  projected: boolean;
  /** Active-turn checkpoint so step commits project only the active turn tail. */
  transcriptCheckpoint: BotTranscriptCheckpoint;
  /** Raw entries that `baseEntries` was projected from, before connect-card resolution. */
  baseEntriesRef: readonly EntryRecord[] | undefined;
  /** Transcript entries before live connect-card status resolution. */
  baseEntries: BotTranscriptEntry[];
  /** Last raw entries seen while deferred, so entry commits still count as run progress. */
  observedEntries: readonly EntryRecord[] | undefined;
  /**
   * The frame entries `entries` was projected from, while re-projecting them
   * would give the same result: no connect card waits on a live status and no
   * refresh has replaced them since. A frame that hands back this same array
   * (the watch returns it unchanged when nothing new arrived) skips projection.
   */
  projectedFrom: readonly EntryRecord[] | undefined;
  runActive: boolean;
  /**
   * Whether the current run's end was already reported (`onRunSettled`), so a
   * frame and the opening reconciliation don't both report it. A new run clears it.
   */
  settled: boolean;
  /** Identity of the current run; a follow-up turn replaces the run without a gap. */
  runKey: string | null;
  watch: ActiveConversationWatch;
  cancel: () => void;
  ended: boolean;
  /** Serializes frame handling with refreshes and state changes. */
  queue: Promise<void>;
}

function sameEntry(left: BotTranscriptEntry, right: BotTranscriptEntry): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A pending connect card resolves against live status, so its projection can change without new entries. */
function awaitsCardStatus(entries: readonly BotTranscriptEntry[]): boolean {
  return entries.some((entry) => entry.type === "connect_card" && entry.card.status === "pending");
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
  // A closed Bot's preview and last reply, kept with the newest entry they were
  // read through. Every transcript change (a turn, a reset, a compaction, an
  // edit) appends an entry, so one newest-entry read tells a list refresh (the
  // Remote host feed asks on every chat or Bot change) whether the transcript
  // needs reading again.
  type BotTranscriptSummary = Pick<BotLiveSummary, "preview" | "updatedAt" | "lastReplyAt" | "recentReplyAt" | "lastTurnEnd">;
  const transcriptSummaries = new Map<string, { key: string } & BotTranscriptSummary>();

  async function transcriptSummary(botId: string, conversation: Conversation): Promise<BotTranscriptSummary> {
    const newest = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
    const key = `${conversation.id}:${newest.items[0]?.id ?? ""}`;
    const cached = transcriptSummaries.get(botId);
    if (cached?.key === key) {
      const { key: _key, ...summary } = cached;
      return summary;
    }
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const entries = projectBotTranscript(view.entries);
    const preview = botTranscriptPreview(entries);
    const lastTurnEnd = botLastTurnEnd(entries);
    const summary: BotTranscriptSummary = {
      preview: preview?.text ?? null,
      updatedAt: preview?.at ?? null,
      lastReplyAt: botLastReplyAt(entries),
      recentReplyAt: botRecentReplyTimes(entries),
      ...(lastTurnEnd ? { lastTurnEnd } : {}),
    };
    transcriptSummaries.set(botId, { key, ...summary });
    return summary;
  }
  const opening = new Map<string, Promise<Feed>>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const attachingSubscribers = new Map<string, number>();
  const runObservers = new Map<string, Set<(update: { queued: number }) => void>>();
  /** Where each Bot's last feed stopped, so `seq` keeps rising across epochs. */
  const lastSeq = new Map<string, number>();

  function hasUiViewers(botId: string): boolean {
    return (subscribers.get(botId)?.size ?? 0) > 0 || (attachingSubscribers.get(botId) ?? 0) > 0;
  }

  function notifyRunObservers(feed: Feed): void {
    const observers = runObservers.get(feed.botId);
    if (!observers || observers.size === 0) return;
    const update = { queued: feed.queued.length };
    for (const observer of observers) {
      try {
        observer(update);
      } catch (error) {
        report(feed.botId, error);
      }
    }
  }

  const report = (botId: string, error: unknown) => deps.onError?.(botId, error);
  /**
   * Feed openings that failed, by their error (every notice that joined one sees
   * the same error): reported once, and the run settled once for whichever
   * joined notice was a running one, whatever order the notices came in.
   */
  const failedOpenings = new WeakMap<object, { settling: boolean }>();
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
      accessRequest: feed.accessRequest,
      plan: feed.plan,
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
    notifyRunObservers(feed);
  }

  function emitSnapshot(feed: Feed): void {
    feed.seq += 1;
    lastSeq.set(feed.botId, feed.seq);
    const snapshot = snapshotOf(feed);
    const event: BotLiveEvent = { botId: feed.botId, epoch: feed.epoch, seq: feed.seq, type: "snapshot", snapshot };
    for (const subscriber of subscribers.get(feed.botId) ?? []) enqueue(subscriber, feed.botId, event);
    notifyRunObservers(feed);
  }

  function waitingOn(feed: Feed): boolean {
    return feed.question !== null || feed.handoff !== null || feed.accessRequest !== null || feed.plan?.status === "pending" || deps.approvalPending?.(feed.botId) === true;
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

  /** Project frame entries; `stable` when the same array always projects to the same transcript. */
  async function projectFrame(feed: Feed, entries: readonly EntryRecord[]) {
    let baseEntries: BotTranscriptEntry[];
    if (entries === feed.baseEntriesRef) {
      baseEntries = feed.baseEntries;
    } else {
      baseEntries = projectBotTranscript(entries, feed.transcriptCheckpoint);
      feed.baseEntries = baseEntries;
      feed.baseEntriesRef = entries;
    }
    const resolved = await resolveCards(feed, baseEntries);
    const stable = !deps.connectCardStatus || !awaitsCardStatus(resolved);
    return { entries: resolved, stable };
  }

  async function resolveCards(feed: Feed, entries: BotTranscriptEntry[]): Promise<BotTranscriptEntry[]> {
    if (!deps.connectCardStatus || !awaitsCardStatus(entries)) return entries;
    const resolved: BotTranscriptEntry[] = [];
    // The newest card for a plugin carries its live status; older ones keep theirs.
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "connect_card" || entry.card.status !== "pending") {
        resolved.push(entry);
        continue;
      }
      const status = await deps.connectCardStatus(feed.botId, entry.card).catch(() => entry.card.status);
      if (status === entry.card.status) {
        resolved.push(entry);
        continue;
      }
      const previous = feed.entries[index];
      if (
        previous?.type === "connect_card" &&
        previous.id === entry.id &&
        previous.card.pluginId === entry.card.pluginId &&
        previous.card.reason === entry.card.reason &&
        previous.card.status === status
      ) {
        resolved.push(previous);
        continue;
      }
      resolved.push({ ...entry, card: { ...entry.card, status } });
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
    let unwatchedEntryProgress = false;
    if (feed.projected) {
      if (entries !== feed.projectedFrom) {
        const projected = await projectFrame(feed, entries);
        applyEntries(feed, projected.entries);
        feed.projectedFrom = projected.stable ? entries : undefined;
      }
    } else if (entries !== feed.observedEntries) {
      feed.observedEntries = entries;
      unwatchedEntryProgress = true;
    }
    const partial = livePartialText(docs);
    if (partial !== feed.partial) {
      feed.partial = partial;
      unwatchedEntryProgress = false;
      emit(feed, { type: "partial", text: partial });
    }
    const queued = await queuedFor(feed, docs);
    if (JSON.stringify(queued) !== JSON.stringify(feed.queued)) {
      feed.queued = queued;
      unwatchedEntryProgress = false;
      emit(feed, { type: "queued", queued });
    }
    const runActive = liveRunActive(docs);
    if (runActive === feed.runActive) {
      const prevActivity = feed.activity;
      updateActivity(feed);
      if (unwatchedEntryProgress && feed.activity === prevActivity) notifyRunObservers(feed);
      return;
    }
    feed.runActive = runActive;
    if (runActive) feed.settled = false;
    // The run's end is reported with its new state, so the line never flashes a phase after the reply.
    const state = await deps.state(feed.botId).catch(() => feed.state);
    const prevState = feed.state;
    const prevActivity = feed.activity;
    setState(feed, state);
    updateActivity(feed);
    if (unwatchedEntryProgress && feed.state === prevState && feed.activity === prevActivity) {
      notifyRunObservers(feed);
    }
    if (!runActive) {
      feed.stopping = false;
      feed.resuming = false;
      resumingBots.delete(feed.botId);
      if (!feed.settled) {
        feed.settled = true;
        deps.onRunSettled?.(feed.botId, state);
      }
      void closeIfUnwatched(feed);
    }
  }

  function setState(feed: Feed, state: BotSessionState): void {
    if (JSON.stringify(state) === JSON.stringify(feed.state)) return;
    const wasRunning = feed.state.kind === "running";
    feed.state = state;
    if (state.kind === "running" && !wasRunning) {
      feed.settled = false;
      startRun(feed);
    }
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
      const watch = await watchActiveConversation(conversation, context);
      const initial = watch.value;
      const epoch = newEpoch();
      const seq = lastSeq.get(botId) ?? 0;
      const transcriptCheckpoint = createBotTranscriptCheckpoint();
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
        epoch,
        seq,
        entries: [],
        partial: livePartialText(initial.docs),
        state: await deps.state(botId),
        question: deps.question?.(botId) ?? null,
        handoff: deps.handoff?.(botId) ?? null,
        accessRequest: deps.accessRequest?.(botId) ?? null,
        plan: await deps.plan?.(botId) ?? null,
        activity: null,
        queued: [],
        classifier,
        startedAt: now(),
        stopping: false,
        resuming: false,
        resumedFrom: undefined,
        frame: { entries: initial.entries, docs: initial.docs },
        projected: false,
        transcriptCheckpoint,
        baseEntriesRef: undefined,
        baseEntries: [],
        observedEntries: initial.entries,
        projectedFrom: undefined,
        runActive: liveRunActive(initial.docs),
        settled: false,
        runKey: liveRunKey(initial.docs),
        watch,
        cancel: () => cancel(new Error("Bot live feed closed.")),
        ended: false,
        queue: Promise.resolve(),
      };
      if (hasUiViewers(botId)) {
        const projected = await projectFrame(feed, initial.entries);
        feed.entries = projected.entries;
        feed.projected = true;
        feed.projectedFrom = projected.stable ? initial.entries : undefined;
      }
      opened = feed;
      if (feed.state.kind === "running") startRun(feed);
      else runStarts.ended(botId);
      feed.activity = computeActivity(feed);
      feed.queued = await queuedFor(feed, initial.docs);
      const end = () => {
        feed.ended = true;
        if (feeds.get(botId) === feed) feeds.delete(botId);
      };
      feeds.set(botId, feed);
      void watch.closed.then(end);
      try {
        watch.start((value) => enqueueWork(feed, () => onFrame(feed, value.entries, value.docs)));
      } catch (error) {
        // The conversation closed while the feed opened (a pause can): this feed
        // never follows it, so it isn't kept with the state it read.
        end();
        feed.cancel();
        throw error;
      }
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
      if (feed.ended || !feed.projected) return;
      const conversation = await deps.conversation(feed.botId);
      const view = await conversation.context(BACKGROUND_CONTEXT);
      const baseEntries = projectBotTranscript(view.entries, feed.transcriptCheckpoint);
      feed.baseEntries = baseEntries;
      feed.baseEntriesRef = view.entries;
      applyEntries(feed, await resolveCards(feed, baseEntries));
      // These entries came from a fresh read, not the frame, so the next frame projects again.
      feed.projectedFrom = undefined;
    });
  }

  /** Project deferred entries for an attaching subscriber, or refresh pending connect cards on an open feed. */
  function ensureProjected(feed: Feed, alreadyProjectedOnOpen: boolean): Promise<void> {
    return enqueueWork(feed, async () => {
      if (feed.ended) return;
      if (!feed.projected) {
        const projected = await projectFrame(feed, feed.frame.entries);
        feed.entries = projected.entries;
        feed.projected = true;
        feed.projectedFrom = projected.stable ? feed.frame.entries : undefined;
        return;
      }
      if (!alreadyProjectedOnOpen) return;
      if (!deps.connectCardStatus || !awaitsCardStatus(feed.entries)) return;
      const conversation = await deps.conversation(feed.botId);
      const view = await conversation.context(BACKGROUND_CONTEXT);
      const baseEntries = projectBotTranscript(view.entries, feed.transcriptCheckpoint);
      feed.baseEntries = baseEntries;
      feed.baseEntriesRef = view.entries;
      applyEntries(feed, await resolveCards(feed, baseEntries));
      feed.projectedFrom = undefined;
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
    if (hasUiViewers(feed.botId)) return;
    if ((runObservers.get(feed.botId)?.size ?? 0) > 0) return;
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

  /** Read inside the feed queue so an old refresh cannot restore a settled attempt. */
  function syncAccessRequest(feed: Feed): Promise<void> {
    return enqueueWork(feed, async () => {
      const accessRequest = deps.accessRequest?.(feed.botId) ?? null;
      if (accessRequest?.waitId === feed.accessRequest?.waitId) return;
      feed.accessRequest = accessRequest;
      emit(feed, { type: "access_request", accessRequest });
      updateActivity(feed);
    });
  }

  /** Read inside the feed queue so concurrent refreshes cannot restore an older plan. */
  function syncPlan(feed: Feed): Promise<void> {
    return enqueueWork(feed, async () => {
      const plan = await deps.plan?.(feed.botId) ?? null;
      if (plan?.planId === feed.plan?.planId && plan?.revision === feed.plan?.revision) return;
      feed.plan = plan;
      emit(feed, { type: "plan", plan });
      updateActivity(feed);
    });
  }

  /** Whether the person owes this Bot an answer: the same sources the chat shows. */
  async function needsYouNow(botId: string): Promise<boolean> {
    return (
      (deps.question?.(botId) ?? null) !== null ||
      (deps.handoff?.(botId) ?? null) !== null ||
      (deps.accessRequest?.(botId) ?? null) !== null ||
      deps.approvalPending?.(botId) === true ||
      (await deps.plan?.(botId))?.status === "pending" ||
      (await deps.issuePending?.(botId)) === true
    );
  }

  return {
    async subscribe(botId, sink) {
      const subscriber: Subscriber = { sink, pending: [], overflowed: false, scheduled: false, closed: false };
      attachingSubscribers.set(botId, (attachingSubscribers.get(botId) ?? 0) + 1);
      try {
        const hadProjectedFeed = feeds.get(botId)?.projected === true;
        const feed = await openFeed(botId);
        // Project deferred frames on first attach; skip full reproject unless a connect card is pending.
        await ensureProjected(feed, hadProjectedFeed).catch((error) => report(botId, error));
        // A question, hand-off or access request opened or settled while no feed was open is caught up here.
        await syncQuestion(feed).catch((error) => report(botId, error));
        await syncHandoff(feed).catch((error) => report(botId, error));
        await syncAccessRequest(feed).catch((error) => report(botId, error));
        await syncPlan(feed).catch((error) => report(botId, error));
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
            if (live) {
              if (!hasUiViewers(botId)) {
                live.projected = false;
                live.projectedFrom = undefined;
                live.observedEntries = live.frame.entries;
              }
              void closeIfUnwatched(live);
            }
          },
        };
      } finally {
        const remaining = (attachingSubscribers.get(botId) ?? 1) - 1;
        if (remaining <= 0) attachingSubscribers.delete(botId);
        else attachingSubscribers.set(botId, remaining);
      }
    },

    async observeRun(botId, onProgress) {
      const feed = await openFeed(botId);
      await feed.queue;
      let set = runObservers.get(botId);
      if (!set) runObservers.set(botId, (set = new Set()));
      set.add(onProgress);
      return {
        queued: feed.queued.length,
        unsubscribe() {
          const current = runObservers.get(botId);
          current?.delete(onProgress);
          if (current && current.size === 0) runObservers.delete(botId);
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
        (opened) =>
          enqueueWork(opened, async () => {
            // A notice that arrived while the feed opened may be older or newer
            // than the state it read, so neither is trusted: the state is read
            // again now, after every notice so far. A run that ended (or paused,
            // or was interrupted) while it opened is reported settled.
            const latest = await deps.state(botId).catch(() => opened.state);
            setState(opened, latest);
            // A run whose last frame is still to come is reported by that frame
            // or here, whichever is first; a paused run's frame may never come.
            if (state.kind === "running" && latest.kind !== "running" && !opened.settled) {
              opened.settled = true;
              deps.onRunSettled?.(opened.botId, latest);
              void closeIfUnwatched(opened);
            }
          }),
        (error) => {
          // Every notice that joined the same opening sees the same error: the
          // failure is reported once, and a run is settled once if any of them
          // was a running notice, even one that joined behind an idle or paused one.
          let failed = typeof error === "object" && error !== null ? failedOpenings.get(error) : undefined;
          if (!failed) {
            failed = { settling: false };
            if (typeof error === "object" && error !== null) failedOpenings.set(error, failed);
            report(botId, error);
          }
          // A pause can stop the conversation's watch while the feed opens, so
          // the feed never opens; a run that ended meanwhile is still reported.
          if (state.kind !== "running" || failed.settling) return;
          failed.settling = true;
          void deps.state(botId).then(
            (latest) => {
              if (latest.kind !== "running") deps.onRunSettled?.(botId, latest);
            },
            (stateError) => report(botId, stateError),
          );
        },
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
      if (!feed || feed.ended || !feed.projected) return;
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

    async refreshAccessRequest(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await syncAccessRequest(feed);
    },

    async refreshPlan(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) return;
      await syncPlan(feed);
    },

    async needsYou(botId) {
      const feed = feeds.get(botId);
      if (!feed || feed.ended) {
        if ((await deps.state(botId)).kind === "unavailable") return false;
      }
      return needsYouNow(botId);
    },

    async summary(botId) {
      // Read right before each return, so a slow summary never reports a stale wait. It uses the
      // same sources as the chat, so a row agrees with it whether or not a chat is open.
      const feed = feeds.get(botId);
      if (feed && !feed.ended) {
        await feed.queue;
        if (feed.projected) {
          const preview = botTranscriptPreview(feed.entries);
          const lastTurnEnd = botLastTurnEnd(feed.entries);
          return {
            botId,
            preview: preview?.text ?? null,
            updatedAt: preview?.at ?? null,
            state: feed.state,
            needsYou: await needsYouNow(botId),
            lastReplyAt: botLastReplyAt(feed.entries),
            recentReplyAt: botRecentReplyTimes(feed.entries),
            ...(lastTurnEnd ? { lastTurnEnd } : {}),
          };
        }
        const conversation = await deps.conversation(botId);
        const transcript = await transcriptSummary(botId, conversation);
        return {
          botId,
          ...transcript,
          state: feed.state,
          needsYou: await needsYouNow(botId),
        };
      }
      const state = await deps.state(botId);
      if (state.kind === "unavailable") {
        return { botId, preview: null, updatedAt: null, state, needsYou: false, lastReplyAt: null };
      }
      const conversation = await deps.conversation(botId);
      const transcript = await transcriptSummary(botId, conversation);
      return {
        botId,
        ...transcript,
        state,
        needsYou: await needsYouNow(botId),
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
      for (const id of [...runObservers.keys()]) {
        if (botId !== undefined && id !== botId) continue;
        runObservers.delete(id);
      }
      await Promise.all(targets.map(stopFeed));
    },
  };
}

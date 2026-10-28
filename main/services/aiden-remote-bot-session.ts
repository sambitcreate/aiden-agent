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
// - A tool approval the Bot waits on is the snapshot's `approval` and an
//   `approval` frame, in the same order. Phones answer it by `waitId` through
//   the shared `POST /approvals/{id}/respond` route (`respondApproval`),
//   idempotent per request UUID; Computer Use can only be denied from a phone.
// - Contract revision 30 (`bot-activity-v1`): devices holding `bot:activity`
//   also get `activity` (the §5 phase, cut to `{ phase, app?, startedAt }`) and
//   `queued` (the person's waiting messages) in the snapshot and as frames.
//   Other devices get the state they already hold at those seqs. A waiting
//   input shows only once the session classified it as the person's own, so a
//   routine's or the self-intro's prompt never reaches a phone. The person's
//   own messages also carry the `submissionId` they were sent as, so a phone
//   settles its optimistic bubble exactly; other devices never see the key.
// - Contract revision 37 (`bot:handoffs`): devices holding it also get the
//   waiting hand-off (`handoff`, published after `approval`), the `paused`
//   state and the `bot_paused` refusal, and may answer a hand-off, open it on
//   the Mac, and pause or unpause the Bot. Other devices keep the revision-35
//   view: a paused Bot reads as unavailable (writes are `operation_stale`), and
//   a waiting hand-off is an assistant line asking them to go to the Mac. When
//   it settles or another takes its place, they get a snapshot at that seq,
//   which drops the old line from their transcript. The person's answer is
//   their message for everyone. Idempotent results are stored in the holder
//   view and projected per device after the ledger returns.
// - Routines, connection requests and starter presets call their main services.

import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import {
  connectionSuggestionFor,
  type ConnectCardEntry,
  type ConnectCardStatus,
} from "../../renderer/shared/bot-connections.js";
import type { BotPreset } from "../../renderer/shared/bot-presets.js";
import { botHandoffResultLine } from "../../renderer/shared/bot-handoffs.js";
import { BOT_ISSUE_ID_PATTERN } from "../../renderer/shared/bot-issues.js";
import { formatBotRoutineLabel } from "../../renderer/shared/bot-routine-label.js";
import { botRoutineCron } from "../../renderer/shared/bot-routine-schedule.js";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteAttachmentProjection, AidenRemoteAttachmentStore } from "./aiden-remote-attachments.js";
import type { Attachment } from "./types.js";
import type { BotMemoryView } from "../../renderer/shared/bot-memory.js";
import {
  BOT_DAILY_CHECKIN_SUGGESTION,
  botRoutineProposalWhen,
  type BotRoutineProposalRespondInput,
  type BotRoutineProposalRespondResult,
} from "../../renderer/shared/bot-routine-proposals.js";
import type { BotMemoryService } from "./bot-memory/bot-memory-main.js";
import type { BotIssueService } from "./bot-issues/service.js";
import { toRemoteBotIssues } from "./aiden-remote-bot-issues.js";
import {
  AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS,
  AIDEN_REMOTE_BOT_CARD_ENTRY_TYPES,
  AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS,
  AIDEN_REMOTE_BOT_QUEUED_MAX,
  type AidenRemoteBotQueuedMessage,
  type AidenRemoteBotSessionActivity,
  parseAidenRemoteBotMemory,
  parseAidenRemoteBotMemoryEditRequest,
  parseAidenRemoteBotRoutineProposalId,
  parseAidenRemoteBotRoutineProposalRespondRequest,
  parseAidenRemoteBotRoutineSuggestionList,
  type AidenRemoteBotMemory,
  type AidenRemoteBotMemoryEditResponse,
  type AidenRemoteBotRoutineNotificationList,
  type AidenRemoteBotRoutineProposalRespondResult,
  type AidenRemoteBotRoutineSuggestionList,
  AIDEN_REMOTE_BOT_PRESETS_MAX,
  AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES,
  AIDEN_REMOTE_BOT_SESSION_MAX_TEXT_CHARS,
  AIDEN_REMOTE_MAX_SSE_FRAME_BYTES,
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
  parseAidenRemoteBotHandoffAnswerRequest,
  parseAidenRemoteBotHandoffWaitId,
  parseAidenRemoteBotIssueActRequest,
  parseAidenRemoteBotSession,
  parseAidenRemoteEmptyRequest,
  type AidenRemoteBotApproval,
  type AidenRemoteBotHandoff,
  type AidenRemoteBotHandoffAnswerReceipt,
  type AidenRemoteBotHandoffOpenOnMacReceipt,
  type AidenRemoteBotIssue,
  type AidenRemoteBotIssueActReceipt,
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
import type { BotApprovals } from "./bot-runtime/bot-approvals.js";
import type { BotQuestions } from "./bot-runtime/bot-questions.js";
import type { BotHandoffs } from "./bot-runtime/bot-handoffs.js";
import type { BotHandoffOpened } from "./bot-runtime/bot-handoff-open.js";
import type { BotPauseOrigin } from "./bot-pause-store.js";
import {
  LEGACY_AUDIENCE,
  legacyHandoffNotice,
  stateViewForAudience,
  toRemoteBotHandoff,
  type AidenRemoteBotHandoffAudience,
} from "./aiden-remote-bot-handoffs.js";
import { isComputerUseCapabilityTool } from "./bot-tool-authority.js";
import { AidenOperationNotExecutedError } from "./aiden-remote-operation-contract.js";
import { BotSessionError, type BotSessionErrorReason, type BotSessionState } from "./bot-runtime/bot-session-service.js";
import type { BotLiveActivity } from "../../renderer/shared/bot-live.js";
import { stopWithIntents, type BotTurnIntent, type BotTurnIntents } from "./bot-runtime/bot-turn-intents.js";
import {
  liveBotActivity,
  livePartialText,
  liveQueuedMessages,
  liveRunKey,
  createBotRunStarts,
  createQueuedInputClassifier,
  projectBotTranscript,
  type BotRunStarts,
  type QueuedInputClassifier,
} from "./bot-runtime/live-projection.js";
import {
  botRoutineLabel,
  botRoutinePromptOf,
  type BotRoutine,
  type BotRoutineService,
} from "./scheduled-bot-routines.js";

/** Kind of the typed connect card entry `suggest_connection` appends. */
export { BOT_CONNECT_CARD_ENTRY_KIND } from "./bot-runtime/live-projection.js";
const ctx = BACKGROUND_CONTEXT;
/** The transcript window's own cap, applied on top of what the snapshot budget leaves it. */
const MAX_SESSION_JSON_BYTES = 768 * 1_024;
/**
 * Serialized bytes one session snapshot's `session` object may take: the
 * transport's SSE frame limit less a margin for the SSE id and event lines and
 * the frame envelope (`protocolVersion`, `botId`, `epoch`, `seq`, `type`, at most
 * about 1 KB with a 160-scalar `botId`). The snapshot allocates this budget in
 * priority order (see `snapshot`).
 */
const SNAPSHOT_BUDGET_BYTES = AIDEN_REMOTE_MAX_SSE_FRAME_BYTES - 64 * 1_024;
/**
 * Serialized bytes the queued list may take. Oldest items first; the first one
 * that would overflow ends the list, so the rest are left out of the projection
 * (phones keep their own outbox copies). Text is never truncated.
 */
const MAX_QUEUED_JSON_BYTES = 256 * 1_024;
const MAX_PENDING_FRAMES = 256;
const PROJECTOR_IDLE_MS = 60_000;
/** Pause before a failed queued-input classification is tried again (the desktop's throttle). */
const CLASSIFY_RETRY_MS = 1_000;
const WIRE_SUBMISSION_ID = /^[A-Za-z0-9._:-]{1,64}$/u;

export interface AidenRemoteBotSessionRuntime {
  send(
    botId: string,
    /** `whenBusy` while a turn runs: `steer` joins it, `followUp` (the default) runs after it. */
    input: {
      text: string;
      requestId: string;
      whenBusy?: "steer" | "followUp";
      /** Revision 33: the person's images, as the desktop Bot chat sends them. */
      attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
    },
  ): Promise<{ submissionId: string; deduped: boolean }>;
  resume(botId: string, requestId: string): Promise<BotSessionState>;
  dismiss(botId: string, requestId: string): Promise<BotSessionState>;
  /** Ends a running turn (serialized with send/resume/dismiss); a paused turn is left for Dismiss. */
  stop(botId: string): Promise<BotSessionState>;
  /** Revision 37: pause the Bot (idempotent; the first pause's time and origin stay). */
  pause(botId: string, by: BotPauseOrigin): Promise<BotSessionState>;
  /** Revision 37: clear the pause; an interrupted turn then waits for Resume. */
  unpause(botId: string): Promise<BotSessionState>;
  state(botId: string): Promise<BotSessionState>;
  conversation(botId: string): Promise<Conversation>;
  /**
   * For each queued submission id it can find: `true` for a routine's input or
   * the hidden self-intro, `false` for the person's own message. Ids it cannot
   * find are left out (`BotSessionRuntime.quietInputs`).
   */
  quietInputs(botId: string, submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /**
   * The person's own inputs placed in the running turn, by the `pi.user`
   * entry each became (entry id → submission id); never a routine's input or
   * the self-intro (`BotSessionRuntime.placedSubmissions`).
   */
  placedSubmissions(botId: string): Promise<ReadonlyMap<string, string>>;
}

export interface AidenRemoteBotSessionServiceOptions {
  /** The live Bot lookup and the shared idempotency ledger (`AidenRemoteBotService`). */
  bots: {
    /** The Bot service projects and accepts Chat activity (`chatActivity: true`): half of `bot-activity-v1`. */
    readonly supportsChatActivity?: boolean;
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
  /** The Bot's waiting tool approvals (the same bridge the desktop answers through). */
  approvals?: Pick<BotApprovals, "pending" | "decide" | "onChange">;
  /**
   * Revision 37: the Bot's waiting hand-off cards (the same bridge the desktop
   * answers through). With it the host announces `bot:handoffs`.
   */
  handoffs?: Pick<BotHandoffs, "pending" | "get" | "answer" | "onChange">;
  /** Revision 37: bring the hand-off forward on the Mac (`openBotHandoffById(botId, waitId, "phone")`). */
  openHandoffOnMac?(botId: string, waitId: string): Promise<BotHandoffOpened>;
  /**
   * Revision 42: the Bot's host-owned "Needs you" cards (the same service the
   * desktop chat and sidebar read). With it the host announces `bot:issues`
   * and serves the issue act route.
   */
  issues?: Pick<BotIssueService, "list" | "act" | "onChange">;
  /**
   * Hear a Bot's session state change on any surface (`onBotSessionStateChange`);
   * returns the unsubscribe. A pause or unpause on the Mac commits nothing to the
   * conversation, so without it an open stream reads the change only at its next
   * refresh (a holder of `bot:handoffs` as `paused`, any other device as `unavailable`).
   */
  stateChanges?(listener: (botId: string) => void): () => void;
  /**
   * Stop and Resume from any surface (`botTurnIntents`). A phone's Stop is
   * announced here, and taken back if it fails, so open desktop chats read
   * "Stopping" too. Resume is announced by the session itself (`onResumed`).
   * With the Bot service's Chat activity gate it is also revision 30: open
   * streams hear every surface's Stop and Resume (`supportsActivity`).
   */
  turnIntents?: Pick<BotTurnIntents, "announce" | "onIntent">;
  /**
   * A queued input could not be classified (it stays off phones and is
   * retried), or the submission a new message was placed as could not be read
   * (that bubble goes without its id). Each is reported once per failing streak.
   */
  onReport?(botId: string, error: unknown): void;
  /** Pause before a failed classification is retried; defaults to one second. */
  classifyRetryMs?: number;
  /**
   * Staged phone uploads (`bot-attachments-v1`, revision 33): the workspace
   * chats' one-shot store, keyed per Bot so a Bot reference never reaches a chat.
   */
  attachments?: Pick<AidenRemoteAttachmentStore, "upload" | "remove" | "reserve">;
  /**
   * Run start times shared with the desktop live projection (`botRunStarts`):
   * a projector created mid-run, or after the 60 s idle close, keeps the
   * run's start instead of its own creation time. Defaults to this service's own.
   */
  runStarts?: BotRunStarts;
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
  /** Bot memory (`bot-memory-v1`): the same service the desktop Memory page uses. */
  memory?: Pick<BotMemoryService, "view" | "edit">;
  /** Answers to routine proposals (`bot-proactive-v1`); the desktop answers through the same service. */
  proposals?: { respond(input: BotRoutineProposalRespondInput): Promise<BotRoutineProposalRespondResult> };
  /** The Bot routine notification feed (`bot-proactive-v1`). Issue items need `bot:issues` (revision 42). */
  routineNotifications?: {
    list(
      since: number | undefined,
      options?: { issues?: boolean },
    ): Promise<AidenRemoteBotRoutineNotificationList>;
  };
  now?(): number;
  projectorIdleMs?: number;
}

/** A Bot memory view in the wire shape. */
export function projectAidenRemoteBotMemory(view: BotMemoryView): AidenRemoteBotMemory {
  return parseAidenRemoteBotMemory({
    botId: view.botId,
    revision: view.revision,
    readable: view.readable,
    memory: view.memory,
    user: view.user,
    updatedAt: view.updatedAt === null ? null : new Date(view.updatedAt).toISOString(),
  });
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

function isoOf(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : undefined;
}

const wireEntryId = (id: string) => `entry_${id}`;
const WIRE_ENTRY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * A hand-off answer's row is `handoff:<toolCallId>`, and a provider's call id
 * may hold characters (or a length) the wire id grammar refuses. Such an id
 * gets a stable digest instead, so a phone still keys the bubble the same way
 * on every snapshot.
 */
function handoffResultEntryId(rowId: string): string {
  const id = wireEntryId(rowId);
  if (WIRE_ENTRY_ID.test(id)) return id;
  return `entry_handoff_${createHash("sha256").update(rowId).digest("hex").slice(0, 32)}`;
}

/**
 * Displayable wire entries of a conversation, oldest first. Derived from the
 * desktop transcript (`projectBotTranscript`), so a phone shows exactly what
 * the Mac shows: the hidden self-intro prompt and whole `[SILENT]` routine
 * turns are left out, tool traffic stays on the Mac, a failed turn is a typed
 * `failed_turn` entry (with the message Retry resends),
 * and each plugin has one connect card (latest status at the first card's place).
 *
 * `submissions` (revision 30) names the submission each of the person's own
 * messages was sent as, by entry id. Only a `user` message takes one: a
 * routine's input and a question answer never do, whatever the map says.
 */
export function projectBotSessionEntries(
  entries: readonly EntryRecord[],
  submissions: ReadonlyMap<string, string> = new Map(),
): AidenRemoteBotSessionEntry[] {
  const output: AidenRemoteBotSessionEntry[] = [];
  const cards = new Map<string, number>();
  for (const entry of projectBotTranscript(entries)) {
    const id = wireEntryId(entry.id);
    switch (entry.type) {
      case "user":
      case "routine": {
        const createdAt = isoOf(entry.at);
        const label = entry.type === "routine" ? wireText(entry.label, 120).trim() : "";
        const submissionId = entry.type === "user" ? submissions.get(entry.id) : undefined;
        output.push({
          type: "message",
          id,
          role: "user",
          // A routine shows the person's prompt, not its notes block or the silence rule.
          // Photos sent without words read as a caption: phones show no image there.
          text: bounded(entry.type === "routine" ? botRoutinePromptOf(entry.text) : entry.text.trim() ? entry.text : photoCaption(entry.imageCount)),
          ...(createdAt ? { createdAt } : {}),
          ...(label ? { label } : {}),
          ...(submissionId !== undefined && WIRE_SUBMISSION_ID.test(submissionId) ? { submissionId } : {}),
        });
        break;
      }
      case "assistant": {
        const text = entry.text.trim() ? entry.text : "";
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
      case "failed_turn": {
        // The phone shows "I couldn't finish that reply." with Retry; the error stays on the Mac.
        const createdAt = isoOf(entry.at);
        const retryText = entry.retryText === null ? "" : bounded(entry.retryText);
        output.push({
          type: "failed_turn",
          id,
          ...(createdAt ? { createdAt } : {}),
          ...(retryText.trim() ? { retryText } : {}),
        });
        break;
      }
      case "question_answer": {
        // The person's choice on a quick-reply card reads as their message.
        const createdAt = isoOf(entry.at);
        output.push({ type: "message", id, role: "user", text: bounded(entry.text), ...(createdAt ? { createdAt } : {}) });
        break;
      }
      case "handoff_result": {
        // Revision 37, for every device: Done or Skip on a hand-off card reads
        // as the person's message ("You did this: …"), with their note under it.
        const createdAt = isoOf(entry.at);
        const note = entry.note?.trim();
        output.push({
          type: "message",
          id: handoffResultEntryId(entry.id),
          role: "user",
          text: bounded(note ? `${botHandoffResultLine(entry)}\n\n${note}` : botHandoffResultLine(entry)),
          ...(createdAt ? { createdAt } : {}),
        });
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
          // `needs_access` is desktop-only; phones keep offering "Finish on your Mac".
          status: entry.card.status === "needs_access" ? "pending" : entry.card.status,
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
      // Revision 27 cards; `withoutBotCards` removes them for devices without `bot:cards`.
      case "memory_update": {
        const createdAt = isoOf(entry.at);
        output.push({ type: "memory_update", id, ...(createdAt ? { createdAt } : {}) });
        break;
      }
      case "routine_proposal": {
        // A card the Bot revised is replaced by the next one; phones show only that.
        if (entry.supersededBy !== undefined) break;
        const createdAt = isoOf(entry.at);
        const { proposal } = entry;
        output.push({
          type: "routine_proposal",
          id,
          proposalId: proposal.proposalId,
          name: wireText(proposal.name, 120).trim() || "Routine",
          prompt: bounded(proposal.prompt).trim() || proposal.name,
          // The card's own "when": a schedule with its timezone, or what starts it.
          label: wireText(botRoutineProposalWhen(proposal), 120).trim() || (proposal.trigger ? "When something happens" : "On a schedule"),
          status: entry.status,
          ...(entry.status === "accepted" && entry.routineId ? { routineId: wireText(entry.routineId, 160) } : {}),
          ...(createdAt ? { createdAt } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return output;
}

/** The entries a device without `bot:cards` may see: revision-26 parsers throw on the card types. */
export function withoutBotCards(entries: readonly AidenRemoteBotSessionEntry[]): AidenRemoteBotSessionEntry[] {
  return entries.filter(
    (entry) => !(AIDEN_REMOTE_BOT_CARD_ENTRY_TYPES as readonly string[]).includes(entry.type),
  );
}

/** The entry a device without `bot:activity` may see: shipped phones decode message keys strictly. */
function withoutSubmissionId(entry: AidenRemoteBotSessionEntry): AidenRemoteBotSessionEntry {
  if (entry.type !== "message" || entry.submissionId === undefined) return entry;
  const { submissionId: _submissionId, ...rest } = entry;
  return rest;
}

/** The entries one device is sent: cards for `bot:cards`, submission ids for `bot:activity`. */
function entriesFor(entries: readonly AidenRemoteBotSessionEntry[], audience: Audience): AidenRemoteBotSessionEntry[] {
  const shown = audience.cards ? [...entries] : withoutBotCards(entries);
  return audience.activity ? shown : shown.map(withoutSubmissionId);
}

/** Text of the in-flight (or paused) assistant partial, if any. A reply heading for `[SILENT]` is never shown. */
export function projectBotSessionPartial(view: Pick<ConversationView, "docs">): string | undefined {
  const text = livePartialText(view.docs);
  return text ? bounded(text) : undefined;
}

/** The §11 allow-list, picked by name: nothing from the step crosses the wire. */
export function projectBotSessionActivity(
  live: Pick<BotLiveActivity, "phase" | "app" | "startedAt">,
): AidenRemoteBotSessionActivity {
  const app = live.phase === "app" && live.app
    ? wireText(live.app, AIDEN_REMOTE_BOT_ACTIVITY_APP_MAX_CHARS).trim()
    : "";
  return {
    phase: live.phase,
    ...(app ? { app } : {}),
    startedAt: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(live.startedAt))),
  };
}

/**
 * The person's waiting messages, oldest first: only inputs in `personal`
 * (classified as the person's own) show, so an input not yet classified stays
 * off the wire. A photo with no words has no text to show and is left out.
 * The list keeps the oldest items whose serialized bytes fit
 * `MAX_QUEUED_JSON_BYTES`, in order, and omits the rest.
 */
export function projectBotSessionQueued(
  docs: Readonly<Record<string, unknown>>,
  personal: ReadonlySet<string>,
): AidenRemoteBotQueuedMessage[] {
  const seen = new Set<string>();
  const valid: AidenRemoteBotQueuedMessage[] = [];
  for (const message of liveQueuedMessages(docs, personal)) {
    const text = wireText(message.text, AIDEN_REMOTE_BOT_MESSAGE_MAX_CHARS);
    if (!text.trim() || !WIRE_SUBMISSION_ID.test(message.submissionId) || seen.has(message.submissionId)) continue;
    seen.add(message.submissionId);
    valid.push({ submissionId: message.submissionId, mode: message.mode === "steer" ? "steer" : "queue", text });
    if (valid.length === AIDEN_REMOTE_BOT_QUEUED_MAX) break;
  }
  return oldestThatFit(valid, MAX_QUEUED_JSON_BYTES);
}

/**
 * The oldest items whose serialized JSON array fits `budgetBytes`, in order. The
 * first item that would overflow ends the list, so the rest are omitted; an item
 * is never cut.
 */
function oldestThatFit<Item>(items: readonly Item[], budgetBytes: number): Item[] {
  const kept: Item[] = [];
  let bytes = 2; // the brackets
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + size > budgetBytes) break;
    kept.push(item);
    bytes += size;
  }
  return kept;
}

/** The serialized bytes of a JSON string's content: its quotes excluded, its escapes counted as written. */
function jsonContentBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * The longest tail of `text`, cut on a code-point boundary, whose JSON string
 * content fits `budgetBytes`. Text that fits is returned whole; otherwise its
 * front is cut, so a phone keeps the newest streamed words.
 */
export function tailWithinJsonBytes(text: string, budgetBytes: number): string {
  if (jsonContentBytes(text) <= budgetBytes) return text;
  const points = [...text];
  let bytes = 0;
  let start = points.length;
  while (start > 0) {
    const size = jsonContentBytes(points[start - 1]!);
    if (bytes + size > budgetBytes) break;
    bytes += size;
    start -= 1;
  }
  return points.slice(start).join("");
}

/** The serialized bytes one `"key":value` member adds to a JSON object, its separating comma included. */
function memberBytes(key: string, value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ [key]: value }), "utf8") - 1;
}

/**
 * A session state on the wire. Revision 37: a device holding `bot:handoffs`
 * sees a person's pause as `paused`; every other device as `unavailable`.
 */
export function projectBotSessionState(
  state: BotSessionState,
  audience: AidenRemoteBotHandoffAudience = LEGACY_AUDIENCE,
): AidenRemoteBotSessionStateView {
  if (state.kind === "interrupted") {
    return { state: "interrupted", interrupted: true, ...(state.blocked ? { blocked: state.blocked } : {}) };
  }
  // A model that exists but cannot run right now is `unavailable` on the wire;
  // its message stays on the Mac.
  if (state.kind === "model_error") return { state: "unavailable", interrupted: false };
  // Shipped phones decode a closed set of states: a Bot the person paused
  // reads as unavailable to them (plan §7.2), and its writes are refused.
  if (state.kind === "paused") {
    return audience.handoffs ? { state: "paused", interrupted: false } : { state: "unavailable", interrupted: false };
  }
  return { state: state.kind as AidenRemoteBotSessionStateKind, interrupted: false };
}

/**
 * The newest entries that fit the transcript's share of the snapshot: at most
 * `budgetBytes` of serialized entries and `MAX_SESSION_JSON_BYTES`. An entry
 * that cannot fit is left out (`hasOlder`), never cut, so the snapshot stays
 * inside the frame limit whatever else it carries.
 */
function windowed(
  entries: AidenRemoteBotSessionEntry[],
  budgetBytes: number,
): { entries: AidenRemoteBotSessionEntry[]; hasOlder: boolean } {
  const limit = Math.min(MAX_SESSION_JSON_BYTES, budgetBytes);
  let start = Math.max(0, entries.length - AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES);
  let window = entries.slice(start);
  while (window.length > 0 && Buffer.byteLength(JSON.stringify(window), "utf8") > limit) {
    start = Math.min(entries.length, start + Math.max(1, Math.floor(window.length / 4)));
    window = entries.slice(start);
  }
  return { entries: window, hasOlder: start > 0 };
}

// ---------------------------------------------------------------------------
// Live projector: one per Bot, shared by every client.
// ---------------------------------------------------------------------------

/** What one device opted into. It changes what the device is sent, never what it may do. */
interface Audience {
  /** `bot:cards`: memory and routine proposal entries (revision 27). */
  cards: boolean;
  /** `bot:activity`: the `activity` and `queued` frames and snapshot keys (revision 30). */
  activity: boolean;
  /** `bot:handoffs`: the `handoff` frame and snapshot key, and the `paused` state (revision 37). */
  handoffs: boolean;
  /** `bot:handoff-notes` beside it: a card that takes no note says so (revision 40). */
  notes: boolean;
  /** `bot:handoff-on-mac` beside it: a step on the Bot's own screen says so (revision 43). */
  onMac: boolean;
  /** `bot:issues`: the `issues` frame and snapshot key (revision 42). */
  issues: boolean;
}

/**
 * A hand-off as `audience` reads it: `takesNote` only for a device that holds
 * `bot:handoff-notes`, and `onMac` only for one that holds
 * `bot:handoff-on-mac`. Earlier decoders are closed and reject the keys.
 */
function handoffForAudience(handoff: AidenRemoteBotHandoff | null, audience: Audience): AidenRemoteBotHandoff | null {
  if (handoff === null) return handoff;
  const { takesNote, onMac, ...card } = handoff;
  return {
    ...card,
    ...(takesNote !== undefined && audience.notes ? { takesNote } : {}),
    ...(onMac !== undefined && audience.onMac ? { onMac } : {}),
  };
}

interface Subscriber extends Audience {
  frames: string[];
  handle?: CursorSseHandle;
  overflowed: boolean;
}

/** Frames only `bot:activity` devices can parse. */
const ACTIVITY_FRAME_TYPES: ReadonlySet<string> = new Set(["activity", "queued"]);

/** The Bot's waiting hand-off for both kinds of device (revision 37). */
interface ProjectedHandoff {
  /** What a `bot:handoffs` device is sent. */
  handoff: AidenRemoteBotHandoff;
  /** What every other device shows instead: an assistant line pointing to the Mac. */
  notice: AidenRemoteBotSessionEntry;
}

/** What a projector needs to project revision 30; absent on hosts without `bot-activity-v1`. */
interface ProjectorActivity {
  /** `AidenRemoteBotSessionRuntime.quietInputs` for this Bot. */
  classify(submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** `AidenRemoteBotSessionRuntime.placedSubmissions` for this Bot. */
  placed(): Promise<ReadonlyMap<string, string>>;
  now(): number;
  /** Shared with the desktop feed: a projector opened mid-run keeps the run's start. */
  runStarts: BotRunStarts;
  retryMs: number;
  report(error: unknown): void;
}

class BotLiveProjector {
  readonly epoch = `epoch_${randomUUID().replace(/-/gu, "")}`;
  seq = 0;
  entries: AidenRemoteBotSessionEntry[] = [];
  partial: string | undefined;
  /** The state as a `bot:handoffs` device sees it; other devices get `stateViewForAudience` of it. */
  state: AidenRemoteBotSessionStateView = { state: "idle", interrupted: false };
  question: AidenRemoteBotQuestion | null = null;
  approval: AidenRemoteBotApproval | null = null;
  /** The waiting hand-off (revision 37), with the line devices without `bot:handoffs` show for it. */
  handoff: ProjectedHandoff | null = null;
  /** The Bot's issue cards (revision 42), oldest first; only `bot:issues` devices are sent them. */
  issues: AidenRemoteBotIssue[] = [];
  /** What the running turn is doing, in the §11 shape; null while no turn runs. */
  activity: AidenRemoteBotSessionActivity | null = null;
  /** The person's messages waiting for the running turn. */
  queued: AidenRemoteBotQueuedMessage[] = [];
  readonly subscribers = new Set<Subscriber>();
  private view: ConversationView | undefined;
  private stopWatch: (() => Promise<unknown>) | undefined;
  private lane: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the current run started, on this Mac's clock. */
  private runStartedAt = 0;
  /** Identity of the current run (`liveRunKey`): a queued follow-up replaces the run while the state stays running. */
  private runKey: string | null = null;
  /** Stop was pressed during this run. */
  private stopping = false;
  /** A Stop was heard; it applies only if the published state is running. */
  private stopRequested = false;
  /** This run is a Resume and has not moved on yet. */
  private resuming = false;
  /** `pi.live` when the Resume was heard, serialized once (`BotLiveActivityInput.resumedFrom`). */
  private resumedFrom: string | undefined;
  /** The session resumed: the run it publishes as running reads "Picking up where it left off". */
  private resumeRequested = false;
  /** Which queued inputs are the person's own (the desktop feed's classifier). */
  private readonly classifier: QueuedInputClassifier | undefined;
  /**
   * Entry id → submission id of the person's messages placed while this
   * projector lived. A finished turn's submission drops out of the session,
   * but its bubble keeps the id while it is in view, so a reconnect snapshot
   * still names it. Pruned to the entries in the session window, so it stays
   * bounded by that window.
   */
  private readonly submissionOf = new Map<string, string>();
  /** The newest `pi.user` entry already looked up, so each message is asked about once. */
  private placedThrough = -1;
  /** The last placement lookup failed: a failing streak is reported once. */
  private placedFailing = false;
  closed = false;

  constructor(
    readonly botId: string,
    private readonly readState: () => Promise<AidenRemoteBotSessionStateView>,
    private readonly resolveEntries: (entries: AidenRemoteBotSessionEntry[]) => Promise<AidenRemoteBotSessionEntry[]>,
    private readonly idleMs: number,
    private readonly onClosed: () => void,
    private readonly readQuestion: () => AidenRemoteBotQuestion | null = () => null,
    private readonly readApproval: () => AidenRemoteBotApproval | null = () => null,
    /** Revision 30; without it nothing is derived and no activity or queued frame is ever sent. */
    private readonly activityDeps?: ProjectorActivity,
    /** Revision 37; without it no hand-off is ever projected. */
    private readonly readHandoff: () => Promise<ProjectedHandoff | null> = async () => null,
    /** Revision 42; without it no issue card is ever projected. */
    private readonly readIssues?: () => Promise<AidenRemoteBotIssue[]>,
  ) {
    this.classifier = activityDeps
      ? createQueuedInputClassifier({
          classify: (ids) => activityDeps.classify(ids),
          now: () => activityDeps.now(),
          retryMs: activityDeps.retryMs,
          report: (error) => activityDeps.report(error),
          // One retry after the pause, on the serial lane, even if no frame arrives.
          retry: () => {
            void this.serial(async () => {
              if (!this.closed && this.view) await this.publish(this.view);
            });
          },
        })
      : undefined;
  }

  async attach(conversation: Conversation): Promise<void> {
    const watch = await conversation.watch(ctx);
    this.stopWatch = () => watch.stop();
    this.view = watch.value;
    this.entries = await this.resolveEntries(
      projectBotSessionEntries(watch.value.entries, await this.submissionsFor(watch.value.entries)),
    );
    this.pruneSubmissions(this.entries);
    this.partial = projectBotSessionPartial(watch.value);
    this.state = await this.readState();
    this.question = this.readQuestion();
    this.approval = this.readApproval();
    this.handoff = await this.readHandoff();
    this.issues = (await this.readIssues?.()) ?? [];
    if (this.activityDeps) {
      this.trackRun({ state: "idle", interrupted: false }, this.state, watch.value.docs);
      this.activity = this.deriveActivity(
        watch.value,
        this.state,
        this.question !== null || this.approval !== null || this.handoff !== null,
      );
      this.queued = await this.queuedFor(watch.value.docs);
    }
    watch.start(async (view) => {
      await this.advance(view);
    });
    void watch.closed.then(() => this.close(), () => this.close());
    this.armIdle();
  }

  /**
   * The session as one device sees it, inside the snapshot budget by
   * construction. Parts are allocated in priority order:
   *  1. identity, state, question, approval, hand-off and activity ship whole
   *     (measured first; their protocol maxima sit well under half the budget);
   *  2. the partial, cut to its tail if it no longer fits;
   *  3. the queued list, oldest first, at most `MAX_QUEUED_JSON_BYTES` and what is left;
   *  4. the transcript window, with whatever is left (possibly none).
   */
  snapshot(audience: Audience): AidenRemoteBotSession {
    const showActivity = audience.activity && this.activityDeps !== undefined;
    const state = stateViewForAudience(this.state, audience);
    const handoff = handoffForAudience(this.handoff?.handoff ?? null, audience);
    let used = 2 + memberBytes("botId", this.botId) + memberBytes("epoch", this.epoch) + memberBytes("seq", this.seq);
    for (const [key, value] of Object.entries(state)) used += memberBytes(key, value);
    used += memberBytes("question", this.question) + memberBytes("approval", this.approval);
    if (audience.handoffs) used += memberBytes("handoff", handoff);
    if (audience.issues) used += memberBytes("issues", this.issues);
    if (showActivity) used += memberBytes("activity", this.activity);

    let partial: string | undefined;
    if (this.partial !== undefined) {
      partial = tailWithinJsonBytes(this.partial, SNAPSHOT_BUDGET_BYTES - used - memberBytes("partial", ""));
      used += memberBytes("partial", partial);
    }

    let queued: AidenRemoteBotQueuedMessage[] | undefined;
    if (showActivity) {
      // "[]" is already counted in the member's empty form, hence the + 2.
      const arrayBudget = SNAPSHOT_BUDGET_BYTES - used - memberBytes("queued", []) + 2;
      queued = oldestThatFit(this.queued, Math.min(MAX_QUEUED_JSON_BYTES, arrayBudget));
      used += memberBytes("queued", queued);
    }

    // The transcript's members are reserved empty; `hasOlder` takes its larger, `false`, form.
    const transcriptBudget =
      SNAPSHOT_BUDGET_BYTES - used - memberBytes("entries", []) - memberBytes("hasOlder", false) + 2;
    const shown = entriesFor(this.entries, audience);
    // Without `bot:handoffs`, a waiting hand-off is the newest line of the chat.
    if (!audience.handoffs && this.handoff) shown.push(this.handoff.notice);
    const { entries, hasOlder } = windowed(shown, transcriptBudget);
    return parseAidenRemoteBotSession({
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...state,
      ...(partial !== undefined ? { partial } : {}),
      entries,
      hasOlder,
      question: this.question,
      approval: this.approval,
      ...(showActivity ? { activity: this.activity, queued } : {}),
      ...(audience.handoffs ? { handoff } : {}),
      ...(audience.issues ? { issues: this.issues } : {}),
    });
  }

  /** The `snapshot` frame for the current seq (first frame of a stream, or a history rewrite). */
  snapshotFrame(audience: Audience): string {
    const session = this.snapshot(audience);
    return sseFrame(`${session.epoch}:${session.seq}`, "snapshot", {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: session.botId,
      epoch: session.epoch,
      seq: session.seq,
      type: "snapshot",
      payload: { session },
    });
  }

  /** Renders a frame once per kind of audience and queues it for every subscriber. */
  private broadcast(render: (audience: Audience) => string): void {
    const rendered = new Map<string, string>();
    for (const subscriber of this.subscribers) {
      if (subscriber.frames.length >= MAX_PENDING_FRAMES) {
        // A stalled client is dropped; it reconnects and gets a fresh snapshot.
        subscriber.overflowed = true;
      } else {
        const key = `${subscriber.cards}:${subscriber.activity}:${subscriber.handoffs}:${subscriber.notes}:${subscriber.onMac}:${subscriber.issues}`;
        let text = rendered.get(key);
        if (text === undefined) {
          text = render(subscriber);
          rendered.set(key, text);
        }
        subscriber.frames.push(text);
      }
      subscriber.handle?.wake();
    }
  }

  /**
   * `legacy` (revision 37, `handoff` frames only): what a device without
   * `bot:handoffs` gets at this seq instead. A hand-off that opens with none
   * shown before it is an entry frame with its line. Once a line is shown, a
   * hand-off that settles or gives way to another is `"snapshot"`: shipped
   * clients have no frame that removes an entry, and a snapshot replaces their
   * whole transcript, so the old line goes and a replacement's line is the
   * newest entry, as a fresh read shows it.
   */
  private frame(
    event: Omit<AidenRemoteBotSessionEvent, "protocolVersion" | "botId" | "epoch" | "seq">,
    legacy?: AidenRemoteBotSessionEntry | "snapshot",
  ): void {
    this.seq += 1;
    const data = {
      protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
      botId: this.botId,
      epoch: this.epoch,
      seq: this.seq,
      ...event,
    };
    const id = `${this.epoch}:${this.seq}`;
    const text = sseFrame(id, event.type, data);
    const card =
      event.type === "entry" &&
      (AIDEN_REMOTE_BOT_CARD_ENTRY_TYPES as readonly string[]).includes(
        (event.payload as { entry?: { type?: string } }).entry?.type ?? "",
      );
    const activityOnly = ACTIVITY_FRAME_TYPES.has(event.type);
    const handoffOnly = event.type === "handoff";
    const issuesOnly = event.type === "issues";
    // A frame a device can't parse (a card entry before revision 27, an
    // activity or queued frame without `bot:activity`, a hand-off without
    // `bot:handoffs`) must still reach it as its seq: clients refetch on any
    // gap. That device gets the state it already holds under that seq
    // instead, which changes nothing it shows.
    const noOp = (audience: Audience) =>
      sseFrame(id, "state", { ...data, type: "state", payload: stateViewForAudience(this.state, audience) });
    // A bubble tagged with its submission id reaches other devices without the key.
    const entry = event.type === "entry" ? (event.payload as { entry: AidenRemoteBotSessionEntry }).entry : undefined;
    const bare = entry && withoutSubmissionId(entry);
    const untagged = bare && bare !== entry ? sseFrame(id, "entry", { ...data, payload: { entry: bare } }) : text;
    this.broadcast((audience) => {
      if ((card && !audience.cards) || (activityOnly && !audience.activity)) return noOp(audience);
      if (issuesOnly && !audience.issues) return noOp(audience);
      if (handoffOnly && !audience.handoffs) {
        if (legacy === "snapshot") return this.snapshotFrame(audience);
        return legacy ? sseFrame(id, "entry", { ...data, type: "entry", payload: { entry: legacy } }) : noOp(audience);
      }
      if (handoffOnly) {
        const handoff = (event.payload as { handoff: AidenRemoteBotHandoff | null }).handoff;
        const shown = handoffForAudience(handoff, audience);
        return shown === handoff ? text : sseFrame(id, "handoff", { ...data, payload: { handoff: shown } });
      }
      if (event.type === "state" && !audience.handoffs) {
        const payload = stateViewForAudience(event.payload as AidenRemoteBotSessionStateView, audience);
        return payload === event.payload ? text : sseFrame(id, "state", { ...data, payload });
      }
      return audience.activity ? text : untagged;
    });
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

  /**
   * Stop, a Stop that failed, or a Resume the session carried out, from any
   * surface. A Stop applies only if the state it publishes with is running,
   * so a Stop with nothing running changes nothing.
   */
  noteIntent(intent: BotTurnIntent): Promise<void> {
    return this.serial(async () => {
      if (!this.activityDeps) return;
      if (intent === "stopping") this.stopRequested = true;
      else if (intent === "stopCancelled") {
        this.stopRequested = false;
        this.stopping = false;
      } else this.resumeRequested = true;
      if (this.view) await this.publish(this.view);
    });
  }

  /**
   * Scope Stop, Resume and the start time to one run, like the desktop feed: a
   * run starts when the state turns running or when a queued follow-up
   * replaces the run (a new `liveRunKey`) while it stays running.
   */
  private trackRun(
    previous: AidenRemoteBotSessionStateView,
    next: AidenRemoteBotSessionStateView,
    docs: Readonly<Record<string, unknown>>,
  ): void {
    const runKey = liveRunKey(docs);
    const deps = this.activityDeps!;
    if (next.state === "running") {
      const replaced = runKey !== null && this.runKey !== null && runKey !== this.runKey;
      if (previous.state !== "running" || replaced) {
        this.stopping = false;
        this.resuming = false;
      }
      // Asked on every running frame, so the run's key is recorded as soon as
      // it shows. Not the attach time: a phone that opens mid-run sees how long
      // the run has really gone, and a replaced run gets its own start.
      this.runStartedAt = deps.runStarts.startedAt(this.botId, runKey, () => deps.now());
      if (this.resumeRequested) {
        this.resumeRequested = false;
        this.resuming = true;
        this.resumedFrom = JSON.stringify(docs["pi.live"]);
      }
      if (this.stopRequested) this.stopping = true;
    } else {
      this.stopping = false;
      this.resuming = false;
      deps.runStarts.ended(this.botId);
      // A Resume is heard before the session publishes the run it resumed, so a
      // paused state still on its way out keeps it; any other state ends it.
      if (next.state !== "interrupted") this.resumeRequested = false;
    }
    this.stopRequested = false;
    this.runKey = runKey;
  }

  /** Slice B's derivation from `pi.live`, cut to the wire. A paused Bot keeps `pi.live.run` but is not working. */
  private deriveActivity(
    view: ConversationView,
    state: AidenRemoteBotSessionStateView,
    waiting: boolean,
  ): AidenRemoteBotSessionActivity | null {
    if (state.state !== "running") return null;
    const live = liveBotActivity({
      entries: view.entries,
      docs: view.docs,
      waiting,
      stopping: this.stopping,
      resuming: this.resuming,
      resumedFrom: this.resumedFrom,
      startedAt: this.runStartedAt,
    }) ?? { phase: "preparing" as const, startedAt: this.runStartedAt };
    if (live.phase !== "resuming") this.resuming = false;
    return projectBotSessionActivity(live);
  }

  /**
   * The person's queued messages (the desktop's `queuedFor`): an id not yet
   * known to be the person's stays off the wire (fail closed), so a routine's
   * prompt never shows as their message.
   */
  private async queuedFor(docs: Readonly<Record<string, unknown>>): Promise<AidenRemoteBotQueuedMessage[]> {
    return projectBotSessionQueued(docs, await this.classifier!.personal(docs));
  }

  /**
   * The submission ids of the person's messages, by entry id (revision 30).
   * Looked up on the serial lane when a new `pi.user` entry appears: its input
   * is placed in the same commit, so the session still lists it unless its
   * turn already ended. An id that can't be found is left out; phones then
   * match the bubble by its text.
   */
  private async submissionsFor(entries: readonly EntryRecord[]): Promise<ReadonlyMap<string, string>> {
    if (!this.activityDeps) return this.submissionOf;
    let newest = this.placedThrough;
    for (const record of entries) {
      if (record.kind === "pi.user" && Number(record.id) > newest) newest = Number(record.id);
    }
    if (newest <= this.placedThrough) return this.submissionOf;
    this.placedThrough = newest;
    let placed: ReadonlyMap<string, string>;
    try {
      placed = await this.activityDeps.placed();
      this.placedFailing = false;
    } catch (error) {
      // The field is optional: without it the phone matches this bubble by its text.
      if (!this.placedFailing) this.activityDeps.report(error);
      this.placedFailing = true;
      return this.submissionOf;
    }
    for (const [entryId, submissionId] of placed) {
      if (WIRE_SUBMISSION_ID.test(submissionId)) this.submissionOf.set(entryId, submissionId);
    }
    return this.submissionOf;
  }

  /** How many bubble tags this projector holds (the memo's size, for tests of its bound). */
  get submissionTagCount(): number {
    return this.submissionOf.size;
  }

  /** Forget the ids of bubbles that left the session window: no snapshot can show them again. */
  private pruneSubmissions(entries: readonly AidenRemoteBotSessionEntry[]): void {
    if (this.submissionOf.size === 0) return;
    // Either window: a device without `bot:cards` sees further back past the cards it skips.
    const inView = new Set(
      [...entries.slice(-AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES), ...withoutBotCards(entries).slice(-AIDEN_REMOTE_BOT_SESSION_MAX_ENTRIES)]
        .map((entry) => entry.id),
    );
    for (const entryId of [...this.submissionOf.keys()]) {
      if (!inView.has(wireEntryId(entryId))) this.submissionOf.delete(entryId);
    }
  }

  /**
   * `snapshotChanges` sends any changed entry as a fresh snapshot instead of an
   * entry event: a refresh can touch an old entry outside a phone's window,
   * which an entry event would append at the bottom of its chat.
   */
  private async publish(view: ConversationView, { snapshotChanges = false } = {}): Promise<void> {
    if (this.closed) return;
    const next = await this.resolveEntries(projectBotSessionEntries(view.entries, await this.submissionsFor(view.entries)));
    const partial = projectBotSessionPartial(view);
    const state = await this.readState().catch(() => this.state);
    const question = this.readQuestion();
    const approval = this.readApproval();
    const handoff = await this.readHandoff();
    const issues = this.readIssues ? await this.readIssues().catch(() => this.issues) : [];
    const queued = this.activityDeps ? await this.queuedFor(view.docs) : [];
    if (this.closed) return;
    let activity: AidenRemoteBotSessionActivity | null = null;
    if (this.activityDeps) {
      this.trackRun(this.state, state, view.docs);
      activity = this.deriveActivity(view, state, question !== null || approval !== null || handoff !== null);
    }

    const previous = this.entries;
    this.pruneSubmissions(next);
    // A bubble's tag is set when it first shows and only dropped once it leaves
    // the window, so a tag change alone is never news: re-sending an old bubble
    // would make phones that no longer hold it append it at the bottom.
    const previousById = new Map(previous.map((entry) => [entry.id, JSON.stringify(withoutSubmissionId(entry))]));
    const nextIds = new Set(next.map((entry) => entry.id));
    // Appends and in-place updates are entry events; anything that removes or
    // reorders shown history (a `[SILENT]` routine turn hiding its input) is a snapshot.
    const kept = previous.filter((entry) => nextIds.has(entry.id)).map((entry) => entry.id);
    const order = next.filter((entry) => previousById.has(entry.id)).map((entry) => entry.id);
    const rewritten =
      kept.length !== previous.length ||
      kept.some((id, index) => order[index] !== id) ||
      (snapshotChanges && next.some((entry) => previousById.get(entry.id) !== JSON.stringify(withoutSubmissionId(entry))));

    this.entries = next;
    if (rewritten) {
      this.partial = partial;
      this.state = state;
      this.question = question;
      this.approval = approval;
      this.handoff = handoff;
      this.activity = activity;
      this.queued = queued;
      this.issues = issues;
      this.seq += 1;
      this.broadcast((audience) => this.snapshotFrame(audience));
      return;
    }
    for (const entry of next) {
      if (previousById.get(entry.id) === JSON.stringify(withoutSubmissionId(entry))) continue;
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
    if (approval?.waitId !== this.approval?.waitId) {
      this.approval = approval;
      this.frame({ type: "approval", payload: { approval } });
    }
    if (handoff?.handoff.waitId !== this.handoff?.handoff.waitId) {
      // Every device without `bot:handoffs` holds the line of the hand-off this replaces.
      const shown = this.handoff !== null;
      this.handoff = handoff;
      this.frame({ type: "handoff", payload: { handoff: handoff?.handoff ?? null } }, shown ? "snapshot" : handoff?.notice);
    }
    // After the state frame, so a phone never sees a phase for a turn that already ended.
    if (JSON.stringify(activity) !== JSON.stringify(this.activity)) {
      this.activity = activity;
      this.frame({ type: "activity", payload: { activity } });
    }
    if (JSON.stringify(queued) !== JSON.stringify(this.queued)) {
      this.queued = queued;
      this.frame({ type: "queued", payload: { queued } });
    }
    if (JSON.stringify(issues) !== JSON.stringify(this.issues)) {
      this.issues = issues;
      this.frame({ type: "issues", payload: { issues } });
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

  /** Re-reads the transcript's connect cards, so one finished on the Mac shows Connected. */
  refreshCards(): Promise<void> {
    return this.serial(async () => {
      if (!this.closed && this.view) await this.publish(this.view, { snapshotChanges: true });
    });
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
    this.classifier?.close();
    this.frame({ type: "closed", payload: {} });
    this.onClosed();
    await this.stopWatch?.().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** A waiting Bot approval as phones see it. */
function wireApproval(prompt: { waitId: string; toolCallId: string; toolName: string; summary: string }): AidenRemoteBotApproval {
  return {
    waitId: prompt.waitId,
    toolCallId: wireText(prompt.toolCallId, 128),
    toolName: wireText(prompt.toolName, 120),
    summary: wireText(prompt.summary, 2_000) || "Aiden needs approval.",
    // Computer Use acts on the Mac's screen: it is allowed there, never from a phone.
    canAllow: !isComputerUseCapabilityTool(prompt.toolName),
  };
}

/**
 * Refusals the session makes from its state before it changes anything: no
 * host, no model (or one that can't run), or a paused turn a send won't
 * replace. Each is checked before any input is written or any run resumes.
 */
const REFUSED_BEFORE_RUNNING: ReadonlySet<BotSessionErrorReason> = new Set([
  "needs_model",
  "model_error",
  "unavailable",
  "bot_paused",
  "paused_by_person",
]);

/**
 * Runs one session call inside an idempotent request. A refusal from state
 * leaves no record in the operation ledger, so the same key is evaluated
 * again once the Bot is fixed (a model chosen, the Bot resumed) instead of
 * replaying the refusal for a day.
 */
async function unlessRefusedBeforeRunning<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BotSessionError && REFUSED_BEFORE_RUNNING.has(error.reason)) {
      throw new AidenOperationNotExecutedError(error);
    }
    throw error;
  }
}

/**
 * Runs the check-then-answer body of an answer request (a question, an
 * approval or a hand-off). Every refusal it throws comes before the answer
 * lands and changes nothing: the card or question stopped waiting, or it
 * doesn't take that answer. The ledger forgets the request instead of
 * recording a refusal it can only replay as `internal_error`, so a retry with
 * the same request UUID is checked again and gets the same refusal.
 */
async function answerOrRefuseUnchanged<Result>(answer: () => Promise<Result>): Promise<Result> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof AidenRemoteServiceError) throw new AidenOperationNotExecutedError(error);
    throw error;
  }
}

/**
 * A session refusal as one device is told it. A person's pause is
 * `bot_paused` for a device holding `bot:handoffs` (revision 37) and
 * `operation_stale`, a code shipped clients already know, for every other.
 */
function mapSessionError(error: unknown, audience: AidenRemoteBotHandoffAudience = LEGACY_AUDIENCE): never {
  // A ledger always unwraps it; a bare `executeIdempotent` passes it through.
  if (error instanceof AidenOperationNotExecutedError) return mapSessionError(error.cause, audience);
  if (error instanceof AidenRemoteServiceError) throw error;
  if (error instanceof BotSessionError) {
    switch (error.reason) {
      case "bot_missing":
      case "bot_deleted":
        throw new AidenRemoteServiceError("not_found", "This Bot no longer exists.", 404);
      case "access_changed":
        throw new AidenRemoteServiceError("capability_denied", error.message, 403);
      case "paused_by_person":
        if (audience.handoffs) throw new AidenRemoteServiceError("bot_paused", error.message, 409);
        throw new AidenRemoteServiceError("operation_stale", error.message, 409);
      case "needs_model":
      case "model_error":
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
/** What a photo-only message reads as on a phone, which draws no image in its transcript. */
function photoCaption(imageCount: number | undefined): string {
  if (!imageCount) return "";
  return imageCount === 1 ? "Sent a photo" : `Sent ${imageCount} photos`;
}

/**
 * The store key for a Bot's staged uploads. A `/` never appears in a chat id,
 * so a Bot's references can't be spent in a workspace chat or the other way round.
 */
function botAttachmentScope(botId: string): string {
  return `bots/${botId}`;
}

function botImageAttachments(attachments: readonly Attachment[]): Array<{ type: "image"; mimeType: string; data: string }> {
  return attachments
    .filter((attachment) => attachment.kind === "image" && attachment.data)
    .map((attachment) => ({ type: "image" as const, mimeType: attachment.mimeType, data: attachment.data! }));
}

/** Text files follow the words the way the desktop Bot chat sends them: name, then contents. */
export function botMessageText(text: string, attachments: readonly Attachment[]): string {
  return attachments
    .filter((attachment) => attachment.kind === "text" && attachment.text)
    .reduce((body, attachment) => `${body}\n\n${attachment.name}:\n${attachment.text}`, text);
}

export function redactRemoteError(message: string): string {
  return redactRemoteText(message, 500) || "This routine failed.";
}

/**
 * Routine text for a phone (a failure or a notification preview): local
 * paths and key-shaped strings are replaced, then the text is cut to
 * `maximum` code points. May be empty.
 */
export function redactRemoteText(text: string, maximum: number): string {
  const redacted = text
    .replace(/(?:file:\/\/)?(?:~|\/(?:Users|home|private|var|tmp|Volumes|Library|opt))(?:\/[^\s'"`)\]]*)+/gu, "[path]")
    .replace(/\b[A-Za-z]:\\[^\s'"`)\]]+/gu, "[path]")
    .replace(/\b(?:sk|pk|rk|xox[abpr]|gh[pousr]|AIza)[-_A-Za-z0-9]{12,}/gu, "[redacted]");
  return wireText(redacted.trim(), maximum).trim();
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

/** The view of a device holding `bot:handoffs`: what the ledger records and the projector holds. */
const HOLDER_AUDIENCE: AidenRemoteBotHandoffAudience = { handoffs: true };

/** The opt-ins a route was called with, from the device's grants. */
type AudienceOptions = { cards?: boolean; activity?: boolean; handoffs?: boolean; handoffNotes?: boolean; handoffOnMac?: boolean; issues?: boolean };

/** Ledger route of each session control. */
const CONTROL_ROUTES = {
  resume: "POST /bots/{id}/resume",
  dismiss: "POST /bots/{id}/dismiss",
  stop: "POST /bots/{id}/stop",
  pause: "POST /bots/{id}/pause",
  unpause: "DELETE /bots/{id}/pause",
} as const;

function handoffExpired(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("handoff_expired", "This hand-off is no longer waiting.", 409);
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
  /** Bot approval ids answered here recently, so a retried request replays its receipt. */
  private readonly answeredApprovals = new Set<string>();
  private readonly stopIntents: (() => void) | undefined;
  private readonly stopStateChanges: (() => void) | undefined;
  private readonly runStarts: BotRunStarts;

  constructor(private readonly options: AidenRemoteBotSessionServiceOptions) {
    this.runStarts = options.runStarts ?? createBotRunStarts();
    // A question or approval asked or settled is published in order with entries and state.
    const refresh = (botId: string) => {
      void this.projectors.get(botId)?.then((projector) => projector.refresh(), () => undefined);
    };
    options.questions?.onChange(refresh);
    options.approvals?.onChange(refresh);
    options.handoffs?.onChange(refresh);
    // Revision 42: a card raised, settled or superseded reaches open streams.
    options.issues?.onChange(refresh);
    // A pause or unpause on the Mac changes only the state; open streams hear it here.
    this.stopStateChanges = options.stateChanges?.(refresh);
    // A Stop or Resume from the Mac or any phone reaches every open session stream.
    this.stopIntents = this.supportsActivity
      ? options.turnIntents!.onIntent((botId, intent) => {
          void this.projectors.get(botId)?.then((projector) => projector.noteIntent(intent), () => undefined);
        })
      : undefined;
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

  get supportsMemory(): boolean {
    return Boolean(this.options.memory);
  }

  /**
   * Activity and queued frames and `whenBusy` (revision 30, `bot-activity-v1`):
   * Stop and Resume reach this host (`turnIntents`) and the Bot service has
   * the Chat activity gate. Without both the host sends revision-29 frames and
   * refuses `whenBusy`.
   */
  get supportsActivity(): boolean {
    return Boolean(this.options.turnIntents) && this.options.bots.supportsChatActivity === true;
  }

  /**
   * Hand-offs and pause on phones (revision 37, `bot:handoffs`): the hand-off
   * bridge and the Mac opener are wired. Without them the host never offers
   * the capability and every device gets the revision-35 view.
   */
  get supportsHandoffs(): boolean {
    return Boolean(this.options.handoffs && this.options.openHandoffOnMac);
  }

  /** Staged image and text uploads for Bot messages (revision 33, `bot-attachments-v1`). */
  get supportsAttachments(): boolean {
    return Boolean(this.options.attachments);
  }

  /**
   * Bot issues on phones (revision 42, `bot:issues`): the issue service is
   * wired. Without it the host never offers the capability, sends no `issues`
   * key, and refuses the act route.
   */
  get supportsIssues(): boolean {
    return Boolean(this.options.issues);
  }

  /** Proposal answers, suggestions and the notification feed are one feature (`bot-proactive-v1`). */
  get supportsProactive(): boolean {
    return Boolean(this.options.proposals && this.options.routineNotifications && this.options.routines);
  }

  // --- Memory (contract revision 27) ---------------------------------------------

  private memoryService() {
    if (!this.options.memory) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    return this.options.memory;
  }

  async memory(botId: string): Promise<AidenRemoteBotMemory> {
    const memory = this.memoryService();
    const bot = await this.options.bots.bot(botId);
    return projectAidenRemoteBotMemory(await memory.view(bot.id));
  }

  /**
   * Replace, remove or clear, idempotent per request UUID. Entry ids are
   * content-addressed, so an edit made against stale text is
   * `memory_entry_not_found` instead of overwriting what changed.
   */
  async editMemory(deviceId: string, botId: string, key: string, input: unknown): Promise<AidenRemoteBotMemoryEditResponse> {
    const memory = this.memoryService();
    const parsed = parseOrInvalid(parseAidenRemoteBotMemoryEditRequest, input, "The memory edit is invalid.");
    const bot = await this.options.bots.bot(botId);
    return this.options.bots.executeIdempotent(
      { deviceId, route: "POST /bots/{id}/memory/edits", resourceId: bot.id, key },
      parsed,
      async () => {
        const result = await memory.edit({ botId: bot.id, edit: parsed.edit });
        if (result.ok) return { ok: true as const, view: projectAidenRemoteBotMemory(result.view) };
        switch (result.code) {
          case "entry_not_found":
            throw new AidenRemoteServiceError(
              "memory_entry_not_found",
              "This memory changed. Refresh it before trying again.",
              404,
            );
          case "over_budget":
            throw new AidenRemoteServiceError("memory_over_budget", result.message, 422);
          case "blocked":
            throw new AidenRemoteServiceError(
              "memory_blocked",
              "This can't be saved because it looks like a password or an instruction to the Bot.",
              422,
            );
          default:
            throw new AidenRemoteServiceError("invalid_request", result.message, 422);
        }
      },
    );
  }

  // --- Proactivity (contract revision 27) ----------------------------------------

  private proactive() {
    const { proposals, routineNotifications, routines } = this.options;
    if (!proposals || !routineNotifications || !routines) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return { proposals, routineNotifications, routines };
  }

  /** Accept or dismiss a routine the Bot suggested. A repeat returns the settled answer. */
  async respondRoutineProposal(
    deviceId: string,
    botId: string,
    proposalId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotRoutineProposalRespondResult> {
    const { proposals } = this.proactive();
    const id = parseOrInvalid(parseAidenRemoteBotRoutineProposalId, proposalId, "The routine suggestion is invalid.");
    const parsed = parseOrInvalid(
      parseAidenRemoteBotRoutineProposalRespondRequest,
      input,
      "The routine suggestion answer is invalid.",
    );
    const bot = await this.options.bots.bot(botId);
    try {
      const result = await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/routine-proposals/{proposalId}/respond", resourceId: `${bot.id}:${id}`, key },
        parsed,
        async () => {
          const settled = await proposals.respond({ botId: bot.id, proposalId: id, decision: parsed.decision });
          return { status: settled.status, ...(settled.routineId !== undefined ? { routineId: settled.routineId } : {}) };
        },
      );
      this.options.notifyBotsChanged?.(bot.id);
      return result;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "routine_proposal_not_found") {
        throw new AidenRemoteServiceError("routine_proposal_not_found", "This routine suggestion is no longer available.", 404);
      }
      return routineError(error);
    }
  }

  /** The Daily check-in starter, offered only while the Bot has no routines. */
  async routineSuggestions(botId: string): Promise<AidenRemoteBotRoutineSuggestionList> {
    const { routines } = this.proactive();
    const bot = await this.options.bots.bot(botId);
    if ((await routines.list(bot.id)).length > 0) return { suggestions: [] };
    const suggestion = BOT_DAILY_CHECKIN_SUGGESTION;
    return parseAidenRemoteBotRoutineSuggestionList({
      suggestions: [
        {
          id: suggestion.id,
          name: suggestion.name,
          prompt: suggestion.prompt,
          schedule: suggestion.schedule,
          label: botRoutineLabel(
            suggestion.schedule,
            this.options.defaultTimezone?.() ?? "UTC",
            this.options.now?.() ?? Date.now(),
          ),
        },
      ],
    });
  }

  /** Finished Bot routine runs a phone should announce, after `since` (ISO). */
  async routineNotificationFeed(
    since: string | undefined,
    options: { issues?: boolean } = {},
  ): Promise<AidenRemoteBotRoutineNotificationList> {
    const { routineNotifications } = this.proactive();
    let sinceMs: number | undefined;
    if (since !== undefined) {
      sinceMs = Date.parse(since);
      if (!/^\d{4}-\d{2}-\d{2}T/u.test(since) || !Number.isFinite(sinceMs)) {
        throw new AidenRemoteServiceError("invalid_request", "since must be an ISO-8601 time.", 400);
      }
    }
    return routineNotifications.list(sinceMs, { issues: options.issues === true && this.supportsIssues });
  }

  /** The state as a `bot:handoffs` device sees it; `stateViewForAudience` projects it for the others. */
  private async stateView(botId: string): Promise<AidenRemoteBotSessionStateView> {
    return projectBotSessionState(await (await this.options.runtime()).state(botId), HOLDER_AUDIENCE);
  }

  /**
   * The Bot's oldest waiting hand-off, for both kinds of device. A card the
   * wire can't carry stays on the Mac.
   */
  private async handoffOf(botId: string): Promise<ProjectedHandoff | null> {
    const prompt = this.options.handoffs?.pending(botId)[0];
    if (prompt === undefined) return null;
    let handoff: AidenRemoteBotHandoff;
    try {
      handoff = toRemoteBotHandoff(prompt);
    } catch {
      return null;
    }
    const name = await this.options.bots.bot(botId).then((bot) => bot.name, () => "");
    return { handoff, notice: legacyHandoffNotice(name, prompt) };
  }

  /**
   * The Bot's issue cards as a `bot:issues` device reads them, oldest first.
   * The store's own rows are the truth here; a card the wire can't carry is
   * dropped by the projection and never fails the rest.
   */
  private async issuesOf(botId: string): Promise<AidenRemoteBotIssue[]> {
    const service = this.options.issues;
    if (!service) return [];
    try {
      return toRemoteBotIssues(await service.list(botId));
    } catch {
      // An unreadable issue file must never take the transcript down with it.
      return [];
    }
  }

  /** The Bot's one waiting question, in the wire shape. */
  private questionOf(botId: string): AidenRemoteBotQuestion | null {
    const prompt = this.options.questions?.pending(botId)[0];
    return prompt === undefined
      ? null
      : { waitId: prompt.waitId, toolCallId: prompt.toolCallId, questions: prompt.questions };
  }

  /** The Bot's oldest waiting tool approval, in the wire shape. */
  private approvalOf(botId: string): AidenRemoteBotApproval | null {
    const prompt = this.options.approvals?.pending(botId)[0];
    return prompt === undefined ? null : wireApproval(prompt);
  }

  /** Whether `waitId` names a Bot approval (waiting now, or answered here recently). */
  ownsApproval(waitId: string): boolean {
    return this.answeredApprovals.has(waitId) || (this.options.approvals?.pending().some((prompt) => prompt.waitId === waitId) ?? false);
  }

  /**
   * Allow or deny a Bot's waiting tool approval by `waitId`. Idempotent per
   * request UUID. Only "once" is offered; Computer Use is denied-only from a
   * phone; an approval that is no longer waiting is `approval_expired`.
   */
  async respondApproval(
    deviceId: string,
    waitId: string,
    decision: "allow" | "deny",
    key: string,
    scope?: string,
  ): Promise<{ approvalId: string; decision: "allow" | "deny"; resolvedAt: string }> {
    const approvals = this.options.approvals;
    if (!approvals) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    return this.options.bots.executeIdempotent(
      { deviceId, route: "POST /approvals/{id}/respond", resourceId: waitId, key },
      scope ? { approvalId: waitId, decision, scope } : { approvalId: waitId, decision },
      () => answerOrRefuseUnchanged(async () => {
        const prompt = approvals.pending().find((candidate) => candidate.waitId === waitId);
        if (!prompt) throw new AidenRemoteServiceError("approval_expired", "This approval is no longer available.", 409);
        await this.options.bots.bot(prompt.botId);
        if (scope !== undefined && scope !== "once") {
          throw new AidenRemoteServiceError("invalid_request", "This approval cannot be remembered with that scope.", 400);
        }
        if (decision === "allow" && !wireApproval(prompt).canAllow) {
          throw new AidenRemoteServiceError(
            "capability_denied",
            "This approval can only be allowed from the Aiden desktop app.",
            403,
          );
        }
        if (!approvals.decide(waitId, decision)) {
          throw new AidenRemoteServiceError("approval_already_resolved", "This approval was already resolved.", 409);
        }
        this.answeredApprovals.add(waitId);
        if (this.answeredApprovals.size > 256) this.answeredApprovals.delete(this.answeredApprovals.values().next().value!);
        return { approvalId: waitId, decision, resolvedAt: new Date(this.options.now?.() ?? Date.now()).toISOString() };
      }),
    );
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
    options: { handoffs?: boolean } = {},
  ): Promise<AidenRemoteBotQuestionAnswerReceipt> {
    const questions = this.questionService();
    const parsed = parseOrInvalid(parseAidenRemoteBotQuestionAnswerRequest, input, "The question answer is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      return await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/questions/{waitId}/answer", resourceId: `${bot.id}:${waitId}`, key },
        { waitId, ...parsed },
        () => answerOrRefuseUnchanged(async () => {
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
        }),
      );
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      return mapSessionError(error, this.audience(options));
    }
  }

  private handoffService() {
    if (!this.supportsHandoffs) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return this.options.handoffs!;
  }

  /** Revision 42: the Bot issue service, or the route is unavailable. */
  private issueService() {
    if (!this.supportsIssues) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    return this.options.issues!;
  }

  /**
   * Revision 37: Done or Skip on the Bot's waiting hand-off. Idempotent per
   * request UUID: a repeat gets the same receipt. A card that is no longer
   * waiting is `handoff_expired`; an answer it does not accept is
   * `invalid_request`. A sign-in is finished on the Mac, so a phone may only skip it.
   */
  async answerHandoff(
    deviceId: string,
    botId: string,
    waitId: string,
    key: string,
    input: unknown,
    options: { handoffs?: boolean } = {},
  ): Promise<AidenRemoteBotHandoffAnswerReceipt> {
    const handoffs = this.handoffService();
    const id = parseOrInvalid((value) => parseAidenRemoteBotHandoffWaitId(value), waitId, "The hand-off is invalid.");
    const parsed = parseOrInvalid(parseAidenRemoteBotHandoffAnswerRequest, input, "The hand-off answer is invalid.");
    const bot = await this.options.bots.bot(botId);
    try {
      return await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/handoffs/{waitId}/answer", resourceId: `${bot.id}:${id}`, key },
        { waitId: id, ...parsed },
        () => answerOrRefuseUnchanged(async () => {
          const prompt = handoffs.get(bot.id, id);
          if (!prompt) throw handoffExpired();
          if (prompt.kind === "sign_in" && parsed.outcome === "done") {
            throw new AidenRemoteServiceError("invalid_request", "Finish signing in on your Mac, or skip it.", 400);
          }
          const outcome = handoffs.answer(bot.id, id, parsed);
          if (outcome === "invalid") {
            throw new AidenRemoteServiceError("invalid_request", "The hand-off answer is invalid.", 400);
          }
          if (outcome === "not_waiting") throw handoffExpired();
          return { waitId: id };
        }),
      );
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      return mapSessionError(error, this.audience(options));
    }
  }

  /**
   * Revision 37: bring the Bot's waiting hand-off forward on the Mac (its
   * chat, and for a sign-in the Bot's own browser). Idempotent per request
   * UUID, like a connection request: a repeat never opens it twice.
   */
  async openHandoffOnMac(
    deviceId: string,
    botId: string,
    waitId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotHandoffOpenOnMacReceipt> {
    const handoffs = this.handoffService();
    const id = parseOrInvalid((value) => parseAidenRemoteBotHandoffWaitId(value), waitId, "The hand-off is invalid.");
    parseOrInvalid((value) => parseAidenRemoteEmptyRequest(value, "Bot hand-off request"), input ?? {}, "The hand-off request is invalid.");
    const bot = await this.options.bots.bot(botId);
    return this.options.bots.executeIdempotent(
      { deviceId, route: "POST /bots/{id}/handoffs/{waitId}/open-on-mac", resourceId: `${bot.id}:${id}`, key },
      { waitId: id },
      async () => {
        // Nothing opened, so a retry with this request UUID is checked again.
        if (!handoffs.get(bot.id, id)) throw new AidenOperationNotExecutedError(handoffExpired());
        const opened = await this.options.openHandoffOnMac!(bot.id, id);
        return { waitId: id, opened: opened !== "none" };
      },
    );
  }

  /**
   * Revision 42: carry out one action a card offers (`bot:issues`). Idempotent
   * per request UUID. `not_open` is a success: the card is gone or already
   * settled. An action the card never offered is `409 operation_stale`, and
   * records nothing for its key so a retry after a refresh is evaluated afresh.
   */
  async actIssue(
    deviceId: string,
    botId: string,
    issueId: string,
    key: string,
    input: unknown,
  ): Promise<AidenRemoteBotIssueActReceipt> {
    const issues = this.issueService();
    const parsed = parseOrInvalid(parseAidenRemoteBotIssueActRequest, input, "The issue action is invalid.");
    if (typeof issueId !== "string" || !BOT_ISSUE_ID_PATTERN.test(issueId)) {
      throw new AidenRemoteServiceError("invalid_request", "The Bot issue is invalid.", 400);
    }
    const id = issueId;
    const bot = await this.options.bots.bot(botId);
    return this.options.bots.executeIdempotent(
      { deviceId, route: "POST /bots/{id}/issues/{issueId}/act", resourceId: `${bot.id}:${id}`, key },
      parsed,
      async () => {
        const result = await issues.act(bot.id, id, parsed.action);
        if (result === "invalid") {
          // Nothing ran: the same key is checked again after the card refreshes.
          throw new AidenOperationNotExecutedError(
            new AidenRemoteServiceError(
              "operation_stale",
              "This card changed. Refresh it before trying again.",
              409,
              true,
            ),
          );
        }
        return { result };
      },
    );
  }

  /**
   * Pending connect cards show what is true now (connected, or Not now). An
   * app left out of the Bot's access stays pending here: the phone's "Finish
   * on your Mac" opens the Bot's chat, where the Mac offers "Add to this Bot".
   */
  private async resolveCards(
    botId: string,
    entries: AidenRemoteBotSessionEntry[],
  ): Promise<AidenRemoteBotSessionEntry[]> {
    const resolve = this.options.connectCardStatus;
    if (!resolve) return entries;
    return Promise.all(entries.map(async (entry) => {
      if (entry.type !== "connect_card" || entry.status !== "pending") return entry;
      const resolved = await resolve(botId, { type: "connect_card", pluginId: entry.pluginId, reason: entry.reason, status: "pending" })
        .catch(() => entry.status);
      const status = resolved === "needs_access" ? "pending" : resolved;
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
        () => this.approvalOf(botId),
        // Without revision 30 nothing is derived, so revision-29 streams are byte-for-byte unchanged.
        this.supportsActivity
          ? {
              classify: (ids) => runtime.quietInputs(botId, ids),
              placed: () => runtime.placedSubmissions(botId),
              now: () => this.options.now?.() ?? Date.now(),
              runStarts: this.runStarts,
              retryMs: this.options.classifyRetryMs ?? CLASSIFY_RETRY_MS,
              report: (error) => this.options.onReport?.(botId, error),
            }
          : undefined,
        () => this.handoffOf(botId),
        this.supportsIssues ? () => this.issuesOf(botId) : undefined,
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

  /**
   * Test seam: how many bubble tags the Bot's open projector remembers, or 0
   * with none open. The memo is bounded by the session window.
   */
  async submissionTagsHeld(botId: string): Promise<number> {
    const projector = await this.projectors.get(botId)?.catch(() => undefined);
    return projector?.submissionTagCount ?? 0;
  }

  /** A projector whose watch already ended is replaced by a fresh epoch. */
  private async liveProjector(botId: string): Promise<BotLiveProjector> {
    const projector = await this.projector(botId);
    return projector.closed ? this.projector(botId) : projector;
  }

  /**
   * What a device that negotiated these opt-ins is sent; `activity` needs this
   * host's revision 30 and `handoffs` its revision 37.
   */
  private audience(options: AudienceOptions): Audience {
    return {
      cards: options.cards === true,
      activity: options.activity === true && this.supportsActivity,
      handoffs: options.handoffs === true && this.supportsHandoffs,
      notes: options.handoffs === true && options.handoffNotes === true && this.supportsHandoffs,
      onMac: options.handoffs === true && options.handoffOnMac === true && this.supportsHandoffs,
      issues: options.issues === true && this.supportsIssues,
    };
  }

  /** `cards`, `activity`, `handoffs`, `issues`: the device holds those opt-ins. */
  async session(botId: string, options: AudienceOptions = {}): Promise<AidenRemoteBotSession> {
    const bot = await this.options.bots.bot(botId);
    const audience = this.audience(options);
    try {
      const raw = await (await this.options.runtime()).state(bot.id);
      const state = projectBotSessionState(raw, audience);
      // A paused Bot still shows its transcript, whichever way the device names it.
      if (state.state === "unavailable" && raw.kind !== "paused") {
        // Bots are held by another Aiden process: nothing can be opened.
        return parseAidenRemoteBotSession({
          botId: bot.id, epoch: "epoch_unavailable", seq: 0, ...state, entries: [], hasOlder: false, question: null, approval: null,
          ...(audience.activity ? { activity: null, queued: [] } : {}),
          ...(audience.handoffs ? { handoff: null } : {}),
          ...(audience.issues ? { issues: [] } : {}),
        });
      }
      const projector = await this.liveProjector(bot.id);
      // A state change without a commit (a desktop Stop, a lock change) is not
      // seen by the watch; a fetch always reports the current state.
      await projector.refresh();
      return projector.snapshot(audience);
    } catch (error) {
      return mapSessionError(error, audience);
    }
  }

  /** SSE: a `snapshot` first, then `partial` / `entry` / `state`, and `closed` when the session closes. */
  async openEvents(
    deviceId: string,
    botId: string,
    response: ServerResponse,
    admit: () => void = () => {},
    options: AudienceOptions = {},
  ): Promise<void> {
    const bot = await this.options.bots.bot(botId);
    let projector: BotLiveProjector;
    try {
      projector = await this.liveProjector(bot.id);
    } catch (error) {
      return mapSessionError(error, this.audience(options));
    }
    // A new subscriber sees current card statuses and state, not the last commit's.
    await projector.refresh();
    if (projector.closed) {
      // Deleted while attaching: a 404 tells the client to leave the chat.
      await this.options.bots.bot(bot.id);
      throw new AidenRemoteServiceError("operation_stale", "This Bot's chat closed. Try again.", 409, true);
    }
    admit();
    const audience = this.audience(options);
    const subscriber: Subscriber = { frames: [projector.snapshotFrame(audience)], overflowed: false, ...audience };
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

  /** An app was connected or set up on the Mac: open Bot streams re-read their pending connect cards. */
  async refreshConnectCards(): Promise<void> {
    const projectors = await Promise.allSettled([...this.projectors.values()]);
    await Promise.all(
      projectors.map((result) => (result.status === "fulfilled" ? result.value.refreshCards().catch(() => undefined) : undefined)),
    );
  }

  async close(): Promise<void> {
    this.stopIntents?.();
    this.stopStateChanges?.();
    for (const deviceId of [...this.subscriptions.keys()]) this.revokeDevice(deviceId);
    const projectors = await Promise.allSettled([...this.projectors.values()]);
    for (const result of projectors) if (result.status === "fulfilled") await result.value.close();
  }

  private async afterAction(botId: string): Promise<void> {
    const projector = await this.projectors.get(botId)?.catch(() => undefined);
    await projector?.refresh();
    this.options.notifyBotsChanged?.(botId);
  }

  /** `handoffs`: the device holds `bot:handoffs` (its receipt and refusals may name a pause). */
  async send(
    deviceId: string,
    botId: string,
    key: string,
    input: unknown,
    options: { handoffs?: boolean } = {},
  ): Promise<AidenRemoteBotMessageReceipt> {
    const audience = this.audience(options);
    // `whenBusy` is revision 30 and `attachmentIds` revision 33: a host that
    // does not announce one refuses its key.
    const parsed = parseOrInvalid(
      (value) => parseAidenRemoteBotMessageRequest(value, {
        allowWhenBusy: this.supportsActivity,
        allowAttachments: this.supportsAttachments,
      }),
      input,
      "The Bot message is invalid.",
    );
    const bot = await this.options.bots.bot(botId);
    try {
      const receipt = await this.options.bots.executeIdempotent(
        { deviceId, route: "POST /bots/{id}/messages", resourceId: bot.id, key },
        parsed,
        async () => {
          const runtime = await this.options.runtime();
          // Consumed once, inside the ledger: a replayed request never asks for them again.
          const taken = parsed.attachmentIds
            ? this.options.attachments!.reserve(deviceId, botAttachmentScope(bot.id), parsed.attachmentIds)
            : undefined;
          const attached = taken?.attachments ?? [];
          const images = botImageAttachments(attached);
          let sent: Awaited<ReturnType<typeof runtime.send>>;
          try {
            // The request UUID is the session request id: a resubmission dedupes.
            sent = await unlessRefusedBeforeRunning(() => runtime.send(bot.id, {
              text: botMessageText(parsed.text, attached),
              requestId: `remote:${deviceId}:${key}`,
              // Steer joins the running turn; Queue (or nothing, as before) runs after it.
              ...(parsed.whenBusy ? { whenBusy: parsed.whenBusy === "steer" ? "steer" as const : "followUp" as const } : {}),
              ...(images.length > 0 ? { attachments: images } : {}),
            }));
          } catch (error) {
            // A refusal from state never started the turn, and the ledger forgets
            // the key: give the uploads back so the same request can run once the
            // Bot is fixed. Anything else may have run, so they stay spent.
            if (error instanceof AidenOperationNotExecutedError) taken?.restore();
            else taken?.commit();
            throw error;
          }
          taken?.commit();
          // Recorded in the holder's view; each device's view is projected from it below.
          return { ...sent, ...projectBotSessionState(await runtime.state(bot.id), HOLDER_AUDIENCE) };
        },
      );
      await this.afterAction(bot.id);
      const { submissionId, deduped, ...state } = receipt;
      return { submissionId, deduped, ...stateViewForAudience(state, audience) };
    } catch (error) {
      return mapSessionError(error, audience);
    }
  }

  /** Stage one image or text file for this device's next message to the Bot (revision 33). */
  async uploadAttachment(deviceId: string, botId: string, input: unknown): Promise<AidenRemoteAttachmentProjection> {
    const attachments = this.attachmentStore();
    const bot = await this.options.bots.bot(botId);
    return attachments.upload(deviceId, botAttachmentScope(bot.id), input);
  }

  /** Drop a staged upload the person removed before sending; an unknown id is already gone. */
  async removeAttachment(deviceId: string, botId: string, attachmentId: string): Promise<void> {
    const attachments = this.attachmentStore();
    const bot = await this.options.bots.bot(botId);
    attachments.remove(deviceId, botAttachmentScope(bot.id), attachmentId);
  }

  private attachmentStore() {
    if (!this.options.attachments) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    return this.options.attachments;
  }

  private async control(
    action: "resume" | "dismiss" | "stop" | "pause" | "unpause",
    deviceId: string,
    botId: string,
    key: string,
    input: unknown,
    options: { handoffs?: boolean },
  ): Promise<AidenRemoteBotSessionStateView> {
    if (action === "pause" || action === "unpause") this.handoffService();
    parseOrInvalid((value) => parseAidenRemoteEmptyRequest(value, "Bot request"), input ?? {}, "The Bot request is invalid.");
    const audience = this.audience(options);
    const bot = await this.options.bots.bot(botId);
    try {
      // Recorded in the holder's view, so a replay to any device projects the same truth.
      const view = await this.options.bots.executeIdempotent(
        { deviceId, route: CONTROL_ROUTES[action], resourceId: bot.id, key },
        {},
        async () => {
          const runtime = await this.options.runtime();
          const requestId = `remote:${deviceId}:${key}`;
          const holderView = (state: BotSessionState) => projectBotSessionState(state, HOLDER_AUDIENCE);
          if (action === "resume") {
            return holderView(await unlessRefusedBeforeRunning(() => runtime.resume(bot.id, requestId)));
          }
          if (action === "dismiss") {
            return holderView(await unlessRefusedBeforeRunning(() => runtime.dismiss(bot.id, requestId)));
          }
          if (action === "pause") {
            return holderView(await unlessRefusedBeforeRunning(() => runtime.pause(bot.id, "phone")));
          }
          if (action === "unpause") {
            return holderView(await unlessRefusedBeforeRunning(() => runtime.unpause(bot.id)));
          }
          // Stop ends a running turn; a paused one belongs to Dismiss. Every
          // surface reads "Stopping" until the run ends, or until the Stop fails.
          const stop = () => unlessRefusedBeforeRunning(() => runtime.stop(bot.id));
          const state = this.options.turnIntents
            ? await stopWithIntents(this.options.turnIntents, bot.id, stop)
            : await stop();
          return holderView(state);
        },
      );
      await this.afterAction(bot.id);
      return stateViewForAudience(view, audience);
    } catch (error) {
      return mapSessionError(error, audience);
    }
  }

  resume(deviceId: string, botId: string, key: string, input: unknown, options: { handoffs?: boolean } = {}) {
    return this.control("resume", deviceId, botId, key, input, options);
  }

  dismiss(deviceId: string, botId: string, key: string, input: unknown, options: { handoffs?: boolean } = {}) {
    return this.control("dismiss", deviceId, botId, key, input, options);
  }

  stop(deviceId: string, botId: string, key: string, input: unknown, options: { handoffs?: boolean } = {}) {
    return this.control("stop", deviceId, botId, key, input, options);
  }

  /**
   * Revision 37: pause the Bot from a phone (`by: "phone"`). Idempotent per
   * request UUID; pausing a paused Bot keeps the first pause. A running turn
   * is closed and left interrupted.
   */
  pause(deviceId: string, botId: string, key: string, input: unknown, options: { handoffs?: boolean } = {}) {
    return this.control("pause", deviceId, botId, key, input, options);
  }

  /** Revision 37: clear the pause. An interrupted turn then waits for Resume. */
  unpause(deviceId: string, botId: string, key: string, options: { handoffs?: boolean } = {}) {
    return this.control("unpause", deviceId, botId, key, {}, options);
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

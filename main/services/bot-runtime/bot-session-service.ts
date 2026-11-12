import { BOT_PEER_MESSAGE_ENTRY_KIND, parseBotPeerTranscriptData, type BotPeerTranscriptData } from "../../../renderer/shared/bot-peers.js";
import type { BotPeerRuntimeReceipt, BotPeerPublication } from "../bot-peers/service.js";
import { inspectBotPeerInputOrigin, type BotPeerInputOrigin } from "../bot-peers/authority.js";
import { BOT_PERSON_INPUT_KIND, BOT_PEER_INPUT_KIND, BOT_ROUTINE_INPUT_KIND, isIssuedBotRoutineInputOrigin, type BotRoutineInputOrigin } from "./bot-input-entry.js";
import { BOT_EXECUTION_INPUT_KEY, BotExecutionDoc, botExecutionScope, botCostApprovalFacts, createBotExecutionRegistry, reconcileBotExecutionResponses, stampBotExecutionTask, withBotExecutionAdmission, type BotExecutionPort } from "./bot-execution.js";
import type { BotExecutionClaim } from "../bot-routine-models.js";
import { botConnectorExecutionRestriction, botConnectorInventoryServer } from "../bot-connector-inventory-scope.js";
import { randomUUID } from "node:crypto";
import { botResponseDigest } from "./bot-response-digest.js";
import { botCostReceiptScope, consumeBotResumeOperation } from "./bot-resume-operations.js";
import type { BotExecutionResumeStatus, BotResumeAcknowledgement } from "../../../renderer/shared/bot-execution-resume.js";
import { reportChatMessageSent } from "../analytics/analytics-feature-reports.js";
import { botMessageTurnOf, isBotMessageRequestId } from "../../../renderer/shared/bot-messages.js";
import { BOT_MESSAGE_INPUT_KIND, type BotMessageInputMetadata } from "./bot-input-entry.js";
// The Bot turn path: every ingress (desktop, Remote, Telegram, routines)
// reaches a Bot's one durable conversation through this service.
//
// - `send` admits input with the caller's stable `requestId`; a repeat of the
//   same request returns the original submission (`deduped: true`). Sending
//   while the Bot is interrupted dismisses the paused turn first.
// - `resume` and `dismiss` are explicit user actions on an interrupted turn.
//   Both are idempotent: a second call, from any client, returns the current
//   state and makes no provider request.
// - Nothing here resumes a harness on its own. The startup scan only records
//   which Bots are interrupted.
// - `pause` is the person's switch (plan §7). It is recorded first, then a
//   running turn is closed under a time bound and left interrupted, never
//   dismissed. While paused, sends, Resume, Dismiss and compaction are refused
//   with `paused_by_person`; `unpause` clears the switch and an interrupted
//   turn shows its usual Resume card again.
// - `deleteBot` records the delete durably (`bots/pending-deletes.json`)
//   before its first destructive step, then aborts the live run, erases the
//   Bot's session and runs the caller-supplied cleanup steps. A pending delete
//   refuses to reopen the Bot's session, and startup rolls it forward through
//   every step before anything else.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type Cursor,
  GenerationTask,
  CompactionTask,
  LiveDoc,
  type Harness,
  HarnessInspection,
  HarnessSettings,
  ModelRef,
  SessionFailed,
  type SettledSubmissionRecord,
  SubmissionId,
  SubmissionRecord,
  type TaskId,
  ToolTask,
  UserInput,
} from "@earendil-works/pi-durable";
import {
  createBotRegistry,
  type BotExtensionDeps,
  type BotReadmission,
  type BotRegistry,
} from "./bot-extension.js";
import { writeFileAtomic } from "../durable-fs.js";
import {
  createBotPauseStore,
  type BotPauseOrigin,
  type BotPauseRecord,
  type BotPauseStore,
} from "../bot-pause-store.js";
import { BOT_INTRO_REQUEST_PREFIX } from "./bot-intro.js";
import {
  BotHarnessHostClosedError,
  createBotHarnessHost,
  isBotHarnessHostUnavailable,
  type BotHarnessHost,
} from "./harness-host.js";

import { inspectLinkedBotWork, stopLinkedBotWork, readLinkedBotWorkEvidence, type BotLinkedWorkEvidence, type BotLinkedWorkInspection, type BotLinkedWorkStopOutcome } from "../bot-open-work/stop.js";

export const BOT_NOTICE_ENTRY_KIND = "aiden.bot-notice";
export const BOTS_HELD_ELSEWHERE_MESSAGE = "Bots are open in another Aiden window.";

export type BotSessionState =
  | { kind: "idle" }
  | { kind: "running"; submissionId: string }
  | { kind: "interrupted"; submissionId: string; blocked?: "access_changed" | "bot_missing" }
  /** The Bot has no AI model configured. */
  | { kind: "needs_model" }
  /** The Bot has a model, but it cannot be used right now (sign-in, missing provider, access). */
  | { kind: "model_error"; message: string }
  | { kind: "unavailable"; reason: "held_by_live_process" }
  /**
   * The person paused the Bot (plan §7). `interrupted`: the submission of the
   * turn that was running when it paused, waiting for Resume after unpause.
   */
  | { kind: "paused"; since: number; by: BotPauseOrigin; interrupted?: string };

/** A transcript notice entry; `data` of `aiden.bot-notice`. */
export type BotNotice =
  | ({ notice: "bot_message"; requestId: string } & BotMessageInputMetadata)
  | { notice: "interrupted"; submissionId: string }
  | { notice: "session_reset"; movedTo: string }
  /** Precedes a routine's input: the turn is labelled with the routine name. */
  | { notice: "routine"; label: string; requestId: string }
  /** The answer to this submission was `[SILENT]`: kept, but no bubble, preview or unread. */
  | { notice: "silent"; submissionId: string }
  /** Precedes an input the person never typed (the self-intro prompt): the input is not shown. */
  | { notice: "hidden_input"; requestId: string }
  /** Written on unpause: the routines that fired while the Bot was paused, with Run now. */
  | { notice: "routines_skipped"; since: number; routines: { routineId: string; name: string; count: number }[] };

export type BotReplyOutcome =
  | { kind: "completed"; text: string }
  /**
   * `error` is the person-facing message. `reason` is Pi's own reason code and
   * `detail` the provider text it settled the submission with; callers classify
   * a routine failure from them, never from the message.
   */
  | { kind: "failed"; error: string; reason?: string; detail?: string }
  /**
   * No answer now. `settled`: the turn ended without one for good (dismissed,
   * stopped or deleted); otherwise it is paused and Resume can still answer it.
   */
  | { kind: "interrupted"; settled?: true };

export interface BotInputAttachment {
  type: "image";
  mimeType: string;
  /** Base64 bytes. */
  data: string;
}

export interface BotSendInput {
  ifIdle?: boolean;
  botMessage?: BotMessageInputMetadata;
  text: string;
  attachments?: readonly BotInputAttachment[];
  requestId: string;
  whenBusy?: "steer" | "followUp";
  /**
   * Unattended senders (routines) set this: an interrupted Bot belongs to the
   * person, so the send is refused with `bot_paused` instead of dismissing the
   * paused turn first.
   */
  ifNotInterrupted?: boolean;
  /** Internal host-issued accepted routine provenance; never accepted from IPC or Remote. */
  routineOrigin?: BotRoutineInputOrigin;
  /** Internal peer host token; IPC/Remote never accept this field. */
  peerOrigin?: BotPeerInputOrigin;
  /** Internal immutable occurrence facts from the admitted scheduler fire. */
  routineTiming?: { scheduledFor?: number; timezone?: string };
  retryOf?: string;
  /** Label shown on the turn, such as the routine name. */
  label?: string;
  /** An Aiden-written prompt (the self-intro): its reply shows, the prompt does not. */
  hidden?: boolean;
}

export type BotSessionErrorReason =
  | "spending_unconfirmed"
  | "bot_busy"
  | "needs_model"
  | "model_error"
  | "unavailable"
  | "access_changed"
  | "bot_missing"
  | "bot_deleted"
  /** Interrupted: a turn is waiting for Resume (the unattended-send refusal). */
  | "bot_paused"
  /** The person paused the Bot. */
  | "paused_by_person"
  /** The Bot's month is over its spending limit. */
  | "spending_limit";

export class BotSessionError extends Error {
  /**
   * `authority`: the typed `BotRuntimeAuthorityError` classification behind
   * this refusal (for example `model_changed`), so routines can record it.
   */
  constructor(readonly reason: BotSessionErrorReason, message?: string, readonly authority?: string) {
    super(message ?? defaultMessage(reason));
    this.name = "BotSessionError";
  }
}

/** The typed classification of a `BotRuntimeAuthorityError`, by name (it may come from another module instance). */
function authorityOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "BotRuntimeAuthorityError") return undefined;
  const classification = (error as { classification?: unknown }).classification;
  return typeof classification === "string" && classification ? classification : undefined;
}

function defaultMessage(reason: BotSessionErrorReason): string {
  switch (reason) {
    case "spending_unconfirmed": return "The prior provider request may have incurred charges, but its cost is unknown. Confirm that you accept this uncertainty before resuming; a new attempt may incur charges again.";
    case "bot_busy": return "This Bot is busy.";
    case "needs_model":
      return "This Bot needs an AI model.";
    case "model_error":
      return "This Bot's AI model is not available right now.";
    case "unavailable":
      return BOTS_HELD_ELSEWHERE_MESSAGE;
    case "access_changed":
      return "This Bot's access changed. Review it in Advanced.";
    case "bot_missing":
    case "bot_deleted":
      return "This Bot no longer exists.";
    case "bot_paused":
      return "I got interrupted while working on this.";
    case "paused_by_person":
      return "This Bot is paused. Resume it to continue.";
    case "spending_limit":
      return "This Bot reached its spending limit for this month. Allow more to keep going.";
  }
}

/** Remove's outcome: withdrawn before it ran, already started, or no longer waiting. */
export type BotWithdrawResult = "withdrawn" | "started" | "gone";

export interface BotSessionService {
  canRetryRoutineRequest(botId: string, requestId: string): Promise<boolean>;
  submissionForRequest(botId: string, requestId: string): Promise<string | undefined>;
  send(botId: string, input: BotSendInput): Promise<{ submissionId: string; deduped: boolean }>;
  resume(botId: string, requestId: string, options?: BotResumeAcknowledgement): Promise<BotSessionState>;
  executionResumeStatus(botId: string): Promise<BotExecutionResumeStatus>;
  dismiss(botId: string, requestId: string): Promise<BotSessionState>;
  /**
   * Stop the reply that is running now (the composer's Stop). What was already
   * written stays in the transcript and queued follow-ups are withdrawn. A
   * paused (interrupted) turn is left for Resume or Dismiss.
   */
  stop(botId: string): Promise<BotSessionState>;
  inspectLinkedWork(botId: string, submissionId: string): Promise<BotLinkedWorkInspection>;
  readLinkedWorkEvidence(botId: string, submissionId: string, kind: "source" | "result", publication?: BotPeerPublication): Promise<BotLinkedWorkEvidence | undefined>;
  stopLinkedWork(botId: string, submissionId: string, intentId?: string, publication?: BotPeerPublication): Promise<BotLinkedWorkStopOutcome>;
  /**
   * Withdraw one queued message before its turn starts (Pi's
   * `abortSubmission`). A message already placed in a turn keeps running.
   */
  withdraw(botId: string, submissionId: string): Promise<BotWithdrawResult>;
  state(botId: string): Promise<BotSessionState>;
  deleteBot(botId: string): Promise<void>;
  /**
   * Wait for a submission's answer. Never starts a paused Bot: a turn that is
   * interrupted (or becomes so when the app quits) reports `interrupted`. A
   * wait cut short any other way (a storage failure) reports `failed`.
   * Aborting `signal` stops waiting only.
   */
  awaitReply(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome>;
  /** Keep the submission's answer for audit but hide it from the chat, preview and unread. */
  markSilent(botId: string, submissionId: string): Promise<void>;
  /**
   * Pause the Bot (idempotent: the first pause's time and origin stay). A
   * running turn is closed and left interrupted, so its questions, hand-offs
   * and approvals are withdrawn and asked again after unpause and Resume.
   */
  pause(botId: string, by: BotPauseOrigin): Promise<BotSessionState>;
  /** Clear the pause. An interrupted turn then waits for Resume as usual. */
  unpause(botId: string): Promise<BotSessionState>;
}

export interface BotSessionRuntime extends BotSessionService {
  /** Routine admission inspects lifecycle without resolving an unrelated default model. */
  routineState(botId: string): Promise<BotSessionState>;
  /** Passive exact peer receipt; never resumes, resolves a model or admits work. */
  peerReceipt(botId: string, requestId: string, publication?: BotPeerPublication): Promise<BotPeerRuntimeReceipt | undefined>;
  appendPeerRow(botId: string, eventId: string, data: BotPeerTranscriptData, publication?: BotPeerPublication): Promise<void>;
  /** Read-only task observation for collecting message replay receipts. Never resumes scheduling. */
  awaitMessageTaskSettlement(botId: string, taskId: string, signal: AbortSignal): Promise<boolean>;
  /** Startup: remove orphaned Bot sessions and record interrupted Bots. Never resumes. */
  initialize(): Promise<{ removedOrphans: string[]; interrupted: string[] }>;
  /** The Bot's conversation, opened lazily (for live projection). */
  conversation(botId: string): Promise<Conversation>;
  /**
   * For each of these queued submission ids it can find: whether it is not the
   * person's own message (`true`: a routine's input or the hidden self-intro,
   * known from its durable request id). Ids it cannot find are left out.
   */
  quietInputs(botId: string, submissionIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /**
   * The person's own inputs the Bot is working on now, keyed by the `pi.user`
   * entry each one was placed as (entry id → submission id). Placement is
   * atomic with that entry's append, so an entry a watch shows is already
   * here; once its turn ends the submission is done and drops out. Routine
   * inputs and the hidden self-intro are never listed (`quietInputs`).
   */
  placedSubmissions(botId: string): Promise<ReadonlyMap<string, string>>;
  /**
   * Compact the Bot's one conversation now (Telegram `/new`), focused on what
   * the person shared and what the Bot promised (`compactionInstructions`).
   * Resolves once the compaction is admitted; it summarizes in the background.
   */
  compact(botId: string): Promise<void>;
  /**
   * Append an entry to the Bot's conversation without starting its scheduler:
   * safe while the Bot is paused or interrupted, unlike a write submission.
   */
  appendEntry(botId: string, kind: string, data: JsonValue): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BotSessionServiceDeps {
  execution?: BotExecutionPort;
  /** Persist a host Needs-you explanation before a blocked invocation is suspended. */
  executionBlocked?(botId: string, claim: BotExecutionClaim, message: string, kind: "spending_unknown" | "unavailable"): Promise<void>;
  leaseHelperPath?: string;
  profileDir: string;
  /**
   * pi-ai model access. Production passes each Bot its own view, so a Bot's
   * provider binding and per-conversation headers stay its own.
   */
  models: Models | ((botId: string) => Models);
  extension: BotExtensionDeps;
  /**
   * The Bot's current model, or `null` when it has no model configured. Any
   * other failure throws; its message is shown as a `model_error`.
   */
  resolveModel(botId: string): Promise<ModelRef | null>;
  /** Every Bot record that exists. Sessions of other ids are orphans. */
  knownBotIds(): Promise<ReadonlySet<string>>;
  /**
   * Erase everything else a Bot owns, in order (routines, dismissals,
   * Telegram binding, then photo, home, access, chat rows and finally the Bot
   * record). Runs after the session is aborted and removed. Each effect must
   * be idempotent: a failed or interrupted delete is retried from the start.
   */
  beforeDelete?(botId: string): Promise<void>;
  deleteEffects?: ReadonlyArray<(botId: string) => Promise<void>>;
  /**
   * A harness opened for this Bot (first use, or after the idle close): a new
   * session starts, so per-session state such as the memory snapshot resets.
   */
  onSessionOpen?(botId: string): void;
  /** The focus a manual compaction (`compact`) asks the summary to keep. */
  compactionInstructions?: string;
  settings?: HarnessSettings;
  idleCloseMs?: number;
  now?: () => number;
  onStateChange?(botId: string, state: BotSessionState): void;
  /** `resume` restarted an interrupted turn (not called for replays, blocked or no-op resumes). */
  onResumed?(botId: string): void;
  /** Close only this accepted peer source/branch before its exact task is stopped. */
  hasPeerSource?(botId:string,requestIds:readonly string[]):Promise<boolean>;
  onSourceStop?(botId: string, requestIds: readonly string[]): Promise<boolean>;
  /** A running reply was aborted by Stop, or an interrupted turn was dismissed. Must not await a plan serial. */
  onStopped?(botId: string): void;
  onReport?(botId: string, error: unknown): void;
  /** Which Bots the person paused. Default: `<profileDir>/bot-service/bot-pauses.json`. */
  pauses?: BotPauseStore;
  /** Runs after the pause is recorded and before a running turn is closed (memory review cancel). */
  onPaused?(botId: string): void | Promise<void>;
  /**
   * Runs once a running turn was closed (or at once when none ran): pause steps
   * that live outside the harness. Waits inside the turn (questions, approvals,
   * hand-offs) need none: the close signals their calls, which withdraws them.
   */
  afterPaused?(botId: string): void | Promise<void>;
  /** Runs after the pause is cleared, with the record it cleared (skipped-routines notice). */
  onUnpaused?(botId: string, record: BotPauseRecord): void | Promise<void>;
  /** How long a pause waits for a running turn to close (default 5 s, like quit). */
  suspendTimeoutMs?: number;
  /** Why a new message may not start: the Bot's month is over its spending limit. */
  spendingRefusal?(botId: string): Promise<string | undefined>;
}

const ctx = BACKGROUND_CONTEXT;
const REQUEST_MEMORY = 1_000;
const REPLY_LOST_MESSAGE = "The Bot stopped before it could answer this. Send it again.";

function userContent(input: BotSendInput): UserInput {
  if (input.attachments === undefined || input.attachments.length === 0) return input.text;
  const parts: Array<TextContent | ImageContent> = [];
  if (input.text.length > 0) parts.push({ type: "text", text: input.text });
  for (const attachment of input.attachments) {
    parts.push({ type: "image", mimeType: attachment.mimeType, data: attachment.data });
  }
  return parts;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function unfinishedInput(inspection: HarnessInspection): SubmissionRecord | undefined {
  return inspection.submissions.find((submission) => submission.type === "input");
}

const PENDING_DELETES_FILE = "pending-deletes.json";

/** Bots whose delete started and has not finished every step. */
async function readPendingDeletes(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as { version?: unknown; botIds?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.botIds) || !parsed.botIds.every((id) => typeof id === "string")) {
    throw new Error("The pending Bot delete record is unreadable.");
  }
  return parsed.botIds as string[];
}
/** Main-only deletion fence for independently stored routine grants. */
export async function botSessionDeletionPending(profileDir: string, botId: string): Promise<boolean> { return (await readPendingDeletes(path.join(profileDir, "bots", PENDING_DELETES_FILE))).includes(botId); }

/** A keyed promise chain: one operation per Bot at a time. */
function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

export async function createBotSessionService(deps: BotSessionServiceDeps): Promise<BotSessionRuntime> {
  const registries = new Map<string, BotRegistry>();
  let shuttingDown = false;
  const hostOrUnavailable = await createBotHarnessHost({
    profileDir: deps.profileDir,
    leaseHelperPath: deps.leaseHelperPath,
    models: deps.models,
    buildRegistry: (botId) => {
      const registry = createBotRegistry(botId, deps.extension);
      registries.set(botId, registry);
      deps.onSessionOpen?.(botId);
      if (!deps.execution) return registry;
      const execution = createBotExecutionRegistry(botId, registry, deps.execution, { onBlocked: executionBlocked, prepareRegistry: async () => { const owned = registry.fork(); await owned.refresh(); return owned.snapshot(); } });
      return { ...execution, attachHarness(harness: Harness) { registry.attachHarness(harness); execution.attachHarness(harness); } };
    },
    ...(deps.settings === undefined ? {} : { settings: deps.settings }),
    ...(deps.idleCloseMs === undefined ? {} : { idleCloseMs: deps.idleCloseMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onReport === undefined ? {} : { onReport: deps.onReport }),
  });
  const host: BotHarnessHost | null = isBotHarnessHostUnavailable(hostOrUnavailable) ? null : hostOrUnavailable;
  const serialize = createKeyedQueue();
  /** Submissions sent with `hidden`, whatever their request id. */
  const hiddenSubmissions = new Set<string>();
  /** Dismiss outcomes; Resume controls have a durable per-conversation receipt. */
  const answered = new Map<string, BotSessionState>();
  /** Interrupted turns whose Resume was refused because the Bot's access changed. */
  const blocked = new Map<string, "access_changed" | "bot_missing">();
  const deleted = new Set<string>();
  const executionSuspends = new Set<string>();
  async function executionBlocked(claim: BotExecutionClaim, message: string, kind: "spending_unknown" | "unavailable"): Promise<void> {
    const botId = claim.botId;
    await deps.executionBlocked?.(botId, claim, message, kind);
    if (executionSuspends.has(botId)) return;
    executionSuspends.add(botId);
    // Do not join close from the invocation close must join. Let this phase
    // wait on its signal while the host independently suspends the Bot.
    queueMicrotask(() => {
      void requireHost().suspend(botId).then(async () => { if (!deleted.has(botId) && !shuttingDown) { await requireHost().open(botId); publish(botId, await currentState(botId, false)); } }).catch((error: unknown) => deps.onReport?.(botId, error)).finally(() => executionSuspends.delete(botId));
    });
  }
  const pauses = deps.pauses ?? createBotPauseStore({ root: () => path.join(deps.profileDir, "bot-service") });
  /**
   * Bots a pause could not close within its bound: the close keeps running in
   * the host, so state reads skip inspecting them until it finishes.
   */
  const suspending = new Set<string>();
  const pendingDeletesFile = path.join(deps.profileDir, "bots", PENDING_DELETES_FILE);
  // A delete cut short by a crash still owns the Bot: never reopen its session.
  for (const botId of await readPendingDeletes(pendingDeletesFile)) deleted.add(botId);

  /** Add or remove a Bot in the durable pending-delete record (one writer at a time). */
  function recordPendingDelete(botId: string, pending: boolean): Promise<void> {
    return serialize(PENDING_DELETES_FILE, async () => {
      const current = new Set(await readPendingDeletes(pendingDeletesFile));
      if (pending === current.has(botId)) return;
      if (pending) current.add(botId);
      else current.delete(botId);
      await writeFileAtomic(pendingDeletesFile, JSON.stringify({ version: 1, botIds: [...current] }), {
        mode: 0o600,
        mkdirMode: 0o700,
      });
    });
  }

  /** Not the person's own message: a routine's input or the hidden self-intro, known from its durable request id. */
  function isQuietSubmission(record: SubmissionRecord): boolean {
    const requestId = record.requestId ?? "";
    // `hiddenSubmissions` is latent: the only hidden sender (the self-intro) already has the
    // `intro:` prefix. Any future hidden sender needs a durable request-id prefix, because this
    // set is lost on restart.
    return requestId.startsWith("peer:") || isBotMessageRequestId(requestId) || requestId.startsWith("routine:") || requestId.startsWith(BOT_INTRO_REQUEST_PREFIX) || hiddenSubmissions.has(String(record.id));
  }

  function requireHost(): BotHarnessHost {
    if (host === null) throw new BotSessionError("unavailable");
    return host;
  }

  function remember(key: string, state: BotSessionState): BotSessionState {
    answered.set(key, state);
    if (answered.size > REQUEST_MEMORY) answered.delete(answered.keys().next().value!);
    return state;
  }

  function publish(botId: string, state: BotSessionState): BotSessionState {
    deps.onStateChange?.(botId, state);
    return state;
  }

  async function openBot(botId: string): Promise<{ conversation: Conversation; registry: BotRegistry }> {
    if (deleted.has(botId)) throw new BotSessionError("bot_deleted");
    const opened = await requireHost().open(botId);
    if (opened.recoveredCorruptFile !== undefined) {
      await writeNotice(opened.conversation, { notice: "session_reset", movedTo: opened.recoveredCorruptFile });
    }
    const registry = registries.get(botId);
    if (registry === undefined) throw new Error(`Bot ${botId} has no registry`);
    return { conversation: opened.conversation, registry };
  }

  async function executionSourceClaim(botId: string, opened: { harness: Harness; conversation: Conversation }, submissionId: string): Promise<BotExecutionClaim> {
    const id = Number(submissionId) as SubmissionId;
    if (!deps.execution || !Number.isSafeInteger(id) || id <= 0) throw new BotSessionError("spending_unconfirmed", "The interrupted work could not be verified.");
    const input = await (await opened.harness.submission(id, ctx))?.status(ctx);
    if (!input || input.type !== "input" || input.conversationId !== opened.conversation.id || input.status !== "placed" || !input.requestId || input.entry === undefined) throw new BotSessionError("spending_unconfirmed", "The interrupted work is not a placed accepted input.");
    const entry = await opened.conversation.commit((tx) => tx.entry(input.entry!), ctx), data = entry?.data as { executionClaimId?: unknown } | undefined;
    if (typeof data?.executionClaimId !== "string") throw new BotSessionError("spending_unconfirmed", "The interrupted work has no saved execution authority.");
    return deps.execution.getClaim(botId, data.executionClaimId, input.requestId);
  }

  async function writeNotice(conversation: Conversation, notice: BotNotice): Promise<void> {
    await conversation.submit({ type: "write", ...(notice.notice === "bot_message" ? {requestId: `bot-message-notice:${notice.requestId}`} : {}), entry: { kind: BOT_NOTICE_ENTRY_KIND, data: {...notice} } }, ctx);
  }

  /**
   * The Bot's pause for display. An unreadable pause file is reported and
   * reads as not paused here; every action reads the store itself and refuses
   * (`assertNotPaused`), so nothing runs on a guess.
   */
  async function pauseOf(botId: string): Promise<BotPauseRecord | undefined> {
    try {
      return await pauses.get(botId);
    } catch (error) {
      deps.onReport?.(botId, error);
      return undefined;
    }
  }

  /** Refuse while paused. An unreadable pause file refuses too (fail closed). */
  async function assertNotPaused(botId: string): Promise<void> {
    if ((await pauses.get(botId)) !== undefined) throw new BotSessionError("paused_by_person");
  }

  /** The submission of the turn waiting under a pause, without starting anything. */
  async function interruptedUnderPause(botId: string): Promise<string | undefined> {
    if (host === null || suspending.has(botId) || !host.isOpen(botId)) return undefined;
    const unfinished = unfinishedInput(await host.inspect(botId));
    return unfinished === undefined ? undefined : String(unfinished.id);
  }

  /** Current state without taking the per-Bot queue. */
  async function currentState(botId: string, resolveDefault = true): Promise<BotSessionState> {
    if (host === null) return { kind: "unavailable", reason: "held_by_live_process" };
    if (deleted.has(botId)) return { kind: "idle" };
    const pause = await pauseOf(botId);
    if (pause !== undefined) {
      const interrupted = await interruptedUnderPause(botId);
      return { kind: "paused", since: pause.since, by: pause.by, ...(interrupted === undefined ? {} : { interrupted }) };
    }
    if (host.isOpen(botId) && !suspending.has(botId)) {
      const inspection = await host.inspect(botId);
      const unfinished = unfinishedInput(inspection);
      if (unfinished !== undefined) {
        const submissionId = String(unfinished.id);
        if (inspection.scheduling === "paused") {
          const reason = blocked.get(botId);
          return { kind: "interrupted", submissionId, ...(reason === undefined ? {} : { blocked: reason }) };
        }
        return { kind: "running", submissionId };
      }
    }
    if (!resolveDefault) return { kind: "idle" };
    const model = await modelFor(botId);
    if (model.kind === "none") return { kind: "needs_model" };
    if (model.kind === "error") return { kind: "model_error", message: model.message };
    return { kind: "idle" };
  }

  async function modelFor(
    botId: string,
  ): Promise<{ kind: "ok"; ref: ModelRef } | { kind: "none" } | { kind: "error"; message: string; authority?: string }> {
    try {
      const ref = await deps.resolveModel(botId);
      return ref === null ? { kind: "none" } : { kind: "ok", ref };
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0 ? error.message : defaultMessage("model_error");
      const authority = authorityOf(error);
      return { kind: "error", message, ...(authority !== undefined ? { authority } : {}) };
    }
  }

  /**
   * Bind the Bot's current model and reload its extension before anything runs.
   * Preparation installs the attended set because a competing input can win
   * admission after the idle snapshot. Each request and call applies its own
   * ingress rules (`turnAllows` in `bot-extension.ts`).
   */
  async function prepareToRun(botId: string, conversation: Conversation, registry: BotRegistry): Promise<ModelRef> {
    const resolved = await modelFor(botId);
    if (resolved.kind === "none") throw new BotSessionError("needs_model");
    if (resolved.kind === "error") throw new BotSessionError("model_error", resolved.message, resolved.authority);
    const model = resolved.ref;
    await registry.refresh();
    const agent = await conversation.agent(ctx);
    if (agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId) {
      await conversation.configure({ model }, ctx);
    }
    return model;
  }

  /** Abort the paused turn without running it, and mark its partial answer interrupted. */
  async function dismissPaused(botId: string, conversation: Conversation, submissionId: string): Promise<void> {
    const host = await requireHost().open(botId), source = await (await host.harness.submission(Number(submissionId) as SubmissionId, ctx))?.status(ctx);
    const exact = await inspectLinkedBotWork(host.harness,conversation.id,submissionId);
    if ((exact.kind === "running" || exact.kind === "interrupted") && exact.inputSubmissionIds.length !== 1 && source?.requestId && await deps.hasPeerSource?.(botId,[source.requestId])) throw new BotSessionError("access_changed","This peer task shares inputs. Its Stop cannot isolate the other work.");
    const peer = source?.requestId ? await deps.onSourceStop?.(botId, [source.requestId]) : false;
    if (peer) { await stopLinkedBotWork(host.harness, conversation.id, submissionId); await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "interrupted", submissionId } }), ctx); }
    else { await conversation.abort(ctx); await writeNotice(conversation, { notice: "interrupted", submissionId }); }
  }

  /**
   * The outcome of a reply wait that ended before its submission settled. A
   * wait ends early only when its harness closes: a quit, a delete, or a
   * storage failure (pi-durable then closes the session for good, and the host
   * reopens it from what was committed). Only a turn that is still there,
   * paused, can be answered by a Resume; anything else is a failed reply, so
   * it is reported instead of waiting for a Resume that cannot come.
   */
  async function replyAfterFailedWait(botId: string, id: SubmissionId, harness: Harness): Promise<BotReplyOutcome> {
    let inspection: HarnessInspection;
    try {
      inspection = await harness.inspect(ctx);
    } catch {
      // Closing: once it has closed, the host has dropped a failed session.
      await harness.closed;
      if (deleted.has(botId)) return { kind: "interrupted", settled: true };
      try {
        inspection = await requireHost().inspect(botId);
      } catch (error) {
        // A runtime shut down by a quit re-checks the reply at the next start.
        if (error instanceof BotHarnessHostClosedError) return { kind: "interrupted" };
        return { kind: "failed", error: REPLY_LOST_MESSAGE };
      }
    }
    if (inspection.scheduling === "paused" && inspection.submissions.some((record) => record.id === id)) {
      return { kind: "interrupted" };
    }
    // A failed storage call may still have committed the settlement, which `inspect` no
    // longer lists: read it back from the reopened session before calling the reply lost.
    if (!inspection.submissions.some((record) => record.id === id)) {
      try {
        const reopened = await requireHost().open(botId);
        const record = await (await reopened.harness.submission(id, ctx))?.status(ctx);
        if (record?.status === "done" || record?.status === "unanswered") {
          return await settledOutcome(reopened.conversation, record as SettledSubmissionRecord);
        }
      } catch {
        // Still unreadable: the reply is lost.
      }
    }
    return { kind: "failed", error: REPLY_LOST_MESSAGE };
  }

  async function settledOutcome(conversation: Conversation, settled: SettledSubmissionRecord): Promise<BotReplyOutcome> {
    if (settled.status === "done" && settled.type === "input") {
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer!), ctx);
      return { kind: "completed", text: assistantText(answer?.model?.[0] as AssistantMessage | undefined) };
    }
    if (settled.reason === "aborted") return { kind: "interrupted", settled: true };
    // Pi's detail carries the provider's own words (`model_error` uses a string);
    // structured details such as `{ reason: "restart_limit" }` add nothing the
    // reason code does not already say.
    const detail = typeof settled.detail === "string" && settled.detail.trim() ? settled.detail : undefined;
    return {
      kind: "failed",
      error: settled.reason ?? "The reply failed.",
      ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  /** Whether the Bot's harness has work its scheduler is running now. */
  async function hasLiveWork(owner: BotHarnessHost, botId: string): Promise<boolean> {
    const inspection = await owner.inspect(botId);
    return inspection.scheduling === "running" && (inspection.tasks.length > 0 || inspection.submissions.length > 0);
  }

  /**
   * A pause whose close outlived its bound: reopen once the close finishes (the
   * host queues the open behind it) and publish the interrupted turn then.
   */
  function reopenAfterSuspend(owner: BotHarnessHost, botId: string): void {
    suspending.add(botId);
    void owner
      .inspect(botId)
      .catch((error: unknown) => deps.onReport?.(botId, error))
      .finally(() => {
        suspending.delete(botId);
        if (deleted.has(botId)) return;
        void currentState(botId).then(
          (state) => publish(botId, state),
          (error: unknown) => deps.onReport?.(botId, error),
        );
      });
  }

  async function lookupRequest(conversation: Conversation, requestId: string) {
    return conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), ctx);
  }

  const service: BotSessionRuntime = {
    async initialize() {
      if (host === null) return { removedOrphans: [], interrupted: [] };
      // Finish deletes a crash cut short before anything else sees the Bot.
      for (const botId of await readPendingDeletes(pendingDeletesFile)) {
        await service.deleteBot(botId).catch((error: unknown) => deps.onReport?.(botId, error));
      }
      const removedOrphans = await host.sweepOrphans(await deps.knownBotIds());
      const interrupted = await host.interruptedBots();
      for (const { botId } of interrupted) {
        publish(botId, await currentState(botId));
      }
      return { removedOrphans, interrupted: interrupted.map(({ botId }) => botId) };
    },

    async peerReceipt(botId, requestId, publication) {
      await publication?.assertCurrent();
      const opened = await openBot(botId), record = await lookupRequest(opened.conversation, requestId);
      await publication?.assertCurrent();
      if (!record || record.type !== "input") return undefined;
      const base = { submissionId: String(record.id), ...(record.entry === undefined ? {} : { entryId: String(record.entry) }) };
      if (record.status === "queued") return { ...base, state: "queued" };
      if (record.status === "unanswered") return { ...base, state: record.reason === "aborted" ? "cancelled" : "failed" };
      if (record.status === "done") { const answer = await opened.conversation.commit((tx) => tx.entry(record.answer), ctx), message = answer?.model?.[0]; return { ...base, state: "completed", resultEntryId: String(record.answer), ...(message?.role === "assistant" ? { responseDigest: botResponseDigest(message) } : {}) }; }
      const host = await requireHost().open(botId), exact = await inspectLinkedBotWork(host.harness, opened.conversation.id, String(record.id));
      return { ...base, state: exact.kind === "running" ? "running" : exact.kind === "queued" ? "queued" : "interrupted" };
    },

    async appendPeerRow(botId, eventId, raw, publication) {
      await publication?.assertCurrent();
      const data = parseBotPeerTranscriptData(raw), opened = await openBot(botId);
      await opened.conversation.commit(async (tx) => { await publication?.assertCurrent(); if (await tx.submissionByRequest(opened.conversation.id, eventId)) return; const pending = await tx.createSubmission({ conversationId: opened.conversation.id, requestId: eventId, type: "write", status: "queued" }), entry = await tx.appendEntry(opened.conversation.id, { kind: BOT_PEER_MESSAGE_ENTRY_KIND, data: JSON.parse(JSON.stringify(data)) }); await publication?.assertCurrent(); tx.placeSubmission(pending.id, entry.id); }, ctx);
    },

    async conversation(botId) {
      return (await openBot(botId)).conversation;
    },

    async quietInputs(botId, submissionIds) {
      const answers = new Map<string, boolean>();
      if (submissionIds.length === 0 || deleted.has(botId)) return answers;
      // `inspect`, not `open`: opening would consume a pending recovery notice that only a send reports.
      const inspection = await requireHost().inspect(botId);
      const wanted = new Set(submissionIds);
      for (const record of inspection.submissions) {
        const id = String(record.id);
        if (wanted.has(id)) answers.set(id, isQuietSubmission(record));
      }
      return answers;
    },

    async placedSubmissions(botId) {
      const placed = new Map<string, string>();
      if (deleted.has(botId)) return placed;
      const inspection = await requireHost().inspect(botId);
      for (const record of inspection.submissions) {
        if (record.type !== "input" || record.entry === undefined || isQuietSubmission(record)) continue;
        placed.set(String(record.entry), String(record.id));
      }
      return placed;
    },

    state(botId) {
      return currentState(botId);
    },

    routineState(botId) { return currentState(botId, false); },

    canRetryRoutineRequest(botId, requestId) {
      return serialize(botId, async () => {
        const { conversation } = await openBot(botId);
        return conversation.commit(async (tx) => {
          const record = await tx.submissionByRequest(conversation.id, requestId);
          if (record?.type !== "input" || record.status !== "unanswered") return false;
          if (record.entry === undefined) return true; // Settled before placement.
          if (!await tx.entry(record.entry)) return false;
          // A routine is placed as a follow-up. Pi creates its first generation
          // in the same commit, after all the inputs it serves. Entries and
          // tasks share a monotonically increasing ID space. Walk back to that
          // generation, ignoring later turns and including any co-placed inputs.
          const query = { conversationId: conversation.id, order: "descending" as const };
          const toolOwners = new Set<TaskId>();
          let safe = false;
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanTasks(query, 64, cursor);
            for (const task of page.items) {
              if (task.id < record.entry) return safe;
              if (task.kind === ToolTask.definition.name && task.owner) toolOwners.add(task.owner);
              if (task.kind === GenerationTask.definition.name) {
                // A completed generation may already have handed off to a
                // successor. An aborted one may have started a tool task.
                safe = task.state.status === "terminal" &&
                  (task.state.outcome.status === "failed" || task.state.outcome.status === "aborted") &&
                  !toolOwners.has(task.id);
              }
            }
            cursor = page.next;
          } while (cursor);
          return safe;
        }, ctx);
      });
    },

    submissionForRequest(botId, requestId) {
      return serialize(botId, async () => {
        const { conversation } = await openBot(botId);
        const existing = await lookupRequest(conversation, requestId);
        return existing === undefined ? undefined : String(existing.id);
      });
    },

    send(botId, input) {
      const routineOrigin = input.routineOrigin;
      let peer: ReturnType<typeof inspectBotPeerInputOrigin> | undefined;
      if (input.peerOrigin) { try { peer = inspectBotPeerInputOrigin(input.peerOrigin); if (peer.botId !== botId || peer.requestId !== input.requestId || input.hidden || routineOrigin || input.retryOf || !deps.execution || input.whenBusy === "steer") throw new Error("Invalid peer input"); } catch { return Promise.reject(new BotSessionError("access_changed", "The peer input origin could not be verified.")); } }
      if (routineOrigin && (!isIssuedBotRoutineInputOrigin(routineOrigin) || routineOrigin.botId !== botId || routineOrigin.runId !== input.requestId || input.hidden === true)) {
        return Promise.reject(new BotSessionError("access_changed", "The routine input origin could not be verified."));
      }
      if (input.routineTiming && (!routineOrigin || input.routineTiming.scheduledFor !== undefined && (!Number.isSafeInteger(input.routineTiming.scheduledFor) || input.routineTiming.scheduledFor < 0))) return Promise.reject(new BotSessionError("access_changed", "The routine occurrence could not be verified."));
      if (input.retryOf && routineOrigin?.kind !== "retry") return Promise.reject(new BotSessionError("access_changed", "The retry origin could not be verified."));
      if (deps.execution && input.whenBusy === "steer") return Promise.reject(new BotSessionError("model_error", "Send this message as a follow-up. Steering cannot mix independently bound model choices."));
      if (input.botMessage && (routineOrigin || input.peerOrigin || input.retryOf || input.routineTiming)) return Promise.reject(new TypeError("Bot messages cannot carry routine or peer provenance."));
      if (input.botMessage && (input.label !== undefined || input.hidden !== undefined)) return Promise.reject(new TypeError("Bot messages cannot be labelled or hidden."));
      const turn = botMessageTurnOf(input.requestId);
      if (isBotMessageRequestId(input.requestId) !== (input.botMessage !== undefined) || (input.botMessage && (
        (turn.kind !== "message" && turn.kind !== "reply") || turn.deliveryId !== input.botMessage.deliveryId ||
        (turn.kind === "message" ? input.botMessage.kind !== "request" || turn.fromBotId !== input.botMessage.botId : input.botMessage.kind !== "reply") ||
        !Number.isFinite(input.botMessage.deadline)))) return Promise.reject(new TypeError("Bot message provenance does not match the request."));
      return serialize(botId, async () => {
        const { conversation, registry } = await openBot(botId);
        const existing = await lookupRequest(conversation, input.requestId);
        if (existing !== undefined) return { submissionId: String(existing.id), deduped: true };
        if (input.botMessage && input.botMessage.deadline <= Date.now()) throw new BotSessionError("unavailable", "This Bot message expired.");
        // After the dedupe lookup, so a redelivered request still reports its submission.
        await assertNotPaused(botId);
        await peer?.assertCurrent();
        const spendingRefusal = await deps.spendingRefusal?.(botId);
        if (spendingRefusal !== undefined) throw new BotSessionError("spending_limit", spendingRefusal);

        const before = await currentState(botId, !deps.execution);
        if (before.kind === "interrupted" && (input.ifNotInterrupted || peer)) throw new BotSessionError("bot_paused");
        if (input.ifIdle && before.kind !== "idle") throw new BotSessionError("bot_busy");
        const execution = await deps.execution?.claim(botId, { requestId: input.requestId, ...(routineOrigin ? { routineOrigin } : {}), ...(input.peerOrigin ? { peerOrigin: input.peerOrigin } : {}), ...(input.routineTiming ?? {}), ...(input.retryOf ? { retryOf: input.retryOf } : {}), ...(botConnectorInventoryServer() ? { connectorServerId: botConnectorInventoryServer() } : {}), ...(botConnectorExecutionRestriction() ? { connectorRestriction: botConnectorExecutionRestriction() } : {}) });
        const model = execution && deps.execution
          ? await withBotExecutionAdmission(botId, execution, deps.execution, async () => {
            await registry.refresh();
            const admitted = botExecutionScope(botId)!.runtime.model;
            return { provider: admitted.provider, modelId: admitted.id };
          }, { allowFallback: true })
          : await prepareToRun(botId, conversation, registry);
        if (before.kind === "interrupted") {
          await dismissPaused(botId, conversation, before.submissionId);
          blocked.delete(botId);
        }
        if (input.label !== undefined && !peer) {
          await writeNotice(conversation, { notice: "routine", label: input.label, requestId: input.requestId });
        }
        if (input.hidden === true) {
          await writeNotice(conversation, { notice: "hidden_input", requestId: input.requestId });
        }
        await peer?.assertCurrent();
        if (input.botMessage && input.botMessage.deadline <= Date.now()) throw new BotSessionError("unavailable", "This Bot message expired.");
        if (input.botMessage) await writeNotice(conversation, {notice: "bot_message", requestId: input.requestId, ...input.botMessage});
        const submission = await conversation.submit(
          {
            type: "input",
            content: userContent(input),
            ...((execution || routineOrigin || peer || input.botMessage || input.label !== undefined) && { entry: { kind: input.botMessage ? BOT_MESSAGE_INPUT_KIND : peer ? BOT_PEER_INPUT_KIND : routineOrigin || input.label !== undefined ? BOT_ROUTINE_INPUT_KIND : BOT_PERSON_INPUT_KIND, data: { ...(input.botMessage ? { ...input.botMessage } : {}), ...(routineOrigin ? { routineOrigin: { ...routineOrigin } } : {}), ...(peer ? { peerOrigin: { ...peer.origin }, peerRequestId: input.requestId, peer: { exchangeId: peer.binding.exchangeId, direction: "received", peerBotId: peer.binding.senderBotId, peerName: peer.peerName, messageKind: peer.binding.kind === "return" ? "result" : peer.binding.kind } } : {}), ...(execution ? { [BOT_EXECUTION_INPUT_KEY]: execution.id } : {}) } } }),
            requestId: input.requestId,
            whenBusy: input.ifIdle ? "reject" : input.whenBusy ?? "followUp",
          },
          ctx,
        );
        if (execution) await deps.execution?.recordSubmission?.(botId, execution.id, String(submission.id));
        if (input.hidden === true) hiddenSubmissions.add(String(submission.id));
        // A routine's input, the hidden self-intro and another Bot's message are not
        // the person's message, and a steer joins the running turn, as a mid-turn
        // message does in a chat.
        const joinsRunningTurn = input.whenBusy === "steer" && before.kind === "running";
        if (input.label === undefined && input.hidden !== true && input.botMessage === undefined && !routineOrigin && !peer && !input.requestId.startsWith("tg:") && !joinsRunningTurn) {
          reportChatMessageSent({
            providerId: model.provider,
            model: model.modelId,
            origin: "bot",
            inWorkspace: () => false,
          });
        }
        requireHost().touch(botId);
        publish(botId, await currentState(botId));
        return { submissionId: String(submission.id), deduped: false };
      });
    },

    async executionResumeStatus(botId) {
      if (!deps.execution) return { requiresUnknownCostAcknowledgement: false };
      const opened = await requireHost().open(botId), tasks = (await opened.harness.inspect(ctx)).tasks;
      const before = await currentState(botId, false); if (before.kind !== "interrupted") return { requiresUnknownCostAcknowledgement: false };
      if (tasks.length > 256) throw new BotSessionError("access_changed");
      const scopeId = await botCostReceiptScope(opened.conversation);
      for (const { record } of tasks) await reconcileBotExecutionResponses(botId, String(record.id), scopeId, record.memos, deps.execution);
      const source = await executionSourceClaim(botId, opened, before.submissionId);
      const receipt = await deps.execution.unknownCostReceipt?.(botId, source, before.submissionId, scopeId);
      if (await deps.execution.hasUnknown?.(botId, source) && !receipt) throw new BotSessionError("spending_unconfirmed", "The unknown provider cost changed. Review it again before resuming.");
      const after = await currentState(botId, false); if (after.kind !== "interrupted" || after.submissionId !== before.submissionId) throw new BotSessionError("spending_unconfirmed", "The interrupted request changed. Review it again before resuming.");
      if (receipt) {
        const fresh = await deps.execution.unknownCostReceipt?.(botId, source, before.submissionId, scopeId);
        if (!/^cost_[a-f0-9]{64}$/u.test(receipt.costReceiptId) || fresh?.costReceiptId !== receipt.costReceiptId || fresh.dispatchId !== receipt.dispatchId) throw new BotSessionError("spending_unconfirmed", "The unknown provider cost changed. Review it again before resuming.");
        return { requiresUnknownCostAcknowledgement: true, interruptedSubmissionId: before.submissionId, costReceiptId: receipt.costReceiptId };
      }
      return { requiresUnknownCostAcknowledgement: false, interruptedSubmissionId: before.submissionId };
    },

    resume(botId, requestId, options) {
      return serialize(botId, async () => {
        const { conversation: controlConversation } = await openBot(botId);
        const current = await currentState(botId, false);
        let decision: "new" | "replayed";
        try { decision = await consumeBotResumeOperation(controlConversation, requestId, options, current.kind === "interrupted" ? current.submissionId : current.kind === "paused" ? current.interrupted : undefined, (deps.now ?? Date.now)(), () => assertNotPaused(botId)); }
        catch (error) { if (error instanceof BotSessionError) throw error; throw new BotSessionError("model_error", error instanceof Error ? error.message : "This Resume decision could not be confirmed."); }
        if (decision === "replayed") return currentState(botId, false);
        const before = await currentState(botId, false);
        if (current.kind !== "interrupted" || before.kind !== "interrupted" || before.submissionId !== current.submissionId) return before;
        if (options?.acknowledgeUnknownCost === true && (!options.expectedSubmissionId || !/^[1-9][0-9]{0,31}$/u.test(options.expectedSubmissionId) || options.expectedSubmissionId !== before.submissionId || !options.expectedCostReceiptId || !/^cost_[a-f0-9]{64}$/u.test(options.expectedCostReceiptId))) throw new BotSessionError("spending_unconfirmed", "The interrupted request or cost receipt changed. Review it before resuming.");

        const opened = await requireHost().open(botId);
        if (deps.execution) {
          const { conversation, registry } = await openBot(botId);
          const tasks = (await opened.harness.inspect(ctx)).tasks;
          const scopeId = await botCostReceiptScope(opened.conversation);
          for (const { record } of tasks) await reconcileBotExecutionResponses(botId, String(record.id), scopeId, record.memos, deps.execution);
          if (tasks.length > 256) throw new BotSessionError("access_changed", "Too much unfinished work is waiting for review.");
          const bindings = await Promise.all(tasks.map(async ({ record }) => ({ id: record.id, kind: record.kind, binding: await opened.harness.snapshot(BotExecutionDoc, record.id, ctx) })));
          const live = await opened.harness.snapshot(LiveDoc, conversation.id, ctx);
          const source = await executionSourceClaim(botId, opened, before.submissionId);
          const verifiedConsent = async (item: typeof bindings[number], consent: NonNullable<typeof item.binding>["costConsent"]) => Boolean(consent && item.binding?.claimId && consent.version === 1 && consent.submissionId === before.submissionId && consent.sourceClaimId === source.id && consent.sourceRequestId === source.requestId && consent.scopeId === scopeId && consent.fromGeneration === (item.binding.dispatchGeneration ?? 0) && consent.toGeneration === consent.fromGeneration + 1 && /^cost_[a-f0-9]{64}$/u.test(consent.costReceiptId) && consent.approvalId && await deps.execution!.verifyCostApproval?.(consent.approvalId, botCostApprovalFacts(botId, String(item.id), item.binding.claimId, consent)));
          if (options?.acknowledgeUnknownCost === true) {
            const receipt = await deps.execution.unknownCostReceipt?.(botId, source, before.submissionId, scopeId);
            let prior = false; for (const item of bindings) { const candidate = item.binding?.costConsent; if (candidate && candidate.costReceiptId === options.expectedCostReceiptId && await verifiedConsent(item, candidate)) prior = true; }
            if (receipt?.costReceiptId !== options.expectedCostReceiptId && !prior) throw new BotSessionError("spending_unconfirmed", "The unknown provider cost changed. Review the current receipt before resuming.");
          }
          const waitingForCostOwner: TaskId[] = [];
          for (const item of bindings) {
            let binding = item.binding;
            if (!binding?.claimId && item.kind === GenerationTask.definition.name && live?.run?.taskId === item.id && live.run.inputs.length === 1) {
              const input = await (await opened.harness.submission(live.run.inputs[0]!, ctx))?.status(ctx);
              const entry = input?.entry === undefined ? undefined : await conversation.commit((tx) => tx.entry(input.entry!), ctx);
              const data = entry?.data as { executionClaimId?: unknown } | undefined;
              if (typeof data?.executionClaimId === "string" && input?.requestId) {
                binding = { claimId: data.executionClaimId, requestId: input.requestId, sourceInputs: [...live.run.inputs] };
                await conversation.commit(async (tx) => { const target = await tx.doc(BotExecutionDoc, item.id); Object.assign(target, binding); }, ctx);
              }
            }
            if (!binding?.claimId || !binding.requestId) throw new BotSessionError("access_changed", "This unfinished task has no saved model choice. Dismiss it and send the request again.");
            const claim = await deps.execution.getClaim(botId, binding.claimId, binding.requestId);
            await withBotExecutionAdmission(botId, claim, deps.execution, () => registry.refresh());
            const unknown = deps.execution.hasUnknown ? await deps.execution.hasUnknown(botId, claim) : binding.blocked?.kind === "spending_unknown";
            let consent = binding.costConsent;
            if (consent && !await verifiedConsent({ ...item, binding }, consent)) { if (options?.acknowledgeUnknownCost !== true) throw new BotSessionError("spending_unconfirmed", "The saved cost decision has no protected owner approval. Review the current receipt before resuming."); consent = undefined; }
            if (unknown && !consent) {
              const receipt = await deps.execution.unknownCostReceipt?.(botId, source, before.submissionId, scopeId), dispatchId = receipt?.dispatchId;
              if (!dispatchId || !receipt || !/^cost_[a-f0-9]{64}$/u.test(receipt.costReceiptId)) throw new BotSessionError("spending_unconfirmed", "The earlier provider request could not be identified. Review the work before resuming.");
              const owner = bindings.find((candidate) => candidate.binding?.dispatchIds?.includes(dispatchId));
              if (owner && owner.id !== item.id) { if (options?.acknowledgeUnknownCost !== true && (owner.binding?.costConsent?.dispatchId !== dispatchId || !await verifiedConsent(owner, owner.binding.costConsent))) throw new BotSessionError("spending_unconfirmed"); waitingForCostOwner.push(item.id); continue; }
              if (options?.acknowledgeUnknownCost !== true) throw new BotSessionError("spending_unconfirmed");
              if (options.expectedCostReceiptId !== receipt.costReceiptId) throw new BotSessionError("spending_unconfirmed", "The unknown provider cost changed. Review the current receipt before resuming.");
              const proposed = { version: 1 as const, requestId, submissionId: before.submissionId, dispatchId, costReceiptId: receipt.costReceiptId, sourceClaimId: source.id, sourceRequestId: source.requestId, scopeId, fromGeneration: binding.dispatchGeneration ?? 0, toGeneration: (binding.dispatchGeneration ?? 0) + 1 };
              const approvalId = await deps.execution.approveCost?.(botCostApprovalFacts(botId, String(item.id), binding.claimId, proposed));
              if (!approvalId) throw new BotSessionError("spending_unconfirmed", "The owner cost approval could not be protected. Retry with the current receipt.");
              consent = { ...proposed, approvalId };
              const accepted = consent;
              await conversation.commit(async (tx) => { const current = await tx.doc(BotExecutionDoc, item.id); if (current.claimId !== binding!.claimId || current.requestId !== binding!.requestId || (current.dispatchGeneration ?? 0) !== accepted.fromGeneration || JSON.stringify(current.costConsent) !== JSON.stringify(binding!.costConsent)) throw new BotSessionError("spending_unconfirmed"); current.costConsent = accepted; }, ctx);
            }
            if (consent) {
              // A protected owner approval anchors this exact source-bound
              // intent. Recover only its original ledger acknowledgement;
              // never select another pending receipt.
              if (!await verifiedConsent({ ...item, binding }, consent)) throw new BotSessionError("spending_unconfirmed", "The protected owner cost approval is unavailable.");
              const outcome = await deps.execution.acknowledgeUnknown?.(botId, claim, consent.dispatchId);
              if (!outcome) throw new BotSessionError("spending_unconfirmed", "The saved cost decision could not be reconciled. Retry this action to check its outcome.");
              const accepted = consent;
              await conversation.commit(async (tx) => { const current = await tx.doc(BotExecutionDoc, item.id); if (current.claimId !== binding!.claimId || current.requestId !== binding!.requestId || JSON.stringify(current.costConsent) !== JSON.stringify(accepted) || (current.dispatchGeneration ?? 0) !== accepted.fromGeneration) throw new BotSessionError("spending_unconfirmed"); current.dispatchGeneration = outcome === "recorded" ? accepted.fromGeneration : accepted.toGeneration; current.costDecision = accepted; delete current.costConsent; delete current.blocked; }, ctx);
            } else if (binding.blocked) await conversation.commit(async (tx) => { delete (await tx.doc(BotExecutionDoc, item.id)).blocked; }, ctx);
          }
          for (const taskId of waitingForCostOwner) await conversation.commit(async (tx) => { delete (await tx.doc(BotExecutionDoc, taskId)).blocked; }, ctx);
          blocked.delete(botId); opened.harness.resume(); deps.onResumed?.(botId); requireHost().touch(botId);
          return publish(botId, await currentState(botId, false));
        }
        const readmission: BotReadmission = await deps.extension.readmit(botId);
        if (!readmission.ok) {
          blocked.set(botId, readmission.reason);
          return publish(botId, await currentState(botId));
        }
        blocked.delete(botId);
        const { conversation, registry } = await openBot(botId);
        if (!deps.execution) await prepareToRun(botId, conversation, registry);
        opened.harness.resume();
        deps.onResumed?.(botId);
        requireHost().touch(botId);
        return publish(botId, await currentState(botId));
      });
    },

    dismiss(botId, requestId) {
      const key = `dismiss:${botId}:${requestId}`;
      return serialize(botId, async () => {
        const replay = answered.get(key);
        if (replay !== undefined) return replay;
        await assertNotPaused(botId);
        const before = await currentState(botId);
        if (before.kind !== "interrupted") return remember(key, before);
        const { conversation, registry } = await openBot(botId);
        // Pending tool calls settle against the Bot's tools while aborting.
        if (!deps.execution) await registry.refresh().catch(() => undefined);
        await dismissPaused(botId, conversation, before.submissionId);
        deps.onStopped?.(botId);
        blocked.delete(botId);
        return remember(key, publish(botId, await currentState(botId)));
      });
    },

    stop(botId) {
      return serialize(botId, async () => {
        const before = await currentState(botId);
        if (before.kind !== "running") return before;
        const { conversation } = await openBot(botId), host = await requireHost().open(botId), live = await host.harness.snapshot(LiveDoc, conversation.id, ctx), sources = await Promise.all((live?.run?.inputs ?? []).map(async (id) => (await (await host.harness.submission(id, ctx))?.status(ctx))?.requestId));
        const requestIds = sources.filter((id):id is string=>id!==undefined);
        if (live?.run && live.run.inputs.length !== 1 && await deps.hasPeerSource?.(botId,requestIds)) throw new BotSessionError("access_changed","This peer task shares inputs. Use its linked exchange Stop to preserve the other work.");
        const peer = await deps.onSourceStop?.(botId, requestIds);
        if (peer) { if (live?.run?.inputs.length !== 1) throw new BotSessionError("access_changed", "This peer task shares inputs. Use its linked exchange Stop to preserve the other work."); await stopLinkedBotWork(host.harness, conversation.id, String(live.run.inputs[0]), { intentId: `peer-source-stop:${live.run.taskId}`, mayContinue: async () => !shuttingDown && !await pauses.get(botId) && !deleted.has(botId) && !suspending.has(botId) }); }
        else await conversation.abort(ctx);
        deps.onStopped?.(botId);
        return publish(botId, await currentState(botId));
      });
    },

    async inspectLinkedWork(botId, submissionId) {
      const opened = await openBot(botId);
      const host = await requireHost().open(botId);
      return inspectLinkedBotWork(host.harness, opened.conversation.id, submissionId);
    },

    async readLinkedWorkEvidence(botId, submissionId, kind, publication) {
      await publication?.assertCurrent();
      const opened = await openBot(botId);
      const host = await requireHost().open(botId);
      await publication?.assertCurrent();
      const evidence=await readLinkedBotWorkEvidence(host.harness, opened.conversation.id, submissionId, kind);
      await publication?.assertCurrent();return evidence;
    },

    stopLinkedWork(botId, submissionId, intentId, publication) {
      return serialize(botId, async () => {
        await publication?.assertCurrent();
        const opened = await openBot(botId);
        const host = await requireHost().open(botId), sourceId = Number(submissionId), record = /^[1-9][0-9]{0,31}$/u.test(submissionId) && Number.isSafeInteger(sourceId) ? await (await host.harness.submission(sourceId as SubmissionId, ctx))?.status(ctx) : undefined;
        const exact = await inspectLinkedBotWork(host.harness,opened.conversation.id,submissionId);
        if ((exact.kind === "running" || exact.kind === "interrupted") && (exact.inputSubmissionIds.length !== 1 || exact.inputSubmissionIds[0] !== submissionId)) return "mixed_inputs";
        await publication?.assertCurrent();
        if (record?.conversationId === opened.conversation.id && record.requestId) await deps.onSourceStop?.(botId, [record.requestId]);
        await publication?.assertCurrent();
        return stopLinkedBotWork(host.harness, opened.conversation.id, submissionId, { intentId, mayContinue: async () => {
          const paused = await pauses.get(botId);
          return !shuttingDown && !paused && !deleted.has(botId) && !suspending.has(botId);
        } });
      });
    },

    withdraw(botId, submissionId) {
      return serialize(botId, async () => {
        const id = Number(submissionId);
        // A rounded id could name a different submission.
        if (!Number.isSafeInteger(id)) return "gone";
        await openBot(botId);
        const opened = await requireHost().open(botId);
        const result = await opened.harness.abortSubmission(
          id as SubmissionId,
          ctx,
          opened.conversation.id,
        );
        if (result === "aborted") return "withdrawn";
        return result === "already_placed" ? "started" : "gone";
      });
    },

    deleteBot(botId) {
      return serialize(botId, async () => {
        // Another process holding the profile owns the session; erasing the
        // Bot's data underneath it would orphan a live harness.
        const owner = requireHost();
        deleted.add(botId);
        blocked.delete(botId);
        // Durable before the first destructive step, so a crash anywhere below
        // is finished at the next start instead of leaving a Bot half deleted.
        await recordPendingDelete(botId, true);
        await deps.beforeDelete?.(botId);
        await owner.destroy(botId);
        registries.delete(botId);
        for (const effect of deps.deleteEffects ?? []) await effect(botId);
        await recordPendingDelete(botId, false);
      });
    },

    async awaitMessageTaskSettlement(botId, taskId, signal) {
      if (signal.aborted || deleted.has(botId)) return false;
      const id = Number(taskId) as TaskId;
      if (!Number.isSafeInteger(id)) return false;
      const owner = requireHost();
      // Inspection keeps a corrupt-session recovery notice for the next real
      // open. A task absent from the live graph cannot replay, including after
      // recovery replaced its session with an empty one.
      const inspection = await owner.inspect(botId);
      const live = inspection.tasks.find((task) => task.record.id === id)?.record;
      if (!live) return true;
      if (live.kind !== ToolTask.definition.name) return false;
      if (signal.aborted || deleted.has(botId)) return false;
      const opened = await owner.open(botId);
      if (opened.recoveredCorruptFile !== undefined) {
        await writeNotice(opened.conversation, {
          notice: "session_reset",
          movedTo: opened.recoveredCorruptFile,
        });
      }
      const record = await opened.harness.getTask(id, ctx);
      if (live.conversationId !== opened.conversation.id) return false;
      if (!record) return true;
      if (
        record.kind !== ToolTask.definition.name ||
        record.conversationId !== opened.conversation.id
      )
        return false;
      if (
        record.state.status === "terminal" ||
        record.state.status === "completing"
      )
        return true;
      const { context, cancel } = withCancel(ctx);
      const onAbort = () => cancel(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const watch = await opened.harness.watchTaskGraph(context);
        try {
          return await new Promise<boolean>((resolve) => {
            const check = (graph: typeof watch.value) => {
              const task = graph.tasks[taskId];
              if (!task || task.state.status === "completing") resolve(true);
            };
            check(watch.value);
            watch.start(async (call) => {
              if (call.kind === "value") check(call.value);
            });
            void watch.closed.then(() => resolve(false));
          });
        } finally {
          await watch.stop();
        }
      } catch (error) {
        if (!signal.aborted) throw error;
        return false;
      } finally {
        signal.removeEventListener("abort", onAbort);
        cancel();
      }
    },

    async awaitReply(botId, submissionId, signal) {
      if (deleted.has(botId)) return { kind: "interrupted", settled: true };
      const opened = await requireHost().open(botId);
      const id = Number(submissionId) as SubmissionId;
      if (!Number.isSafeInteger(id)) return { kind: "failed", error: "This reply is no longer tracked." };
      const submission = await opened.harness.submission(id, ctx);
      if (submission === undefined) return { kind: "failed", error: "This reply is no longer tracked." };
      // `wait()` would start a paused scheduler, which is Resume's decision.
      const inspection = await opened.harness.inspect(ctx);
      if (inspection.scheduling === "paused" && inspection.submissions.some((record) => record.id === id)) {
        return { kind: "interrupted" };
      }
      const { context, cancel } = withCancel(ctx);
      const onAbort = () => cancel(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      let settled: Awaited<ReturnType<typeof submission.wait>>;
      try {
        settled = await submission.wait(context);
      } catch (error) {
        if (signal.aborted) throw error;
        return await replyAfterFailedWait(botId, id, opened.harness);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      try {
        return await settledOutcome(opened.conversation, settled);
      } catch (error) {
        // Pi Durable 1.5 settles a wait from the adopted commit while it is still
        // being stored, so the store can fail after the wait returned: read the
        // answer back from the reopened session, as for a wait the failure ended.
        if (!(error instanceof SessionFailed)) throw error;
        return await replyAfterFailedWait(botId, id, opened.harness);
      }
    },

    compact(botId) {
      return serialize(botId, async () => {
        // Compaction starts the scheduler, which would run an interrupted turn.
        await assertNotPaused(botId);
        const { conversation, registry } = await openBot(botId);
        if (deps.execution) {
          const execution = await deps.execution.claim(botId, { requestId: `compaction:${randomUUID()}` });
          await withBotExecutionAdmission(botId, execution, deps.execution, () => registry.refresh());
          await conversation.commit(async (tx) => {
            const taskId = await tx.createTask(CompactionTask, { reason: "manual" as const, ...(deps.compactionInstructions ? { instructions: deps.compactionInstructions } : {}) }, { ownership: { kind: "conversation" }, conversationId: conversation.id });
            await stampBotExecutionTask(tx, taskId, execution);
            const live = await tx.doc(LiveDoc, conversation.id); live.compactions = [...live.compactions ?? [], { taskId, trigger: "manual" as const, blocking: false, attempt: 1 }].sort((a, b) => a.taskId - b.taskId);
          }, ctx);
          (await requireHost().open(botId)).harness.resume();
        } else {
          await prepareToRun(botId, conversation, registry);
          await conversation.compact(deps.compactionInstructions, ctx);
        }
        requireHost().touch(botId);
      });
    },

    async markSilent(botId, submissionId) {
      // Appended, not submitted: the Bot may have been paused or interrupted
      // since this reply settled, and a write submission would resume it.
      await service.appendEntry(botId, BOT_NOTICE_ENTRY_KIND, { notice: "silent", submissionId });
    },

    async appendEntry(botId, kind, data) {
      // Scheduler hooks and Resume/Dismiss may await issue settlement while the
      // command lane is held. Metadata writes use their own SQLite transaction
      // so they cannot queue behind the operation waiting for them.
      const { conversation } = await openBot(botId);
      const effectId = data && typeof data === "object" && !Array.isArray(data) ? data.effectId : undefined;
      await conversation.commit(async tx => {
        if (deleted.has(botId)) throw new BotSessionError("bot_deleted");
        if (shuttingDown) throw new Error("The Bot runtime is shutting down.");
        if (typeof effectId === "string") {
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanEntries({ conversationId: conversation.id }, 500, cursor);
            if (page.items.some(entry => entry.kind === kind && (entry.data as { effectId?: string } | undefined)?.effectId === effectId)) return;
            cursor = page.next;
          } while (cursor !== undefined);
        }
        // Deletion can begin while an idempotency scan awaits storage.
        if (deleted.has(botId)) throw new BotSessionError("bot_deleted");
        if (shuttingDown) throw new Error("The Bot runtime is shutting down.");
        await tx.appendEntry(conversation.id, { kind, data });
      }, ctx);
    },

    pause(botId, by) {
      return serialize(botId, async () => {
        if (deleted.has(botId)) throw new BotSessionError("bot_deleted");
        const owner = requireHost();
        // Durable first: whatever happens below, the Bot stays paused.
        await pauses.pause(botId, by);
        try {
          await deps.onPaused?.(botId);
        } catch (error) {
          deps.onReport?.(botId, error);
        }
        // A close or reopen that fails is reported, never raised: the pause is
        // already durable, so the Bot's other work still stops and every window hears it.
        try {
          if (owner.isOpen(botId) && !suspending.has(botId) && (await hasLiveWork(owner, botId))) {
            const outcome = await owner.suspend(botId, deps.suspendTimeoutMs);
            if (outcome === "timed_out") reopenAfterSuspend(owner, botId);
            // Reopen: the closed turn is read back as interrupted and nothing is scheduled.
            else if (outcome === "closed") await owner.inspect(botId);
          }
        } catch (error) {
          deps.onReport?.(botId, error);
        }
        try {
          await deps.afterPaused?.(botId);
        } catch (error) {
          deps.onReport?.(botId, error);
        }
        return publish(botId, await currentState(botId));
      });
    },

    async unpause(botId) {
      const { state, record } = await serialize(botId, async () => {
        const cleared = await pauses.unpause(botId);
        return { state: publish(botId, await currentState(botId)), record: cleared };
      });
      // Outside the queue: the hook may append entries to this Bot.
      if (record !== undefined) {
        try {
          await deps.onUnpaused?.(botId, record);
        } catch (error) {
          deps.onReport?.(botId, error);
        }
      }
      return state;
    },

    async shutdown() {
      shuttingDown = true;
      await host?.shutdown();
    },
  };
  return service;
}

import { botMessageTurnOf, isBotMessageRequestId } from "../../../renderer/shared/bot-messages.js";
import { BOT_MESSAGE_INPUT_KIND, type BotMessageInputMetadata } from "./bot-input-entry.js";
import { BOT_ROUTINE_INPUT_KIND } from "./bot-input-entry.js";
import { botExecutionScope } from "./bot-execution.js";
// The `aiden-bot` Pi Durable extension: everything a Bot turn needs from
// Aiden, installed in a Bot harness's registry before anything can run.
//
// - System prompt: the Bot's sections in the order base, persona (the soul),
//   authority, connection guidance, then memory, rendered verbatim (Aiden
//   already escapes and tags their content). Sections are built after the
//   tools, so the base prompt and MCP guidance describe exactly the tools
//   offered. Memory renders before every request from the memory service's
//   frozen snapshot and goes last, because it changes most often.
// - Tools: Aiden tools adapted by `tool-adapter.ts`, rebuilt from the current
//   inventory on every `refresh()` (each submit and Resume). MCP tools are
//   never replay-safe; the caller declares replay for the rest.
// - Policy: `beforeTool` re-checks the Bot's current policy at every call and
//   blocks a disallowed tool without running it.
// - Codemode: when the Bot has connection, file, shell or lookup tools, Pi
//   Durable's `codemode` tool lets the model script them (batch calls, filter
//   results). Each call a script makes is a durable nested tool call: it passes
//   the same `beforeTool` ingress, policy and approval checks as a direct call,
//   and its approval wait survives a restart like a direct one. A call a rule
//   hands to the person is refused, so the model makes it directly and the
//   person gets the card. Scripts never reach cards, the Bot's own computer or
//   browser, routines or subagents (those tools are `callers: ["model"]`).
// - Ingress: preparation installs the attended set because admission can race.
//   Each request and each
//   call reads which inputs its run serves (`pi.live.run`, durable, so a
//   queued or restarted input keeps its own sender) and withholds what those
//   inputs may not use (routine and Telegram turns get no question card), so a
//   turn never inherits the tools of whoever sent last.
// - Images: a model without image input gets text references in place of the
//   person's images, for that request only (see `bot-images.ts`).
// - Approvals: an approval-gated call asks through `requestApproval` with a
//   `waitId` persisted in the tool task's memo, so a restart re-asks the same
//   approval instead of minting a new one.
// - Rule hand-offs (plan §4.4): when the Bot's rules hand a call to the person,
//   the call never runs. A hand-off card opens under the same memo's `waitId`
//   (kind "handoff"); the answer is kept in its own memo and applied exactly
//   once, even across a crash: the transcript row (`recordHandoff`) and the
//   block text the model reads.
// - Authority: the first request after the harness opens re-admits the Bot and
//   fails closed (no provider request) when its access changed.
// - Memory: a final answer notifies the background review (`afterReply`)
//   without waiting for it; a compaction asks `beforeCompact` first, which
//   flushes memory and may supply a steered summary. `memoryOffered` gates
//   the flush by the current run; the compacted conversation is handed over
//   too, so the flush also reads each historical entry's own ingress.
// - Hooks (docs/plans/aiden-hooks-plan.md §7, `hooks` dep): the person's
//   global and Bot hooks run in the Bot's folder. PreToolUse runs only after
//   the Bot's rules allow a call, so a hook can block it or ask for approval
//   but never loosen a rule; on an unattended turn an ask blocks. PostToolUse
//   adds its context after the result, Stop may continue the run (capped),
//   PreCompact observes and SessionStart opens each process's first request.
//   Every hook's answer is kept in the task's memo, so a durable replay never
//   runs the hook again.

import type { BotApprovalRuleTarget } from "../../../renderer/shared/tool-approval-scope.js";
import type { BrowserApprovalTarget } from "../browser/approval.js";
import type { BotPlanPermit, BotPlans } from "../bot-plans/plans.js";
import type { BotApprovalDecision } from "./bot-approval-tallies.js";
export type { BotApprovalAnswer, BotApprovalDecision } from "./bot-approval-tallies.js";
import { botApprovalRuleKey } from "../../../renderer/shared/tool-approval-scope.js";
import { createHash, randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CodemodeSandbox, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import {
  CompactionTask,
  createRegistry,
  type Conversation,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  section,
  ToolTask,
  type CompactionHooks,
  type ConversationId,
  type DocumentReader,
  type EntryRecord,
  type Extension,
  type Harness,
  type HookApi,
  type Registry,
  type ToolHookCall,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import type {
  BotHandoffAnswer,
  BotHandoffOutcome,
  BotHandoffResultDetails,
  BotHandoffRule,
} from "../../../renderer/shared/bot-handoffs.js";
import { handoffSkippedText, ruleHandoffDoneBlock, ruleUnattendedBlock } from "./bot-handoff-text.js";
import {
  BOT_BROWSER_SNAPSHOT_IMAGES_KEPT,
  BOT_COMPUTER_CAPTURE_IMAGES_KEPT,
  BOT_OLDER_COMPUTER_CAPTURE_NOTE,
  withImageReferences,
  withNewestToolImages,
} from "./bot-images.js";
import { BOT_COMPUTER_TOOL_NAME } from "../bot-computers/types.js";
import { withheldUntilDisclosed } from "./bot-tool-disclosure.js";
import { LOAD_TOOLS_TOOL_NAME, createOnDemandTools, withheldUntilLoaded } from "../on-demand-tools.js";
import { adaptAidenTool, type BotToolCall, type DurableTool, type ToolReplay } from "./tool-adapter.js";
import { isPiCodemodeCallable } from "../pi-runtime-tool.js";
import {
  MAX_STOP_HOOK_CONTINUATIONS,
  botHooksWithoutFolder,
  botSurfaceHooks,
  hookAskText,
  hookBlockText,
  hookContextText,
  hookNoticeLines,
  hookPostToolAdditions,
  hookStopContinuation,
  hookToolPayload,
  type SurfaceHooks,
} from "../agent-surface-hooks.js";
import { toolCallIdempotencyKey } from "../hooks/hook-config.js";
import type { HookDispatcher } from "../hooks/hook-types.js";

export const BOT_EXTENSION_NAME = "aiden-bot";
/** Section keys, in render order. */
export const BOT_SECTION_KEYS = ["aiden-base", "aiden-persona", "aiden-authority", "aiden-guidance", "aiden-memory"] as const;
/** The tool whose offer decides how the memory section reads. */
const MEMORY_TOOL_NAME = "bot_memory";
const APPROVAL_MEMO = "aiden.approval";
export const BOT_EXECUTION_ID_MEMO = "aiden.execution.id";
const EXECUTION_ID_MEMO = BOT_EXECUTION_ID_MEMO;
const PLAN_EXECUTION_MEMO = "aiden.execution.plan";
const NESTED_EXECUTION_MEMO = "aiden.execution.nested";
const INPUT_IDENTITY_ENTRY = "aiden.bot-input-identity";
/** The person's answer to a rule hand-off, kept until the call's block is recorded. */
const HANDOFF_ANSWER_MEMO = "aiden.handoff.answer";
/** A PreToolUse hook's answer for this call, so a replay never asks the hook again. */
const PRE_TOOL_HOOK_MEMO = "aiden.hook.pre";
/** The wait a hook's ask opened for this call. */
const HOOK_ASK_MEMO = "aiden.hook.ask";
/** The person allowed this call on a hook's card. */
const HOOK_ASK_ALLOWED_MEMO = "aiden.hook.ask.allowed";
/** A PostToolUse hook's additions for this call. */
const POST_TOOL_HOOK_MEMO = "aiden.hook.post";
/** A Stop hook's continuation (or none) for this generation. */
const STOP_HOOK_MEMO = "aiden.hook.stop";
/** Runs whose Stop continuations are counted at once; older counts are dropped. */
const MAX_COUNTED_STOP_RUNS = 64;
export const BOT_CODEMODE_TOOL_NAME = "codemode";
/** Lookups a script may call besides workspace, connection and codemode-marked tools. */
const BOT_SCRIPT_LOOKUPS: ReadonlySet<string> = new Set(["web_search", "bot_recall"]);
/** VM heap per script; the worker shares the app's process. */
const BOT_SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024;
/** Estimated tokens of tool declarations the `codemode` section lists; the tools are declared directly too. */
const BOT_SCRIPT_INLINE_BUDGET = 1_000;

/** Whether a Bot script may call this tool. Cards, computers, browsers, routines and subagents are direct only. */
function scriptCallable(entry: BotToolEntry): boolean {
  if (entry.tool.name === BOT_CODEMODE_TOOL_NAME) return false;
  return entry.mcp === true || isPiCodemodeCallable(entry.tool) || BOT_SCRIPT_LOOKUPS.has(entry.tool.name);
}

/** A rule hand-off can't open from inside a script: the model makes the call itself. */
export function scriptHandoffBlock(toolName: string): string {
  return `A rule hands ${toolName} to the person. Call ${toolName} directly, not from codemode, so they get the card.`;
}

/** Private authorization evidence. Never projected into renderer/Remote prompts. */
export interface BotApprovalRequirements {
  target: BotApprovalRuleTarget;
  requirementsFingerprint: string;
  consentRevision: string;
  authorizationFingerprint: string;
  matchedRuleId?: string;
}

export interface BotApprovalEvidence {
  requirementsFingerprint: string;
  authorizationFingerprint: string;
}
export interface BotAllowListRelease {
  target: BotApprovalRuleTarget;
  ruleId: string;
  consentRevision: string;
}
/** Original prompt evidence is captured before waiting. Task 5 must compare its
 * consentRevision atomically at first publication; current-book reads cannot replace it. */
export interface BotApprovalSettlementInput {
  botId: string;
  /** Host-owned turn routing. Bot-message replies cannot deliver the nudge to the person. */
  hintEligible?: boolean;
  remember: NonNullable<BotApprovalRequirement["remember"]>;
  requirements?: BotApprovalRequirements;
  decision: BotApprovalDecision;
}
/** Ephemeral main-only guard. Invoke only for first publication, after exact
 * prior-operation replay lookup and inside its atomic update. Never retain it
 * or invoke it after publication has intentionally changed consentRevision. */
export interface BotApprovalSettlementContext {
  validatePublication?(): Promise<void>;
}
export interface BotApprovalSettlement {
  hint?: string;
  publication?: BotAllowListRelease;
}
export interface BotApprovalRequirement {
  evidence?: BotApprovalEvidence;
  allowFromList?(grant: BotAllowListRelease): Promise<void>;
  /** Fresh ordinary policy only, never C coverage or D usage. */
  revalidate?(): Promise<BotApprovalRequirement | undefined>;
  remember?: { target: BotApprovalRuleTarget; title: string; offer?: { count: number } };
  requirements?: BotApprovalRequirements;
  summary: string;
  /**
   * Runs after the person allows, before the tool executes (for example to
   * bind a Computer Use grant to this call). A throw blocks the call.
   */
  onAllow?(): void | Promise<void>;
  /** The rule that made (or also covers) this ask. */
  rule?: BotHandoffRule;
  /**
   * The person's Settings → Bots & Approvals lets this routine run go ahead: no card,
   * `onAllow` still runs before the tool.
   */
  preapproved?: true;
  /** Main-only reservation, held only for this invocation. Never memoize the permit. */
  planPermit?: BotPlanPermit;
  planOperation?(args: unknown): string | undefined;
  /** A rule edit during onAllow requires an ordinary fresh decision. */
  planRulesCurrent?(): Promise<boolean>;
}

/** A rule handed this call to the person: the call never runs. */
export interface BotRuleHandoff {
  rule: BotHandoffRule;
  /** What the call was about to do, for the block text ("The person did this themselves: …"). */
  summary: string;
  /** The card's title after "Your turn: ". */
  action: string;
  why: string;
  /** The page where the person can do it (the Bot browser's tab): the card's Open. */
  open?: { url: string };
  browserTarget?: Readonly<BrowserApprovalTarget>;
}

export type BotPolicyDecision =
  | { allowed: true; approval?: BotApprovalRequirement; handoff?: undefined }
  | { allowed: true; handoff: BotRuleHandoff; approval?: undefined }
  | { allowed: false; reason: string };

export interface BotRuleHandoffRequest {
  botId: string;
  /** Stable across restarts for the same tool call. */
  waitId: string;
  toolCallId: string;
  toolName: string;
  action: string;
  why: string;
  rule: BotHandoffRule;
  /** The page where the person can do it: the card's Open. */
  open?: { url: string };
  browserTarget?: Readonly<BrowserApprovalTarget>;
  /** Aborted when the turn is stopped; the card is withdrawn. */
  signal: AbortSignal | undefined;
}

/** A settled rule hand-off, for the transcript. `toolCallId` and `rule` are always set. */
export type BotRuleHandoffRecord = { botId: string } & BotHandoffResultDetails & { toolCallId: string; rule: BotHandoffRule };

/**
 * Where a rule hand-off's row goes: the conversation of the call it stopped,
 * read and written through the harness that runs that call. It never goes
 * through the Bot's harness host: a pause, quit or delete holds the host's
 * lock for the Bot while it waits for this very call to end, so a write that
 * waited on that lock would never finish, and nor would the close.
 */
export interface BotRuleHandoffRowTarget {
  /** The conversation's entries as committed now. */
  entries(): Promise<readonly EntryRecord[]>;
  /** Append an entry; never submitted, so it can't start or resume the Bot. */
  append(kind: string, data: JsonValue): Promise<void>;
}

/** The call being checked. */
export interface BotToolCallCheck {
  /** Optional live owner fence for pure requirements reads; never hashed as a callback. */
  assertCurrent?(): Promise<void>;
  owner?: BotApprovalOwner;
  executionId?: string;
  /** Stable host-owned input identities for plan binding; ingress still uses requestIds. */
  authorizationIds?: readonly string[];
  /** Stale permits fall back to ordinary policy without reserving again. */
  skipPlanCoverage?: true;
  /** Internal ordinary-policy fallback after an unreadable or changed allow-list proof. */
  skipAllowList?: true;
  /** Internal pure ordinary-approval evidence read. */
  approvalProbe?: true;
  callId: string;
  args: unknown;
  signal: AbortSignal | undefined;
  /** Request ids of the inputs the calling run serves (one per input; `undefined` when it has none). */
  requestIds?: readonly (string | undefined)[];
  hasRoutineInputs?(): Promise<boolean>;
}

export type BotReadmission = { ok: true } | { ok: false; reason: "access_changed" | "bot_missing" };

export interface BotApprovalOwner {
  runId: string;
  inputs: Array<{submissionId: string; entryId?: string; requestId?: string; botMessage?: BotMessageInputMetadata; invalidBotInput?: true}>;
}

export interface BotApprovalRequest {
  authorizationFingerprint: string;
  always?: { key: string; count: number };
  allowList?: Pick<BotApprovalRequirements, "target" | "requirementsFingerprint" | "consentRevision">;
  assertCurrent?(): Promise<void>;
  prepareAllowListRelease?(grant: BotAllowListRelease): Promise<BotApprovalDecision | undefined>;
  owner?: BotApprovalOwner;
  botId: string;
  /** Stable across restarts for the same tool call. */
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  /**
   * One-way hashes of the call's exact arguments and of the reply it belongs
   * to. Waits that match on both (and on the card) are the same action in the
   * same run, so one card may answer them; nothing else is grouped.
   */
  argumentsHash?: string;
  runHash?: string;
  /** Aborted when the turn is stopped; the approval prompt should be withdrawn. */
  signal: AbortSignal | undefined;
}

export interface BotToolEntry {
  tool: AgentTool;
  replay: ToolReplay;
  /** MCP tools are forced to `unsafe` replay. */
  mcp?: boolean;
  /** Build the tool per call from the conversation it runs in (see `tool-adapter.ts`). */
  bind?: (call: BotToolCall) => AgentTool;
  /** The assembly's optional main-only final plan admission port. */
  admitPlan?: BotPlans["admit"];
}

/** What the next request offers, so the sections can describe it. */
export interface BotOfferedTools {
  toolNames: readonly string[];
}

/** What the next run is for: the request that started (or will start) it. */
export interface BotTurnContext {
  /** Routine runs (`routine:*`) get no routine-editing tools. */
  requestId?: string;
}

/** What a compaction is about to summarize (Pi Durable's `beforeCompact` input). */
export type BotCompaction = Parameters<CompactionHooks["beforeCompact"]>[0];

export interface BotExtensionDeps {
  now?(): number;
  /** Re-read on every refresh. */
  loadBot(botId: string): Promise<BotDefinition>;
  /** Base, persona, authority and guidance sections, in this order. Built after `currentTools`. */
  systemSections(bot: BotDefinition, offered: BotOfferedTools): Promise<string[]>;
  /**
   * The `aiden-memory` section, rendered before every request. `memoryOffered`
   * says whether this request offers `bot_memory`. Absent or "": no section.
   */
  memorySection?(botId: string, offer: { memoryOffered: boolean }): Promise<string>;
  /** The Bot gave a final answer. Called without waiting; must not throw. */
  afterReply?(botId: string): void;
  /** Awaited host peer outcome observation; never creates a new model request. */
  peerReply?(botId: string, message: AssistantMessage, taskId: string): Promise<void>;
  /**
   * A compaction is about to summarize. Return a summary to use instead of Pi
   * Durable's own, or `undefined` to let it summarize. Errors fall back too.
   * `offer.conversation` is the conversation being compacted, so each
   * compacted entry's own provenance can be read (absent when unreadable).
   */
  beforeCompact?(
    botId: string,
    compaction: BotCompaction,
    offer: { memoryOffered: boolean; conversation?: Conversation },
    context: Context,
  ): Promise<{ summary: string } | undefined>;
  currentTools(bot: BotDefinition, turn: BotTurnContext): Promise<BotToolEntry[]>;
  checkPolicy(botId: string, toolName: string, call?: BotToolCallCheck): Promise<BotPolicyDecision>;
  /**
   * Whether a run serving inputs with these request ids may use `toolName`
   * (ingress rules only). Applied to every request's offer and every call.
   * Absent: every tool installed is allowed.
   */
  turnAllows?(toolName: string, requestIds: readonly (string | undefined)[]): boolean;
  /**
   * Ask the person. Resolves with their answer; rejects when `signal` aborts
   * (the turn stopped or the app is quitting), so the call stays unanswered
   * and is re-asked with the same `waitId` after Resume.
   */
  requestApproval(request: BotApprovalRequest): Promise<BotApprovalDecision>;
  settleApproval?(input: BotApprovalSettlementInput, context?: BotApprovalSettlementContext): Promise<BotApprovalSettlement>;
  /** Optional adapter alias; both request ports return the same structured decision. */
  requestApprovalOutcome?(request: BotApprovalRequest): Promise<BotApprovalDecision>;
  /**
   * Show a rule hand-off card. Resolves with the person's answer; rejects
   * when `signal` aborts, so the call stays unanswered and Resume asks again
   * under the same `waitId`. Absent (no one to ask): a rule hand-off blocks.
   */
  requestHandoff?(request: BotRuleHandoffRequest): Promise<BotHandoffAnswer>;
  /**
   * Write the transcript row for a settled rule hand-off into `conversation`,
   * the stopped call's own. Must be idempotent per `toolCallId`.
   */
  recordHandoff?(record: BotRuleHandoffRecord, conversation: BotRuleHandoffRowTarget): Promise<void>;
  readmit(botId: string): Promise<BotReadmission>;
  /** Whether the Bot's model takes images. Defaults to true. */
  imageInput?(botId: string): Promise<boolean>;
  /**
   * Spending limits. `refusal` runs before every request with the request
   * ids of the run it serves, and says why it may not go: the Bot's month or
   * the routine run is over its limit. `record` counts every response; the
   * next request waits for it, so a fast tool turn cannot slip past a limit.
   * It must not throw.
   */
  spending?: {
    refusal(botId: string, requestIds: readonly (string | undefined)[]): Promise<string | undefined>;
    record(botId: string, requestIds: readonly (string | undefined)[], message: AssistantMessage): void | Promise<void>;
  };
  /**
   * The sandbox Bot scripts run in, made once per Bot. Absent: a worker
   * sandbox from the installed pi-codemode package (the desktop). A bundled
   * host passes its own worker and wasm.
   */
  codemodeSandbox?(): CodemodeSandboxBase;
  /**
   * The person's hooks for this Bot: global and `bot:<id>` scopes, run in the
   * Bot's folder. Absent: no hooks run.
   */
  hooks?: BotHookDeps;
}

export interface BotHookDeps {
  /** The Bot's folder, where its hooks run. */
  cwd(botId: string): Promise<string>;
  /**
   * Whether someone can answer an approval for a run serving inputs with
   * these request ids. A hook's ask on an unattended run blocks the call.
   */
  attended(requestIds: readonly (string | undefined)[]): boolean;
  /** Absent: the process-wide dispatcher. */
  dispatcher?: () => HookDispatcher;
  /**
   * Hook messages and Aiden's hook notices for the person, from each hook
   * that runs (a replay never repeats them). They never reach the model.
   * Must not throw.
   */
  report?(botId: string, lines: readonly string[]): void;
}

export class BotAccessChangedError extends Error {
  constructor(readonly reason: "access_changed" | "bot_missing") {
    super(reason === "bot_missing" ? "This Bot no longer exists." : "This Bot's access changed. Review it in Advanced.");
    this.name = "BotAccessChangedError";
  }
}

/** A request the Bot's month or a routine run had no money left for. */
export class BotSpendingLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotSpendingLimitError";
  }
}

export interface BotRegistry extends Registry {
  /**
   * Reload the Bot, its sections and its tools, and reinstall the extension.
   * Call before every submit and Resume; pending tool calls resolve against
   * the tools installed here.
   */
  refresh(turn?: BotTurnContext): Promise<void>;
  /** The readmission failure that stopped the latest request, if any. */
  admissionFailure(): BotReadmission | null;
  /**
   * Bind the harness this registry serves. Required for failing closed: a
   * hook's own error is only reported by Pi Durable, so a failed readmission
   * aborts the generation task instead.
   */
  attachHarness(harness: Harness): void;
  /** Independent prompt/tool closures for one task phase; shares only its sandbox. */
  fork(): BotRegistry;
}

function approvalHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") return `{${Object.entries(input).filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
    return JSON.stringify(input);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function ordinaryEvidence(value: BotApprovalRequirement, executionId: string, toolName: string, args: unknown,
  owner: BotApprovalOwner, requestIds: readonly (string | undefined)[]): BotApprovalEvidence {
  if (value.evidence) return value.evidence;
  const fingerprint = approvalHash({ version: "host-approval-v1", executionId, toolName, args, owner, requestIds,
    rule: value.rule?.id, target: value.remember?.target });
  return { requirementsFingerprint: fingerprint, authorizationFingerprint: fingerprint };
}
/** Revocation drops the probe closure and its live HookApi even if a consumer
 * mistakenly keeps the context or its callback after settlement. */
function publicationValidation(probe: (() => Promise<void>) | undefined) {
  const context: BotApprovalSettlementContext = {
    async validatePublication() {
      const active = probe;
      if (!active) throw new Error("This approval publication validation is no longer active.");
      await active();
      if (probe !== active) throw new Error("This approval publication validation is no longer active.");
    },
  };
  return { context, revoke() { probe = undefined; context.validatePublication = undefined; } };
}

interface ApprovalSettlementMemo {
  [key: string]: JsonValue;
  id: string;
  authorizationFingerprint: string;
  result: { [key: string]: JsonValue };
}

interface ApprovalMemo {
  [key: string]: JsonValue;
  waitId: string;
  toolCallId: string;
  summary: string;
  /**
   * What the wait was opened as. Memos written before rules have neither
   * `kind` nor `rule`, and were approvals.
   */
  kind: "approval" | "handoff";
  /** The rule id that made it, or null. */
  rule: string | null;
}

/** A PreToolUse hook's answer, kept for replay. */
interface PreToolHookMemo {
  [key: string]: JsonValue;
  kind: "none" | "block" | "ask";
  text: string | null;
  /** The hook's context for the model, added to the tool's result. Memos kept before it existed lack it; readers use `?? null`. */
  context: string | null;
}

/** Text a PostToolUse hook or a Stop hook returned for this task, or null for none. */
interface HookTextMemo {
  [key: string]: JsonValue;
  text: string | null;
}

/** The message with `text` appended as its own block, when it is the person's. */
function withAppendedText(message: Message, text: string): Message {
  if (message.role !== "user") return message;
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : [...message.content];
  return { ...message, content: [...content, { type: "text" as const, text }] };
}

/** Everything needed to apply a rule hand-off's answer without asking or re-deciding. */
interface HandoffAnswerMemo {
  [key: string]: JsonValue;
  outcome: BotHandoffOutcome;
  note: string | null;
  summary: string;
  action: string;
  rule: { id: string; label: string };
}

/**
 * The request's messages with the `withheld` tools taken out of every tool
 * declaration, for that request only (the stored transcript is unchanged).
 */
function withoutTools(messages: readonly Message[], withheld: (name: string) => boolean): readonly Message[] {
  if (!messages.some((message) => message.role === "system" && message.toolsAdded?.some((tool) => withheld(tool.name)))) {
    return messages;
  }
  return messages.map((message) =>
    message.role === "system" && message.toolsAdded !== undefined
      ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => !withheld(tool.name)) }
      : message,
  );
}

export function createBotRegistry(botId: string, deps: BotExtensionDeps): BotRegistry {
  const registry = createRegistry();
  let sections: readonly string[] = [];
  let admitted = false;
  let failure: BotReadmission | null = null;
  let harness: Harness | undefined;

  /**
   * Stop the generation before it reaches the provider. Pi Durable reports and
   * ignores errors thrown by hooks, so throwing alone would still send the
   * request; aborting the task ends the run as `unanswered` instead.
   */
  async function failClosed(taskId: Parameters<Harness["abortTask"]>[0], context: Context, error: Error): Promise<never> {
    if (harness === undefined) throw error;
    void harness.abortTask(taskId, BACKGROUND_CONTEXT).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const signal = context.abortSignal;
      if (signal === undefined || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw error;
  }

  let installedToolNames = new Set<string>();
  let planAdmissionAvailable = false;
  /** Offered tools whose declarations wait until the model loads or calls them. */
  let onDemandNames: ReadonlySet<string> = new Set();

  /** A conversation as a rule hand-off row target: read and appended through this harness, never the host. */
  function rowTarget(conversation: Conversation, context: Context): BotRuleHandoffRowTarget {
    return {
      entries: async () => (await conversation.context(context)).entries,
      append: async (kind, data) => {
        await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind, data }), context);
      },
    };
  }

  /**
   * Record the settled hand-off and block the call with what the person did.
   * Recording is idempotent, so a crash after it re-applies the same answer
   * without a second row. A row that can't be written now (the turn is
   * closing for a pause or quit) is written when Resume applies the answer.
   */
  async function applyHandoffAnswer(
    api: { readonly conversationId: ConversationId },
    context: Context,
    toolCallId: string,
    answer: HandoffAnswerMemo,
  ): Promise<{ block: string }> {
    try {
      const conversation =
        deps.recordHandoff === undefined ? undefined : await harness?.conversation(api.conversationId, context);
      if (conversation !== undefined) {
        await deps.recordHandoff!(
          {
            botId,
            kind: "action",
            outcome: answer.outcome,
            action: answer.action,
            ...(typeof answer.note === "string" ? { note: answer.note } : {}),
            toolCallId,
            rule: { id: answer.rule.id, label: answer.rule.label },
          },
          rowTarget(conversation, context),
        );
      }
    } catch {
      // The model must still read what the person did; the row is only the transcript's copy.
    }
    return {
      block:
        answer.outcome === "done"
          ? ruleHandoffDoneBlock(answer.summary, answer.note ?? undefined)
          : handoffSkippedText(answer.action, answer.note ?? undefined),
    };
  }

  /** Request ids of the inputs the current run of this conversation serves, read from durable state. */
  async function runRequestIds(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId },
    context: Context,
  ): Promise<(string | undefined)[]> {
    const execution = botExecutionScope(botId); if (execution) return execution.requestIds;
    return (await runOwner(api, context)).inputs.map(input => input.requestId);
  }

  async function runOwner(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId }, context: Context,
  ): Promise<BotApprovalOwner> {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    if (!harness) throw new Error("The Bot harness is not attached.");
    const {submissions} = await harness.inspect(context);
    const conversation = await harness.conversation(api.conversationId, context);
    const inputs = await Promise.all((live?.run?.inputs ?? []).map(async id => {
      const submission = submissions.find(s => s.id === id);
      if (submission?.type !== "input") return undefined;
      const entry = submission.entry !== undefined && conversation
        ? await conversation.commit(tx => tx.entry(submission.entry!), context) : undefined;
      const botMessage = entry?.kind === BOT_MESSAGE_INPUT_KIND ? botInputMetadata(submission.requestId, entry.data) : undefined;
      return {submissionId: String(id), ...(entry ? { entryId: String(entry.id) } : {}), ...(submission?.requestId !== undefined ? {requestId: submission.requestId} : {}),
        ...(botMessage ? { botMessage } : entry?.kind === BOT_MESSAGE_INPUT_KIND ? { invalidBotInput: true as const } : {})};
    }));
    return {runId: String(live?.run?.taskId ?? api.conversationId), inputs: inputs.some(input => input === undefined)
      ? [] : inputs.filter((input): input is NonNullable<typeof input> => input !== undefined)};
  }

  function botInputMetadata(requestId: string | undefined, data: JsonValue | undefined): BotMessageInputMetadata | undefined {
    const turn = botMessageTurnOf(requestId);
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const { kind, deliveryId, botId: sender, botName, text, deadline } = data;
    if ((turn.kind !== "message" && turn.kind !== "reply") || deliveryId !== turn.deliveryId ||
        kind !== (turn.kind === "message" ? "request" : "reply") ||
        typeof sender !== "string" || !sender.trim() || (turn.kind === "message" && sender !== turn.fromBotId) ||
        typeof botName !== "string" || typeof text !== "string" || typeof deadline !== "number" || !Number.isFinite(deadline)) return undefined;
    return { kind, deliveryId: turn.deliveryId, botId: sender, botName, text, deadline };
  }

  async function runInputIds(api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId }, context: Context): Promise<string[]> {
    const owner = await runOwner(api, context);
    if (!owner.inputs.length) throw new Error("This tool is not available without an active input.");
    if (owner.inputs.every(input => input.requestId !== undefined)) return owner.inputs.map(input => input.requestId!);
    const conversation = await harness!.conversation(api.conversationId, context);
    if (!conversation) throw new Error("This Bot conversation is unavailable.");
    // One transaction makes concurrent tools share the identity. A fresh
    // recovered DB has no bookkeeping entry and therefore mints a new UUID.
    return conversation.commit(async tx => {
      const identities = new Map<string, string>();
      let cursor: Parameters<typeof tx.scanEntries>[2];
      do {
        const page = await tx.scanEntries({ conversationId: api.conversationId }, 500, cursor);
        for (const entry of page.items) {
          if (entry.kind !== INPUT_IDENTITY_ENTRY || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
          const { submissionId, entryId, identity } = entry.data;
          if (typeof submissionId === "string" && typeof entryId === "string" && typeof identity === "string" && /^input:[0-9a-f-]{36}$/u.test(identity)) identities.set(JSON.stringify([submissionId, entryId]), identity);
        }
        cursor = page.next;
      } while (cursor !== undefined);
      const ids: string[] = [];
      for (const input of owner.inputs) {
        if (input.requestId !== undefined) { ids.push(input.requestId); continue; }
        if (!input.entryId) throw new Error("This input has no committed entry.");
        const key = JSON.stringify([input.submissionId, input.entryId]);
        let identity = identities.get(key);
        if (!identity) {
          identity = `input:${randomUUID()}`;
          await tx.appendEntry(api.conversationId, { kind: INPUT_IDENTITY_ENTRY, data: { submissionId: input.submissionId, entryId: input.entryId, identity } });
          identities.set(key, identity);
        }
        ids.push(identity);
      }
      return ids;
    }, context);
  }

  function expired(owner: BotApprovalOwner): boolean {
    return owner.inputs.some(input => input.invalidBotInput || (isBotMessageRequestId(input.requestId) &&
      (!input.botMessage || input.botMessage.deadline <= (deps.now?.() ?? Date.now()))));
  }
  async function assertLive(api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId }, context: Context, expectedOwner?: BotApprovalOwner): Promise<void> {
    const owner = await runOwner(api, context);
    if (owner.inputs.length === 0) throw new Error("This tool is not available without an active input.");
    if (expired(owner)) throw new Error("This Bot message expired. No further actions can run.");
    if (expectedOwner && approvalHash(owner) !== approvalHash(expectedOwner)) throw new Error("This tool's owning inputs changed. Ask again.");
  }

  /** Whether the run being served may use `bot_memory`. */
  async function memoryOffered(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId },
    context: Context,
  ): Promise<boolean> {
    if (!installedToolNames.has(MEMORY_TOOL_NAME)) return false;
    const requestIds = await runRequestIds(api, context);
    if (requestIds.length === 0) return false;
    if (deps.turnAllows === undefined) return true;
    return deps.turnAllows(MEMORY_TOOL_NAME, requestIds);
  }

  // Invocation-local permits and callbacks are never durable/public metadata.
  const executionApprovals = new Map<string, { approval: BotApprovalRequirement; invalid?: boolean; argsFingerprint?: string }>();
  const ordinaryExecutions = new Set<string>();
  const executedApprovals = new Map<string, { id: string; authorizationFingerprint: string; cacheKey: string }>();
  /** Actions the person declined, by run: in-memory only, for the runs still going. */
  const declinedInRuns = new Map<string, Set<string>>();
  const rememberDecline = (runId: string, key: string) => {
    const declined = declinedInRuns.get(runId) ?? new Set<string>();
    declined.add(key);
    declinedInRuns.delete(runId);
    declinedInRuns.set(runId, declined);
    // Keep only the most recent runs.
    while (declinedInRuns.size > 64) declinedInRuns.delete(declinedInRuns.keys().next().value!);
  };

  /**
   * A hook's ask gets a card of its own, ahead of the rule's flow: a remembered
   * Always answers the rule, never the hook. The answer is kept in the call's
   * memo, so a replay or a re-decision doesn't ask again. Returns the block, if any.
   */
  async function askForHook(summary: string, call: ToolHookCall, api: HookApi, context: Context, executionId: string,
    owner: BotApprovalOwner, requestIds: readonly (string | undefined)[]): Promise<{ block: string } | undefined> {
    if ((await api.memo<boolean>(HOOK_ASK_ALLOWED_MEMO, context)) === true) return undefined;
    const fingerprint = ordinaryEvidence({ summary }, executionId, call.name, call.arguments, owner, requestIds).authorizationFingerprint;
    const memo = await api.memo<ApprovalMemo>(HOOK_ASK_MEMO, {
      waitId: randomUUID(), toolCallId: call.id, summary, kind: "approval", rule: null, authorizationFingerprint: fingerprint,
    }, context);
    const request: BotApprovalRequest = {
      botId, waitId: memo.waitId, toolCallId: memo.toolCallId, toolName: call.name, summary: memo.summary,
      authorizationFingerprint: fingerprint, owner, signal: context.abortSignal, assertCurrent: () => assertLive(api, context, owner),
    };
    const answer = deps.requestApprovalOutcome ? await deps.requestApprovalOutcome(request) : await deps.requestApproval(request);
    if (answer.id !== memo.waitId || answer.authorizationFingerprint !== fingerprint) return { block: "This approval decision belongs to another authorization attempt." };
    if (answer.answer === "deny") {
      return { block: answer.source === "expiry" ? "The approval window expired. Nobody approved this action." : "The person declined this action." };
    }
    await api.memo(HOOK_ASK_ALLOWED_MEMO, true, context);
    return undefined;
  }

  async function authorizeTool(call: ToolHookCall, api: HookApi, context: Context, skipPlanCoverage = false, attempt = 0): Promise<{ block: string } | undefined> {
    if (attempt > 3) return { block: "This action's approval requirements kept changing. Ask again." };
    call = { ...call, arguments: structuredClone(call.arguments) };
    const executionId = await api.memo(EXECUTION_ID_MEMO, randomUUID(), context);
    await api.memo(NESTED_EXECUTION_MEMO, call.parent !== undefined, context);
    executionApprovals.delete(String(api.taskId));
    executedApprovals.delete(String(api.taskId));
    const owner = await runOwner(api, context);
    if (owner.inputs.length === 0) return {block: "This tool is not available without an active input."};
    if (expired(owner)) return {block: "This Bot message expired. No further actions can run."};
    // A rule hand-off the person already answered is applied as answered,
    // whatever the rules say now: re-deciding could run a call the person
    // already did themselves.
    const answered = await api.memo<HandoffAnswerMemo>(HANDOFF_ANSWER_MEMO, context);
    if (answered !== undefined) return applyHandoffAnswer(api, context, call.id, answered);
    // A throw here blocks the call, so an unreadable run fails closed.
    const requestIds = await runRequestIds(api, context);
    if (deps.turnAllows !== undefined && !deps.turnAllows(call.name, requestIds)) {
      return { block: "This tool is not available on this turn." };
    }
    // Codemode itself does nothing; every call its script makes is checked on its own.
    if (call.name === BOT_CODEMODE_TOOL_NAME && scriptable.length > 0) return undefined;
    // Loading only declares installed tools; each loaded tool is checked when called.
    if (call.name === LOAD_TOOLS_TOOL_NAME && onDemandNames.size > 0) return undefined;
    const check: BotToolCallCheck = {
      executionId,
      owner,
      assertCurrent: () => assertLive(api, context, owner),
      ...(planAdmissionAvailable ? { authorizationIds: await runInputIds(api, context) } : {}),
      ...(skipPlanCoverage ? { skipPlanCoverage: true as const } : {}),
      callId: call.id,
      args: call.arguments,
      signal: context.abortSignal,
      requestIds,
      hasRoutineInputs: async () => {
        const conversation = await harness!.conversation(api.conversationId, context);
        if (!conversation) return false;
        return conversation.commit(async (tx) => {
          for (const key of requestIds) {
            if (!key) return false;
            const input = await tx.submissionByRequest(api.conversationId, key);
            if (input?.type !== "input" || input.entry === undefined ||
                (await tx.entry(input.entry))?.kind !== BOT_ROUTINE_INPUT_KIND) return false;
          }
          return requestIds.length > 0;
        }, context);
      },
    };
    let decision = await deps.checkPolicy(botId, call.name, check);
    if (!planAdmissionAvailable && decision.allowed && decision.approval?.evidence && !decision.approval.preapproved) {
      // With no C port, harmless calls still avoid identity bookkeeping. An
      // ordinary approval needs mapped unnamed inputs too; this second fresh
      // classification cannot reserve coverage.
      check.authorizationIds = await runInputIds(api, context);
      decision = await deps.checkPolicy(botId, call.name, { ...check, skipPlanCoverage: true });
    }
    if (expired(await runOwner(api, context))) return {block: "This Bot message expired."};
    if (!decision.allowed) return { block: decision.reason };
    // A hand-off card belongs to a call in the transcript, which a script's call is not.
    if (decision.handoff !== undefined && call.parent !== undefined) return { block: scriptHandoffBlock(call.name) };
    if (decision.handoff !== undefined) {
      const handoff = decision.handoff;
      // Nobody can answer a card here: block with what is needed.
      if (deps.requestHandoff === undefined) return { block: ruleUnattendedBlock(handoff.rule.label) };
      const target = handoff.browserTarget;
      // A resumed tool can probe a different current tab. Keep the first
      // document identity with its wait, without persisting the page URL.
      const browserDocument = target && JSON.stringify([target.workspaceId, target.tabId, target.documentRevision]);
      const memo = await api.memo<ApprovalMemo>(
        APPROVAL_MEMO,
        {
          waitId: randomUUID(), toolCallId: call.id, summary: handoff.summary, kind: "handoff", rule: handoff.rule.id,
          ...(browserDocument && { browserDocument }),
        },
        context,
      );
      const answer = await deps.requestHandoff({
        botId,
        waitId: memo.waitId,
        toolCallId: call.id,
        toolName: call.name,
        action: handoff.action,
        why: handoff.why,
        rule: handoff.rule,
        ...(target && memo.browserDocument === browserDocument && { browserTarget: target }),
        ...(handoff.open === undefined ? {} : { open: handoff.open }),
        signal: context.abortSignal,
      });
      const stored = await api.memo<HandoffAnswerMemo>(
        HANDOFF_ANSWER_MEMO,
        {
          outcome: answer.outcome,
          note: answer.note ?? null,
          summary: handoff.summary,
          action: handoff.action,
          rule: { id: handoff.rule.id, label: handoff.rule.label },
        },
        context,
      );
      return applyHandoffAnswer(api, context, call.id, stored);
    }
    // Hooks see only what the rules already allow, and can only tighten it.
    const hookAnswer = await preToolHook(call, api, context, requestIds);
    if (hookAnswer?.kind === "block") return { block: hookAnswer.text ?? "Blocked by a hook." };
    if (hookAnswer?.kind === "ask") {
      const refused = await askForHook(hookAnswer.text ?? "A hook asks for your approval.", call, api, context, executionId, owner, requestIds);
      if (refused !== undefined) return refused;
    }
    if (hookAnswer !== undefined) {
      // A hook, and above all its card, holds the call: decide on today's rules
      // and the run as it stands now.
      try {
        await assertLive(api, context, owner);
      } catch (error) {
        return { block: error instanceof Error ? error.message : "This action can no longer run." };
      }
      const current = await deps.checkPolicy(botId, call.name, { ...check, skipPlanCoverage: true, skipAllowList: true, approvalProbe: true });
      if (!current.allowed) return { block: current.reason };
      // A plan permit and an allow-list entry recheck themselves when used, and
      // this probe skips both. A routine's go-ahead has no such check, so it
      // must still stand here. An ordinary approval is rechecked after its card.
      const goAhead = decision.approval?.preapproved === true && decision.approval.planPermit === undefined && decision.approval.requirements === undefined;
      if (
        current.handoff !== undefined ||
        (decision.approval === undefined && current.approval !== undefined) ||
        (goAhead && current.approval?.preapproved !== true)
      ) {
        return authorizeTool(call, api, context, true, attempt + 1);
      }
    }
    if (decision.approval === undefined) return undefined;
    if (decision.approval.planPermit) {
      await api.memo(PLAN_EXECUTION_MEMO, true, context);
      executionApprovals.set(String(api.taskId), { approval: decision.approval });
    }
    if (decision.approval.preapproved === true) {
      try {
        await assertLive(api, context);
        await decision.approval.onAllow?.();
        await assertLive(api, context);
      } catch (error) {
        // A beforeTool block never reaches execute/afterTool/settled.
        executionApprovals.delete(String(api.taskId));
        return { block: error instanceof Error ? error.message : "This action can no longer run." };
      }
      return undefined;
    }
    let approval = decision.approval;
    const evidenceOf = (value: BotApprovalRequirement) => ordinaryEvidence(value, executionId, call.name, call.arguments, owner, requestIds);
    const fresh = async () => {
      await assertLive(api, context);
      if (approval.revalidate) return approval.revalidate();
      const current = await deps.checkPolicy(botId, call.name, { ...check, skipPlanCoverage: true, skipAllowList: true, approvalProbe: true });
      return current.allowed ? current.approval : undefined;
    };
    const attemptMemo = async (value: BotApprovalRequirement) => {
      const evidence = evidenceOf(value);
      return api.memo<ApprovalMemo>(`aiden.approval.attempt:${evidence.authorizationFingerprint}`, {
        waitId: randomUUID(), toolCallId: call.id, summary: value.summary, kind: "approval", rule: value.rule?.id ?? null,
        authorizationFingerprint: evidence.authorizationFingerprint,
      }, context);
    };
    // The person already declined this exact action in this run: never ask
    // again (the approval gate's "declined in run" rule, plan §3.3).
    // A run is the reply to one set of inputs, across all of its model steps.
    const declineRun = `${api.conversationId}\u0000${owner.inputs.map(input => input.submissionId).join(",")}`;
    const declineKey = `${call.name}\u0000${approval.summary}\u0000${JSON.stringify(call.arguments ?? null)}`;
    if (declinedInRuns.get(declineRun)?.has(declineKey)) return { block: "The person declined this action." };
    let memo = await attemptMemo(approval);
    let fingerprint = evidenceOf(approval).authorizationFingerprint;
    let releaseProof: BotAllowListRelease | undefined;
    let preparedRelease: { approval: BotApprovalRequirement; memo: ApprovalMemo; grant: BotAllowListRelease } | undefined;
    const capturedRequirements = approval.requirements ? structuredClone(approval.requirements) : undefined;
    const capturedRemember = approval.remember ? structuredClone(approval.remember) : undefined;
    const request: BotApprovalRequest = {
      botId, waitId: memo.waitId, toolCallId: memo.toolCallId, toolName: call.name, summary: approval.summary,
      argumentsHash: approvalHash({ toolName: call.name, args: call.arguments ?? null }), runHash: approvalHash(declineRun),
      authorizationFingerprint: fingerprint, owner, signal: context.abortSignal, assertCurrent: () => assertLive(api, context, owner),
      ...(capturedRemember?.offer && !approval.rule ? { always: { key: botApprovalRuleKey(capturedRemember.target), count: capturedRemember.offer.count } } : {}),
      ...(capturedRequirements && capturedRemember && !approval.rule ? {
        allowList: { target: capturedRequirements.target, requirementsFingerprint: capturedRequirements.requirementsFingerprint,
          consentRevision: capturedRequirements.consentRevision },
        prepareAllowListRelease: async (grant: BotAllowListRelease) => {
          const current = await fresh(), proof = current?.requirements;
          if (!current || !proof || current.rule || proof.requirementsFingerprint !== capturedRequirements.requirementsFingerprint ||
              proof.consentRevision !== grant.consentRevision || proof.matchedRuleId !== grant.ruleId ||
              botApprovalRuleKey(proof.target) !== botApprovalRuleKey(grant.target)) return undefined;
          const replacement = await attemptMemo(current);
          if (replacement.waitId === memo.waitId) return undefined;
          await assertLive(api, context);
          preparedRelease = { approval: current, memo: replacement, grant: structuredClone(grant) };
          return { id: replacement.waitId, authorizationFingerprint: proof.authorizationFingerprint, answer: "allow" as const, source: "allow_list" as const };
        },
      } : {}),
    };
    const answer = deps.requestApprovalOutcome ? await deps.requestApprovalOutcome(request) : await deps.requestApproval(request);
    if (answer.source === "allow_list" && preparedRelease && answer.id === preparedRelease.memo.waitId &&
        answer.authorizationFingerprint === evidenceOf(preparedRelease.approval).authorizationFingerprint) {
      approval = preparedRelease.approval; memo = preparedRelease.memo; releaseProof = preparedRelease.grant;
      fingerprint = evidenceOf(approval).authorizationFingerprint;
    }
    if (answer.id !== memo.waitId || answer.authorizationFingerprint !== fingerprint) return { block: "This approval decision belongs to another authorization attempt." };
    const settlementOwner = await runOwner(api, context);
    if (expired(settlementOwner)) return { block: "This Bot message expired. The approval window ended." };
    const cacheKey = `aiden.approval.settled:${answer.id}:${answer.authorizationFingerprint}`;
    let settlement: BotApprovalSettlement = {};
    if (capturedRemember && deps.settleApproval) {
      let cache = await api.memo<ApprovalSettlementMemo>(cacheKey, context);
      if (cache && (cache.id !== answer.id || cache.authorizationFingerprint !== answer.authorizationFingerprint))
        return { block: "This approval settlement belongs to another authorization attempt." };
      if (!cache) {
        const mayPublish = answer.source === "person" && answer.answer === "allow_always";
        const expectedFingerprint = answer.authorizationFingerprint;
        const publicationRequirements = async () => {
          await assertLive(api, context, owner);
          const current = await fresh();
          await assertLive(api, context, owner);
          return current && evidenceOf(current).authorizationFingerprint === expectedFingerprint ? current : undefined;
        };
        // A stale human Always must not reach a service capable of publishing.
        // Once/deny history remains the exact human event, even if policy moved.
        if (mayPublish && !(await publicationRequirements())) return authorizeTool(call, api, context, true, attempt + 1);
        let publicationChanged = false;
        const validation = mayPublish ? publicationValidation(async () => {
          try {
            const current = await publicationRequirements();
            if (!current?.requirements || !capturedRequirements || current.rule ||
                current.requirements.authorizationFingerprint !== capturedRequirements.authorizationFingerprint) {
              throw new Error("This action's approval requirements changed before publication. Ask again.");
            }
          } catch (error) { publicationChanged = true; throw error; }
        }) : undefined;
        const requirements = releaseProof ? approval.requirements : capturedRequirements;
        let result: BotApprovalSettlement;
        try {
          result = await deps.settleApproval(structuredClone({ botId, remember: capturedRemember,
            hintEligible: !settlementOwner.inputs.some(input => { const turn = botMessageTurnOf(input.requestId); return turn.kind === "message" || turn.kind === "reply"; }),
            ...(requirements ? { requirements } : {}), decision: answer }), validation?.context);
        } catch (error) {
          if (publicationChanged) return authorizeTool(call, api, context, true, attempt + 1);
          throw error;
        } finally { validation?.revoke(); }
        cache = await api.memo<ApprovalSettlementMemo>(cacheKey, { id: answer.id, authorizationFingerprint: answer.authorizationFingerprint,
          result: JSON.parse(JSON.stringify(result)) as { [key: string]: JsonValue } }, context);
      }
      settlement = cache.result as BotApprovalSettlement;
    }
    if (answer.answer === "deny") {
      if (answer.source === "person") rememberDecline(declineRun, declineKey);
      return { block: answer.source === "expiry" ? "The approval window expired. Nobody approved this action."
        : answer.source === "person" ? "The person declined this action." : "This action was not approved." };
    }
    const current = await fresh();
    const publication = releaseProof ?? settlement.publication;
    const same = current && evidenceOf(current).authorizationFingerprint === fingerprint;
    const ownPublication = current?.requirements && publication && (answer.source === "allow_list" || answer.answer === "allow_always") &&
      current.requirements.requirementsFingerprint === (releaseProof ? approval.requirements?.requirementsFingerprint : capturedRequirements?.requirementsFingerprint) &&
      current.requirements.consentRevision === publication.consentRevision && current.requirements.matchedRuleId === publication.ruleId &&
      botApprovalRuleKey(current.requirements.target) === botApprovalRuleKey(publication.target);
    if (!current || (!same && !ownPublication)) return authorizeTool(call, api, context, true, attempt + 1);
    try {
      await assertLive(api, context);
      if (answer.source === "allow_list" && publication) {
        if (!current.allowFromList) throw new Error("This remembered approval is no longer available.");
        await current.allowFromList(publication);
      } else await current.onAllow?.();
      await assertLive(api, context);
      const afterBinding = current.revalidate ? await current.revalidate() : current;
      if (!afterBinding || evidenceOf(afterBinding).authorizationFingerprint !== evidenceOf(current).authorizationFingerprint)
        return authorizeTool(call, api, context, true, attempt + 1);
      await api.memo("aiden.execution.approval", true, context);
      executionApprovals.set(String(api.taskId), { approval: { summary: current.summary, evidence: evidenceOf(current) }, argsFingerprint: approvalHash(call.arguments) });
      if (capturedRemember && deps.settleApproval) executedApprovals.set(String(api.taskId), { id: answer.id, authorizationFingerprint: answer.authorizationFingerprint, cacheKey });
    } catch (error) {
      executionApprovals.delete(String(api.taskId)); executedApprovals.delete(String(api.taskId));
      return { block: error instanceof Error ? error.message : "This action can no longer run." };
    }
    return undefined;
  }

  /** The remembered-approval hint settled for this call, if it still belongs to it. */
  async function settledHint(executed: { id: string; authorizationFingerprint: string; cacheKey: string }, api: HookApi, context: Context): Promise<string | undefined> {
    const cache = await api.memo<ApprovalSettlementMemo>(executed.cacheKey, context);
    if (!cache || cache.id !== executed.id || cache.authorizationFingerprint !== executed.authorizationFingerprint) return undefined;
    return typeof cache.result.hint === "string" ? cache.result.hint : undefined;
  }

  /** Hook context for this call's result: PreToolUse's, kept in its memo, then PostToolUse's. */
  async function hookAdditions(call: ToolHookCall, result: { output?: unknown; isError?: boolean }, api: HookApi, context: Context): Promise<string | undefined> {
    if (!Array.isArray(result.output)) return undefined;
    const client = await botHooks();
    if (client === undefined) return undefined;
    const preContext = (await api.memo<PreToolHookMemo>(PRE_TOOL_HOOK_MEMO, context))?.context ?? null;
    let stored = await api.memo<HookTextMemo>(POST_TOOL_HOOK_MEMO, context);
    if (stored === undefined && client.has("PostToolUse", call.name)) {
      const text = (result.output as Array<{ type: string; text?: string }>)
        .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
        .join("\n");
      const outcome = await client.dispatch(
        "PostToolUse",
        { ...hookToolPayload(call.name, call.arguments, call.id), tool_response: { content: text, is_error: result.isError === true } },
        { idempotencyKey: `PostToolUse:bot:${botId}:${call.id}`, signal: context.abortSignal },
      );
      stored = await api.memo<HookTextMemo>(POST_TOOL_HOOK_MEMO, { text: hookPostToolAdditions(outcome) ?? null }, context);
    }
    const additions = [preContext, stored?.text ?? null].filter((text): text is string => typeof text === "string" && text.length > 0);
    return additions.length === 0 ? undefined : additions.join("\n\n");
  }

  async function currentExecutionApproval(toolName: string, api: HookApi, args: unknown, context: Context) {
    const owner = await runOwner(api, context), requestIds = await runRequestIds(api, context);
    const executionId = await api.memo<string>(EXECUTION_ID_MEMO, context);
    if (!executionId || expired(owner) || !owner.inputs.length) return undefined;
    const decision = await deps.checkPolicy(botId, toolName, { executionId, callId: (api as ToolExecutionApi).callId,
      args, owner, requestIds, authorizationIds: await runInputIds(api, context),
      signal: context.abortSignal, assertCurrent: () => assertLive(api, context, owner),
      skipPlanCoverage: true, skipAllowList: true, approvalProbe: true });
    if (!decision.allowed || !decision.approval || decision.approval.preapproved) return undefined;
    return ordinaryEvidence(decision.approval, executionId, toolName, args, owner, requestIds);
  }

  /* Hooks: one client per Bot, built once its folder is known. */
  let hookClient: SurfaceHooks | undefined;
  async function botHooks(): Promise<SurfaceHooks | undefined> {
    const hookDeps = deps.hooks;
    if (hookDeps === undefined) return undefined;
    if (hookClient !== undefined) return hookClient;
    const report = (lines: string[]): void => {
      try {
        hookDeps.report?.(botId, lines);
      } catch {
        // Reporting is best effort; the hook's answer still applies.
      }
    };
    const reporting = (client: SurfaceHooks): SurfaceHooks => ({
      ...client,
      dispatch: async (...args) => {
        const outcome = await client.dispatch(...args);
        const lines = hookNoticeLines(outcome);
        if (lines.length > 0) report(lines);
        return outcome;
      },
    });
    let cwd: string;
    try {
      cwd = await hookDeps.cwd(botId);
    } catch (error) {
      // Its hooks can't run this time, so a call one of them could match doesn't either.
      return reporting(botHooksWithoutFolder(botId, error, hookDeps.dispatcher, { report }));
    }
    // Observe-only events (PreCompact) report through the same channel as dispatched ones.
    hookClient = reporting(botSurfaceHooks(botId, cwd, hookDeps.dispatcher, { report }));
    return hookClient;
  }

  /** SessionStart opens this process's first request, and the first after a compaction. */
  let sessionStart: "pending" | "compact" | "done" = "pending";
  /** SessionStart context, for the requests of the run it opened. */
  let sessionContext: { runKey: string; text: string } | undefined;
  /** Stop continuations per run, in this process. */
  const stopContinuations = new Map<string, number>();

  async function runKey(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId },
    context: Context,
  ): Promise<string> {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    return `${api.conversationId}\0${(live?.run?.inputs ?? []).join(",")}`;
  }

  async function startSession(
    request: { readonly messages: readonly Message[] },
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId; readonly taskId: HookApi["taskId"] },
    context: Context,
  ): Promise<void> {
    if (sessionStart === "done") return;
    const client = await botHooks();
    const source = sessionStart === "compact"
      ? "compact"
      : request.messages.some((message) => message.role === "assistant") ? "resume" : "startup";
    sessionStart = "done";
    if (client === undefined || !client.has("SessionStart")) return;
    const outcome = await client.dispatch(
      "SessionStart",
      { source },
      { idempotencyKey: `SessionStart:bot:${botId}:${String(api.taskId)}`, signal: context.abortSignal },
    );
    const text = hookContextText(outcome?.additionalContext);
    sessionContext = text === undefined ? undefined : { runKey: await runKey(api, context), text };
  }

  /** The person's hook context for the run it belongs to, on its latest user message. */
  async function withSessionContext(
    messages: readonly Message[],
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId },
    context: Context,
  ): Promise<readonly Message[]> {
    if (sessionContext === undefined) return messages;
    if ((await runKey(api, context)) !== sessionContext.runKey) {
      sessionContext = undefined;
      return messages;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "user") continue;
      const next = [...messages];
      next[index] = withAppendedText(messages[index]!, sessionContext.text);
      return next;
    }
    return messages;
  }

  /**
   * PreToolUse for a call the Bot's rules already allow. Its answer is kept
   * in the call's memo, so a replay or Resume applies it without running the
   * hook again. A stopped turn throws before anything is kept.
   */
  async function preToolHook(
    call: { readonly id: string; readonly name: string; readonly arguments: unknown },
    api: { readonly conversationId: ConversationId; memo: HookApi["memo"] },
    context: Context,
    requestIds: readonly (string | undefined)[],
  ): Promise<PreToolHookMemo | undefined> {
    const client = await botHooks();
    if (client === undefined) return undefined;
    const stored = await api.memo<PreToolHookMemo>(PRE_TOOL_HOOK_MEMO, context);
    if (stored !== undefined) return stored;
    if (!client.has("PreToolUse", call.name)) return undefined;
    const outcome = await client.dispatch("PreToolUse", hookToolPayload(call.name, call.arguments, call.id), {
      idempotencyKey: toolCallIdempotencyKey(`PreToolUse:bot:${botId}`, call.id, call.arguments),
      signal: context.abortSignal,
    });
    if (context.abortSignal?.aborted) throw new Error("The turn stopped before the hook answered.");
    let answer: PreToolHookMemo = { kind: "none", text: null, context: outcome?.additionalContext ?? null };
    if (outcome?.decision === "deny") {
      answer = { kind: "block", text: hookBlockText(outcome), context: null };
    } else if (outcome?.decision === "ask") {
      answer = deps.hooks!.attended(requestIds)
        ? { kind: "ask", text: hookAskText(outcome), context: outcome.additionalContext ?? null }
        : { kind: "block", text: `${hookBlockText(outcome)} No one is here to approve it on this turn.`, context: null };
    }
    // `allow` and `updatedInput` change nothing: the Bot's rules already decided, on these arguments.
    return api.memo<PreToolHookMemo>(PRE_TOOL_HOOK_MEMO, answer, context);
  }

  /** A Stop hook's next instruction for this run, or undefined to let it end. */
  async function stopHook(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId; readonly taskId: HookApi["taskId"]; memo: HookApi["memo"] },
    context: Context,
  ): Promise<string | undefined> {
    const client = await botHooks();
    if (client === undefined) return undefined;
    const stored = await api.memo<HookTextMemo>(STOP_HOOK_MEMO, context);
    if (stored !== undefined) return stored.text ?? undefined;
    const key = await runKey(api, context);
    const count = stopContinuations.get(key) ?? 0;
    // A stopped turn never continues, and the cap ends a hook that always says "keep going".
    if (context.abortSignal?.aborted || count >= MAX_STOP_HOOK_CONTINUATIONS || !client.has("Stop")) {
      stopContinuations.delete(key);
      return undefined;
    }
    const outcome = await client.dispatch(
      "Stop",
      { stop_hook_active: count > 0 },
      { idempotencyKey: `Stop:bot:${botId}:${String(api.taskId)}`, signal: context.abortSignal },
    );
    if (context.abortSignal?.aborted) {
      stopContinuations.delete(key);
      return undefined;
    }
    const kept = await api.memo<HookTextMemo>(STOP_HOOK_MEMO, { text: hookStopContinuation(outcome) ?? null }, context);
    if (kept.text === null) {
      stopContinuations.delete(key);
      return undefined;
    }
    stopContinuations.delete(key);
    stopContinuations.set(key, count + 1);
    while (stopContinuations.size > MAX_COUNTED_STOP_RUNS) {
      stopContinuations.delete(stopContinuations.keys().next().value!);
    }
    return kept.text;
  }

  const hooks = [
    hook(GenerationTask, {
      beforeRequest: async (request, api, context) => {
        const owner = await runOwner(api, context);
        const messageExpired = expired(owner);
        if (messageExpired && owner.inputs.every(input => input.invalidBotInput || isBotMessageRequestId(input.requestId))) return failClosed(api.taskId, context, new Error("This Bot message expired."));
        if (!admitted) {
          const readmission = await deps.readmit(botId);
          if (!readmission.ok) {
            failure = readmission;
            return failClosed(api.taskId, context, new BotAccessChangedError(readmission.reason));
          }
          failure = null;
          admitted = true;
        }
        await startSession(request, api, context);
        // The step that crossed a spending limit has finished: the run stops
        // before its next request.
        if (deps.spending !== undefined) {
          const refusal = await deps.spending.refusal(botId, await runRequestIds(api, context));
          if (refusal !== undefined) return failClosed(api.taskId, context, new BotSpendingLimitError(refusal));
        }
        let messages = messageExpired || owner.inputs.length === 0 ? withoutTools(request.messages, () => true) : request.messages;
        const turnAllows = deps.turnAllows;
        if (turnAllows !== undefined) {
          const requestIds = await runRequestIds(api, context);
          messages = withoutTools(messages, (name) => !turnAllows(name, requestIds));
        }
        messages = withoutTools(messages, withheldUntilDisclosed(messages));
        if (onDemandNames.size > 0) messages = withoutTools(messages, withheldUntilLoaded(messages, onDemandNames));
        messages = withNewestToolImages(messages, "browser_snapshot", BOT_BROWSER_SNAPSHOT_IMAGES_KEPT);
        messages = withNewestToolImages(messages, BOT_COMPUTER_TOOL_NAME, BOT_COMPUTER_CAPTURE_IMAGES_KEPT, BOT_OLDER_COMPUTER_CAPTURE_NOTE);
        if (deps.imageInput !== undefined && !(await deps.imageInput(botId))) messages = withImageReferences(messages);
        messages = await withSessionContext(messages, api, context);
        const finalOwner = await runOwner(api, context);
        const finalExpired = expired(finalOwner);
        if (finalExpired || finalOwner.inputs.length === 0) {
          if (finalExpired && finalOwner.inputs.every(input => input.invalidBotInput || isBotMessageRequestId(input.requestId))) return failClosed(api.taskId, context, new Error("This Bot message expired."));
          messages = withoutTools(messages, () => true);
        }
        return messages === request.messages ? undefined : { messages };
      },
      afterResponse: async (message, api, context) => {
        if (deps.spending === undefined) return;
        try {
          await deps.spending.record(botId, await runRequestIds(api, context), message);
        } catch {
          // Spending that cannot be attributed must never fail the reply.
        }
      },
      onYield: async (message, api, context) => {
        // A Stop hook may keep the run going; the answer is final only when it
        // doesn't. A reply cut off at the length limit isn't the Bot stopping.
        const continuation = message.stopReason === "stop" ? await stopHook(api, context) : undefined;
        if (continuation !== undefined) return { continue: continuation };
        await deps.peerReply?.(botId, message, String(api.taskId));
        // The review decides later whether to run; the answer never waits on it.
        try {
          if (!botExecutionScope(botId)?.claim.peer) deps.afterReply?.(botId);
        } catch {
          // A review that cannot be scheduled must never affect the reply.
        }
        return undefined;
      },
    }),
    hook(CompactionTask, {
      beforeCompact: async (compaction, api, context) => {
        // Observe-only: a Pi Durable compaction takes no extra instructions.
        const client = await botHooks();
        if (client !== undefined) {
          client.observe(
            "PreCompact",
            { trigger: compaction.reason === "manual" ? "manual" : "auto", aiden_reason: compaction.reason },
            { idempotencyKey: `PreCompact:bot:${botId}:${String(api.taskId)}` },
          );
          if (sessionStart === "done") sessionStart = "compact";
        }
        if (deps.beforeCompact === undefined) return undefined;
        const offered = await memoryOffered(api, context).catch(() => false);
        const conversation = await harness?.conversation(api.conversationId, context).catch(() => undefined);
        return deps.beforeCompact(
          botId,
          compaction,
          { memoryOffered: offered, ...(conversation === undefined ? {} : { conversation }) },
          context,
        );
      },
    }),
    hook(ToolTask, {
      beforeTool: (call, api, context) => authorizeTool(call, api, context),
      afterTool: async (call, result, api, context) => {
        const key = String(api.taskId), executed = executedApprovals.get(key);
        executedApprovals.delete(key); executionApprovals.delete(key); ordinaryExecutions.delete(key);
        const hint = executed && !result.isError ? await settledHint(executed, api, context) : undefined;
        const additions = [await hookAdditions(call, result, api, context), hint === undefined ? undefined : `\n\n${hint}`]
          .filter((text): text is string => text !== undefined);
        if (additions.length === 0 || !Array.isArray(result.output)) return undefined;
        return { ...result, output: [...result.output, ...additions.map((text) => ({ type: "text" as const, text }))] };
      },
    }),
  ];

  /* Codemode: the tools installed by the latest refresh that scripts may call. */
  let scriptable: readonly BotToolEntry[] = [];
  let sandbox: CodemodeSandboxBase | undefined;
  let codemode: Extension | undefined;

  /** Pi Durable's codemode over the Bot's tools: replay-safe, each call a nested tool call. */
  function codemodeExtension(): Extension {
    sandbox ??= deps.codemodeSandbox?.() ?? new CodemodeSandbox({ memoryLimitBytes: BOT_SCRIPT_MEMORY_BYTES });
    codemode ??= createCodemodeExtension({ sandbox, models: false, inlineBudget: BOT_SCRIPT_INLINE_BUDGET });
    return codemode;
  }

  function build(tools: readonly DurableTool[]): Extension {
    return defineExtension({
      name: BOT_EXTENSION_NAME,
      tools,
      sections: BOT_SECTION_KEYS.map((key, index) =>
        key === "aiden-memory"
          ? section(
              key,
              async (input, context) => {
                if (deps.memorySection === undefined) return undefined;
                const offered = await memoryOffered(
                  { snapshot: input.read.snapshot.bind(input.read), conversationId: input.conversationId },
                  context,
                );
                const text = await deps.memorySection(botId, { memoryOffered: offered });
                return text.length === 0 ? undefined : text;
              },
              { tag: false },
            )
          : section(key, () => {
              const text = sections[index];
              return text === undefined || text.length === 0 ? undefined : text;
            }, { tag: false }),
      ),
      hooks,
    });
  }

  registry.install(build([]));

  return Object.assign(registry, {
    async refresh(turn: BotTurnContext = {}) {
      const bot = await deps.loadBot(botId);
      const current = await deps.currentTools(bot, turn);
      planAdmissionAvailable = current.some(entry => entry.admitPlan !== undefined);
      // Rarely used tools are installed but declared only once loaded (see `on-demand-tools.ts`).
      const loading = createOnDemandTools(current.map(({ tool }) => tool));
      onDemandNames = new Set(loading?.onDemand.map(({ name }) => name) ?? []);
      const offered: BotToolEntry[] = loading ? [...current, { tool: loading.loader, replay: "safe" }] : [...current];
      // The sections describe the Bot's own tools; connection tools stay declared, so their guidance stays in the prompt.
      const nextSections = await deps.systemSections(bot, { toolNames: offered.map(({ tool }) => tool.name) });
      // The memory section renders per request; the rest are fixed per refresh.
      sections = nextSections.slice(0, BOT_SECTION_KEYS.length - 1);
      scriptable = offered.some(({ tool }) => tool.name === BOT_CODEMODE_TOOL_NAME) ? [] : offered.filter(scriptCallable);
      installedToolNames = new Set([
        ...offered.map(({ tool }) => tool.name),
        ...(scriptable.length > 0 ? [BOT_CODEMODE_TOOL_NAME] : []),
      ]);
      const tools = offered.map((entry): DurableTool => {
        const { tool, replay, mcp, bind, admitPlan } = entry;
        // Rebuild call context using the current execution API, including recovery,
        // because an unsafe tool's old HookApi is no longer live after intent.
        const executionCall = async (api: HookApi & { callId: string }, args: unknown, context: Context): Promise<ToolHookCall> => ({
          type: "toolCall", id: api.callId, name: tool.name, arguments: args as ToolHookCall["arguments"],
          ...(await api.memo<boolean>(NESTED_EXECUTION_MEMO, context) ? { parent: { taskId: api.taskId, callId: api.callId } } : {}),
        });
        const adapted = adaptAidenTool(tool, {
          assertRunActive: assertLive, replay: mcp ? "unsafe" : replay,
          ...(bind === undefined ? {} : { bind, runRequestIds, runInputIds }),
          ...{
            prepareExecution: async (api, context, args) => {
              const key = String(api.taskId);
              if (!ordinaryExecutions.has(key) && !executionApprovals.has(key) && (await api.memo<boolean>(PLAN_EXECUTION_MEMO, context) || await api.memo<boolean>("aiden.execution.approval", context))) {
                // Safe recovery skips beforeTool. Restore authorization before
                // entering the fence, so authority is fresh after onAllow.
                const result = await authorizeTool(await executionCall(api, args, context), api, context);
                if (result?.block) throw new Error(result.block);
                if (!executionApprovals.has(key)) ordinaryExecutions.add(key);
              }
              let authorization = executionApprovals.get(key);
              if (authorization?.argsFingerprint && (authorization.argsFingerprint !== approvalHash(args) ||
                  (await currentExecutionApproval(tool.name, api, args, context))?.authorizationFingerprint !== authorization.approval.evidence?.authorizationFingerprint)) {
                const result = await authorizeTool(await executionCall(api, args, context), api, context, true);
                if (result?.block) throw new Error(result.block);
                authorization = executionApprovals.get(key);
              }
              if (authorization?.approval.planRulesCurrent && !(await authorization.approval.planRulesCurrent())) {
                authorization.invalid = true;
              }
            },
            admitEffect: async <T>(api: ToolExecutionApi, context: Context, args: unknown, start: () => Promise<T>) => {
              const key = String(api.taskId);
              const owner = await runOwner(api, context);
              if (owner.inputs.length === 0) throw new Error("This tool is not available without an active input.");
              if (deps.turnAllows && !deps.turnAllows(tool.name, owner.inputs.map(input => input.requestId))) {
                throw new Error("This tool is not available on this turn.");
              }
              const guardedStart = () => {
                context.abortSignal?.throwIfAborted();
                if (expired(owner)) throw new Error("This Bot message expired. No further actions can run.");
                return start();
              };
              const authorization = executionApprovals.get(key);
              if (authorization?.invalid) return { admitted: false as const };
              const approval = authorization?.approval;
              if (authorization?.argsFingerprint && (authorization.argsFingerprint !== approvalHash(args) ||
                  (await currentExecutionApproval(tool.name, api, args, context))?.authorizationFingerprint !== approval?.evidence?.authorizationFingerprint))
                return { admitted: false as const };
              if (approval?.planPermit) {
                if (approval.planOperation?.(args) !== approval.planPermit.operationFingerprint) return { admitted: false as const };
                if (!admitPlan) return { admitted: false as const };
                return admitPlan(approval.planPermit, guardedStart);
              }
              return { admitted: true as const, started: guardedStart() };
            },
            reauthorize: async (api, context, args) => {
              const result = await authorizeTool(await executionCall(api, args, context), api, context, true);
              if (result?.block) throw new Error(result.block);
              ordinaryExecutions.add(String(api.taskId));
            },
            settled: api => { executionApprovals.delete(String(api.taskId)); ordinaryExecutions.delete(String(api.taskId)); },
          },
        });
        // Only the scriptable tools resolve for a script's calls.
        return scriptable.includes(entry) ? adapted : { ...adapted, callers: ["model"] };
      });
      registry.install(build(tools));
      if (scriptable.length > 0) registry.install(codemodeExtension());
      else if (codemode !== undefined) registry.uninstall(codemode);
    },
    admissionFailure() {
      return failure;
    },
    attachHarness(next: Harness) {
      harness = next;
    },
    fork() {
      const child = createBotRegistry(botId, { ...deps, codemodeSandbox: () => sandbox ??= deps.codemodeSandbox?.() ?? new CodemodeSandbox({ memoryLimitBytes: BOT_SCRIPT_MEMORY_BYTES }) });
      if (harness) child.attachHarness(harness);
      return child;
    },
  });
}

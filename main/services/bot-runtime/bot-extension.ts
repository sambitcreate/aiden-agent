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
// - Ingress: the installed tools are the attended set. Each request and each
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

import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
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
  type Registry,
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

export const BOT_EXTENSION_NAME = "aiden-bot";
/** Section keys, in render order. */
export const BOT_SECTION_KEYS = ["aiden-base", "aiden-persona", "aiden-authority", "aiden-guidance", "aiden-memory"] as const;
/** The tool whose offer decides how the memory section reads. */
const MEMORY_TOOL_NAME = "bot_memory";
const APPROVAL_MEMO = "aiden.approval";
/** The person's answer to a rule hand-off, kept until the call's block is recorded. */
const HANDOFF_ANSWER_MEMO = "aiden.handoff.answer";
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

export interface BotApprovalRequirement {
  summary: string;
  /**
   * Runs after the person allows, before the tool executes (for example to
   * bind a Computer Use grant to this call). A throw blocks the call.
   */
  onAllow?(): void | Promise<void>;
  /** The rule that made (or also covers) this ask. */
  rule?: BotHandoffRule;
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
  callId: string;
  args: unknown;
  signal: AbortSignal | undefined;
  /** Request ids of the inputs the calling run serves (one per input; `undefined` when it has none). */
  requestIds?: readonly (string | undefined)[];
}

export type BotReadmission = { ok: true } | { ok: false; reason: "access_changed" | "bot_missing" };

export interface BotApprovalRequest {
  botId: string;
  /** Stable across restarts for the same tool call. */
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
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
  requestApproval(request: BotApprovalRequest): Promise<"allow" | "deny">;
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
   * The sandbox Bot scripts run in, made once per Bot. Absent: a worker
   * sandbox from the installed pi-codemode package (the desktop). A bundled
   * host passes its own worker and wasm.
   */
  codemodeSandbox?(): CodemodeSandboxBase;
}

export class BotAccessChangedError extends Error {
  constructor(readonly reason: "access_changed" | "bot_missing") {
    super(reason === "bot_missing" ? "This Bot no longer exists." : "This Bot's access changed. Review it in Advanced.");
    this.name = "BotAccessChangedError";
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
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const inputs = live?.run?.inputs ?? [];
    if (inputs.length === 0) return [];
    if (harness === undefined) throw new Error("The Bot harness is not attached.");
    const { submissions } = await harness.inspect(context);
    return inputs.map((id) => submissions.find((submission) => submission.id === id)?.requestId);
  }

  /** Whether the run being served may use `bot_memory`. */
  async function memoryOffered(
    api: Pick<DocumentReader, "snapshot"> & { readonly conversationId: ConversationId },
    context: Context,
  ): Promise<boolean> {
    if (!installedToolNames.has(MEMORY_TOOL_NAME)) return false;
    if (deps.turnAllows === undefined) return true;
    return deps.turnAllows(MEMORY_TOOL_NAME, await runRequestIds(api, context));
  }

  const hooks = [
    hook(GenerationTask, {
      beforeRequest: async (request, api, context) => {
        if (!admitted) {
          const readmission = await deps.readmit(botId);
          if (!readmission.ok) {
            failure = readmission;
            return failClosed(api.taskId, context, new BotAccessChangedError(readmission.reason));
          }
          failure = null;
          admitted = true;
        }
        let messages = request.messages;
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
        return messages === request.messages ? undefined : { messages };
      },
      onYield: () => {
        // The review decides later whether to run; the answer never waits on it.
        try {
          deps.afterReply?.(botId);
        } catch {
          // A review that cannot be scheduled must never affect the reply.
        }
        return undefined;
      },
    }),
    hook(CompactionTask, {
      beforeCompact: async (compaction, api, context) => {
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
      beforeTool: async (call, api, context) => {
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
        const decision = await deps.checkPolicy(botId, call.name, {
          callId: call.id,
          args: call.arguments,
          signal: context.abortSignal,
          requestIds,
        });
        if (!decision.allowed) return { block: decision.reason };
        // A hand-off card belongs to a call in the transcript, which a script's call is not.
        if (decision.handoff !== undefined && call.parent !== undefined) return { block: scriptHandoffBlock(call.name) };
        if (decision.handoff !== undefined) {
          const handoff = decision.handoff;
          // Nobody can answer a card here: block with what is needed.
          if (deps.requestHandoff === undefined) return { block: ruleUnattendedBlock(handoff.rule.label) };
          const memo = await api.memo<ApprovalMemo>(
            APPROVAL_MEMO,
            { waitId: randomUUID(), toolCallId: call.id, summary: handoff.summary, kind: "handoff", rule: handoff.rule.id },
            context,
          );
          // The current decision wins; only the wait id carries over from an earlier ask.
          const answer = await deps.requestHandoff({
            botId,
            waitId: memo.waitId,
            toolCallId: call.id,
            toolName: call.name,
            action: handoff.action,
            why: handoff.why,
            rule: handoff.rule,
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
        if (decision.approval === undefined) return undefined;
        const memo = await api.memo<ApprovalMemo>(
          APPROVAL_MEMO,
          {
            waitId: randomUUID(),
            toolCallId: call.id,
            summary: decision.approval.summary,
            kind: "approval",
            rule: decision.approval.rule?.id ?? null,
          },
          context,
        );
        // A wait first opened as a hand-off (the rules changed since) asks with
        // today's summary under the same wait id.
        const summary = memo.kind === "handoff" ? decision.approval.summary : memo.summary;
        const answer = await deps.requestApproval({
          botId,
          waitId: memo.waitId,
          toolCallId: memo.toolCallId,
          toolName: call.name,
          summary,
          signal: context.abortSignal,
        });
        if (answer !== "allow") return { block: "The person declined this action." };
        try {
          await decision.approval.onAllow?.();
        } catch (error) {
          return { block: error instanceof Error ? error.message : "This action can no longer run." };
        }
        return undefined;
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
        const { tool, replay, mcp, bind } = entry;
        const adapted = adaptAidenTool(tool, { replay: mcp ? "unsafe" : replay, ...(bind === undefined ? {} : { bind, runRequestIds }) });
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
  });
}

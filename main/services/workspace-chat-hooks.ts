/**
 * Aiden hooks for desktop workspace chats (docs/plans/aiden-hooks-plan.md §7).
 *
 * llm-client wires these into one ordinary chat generation: PreToolUse in the
 * host `beforeToolCall`, PostToolUse and per-turn context through the
 * `aiden.hooks` runtime extension, UserPromptSubmit and SessionStart at prompt
 * intake, Stop through the harness `onStop` continuation, Notification when a
 * card or question waits for the person, PreCompact before each compaction
 * (in a turn, and through the context lifecycle service for the Compact
 * action), and SessionEnd when the chat is deleted. The chat's subagents fire
 * SubagentStop through `chatSurfaceHooks` in `agent-surface-hooks.ts`.
 *
 * Not wired here, each on purpose: Bot chats (their hooks are policy-owned and
 * run through `agent-surface-hooks.ts`), Design Studio runs, ACP harness
 * providers such as Antigravity (the agent runs its own tools), routines,
 * title generation, provider probes and model-catalog work. None of those
 * reach this module.
 *
 * Hooks can only tighten a chat, and they never break one: a dispatcher that
 * throws counts as no outcome (a fail-closed PreToolUse hook is already mapped
 * to deny by the dispatcher itself).
 */

import os from "node:os";
import type { AgentMessage, AgentTool, AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { fenceAsData } from "../../renderer/shared/agent-notices.js";
import { getHookDispatcher } from "./hooks/index.js";
import type {
  HookDispatchContext,
  HookDispatcher,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookScope,
} from "./hooks/hook-types.js";
import { aidenToolInput, claudeToolInput, claudeToolName } from "./hooks/hook-aliases.js";
import {
  clearPromptHookBlock,
  isHookBlockedPrompt,
  markPromptHookBlocked,
  type PromptHookBlockStore,
} from "./hook-blocked-prompt.js";
import type {
  PiAgentRuntimeExtension,
  PiRuntimeStopDecision,
  PiRuntimeStopEvent,
} from "./pi-agent-runtime-harness.js";

/** Stop hooks keep one person turn going at most this many times. */
export const MAX_STOP_HOOK_CONTINUATIONS = 8;

/** The tool whose input a hook may never rewrite: the card showed the command. */
const SHELL_TOOL_NAME = "run_command";

export interface WorkspaceChatHookTarget {
  chatId: string;
  /** The chat's folder; absent for a folderless chat. */
  workspaceRoot?: string;
}

/** Global, then the chat's workspace when it has a folder, then the chat. */
export function workspaceChatHookScopes(target: WorkspaceChatHookTarget): HookScope[] {
  return [
    { kind: "global" },
    ...(target.workspaceRoot ? [{ kind: "workspace" as const, workspaceRoot: target.workspaceRoot }] : []),
    { kind: "chat", chatId: target.chatId },
  ];
}

/**
 * Hooks run in the chat's folder. A folderless chat has no folder of its own,
 * so its global and chat hooks run in the home folder, as a terminal would.
 */
export function workspaceChatHookCwd(target: WorkspaceChatHookTarget): string {
  return target.workspaceRoot ?? os.homedir();
}

export type PreToolUseHookResult =
  /** No hook ran or none expressed a decision. */
  | { kind: "none" }
  /** Block the call; `reason` is attributed to the hooks and shown in the tool row. */
  | { kind: "block"; reason: string }
  /** Show the approval card even when the chat would not ask; never offer to remember. */
  | { kind: "ask"; reason: string }
  /** May skip the card only where a remembered approval scope could already apply. */
  | { kind: "allow" };

export interface WorkspaceChatHookOptions {
  /**
   * Hook `systemMessage` text, Aiden's hook notices and a hook's stop reason,
   * for the person only. These never enter model context.
   */
  onMessages?: (lines: string[]) => void;
}

export interface WorkspaceChatHooks {
  readonly target: WorkspaceChatHookTarget;
  has(event: HookEvent, toolName?: string): boolean;
  /** Runs matching hooks; undefined when none could match or the dispatcher failed. */
  dispatch(
    event: HookEvent,
    payload: Omit<HookPayload, "hook_event_name" | "session_id" | "cwd">,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<HookOutcome | undefined>;
  /**
   * PreToolUse for one call. A hook's `updatedInput` replaces `args` in place
   * (validated against the tool's schema) for every tool but `run_command`.
   */
  preToolUse(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    tools?: readonly AgentTool[];
    signal?: AbortSignal;
  }): Promise<PreToolUseHookResult>;
  /** Fire-and-forget; never delays the card or question it reports. */
  notify(message: string, notificationType: string): void;
  /**
   * Set once a PreToolUse or PostToolUse hook returned `continue: false`: the
   * turn ends after the current tool batch, and this says why.
   */
  stopRequested(): string | undefined;
  /** The harness `onStop` callback: a Stop hook may keep the turn going. */
  onStop(event: PiRuntimeStopEvent): Promise<PiRuntimeStopDecision | undefined>;
  /**
   * PostToolUse plus per-turn context (UserPromptSubmit and SessionStart),
   * placed after the current prompt and never saved as the person's words.
   * PreToolUse context rides on its tool's result, and a hook's stop ends the
   * turn after the tool batch it came from.
   */
  extension(options: {
    /** The current prompt's timestamp; without one the last user message carries the context. */
    promptTimestamp(): number | undefined;
    turnContext(): string | undefined;
    /** UserPromptSubmit context for the mid-flight input this user message is, on that message only. */
    inputContext?(message: { timestamp: number; text: string }): string | undefined;
  }): PiAgentRuntimeExtension;
}

/** "hook a, b" naming the hooks that ran, or "a hook" when none reported a name. */
function hooksLabel(outcome: HookOutcome, noun = "hook"): string {
  return outcome.ranHooks.length > 0 ? `${noun} ${outcome.ranHooks.join(", ")}` : `a ${noun}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function modelReason(outcome: HookOutcome, fallback: string): string {
  return (outcome.reasonForModel ?? outcome.reason ?? "").trim() || fallback;
}

/** Text the person should see after any hook event: hook messages and Aiden's notices. */
export function hookNoticeLines(outcome: HookOutcome | undefined): string[] {
  if (!outcome) return [];
  return [
    ...(outcome.systemMessages ?? []).map((message) => `${capitalized(hooksLabel(outcome))}: ${message}`),
    ...(outcome.notices ?? []),
  ];
}

/** What the person sees when a hook's `continue: false` ends the turn. */
export function hookStopMessage(outcome: HookOutcome): string {
  const reason = (outcome.stopReason ?? "").trim();
  return `Stopped by ${hooksLabel(outcome)}${reason ? `: ${reason}` : "."}`;
}

/** What the person sees when a UserPromptSubmit hook refuses the prompt. */
export function promptBlockedMessage(outcome: HookOutcome): string {
  const reason = (outcome.stopReason ?? outcome.reason ?? "").trim();
  return `Blocked by ${hooksLabel(outcome)}: ${reason || "the prompt was not sent"}`;
}

/** Hook context for one turn, introduced as host data rather than the person's words. */
export function hookTurnContextText(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part?.trim()));
  if (present.length === 0) return undefined;
  return `[Aiden hook] Context from the person's hooks for this turn:\n\n${present.join("\n\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace `target`'s own keys with `next`'s, keeping the same object the tool will run with. */
function replaceArgsInPlace(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function appendText(message: AgentMessage, text: string): AgentMessage {
  if (message.role !== "user") return message;
  const content =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : [...message.content];
  return { ...message, content: [...content, { type: "text" as const, text }] };
}

/**
 * One run's mid-flight UserPromptSubmit context. Each entry is keyed by its
 * queued input's timestamp (admission keeps those unique within a run) and
 * answers only a user message with that input's exact text, so another
 * message that shares the millisecond never picks it up.
 */
export function createRunInputContexts(): {
  attach(input: { timestamp: number; text: string }, context: string): void;
  lookup(message: { timestamp: number; text: string }): string | undefined;
} {
  const entries = new Map<number, { text: string; context: string }>();
  return {
    attach: ({ timestamp, text }, context) => {
      entries.set(timestamp, { text, context });
    },
    lookup: ({ timestamp, text }) => {
      const entry = entries.get(timestamp);
      return entry && entry.text === text ? entry.context : undefined;
    },
  };
}

/** A user message's text, joined the same way whether stored as a string or blocks. */
function plainText(content: Extract<AgentMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function textOf(result: AfterToolCallContext["result"]): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createWorkspaceChatHooks(
  target: WorkspaceChatHookTarget,
  dispatcher: () => HookDispatcher = getHookDispatcher,
  options: WorkspaceChatHookOptions = {},
): WorkspaceChatHooks {
  const report = (lines: string[]) => {
    if (lines.length === 0 || !options.onMessages) return;
    try {
      options.onMessages(lines);
    } catch {
      // Showing a hook's message never breaks the chat.
    }
  };
  /** PreToolUse context waiting for its tool's result, by tool call id. */
  const preToolContext = new Map<string, string>();
  let stopReason: string | undefined;
  const requestStop = (outcome: HookOutcome) => {
    if (!outcome.stopTurn || stopReason !== undefined) return;
    stopReason = hookStopMessage(outcome);
    report([stopReason]);
  };
  const scopes = workspaceChatHookScopes(target);
  const cwd = workspaceChatHookCwd(target);
  const base: Omit<HookDispatchContext, "idempotencyKey" | "signal"> = {
    scopes,
    cwd,
    sessionId: target.chatId,
    // Background (`async`) hooks' messages arrive after their dispatch returns.
    reportAsync: report,
  };
  const has = (event: HookEvent, toolName?: string): boolean => {
    try {
      return dispatcher().hasHooks(event, scopes, toolName);
    } catch {
      return false;
    }
  };
  const dispatch: WorkspaceChatHooks["dispatch"] = async (event, payload, options) => {
    if (!has(event, typeof payload.aiden_tool_name === "string" ? payload.aiden_tool_name : undefined)) {
      return undefined;
    }
    let outcome: HookOutcome;
    try {
      outcome = await dispatcher().dispatch(
        event,
        { ...payload, hook_event_name: event, session_id: target.chatId, cwd },
        {
          ...base,
          ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    } catch {
      return undefined;
    }
    report(hookNoticeLines(outcome));
    return outcome;
  };
  const toolPayload = (toolName: string, input: unknown, toolUseId: string) => ({
    tool_name: claudeToolName(toolName),
    aiden_tool_name: toolName,
    tool_input: claudeToolInput(isRecord(input) ? input : undefined) ?? {},
    tool_use_id: toolUseId,
  });

  return {
    target,
    has,
    dispatch,
    async preToolUse({ toolCallId, toolName, args, tools, signal }) {
      if (!has("PreToolUse", toolName)) return { kind: "none" };
      const outcome = await dispatch("PreToolUse", toolPayload(toolName, args, toolCallId), {
        idempotencyKey: `PreToolUse:${target.chatId}:${toolCallId}`,
        signal,
      });
      if (!outcome) return { kind: "none" };
      // `continue: false` lets this call finish (unless denied) and then ends the turn.
      requestStop(outcome);
      if (outcome.decision === "deny") {
        return { kind: "block", reason: `Blocked by ${hooksLabel(outcome)}: ${modelReason(outcome, "no reason given")}` };
      }
      if (outcome.updatedInput && toolName !== SHELL_TOOL_NAME && isRecord(args)) {
        const tool = tools?.find((candidate) => candidate.name === toolName);
        let validated: Record<string, unknown>;
        try {
          if (!tool) throw new Error("the tool is not available");
          const mapped = aidenToolInput(toolName, outcome.updatedInput, args);
          validated = validateToolArguments(tool, {
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: mapped as Record<string, never>,
          }) as Record<string, unknown>;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            kind: "block",
            reason: `Blocked by ${hooksLabel(outcome)}: its updated input does not fit ${toolName} (${detail}).`,
          };
        }
        replaceArgsInPlace(args, validated);
      }
      if (outcome.additionalContext) preToolContext.set(toolCallId, outcome.additionalContext);
      if (outcome.decision === "ask") {
        return {
          kind: "ask",
          reason: `${capitalized(hooksLabel(outcome))}: ${modelReason(outcome, "asks for your approval")}`,
        };
      }
      if (outcome.decision === "allow") return { kind: "allow" };
      return { kind: "none" };
    },
    notify(message, notificationType) {
      if (!has("Notification")) return;
      void dispatch("Notification", { message, notification_type: notificationType }).catch(() => {});
    },
    stopRequested: () => stopReason,
    async onStop(event) {
      // Pi ended the reply on its own; the person's Stop and errors never get here.
      if (stopReason !== undefined) return undefined;
      if (event.continuations >= MAX_STOP_HOOK_CONTINUATIONS || !has("Stop")) return undefined;
      const outcome = await dispatch(
        "Stop",
        { stop_hook_active: event.continuations > 0 },
        { signal: event.signal },
      );
      if (!outcome?.continueTurn || outcome.stopTurn) return undefined;
      const instruction = (outcome.reasonForModel ?? outcome.reason ?? "").trim();
      if (!instruction) return undefined;
      return {
        continueWith: `[Aiden hook] ${capitalized(hooksLabel(outcome, "Stop hook"))} asked you to keep going before you finish:\n${instruction}`,
      };
    },
    extension({ promptTimestamp, turnContext, inputContext }) {
      return {
        id: "aiden.hooks",
        transformContext: async (input) => {
          let messages = input;
          if (inputContext) {
            messages = messages.map((message) => {
              if (message.role !== "user") return message;
              const own = inputContext({ timestamp: message.timestamp, text: plainText(message.content) });
              return own ? appendText(message, own) : message;
            });
          }
          const context = turnContext();
          if (!context) return messages;
          let index = -1;
          const anchor = promptTimestamp();
          if (anchor !== undefined) {
            index = messages.findIndex(
              (message) => message.role === "user" && message.timestamp === anchor,
            );
          }
          if (index < 0) {
            for (let at = messages.length - 1; at >= 0; at -= 1) {
              if (messages[at]?.role === "user") {
                index = at;
                break;
              }
            }
          }
          if (index < 0) return messages;
          const next = [...messages];
          next[index] = appendText(next[index]!, context);
          return next;
        },
        afterToolCall: async (context, signal): Promise<AfterToolCallResult | undefined> => {
          const toolName = context.toolCall.name;
          const additions: string[] = [];
          const preContext = preToolContext.get(context.toolCall.id);
          preToolContext.delete(context.toolCall.id);
          if (preContext) additions.push(preContext);
          const outcome = has("PostToolUse", toolName)
            ? await dispatch(
                "PostToolUse",
                {
                  ...toolPayload(toolName, context.args, context.toolCall.id),
                  tool_response: { content: textOf(context.result), is_error: context.isError },
                },
                { idempotencyKey: `PostToolUse:${target.chatId}:${context.toolCall.id}`, signal },
              )
            : undefined;
          if (outcome) {
            requestStop(outcome);
            if (outcome.flaggedResult) {
              const reason =
                outcome.reasonForModel ?? (outcome.reason ? fenceAsData("Hook feedback", outcome.reason) : undefined);
              additions.push(`${capitalized(hooksLabel(outcome))} flagged this result.${reason ? `\n${reason}` : ""}`);
            }
            if (outcome.additionalContext) additions.push(outcome.additionalContext);
          }
          if (additions.length === 0) return undefined;
          return {
            content: [...context.result.content, { type: "text", text: additions.join("\n\n") }],
          };
        },
        // A hook's `continue: false` ends the run once this turn's tools finish.
        finishTurn: () => (stopReason !== undefined ? { action: "end" } : undefined),
      };
    },
  };
}

/**
 * PreCompact for one compaction of a chat that runs hooks. Hook context
 * (already fenced as data) becomes extra instructions for the summary; other
 * output is ignored. Each hook is bounded by its own timeout and the dispatch
 * never throws, so a hook never fails the compaction or holds it up longer.
 */
export async function preCompactSummaryInstructions(
  hooks: Pick<WorkspaceChatHooks, "has" | "dispatch">,
  input: { trigger: "manual" | "auto"; reason: string; signal?: AbortSignal },
): Promise<string | undefined> {
  if (!hooks.has("PreCompact")) return undefined;
  const outcome = await hooks
    .dispatch(
      "PreCompact",
      { trigger: input.trigger, aiden_reason: input.reason },
      input.signal ? { signal: input.signal } : undefined,
    )
    .catch(() => undefined);
  const context = outcome?.additionalContext?.trim();
  return context ? `Keep what the person's PreCompact hooks point out:\n\n${context}` : undefined;
}

/** The person's prompt; `id` is its stored message, when the chat store holds one. */
export interface PromptIntakeMessage {
  id?: string;
  content: string;
  hookBlocked?: unknown;
}

export interface PromptIntakeInput {
  target: WorkspaceChatHookTarget;
  /** The chat's hook dispatch, which also shows hook messages; absent when the chat runs no hooks. */
  dispatch?: WorkspaceChatHooks["dispatch"];
  /** Whether the chat had earlier messages, which picks `startup` or `resume`. */
  hasPriorMessages: boolean;
  /** The stored prompt this turn sends, when there is one. */
  prompt: PromptIntakeMessage | undefined;
  store: PromptHookBlockStore;
  idempotencyKeys: { sessionStart?: string; userPromptSubmit: string };
  signal?: AbortSignal;
  /** A failed write of the prompt's blocked mark; the turn goes on regardless. */
  onStoreError: (message: string, error: unknown) => void;
}

/**
 * SessionStart, then UserPromptSubmit, before the model sees a turn. Returns
 * the hook context for this turn only. Throws, so the turn ends before any
 * model call, when SessionStart's `continue: false` stops it (the session is
 * not marked started, so the next message runs SessionStart again) or when
 * UserPromptSubmit refuses the prompt (it is marked so it never reaches a
 * model). A prompt that was blocked before and goes through now loses its
 * mark, on `prompt` itself too, so this turn journals it in order.
 */
export async function runPromptIntakeHooks(input: PromptIntakeInput): Promise<string | undefined> {
  const { dispatch, prompt } = input;
  let context: string | undefined;
  if (dispatch) {
    const source = workspaceChatSessionStartSource(input.target.chatId, input.hasPriorMessages);
    const sessionStart = source
      ? await dispatch(
          "SessionStart",
          { source },
          {
            ...(input.idempotencyKeys.sessionStart ? { idempotencyKey: input.idempotencyKeys.sessionStart } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
        )
      : undefined;
    if (sessionStart?.stopTurn) throw new Error(hookStopMessage(sessionStart));
    if (source) markWorkspaceChatSessionStarted(input.target);
    const promptSubmit = prompt
      ? await dispatch(
          "UserPromptSubmit",
          { prompt: prompt.content },
          {
            idempotencyKey: input.idempotencyKeys.userPromptSubmit,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        )
      : undefined;
    if (promptSubmit?.blockPrompt || promptSubmit?.stopTurn) {
      // The prompt stays visible but is marked, so no later turn, fork or
      // summary ever projects it into a model's context.
      const blocked = promptBlockedMessage(promptSubmit);
      if (prompt?.id) {
        await markPromptHookBlocked(input.store, input.target.chatId, prompt.id, blocked, (error) =>
          input.onStoreError("Could not mark a hook-blocked prompt.", error),
        );
      }
      throw new Error(blocked);
    }
    context = hookTurnContextText([sessionStart?.additionalContext, promptSubmit?.additionalContext]);
  }
  if (prompt?.id && isHookBlockedPrompt({ ...prompt, role: "user" })) {
    // Sent now (a retry after the hook changed or was turned off), so it is
    // no longer a blocked prompt.
    await clearPromptHookBlock(input.store, input.target.chatId, prompt as PromptIntakeMessage & { id: string }, (error) =>
      input.onStoreError("Could not clear a hook-blocked prompt's mark.", error),
    );
  }
  return context;
}

/**
 * UserPromptSubmit for input the person sends while a run is going (a steer
 * or a queued follow-up). A refusal (or `continue: false`) says why, so the
 * input is saved marked and never queued; otherwise any hook context is
 * returned for that input alone.
 */
export async function screenRunInputWithHooks(input: {
  dispatch: WorkspaceChatHooks["dispatch"];
  text: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<{ blocked: string } | { context?: string }> {
  const outcome = await input.dispatch(
    "UserPromptSubmit",
    { prompt: input.text },
    { idempotencyKey: input.idempotencyKey, ...(input.signal ? { signal: input.signal } : {}) },
  );
  if (outcome?.blockPrompt || outcome?.stopTurn) return { blocked: promptBlockedMessage(outcome) };
  const context = outcome?.additionalContext?.trim();
  return context ? { context: `[Aiden hook] Context from the person's hooks for this message:\n\n${context}` } : {};
}

/**
 * SessionStart bookkeeping for this app process: a chat's first turn is
 * `startup`, its first turn after a restart is `resume`, and its first turn
 * after compaction is `compact`. Later turns of a running session start none.
 */
const startedSessions = new Map<string, WorkspaceChatHookTarget>();
const compactedSessions = new Set<string>();
/**
 * Chats this process remembers at most. The least recently started chat is
 * forgotten first; it only means its next turn reports `resume` again and its
 * deletion fires no SessionEnd.
 */
export const MAX_TRACKED_HOOK_SESSIONS = 512;

export function workspaceChatSessionStartSource(
  chatId: string,
  hasPriorMessages: boolean,
): "startup" | "resume" | "compact" | undefined {
  if (compactedSessions.has(chatId)) return "compact";
  if (!hasPriorMessages) return startedSessions.has(chatId) ? undefined : "startup";
  return startedSessions.has(chatId) ? undefined : "resume";
}

/** Called once the turn that asked for a source has dispatched SessionStart. */
export function markWorkspaceChatSessionStarted(target: WorkspaceChatHookTarget): void {
  // Delete first so the chat becomes the most recent entry.
  startedSessions.delete(target.chatId);
  startedSessions.set(target.chatId, target);
  compactedSessions.delete(target.chatId);
  while (startedSessions.size > MAX_TRACKED_HOOK_SESSIONS) {
    const oldest = startedSessions.keys().next().value;
    if (oldest === undefined) break;
    startedSessions.delete(oldest);
    compactedSessions.delete(oldest);
  }
}

/** A compaction finished: the next turn starts a `compact` session. */
export function markWorkspaceChatCompacted(chatId: string): void {
  if (startedSessions.has(chatId)) compactedSessions.add(chatId);
}

/**
 * SessionEnd once a chat that ran hooks in this process is deleted. Best
 * effort and fire-and-forget: the delete never waits for it.
 */
export function endWorkspaceChatSession(
  chatId: string,
  dispatcher: () => HookDispatcher = getHookDispatcher,
  options: WorkspaceChatHookOptions = {},
): void {
  const target = startedSessions.get(chatId);
  startedSessions.delete(chatId);
  compactedSessions.delete(chatId);
  if (!target) return;
  // The chat is gone, so its hooks' messages go where the caller says (the app log, or stderr).
  const hooks = createWorkspaceChatHooks(target, dispatcher, options);
  void hooks.dispatch("SessionEnd", { reason: "other", aiden_reason: "chat_deleted" }).catch(() => {});
}

/** Tests only: forget every session this process started. */
export function resetWorkspaceChatSessionsForTests(): void {
  startedSessions.clear();
  compactedSessions.clear();
}

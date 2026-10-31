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
  /** The harness `onStop` callback: a Stop hook may keep the turn going. */
  onStop(event: PiRuntimeStopEvent): Promise<PiRuntimeStopDecision | undefined>;
  /**
   * PostToolUse plus per-turn context (UserPromptSubmit and SessionStart),
   * placed after the current prompt and never saved as the person's words.
   */
  extension(options: {
    /** The current prompt's timestamp; without one the last user message carries the context. */
    promptTimestamp(): number | undefined;
    turnContext(): string | undefined;
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

function textOf(result: AfterToolCallContext["result"]): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createWorkspaceChatHooks(
  target: WorkspaceChatHookTarget,
  dispatcher: () => HookDispatcher = getHookDispatcher,
): WorkspaceChatHooks {
  const scopes = workspaceChatHookScopes(target);
  const cwd = workspaceChatHookCwd(target);
  const base: Omit<HookDispatchContext, "idempotencyKey" | "signal"> = {
    scopes,
    cwd,
    sessionId: target.chatId,
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
    try {
      return await dispatcher().dispatch(
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
  };
  const toolPayload = (toolName: string, input: unknown) => ({
    tool_name: claudeToolName(toolName),
    aiden_tool_name: toolName,
    tool_input: claudeToolInput(isRecord(input) ? input : undefined) ?? {},
  });

  return {
    target,
    has,
    dispatch,
    async preToolUse({ toolCallId, toolName, args, tools, signal }) {
      if (!has("PreToolUse", toolName)) return { kind: "none" };
      const outcome = await dispatch("PreToolUse", toolPayload(toolName, args), {
        idempotencyKey: `PreToolUse:${target.chatId}:${toolCallId}`,
        signal,
      });
      if (!outcome) return { kind: "none" };
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
    async onStop(event) {
      // Pi ended the reply on its own; the person's Stop and errors never get here.
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
    extension({ promptTimestamp, turnContext }) {
      return {
        id: "aiden.hooks",
        transformContext: async (messages) => {
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
          if (!has("PostToolUse", toolName)) return undefined;
          const outcome = await dispatch(
            "PostToolUse",
            {
              ...toolPayload(toolName, context.args),
              tool_response: { content: textOf(context.result), is_error: context.isError },
            },
            { idempotencyKey: `PostToolUse:${target.chatId}:${context.toolCall.id}`, signal },
          );
          if (!outcome) return undefined;
          const additions: string[] = [];
          if (outcome.flaggedResult) {
            const reason = outcome.reasonForModel ?? (outcome.reason ? fenceAsData("Hook feedback", outcome.reason) : undefined);
            additions.push(`${capitalized(hooksLabel(outcome))} flagged this result.${reason ? `\n${reason}` : ""}`);
          }
          if (outcome.additionalContext) additions.push(outcome.additionalContext);
          if (additions.length === 0) return undefined;
          return {
            content: [...context.result.content, { type: "text", text: additions.join("\n\n") }],
          };
        },
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

/**
 * SessionStart bookkeeping for this app process: a chat's first turn is
 * `startup`, its first turn after a restart is `resume`, and its first turn
 * after compaction is `compact`. Later turns of a running session start none.
 */
const startedSessions = new Map<string, WorkspaceChatHookTarget>();
const compactedSessions = new Set<string>();

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
  startedSessions.set(target.chatId, target);
  compactedSessions.delete(target.chatId);
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
): void {
  const target = startedSessions.get(chatId);
  startedSessions.delete(chatId);
  compactedSessions.delete(chatId);
  if (!target) return;
  const hooks = createWorkspaceChatHooks(target, dispatcher);
  void hooks.dispatch("SessionEnd", { reason: "other", aiden_reason: "chat_deleted" }).catch(() => {});
}

/** Tests only: forget every session this process started. */
export function resetWorkspaceChatSessionsForTests(): void {
  startedSessions.clear();
  compactedSessions.clear();
}

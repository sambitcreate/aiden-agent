/**
 * Aiden hooks for the surfaces outside desktop workspace chats
 * (docs/plans/aiden-hooks-plan.md §7, phase 3): Bots, routines, subagents,
 * managed worktrees and the CLI daemon. Desktop workspace chats use
 * `workspace-chat-hooks.ts`; the wording here matches it, so a hook's
 * block, ask and continuation read the same on every surface.
 *
 * Hooks never break a surface: a dispatcher that throws counts as no outcome
 * (a fail-closed PreToolUse hook is already mapped to deny by the dispatcher).
 * Everything here runs in Node without Electron, so the CLI bundles it too.
 */

import { fenceAsData } from "../../renderer/shared/agent-notices.js";
import { claudeToolInput, claudeToolName } from "./hooks/hook-aliases.js";
import { hookScopesFor } from "./hooks/hook-config.js";
import { getHookDispatcher } from "./hooks/index.js";
import type { HookDispatcher, HookEvent, HookOutcome, HookPayload, HookScope } from "./hooks/hook-types.js";
import { MAX_STOP_HOOK_CONTINUATIONS, hookNoticeLines, hookStopMessage } from "./workspace-chat-hooks.js";

/** Stop hooks keep one run going at most this many times, on every surface. */
export { MAX_STOP_HOOK_CONTINUATIONS };
/** Hook messages and notices read the same on every surface. */
export { hookNoticeLines, hookStopMessage };

/** Where one surface's hooks run and whose they are. */
export interface SurfaceHookTarget {
  /** Global first, then workspace → bot → chat, as `hookScopesFor` builds them. */
  scopes: HookScope[];
  /** The command's working directory. */
  cwd: string;
  /** `session_id` in the payload: the chat, Bot or routine the event belongs to. */
  sessionId: string;
}

export type SurfaceHookPayload = Omit<HookPayload, "hook_event_name" | "session_id" | "cwd">;

export interface SurfaceHooks {
  readonly target: SurfaceHookTarget;
  has(event: HookEvent, toolName?: string): boolean;
  /** Runs matching hooks; undefined when none could match or the dispatcher failed. */
  dispatch(
    event: HookEvent,
    payload: SurfaceHookPayload,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<HookOutcome | undefined>;
  /** Fire-and-forget for observe-only events: never delays or fails the caller. */
  observe(event: HookEvent, payload: SurfaceHookPayload, options?: { idempotencyKey?: string }): void;
}

export function createSurfaceHooks(
  target: SurfaceHookTarget,
  dispatcher: () => HookDispatcher = getHookDispatcher,
): SurfaceHooks {
  const has = (event: HookEvent, toolName?: string): boolean => {
    try {
      return dispatcher().hasHooks(event, target.scopes, toolName);
    } catch {
      return false;
    }
  };
  const dispatch: SurfaceHooks["dispatch"] = async (event, payload, options) => {
    if (!has(event, typeof payload.aiden_tool_name === "string" ? payload.aiden_tool_name : undefined)) {
      return undefined;
    }
    try {
      return await dispatcher().dispatch(
        event,
        { ...payload, hook_event_name: event, session_id: target.sessionId, cwd: target.cwd },
        {
          scopes: target.scopes,
          cwd: target.cwd,
          sessionId: target.sessionId,
          ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    } catch {
      return undefined;
    }
  };
  return {
    target,
    has,
    dispatch,
    observe(event, payload, options) {
      if (!has(event)) return;
      void dispatch(event, payload, options).catch(() => undefined);
    },
  };
}

/** A Bot's hooks: global, then that Bot's own; they run in its folder and `session_id` is the Bot. */
export function botSurfaceHooks(botId: string, botFolder: string, dispatcher?: () => HookDispatcher): SurfaceHooks {
  return createSurfaceHooks({ scopes: hookScopesFor({ botId }), cwd: botFolder, sessionId: botId }, dispatcher);
}

/**
 * A desktop workspace chat's hooks for the work it starts outside its own
 * turn (its subagents): global, then the workspace, then the chat. A No
 * workspace chat passes no `workspaceRoot`, so only global and chat hooks run,
 * the same scopes its own turns use.
 */
export function chatSurfaceHooks(
  input: { chatId: string; cwd: string; workspaceRoot?: string },
  dispatcher?: () => HookDispatcher,
): SurfaceHooks {
  return createSurfaceHooks(
    { scopes: hookScopesFor({ workspaceRoot: input.workspaceRoot, chatId: input.chatId }), cwd: input.cwd, sessionId: input.chatId },
    dispatcher,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `tool_name` (Claude spelling), `aiden_tool_name` and `tool_input` for a tool event. */
export function hookToolPayload(toolName: string, input: unknown): SurfaceHookPayload {
  return {
    tool_name: claudeToolName(toolName),
    aiden_tool_name: toolName,
    tool_input: claudeToolInput(isRecord(input) ? input : undefined) ?? {},
  };
}

/** "hook a, b" naming the hooks that ran, or "a hook" when none reported a name. */
export function hooksLabel(outcome: HookOutcome, noun = "hook"): string {
  return outcome.ranHooks.length > 0 ? `${noun} ${outcome.ranHooks.join(", ")}` : `a ${noun}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The fenced reason, never the raw one: hook output is data, not instructions. */
function modelReason(outcome: HookOutcome, fallback: string): string {
  return (outcome.reasonForModel ?? "").trim() || fallback;
}

/** The tool error for a PreToolUse deny, as the model reads it. */
export function hookBlockText(outcome: HookOutcome): string {
  return `Blocked by ${hooksLabel(outcome)}: ${modelReason(outcome, "no reason given")}`;
}

/** The approval summary for a PreToolUse ask. The person reads the hook's own reason. */
export function hookAskText(outcome: HookOutcome): string {
  const reason = (outcome.reason ?? "").trim() || "asks for your approval";
  return `${capitalized(hooksLabel(outcome))}: ${reason}`;
}

/**
 * The next instruction when a Stop hook keeps the run going, or undefined
 * when it lets it end. A hook that also asked to stop wins.
 */
export function hookStopContinuation(outcome: HookOutcome | undefined): string | undefined {
  if (!outcome?.continueTurn || outcome.stopTurn) return undefined;
  const instruction = (outcome.reasonForModel ?? "").trim();
  if (!instruction) return undefined;
  return `[Aiden hook] ${capitalized(hooksLabel(outcome, "Stop hook"))} asked you to keep going before you finish:\n${instruction}`;
}

/** What PostToolUse adds after a tool's result: a flagged-result line and hook context. */
export function hookPostToolAdditions(outcome: HookOutcome | undefined): string | undefined {
  if (!outcome) return undefined;
  const additions: string[] = [];
  if (outcome.flaggedResult) {
    const reason = outcome.reasonForModel ?? (outcome.reason ? fenceAsData("Hook feedback", outcome.reason) : undefined);
    additions.push(`${capitalized(hooksLabel(outcome))} flagged this result.${reason ? `\n${reason}` : ""}`);
  }
  if (outcome.additionalContext) additions.push(outcome.additionalContext);
  return additions.length === 0 ? undefined : additions.join("\n\n");
}

/** Hook context for one session or turn, introduced as host data rather than the person's words. */
export function hookContextText(context: string | undefined): string | undefined {
  if (!context?.trim()) return undefined;
  return `[Aiden hook] Context from the person's hooks for this turn:\n\n${context}`;
}


/** What a WorktreeSetup hook is told about the new managed worktree. */
export interface WorktreeSetupHookInput {
  /** The source workspace's folder: its hooks (global, then that workspace's) are the ones that run. */
  sourceFolderPath: string;
  /** The source checkout's top level. */
  sourceRoot: string;
  /** The new worktree's checkout root. */
  worktreePath: string;
  /** The new worktree's workspace folder, where the hooks run. */
  workspacePath: string;
  /** The new worktree's workspace id (`session_id`). */
  workspaceId: string;
  branch: string;
}

/**
 * Runs WorktreeSetup hooks in the new worktree and waits for them (each is
 * bounded by its own timeout). Returns the lines the person should see; a
 * failing hook never throws here, so the worktree is never undone.
 */
export async function runWorktreeSetupHooks(
  input: WorktreeSetupHookInput,
  dispatcher?: () => HookDispatcher,
): Promise<string[]> {
  const hooks = createSurfaceHooks(
    { scopes: hookScopesFor({ workspaceRoot: input.sourceFolderPath }), cwd: input.workspacePath, sessionId: input.workspaceId },
    dispatcher,
  );
  const outcome = await hooks.dispatch(
    "WorktreeSetup",
    { worktree_path: input.worktreePath, branch: input.branch, source_root: input.sourceRoot },
    { idempotencyKey: `WorktreeSetup:${input.workspaceId}` },
  );
  return hookNoticeLines(outcome);
}

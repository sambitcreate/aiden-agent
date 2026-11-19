// Which tools a workspace chat declares, and which calls a given turn refuses.
//
// A chat declares the same tools on every turn so the cached prefix holds
// (docs/plans/prompt-cache-hit-rate.md, phase 2). What differs from turn to
// turn is who is there: an unattended follow-up has nobody to approve or
// watch, a paired device cannot show some results, and inline visuals On
// request draw only after /visualize. Those turns keep the declaration and
// refuse the call in `beforeToolCall`, before any access check, approval or
// execution, with a reason that names the condition.
//
// A workspace chat turn main starts on its own (the turn a settled run owes
// its chat, an unattended follow-up) has no window on this computer. It
// declares what a turn in the chat's window declares, so the chat's tool list
// is the same whoever started the turn, and refuses every call that needs the
// window: Computer Use, hooks, questions, the to-do list, the advisor, the
// browser, simulators, Aiden's settings tools and the design canvas.

import type { InlineVisualsMode } from "../../renderer/shared/appearance.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../renderer/shared/ask-user-question.js";
import { WORKSPACE_ARTIFACT_TOOL_NAME } from "../../renderer/shared/workspace-artifacts.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";
import { generativeUiUnavailableReason } from "./generative-ui-extension.js";
import { HOOKS_TOOL_NAME, hooksToolUnavailableReason, offersHooksTool, type HooksToolSurface } from "./hooks-tool.js";
import { TODO_TOOL_NAME } from "./rpiv-todo/contract.js";

const FORM_FILL_TOOL_NAME = "form_fill";
const SUBAGENT_TOOL_NAME = "subagent";
/** advisor-runtime.ts; named here so the policy does not load the advisor runtime. */
const ADVISOR_TOOL_NAME = "advisor";

/** The chat's own surface: fixed for every turn of the chat. */
export type ChatToolSurface = Omit<HooksToolSurface, "unattended" | "remoteAudience">;

/** Who and what this one turn serves. */
export interface ChatTurnAudience {
  /** Nobody is watching: an unattended follow-up. */
  unattended: boolean;
  /** A phone or paired Mac sent the turn and sees its results. */
  remoteAudience: boolean;
  /** The paired device that sent the turn cannot answer a question prompt. */
  questionPromptsUnavailable?: boolean;
  inlineVisuals?: InlineVisualsMode;
  /** The person used /visualize in this turn. */
  visualize: boolean;
  /**
   * Main started this workspace chat turn and no window on this computer
   * owns it (`windowlessChatTurn`): calls that need the window are refused.
   */
  windowless?: boolean;
  /**
   * Window-dependent tools this turn declared from its runtime sources (the
   * browser, simulators, Aiden's settings tools, the design canvas). Read on
   * each call, so names added after the refusal is built count.
   */
  windowOnlyToolNames?: ReadonlySet<string>;
}

/** What a generation's execution options say about who the turn serves. */
export interface ChatTurnAudienceOptions {
  unattended?: boolean;
  visualAudience?: "remote";
  questionPromptsUnavailable?: boolean;
  windowless?: boolean;
}

/** What the turn's own parameters say about inline visuals. */
export interface ChatTurnAudienceParams {
  inlineVisuals?: InlineVisualsMode;
  visualize?: boolean;
}

/** The turn's audience, from the generation's options and parameters. */
export function chatTurnAudienceFor(options: ChatTurnAudienceOptions, params: ChatTurnAudienceParams): ChatTurnAudience {
  return {
    unattended: options.unattended === true,
    remoteAudience: options.visualAudience === "remote",
    questionPromptsUnavailable: options.questionPromptsUnavailable === true,
    ...(params.inlineVisuals ? { inlineVisuals: params.inlineVisuals } : {}),
    visualize: params.visualize === true,
    ...(options.windowless === true ? { windowless: true } : {}),
  };
}

/** Who started a turn, as the client sees its owner. */
export interface ChatTurnOwnerScope {
  /** A desktop window on this computer owns the turn. */
  window: boolean;
  /** A paired phone or Mac sent the turn. */
  remote: boolean;
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  botBound: boolean;
}

/**
 * A workspace chat turn main started with no window or paired device behind
 * it: the turn a settled run owes its chat, or an unattended follow-up.
 * Bots, the Assistant, Telegram and scheduled runs keep their own tool
 * policies and are never windowless chat turns.
 */
export function windowlessChatTurn(scope: ChatTurnOwnerScope): boolean {
  return (
    !scope.window &&
    !scope.remote &&
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
    !scope.botBound
  );
}

/**
 * Whether the turn declares the tools a window on this computer offers. A
 * windowless chat turn declares them too, and refuses their calls.
 */
export function declaresWindowTools(scope: ChatTurnOwnerScope): boolean {
  return scope.window || windowlessChatTurn(scope);
}

/**
 * Whether the turn declares Aiden's settings and scheduling tools: a turn a
 * person can attend (no Bot, an Assistant only when attended, never
 * Telegram) that may schedule, and that a window on this computer or a
 * paired device owns, or that declares a window's tools without one.
 */
export function declaresAppTools(
  scope: ChatTurnOwnerScope,
  turn: { attendedAssistant: boolean; schedulingAllowed: boolean },
): boolean {
  return !scope.botBound &&
    (!scope.assistantMode || turn.attendedAssistant) &&
    scope.interactionSurface !== "telegram" &&
    turn.schedulingAllowed &&
    (declaresWindowTools(scope) || scope.remote);
}

/** The tools a windowless chat turn refuses by name, whatever its sources declared. */
const WINDOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  COMPUTER_USE_TOOL_NAME,
  FORM_FILL_TOOL_NAME,
  HOOKS_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  TODO_TOOL_NAME,
  ADVISOR_TOOL_NAME,
]);

/** A per-turn refusal: the reason a call cannot run in this turn, or undefined. */
export type TurnToolRefusal = (name: string, args: unknown) => string | undefined;

/**
 * One refusal from several: the first that refuses the call gives its reason.
 * The list is read on each call, so refusals added after this is built count.
 */
export function firstTurnToolRefusal(refusals: readonly TurnToolRefusal[]): TurnToolRefusal {
  return (name, args) => {
    for (const refusal of refusals) {
      const reason = refusal(name, args);
      if (reason) return reason;
    }
    return undefined;
  };
}

/** Declarations that depend on the chat alone, never on the turn's audience. */
export function chatToolOffers(surface: ChatToolSurface): { hooks: boolean } {
  return { hooks: offersHooksTool({ ...surface, unattended: false, remoteAudience: false }) };
}

/** A call this turn cannot run, with the reason the model reads, or undefined. */
export function chatTurnToolRefusal(
  surface: ChatToolSurface,
  turn: ChatTurnAudience,
): (name: string) => string | undefined {
  const hooksSurface: HooksToolSurface = { ...surface, unattended: turn.unattended, remoteAudience: turn.remoteAudience };
  const visuals = { onRequest: turn.inlineVisuals === "on_request", visualize: turn.visualize };
  return (name) => {
    const hooks = hooksToolUnavailableReason(name, hooksSurface);
    if (hooks) return hooks;
    if (turn.unattended && (name === COMPUTER_USE_TOOL_NAME || name === FORM_FILL_TOOL_NAME)) {
      return `${name} is not available in this turn: nobody is watching this follow-up to grant Computer Use. Describe what you would do on screen instead.`;
    }
    if (turn.unattended && name === SUBAGENT_TOOL_NAME) {
      return `${SUBAGENT_TOOL_NAME} is not available in this turn: nobody is watching this follow-up to approve or follow a subagent run. Do the work yourself or say what you would delegate.`;
    }
    if (turn.remoteAudience && (name === COMPUTER_USE_TOOL_NAME || name === FORM_FILL_TOOL_NAME)) {
      return `${name} is not available in this turn: the request came from a paired device, and Computer Use is granted only on this computer. Describe what you would do on screen instead.`;
    }
    if (turn.questionPromptsUnavailable === true && name === ASK_USER_QUESTION_TOOL_NAME) {
      return `${ASK_USER_QUESTION_TOOL_NAME} is not available in this turn: the paired device that sent it cannot show question prompts. Ask your question in your reply instead.`;
    }
    if (turn.windowless === true && (WINDOW_TOOL_NAMES.has(name) || turn.windowOnlyToolNames?.has(name) === true)) {
      return `${name} is not available in this turn: Aiden started this turn itself and no window owns it, and this tool needs the chat's own window. Say in your reply what you would do with it.`;
    }
    if (turn.remoteAudience && name === WORKSPACE_ARTIFACT_TOOL_NAME) {
      return `${WORKSPACE_ARTIFACT_TOOL_NAME} is not available in this turn: the request came from a paired device, which cannot show workspace artifacts. Open the chat on this computer to create, refresh or run one.`;
    }
    return generativeUiUnavailableReason(name, visuals);
  };
}

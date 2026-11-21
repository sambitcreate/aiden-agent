// What an owed turn starts with: the settled run's provider, model, folder and
// tools, as an ordinary chat turn. Kept apart from llm-client so the request
// can be checked without starting a run.

import type { OwedTurnPlan } from "./chat-owed-turns.js";
import type { GenerationExecutionOptions } from "./llm-client.js";
import type { ChatStartParams } from "./types.js";

/** What a run that can owe its chat a turn ran with, for that turn. */
export interface OwedTurnContext {
  workspaceId?: string;
  providerId: string;
  model: string;
  thinkingLevel?: ChatStartParams["thinkingLevel"];
  inlineVisuals?: ChatStartParams["inlineVisuals"];
  /** A paired device sent the run, so its visuals stay snapshots. */
  visualAudience?: GenerationExecutionOptions["visualAudience"];
  /** Tools the run's surface withheld, which the owed turn withholds too. */
  excludeToolNames?: ReadonlySet<string>;
}

export interface OwedTurnStartRequest {
  params: ChatStartParams;
  options: GenerationExecutionOptions;
}

/**
 * The owed turn's start request. It sets no access of its own and no
 * Assistant mode, so a workspace chat's owed turn follows the approval mode
 * (Ask, Auto or Never ask) the same as the turn the person started. It
 * withholds only what the settled run's surface withheld: tools whose cards
 * need a window (Computer Use, the hooks tool) stay declared, so the chat's
 * tool list does not change, and the turn refuses their calls because no
 * window owns it (`chatTurnToolRefusal`).
 */
export function owedTurnStartRequest<Origin extends string>(
  plan: OwedTurnPlan<OwedTurnContext, Origin>,
  streamId: string,
): OwedTurnStartRequest {
  const prompt = plan.inputs[plan.inputs.length - 1]!;
  const hookContext = plan.inputs
    .map((input) => input.hookContext)
    .filter((context): context is string => Boolean(context))
    .join("\n\n");
  const { context } = plan;
  const excludeToolNames = new Set(context.excludeToolNames);
  return {
    params: {
      chatId: plan.chatId,
      ...(context.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
      providerId: context.providerId,
      model: context.model,
      ...(context.thinkingLevel !== undefined ? { thinkingLevel: context.thinkingLevel } : {}),
      ...(context.inlineVisuals !== undefined ? { inlineVisuals: context.inlineVisuals } : {}),
      messages: [],
    },
    options: {
      turnId: streamId,
      usageSource: "chat",
      allowSubagents: true,
      excludeToolNames,
      ...(context.visualAudience !== undefined ? { visualAudience: context.visualAudience } : {}),
      screenedPrompt: { messageId: prompt.messageId, ...(hookContext ? { context: hookContext } : {}) },
    },
  };
}

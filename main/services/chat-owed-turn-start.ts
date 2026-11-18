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
 * (Ask, Auto or Never ask) the same as the turn the person started.
 * `windowOnlyToolNames` are tools whose cards need the run's own window
 * (the hooks tool), which no owed turn has.
 */
export function owedTurnStartRequest<Origin extends string>(
  plan: OwedTurnPlan<OwedTurnContext, Origin>,
  streamId: string,
  windowOnlyToolNames: readonly string[],
): OwedTurnStartRequest {
  const prompt = plan.inputs[plan.inputs.length - 1]!;
  const hookContext = plan.inputs
    .map((input) => input.hookContext)
    .filter((context): context is string => Boolean(context))
    .join("\n\n");
  const { context } = plan;
  const excludeToolNames = new Set(context.excludeToolNames);
  for (const name of windowOnlyToolNames) excludeToolNames.add(name);
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
      allowComputerUse: false,
      excludeToolNames,
      ...(context.visualAudience !== undefined ? { visualAudience: context.visualAudience } : {}),
      screenedPrompt: { messageId: prompt.messageId, ...(hookContext ? { context: hookContext } : {}) },
    },
  };
}

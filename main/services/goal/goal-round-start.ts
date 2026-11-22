/**
 * What a goal round starts with. A round is an attended chat turn that Aiden
 * began, built like the turn a settled run owes its chat
 * (`owedTurnStartRequest`): the last run's provider, model, folder, thinking
 * and withheld tools, no access of its own, so the chat's approval mode
 * applies exactly as for the person's own turns. `goalRound` marks it so the
 * turn refuses what a round may not do (setting check-backs).
 */
import type { OwedTurnContext, OwedTurnStartRequest } from "../chat-owed-turn-start.js";

export function goalRoundStartRequest(chatId: string, context: OwedTurnContext, streamId: string): OwedTurnStartRequest {
  return {
    params: {
      chatId,
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
      goalRound: true,
      excludeToolNames: new Set(context.excludeToolNames),
      ...(context.visualAudience !== undefined ? { visualAudience: context.visualAudience } : {}),
    },
  };
}

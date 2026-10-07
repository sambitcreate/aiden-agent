// Bot tool approvals on the shared tool-approval coordinator.
//
// A Bot approval is identified by its `waitId`, which the `aiden-bot`
// extension persists in the tool task's memo. The coordinator publishes the
// prompt under that id, so desktop IPC and the Remote approval routes resolve
// it by `waitId`, and a prompt re-asked after a restart keeps its id.
//
// Bots are owned by the profile, not by a renderer document: any desktop
// window or paired controller may answer, and the first answer wins.
//
// Stopping the turn (Dismiss, delete, quit) withdraws the prompt and rejects
// the request with the abort reason, so the call stays unanswered rather than
// being recorded as declined.

import { ToolApprovalCoordinator, type ToolApprovalOutcome } from "../tool-approval.js";
import type { BotApprovalRequest } from "./bot-extension.js";

export interface BotApprovalPrompt {
  botId: string;
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
}

export interface BotApprovals {
  request(request: BotApprovalRequest): Promise<"allow" | "deny">;
  /** Answer a pending prompt by `waitId`. False when nothing is waiting under that id. */
  decide(waitId: string, decision: "allow" | "deny"): boolean;
  /** Prompts waiting for an answer, oldest first; for one Bot when `botId` is given. */
  pending(botId?: string): BotApprovalPrompt[];
}

export interface BotApprovalsOptions {
  publish(prompt: BotApprovalPrompt): void;
  withdraw?(prompt: BotApprovalPrompt, outcome: ToolApprovalOutcome): void;
}

const STREAM_PREFIX = "bot:";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The approval was withdrawn.", "AbortError");
}

export function createBotApprovals(options: BotApprovalsOptions): BotApprovals {
  const waiting = new Map<string, BotApprovalPrompt>();
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => {
      const botId = prompt.streamId.slice(STREAM_PREFIX.length);
      const published: BotApprovalPrompt = {
        botId,
        waitId: prompt.approvalId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        summary: prompt.summary,
      };
      waiting.set(prompt.approvalId, published);
      options.publish(published);
    },
    (approvalId, outcome) => {
      const prompt = waiting.get(approvalId);
      waiting.delete(approvalId);
      if (prompt !== undefined) options.withdraw?.(prompt, outcome);
    },
  );

  return {
    async request(request) {
      if (request.signal?.aborted) throw abortReason(request.signal);
      const outcome = await coordinator.request(
        {
          streamId: `${STREAM_PREFIX}${request.botId}`,
          approvalId: request.waitId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          summary: request.summary,
        },
        request.signal,
      );
      if (outcome === "allowed") return "allow";
      if (request.signal?.aborted) throw abortReason(request.signal);
      return "deny";
    },
    decide(waitId, decision) {
      return coordinator.decideAsHost(waitId, decision === "allow");
    },
    pending(botId) {
      const all = [...waiting.values()];
      return botId === undefined ? all : all.filter((prompt) => prompt.botId === botId);
    },
  };
}

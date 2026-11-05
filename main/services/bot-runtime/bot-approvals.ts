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
import type { BotApprovalOwner, BotApprovalRequest } from "./bot-extension.js";

export type BotApprovalDecisionSource = "person" | "expiry" | "allow_list";

/** Main-owned provenance; absent when no decision could be obtained. */
export interface BotApprovalRequestOutcome {
  decision: "allow" | "deny";
  decisionSource?: BotApprovalDecisionSource;
}

export interface BotApprovalPrompt {
  owner?: BotApprovalOwner;
  decisionSource?: BotApprovalDecisionSource;
  botId: string;
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
}

/** Renderer prompts never carry the main-only run/input provenance or decision source. */
export function publicBotApprovalPrompt(
  prompt: BotApprovalPrompt,
): Omit<BotApprovalPrompt, "owner" | "decisionSource"> {
  return {
    botId: prompt.botId,
    waitId: prompt.waitId,
    toolCallId: prompt.toolCallId,
    toolName: prompt.toolName,
    summary: prompt.summary,
  };
}

export interface BotApprovals {
  request(request: BotApprovalRequest): Promise<"allow" | "deny">;
  requestOutcome(request: BotApprovalRequest): Promise<BotApprovalRequestOutcome>;
  /** Answer a pending prompt by `waitId`. False when nothing is waiting under that id. */
  decide(waitId: string, decision: "allow" | "deny", source?: BotApprovalDecisionSource): boolean;
  /** Prompts waiting for an answer, oldest first; for one Bot when `botId` is given. */
  pending(botId?: string): BotApprovalPrompt[];
  /** Hear a prompt appear or settle (for example to update phones watching the Bot). */
  onChange(listener: (botId: string) => void): () => void;
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
  const requests = new Map<string, { owner?: BotApprovalOwner; prompt?: BotApprovalPrompt }>();
  const waiting = new Map<string, BotApprovalPrompt>();
  const listeners = new Set<(botId: string) => void>();
  const changed = (botId: string) => {
    for (const listener of listeners) listener(botId);
  };
  const coordinator = new ToolApprovalCoordinator(
    (prompt) => {
      const botId = prompt.streamId.slice(STREAM_PREFIX.length);
      const request = requests.get(prompt.approvalId);
      const published: BotApprovalPrompt = {
        ...(request?.owner ? { owner: request.owner } : {}),
        botId,
        waitId: prompt.approvalId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        summary: prompt.summary,
      };
      if (request) request.prompt = published;
      waiting.set(prompt.approvalId, published);
      options.publish(published);
      changed(botId);
    },
    (approvalId, outcome) => {
      const prompt = waiting.get(approvalId);
      waiting.delete(approvalId);
      if (prompt !== undefined) {
        options.withdraw?.(prompt, outcome);
        changed(prompt.botId);
      }
    },
  );

  async function requestOutcome(request: BotApprovalRequest): Promise<BotApprovalRequestOutcome> {
    if (request.signal?.aborted) throw abortReason(request.signal);
    const state = { owner: request.owner, prompt: undefined as BotApprovalPrompt | undefined };
    requests.set(request.waitId, state);
    try {
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
      if (request.signal?.aborted) throw abortReason(request.signal);
      if (outcome === "cancelled") throw new DOMException("The approval was withdrawn.", "AbortError");
      const source = state.prompt?.decisionSource;
      return {
        decision: outcome === "allowed" ? "allow" : "deny",
        ...(source === undefined ? {} : { decisionSource: source }),
      };
    } finally {
      if (requests.get(request.waitId) === state) requests.delete(request.waitId);
    }
  }

  return {
    async request(request) {
      return (await requestOutcome(request)).decision;
    },
    requestOutcome,
    decide(waitId, decision, source = "person") {
      const prompt = waiting.get(waitId);
      if (prompt) prompt.decisionSource = source;
      return coordinator.decideAsHost(waitId, decision === "allow");
    },
    pending(botId) {
      const all = [...waiting.values()];
      return botId === undefined ? all : all.filter((prompt) => prompt.botId === botId);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

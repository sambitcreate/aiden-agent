import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { AskUserQuestionPromptV1, AskUserQuestionV1 } from "../../renderer/shared/ask-user-question.js";
import type { ToolApprovalScope } from "../../renderer/shared/tool-approval-scope.js";
import type { AidenRemotePendingQuestion } from "./aiden-remote-protocol.js";
import type { AidenRemotePendingApproval } from "./aiden-remote-streams.js";
import type { ToolApprovalPrompt } from "./tool-approval.js";

/** How long a card waits for an answer, the same as a phone turn's card. */
export const OWED_TURN_PROMPT_LIFETIME_MS = 5 * 60 * 1_000;

/**
 * Model operations whose approval needs the full payload on the window that
 * owns the run. A card shown anywhere else offers Deny only.
 */
const OWNING_WINDOW_ONLY_TOOLS: ReadonlySet<string> = new Set(["classify", "generate_image"]);

/** False when only the run's own window may allow this tool. */
export function approvalAllowableAwayFromOwner(toolName: string): boolean {
  return !OWNING_WINDOW_ONLY_TOOLS.has(toolName);
}

export interface OwedTurnPromptsDeps {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** A card for this chat appeared or went away; desktop windows re-read it. */
  notifyChanged(chatId: string): void;
  /** Nobody answered the approval in time: deny it. */
  expireApproval(approvalId: string): void;
  /** Nobody answered the question in time: close it as timed out. */
  expireQuestion(promptId: string): void;
}

interface Card {
  chatId: string;
  streamId: string;
  expiresAt: number;
  timer: unknown;
}

interface ApprovalCard extends Card {
  prompt: ToolApprovalPrompt;
}

interface QuestionCard extends Card {
  toolCallId: string;
  questions: AskUserQuestionV1[];
}

/**
 * Approval and question cards of owed turns. An owed turn has no window or
 * device of its own, so main keeps its cards here. Desktop windows showing
 * the chat read them through the same host card a phone turn's approval
 * uses, and paired phones answer them through their run controls. The first
 * answer wins; a card nobody answers ends like a phone turn's.
 */
export function createOwedTurnPrompts(deps: OwedTurnPromptsDeps) {
  const approvals = new Map<string, ApprovalCard>();
  const questions = new Map<string, QuestionCard>();

  function drop(id: string): void {
    const card = approvals.get(id) ?? questions.get(id);
    if (!card) return;
    deps.clearTimer(card.timer);
    approvals.delete(id);
    questions.delete(id);
    deps.notifyChanged(card.chatId);
  }

  function firstFor<T extends Card>(cards: Map<string, T>, chatId: string): [string, T] | undefined {
    const now = deps.now();
    for (const entry of cards) {
      if (entry[1].chatId === chatId && entry[1].expiresAt > now) return entry;
    }
    return undefined;
  }

  return {
    /** What the owed turn sends its owner. Only cards are kept; the rest reaches desktops as host-run frames. */
    publish(chatId: string, channel: NotificationChannel, payload: unknown): void {
      if (channel === "chat:approval") {
        const prompt = payload as ToolApprovalPrompt;
        drop(prompt.approvalId);
        const expiresAt = deps.now() + OWED_TURN_PROMPT_LIFETIME_MS;
        const timer = deps.setTimer(() => {
          if (approvals.get(prompt.approvalId)?.expiresAt === expiresAt) deps.expireApproval(prompt.approvalId);
        }, OWED_TURN_PROMPT_LIFETIME_MS);
        approvals.set(prompt.approvalId, { chatId, streamId: prompt.streamId, prompt, expiresAt, timer });
        deps.notifyChanged(chatId);
        return;
      }
      if (channel === "chat:questionnaire") {
        const prompt = payload as AskUserQuestionPromptV1;
        drop(prompt.promptId);
        const now = deps.now();
        // The agent's own deadline when it has one, never past a phone card's.
        const agentDeadline = prompt.expiresAt ? Date.parse(prompt.expiresAt) : Number.NaN;
        const expiresAt = Number.isFinite(agentDeadline)
          ? Math.min(Math.max(agentDeadline, now), now + OWED_TURN_PROMPT_LIFETIME_MS)
          : now + OWED_TURN_PROMPT_LIFETIME_MS;
        const timer = deps.setTimer(() => {
          if (questions.get(prompt.promptId)?.expiresAt === expiresAt) deps.expireQuestion(prompt.promptId);
        }, expiresAt - now);
        questions.set(prompt.promptId, {
          chatId,
          streamId: prompt.streamId,
          toolCallId: prompt.toolCallId,
          questions: structuredClone(prompt.questions),
          expiresAt,
          timer,
        });
        deps.notifyChanged(chatId);
        return;
      }
      if (channel === "chat:done" || channel === "chat:error") {
        const streamId = (payload as { streamId?: unknown } | null)?.streamId;
        for (const [id, card] of [...approvals, ...questions]) {
          if (card.streamId === streamId) drop(id);
        }
      }
    },

    /** The approval or question was answered, denied, timed out or withdrawn. */
    settled(id: string): void {
      drop(id);
    },

    approvalForChat(chatId: string): AidenRemotePendingApproval | null {
      const found = firstFor(approvals, chatId);
      if (!found) return null;
      const [approvalId, card] = found;
      const canAllow = approvalAllowableAwayFromOwner(card.prompt.toolName);
      const scopes: ToolApprovalScope[] = (card.prompt.scopes ?? []).filter((scope) => scope !== "once");
      return {
        approvalId,
        streamId: card.streamId,
        chatId,
        summary: card.prompt.summary,
        toolCallId: card.prompt.toolCallId,
        toolName: card.prompt.toolName,
        expiresAt: new Date(card.expiresAt).toISOString(),
        canAllow,
        ...(canAllow && scopes.length > 0 ? { scopes } : {}),
        ...(card.prompt.details ? { details: structuredClone(card.prompt.details) } : {}),
      };
    },

    questionForChat(chatId: string): AidenRemotePendingQuestion | null {
      const found = firstFor(questions, chatId);
      if (!found) return null;
      const [promptId, card] = found;
      return {
        promptId,
        streamId: card.streamId,
        chatId,
        toolCallId: card.toolCallId,
        questions: structuredClone(card.questions),
        expiresAt: new Date(card.expiresAt).toISOString(),
      };
    },

    /**
     * True when `approvalId` is an open card of an owed turn in this chat that
     * a desktop window may answer this way. Deny is always offered; Allow is
     * not for tools only the owning window may allow.
     */
    canDecide(chatId: string, approvalId: string, decision: "allow" | "deny"): boolean {
      const card = approvals.get(approvalId);
      if (!card || card.chatId !== chatId || card.expiresAt <= deps.now()) return false;
      return decision === "deny" || approvalAllowableAwayFromOwner(card.prompt.toolName);
    },

    /** True when `promptId` is an open question of an owed turn in this chat. */
    hasQuestion(chatId: string, promptId: string): boolean {
      const card = questions.get(promptId);
      return card !== undefined && card.chatId === chatId && card.expiresAt > deps.now();
    },
  };
}

export type OwedTurnPrompts = ReturnType<typeof createOwedTurnPrompts>;

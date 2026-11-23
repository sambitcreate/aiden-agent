/**
 * How a keep-going round starts: offered first to a focused window that shows
 * its chat (`goal-window-rounds.ts`), and started without a window otherwise.
 * Every effect is a dependency, so the order of the checks (the goal is still
 * the one at work after the offer, when the round's message is saved and just
 * before the turn starts) is testable; `goal-main.ts` binds them.
 */
import type { AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import type { OwedTurnContext, OwedTurnStartRequest } from "../chat-owed-turn-start.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import type { ChatTurnLease } from "../chat-turn-admission.js";
import type { StartTurnResult } from "../follow-through/notice-delivery.js";
import { goalRoundStartRequest } from "./goal-round-start.js";
import type { GoalWindowRoundResult } from "./goal-window-rounds.js";

/** Whether the goal a round was started for is still the one at work; a round for anything else never begins. */
export type RoundStillCurrent = () => boolean;

/** The round's message: the continuation note, or a notice. */
export interface GoalRoundMessage {
  text: string;
  notice: AgentNoticeV1;
}

/** A window-owned round: the window's document owns it, with the stream the window subscribed to. */
export interface WindowRoundOwner {
  owner: ChatGenerationOwner;
  streamId: string;
}

/** What a round offered to a window carries; the window's start sets `outcome`. */
export interface WindowRoundPayload {
  context: OwedTurnContext;
  /** The round's message; none when it answers a notice already saved. */
  round: GoalRoundMessage | undefined;
  isCurrent: RoundStillCurrent;
  /** How the window's start went, set by the window's start. */
  outcome?: StartTurnResult;
}

export type GoalRoundLease = Pick<ChatTurnLease, "isActive" | "reserveAppendPayload" | "settleAsyncWork" | "release">;

export interface GoalRoundStarterDependencies {
  /** Offers the round to a focused window that shows the chat (`GoalWindowRounds.offer`). */
  offer(chatId: string, payload: WindowRoundPayload): Promise<GoalWindowRoundResult>;
  newStreamId(): string;
  /** The owner of a round without a window: its cards wait, as for an attended turn. */
  attendedTurnOwner(chatId: string, streamId: string): ChatGenerationOwner;
  beginChatTurn(chatId: string, streamId: string, ownerId: string): GoalRoundLease | null;
  appendMessage(
    chatId: string,
    message: { role: "user"; content: string; notice: AgentNoticeV1 },
    options: { providerId: string; model: string; expectedWorkspaceId?: string; isCurrent: () => boolean },
  ): Promise<{ messages: ReadonlyArray<{ id?: string }> }>;
  start(
    streamId: string,
    params: OwedTurnStartRequest["params"],
    owner: ChatGenerationOwner,
    options: OwedTurnStartRequest["options"],
  ): Promise<boolean>;
  transcriptChanged(chatId: string): void;
  log(message: string, error: unknown): void;
}

export interface GoalRoundStarter {
  /**
   * Starts an attended round in the chat: with `message` saved first, or
   * answering the chat's latest saved message. Without a window its cards
   * wait; in a window (`window`) the round is that window's run. `isCurrent`
   * is checked when the round's message is saved and again just before the
   * turn starts.
   */
  startAttendedRound(
    chatId: string,
    context: OwedTurnContext,
    message: GoalRoundMessage | undefined,
    window?: WindowRoundOwner,
    isCurrent?: RoundStillCurrent,
  ): Promise<StartTurnResult>;
  /**
   * A round, the next one or one that answers a notice, starts in a focused
   * window that shows the chat when there is one, and without a window otherwise.
   */
  startGoalRound(
    chatId: string,
    context: OwedTurnContext,
    round: GoalRoundMessage | undefined,
    isCurrent: RoundStillCurrent,
  ): Promise<StartTurnResult>;
}

export function createGoalRoundStarter(deps: GoalRoundStarterDependencies): GoalRoundStarter {
  async function startAttendedRound(
    chatId: string,
    context: OwedTurnContext,
    message: GoalRoundMessage | undefined,
    window?: WindowRoundOwner,
    isCurrent: RoundStillCurrent = () => true,
  ): Promise<StartTurnResult> {
    const streamId = window?.streamId ?? deps.newStreamId();
    const owner = window?.owner ?? deps.attendedTurnOwner(chatId, streamId);
    const lease = deps.beginChatTurn(chatId, streamId, owner.documentId);
    if (!lease) return { kind: "busy" };
    let messageId: string | undefined;
    try {
      if (message) {
        lease.reserveAppendPayload(Buffer.byteLength(message.text, "utf8") + 1_024);
        const saved = await deps.appendMessage(
          chatId,
          { role: "user", content: message.text, notice: message.notice },
          {
            providerId: context.providerId,
            model: context.model,
            ...(context.workspaceId !== undefined ? { expectedWorkspaceId: context.workspaceId } : {}),
            isCurrent: () => lease.isActive() && isCurrent(),
          },
        );
        messageId = saved.messages[saved.messages.length - 1]?.id;
        deps.transcriptChanged(chatId);
      }
      lease.settleAsyncWork();
      if (!isCurrent()) {
        lease.release();
        return { kind: "unavailable", reason: "The goal changed before the round began.", ...(messageId ? { messageId } : {}) };
      }
      const request = goalRoundStartRequest(chatId, context, streamId);
      const started = await deps.start(streamId, request.params, owner, request.options);
      if (!started) {
        lease.release();
        return { kind: "unavailable", reason: "The round stopped before it began.", ...(messageId ? { messageId } : {}) };
      }
      return { kind: "started", streamId, ...(messageId ? { messageId } : {}) };
    } catch (error) {
      lease.release();
      lease.settleAsyncWork();
      deps.log("A keep-going round could not start.", error);
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : "The round could not start.",
        ...(messageId ? { messageId } : {}),
      };
    }
  }

  async function startGoalRound(
    chatId: string,
    context: OwedTurnContext,
    round: GoalRoundMessage | undefined,
    isCurrent: RoundStillCurrent,
  ): Promise<StartTurnResult> {
    const payload: WindowRoundPayload = { context, round, isCurrent };
    const inWindow = await deps.offer(chatId, payload);
    if (inWindow !== "no-window") {
      return payload.outcome ?? (inWindow === "busy" ? { kind: "busy" } : { kind: "unavailable", reason: "The round could not start." });
    }
    // The offer can wait up to 5 seconds for a window: the person may have paused meanwhile.
    if (!isCurrent()) return { kind: "unavailable", reason: "The goal changed before the round began." };
    return startAttendedRound(chatId, context, round, undefined, isCurrent);
  }

  return { startAttendedRound, startGoalRound };
}

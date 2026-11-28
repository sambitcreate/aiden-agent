/**
 * Main-process wiring for keep-going goals: the loop (`goal-loop.ts`) bound to
 * the chat client, the chat store, the reviewer, spending, usage, analytics
 * and IPC broadcasts. Goals are saved with follow-through's state; each
 * Aiden process has its own boot id, so a goal left active by the last one
 * comes back paused.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, logger, powerMonitor } from "../../platform.js";
import { goalLoopEnabled, type GoalView } from "../../../renderer/shared/goal.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import {
  ATTENDED_TURN_PROMPT_LIFETIME_MS,
  type OwedTurnPromptLifetime,
} from "../chat-owed-turn-prompts.js";
import { chatActivityRegistry } from "../chat-activity.js";
import type { GoalNeedsYou } from "../chat-pending-attention.js";
import { chatStore } from "../chat-store.js";
import { chatMessageToPiMessage } from "../generation-messages.js";
import { llmClient } from "../llm-client.js";
import { resolveModelRuntime } from "../model-runtime.js";
import { chatSideCallPrefixes } from "../side-call-prefix.js";
import { createSpendingMeter, spendCounts } from "../spending-service.js";
import { spending } from "../spending-main.js";
import { isLocalModelProvider } from "../usage-accounting.js";
import { usageStore } from "../usage-store.js";
import {
  backgroundJobs,
  prepareGoalCheck,
  runGoalCheck,
  saveFollowThroughGoals,
  savedFollowThroughGoals,
} from "../follow-through/follow-through-main.js";
import { noticeDelivery } from "../follow-through/notice-delivery-main.js";
import type { StartTurnResult } from "../follow-through/notice-delivery.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import type { OwedTurnContext } from "../chat-owed-turn-start.js";
import type { Chat } from "../types.js";
import { goalChatRefusal } from "./goal-core.js";
import { GoalLoop, type GoalRoundStart } from "./goal-loop.js";
import {
  createGoalRoundStarter,
  type GoalRoundMessage,
  type RoundStillCurrent,
  type WindowRoundPayload,
} from "./goal-round-starter.js";
import { reviewGoal } from "./goal-reviewer.js";
import { installGoalTurnHooks } from "./goal-turn-hooks.js";
import {
  GoalWindowRounds,
  type GoalWindowDocument,
  type GoalWindowView,
} from "./goal-window-rounds.js";
import { GoalProposals } from "./goal-proposals.js";

const BOOT = randomUUID();

/** How often a look waiting for a busy chat checks it again. */
const IDLE_POLL_MS = 1_000;

const lookingListeners = new Set<() => void>();

/** Called when the loop starts or stops looking at a chat (`goalLoop.looking()`), for keep-awake. */
export function onGoalLookingChanged(listener: () => void): () => void {
  lookingListeners.add(listener);
  return () => lookingListeners.delete(listener);
}

function transcriptChanged(chatId: string): void {
  ipcMain.broadcast("chats:changed", {});
  ipcMain.broadcast("chats:follow-through-changed", { chatId, transcript: true });
}

/** Why this chat cannot have a goal (`goalChatRefusal`). */
async function eligibility(chatId: string): Promise<string | undefined> {
  return goalChatRefusal(await chatStore.get(chatId));
}

/** What the round that just settled did: everything after the chat's last user message. */
function roundActivity(chat: Chat | null): { toolCalls: number; newTextChars: number } {
  const messages = chat?.messages ?? [];
  let start = messages.length;
  while (start > 0 && messages[start - 1]!.role !== "user") start -= 1;
  let toolCalls = 0;
  let newTextChars = 0;
  for (const message of messages.slice(start)) {
    if (message.role !== "assistant") continue;
    newTextChars += message.content.trim().length;
    toolCalls += message.timeline?.steps.filter((step) => step.kind === "tool").length ?? 0;
  }
  return { toolCalls, newTextChars };
}

/** A round's cards wait 30 minutes; one nobody answers moves the goal to Needs you. */
const roundPromptLifetime: OwedTurnPromptLifetime = {
  ms: ATTENDED_TURN_PROMPT_LIFETIME_MS,
  expired: (chatId) => goalLoop.promptExpired(chatId),
};

/** Which window, if any, starts each due round (`goal-window-rounds.ts`). */
const goalWindowRounds = new GoalWindowRounds<WindowRoundPayload>({
  newToken: () => randomUUID(),
  screenLocked: () => powerMonitor.getSystemIdleState(1) === "locked",
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  closedMidRound: ({ chatId, streamId, documentId }) => {
    // Pause first, so the stop below reads as the window closing, not the person's Stop.
    goalLoop.windowClosed(chatId);
    llmClient.cancel(streamId, "user_stop", documentId);
  },
});

const { startAttendedRound, startGoalRound } = createGoalRoundStarter({
  offer: (chatId, payload) => goalWindowRounds.offer(chatId, payload),
  newStreamId: () => `goal-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  attendedTurnOwner: (chatId, streamId) =>
    llmClient.attendedTurnOwner(chatId, `goal:${streamId}`, roundPromptLifetime),
  beginChatTurn: (chatId, streamId, ownerId) => llmClient.beginChatTurn(chatId, streamId, ownerId),
  appendMessage: (chatId, message, options) => chatStore.appendMessage(chatId, message, options),
  start: (streamId, params, owner, options) => llmClient.start(streamId, params, owner, options),
  transcriptChanged,
  log: (message, error) => logger.warn("goal", message, error),
});

async function startRound(
  chatId: string,
  context: OwedTurnContext,
  round: GoalRoundMessage,
  isCurrent: RoundStillCurrent,
): Promise<GoalRoundStart> {
  const started = await startGoalRound(chatId, context, round, isCurrent);
  return started.kind === "started" ? "started" : started.kind === "busy" ? "busy" : "unavailable";
}

/** Documents whose end is already watched. */
const watchedDocuments = new Set<string>();

/** A window says which chat its pane shows and whether it has focus; the view ends when the document does. */
export function reportGoalWindowView(
  document: GoalWindowDocument & { onGone(listener: () => void): () => void },
  view: GoalWindowView,
): void {
  goalWindowRounds.report(document, view);
  if (watchedDocuments.has(document.documentId)) return;
  watchedDocuments.add(document.documentId);
  const stop = document.onGone(() => {
    stop();
    watchedDocuments.delete(document.documentId);
    goalWindowRounds.gone(document.documentId);
  });
}

/**
 * The window takes the round it was offered with `token` and starts it as its
 * own run on `streamId`. Throws when the offer is gone (it timed out, or went
 * to another window), so the window drops it.
 */
export async function startGoalWindowRound(
  owner: ChatGenerationOwner,
  token: string,
  streamId: string,
): Promise<StartTurnResult> {
  const claim = goalWindowRounds.claim(token, owner.documentId);
  if (!claim) throw new Error("This keep-going round is no longer waiting for this window.");
  let result: StartTurnResult = { kind: "unavailable", reason: "The round could not start." };
  try {
    // Its cards show in the window, and one unanswered for 30 minutes moves the goal to Needs you, as off screen.
    const roundOwner = llmClient.attendedWindowOwner(owner, claim.chatId, roundPromptLifetime);
    result = await startAttendedRound(
      claim.chatId,
      claim.payload.context,
      claim.payload.round,
      { owner: roundOwner, streamId },
      claim.payload.isCurrent,
    );
    return result;
  } finally {
    claim.payload.outcome = result;
    claim.settle(
      result.kind === "started"
        ? { kind: "started", streamId }
        : { kind: result.kind === "busy" ? "busy" : "unavailable" },
    );
    if (result.kind === "started") goalLoop.windowRoundStarted(claim.chatId);
  }
}

/** The window can't take the round (busy, or showing a draft): it runs without one. */
export function declineGoalWindowRound(documentId: string, token: string): void {
  goalWindowRounds.decline(token, documentId);
}

export const goalLoop = new GoalLoop({
  enabled: goalLoopEnabled,
  boot: BOOT,
  now: Date.now,
  newId: () => `goal-${randomUUID()}`,
  delay: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  persist: saveFollowThroughGoals,
  onChange: (chatId: string, goal: GoalView | null) => {
    ipcMain.broadcast("chats:goal-changed", { chatId, goal });
    // The Inbox and Dock badge recount: a goal at Needs you is a Needs you row.
    chatActivityRegistry.touch();
  },
  eligibility,
  isChatBusy: (chatId) => llmClient.isChatBusy(chatId) || noticeDelivery.hasPending(chatId),
  helperRunning: (chatId) => llmClient.chatHasLiveHelpers(chatId),
  jobsRunning: (chatId) => backgroundJobs.list(chatId).some((job) => job.state === "running"),
  roundActivity: async (chatId) => roundActivity(await chatStore.get(chatId)),
  fallbackContext: async (chatId) => {
    const chat = await chatStore.get(chatId);
    if (!chat?.providerId || !chat.model) return undefined;
    return {
      ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
      providerId: chat.providerId,
      model: chat.model,
    };
  },
  review: async (goal, input) => {
    const chat = await chatStore.get(goal.chatId);
    if (!chat?.providerId || !chat.model)
      return { kind: "unusable", why: "failed", via: "isolated" };
    const runtime = await resolveModelRuntime(chat.providerId, chat.model, input.signal, chat.id);
    const owner = { kind: "chat" as const, id: chat.id };
    const meter = createSpendingMeter({
      spending,
      owner,
      counts: () =>
        spendCounts({
          local: isLocalModelProvider(runtime.provider),
          provider: runtime.provider,
          models: runtime.models,
        }),
    });
    const supportsImages = runtime.model.input.includes("image");
    const outcome = await reviewGoal(
      {
        runtime,
        prefix: () => chatSideCallPrefixes.latest(chat.id),
        messages: async () =>
          chat.messages.map((message) =>
            chatMessageToPiMessage(message, runtime.model, supportsImages),
          ),
        spendingRefusal: () => spending.refusal(owner),
        countSpend: (message) => meter.count(message),
        recordUsage: (record) => usageStore.record(record),
        reportFailure: (area, error) =>
          logger.warn("goal", `The goal review's ${area} step failed.`, error),
      },
      { goal, allowWait: input.allowWait, signal: input.signal },
    );
    await meter
      .settled()
      .catch((error: unknown) =>
        logger.warn("goal", "The goal review's cost could not be counted.", error),
      );
    return outcome;
  },
  runCheck: (goal, signal) => runGoalCheck(goal.chatId, goal.check!.command, signal),
  prepareCheck: prepareGoalCheck,
  startRound,
  startNoticeRound: startGoalRound,
  waitForIdle: async (chatId, signal) => {
    // Whatever holds the chat may settle no run (a notice saved as a card, a
    // scheduled task's admission): poll until nothing does.
    while (!signal.aborted && (llmClient.isChatBusy(chatId) || noticeDelivery.hasPending(chatId))) {
      if (
        !(await llmClient.waitForChatIdleWithin(chatId, IDLE_POLL_MS)) ||
        noticeDelivery.hasPending(chatId)
      ) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, IDLE_POLL_MS);
          timer.unref?.();
        });
      }
    }
  },
  lookingChanged: () => {
    for (const listener of lookingListeners) listener();
  },
  report: (event) => {
    if (event.event === "goal_started") reportAnalyticsEvent("goal_started", event.properties);
    else reportAnalyticsEvent("goal_settled", event.properties);
  },
  log: (message, error) => logger.warn("goal", message, error),
});

/** Goals the agent suggested with `propose_goal`, waiting for Start or Not now. */
export const goalProposals = new GoalProposals({
  now: Date.now,
  onChange: (chatId, proposal) =>
    ipcMain.broadcast("chats:goal-proposal-changed", { chatId, proposal }),
  refusal: async (chatId) => {
    const refusal = await eligibility(chatId);
    if (refusal) return refusal;
    return goalLoop.get(chatId)?.status === "active"
      ? "This chat already has a goal at work."
      : undefined;
  },
});

let started = false;

/** After follow-through loaded its state: restore goals (active ones come back paused) and hook into chats. */
export function startGoalLoop(): void {
  if (started) return;
  started = true;
  goalLoop.restore(savedFollowThroughGoals());
  installGoalTurnHooks({
    kickoff: (chatId) => goalLoop.kickoff(chatId),
    reminder: (chatId) => goalLoop.reminder(chatId),
    objective: (chatId) => goalLoop.get(chatId)?.objective,
    runSettled: (event) => {
      goalWindowRounds.settled(event.streamId);
      goalLoop.runSettled(event);
    },
    chatDeleted: (chatId) => {
      goalProposals.dismiss(chatId);
      goalLoop.deleteChat(chatId);
    },
    accessChanged: (chatIds) => goalLoop.accessChanged(chatIds),
    moveRefusal: (chatId) => goalLoop.moveRefusal(chatId),
    noticeRound: (chatId, notice) => goalLoop.noticeRound(chatId, notice),
    windowToolRefused: (chatId) => goalLoop.windowWanted(chatId),
    proposeGoal: (chatId, objective) => goalProposals.propose(chatId, objective),
  });
}

/** The chat's goal when it stopped at Needs you, for the Inbox. */
export function goalNeedsYou(chatId: string): GoalNeedsYou | undefined {
  const goal = goalLoop.get(chatId);
  return goal?.status === "needs-you"
    ? { since: goal.updatedAt, reason: goal.reason ?? "The keep-going goal needs you" }
    : undefined;
}

export function shutdownGoalLoop(): void {
  goalLoop.shutdown();
}

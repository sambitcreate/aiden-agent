/**
 * Main-process wiring for keep-going goals: the loop (`goal-loop.ts`) bound to
 * the chat client, the chat store, the reviewer, spending, usage, analytics
 * and IPC broadcasts. Goals are saved with follow-through's state; each
 * Aiden process has its own boot id, so a goal left active by the last one
 * comes back paused.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, logger, powerMonitor } from "../../platform.js";
import { ASSISTANT_WORKSPACE_ID } from "../../../renderer/shared/assistant.js";
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
import { goalLoopEnabled, type GoalView } from "../../../renderer/shared/goal.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { ATTENDED_TURN_PROMPT_LIFETIME_MS, type OwedTurnPromptLifetime } from "../chat-owed-turn-prompts.js";
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
import type { Chat } from "../types.js";
import type { AgentNoticeV1 } from "../../../renderer/shared/agent-notices.js";
import { GoalLoop, type GoalRoundStart } from "./goal-loop.js";
import { goalRoundStartRequest } from "./goal-round-start.js";
import { reviewGoal } from "./goal-reviewer.js";
import { installGoalTurnHooks } from "./goal-turn-hooks.js";
import { GoalWindowRounds, type GoalWindowDocument, type GoalWindowView } from "./goal-window-rounds.js";

const BOOT = randomUUID();

function transcriptChanged(chatId: string): void {
  ipcMain.broadcast("chats:changed", {});
  ipcMain.broadcast("chats:follow-through-changed", { chatId, transcript: true });
}

/** Why this chat cannot have a goal: Bots, the Assistant, agent harnesses and chats another feature owns. */
async function eligibility(chatId: string): Promise<string | undefined> {
  const chat = await chatStore.get(chatId);
  if (!chat) return "This chat no longer exists.";
  if (chat.botId) return "Bots can't have a keep-going goal.";
  if (chat.owner !== undefined) return "This chat runs its own way, so it can't have a goal.";
  if (chat.workspaceId === ASSISTANT_WORKSPACE_ID) return "The Assistant can't have a keep-going goal.";
  if (!chat.providerId || !chat.model) return "Choose a model for this chat first.";
  if (isAcpHarnessProvider(chat.providerId)) return "Chats with an agent harness can't have a keep-going goal.";
  return undefined;
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

/** A window-owned round: the window's document owns it, with the stream the window subscribed to. */
interface WindowRoundOwner {
  owner: ChatGenerationOwner;
  streamId: string;
}

/**
 * Starts an attended round in the chat: with `message` saved first (the
 * continuation note, or a notice), or answering the chat's latest saved
 * message. Without a window its cards wait 30 minutes; in a window
 * (`window`) the round is that window's run, with every tool.
 */
async function startAttendedRound(
  chatId: string,
  context: Parameters<typeof goalRoundStartRequest>[1],
  message: { text: string; notice: AgentNoticeV1 } | undefined,
  window?: WindowRoundOwner,
): Promise<StartTurnResult> {
  const streamId = window?.streamId ?? `goal-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const owner = window?.owner ?? llmClient.attendedTurnOwner(chatId, `goal:${streamId}`, roundPromptLifetime);
  const lease = llmClient.beginChatTurn(chatId, streamId, owner.documentId);
  if (!lease) return { kind: "busy" };
  let messageId: string | undefined;
  try {
    if (message) {
      lease.reserveAppendPayload(Buffer.byteLength(message.text, "utf8") + 1_024);
      const saved = await chatStore.appendMessage(
        chatId,
        { role: "user", content: message.text, notice: message.notice },
        {
          providerId: context.providerId,
          model: context.model,
          ...(context.workspaceId !== undefined ? { expectedWorkspaceId: context.workspaceId } : {}),
          isCurrent: () => lease.isActive(),
        },
      );
      messageId = saved.messages[saved.messages.length - 1]?.id;
      transcriptChanged(chatId);
    }
    lease.settleAsyncWork();
    const request = goalRoundStartRequest(chatId, context, streamId);
    const started = await llmClient.start(streamId, request.params, owner, request.options);
    if (!started) {
      lease.release();
      return { kind: "unavailable", reason: "The round stopped before it began.", ...(messageId ? { messageId } : {}) };
    }
    return { kind: "started", streamId, ...(messageId ? { messageId } : {}) };
  } catch (error) {
    lease.release();
    lease.settleAsyncWork();
    logger.warn("goal", "A keep-going round could not start.", error);
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "The round could not start.",
      ...(messageId ? { messageId } : {}),
    };
  }
}

interface WindowRoundPayload {
  context: Parameters<typeof goalRoundStartRequest>[1];
  round: { text: string; notice: AgentNoticeV1 };
}

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

/** A round starts in a focused window that shows the chat when there is one, and without a window otherwise. */
async function startRound(
  chatId: string,
  context: Parameters<typeof goalRoundStartRequest>[1],
  round: { text: string; notice: AgentNoticeV1 },
): Promise<GoalRoundStart> {
  const inWindow = await goalWindowRounds.offer(chatId, { context, round });
  if (inWindow !== "no-window") return inWindow;
  const started = await startAttendedRound(chatId, context, round);
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
export async function startGoalWindowRound(owner: ChatGenerationOwner, token: string, streamId: string): Promise<StartTurnResult> {
  const claim = goalWindowRounds.claim(token, owner.documentId);
  if (!claim) throw new Error("This keep-going round is no longer waiting for this window.");
  let result: StartTurnResult = { kind: "unavailable", reason: "The round could not start." };
  try {
    result = await startAttendedRound(claim.chatId, claim.payload.context, claim.payload.round, { owner, streamId });
    return result;
  } finally {
    claim.settle(result.kind === "started" ? { kind: "started", streamId } : { kind: result.kind === "busy" ? "busy" : "unavailable" });
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
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
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
    return { ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}), providerId: chat.providerId, model: chat.model };
  },
  review: async (goal, input) => {
    const chat = await chatStore.get(goal.chatId);
    if (!chat?.providerId || !chat.model) return { kind: "unusable", why: "failed", via: "isolated" };
    const runtime = await resolveModelRuntime(chat.providerId, chat.model, input.signal, chat.id);
    const owner = { kind: "chat" as const, id: chat.id };
    const meter = createSpendingMeter({
      spending,
      owner,
      counts: () => spendCounts({ local: isLocalModelProvider(runtime.provider), provider: runtime.provider, models: runtime.models }),
    });
    const supportsImages = runtime.model.input.includes("image");
    const outcome = await reviewGoal(
      {
        runtime,
        prefix: () => chatSideCallPrefixes.latest(chat.id),
        messages: async () => chat.messages.map((message) => chatMessageToPiMessage(message, runtime.model, supportsImages)),
        spendingRefusal: () => spending.refusal(owner),
        countSpend: (message) => meter.count(message),
        recordUsage: (record) => usageStore.record(record),
        reportFailure: (area, error) => logger.warn("goal", `The goal review's ${area} step failed.`, error),
      },
      { goal, allowWait: input.allowWait, signal: input.signal },
    );
    await meter.settled().catch((error: unknown) => logger.warn("goal", "The goal review's cost could not be counted.", error));
    return outcome;
  },
  runCheck: (goal, signal) => runGoalCheck(goal.chatId, goal.check!.command, signal),
  prepareCheck: prepareGoalCheck,
  startRound,
  startNoticeRound: startAttendedRound,
  report: (event) => {
    if (event.event === "goal_started") reportAnalyticsEvent("goal_started", event.properties);
    else reportAnalyticsEvent("goal_settled", event.properties);
  },
  log: (message, error) => logger.warn("goal", message, error),
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
    runSettled: (event) => {
      goalWindowRounds.settled(event.streamId);
      goalLoop.runSettled(event);
    },
    chatDeleted: (chatId) => goalLoop.deleteChat(chatId),
    accessChanged: (chatIds) => goalLoop.accessChanged(chatIds),
    moveRefusal: (chatId) => goalLoop.moveRefusal(chatId),
    noticeRound: (chatId, notice) => goalLoop.noticeRound(chatId, notice),
    windowToolRefused: (chatId) => goalLoop.windowWanted(chatId),
  });
}

/** The chat's goal when it stopped at Needs you, for the Inbox. */
export function goalNeedsYou(chatId: string): GoalNeedsYou | undefined {
  const goal = goalLoop.get(chatId);
  return goal?.status === "needs-you" ? { since: goal.updatedAt, reason: goal.reason ?? "The keep-going goal needs you" } : undefined;
}

export function shutdownGoalLoop(): void {
  goalLoop.shutdown();
}

/**
 * Main-process wiring for keep-going goals: the loop (`goal-loop.ts`) bound to
 * the chat client, the chat store, the reviewer, spending, usage, analytics
 * and IPC broadcasts. Goals are saved with follow-through's state; each
 * Aiden process has its own boot id, so a goal left active by the last one
 * comes back paused.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, logger } from "../../platform.js";
import { ASSISTANT_WORKSPACE_ID } from "../../../renderer/shared/assistant.js";
import { isAcpHarnessProvider } from "../../../renderer/shared/acp-harness.js";
import { goalLoopEnabled, type GoalView } from "../../../renderer/shared/goal.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { chatStore } from "../chat-store.js";
import { chatMessageToPiMessage } from "../generation-messages.js";
import { llmClient } from "../llm-client.js";
import { resolveModelRuntime } from "../model-runtime.js";
import { chatSideCallPrefixes } from "../side-call-prefix.js";
import { createSpendingMeter, spendCounts } from "../spending-service.js";
import { spending } from "../spending-main.js";
import { isLocalModelProvider } from "../usage-accounting.js";
import { usageStore } from "../usage-store.js";
import { backgroundJobs, saveFollowThroughGoals, savedFollowThroughGoals } from "../follow-through/follow-through-main.js";
import { noticeDelivery } from "../follow-through/notice-delivery-main.js";
import type { Chat } from "../types.js";
import { GoalLoop, type GoalRoundStart } from "./goal-loop.js";
import { goalRoundStartRequest } from "./goal-round-start.js";
import { reviewGoal } from "./goal-reviewer.js";
import { installGoalTurnHooks } from "./goal-turn-hooks.js";

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

async function startRound(
  chatId: string,
  context: Parameters<typeof goalRoundStartRequest>[1],
  round: { text: string; notice: import("../../../renderer/shared/agent-notices.js").AgentNoticeV1 },
): Promise<GoalRoundStart> {
  const streamId = `goal-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const owner = llmClient.attendedTurnOwner(chatId, `goal:${streamId}`);
  const lease = llmClient.beginChatTurn(chatId, streamId, owner.documentId);
  if (!lease) return "busy";
  try {
    lease.reserveAppendPayload(Buffer.byteLength(round.text, "utf8") + 1_024);
    await chatStore.appendMessage(
      chatId,
      { role: "user", content: round.text, notice: round.notice },
      {
        providerId: context.providerId,
        model: context.model,
        ...(context.workspaceId !== undefined ? { expectedWorkspaceId: context.workspaceId } : {}),
        isCurrent: () => lease.isActive(),
      },
    );
    transcriptChanged(chatId);
    lease.settleAsyncWork();
    const request = goalRoundStartRequest(chatId, context, streamId);
    const started = await llmClient.start(streamId, request.params, owner, request.options);
    if (!started) {
      lease.release();
      return "unavailable";
    }
    return "started";
  } catch (error) {
    lease.release();
    lease.settleAsyncWork();
    logger.warn("goal", "A keep-going round could not start.", error);
    return "unavailable";
  }
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
  onChange: (chatId: string, goal: GoalView | null) => ipcMain.broadcast("chats:goal-changed", { chatId, goal }),
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
  startRound,
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
    runSettled: (event) => goalLoop.runSettled(event),
    chatDeleted: (chatId) => goalLoop.deleteChat(chatId),
    accessChanged: (chatIds) => goalLoop.accessChanged(chatIds),
    moveRefusal: (chatId) => goalLoop.moveRefusal(chatId),
  });
}

export function shutdownGoalLoop(): void {
  goalLoop.shutdown();
}

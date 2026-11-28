// How a keep-going round starts with fake windows, chats and turns: offered
// to a window first, and checked against the goal at every step before it begins.

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentNotice } from "../../../renderer/shared/agent-notices.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import type { StartTurnResult } from "../follow-through/notice-delivery.js";
import {
  createGoalRoundStarter,
  type GoalRoundStarterDependencies,
  type WindowRoundPayload,
} from "./goal-round-starter.js";
import type { GoalWindowRoundResult } from "./goal-window-rounds.js";

const CHAT = "chat-1";
const CONTEXT = { workspaceId: "ws-1", providerId: "anthropic", model: "claude" };
const ROUND = {
  text: "Keep going: write the changelog.",
  notice: agentNotice({
    source: "goal",
    tone: "info",
    title: "Keep going · round 2 of 50",
    summary: "Write the changelog",
  }),
};

function owner(documentId: string): ChatGenerationOwner {
  return {
    id: 0,
    documentId,
    isDestroyed: () => false,
    send: () => {},
  } as unknown as ChatGenerationOwner;
}

function harness(
  options: { window?: (payload: WindowRoundPayload) => Promise<GoalWindowRoundResult> } = {},
) {
  const saved: Array<{ content: string; stillCurrent: boolean }> = [];
  const started: string[] = [];
  const leases = { begun: 0, released: 0 };
  const hooks = {
    /** Runs while the round's message is being saved. */
    duringAppend: () => {},
    /** Runs after the message is saved, before the turn would start. */
    afterAppend: () => {},
  };
  const deps: GoalRoundStarterDependencies = {
    offer: (_chatId, payload) => options.window?.(payload) ?? Promise.resolve("no-window"),
    newStreamId: () => "goal-stream",
    attendedTurnOwner: () => owner("attended"),
    beginChatTurn: () => {
      leases.begun += 1;
      return {
        isActive: () => true,
        reserveAppendPayload: () => {},
        settleAsyncWork: () => {},
        release: () => {
          leases.released += 1;
        },
      };
    },
    appendMessage: async (_chatId, message, append) => {
      hooks.duringAppend();
      // The store refuses to save when the round's check says no.
      const stillCurrent = append.isCurrent();
      saved.push({ content: message.content, stillCurrent });
      if (!stillCurrent) throw new Error("The goal changed before the message was saved.");
      hooks.afterAppend();
      return { messages: [{ id: "msg-1" }] };
    },
    start: async (streamId) => {
      started.push(streamId);
      return true;
    },
    transcriptChanged: () => {},
    log: () => {},
  };
  return { starter: createGoalRoundStarter(deps), saved, started, leases, hooks };
}

test("a goal paused while the offer waited for a window starts nothing without one", async () => {
  let current = true;
  const h = harness({
    window: async () => {
      // The person presses Pause during the offer's wait.
      current = false;
      return "no-window";
    },
  });
  const result = await h.starter.startGoalRound(CHAT, CONTEXT, ROUND, () => current);
  assert.equal(result.kind, "unavailable");
  assert.equal(h.leases.begun, 0, "no turn was even reserved");
  assert.deepEqual(h.saved, [], "the round's message isn't saved");
  assert.deepEqual(h.started, []);

  // With the goal still at work, the same round starts off screen.
  const idle = harness();
  const started = await idle.starter.startGoalRound(CHAT, CONTEXT, ROUND, () => true);
  assert.deepEqual(started, { kind: "started", streamId: "goal-stream", messageId: "msg-1" });
});

test("a notice round goes through the window offer and returns the window's own outcome", async () => {
  const offered: WindowRoundPayload[] = [];
  const h = harness({
    window: async (payload) => {
      offered.push(payload);
      // The window starts it as its own run and says how it went.
      payload.outcome = { kind: "started", streamId: "window-stream", messageId: "msg-notice" };
      return "started";
    },
  });
  // A notice already saved: the round answers it, with no message of its own.
  const result: StartTurnResult = await h.starter.startGoalRound(
    CHAT,
    CONTEXT,
    undefined,
    () => true,
  );
  assert.deepEqual(result, { kind: "started", streamId: "window-stream", messageId: "msg-notice" });
  assert.equal(offered.length, 1);
  assert.equal(offered[0]!.round, undefined);
  assert.equal(h.leases.begun, 0, "it didn't also start without the window");
  assert.deepEqual(h.started, []);

  // A window that was busy hands back the busy outcome, so the notice waits for the chat to be idle.
  const busy = harness({ window: async () => "busy" });
  assert.deepEqual(await busy.starter.startGoalRound(CHAT, CONTEXT, undefined, () => true), {
    kind: "busy",
  });
});

test("the goal is checked when the round's message is saved and again just before the turn starts", async () => {
  // Paused while the message is being saved: the store is told, and nothing is saved or started.
  let current = true;
  const duringSave = harness();
  duringSave.hooks.duringAppend = () => (current = false);
  const refused = await duringSave.starter.startGoalRound(CHAT, CONTEXT, ROUND, () => current);
  assert.equal(refused.kind, "unavailable");
  assert.deepEqual(duringSave.saved, [{ content: ROUND.text, stillCurrent: false }]);
  assert.deepEqual(duringSave.started, []);
  assert.equal(duringSave.leases.released, 1, "the chat's turn is given back");

  // Paused right after the message was saved: the turn doesn't start, and the saved message is named.
  current = true;
  const afterSave = harness();
  afterSave.hooks.afterAppend = () => (current = false);
  const stopped = await afterSave.starter.startGoalRound(CHAT, CONTEXT, ROUND, () => current);
  assert.deepEqual(stopped, {
    kind: "unavailable",
    reason: "The goal changed before the round began.",
    messageId: "msg-1",
  });
  assert.deepEqual(afterSave.started, []);
  assert.equal(afterSave.leases.released, 1);
});

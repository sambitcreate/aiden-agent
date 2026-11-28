// chats:goal:* against a real GoalLoop with fake chats: the loop's state is
// the oracle for what each handler did.

import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalLoop } from "../services/goal/goal-loop.js";
import {
  GOAL_CLEAR_CHANNEL,
  GOAL_GET_CHANNEL,
  GOAL_PAUSE_CHANNEL,
  GOAL_RESUME_CHANNEL,
  GOAL_DECLINE_WINDOW_ROUND_CHANNEL,
  GOAL_DISMISS_PROPOSAL_CHANNEL,
  GOAL_PROPOSAL_CHANNEL,
  GOAL_SET_CHANNEL,
  GOAL_START_WINDOW_ROUND_CHANNEL,
  GOAL_VIEW_CHANNEL,
  registerGoalHandlers,
} from "./goals.js";
import { GoalWindowRounds } from "../services/goal/goal-window-rounds.js";
import { GoalProposals } from "../services/goal/goal-proposals.js";

function setup() {
  const rounds: string[] = [];
  const checks: string[] = [];
  const loop = new GoalLoop({
    enabled: () => true,
    boot: "boot",
    now: () => 1_000,
    newId: () => "goal-1",
    delay: () => Promise.resolve(),
    setTimer: () => () => {},
    persist: () => {},
    onChange: () => {},
    eligibility: async (chatId) =>
      chatId === "bot-chat" ? "A Bot's chat can't have a goal." : undefined,
    isChatBusy: () => false,
    helperRunning: () => false,
    jobsRunning: () => false,
    roundActivity: async () => ({ toolCalls: 1, newTextChars: 0 }),
    fallbackContext: async () => ({ providerId: "anthropic", model: "claude" }),
    review: async () => ({ kind: "cancelled" }),
    startRound: async (chatId) => {
      rounds.push(chatId);
      return "started";
    },
    startNoticeRound: async () => ({ kind: "busy" }),
    waitForIdle: () => new Promise<void>(() => {}),
    runCheck: async (goal) => {
      checks.push(goal.check!.command);
      return {
        kind: "finished",
        passed: true,
        summary: `\`${goal.check!.command}\` passed`,
        details: "",
      };
    },
    report: () => {},
    log: () => {},
  });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const inactive = { inactive: true };
  const proposals = new GoalProposals({
    now: () => 7,
    onChange: () => {},
    refusal: async () => undefined,
  });
  registerGoalHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    loop,
    proposals,
    activeDocument: (event) => {
      if (event === inactive)
        throw new Error("Goal changes require the active application document.");
    },
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!({}, ...args));
  const invokeFrom = (event: unknown, channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...args));
  return { invoke, invokeFrom, inactive, rounds, checks, proposals };
}

test("set, get, pause, resume and clear drive the chat's goal", async () => {
  const { invoke, rounds } = setup();
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
  const set = (await invoke(GOAL_SET_CHANNEL, {
    chatId: "chat-1",
    objective: "Ship it",
    source: "slash",
  })) as { status: string };
  assert.equal(set.status, "active");
  assert.equal(
    ((await invoke(GOAL_GET_CHANNEL, "chat-1")) as { objective: string }).objective,
    "Ship it",
  );

  assert.equal(
    ((await invoke(GOAL_PAUSE_CHANNEL, { chatId: "chat-1" })) as { status: string }).status,
    "paused",
  );
  const resumed = (await invoke(GOAL_RESUME_CHANNEL, { chatId: "chat-1" })) as {
    status: string;
    rounds: number;
  };
  assert.deepEqual([resumed.status, resumed.rounds], ["active", 1]);
  assert.deepEqual(rounds, ["chat-1"], "Keep going starts a round in the idle chat");

  await invoke(GOAL_CLEAR_CHANNEL, { chatId: "chat-1" });
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
});

test("changes are refused from an inactive document, for malformed input, a phone source, or an ineligible chat", async () => {
  const { invoke, invokeFrom, inactive } = setup();
  await assert.rejects(
    invokeFrom(inactive, GOAL_SET_CHANNEL, {
      chatId: "chat-1",
      objective: "Ship it",
      source: "slash",
    }),
    /active application document/,
  );
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "", objective: "Ship it", source: "slash" }),
    /Invalid chat/,
  );
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", objective: 7, source: "slash" }),
    /Say what the goal is/,
  );
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", objective: "Ship it", source: "phone" }),
    /Invalid goal source/,
  );
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "bot-chat", objective: "Ship it", source: "menu" }),
    /Bot's chat/,
  );
  await assert.rejects(invoke(GOAL_PAUSE_CHANNEL, "chat-1"), /Invalid request/);
  assert.equal(await invoke(GOAL_GET_CHANNEL, "chat-1"), null);
});

test("/until sets a goal checked by its command, which runs at once in an idle chat", async () => {
  const { invoke, checks } = setup();
  const set = (await invoke(GOAL_SET_CHANNEL, {
    chatId: "chat-1",
    source: "until",
    check: "  npm test  ",
  })) as {
    objective: string;
    maxRounds: number;
    check?: { command: string };
    source: string;
  };
  assert.deepEqual(
    [set.objective, set.maxRounds, set.check?.command, set.source],
    ["Keep going until npm test passes", 5, "npm test", "until"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(checks, ["npm test"]);
  assert.equal(((await invoke(GOAL_GET_CHANNEL, "chat-1")) as { status: string }).status, "done");
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", source: "until", check: "  " }),
    /Name the check/,
  );
  await assert.rejects(
    invoke(GOAL_SET_CHANNEL, { chatId: "chat-1", source: "until", check: "a\nb" }),
    /one command line/,
  );
});

test("a window reports its chat, takes the round it is offered on its own stream, and a declined round runs without it", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const rounds = new GoalWindowRounds<{ round: number }>({
    newToken: () => `token-${handlers.size}-${Math.random()}`,
    screenLocked: () => false,
    setTimer: () => () => {},
    closedMidRound: () => {},
  });
  const sent = new Map<string, Array<{ chatId: string; token: string }>>();
  const started: Array<{ chatId: string; streamId: string }> = [];
  registerGoalHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    loop: {} as never,
    activeDocument: () => {},
    windowRounds: {
      report: (event, view) => {
        const documentId = (event as { documentId: string }).documentId;
        rounds.report(
          {
            documentId,
            send: (request) => sent.set(documentId, [...(sent.get(documentId) ?? []), request]),
          },
          view,
        );
      },
      start: async (event, token, streamId) => {
        const claim = rounds.claim(token, (event as { documentId: string }).documentId);
        if (!claim) throw new Error("This keep-going round is no longer waiting for this window.");
        started.push({ chatId: claim.chatId, streamId });
        claim.settle({ kind: "started", streamId });
        return { kind: "started", streamId };
      },
      decline: (event, token) =>
        rounds.decline(token, (event as { documentId: string }).documentId),
    },
  });
  const invoke = (documentId: string, channel: string, input: unknown) =>
    Promise.resolve().then(() => handlers.get(channel)!({ documentId }, input));

  await assert.rejects(invoke("doc-a", GOAL_VIEW_CHANNEL, { chatId: "chat-1" }), /Invalid view/u);
  await invoke("doc-a", GOAL_VIEW_CHANNEL, { chatId: "chat-1", focused: true });
  const offered = rounds.offer("chat-1", { round: 2 });
  const [request] = sent.get("doc-a") ?? [];
  assert.equal(request?.chatId, "chat-1");
  await assert.rejects(
    invoke("doc-a", GOAL_START_WINDOW_ROUND_CHANNEL, {
      token: request!.token,
      streamId: "bad stream id!",
    }),
    /Invalid chat stream/u,
  );
  await assert.rejects(
    invoke("doc-b", GOAL_START_WINDOW_ROUND_CHANNEL, { token: request!.token, streamId: "s-1" }),
    /no longer waiting/u,
  );
  assert.deepEqual(
    await invoke("doc-a", GOAL_START_WINDOW_ROUND_CHANNEL, {
      token: request!.token,
      streamId: "s-1",
    }),
    {
      streamId: "s-1",
      accepted: true,
      started: true,
    },
  );
  assert.equal(await offered, "started");
  assert.deepEqual(started, [{ chatId: "chat-1", streamId: "s-1" }]);

  const next = rounds.offer("chat-1", { round: 3 });
  await invoke("doc-a", GOAL_DECLINE_WINDOW_ROUND_CHANNEL, { token: sent.get("doc-a")![1]!.token });
  assert.equal(await next, "no-window");
  await invoke("doc-a", GOAL_VIEW_CHANNEL, { chatId: null, focused: true });
  assert.equal(
    await rounds.offer("chat-1", { round: 4 }),
    "no-window",
    "a window showing no chat is not asked",
  );
});

test("a suggested goal is read and dismissed with Not now, and Start (a goal set from it) answers it", async () => {
  const { invoke, invokeFrom, inactive, proposals } = setup();
  assert.equal(await invoke(GOAL_PROPOSAL_CHANNEL, "chat-1"), null);
  await proposals.propose("chat-1", "Finish the migration");
  assert.deepEqual(await invoke(GOAL_PROPOSAL_CHANNEL, "chat-1"), {
    chatId: "chat-1",
    objective: "Finish the migration",
    proposedAt: 7,
  });
  await assert.rejects(
    invokeFrom(inactive, GOAL_DISMISS_PROPOSAL_CHANNEL, { chatId: "chat-1" }),
    /active application document/u,
  );
  await invoke(GOAL_DISMISS_PROPOSAL_CHANNEL, { chatId: "chat-1" });
  assert.equal(await invoke(GOAL_PROPOSAL_CHANNEL, "chat-1"), null);

  await proposals.propose("chat-1", "Finish the migration");
  const set = (await invoke(GOAL_SET_CHANNEL, {
    chatId: "chat-1",
    objective: "Finish the migration",
    source: "proposal",
  })) as { source: string };
  assert.equal(set.source, "proposal");
  assert.equal(await invoke(GOAL_PROPOSAL_CHANNEL, "chat-1"), null);
});

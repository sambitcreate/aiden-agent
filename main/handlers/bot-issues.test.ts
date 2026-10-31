import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ISSUE_CHANNELS,
  type BotIssue,
  type BotIssueAction,
} from "../../renderer/shared/bot-issues.js";
import type { BotIssueActResult } from "../services/bot-issues/service.js";
import { registerBotIssueHandlers } from "./bot-issues.js";

const ISSUE: BotIssue = {
  id: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
  botId: "bot:ada",
  kind: "routine_failed",
  dedupeKey: "routine:r1:failed",
  title: "Ada couldn’t finish your morning briefing",
  body: "The model was unavailable, so nothing ran.",
  routineId: "r1",
  actions: [{ kind: "resume_routine", routineId: "r1" }, { kind: "stop_run" }],
  createdAt: 1_000,
};

function setup(result: BotIssueActResult = "done") {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const acts: Array<{ botId: string; issueId: string; action: BotIssueAction }> = [];
  const lists: Array<{ botId: string; options: { open?: boolean } | undefined }> = [];
  registerBotIssueHandlers({
    handle: (channel, handler) => void handlers.set(channel, handler),
    issues: {
      act: async (botId, issueId, action) => {
        acts.push({ botId, issueId, action });
        return result;
      },
      list: async (botId, options) => {
        lists.push({ botId, options });
        return [ISSUE];
      },
    },
  });
  /** Exactly what preload does: the handler's arguments reach it as sent. */
  const invoke = (channel: string, input: unknown) =>
    Promise.resolve(handlers.get(channel)!(null, input));
  return { invoke, acts, lists };
}

const act = (overrides: Record<string, unknown> = {}) => ({
  botId: ISSUE.botId,
  issueId: ISSUE.id,
  action: { kind: "resume_routine", routineId: "r1" },
  ...overrides,
});

test("bots:issues:act carries the offered action to the service and reports it settled", async () => {
  const { invoke, acts } = setup();
  assert.deepEqual(await invoke(BOT_ISSUE_CHANNELS.act, act()), { result: "done" });
  assert.deepEqual(acts, [
    {
      botId: ISSUE.botId,
      issueId: ISSUE.id,
      action: { kind: "resume_routine", routineId: "r1" },
    },
  ]);
});

test("bots:issues:act rejects unknown action kinds", async () => {
  const { invoke, acts } = setup();
  const malformed: unknown[] = [
    null,
    "stop_run",
    [],
    act({ action: { kind: "restart_everything" } }),
    act({ action: { kind: "resume_routine" } }),
    act({ action: { kind: "resume_routine", routineId: "" } }),
    act({ action: { kind: "resume_routine", routineId: "../r1" } }),
    act({ action: { kind: "stop_run", reason: "because" } }),
    act({ action: { kind: "open_settings", section: "billing" } }),
    act({ issueId: "" }),
    act({ issueId: "has spaces" }),
    act({ extra: true }),
  ];
  for (const input of malformed) {
    await assert.rejects(invoke(BOT_ISSUE_CHANNELS.act, input), /Invalid bot issue/u, JSON.stringify(input));
  }
  assert.deepEqual(acts, [], "nothing reaches the service");
});

test("bots:issues:act says a settled issue is not open, and refuses an action the issue does not offer", async () => {
  const settled = setup("not_open");
  assert.deepEqual(await settled.invoke(BOT_ISSUE_CHANNELS.act, act()), { result: "not_open" });

  const invalid = setup("invalid");
  await assert.rejects(invalid.invoke(BOT_ISSUE_CHANNELS.act, act()), /doesn’t fit this issue/u);
});

test("bots:issues:list reads one Bot's issues, filtered to open ones when asked", async () => {
  const { invoke, lists } = setup();
  assert.deepEqual(await invoke(BOT_ISSUE_CHANNELS.list, { botId: ISSUE.botId, open: true }), [ISSUE]);
  assert.deepEqual(await invoke(BOT_ISSUE_CHANNELS.list, { botId: ISSUE.botId }), [ISSUE]);
  assert.deepEqual(lists, [
    { botId: ISSUE.botId, options: { open: true } },
    { botId: ISSUE.botId, options: undefined },
  ]);

  for (const input of [null, { botId: ISSUE.botId, open: "yes" }, { botId: ISSUE.botId, extra: true }, { botId: "" }]) {
    await assert.rejects(invoke(BOT_ISSUE_CHANNELS.list, input), /Invalid bot/u, JSON.stringify(input));
  }
});

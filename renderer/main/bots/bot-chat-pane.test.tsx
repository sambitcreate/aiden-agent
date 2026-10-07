import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotChatRoute } from "../bot-chat-route";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";
import type { BotLiveSnapshot, BotTranscriptEntry } from "../../shared/bot-live";

afterEach(cleanup);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function snapshot(overrides: Partial<BotLiveSnapshot> = {}): BotLiveSnapshot {
  return {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 0,
    entries: [],
    partial: null,
    state: { kind: "idle" },
    ...overrides,
  };
}

function userEntry(id: string, text: string): BotTranscriptEntry {
  return { id, type: "user", text, imageCount: 0 };
}

function assistantEntry(id: string, text: string): BotTranscriptEntry {
  return { id, type: "assistant", text, toolCalls: [], stopReason: "stop" };
}

async function mountChat(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    ...handlers,
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  return calls;
}

test("a reply still being written is folded under Working and opens to its text", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({ partial: "Checking your calendar now", state: { kind: "running", submissionId: "s1" } }),
  });
  const working = await screen.findByRole("button", { name: /Working/u });
  fireEvent.click(working);
  assert.ok(await screen.findByText("Checking your calendar now"));
});

test("a sequence gap re-subscribes and shows the fresh snapshot", async () => {
  let subscribes = 0;
  const calls = await mountChat({
    "bots:live:subscribe": () => {
      subscribes += 1;
      return subscribes === 1
        ? snapshot({ entries: [userEntry("u1", "Plan Lisbon")] })
        : snapshot({
            seq: 3,
            entries: [userEntry("u1", "Plan Lisbon"), assistantEntry("a1", "Here is a plan for Lisbon.")],
          });
    },
  });
  assert.ok(await screen.findByText("Plan Lisbon"));
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 3,
    type: "entry",
    entry: assistantEntry("a1", "Here is a plan for Lisbon."),
  });
  assert.ok(await screen.findByText("Here is a plan for Lisbon."));
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 2);
});

test("a new epoch from a reopened Bot replaces the view with a fresh snapshot", async () => {
  let subscribes = 0;
  await mountChat({
    "bots:live:subscribe": () => {
      subscribes += 1;
      return subscribes === 1
        ? snapshot({ entries: [assistantEntry("a1", "Old session message")] })
        : snapshot({ epoch: "epoch-2", seq: 7, entries: [assistantEntry("a9", "Back after reopening")] });
    },
  });
  assert.ok(await screen.findByText("Old session message"));
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-2",
    seq: 1,
    type: "partial",
    text: null,
  });
  assert.ok(await screen.findByText("Back after reopening"));
  assert.equal(screen.queryByText("Old session message"), null);
});

test("an interrupted Bot offers Resume and Dismiss, each sent once with a request id", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1" } }),
    "bots:resume": () => ({ kind: "running", submissionId: "s1" }),
    "bots:dismiss": () => ({ kind: "idle" }),
  });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  assert.ok(within(card).getByText("I got interrupted while working on this."));
  fireEvent.click(within(card).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
  const resume = calls.find((call) => call.channel === "bots:resume")!;
  const resumeInput = resume.args[0] as { botId: string; requestId: string };
  assert.equal(resumeInput.botId, "bot-1");
  assert.match(resumeInput.requestId, UUID);
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:dismiss").length, 1));
  const dismissInput = calls.find((call) => call.channel === "bots:dismiss")!.args[0] as { botId: string; requestId: string };
  assert.equal(dismissInput.botId, "bot-1");
  assert.match(dismissInput.requestId, UUID);
});

test("an interrupted Bot whose access changed points to Advanced instead of resuming", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ state: { kind: "interrupted", submissionId: "s1", blocked: "access_changed" } }),
  });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  assert.ok(within(card).getByText("This Bot's access changed. Review it in Advanced."));
  assert.equal(within(card).queryByRole("button", { name: "Resume" }), null);
  assert.ok(within(card).getByRole("button", { name: "Open Advanced" }));
});

test("a pending connect card offers Connect and Not now, and Not now is saved for the Bot", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          {
            id: "c1",
            type: "connect_card",
            card: { type: "connect_card", pluginId: "gmail", reason: "To read your replies", status: "pending" },
          },
        ],
      }),
    "bots:connections:dismiss": () => undefined,
  });
  const card = await screen.findByRole("group", { name: "Connect Gmail" });
  assert.ok(within(card).getByText("To read your replies"));
  assert.ok(within(card).getByRole("button", { name: "Connect Gmail" }));
  fireEvent.click(within(card).getByRole("button", { name: "Not now for Gmail" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:connections:dismiss")?.args, ["bot-1", "gmail"]),
  );
});

test("a connected card reads Connected and offers no actions", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          {
            id: "c1",
            type: "connect_card",
            card: { type: "connect_card", pluginId: "gmail", reason: "To read your replies", status: "connected" },
          },
        ],
      }),
  });
  const card = await screen.findByRole("group", { name: "Gmail" });
  assert.ok(within(card).getByText("Connected"));
  assert.equal(within(card).queryByRole("button", { name: "Not now for Gmail" }), null);
});

test("sends carry a fresh request id per message and go to the Bot's one conversation", async () => {
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot(), "bots:send": () => ({ submissionId: "s", deduped: false }) });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "First question" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
  fireEvent.change(box, { target: { value: "Second question" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 2));
  const [first, second] = calls.filter((call) => call.channel === "bots:send").map((call) => call.args[0] as {
    botId: string;
    text: string;
    requestId: string;
  });
  assert.equal(first!.botId, "bot-1");
  assert.equal(first!.text, "First question");
  assert.match(first!.requestId, UUID);
  assert.notEqual(first!.requestId, second!.requestId);
});

test("Stop ends the running reply through the runtime", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "running", submissionId: "s1" } }),
    "bots:stop": () => ({ kind: "idle" }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Stop generating" }));
  await waitFor(() => assert.deepEqual(calls.find((call) => call.channel === "bots:stop")?.args, ["bot-1"]));
});

test("a Bot without an AI model asks for one and sends nothing", async () => {
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot({ state: { kind: "needs_model" } }) });
  const status = await screen.findByRole("status");
  assert.ok(within(status).getByText("Needs an AI model"));
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);
});

test("a connect card answered with Not now reads Not connected and stays put", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          {
            id: "c1",
            type: "connect_card",
            card: { type: "connect_card", pluginId: "gmail", reason: "To read your replies", status: "dismissed" },
          },
        ],
      }),
  });
  const card = await screen.findByRole("group", { name: "Gmail" });
  assert.ok(within(card).getByText("Not connected"));
  assert.equal(within(card).queryByRole("button", { name: "Connect Gmail" }), null);
});

test("text before a tool call folds under Updates, and only the final answer is a bubble", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Am I free Friday?"),
          { id: "a1", type: "assistant", text: "Let me check your calendar.", toolCalls: [{ id: "t1", name: "calendar" }], stopReason: "toolUse" },
          { id: "r1", type: "tool_result", toolCallId: "t1", toolName: "calendar", isError: false },
          assistantEntry("a2", "You are free all day Friday."),
        ],
      }),
  });
  assert.ok(await screen.findByText("You are free all day Friday."));
  assert.equal(screen.queryByText("Let me check your calendar."), null);
  fireEvent.click(screen.getByRole("button", { name: "Updates" }));
  assert.ok(await screen.findByText("Let me check your calendar."));
});

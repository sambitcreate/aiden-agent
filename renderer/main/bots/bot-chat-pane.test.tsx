import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotChatRoute } from "../bot-chat-route";
import { mountWithBotRouter } from "./test-providers";
import { toast } from "../../components/ui";
import { botFixture } from "./test-fixtures";
import type { BotLiveSnapshot, BotTranscriptEntry } from "../../shared/bot-live";
import { BOT_SIDEBAR_PREFERENCES_KEY, parseBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function snapshot(overrides: Partial<BotLiveSnapshot> = {}): BotLiveSnapshot {
  return {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 0,
    entries: [],
    partial: null,
    state: { kind: "idle" },
    question: null,
    activity: null,
    queued: [],
    ...overrides,
  };
}

const COLOUR_QUESTION = {
  question: "Which colour should the banner use?",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Blue", description: "Calm and cool." },
    { label: "Red", description: "Loud and warm." },
  ],
};

/** The chat's status live region, which stays mounted while the line comes and goes. */
function statusRegion(): Element | undefined {
  return screen.queryAllByRole("status").find((node) => node.hasAttribute("data-bot-status-announcement"));
}

/** What a screen reader is told by the status line ("" while no line shows), or null without a region. */
function announced(): string | null {
  return statusRegion()?.textContent ?? null;
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

test("a reply still being written shows as its own bubble", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ partial: "Checking your calendar now", state: { kind: "running", submissionId: "s1" } }),
  });
  assert.ok(await screen.findByText("Checking your calendar now"));
  assert.equal(screen.queryByRole("button", { name: /Working|Updates/u }), null);
});

test("a Bot's A–E question shows its card, and submitting a chosen option answers it by wait id", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        question: { botId: "bot-1", waitId: "wait-1", toolCallId: "tool-1", questions: [COLOUR_QUESTION] },
      }),
    "bots:answerQuestion": () => ({ answered: true }),
  });
  assert.ok(await screen.findByRole("heading", { name: "Which colour should the banner use?" }));
  assert.equal(screen.queryByPlaceholderText("Ask Planner"), null, "the card takes the composer's place");
  fireEvent.click(screen.getByRole("button", { name: /Blue/u }));
  assert.equal(
    calls.filter((call) => call.channel === "bots:answerQuestion").length,
    0,
    "choosing an option selects it without answering yet",
  );
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:answerQuestion").length, 1));
  const input = calls.find((call) => call.channel === "bots:answerQuestion")!.args[0] as {
    botId: string;
    waitId: string;
    answer: unknown;
  };
  assert.equal(input.botId, "bot-1");
  assert.equal(input.waitId, "wait-1");
  assert.deepEqual(input.answer, {
    version: 1,
    promptId: "wait-1",
    cancelled: false,
    answers: [{ questionIndex: 0, kind: "option", answer: "Blue" }],
  });
});

test("a question leaves the chat when the live view reports it settled, and its answer stays in the transcript", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        question: { botId: "bot-1", waitId: "wait-1", toolCallId: "tool-1", questions: [COLOUR_QUESTION] },
      }),
  });
  assert.ok(await screen.findByRole("heading", { name: "Which colour should the banner use?" }));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "question",
    question: null,
  }));
  // Read textContent: a Testing Library query here stalls the test DOM once the composer remounts.
  await waitFor(() => assert.equal(document.body.textContent?.includes("Which colour should the banner use?"), false));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 2,
    type: "entry",
    entry: { id: "qa1", type: "question_answer", text: "Blue" },
  }));
  assert.ok(await screen.findByText("Blue"));
  assert.ok(screen.getByPlaceholderText("Ask Planner"), "the composer is back");
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
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 3,
    type: "entry",
    entry: assistantEntry("a1", "Here is a plan for Lisbon."),
  }));
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
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-2",
    seq: 1,
    type: "partial",
    text: null,
  }));
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

test("the Bot's own progress message is a bubble at every level, and Quiet shows no tool rows", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Am I free Friday?"),
          {
            id: "a1",
            type: "assistant",
            text: "Let me check your calendar.",
            toolCalls: [{ id: "t1", name: "calendar", kind: "working", label: "Used a tool" }],
            stopReason: "toolUse",
          },
          { id: "r1", type: "tool_result", toolCallId: "t1", toolName: "calendar", isError: false, status: "ok" },
          assistantEntry("a2", "You are free all day Friday."),
        ],
      }),
  });
  assert.ok(await screen.findByText("Let me check your calendar."));
  assert.ok(screen.getByText("You are free all day Friday."));
  assert.equal(screen.queryByText(/Used a tool/u), null);
});

test("a tool call that needs approval asks in the chat and answers by wait id", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => ({ decided: true }),
  });
  act(() => emitBotTestNotification("bots:approval", {
    botId: "bot-1",
    waitId: "wait-7",
    toolCallId: "call-7",
    toolName: "send_email",
    summary: "Send the weekly update to the team.",
  }));
  const card = await screen.findByRole("group", { name: "Planner needs approval" });
  assert.ok(within(card).getByText("Send the weekly update to the team."));
  fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:approve")));
  assert.deepEqual(calls.find((call) => call.channel === "bots:approve")?.args, [
    { waitId: "wait-7", decision: "allow" },
  ]);
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner needs approval" }), null));
});

test("Resume clicked twice, or Resume then Dismiss, sends one request until the first answers", async () => {
  let answer: (state: unknown) => void = () => undefined;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1" } }),
    "bots:resume": () => new Promise((resolve) => (answer = resolve)),
    "bots:dismiss": () => ({ kind: "idle" }),
  });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  const resume = within(card).getByRole("button", { name: "Resume" });
  const dismiss = within(card).getByRole("button", { name: "Dismiss" });
  fireEvent.click(resume);
  fireEvent.click(resume);
  fireEvent.click(dismiss);
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
  assert.equal(calls.filter((call) => call.channel === "bots:dismiss").length, 0);
  answer({ kind: "running", submissionId: "s1" });
  // Once answered, the card works again (the live state decides whether it stays).
  await waitFor(() => assert.equal(within(card).getByRole("button", { name: "Dismiss" }).hasAttribute("disabled"), false));
  fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:dismiss").length, 1));
});

test("an approval whose answer fails to send comes back so it can be answered again", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => Promise.reject(new Error("The approval could not be sent.")),
  });
  act(() => emitBotTestNotification("bots:approval", {
    botId: "bot-1",
    waitId: "wait-8",
    toolCallId: "call-8",
    toolName: "share_image",
    summary: "Share the chart.",
  }));
  const card = await screen.findByRole("group", { name: "Planner needs approval" });
  assert.ok(within(card).getByText("Planner wants to use Share image."));
  fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
  const back = await screen.findByRole("group", { name: "Planner needs approval" });
  assert.ok(within(back).getByRole("button", { name: "Allow" }));
});

test("a Bot open in another Aiden window says so in plain words", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "unavailable", reason: "held_by_live_process" } }),
  });
  // The reason is said once, in the composer's status line; the field itself only says it can't send.
  const reason = await screen.findByText("Bots are open in another Aiden window.");
  assert.ok(reason.closest('[role="status"]'));
  assert.equal(screen.getAllByText("Bots are open in another Aiden window.").length, 1);
  assert.ok(screen.getByPlaceholderText("Can’t send yet"));
  assert.equal(screen.queryByText(/held_by_live_process/u), null);
  assert.equal(screen.queryByPlaceholderText(/held_by_live_process/u), null);
});

test("a just-sent message shows the status line before any reply text arrives", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan Lisbon")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "preparing", startedAt: Date.now() },
      }),
  });
  assert.ok(await screen.findByText("Plan Lisbon"));
  await waitFor(() => assert.equal(announced(), "Getting ready"));
});

test("the status line follows live activity, and hides while the reply's words stream", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "What's on my list?")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "groceries.md" } },
      }),
  });
  await waitFor(() => assert.equal(announced(), "Reading, groceries.md"));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "activity",
    activity: { phase: "writing", startedAt: Date.now() },
  }));
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 2, type: "partial", text: "Eggs and milk." }));
  await waitFor(() => assert.equal(screen.queryByText("Reading") === null, true));
  assert.equal(screen.queryByText("Writing") === null, true, "the words themselves are the signal");
});

test("one status region stays mounted from an idle chat through streaming, so each new line is announced", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({ entries: [assistantEntry("a1", "Hi there.")] }),
  });
  assert.ok(await screen.findByText("Hi there."));
  const region = statusRegion();
  assert.ok(region, "the region is there before the Bot does anything");
  assert.equal(announced(), "");

  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "state",
    state: { kind: "running", submissionId: "s1" },
  }));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 2,
    type: "activity",
    activity: { phase: "writing", startedAt: Date.now() },
  }));
  await waitFor(() => assert.equal(announced(), "Writing"));
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 3, type: "partial", text: "Let me check." }));
  await waitFor(() => assert.equal(announced(), "", "words are streaming, so the region is quiet"));

  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 4,
    type: "activity",
    activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "notes.md" } },
  }));
  await waitFor(() => assert.equal(announced(), "Reading, notes.md"), { timeout: 3_000 });
  assert.equal(statusRegion() === region, true, "the same region announced both stretches");
});

test("a Bot set to Always Thinking says Thinking while it reads", async () => {
  await mountChat({
    "bots:get": () => botFixture({ chatActivity: { level: "quiet", wording: "thinking" } }),
    "bots:live:subscribe": () =>
      snapshot({
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "groceries.md" } },
      }),
  });
  await waitFor(() => assert.equal(announced(), "Thinking"));
});

test("the status line stays through a tool that follows narration, even while that narration is still the partial", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Tidy my notes")],
        partial: "On it.",
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "reading", startedAt: Date.now(), step: { kind: "reading", label: "Reading", detail: "notes.md" } },
      }),
  });
  await waitFor(() => assert.equal(announced(), "Reading, notes.md"));
});

test("a deleted Bot's chat says it was not found instead of loading forever", async () => {
  installBotTestIpc({
    "bots:get": () => null,
    "bots:live:subscribe": () => Promise.reject(new Error("This Bot no longer exists.")),
    "bots:pendingApprovals": () => [],
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  assert.ok(await screen.findByText("Bot not found"));
});

test("a chat that fails to open says so, and Try again opens it", async () => {
  let attempts = 0;
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("Bots are starting."))
        : snapshot({ entries: [assistantEntry("a1", "Welcome back.")] });
    },
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const alert = await screen.findByRole("alert");
  assert.ok(within(alert).getByText("This chat didn’t open"));
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  assert.ok(await screen.findByText("Welcome back."));
});

test("a renderer reload mid-reply shows the partial reply from the fresh snapshot", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        seq: 4,
        entries: [userEntry("u1", "Tell me a story")],
        partial: "Once upon a time",
        state: { kind: "running", submissionId: "s1" },
      }),
  });
  cleanup();
  // The reloaded document mounts the chat again and subscribes once more.
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 5,
    type: "partial",
    text: "Once upon a time there was a fox.",
  }));
  assert.ok(await screen.findByText("Once upon a time there was a fox."));
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 2);
  assert.equal(calls.filter((call) => call.channel === "bots:live:unsubscribe").length, 1);
});

function toolStep(id: string, text: string): BotTranscriptEntry {
  return { id, type: "assistant", text, toolCalls: [{ id: `${id}-call`, name: "web_search", kind: "searching", label: "Searched the web" }], stopReason: "toolUse" };
}

test("each round's narration is its own bubble before the answer", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Find flights"),
          toolStep("a1", "Searching airlines."),
          toolStep("a2", "Comparing prices."),
          assistantEntry("a3", "TAP on Friday is cheapest."),
        ],
      }),
  });
  assert.ok(await screen.findByText("Searching airlines."));
  assert.ok(screen.getByText("Comparing prices."));
  assert.ok(screen.getByText("TAP on Friday is cheapest."));
});

test("a Summary Bot shows one recap above its answer that opens to the steps", async () => {
  await mountChat({
    "bots:get": () => botFixture({ chatActivity: { level: "summary", wording: "follows" } }),
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          { ...userEntry("u1", "Find flights"), at: 1_000 } as BotTranscriptEntry,
          toolStep("a1", ""),
          { id: "r1", type: "tool_result", toolCallId: "a1-call", toolName: "web_search", isError: false, status: "ok", at: 5_000 },
          { ...assistantEntry("a2", "TAP on Friday is cheapest."), at: 19_000 } as BotTranscriptEntry,
        ],
      }),
  });
  const recap = await screen.findByRole("button", { name: "Worked for 18s · searched the web" });
  fireEvent.click(recap);
  assert.ok(await screen.findByText("Searched the web"));
});

test("a reply the person stopped says so in a quiet centred line", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Tell me a story"),
          { id: "a1", type: "assistant", text: "Once upon", toolCalls: [], stopReason: "aborted" },
        ],
      }),
  });
  assert.ok(await screen.findByText("You stopped this reply."));
});

test("Reply quotes a message at the start of the composer", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({ entries: [userEntry("u1", "Plan Lisbon"), assistantEntry("a1", "Day one: Alfama.")] }),
  });
  await screen.findByText("Day one: Alfama.");
  fireEvent.keyDown(screen.getByRole("button", { name: "Message actions for Planner’s message" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
  const composer = screen.getByPlaceholderText("Ask Planner") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(composer.value, "> Day one: Alfama.\n\n"));
});

test("Copy puts a message on the clipboard", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  await mountChat({ "bots:live:subscribe": () => snapshot({ entries: [userEntry("u1", "Plan Lisbon")] }) });
  await screen.findByText("Plan Lisbon");
  fireEvent.keyDown(screen.getByRole("button", { name: "Message actions for You’s message" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
  await waitFor(() => assert.deepEqual(copied, ["Plan Lisbon"]));
});

test("a failed reply says so, and Retry resends the message as a new submission", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ entries: [userEntry("u1", "Plan dinner"), { id: "a1:failed", type: "failed_turn", retryText: "Plan dinner" }] }),
    "bots:send": () => ({ submissionId: "s2", deduped: false }),
  });
  const card = await screen.findByRole("group", { name: "Planner couldn’t finish a reply" });
  assert.ok(within(card).getByText("I couldn't finish that reply."));
  fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
  const input = calls.find((call) => call.channel === "bots:send")!.args[0] as { botId: string; text: string; requestId: string };
  assert.equal(input.botId, "bot-1");
  assert.equal(input.text, "Plan dinner");
  assert.match(input.requestId, UUID);
});

test("an older failed reply offers no Retry once the chat moved on", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Plan dinner"),
          { id: "a1:failed", type: "failed_turn", retryText: "Plan dinner" },
          userEntry("u2", "Never mind"),
          assistantEntry("a2", "Okay."),
        ],
      }),
  });
  const card = await screen.findByRole("group", { name: "Planner couldn’t finish a reply" });
  assert.equal(within(card).queryByRole("button", { name: "Retry" }), null);
});

test("Stop stays available while a question card replaces the composer", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        state: { kind: "running", submissionId: "s1" },
        question: { botId: "bot-1", waitId: "wait-1", toolCallId: "tool-1", questions: [COLOUR_QUESTION] },
      }),
    "bots:stop": () => ({ kind: "idle" }),
  });
  assert.ok(await screen.findByRole("heading", { name: "Which colour should the banner use?" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:stop").map((call) => call.args), [["bot-1"]]));
});

test("a model the Bot can't reach says why, and Choose a model opens Advanced for that Bot", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ state: { kind: "model_error", message: "Sign in to Text Service again." } }),
  });
  const { router } = await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const card = await screen.findByRole("alert", { name: "Planner can’t reach its AI model" });
  assert.ok(within(card).getByText("Sign in to Text Service again."));
  fireEvent.click(within(card).getByRole("button", { name: "Choose a model" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
  assert.equal((router.state.location.search as { page?: string }).page, "advanced");
});

test("an interrupted Bot whose access changed opens Advanced, not just the Profile", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1", blocked: "access_changed" } }),
  });
  const { router } = await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  fireEvent.click(within(card).getByRole("button", { name: "Open Advanced" }));
  await waitFor(() => assert.equal((router.state.location.search as { page?: string }).page, "advanced"));
});

/** Gives the chat's scrollport a real height so follow-the-reply can be observed. */
function measurableScrollport(scrollHeight: number, clientHeight: number) {
  const viewport = document.querySelector<HTMLElement>("[data-scroll-top]");
  assert.ok(viewport, "the chat scrolls in its own scrollport");
  // The chat opens pinned to its latest message.
  let top = scrollHeight - clientHeight;
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => top,
    // Like a real scrollport, the offset clamps to the scrollable range.
    set: (value: number) => {
      top = Math.max(0, Math.min(value, scrollHeight - clientHeight));
    },
  });
  viewport.scrollTo = ((options: ScrollToOptions) => {
    top = Math.min(options.top ?? top, scrollHeight - clientHeight);
  }) as typeof viewport.scrollTo;
  return {
    viewport,
    scrollTop: () => top,
    // A person reading back scrolls with a gesture (here a wheel turn) and the
    // scrollport then moves; follow-the-bottom yields only to that intent.
    scrollUserTo: (value: number) => {
      fireEvent.wheel(viewport, { deltaY: value < top ? -120 : 120 });
      top = value;
      fireEvent.scroll(viewport);
    },
  };
}

test("a streaming reply doesn't pull the chat down while the person reads earlier messages", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ entries: [userEntry("u1", "Tell me a story")], state: { kind: "running", submissionId: "s1" } }),
  });
  await screen.findByText("Tell me a story");
  const port = measurableScrollport(2_000, 400);
  port.scrollUserTo(300);

  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "partial", text: "Once upon" }));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 2,
    type: "partial",
    text: "Once upon a time there was a fox.",
  }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(port.scrollTop(), 300, "the reader keeps their place");

  // The way back down is one click away.
  fireEvent.click(await screen.findByRole("button", { name: "Scroll to bottom" }));
  assert.equal(port.scrollTop(), 1_600);
});

const CHECK_IN_PROPOSAL = {
  proposalId: "proposal-1",
  name: "Daily check-in",
  prompt: "Check in briefly with one or two things worth knowing today.",
  schedule: { kind: "daily" as const, time: "09:00" },
  timezone: "UTC",
  label: "Every day at 9:00 AM",
};

function proposalEntry(status: "pending" | "accepted" | "dismissed", routineId?: string): BotTranscriptEntry {
  return { id: "p1", type: "routine_proposal", proposal: CHECK_IN_PROPOSAL, status, ...(routineId ? { routineId } : {}) };
}

test("Memory updated is a quiet caption, outside Updates, that opens the panel's Memory tab", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "I'm vegetarian"),
          { id: "m1", type: "memory_update", targets: ["user"], source: "turn" },
          { id: "m2", type: "memory_update", targets: ["memory"], source: "review" },
          assistantEntry("a1", "Noted."),
        ],
      }),
  });
  const { router } = await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  await screen.findByText("Noted.");
  const captions = screen.getAllByRole("button", { name: "Memory updated. Open Memory" });
  assert.equal(captions.length, 1, "back-to-back saves read as one line");
  fireEvent.click(captions[0]!);
  const panel = screen.getByRole("complementary", { name: "Bot panel" });
  assert.equal(within(panel).getByRole("tab", { name: "Memory" }).getAttribute("aria-selected"), "true");
  assert.equal(router.state.location.pathname, "/bots/bot-1/chat", "the chat stays open beside it");
});

test("a routine proposal shows its name, schedule and prompt, and Add routine accepts it once", async () => {
  let respond: (value: unknown) => void = () => undefined;
  const calls = await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () =>
      snapshot({ entries: [assistantEntry("a1", "Want me to check in daily?"), proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => new Promise((resolve) => (respond = resolve)),
  });
  const card = await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" });
  assert.ok(within(card).getByText("Add a routine?"));
  assert.ok(within(card).getByText("Daily check-in · Every day at 9:00 AM"));
  assert.ok(within(card).getByText(CHECK_IN_PROPOSAL.prompt));

  fireEvent.click(within(card).getByRole("button", { name: "Add routine" }));
  fireEvent.click(within(card).getByRole("button", { name: /Add/u }));
  const responds = () => calls.filter((call) => call.channel === "bots:routineProposals:respond");
  await waitFor(() => assert.equal(responds().length, 1));
  assert.deepEqual(responds()[0]!.args[0], { botId: "bot-1", proposalId: "proposal-1", decision: "accept" });
  respond({ status: "accepted", routineId: "task-9" });
  assert.ok(await within(card).findByText("Added ✓ · Every day at 9:00 AM"));
  assert.equal(within(card).queryByRole("button") === null, true, "a settled card has no actions");
  assert.equal(responds().length, 1, "a second click while it was answering sent nothing");
});

test("Not now dismisses a routine proposal, and the card reads Not added", async () => {
  const calls = await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ entries: [proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => ({ status: "dismissed" }),
  });
  const card = await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" });
  fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
  assert.ok(await within(card).findByText("Not added"));
  const respond = calls.find((call) => call.channel === "bots:routineProposals:respond")!;
  assert.deepEqual(respond.args[0], { botId: "bot-1", proposalId: "proposal-1", decision: "dismiss" });
});

test("a failed answer keeps the proposal answerable, and one answered elsewhere arrives settled", async () => {
  await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ entries: [proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => {
      throw new Error("The Mac is busy.");
    },
  });
  const card = await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" });
  fireEvent.click(within(card).getByRole("button", { name: "Add routine" }));
  await waitFor(() =>
    assert.equal((within(card).getByRole("button", { name: "Add routine" }) as HTMLButtonElement).disabled, false),
  );
  assert.ok(within(card).getByText("Add a routine?"));

  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "entry",
    entry: proposalEntry("accepted", "task-9"),
  }));
  assert.ok(await screen.findByText("Added ✓ · Every day at 9:00 AM"));
});

test("a queued message shows faded as Queued, and Remove withdraws that one submission", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan dinners")],
        state: { kind: "running", submissionId: "s1" },
        queued: [{ submissionId: "8", mode: "followUp", text: "Also add dessert", imageCount: 0 }],
      }),
    "bots:withdraw": () => "withdrawn",
  });
  assert.ok(await screen.findByText("Also add dessert"));
  assert.ok(screen.getByText("Queued"));
  fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Also add dessert" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:withdraw")?.args, [{ botId: "bot-1", submissionId: "8" }]),
  );
});

const QUEUED_BASE = {
  entries: [userEntry("u1", "Plan dinners")],
  state: { kind: "running", submissionId: "s1" } as const,
};

test("Remove on a message that already started says it stays", async () => {
  // The test DOM does not mount sonner's viewport, so observe the toast the person would be shown.
  const shown: string[] = [];
  const original = toast.info;
  toast.info = ((message: unknown) => {
    shown.push(String(message));
    return "toast";
  }) as typeof toast.info;
  try {
    const calls = await mountChat({
      "bots:live:subscribe": () =>
        snapshot({ ...QUEUED_BASE, queued: [{ submissionId: "8", mode: "followUp", text: "Also add dessert", imageCount: 0 }] }),
      "bots:withdraw": () => "started",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove queued message: Also add dessert" }));
    await waitFor(() => assert.deepEqual(shown, ["That message already started, so it stays."]));
    assert.equal(calls.filter((call) => call.channel === "bots:withdraw").length, 1);
  } finally {
    toast.info = original;
  }
});

test("a queued message leaves the page when the queue event empties it", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ ...QUEUED_BASE, queued: [{ submissionId: "8", mode: "followUp", text: "Also add dessert", imageCount: 0 }] }),
  });
  assert.ok(await screen.findByText("Also add dessert"));
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "queued", queued: [] }));
  await waitFor(() => assert.equal(document.body.textContent?.includes("Also add dessert"), false));
  assert.equal(screen.queryByText("Queued"), null);
});

test("each queued message has its own Remove, and removing one moves focus on: the next Remove, else the composer", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        ...QUEUED_BASE,
        queued: [
          { submissionId: "8", mode: "followUp", text: "Also add dessert", imageCount: 0 },
          { submissionId: "9", mode: "followUp", text: "And a drinks list", imageCount: 0 },
        ],
      }),
    "bots:withdraw": () => "withdrawn",
  });
  const first = await screen.findByRole("button", { name: "Remove queued message: Also add dessert" });
  const second = screen.getByRole("button", { name: "Remove queued message: And a drinks list" });
  first.focus();
  fireEvent.click(first);
  await waitFor(() => assert.equal(document.activeElement, second));
  fireEvent.click(second);
  await waitFor(() => assert.equal((document.activeElement as HTMLElement | null)?.getAttribute("placeholder"), "Ask Planner"));
});

test("the chat header's face works only while the Bot works, and a photo gets a small activity badge", async () => {
  await mountChat({
    "bots:getCanonicalPhoto": () => ({ assetRevision: "a1", dataUrl: "data:image/png;base64,AAAA" }),
    "bots:live:subscribe": () =>
      snapshot({ state: { kind: "running", submissionId: "s1" }, activity: { phase: "thinking", startedAt: Date.now() } }),
  });
  const pill = await screen.findByRole("button", { name: "Planner profile" });
  const face = within(pill).getByTitle("Planner");
  await waitFor(() => {
    assert.equal(face.hasAttribute("data-working"), true);
    assert.ok(face.querySelector('[data-aiden-mark="glance"]'));
  });
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "state",
    state: { kind: "idle" },
  }));
  await waitFor(() => assert.equal(face.hasAttribute("data-working"), false));
  assert.equal(face.querySelector('[data-aiden-mark="glance"]'), null);
});

test("an open chat keeps its Bot read: a reply that finishes while it is open is seen, and leaving records the visit", async () => {
  const stored = () => parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), Date.now());
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot({ entries: [userEntry("u1", "Plan Lisbon")] }),
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
  });
  const { router } = await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat" });
  await screen.findByText("Plan Lisbon");
  await waitFor(() => assert.ok((stored().lastViewed["bot-1"] ?? 0) > 0, "opening the chat records the visit"));
  assert.equal(stored().seenReplyAt["bot-1"], undefined, "no reply to have seen yet");
  const opened = stored().lastViewed["bot-1"] ?? 0;

  // Main times a reply from when it began streaming.
  const replyAt = Date.now() - 2_000;
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "entry",
    entry: { ...assistantEntry("a1", "Here is a plan for Lisbon."), at: replyAt },
  }));
  await screen.findByText("Here is a plan for Lisbon.");
  await waitFor(() => assert.equal(stored().seenReplyAt["bot-1"], replyAt, "the reply that finished while open is seen"));

  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  await act(() => router.navigate({ to: "/scheduled" }));
  await waitFor(() => assert.equal(screen.queryByText("Plan Lisbon") === null, true, "the chat is gone"));
  assert.ok((stored().lastViewed["bot-1"] ?? 0) > opened, "leaving records when it was last open");
  assert.equal(stored().seenReplyAt["bot-1"], replyAt, "leaving never claims a reply the chat didn't show");
});

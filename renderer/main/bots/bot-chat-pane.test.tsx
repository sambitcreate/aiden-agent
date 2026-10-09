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
    question: null,
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
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "question",
    question: null,
  });
  // Read textContent: a Testing Library query here stalls the test DOM once the composer remounts.
  await waitFor(() => assert.equal(document.body.textContent?.includes("Which colour should the banner use?"), false));
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 2,
    type: "entry",
    entry: { id: "qa1", type: "question_answer", text: "Blue" },
  });
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

test("a tool call that needs approval asks in the chat and answers by wait id", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => ({ decided: true }),
  });
  emitBotTestNotification("bots:approval", {
    botId: "bot-1",
    waitId: "wait-7",
    toolCallId: "call-7",
    toolName: "send_email",
    summary: "Send the weekly update to the team.",
  });
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
  emitBotTestNotification("bots:approval", {
    botId: "bot-1",
    waitId: "wait-8",
    toolCallId: "call-8",
    toolName: "share_image",
    summary: "Share the chart.",
  });
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
  assert.ok(await screen.findByPlaceholderText("Bots are open in another Aiden window."));
  assert.equal(screen.queryByText(/held_by_live_process/u), null);
  assert.equal(screen.queryByPlaceholderText(/held_by_live_process/u), null);
});

test("a just-sent message shows the Bot working before any reply text arrives", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ entries: [userEntry("u1", "Plan Lisbon")], state: { kind: "running", submissionId: "s1" } }),
  });
  assert.ok(await screen.findByText("Plan Lisbon"));
  assert.ok(await screen.findByRole("button", { name: /Working/u }));
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
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 5,
    type: "partial",
    text: "Once upon a time there was a fox.",
  });
  fireEvent.click(await screen.findByRole("button", { name: /Working/u }));
  assert.ok(await screen.findByText("Once upon a time there was a fox."));
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 2);
  assert.equal(calls.filter((call) => call.channel === "bots:live:unsubscribe").length, 1);
});

const FILE_HANDLERS = {
  "bots:files:list": () => ({
    entries: [
      { path: "lists", name: "lists", parentPath: "", depth: 0, kind: "directory" },
      { path: "lists/groceries.md", name: "groceries.md", parentPath: "lists", depth: 1, kind: "file" },
    ],
    truncated: false,
    skippedDirectories: 0,
  }),
  "bots:files:read": (_botId: unknown, path: unknown) => ({
    path,
    content: "eggs\nmilk",
    size: 9,
    modifiedAt: 1,
    version: "v1",
  }),
};

function toolStep(id: string, text: string): BotTranscriptEntry {
  return { id, type: "assistant", text, toolCalls: [{ id: `${id}-call`, name: "web_search" }], stopReason: "toolUse" };
}

test("Files in the ••• menu lists the Bot's folder and opens a file", async () => {
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot(), ...FILE_HANDLERS });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  fireEvent.click(await screen.findByRole("button", { name: "groceries.md" }));
  const contents = await screen.findByLabelText("Contents of lists/groceries.md");
  assert.equal(contents.textContent, "eggs\nmilk");
  assert.deepEqual(calls.find((call) => call.channel === "bots:files:read")?.args, ["bot-1", "lists/groceries.md"]);
});

test("a file the Bot wrote shows as a chip that opens that file", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          userEntry("u1", "Write my grocery list"),
          { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
          assistantEntry("a1", "Done."),
        ],
      }),
    ...FILE_HANDLERS,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open groceries.md" }));
  assert.equal((await screen.findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
});

test("all tool rounds before an answer fold into one Updates line", async () => {
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
  assert.ok(await screen.findByText("TAP on Friday is cheapest."));
  assert.equal(screen.getAllByRole("button", { name: "Updates" }).length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Updates" }));
  assert.ok(await screen.findByText(/Searching airlines\.\s+Comparing prices\./u));
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
  let top = 0;
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  viewport.scrollTo = ((options: ScrollToOptions) => {
    top = Math.min(options.top ?? top, scrollHeight - clientHeight);
  }) as typeof viewport.scrollTo;
  return {
    viewport,
    scrollTop: () => top,
    scrollUserTo: (value: number) => {
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

  emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "partial", text: "Once upon" });
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 2,
    type: "partial",
    text: "Once upon a time there was a fox.",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(port.scrollTop(), 300, "the reader keeps their place");

  // The way back down is one click away.
  fireEvent.click(await screen.findByRole("button", { name: "Scroll to bottom" }));
  assert.equal(port.scrollTop(), 1_600);
});

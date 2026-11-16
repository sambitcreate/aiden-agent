import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotChatRoute } from "../bot-chat-route";
import { settleBotPendingSends } from "./bot-chat-pane";
import { BotPanelHandoff } from "./bot-panel-handoff";
import { clearHandoffTaken } from "../../components/bots/handoff-taken";
import { mountWithBotRouter } from "./test-providers";
import { toast } from "../../components/ui";
import { botFixture } from "./test-fixtures";
import type { BotLiveSnapshot, BotTranscriptEntry } from "../../shared/bot-live";
import { pendingBotResumes, recordBotResume } from "./bot-resume-journal";
import type { BotPlanView } from "../../shared/bot-plans";
import { BOT_SIDEBAR_PREFERENCES_KEY, parseBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";
import { APPEARANCE_CHANGE_EVENT, cacheAppearance } from "../../lib/appearance-runtime";
import { createDefaultAppearanceConfig } from "../../shared/appearance";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  clearHandoffTaken();
});

const COST_RECEIPT = "cost_" + "a".repeat(64);
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

/** The Needs-you slot's "1 of N", or null while it shows one item or none. */
function slotPosition(): string | null {
  const header = screen.queryByRole("navigation", { name: "Needs you" });
  return header ? within(header).getByText(/^\d+ of \d+$/u).textContent : null;
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
  await screen.findByRole("button", { name: "Planner settings" });
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

test("an interrupted Bot offers Resume and Dismiss, each sent once with a request id, and the card leaves on the click", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1" } }),
    // Still interrupted after the Resume (say, the readmission was refused): the card comes back.
    "bots:resume": () => ({ kind: "interrupted", submissionId: "s1" }),
    "bots:dismiss": () => ({ kind: "idle" }),
  });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  assert.ok(within(card).getByText("I got interrupted while working on this."));
  fireEvent.click(within(card).getByRole("button", { name: "Resume" }));
  assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null, "the card leaves before main answers");
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
  const resume = calls.find((call) => call.channel === "bots:resume")!;
  const resumeInput = resume.args[0] as { botId: string; requestId: string };
  assert.equal(resumeInput.botId, "bot-1");
  assert.match(resumeInput.requestId, UUID);
  const back = await screen.findByRole("group", { name: "Planner was interrupted" });
  // Main answered (and remembers that answer per id), so the next Resume is a new request.
  fireEvent.click(within(back).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 2));
  const secondResume = calls.filter((call) => call.channel === "bots:resume")[1]!.args[0] as { requestId: string };
  assert.notEqual(secondResume.requestId, resumeInput.requestId);
  const backAgain = await screen.findByRole("group", { name: "Planner was interrupted" });
  fireEvent.click(within(backAgain).getByRole("button", { name: "Dismiss" }));
  assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null);
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:dismiss").length, 1));
  const dismissInput = calls.find((call) => call.channel === "bots:dismiss")!.args[0] as { botId: string; requestId: string };
  assert.equal(dismissInput.botId, "bot-1");
  assert.match(dismissInput.requestId, UUID);
  assert.notEqual(dismissInput.requestId, resumeInput.requestId);
});

test("resuming an unconfirmed provider charge requires explicit confirmation and preserves that consent on retry", async () => {
  let fail = true;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "1" } }),
    "bots:routineModels:resumeStatus": () => ({ requiresUnknownCostAcknowledgement: true, costReceiptId: COST_RECEIPT, interruptedSubmissionId: "1" }),
    "bots:resume": () => { if (fail) { fail = false; throw new Error("Lost Resume acknowledgement."); } return { kind: "running", submissionId: "1" }; },
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  const consent = await screen.findByRole("alertdialog", { name: "Resume Planner with an unconfirmed charge?" });
  assert.ok(within(consent).getByText(/Resuming may incur another charge/u));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
  fireEvent.click(within(consent).getByRole("button", { name: "Cancel" }));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 2));
  const attempts = calls.filter((call) => call.channel === "bots:resume").map((call) => call.args[0] as { requestId: string; acknowledgeUnknownCost?: boolean });
  assert.equal(attempts[0].acknowledgeUnknownCost, true);
  assert.equal(attempts[0].requestId, attempts[1].requestId); assert.equal(attempts[1].acknowledgeUnknownCost, true);
});

test("a cost confirmation for an older interrupted input cannot resume a newer one", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => ({ requiresUnknownCostAcknowledgement: true, costReceiptId: COST_RECEIPT, interruptedSubmissionId: "10" }),
    "bots:resume": () => ({ kind: "running", submissionId: "11" }),
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  const consent = await screen.findByRole("alertdialog");
  await act(async () => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "state", state: { kind: "interrupted", submissionId: "11" } }));
  fireEvent.click(within(consent).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
});

test("a delayed ordinary Resume preflight cannot resume newer work or survive leaving the chat", async () => {
  let release!: (value: { requiresUnknownCostAcknowledgement: boolean; interruptedSubmissionId?: string }) => void;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => new Promise((resolve) => { release = resolve; }),
    "bots:resume": () => ({ kind: "running", submissionId: "11" }),
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 1));
  await act(async () => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "state", state: { kind: "interrupted", submissionId: "11" } }));
  await act(async () => release({ requiresUnknownCostAcknowledgement: false }));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 2));
  cleanup();
  await act(async () => release({ requiresUnknownCostAcknowledgement: false, interruptedSubmissionId: "11" }));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
});

test("an unknown ordinary Resume survives remount and settles its original body before a new consent", async () => {
  const first = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:resume": () => { throw new Error("Lost ordinary Resume reply."); },
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await screen.findByRole("button", { name: "Retry saved Resume" });
  await waitFor(() => assert.equal(first.filter((call) => call.channel === "bots:resume").length, 1));
  const original = first.find((call) => call.channel === "bots:resume")!.args[0];
  cleanup();
  const second = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => ({ requiresUnknownCostAcknowledgement: true, costReceiptId: COST_RECEIPT, interruptedSubmissionId: "10" }),
    "bots:resume": () => ({ kind: "interrupted", submissionId: "10" }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Resume" }));
  await waitFor(() => assert.equal(pendingBotResumes("bot-1").length, 0));
  assert.deepEqual(second.find((call) => call.channel === "bots:resume")!.args[0], original);
  assert.equal(second.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 0);
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  const consent = await screen.findByRole("alertdialog");
  assert.equal(second.filter((call) => call.channel === "bots:resume").length, 1);
  fireEvent.click(within(consent).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(second.filter((call) => call.channel === "bots:resume").length, 2));
  const accepted = second.filter((call) => call.channel === "bots:resume")[1].args[0] as { requestId: string; acknowledgeUnknownCost?: boolean };
  assert.equal(accepted.acknowledgeUnknownCost, true);
  assert.notEqual(accepted.requestId, (original as { requestId: string }).requestId);
});

test("an acknowledged Resume survives remount with its exact source, consent and UUID", async () => {
  const handlers = {
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => ({ requiresUnknownCostAcknowledgement: true, costReceiptId: COST_RECEIPT, interruptedSubmissionId: "10" }),
    "bots:resume": () => { throw new Error("Lost confirmed Resume reply."); },
  };
  const first = await mountChat(handlers);
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Resume" }));
  await screen.findByRole("button", { name: "Retry saved Resume" });
  await waitFor(() => assert.equal(first.filter((call) => call.channel === "bots:resume").length, 1));
  const original = first.find((call) => call.channel === "bots:resume")!.args[0];
  cleanup();
  const second = await mountChat({ ...handlers, "bots:resume": () => ({ kind: "interrupted", submissionId: "11" }) });
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Resume" }));
  await waitFor(() => assert.equal(pendingBotResumes("bot-1").length, 0));
  assert.deepEqual(second.find((call) => call.channel === "bots:resume")!.args[0], original);
  assert.equal(second.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 0);
});

test("a consent dialog keeps its original receipt when another request on the same input becomes unknown", async () => {
  let currentReceipt = COST_RECEIPT, effects = 0, staleRequest: unknown;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => ({ requiresUnknownCostAcknowledgement: true, interruptedSubmissionId: "10", costReceiptId: currentReceipt }),
    "bots:resume": (input) => {
      if ((input as { expectedCostReceiptId?: string }).expectedCostReceiptId !== currentReceipt) {
        // The host consumes the stale decision, then refuses it. Its exact
        // replay settles observationally without applying it to the new cost.
        if (staleRequest === undefined) { staleRequest = input; throw new Error("The prior cost decision changed."); }
        assert.deepEqual(input, staleRequest);
        return { kind: "interrupted", submissionId: "10" };
      }
      effects++;
      return { kind: "interrupted", submissionId: "10" };
    },
  });
  const request = async () => fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await request();
  const oldDialog = await screen.findByRole("alertdialog");
  currentReceipt = "cost_" + "b".repeat(64);
  fireEvent.click(within(oldDialog).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
  assert.equal((calls.find((call) => call.channel === "bots:resume")!.args[0] as { expectedCostReceiptId: string }).expectedCostReceiptId, COST_RECEIPT);
  assert.equal(effects, 0, "confirming A never silently adopts receipt B");
  assert.equal(pendingBotResumes("bot-1").length, 1);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Resume" }));
  await waitFor(() => assert.equal(pendingBotResumes("bot-1").length, 0));
  assert.equal(calls.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 1, "settling A does not preflight or adopt B");
  assert.equal(effects, 0);
  await request();
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(effects, 1));
});

test("background visits invalidate held preflight and cost consent without sending Resume", async () => {
  let release!: (value: { requiresUnknownCostAcknowledgement: boolean; interruptedSubmissionId: string }) => void;
  let held = true;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:routineModels:resumeStatus": () => held ? new Promise((resolve) => { release = resolve; }) : { requiresUnknownCostAcknowledgement: true, costReceiptId: COST_RECEIPT, interruptedSubmissionId: "10" },
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 1));
  fireEvent(window, new Event("blur")); fireEvent(window, new Event("focus"));
  await act(async () => release({ requiresUnknownCostAcknowledgement: false, interruptedSubmissionId: "10" }));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
  held = false;
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await screen.findByRole("alertdialog");
  fireEvent(window, new Event("blur")); fireEvent(window, new Event("focus"));
  assert.ok(!screen.queryByRole("alertdialog"));
  assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
});

test("an expired saved Resume remains unconfirmed and is never replaced or sent", async () => {
  const now = Date.now;
  try {
    Date.now = () => now() - 24 * 60 * 60 * 1000;
    recordBotResume({ botId: "bot-1", submissionId: "10", requestId: crypto.randomUUID(), acknowledgement: {} });
  } finally { Date.now = now; }
  const original = pendingBotResumes("bot-1")[0];
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved Resume" }));
  await waitFor(() => assert.ok(!(screen.getByRole("button", { name: "Retry saved Resume" }) as HTMLButtonElement).disabled));
  assert.deepEqual(pendingBotResumes("bot-1"), [original]);
  assert.equal(calls.filter((call) => call.channel === "bots:resume" || call.channel === "bots:routineModels:resumeStatus").length, 0);
});

test("Resume sends nothing when its exact request cannot be retained on this device", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "10" } }),
    "bots:resume": () => ({ kind: "running", submissionId: "10" }),
  });
  const storage = localStorage, descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return storage.length; }, key: storage.key.bind(storage), getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage), clear: storage.clear.bind(storage), setItem: () => { throw new Error("Device storage is full."); },
    } });
    fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
    await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:routineModels:resumeStatus").length, 1));
    await screen.findByRole("group", { name: "Planner was interrupted" });
    assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 0);
  } finally { Object.defineProperty(globalThis, "localStorage", descriptor); }
  fireEvent.click(within(await screen.findByRole("group", { name: "Planner was interrupted" })).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 1));
});

test("a Resume that fails brings the card back, and the next Resume replays the same request id", async () => {
  let fail = true;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1" } }),
    "bots:resume": () => {
      if (fail) throw new Error("Error invoking remote method 'bots:resume': Error: Bots are starting.");
      return { kind: "running", submissionId: "s1" };
    },
  });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  fireEvent.click(within(card).getByRole("button", { name: "Resume" }));
  const back = await screen.findByRole("group", { name: "Planner was interrupted" });
  fail = false;
  fireEvent.click(within(back).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:resume").length, 2));
  const [first, second] = calls.filter((call) => call.channel === "bots:resume").map((call) => (call.args[0] as { requestId: string }).requestId);
  assert.equal(first, second, "main deduplicates the replay by its request id");
  // Running now: the card stays away until the live state says otherwise.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null);
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

test("a Bot over its monthly spending limit sends nothing until Allow more", async () => {
  const month = { ownerKind: "bot", ownerId: "bot-1", period: "month", limitUsd: 20, extraUsd: 0 } as const;
  let extraUsd = 0;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => ({ submissionId: "s", deduped: false }),
    "spending:status": () => ({ ...month, extraUsd, spentUsd: 20.4, state: extraUsd ? "under" : "reached" }),
    "spending:allowMore": () => {
      extraUsd = 20;
      return { ...month, extraUsd, spentUsd: 20.4, state: "under" };
    },
  });
  const reached = "Planner reached its $20.00 spending limit this month.";
  // The composer's status line says why it can't send, alongside the notice.
  await waitFor(() => assert.equal(screen.getAllByText(reached).length, 2));
  const blocked = document.querySelector("textarea")!;
  fireEvent.change(blocked, { target: { value: "One more thing" } });
  fireEvent.keyDown(blocked, { key: "Enter" });
  assert.equal(screen.queryByRole("button", { name: "Send message" })?.hasAttribute("disabled") ?? true, true);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);

  fireEvent.click(screen.getByRole("button", { name: "Allow $20.00 more" }));
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "One more thing" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
});

test("the status slot shows one card: a spent limit outranks the person's pause, and a model problem outranks both", async () => {
  const month = { ownerKind: "bot", ownerId: "bot-1", period: "month", limitUsd: 20, extraUsd: 0 } as const;
  let state: BotLiveSnapshot["state"] = { kind: "paused", since: 1_000, by: "mac" };
  await mountChat({
    "bots:live:subscribe": () => snapshot({ state }),
    "spending:status": () => ({ ...month, spentUsd: 20.4, state: "reached" }),
  });
  await screen.findByRole("button", { name: "Allow $20.00 more" });
  assert.equal(screen.queryByRole("group", { name: /paused/u }), null, "the pause card waits behind the limit");
  cleanup();
  state = { kind: "model_error", message: "Sign in to Text Service again." };
  await mountChat({
    "bots:live:subscribe": () => snapshot({ state }),
    "spending:status": () => ({ ...month, spentUsd: 20.4, state: "reached" }),
  });
  await screen.findByRole("alert", { name: "Planner can’t reach its AI model" });
  assert.equal(screen.queryByRole("button", { name: "Allow $20.00 more" }), null);
});

test("a Bot at its monthly limit can send again once its month starts over, without Allow more", async () => {
  const month = { ownerKind: "bot", ownerId: "bot-1", period: "month", limitUsd: 20, extraUsd: 0 } as const;
  const periodEnd = Date.now() + 300;
  let reads = 0;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => ({ submissionId: "s", deduped: false }),
    "spending:status": () =>
      ++reads === 1
        ? { ...month, spentUsd: 20.4, state: "reached", periodStart: periodEnd - 30 * 86_400_000, periodEnd }
        : { ...month, spentUsd: 0, state: "under", periodStart: periodEnd, periodEnd: periodEnd + 30 * 86_400_000 },
  });
  await waitFor(() => assert.equal(screen.getAllByText("Planner reached its $20.00 spending limit this month.").length, 2));
  const box = await screen.findByPlaceholderText("Ask Planner", undefined, { timeout: 3_000 });
  fireEvent.change(box, { target: { value: "New month" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
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

/** A Bot's Always is the remembered allow in the menu beside Allow once. */
async function chooseBotAlways(card: HTMLElement) {
  fireEvent.pointerDown(within(card).getByRole("button", { name: "More ways to allow" }), { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Always allow for Planner/u }));
}

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
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  assert.ok(within(card).getByText("Send the weekly update to the team."));
  assert.ok(within(card).getByText("Planner is paused until you choose."));
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:approve")));
  assert.deepEqual(calls.find((call) => call.channel === "bots:approve")?.args, [
    { waitId: "wait-7", decision: "allow" },
  ]);
  await waitFor(() => assert.equal(screen.queryByRole("region", { name: "Review before Send email" }), null));
  // The answered card collapses to its status line.
  assert.equal((await screen.findByText("Allowed once")).closest("[role='status']")?.getAttribute("data-approval-status"), "allow");
});

test("identical waiting calls share one card, which answers every one of them", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => ({ decided: true }),
  });
  // A mutating tool's card can read the same for different arguments: only the hashes say it is the same call.
  const same = { botId: "bot-1", toolName: "send_email", summary: "send_email", argumentsHash: "args-ana", runHash: "run-1" };
  act(() => {
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-1", toolCallId: "call-1" });
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-2", toolCallId: "call-2" });
    emitBotTestNotification("bots:approval", { ...same, argumentsHash: "args-bo", waitId: "wait-3", toolCallId: "call-3" });
    emitBotTestNotification("bots:approval", { ...same, runHash: "run-2", waitId: "wait-4", toolCallId: "call-4" });
    emitBotTestNotification("bots:approval", { botId: "bot-1", toolName: "send_email", summary: "send_email", waitId: "wait-5", toolCallId: "call-5" });
  });
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  assert.equal(slotPosition(), "1 of 4", "the Needs-you slot counts the cards");
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:approve").length, 2));
  assert.deepEqual(calls.filter((call) => call.channel === "bots:approve").map((call) => call.args), [
    [{ waitId: "wait-1", decision: "deny" }],
    [{ waitId: "wait-2", decision: "deny" }],
  ], "different arguments, another reply, or no hashes each wait for their own answer");
  await waitFor(() => assert.equal(slotPosition(), "1 of 3"));
});

test("a shared card's answer removes only the waits it reached", async () => {
  const answers: Record<string, { decided: boolean }> = { "wait-1": { decided: false }, "wait-2": { decided: true } };
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": (request) => answers[(request as { waitId: string }).waitId],
  });
  const approved = () => calls.filter((call) => call.channel === "bots:approve").map((call) => (call.args[0] as { waitId: string }).waitId);
  const same = { botId: "bot-1", toolName: "send_email", summary: "Send it.", argumentsHash: "args", runHash: "run" };
  act(() => {
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-1", toolCallId: "call-1" });
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-2", toolCallId: "call-2" });
  });
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() => assert.deepEqual(approved(), ["wait-1", "wait-2"]));
  // The second wait was allowed although the first was not: no error.
  await waitFor(() => assert.equal((within(card).getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled, false));
  assert.equal(within(card).queryByRole("alert"), null);
  // Only the wait it did not reach is still on the card.
  answers["wait-1"] = { decided: true };
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() => assert.deepEqual(approved(), ["wait-1", "wait-2", "wait-1"]));
  assert.ok(await screen.findByText("Allowed once"));
});

test("a shared card whose answer reached none of its waits says so and stays", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": (request) =>
      (request as { waitId: string }).waitId === "wait-1"
        ? { decided: false }
        : Promise.reject(new Error("The approval could not be sent.")),
  });
  const same = { botId: "bot-1", toolName: "send_email", summary: "Send it.", argumentsHash: "args", runHash: "run" };
  act(() => {
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-1", toolCallId: "call-1" });
    emitBotTestNotification("bots:approval", { ...same, waitId: "wait-2", toolCallId: "call-2" });
  });
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  assert.equal((await within(card).findByRole("alert")).textContent, "The approval could not be sent.");
  assert.equal(screen.queryByText("Allowed once"), null);
  assert.ok(screen.getByRole("region", { name: "Review before Send email" }), "neither wait was removed");
});

test("a card answered on another device collapses to No longer active, and a deny here to Denied", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => ({ decided: true }),
  });
  const prompt = { botId: "bot-1", waitId: "wait-9", toolCallId: "call-9", toolName: "send_email", summary: "Send it." };
  act(() => emitBotTestNotification("bots:approval", prompt));
  await screen.findByRole("region", { name: "Review before Send email" });
  act(() => emitBotTestNotification("bots:approval-settled", { botId: "bot-1", waitId: "wait-9", outcome: "allowed" }));
  assert.ok(await screen.findByText("No longer active"));
  assert.equal(screen.queryByRole("region", { name: "Review before Send email" }), null);

  act(() => emitBotTestNotification("bots:approval", { ...prompt, waitId: "wait-10" }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  // The device's own answer is never reported as stale, even when the settlement arrives first.
  act(() => emitBotTestNotification("bots:approval-settled", { botId: "bot-1", waitId: "wait-10", outcome: "denied" }));
  assert.ok(await screen.findByText("Denied"));
  assert.equal(screen.queryByText("No longer active"), null);
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
  assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null, "the card is gone while main answers");
  // Answered as still interrupted: the card is back and works again.
  answer({ kind: "interrupted", submissionId: "s1" });
  const back = await screen.findByRole("group", { name: "Planner was interrupted" });
  fireEvent.click(within(back).getByRole("button", { name: "Dismiss" }));
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
  const card = await screen.findByRole("region", { name: "Review before Share image" });
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  assert.equal((await within(card).findByRole("alert")).textContent, "The approval could not be sent.");
  await waitFor(() => assert.equal((within(card).getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled, false));
  assert.equal(screen.queryByText("Allowed once"), null);
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

test("a long turn shows its elapsed time on the status line and one Stop, the composer's", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Do you have access to my messages?")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "thinking", startedAt: Date.now() - 25_000 },
      }),
    "bots:stop": () => ({ kind: "idle" }),
  });
  const line = await screen.findByRole("group", { name: "Thinking" });
  assert.match(line.textContent ?? "", /· 2\ds/u);
  const stops = screen.getAllByRole("button", { name: /^Stop/u });
  assert.deepEqual(stops.map((button) => button.getAttribute("aria-label")), ["Stop generating"], "the line doesn't repeat the composer's Stop");
  fireEvent.click(stops[0]!);
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:stop").map((call) => call.args), [["bot-1"]]));
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
  const opening = "Story opening.\n\n";
  const fresh = `${opening}A woodland tale.\n\n`;
  const continued = `${fresh}Once upon a time there was a fox.\n\n`;
  let finishReload!: (value: BotLiveSnapshot) => void;
  const reloadSnapshot = new Promise<BotLiveSnapshot>((resolve) => { finishReload = resolve; });
  let subscribes = 0;
  const calls = await mountChat({
    "bots:live:subscribe": () => ++subscribes === 1
      ? snapshot({
          seq: 3,
          entries: [userEntry("u1", "Tell me a story")],
          partial: opening,
          state: { kind: "running", submissionId: "s1" },
        })
      : reloadSnapshot,
  });
  assert.ok(await screen.findByText("Story opening."));
  cleanup();
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:live:unsubscribe").length, 1));
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  // Identity can render from cache before the new live subscription exists.
  await waitFor(() => assert.equal(subscribes, 2));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1", epoch: "epoch-1", seq: 5, type: "partial", text: continued,
  }));
  assert.equal(screen.queryByText("A woodland tale."), null, "the pending snapshot has not authorized its buffered update yet");
  await act(async () => finishReload(snapshot({
    seq: 4,
    entries: [userEntry("u1", "Tell me a story")],
    partial: fresh,
    state: { kind: "running", submissionId: "s1" },
  })));
  // Finished paragraphs exercise reload/replay without racing the separate
  // one-second reveal-tail deadline against the query's one-second deadline.
  assert.ok(await screen.findByText("A woodland tale."));
  assert.ok(screen.getByText("Once upon a time there was a fox."));
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1", epoch: "epoch-1", seq: 6, type: "partial", text: `${continued}An owl joined the tale.\n\n`,
  }));
  assert.ok(await screen.findByText("An owl joined the tale."));
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

const FINISHED_SEARCH: BotTranscriptEntry[] = [
  { ...userEntry("u1", "Find flights"), at: 1_000 } as BotTranscriptEntry,
  toolStep("a1", ""),
  { id: "r1", type: "tool_result", toolCallId: "a1-call", toolName: "web_search", isError: false, status: "ok", at: 5_000 },
  { ...assistantEntry("a2", "TAP on Friday is cheapest."), at: 19_000 } as BotTranscriptEntry,
];

function showToolActivity(value: boolean) {
  cacheAppearance({ ...createDefaultAppearanceConfig(), showToolActivity: value });
  act(() => window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT)));
}

test("tool activity is hidden by default; Show tool activity shows it, folded to one line once the run ended", async () => {
  try {
    await mountChat({
      // A Bot still stored as Summary: the device switch decides now, not the Bot.
      "bots:get": () => botFixture({ chatActivity: { level: "summary", wording: "follows" } }),
      "bots:live:subscribe": () => snapshot({ entries: FINISHED_SEARCH }),
    });
    await screen.findByText("TAP on Friday is cheapest.");
    assert.equal(screen.queryByRole("button", { name: /^Worked for/u }), null, "hidden by default");
    showToolActivity(true);
    const recap = await screen.findByRole("button", { name: "Worked for 18s · searched the web" });
    assert.equal(screen.queryByText("Searched the web"), null, "the finished run is one line");
    fireEvent.click(recap);
    assert.ok(await screen.findByText("Searched the web"));
    showToolActivity(false);
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: /^Worked for/u }), null));
  } finally {
    localStorage.clear();
  }
});

test("until the switch is set, a Bot that was Detailed keeps showing its tool activity", async () => {
  await mountChat({
    "bots:get": () => botFixture({ chatActivity: { level: "detailed", wording: "follows" } }),
    "bots:live:subscribe": () => snapshot({ entries: FINISHED_SEARCH }),
  });
  assert.ok(await screen.findByRole("button", { name: "Worked for 18s · searched the web" }));
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

for (const key of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
  test(`${key.key} opens a Bot message menu and Reply keeps that message's text`, async () => {
    await mountChat({
      "bots:live:subscribe": () => snapshot({ entries: [userEntry("u1", "First question"), assistantEntry("a1", "Keep this answer")] }),
    });
    const actions = await screen.findByRole("button", { name: "Message actions for Planner’s message" });
    actions.focus();
    fireEvent.keyDown(actions, key);
    const reply = await screen.findByRole("menuitem", { name: "Reply" });
    fireEvent.click(reply);
    await waitFor(() => assert.equal((screen.getByPlaceholderText("Ask Planner") as HTMLTextAreaElement).value, "> Keep this answer\n\n"));
  });
}

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

test("a model the Bot can't reach says why, and Choose a model opens that Bot's Advanced tab", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ state: { kind: "model_error", message: "Sign in to Text Service again." } }),
  });
  const { router } = await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const card = await screen.findByRole("alert", { name: "Planner can’t reach its AI model" });
  assert.ok(within(card).getByText("Sign in to Text Service again."));
  fireEvent.click(within(card).getByRole("button", { name: "Choose a model" }));
  await waitFor(() => assert.equal(advancedTabShown(), true));
  assert.equal(router.state.location.pathname, "/bots/bot-1/chat", "the chat stays, with its settings beside it");
});

/** The Bot panel is open on its Advanced tab, the Bot's settings. */
function advancedTabShown(): boolean {
  const panel = document.getElementById("bot-panel");
  if (!panel || panel.getAttribute("data-state") !== "open") return false;
  return within(panel).getByRole("tab", { name: "Advanced" }).getAttribute("aria-selected") === "true";
}

test("an interrupted Bot whose access changed opens its Advanced tab", async () => {
  installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s1", blocked: "access_changed" } }),
  });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const card = await screen.findByRole("group", { name: "Planner was interrupted" });
  fireEvent.click(within(card).getByRole("button", { name: "Open Advanced" }));
  await waitFor(() => assert.equal(advancedTabShown(), true));
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
  timezone: "America/New_York",
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

test("a routine suggestion shows its name, schedule and prompt, and Add accepts it once", async () => {
  let respond: (value: unknown) => void = () => undefined;
  const calls = await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () =>
      snapshot({ entries: [assistantEntry("a1", "Want me to check in daily?"), proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => new Promise((resolve) => (respond = resolve)),
  });
  const card = await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" });
  assert.ok(within(card).getByText("Add a routine?"));
  assert.ok(within(card).getByText("Daily check-in · Every day at 9:00 AM · Eastern Time"));
  assert.ok(within(card).getByText(CHECK_IN_PROPOSAL.prompt));

  fireEvent.click(within(card).getByRole("button", { name: "Add" }));
  fireEvent.click(within(card).getByRole("button", { name: /Add/u }));
  const responds = () => calls.filter((call) => call.channel === "bots:routineProposals:respond");
  await waitFor(() => assert.equal(responds().length, 1));
  assert.deepEqual(responds()[0]!.args[0], { botId: "bot-1", proposalId: "proposal-1", decision: "accept" });
  await act(async () => respond({ status: "accepted", routineId: "task-9" }));
  assert.ok(await screen.findByText("Added Daily check-in · Every day at 9:00 AM · Eastern Time"));
  assert.equal(screen.queryByRole("group", { name: "Routine suggestion: Daily check-in" }), null, "it settles to a receipt line");
  assert.equal(responds().length, 1, "a second click while it was answering sent nothing");
});

test("Not now dismisses a routine suggestion with no reason, and Why not? on its receipt sends one", async () => {
  const calls = await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ entries: [proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => ({ status: "dismissed" }),
  });
  fireEvent.click(within(await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" })).getByRole("button", { name: "Not now" }));
  await screen.findByText("Not added: Daily check-in");
  fireEvent.click(screen.getByRole("button", { name: "Why not Daily check-in?" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Why not Daily check-in?" })).getByRole("button", { name: "Already have this" }));
  await screen.findByText("Not added: Daily check-in. Noted, thanks.");
  assert.deepEqual(calls.filter((call) => call.channel === "bots:routineProposals:respond").map((call) => call.args[0]), [
    { botId: "bot-1", proposalId: "proposal-1", decision: "dismiss" },
    { botId: "bot-1", proposalId: "proposal-1", decision: "dismiss", reason: "already_have" },
  ]);
});

test("a failed answer keeps the suggestion answerable, and one answered elsewhere arrives settled", async () => {
  await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => snapshot({ entries: [proposalEntry("pending")] }),
    "bots:routineProposals:respond": () => {
      throw new Error("The Mac is busy.");
    },
  });
  const card = await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" });
  fireEvent.click(within(card).getByRole("button", { name: "Add" }));
  await waitFor(() =>
    assert.equal((within(card).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled, false),
  );
  assert.ok(within(card).getByText("Add a routine?"));

  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "entry",
    entry: proposalEntry("accepted", "task-9"),
  }));
  assert.ok(await screen.findByText("Added Daily check-in · Every day at 9:00 AM · Eastern Time"));
});

test("only one suggestion shows in full: the newest waits on screen, an earlier one folds to Waiting with Show", async () => {
  await mountChat({
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () =>
      snapshot({
        entries: [
          proposalEntry("pending"),
          assistantEntry("a1", "I also wrote a skill."),
          {
            id: "s1",
            type: "skill_proposal",
            proposal: { proposalId: "skill-1", name: "meal-plan", description: "Use when planning meals.", origin: "bot", preview: "List seven dinners.", update: false },
            status: "pending",
          },
        ],
      }),
  });
  assert.ok(await screen.findByRole("group", { name: "Skill: meal-plan" }));
  assert.equal(screen.queryByRole("group", { name: "Routine suggestion: Daily check-in" }), null);
  assert.ok(screen.getByText("Waiting: Routine suggestion: Daily check-in"));
  fireEvent.click(screen.getByRole("button", { name: "Show Routine suggestion: Daily check-in" }));
  assert.ok(await screen.findByRole("group", { name: "Routine suggestion: Daily check-in" }));
  assert.equal(screen.queryByRole("group", { name: "Skill: meal-plan" }), null, "still only one in full");
  assert.ok(screen.getByText("Waiting: Skill: meal-plan"));
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
  const pill = await screen.findByRole("button", { name: "Planner settings" });
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

const BANK_HANDOFF = {
  botId: "bot-1",
  waitId: "wait-h",
  toolCallId: "tool-h",
  kind: "action" as const,
  action: "Enter the 2FA code for your bank",
  why: "Only you get the code on your phone.",
  open: { url: "https://bank.example/verify" },
  source: "tool" as const,
};

const RUNNING = { kind: "running", submissionId: "s1" } as const;

/** The test DOM does not mount sonner's viewport, so observe the error toasts the person would be shown. */
function captureErrorToasts() {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => {
    shown.push(String(message));
    return "toast";
  }) as typeof toast.error;
  return { shown, restore: () => void (toast.error = original) };
}

const handoffAnswers = (calls: ReadonlyArray<{ channel: string; args: unknown[] }>) =>
  calls.filter((call) => call.channel === "bots:answerHandoff").map((call) => call.args[0]);

test("a hand-off card waits above the composer, Open asks for its page, and Done answers it once by wait id", async () => {
  let release: (value: { answered: boolean }) => void = () => undefined;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
    "bots:openHandoff": () => ({ opened: "external" }),
    "bots:answerHandoff": () => new Promise((resolve) => (release = resolve)),
  });
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  assert.ok(within(card).getByText("Needs you: Enter the 2FA code for your bank"));
  assert.ok(within(card).getByText("Only you get the code on your phone."));
  const note = screen.getByPlaceholderText("Add a note and send to mark it done");
  assert.ok(
    within(card).getByRole("button", { name: "Take control at bank.example" }).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the composer stays, for a note, and Tab reaches it after the card's buttons",
  );
  assert.equal(within(card).queryByRole("button", { name: "I’m done" }), null, "I'm done comes once the person took control");

  fireEvent.click(within(card).getByRole("button", { name: "Take control at bank.example" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:openHandoff")?.args, [{ botId: "bot-1", waitId: "wait-h" }]),
  );
  await waitFor(() => assert.equal((within(card).getByRole("button", { name: "I’m done" }) as HTMLButtonElement).disabled, false));

  fireEvent.click(within(card).getByRole("button", { name: "I’m done" }));
  fireEvent.click(within(card).getByRole("button", { name: "I’m done" }));
  await waitFor(() => assert.equal(handoffAnswers(calls).length, 1));
  assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-h", outcome: "done" }], "a second press waits for the first");
  await act(async () => release({ answered: true }));

  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "handoff", handoff: null }));
  await waitFor(() => assert.equal(document.body.textContent?.includes("Needs you:"), false));
  act(() =>
    emitBotTestNotification("bots:live:event", {
      botId: "bot-1",
      epoch: "epoch-1",
      seq: 2,
      type: "entry",
      entry: { id: "handoff:tool-h", type: "handoff_result", kind: "action", outcome: "done", action: BANK_HANDOFF.action },
    }),
  );
  await waitFor(() => assert.equal(document.body.textContent?.includes("You did this: Enter the 2FA code for your bank"), true));
  assert.ok(screen.getByPlaceholderText("Ask Planner"), "the composer asks the Bot again");
});

test("Skip answers the card as skipped, and a card answered elsewhere says so", async () => {
  const errors = captureErrorToasts();
  try {
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: { ...BANK_HANDOFF, open: undefined } }),
      "bots:answerHandoff": () => ({ answered: false }),
    });
    const card = await screen.findByRole("group", { name: "Planner needs you" });
    assert.equal(within(card).queryByRole("button", { name: /^Open/u }), null, "no page, no Open");
    fireEvent.click(within(card).getByRole("button", { name: "Take control" }));
    assert.equal(calls.some((call) => call.channel === "bots:openHandoff"), false, "nothing to open");
    fireEvent.click(within(card).getByRole("button", { name: "Skip" }));
    await waitFor(() => assert.deepEqual(errors.shown, ["That card was already answered or closed."]));
    assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-h", outcome: "skipped" }]);
  } finally {
    errors.restore();
  }
});

test("typing while a hand-off waits answers it Done with that note, never as a queued or steering message", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
    "bots:answerHandoff": () => ({ answered: true }),
    "bots:stop": () => ({ kind: "idle" }),
  });
  const box = await screen.findByPlaceholderText("Add a note and send to mark it done");
  assert.equal(screen.queryByRole("button", { name: "Queue message" }), null, "the note answers the card, so there is no Queue or Steer");
  fireEvent.change(box, { target: { value: "  Code entered, it said 'verified'.  " } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(handoffAnswers(calls).length, 1));
  assert.deepEqual(handoffAnswers(calls), [
    { botId: "bot-1", waitId: "wait-h", outcome: "done", note: "Code entered, it said 'verified'." },
  ]);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false, "the note never reaches the Bot as a message of its own");
  assert.equal(document.querySelector("[data-bot-pending-send]"), null, "nor shows as a message being sent");

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:stop").map((call) => call.args), [["bot-1"]]));
});

test("a note sent while Open is on its way keeps the card's buttons waiting for the note, so Done can't answer twice", async () => {
  const errors = captureErrorToasts();
  try {
    let opened: (value: { opened: string }) => void = () => undefined;
    let answered: (value: { answered: boolean }) => void = () => undefined;
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
      "bots:openHandoff": () => new Promise((resolve) => (opened = resolve)),
      "bots:answerHandoff": () => new Promise((resolve) => (answered = resolve)),
    });
    const card = await screen.findByRole("group", { name: "Planner needs you" });
    const done = () => within(card).getByRole("button", { name: "I’m done" }) as HTMLButtonElement;
    fireEvent.click(within(card).getByRole("button", { name: "Take control at bank.example" }));
    await waitFor(() => assert.equal(done().disabled, true));
    const box = screen.getByPlaceholderText("Add a note and send to mark it done");
    fireEvent.change(box, { target: { value: "Entered it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => assert.equal(handoffAnswers(calls).length, 1));

    await act(async () => opened({ opened: "external" }));
    assert.equal(done().disabled, true, "the note is still on its way");
    fireEvent.click(done());
    await act(async () => answered({ answered: true }));
    await waitFor(() => assert.equal(done().disabled, false));
    assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-h", outcome: "done", note: "Entered it." }]);
    assert.deepEqual(errors.shown, [], "no 'already answered' for an answer the person sent once");
  } finally {
    errors.restore();
  }
});

test("the floating panel's copy of the card waits for a note sent from the composer, so its Done can't answer twice", async () => {
  const errors = captureErrorToasts();
  try {
    let opened: (value: { opened: string }) => void = () => undefined;
    let answered: (value: { answered: boolean }) => void = () => undefined;
    const calls = installBotTestIpc({
      "bots:get": () => botFixture(),
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
      "bots:openHandoff": () => new Promise((resolve) => (opened = resolve)),
      "bots:answerHandoff": () => new Promise((resolve) => (answered = resolve)),
    });
    // The panel floating over a narrow chat carries the card's buttons; the composer stays below.
    await mountWithBotRouter(<BotChatRoute botId="bot-1" />, {
      initialPath: "/bots/bot-1/chat",
      sidebar: <BotPanelHandoff botId="bot-1" name="Planner" avatar={botFixture().avatar} />,
    });
    await waitFor(() => assert.equal(screen.getAllByRole("group", { name: "Planner needs you" }).length, 2));
    // The panel's copy carries the title and buttons, not the card's reason.
    const panel = screen.getAllByRole("group", { name: "Planner needs you" }).find((group) => !within(group).queryByText(BANK_HANDOFF.why))!;
    const done = () => within(panel).getByRole("button", { name: "I’m done" }) as HTMLButtonElement;
    fireEvent.click(within(panel).getByRole("button", { name: "Take control at bank.example" }));
    await waitFor(() => assert.equal(done().disabled, true));
    fireEvent.change(screen.getByPlaceholderText("Add a note and send to mark it done"), { target: { value: "Entered it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => assert.equal(handoffAnswers(calls).length, 1));

    await act(async () => opened({ opened: "external" }));
    assert.equal(done().disabled, true, "the note from the composer is still on its way");
    fireEvent.click(done());
    await act(async () => answered({ answered: true }));
    await waitFor(() => assert.equal(done().disabled, false));
    assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-h", outcome: "done", note: "Entered it." }]);
    assert.deepEqual(errors.shown, []);
  } finally {
    errors.restore();
  }
});

test("a note the card could not take stays in the composer", async () => {
  const errors = captureErrorToasts();
  try {
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
      "bots:answerHandoff": () => ({ answered: false }),
    });
    const box = (await screen.findByPlaceholderText("Add a note and send to mark it done")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Done on my phone." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
    await waitFor(() => assert.deepEqual(errors.shown, ["That card was already answered or closed."], "said once"));
    assert.equal(handoffAnswers(calls).length, 1);
    await waitFor(() => assert.equal(box.value, "Done on my phone."));
  } finally {
    errors.restore();
  }
});

const CREDENTIALS_HANDOFF = {
  botId: "bot-1",
  waitId: "wait-c",
  toolCallId: "tool-c",
  kind: "action" as const,
  action: "Enter a password or 2FA code, or change account security",
  why: "Planner was about to type into the bank's code field.",
  source: "rule" as const,
  rule: { id: "locked.credentials", label: "Enter a password or 2FA code, or change account security" },
};

test("a card that takes a note says the Bot reads it, so a password, code or card number stays out of the chat", async () => {
  // A money rule's card takes a note too (a payment reference), so it names card numbers.
  const payment = { ...CREDENTIALS_HANDOFF, waitId: "wait-m", rule: { id: "locked.money", label: "Move money or enter card details" } };
  for (const handoff of [BANK_HANDOFF, payment]) {
    await mountChat({ "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff }) });
    const card = await screen.findByRole("group", { name: "Planner needs you" });
    assert.ok(
      within(card).getByText("Planner reads any note you send. Enter passwords, codes and card numbers on the page, never in the chat."),
      handoff.waitId,
    );
    cleanup();
  }
});

test("a password-or-code card takes no note: the composer points to the card, and Done answers it without one", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: CREDENTIALS_HANDOFF }),
    "bots:answerHandoff": () => ({ answered: true }),
  });
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  assert.ok(
    screen.getByText("Enter it yourself, then choose I’m done above. This card takes no note, so a password or code never reaches Planner.", {
      selector: "[role=status]",
    }),
    "the composer says where to answer",
  );
  assert.equal(screen.queryByPlaceholderText("Add a note and send to mark it done"), null);
  assert.equal(within(card).queryByText(/reads any note you send/u), null, "no note to warn about");
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "481516" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(handoffAnswers(calls).length, 0, "the code typed in the chat is never sent");
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);

  fireEvent.click(within(card).getByRole("button", { name: "Take control" }));
  fireEvent.click(within(card).getByRole("button", { name: "I’m done" }));
  await waitFor(() => assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-c", outcome: "done" }]));
});

test("a photo sent while a hand-off waits is refused and kept with the note, and the card stays unanswered", async () => {
  const errors = captureErrorToasts();
  try {
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
      "bots:answerHandoff": () => ({ answered: true }),
    });
    // The pasted image reaches the composer the way the preload's attachment reader returns it.
    (window as unknown as { aidenAPI: Record<string, unknown> }).aidenAPI.attachments = {
      readClipboardImages: async () => [
        { id: "img-1", name: "verified.png", mimeType: "image/png", kind: "image", size: 4, data: "AAECAw==" },
      ],
    };
    const box = (await screen.findByPlaceholderText("Add a note and send to mark it done")) as HTMLTextAreaElement;
    const image = new File([new Uint8Array([0, 1, 2, 3])], "verified.png", { type: "image/png" });
    fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => image }], getData: () => "" },
    });
    await waitFor(() => assert.equal(document.body.textContent?.includes("1 attachment is ready."), true));
    fireEvent.change(box, { target: { value: "It said verified." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => assert.deepEqual(errors.shown, ["Send photos after you answer the card."]));
    assert.equal(handoffAnswers(calls).length, 0, "the card is not answered without the photo");
    assert.equal(calls.some((call) => call.channel === "bots:send"), false);
    await waitFor(() => assert.equal(box.value, "It said verified."));
    assert.ok(screen.getByRole("group", { name: "Planner needs you" }), "the card still waits");
  } finally {
    errors.restore();
  }
});

const GITHUB_SIGN_IN = {
  botId: "bot-1",
  waitId: "wait-s",
  toolCallId: "tool-s",
  kind: "sign_in" as const,
  action: "Sign in to github.com",
  why: "I need your GitHub account to read your issues.",
  open: { url: "https://github.com" },
  origin: "https://github.com",
  target: "browser" as const,
  source: "tool" as const,
};

test("a sign-in card opens the site in the Bot's browser, brings its panel forward, and I'm done answers it", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: GITHUB_SIGN_IN }),
    "bots:openHandoff": () => ({ opened: "browser" }),
    "bots:answerHandoff": () => ({ answered: true }),
  });
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  assert.ok(within(card).getByText("Sign in to github.com for Planner"));
  const panel = document.getElementById("bot-panel");
  assert.equal(panel?.getAttribute("data-state"), "closed");

  fireEvent.click(within(card).getByRole("button", { name: "Take control to sign in" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "bots:openHandoff")?.args, [{ botId: "bot-1", waitId: "wait-s" }]),
  );
  await waitFor(() => assert.equal(document.getElementById("bot-panel")?.getAttribute("data-state"), "open"));

  await waitFor(() => assert.equal((within(card).getByRole("button", { name: "I’m done" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(within(card).getByRole("button", { name: "I’m done" }));
  await waitFor(() => assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-s", outcome: "done" }]));
});

// This DOM lays nothing out, so the chat measures no room beside the panel and the panel floats over it.
test("a panel floating over the chat carries the sign-in's buttons, so I'm done stays in reach", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: GITHUB_SIGN_IN }),
    "bots:openHandoff": () => ({ opened: "browser" }),
    "bots:answerHandoff": () => ({ answered: true }),
  });
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  fireEvent.click(within(card).getByRole("button", { name: "Take control to sign in" }));
  const panel = document.getElementById("bot-panel");
  assert.ok(panel);
  await waitFor(() => assert.equal(panel.getAttribute("data-state"), "open"));
  assert.equal(panel.getAttribute("data-surface-mode"), "tools-floating");

  const inPanel = within(panel).getByRole("group", { name: "Planner needs you" });
  assert.ok(within(inPanel).getByText("Sign in to github.com for Planner"));
  fireEvent.click(within(inPanel).getByRole("button", { name: "I’m done" }));
  await waitFor(() => assert.deepEqual(handoffAnswers(calls), [{ botId: "bot-1", waitId: "wait-s", outcome: "done" }]));

  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "handoff", handoff: null }));
  await waitFor(() => assert.equal(within(panel).queryByRole("group", { name: "Planner needs you" }), null));
});

test("a panel docked beside the chat leaves the hand-off to its card, with no second set of buttons", async () => {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function wide() {
    return { x: 0, y: 0, top: 0, left: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) } as DOMRect;
  };
  try {
    await mountChat({ "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: GITHUB_SIGN_IN }) });
    await screen.findByRole("group", { name: "Planner needs you" });
    fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
    const panel = document.getElementById("bot-panel");
    assert.ok(panel);
    assert.equal(panel.getAttribute("data-state"), "open");
    assert.equal(panel.getAttribute("data-surface-mode"), "tools-pinned");
    assert.equal(within(panel).queryByRole("group", { name: "Planner needs you" }), null);
    assert.equal(screen.getAllByRole("button", { name: "Take control to sign in" }).length, 1);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = measure;
  }
});

test("while a sign-in waits the composer takes no note, so a password typed there never reaches the Bot", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: GITHUB_SIGN_IN }),
    "bots:answerHandoff": () => ({ answered: true }),
    "bots:stop": () => ({ kind: "idle" }),
  });
  await screen.findByRole("group", { name: "Planner needs you" });
  assert.ok(
    screen.getByText("Sign in for Planner with Take control above, then choose I’m done.", { selector: "[role=status]" }),
    "the composer says where to answer",
  );
  assert.equal(screen.queryByPlaceholderText("Add a note and send to mark it done"), null);
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "hunter2" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(handoffAnswers(calls).length, 0);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => assert.deepEqual(calls.filter((call) => call.channel === "bots:stop").map((call) => call.args), [["bot-1"]]));
});

test("a sign-in page that couldn't open says so, and the card keeps waiting", async () => {
  const errors = captureErrorToasts();
  try {
    await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: GITHUB_SIGN_IN }),
      "bots:openHandoff": () => ({ opened: "none" }),
    });
    const card = await screen.findByRole("group", { name: "Planner needs you" });
    fireEvent.click(within(card).getByRole("button", { name: "Take control to sign in" }));
    await waitFor(() => assert.deepEqual(errors.shown, ["Aiden couldn’t open the sign-in page."]));
    assert.equal(document.getElementById("bot-panel")?.getAttribute("data-state"), "closed");
    assert.ok(screen.getByRole("group", { name: "Planner needs you" }));
  } finally {
    errors.restore();
  }
});

test("a sent message shows at once as a sent message with Getting ready, and the echo settles into its entry", async () => {
  let answer: (result: unknown) => void = () => undefined;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => new Promise((resolve) => (answer = resolve)),
  });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "Plan dinner" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  const echo = await screen.findByText("Plan dinner");
  assert.ok(echo.closest("[data-bot-pending-send]"), "the message is on screen before main answers");
  assert.ok(echo.closest("[data-bot-message]"), "it is a message like any other, with Copy and Reply");
  assert.equal(screen.queryByText("Sending…"), null, "a quick send never says Sending…");
  // The Bot shows it is starting before main answers.
  await waitFor(() => assert.equal(announced(), "Getting ready"));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
  answer({ submissionId: "s1", deduped: false });
  act(() => emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "epoch-1",
    seq: 1,
    type: "entry",
    entry: userEntry("u1", "Plan dinner"),
  }));
  await waitFor(() => assert.equal(document.querySelector("[data-bot-pending-send]"), null));
  assert.equal(screen.getAllByText("Plan dinner").length, 1, "the echo gave way to the entry, not doubled it");
});

test("a send still moving into place keeps its echo when its entry arrives, and settles once it lands", () => {
  const pending = [
    { requestId: "r1", text: "Plan dinner", seen: new Set(["u0"]), at: 0, queued: false, accepted: true },
    { requestId: "r2", text: "Plan lunch", seen: new Set(["u0"]), at: 0, queued: false, accepted: true },
  ];
  const arrived = snapshot({ entries: [userEntry("u0", "Plan dinner"), userEntry("u1", "Plan dinner"), userEntry("u2", "Plan lunch")] });
  assert.deepEqual(
    settleBotPendingSends(pending, arrived, new Set(["r1"])).map((send) => send.requestId),
    ["r1"],
    "the moving send waits; the other settles into its entry",
  );
  assert.deepEqual(settleBotPendingSends(pending, arrived).map((send) => send.requestId), []);
  // An entry that was already on screen when the echo was made never settles it.
  assert.deepEqual(
    settleBotPendingSends(pending.slice(0, 1), snapshot({ entries: [userEntry("u0", "Plan dinner")] })).map((send) => send.requestId),
    ["r1"],
  );
});

/** Lets a send move from the composer, under motion the test finishes itself. */
function installSendMotion(): { land: () => void; restore: () => void } {
  const rect = HTMLTextAreaElement.prototype.getBoundingClientRect;
  const animate = Element.prototype.animate;
  const moving: Animation[] = [];
  HTMLTextAreaElement.prototype.getBoundingClientRect = () => new DOMRect(16, 600, 480, 40);
  Element.prototype.animate = function () {
    const animation = {
      onfinish: null,
      oncancel: null,
      cancel: () => animation.oncancel?.(new Event("cancel") as AnimationPlaybackEvent),
    } as unknown as Animation;
    moving.push(animation);
    return animation;
  };
  return {
    land: () => moving.splice(0).forEach((animation) => animation.onfinish?.(new Event("finish") as AnimationPlaybackEvent)),
    restore: () => {
      HTMLTextAreaElement.prototype.getBoundingClientRect = rect;
      Element.prototype.animate = animate;
    },
  };
}

test("a send moving into place holds its entry until it lands, and a reply that comes first ends the motion above it", async (t) => {
  const motion = installSendMotion();
  t.after(motion.restore);
  await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => ({ submissionId: "s1", deduped: false }),
  });
  const send = async (text: string) => {
    fireEvent.change(await screen.findByPlaceholderText("Ask Planner"), { target: { value: text } });
    fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
    await screen.findByText(text);
    // The copy starts moving on the next frame.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  };
  // The moving copy floats outside the chat, hidden from assistive tech.
  const inChat = (text: string) => screen.queryAllByText(text).filter((node) => !node.closest("[aria-hidden='true']"));
  let seq = 0;
  const arrive = (entry: BotTranscriptEntry) =>
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: ++seq, type: "entry", entry }));

  await send("Plan dinner");
  arrive(userEntry("u1", "Plan dinner"));
  assert.equal(inChat("Plan dinner").length, 1, "the entry waits unseen while the words move");
  assert.ok(inChat("Plan dinner")[0]?.closest("[data-bot-pending-send]"));
  act(() => motion.land());
  await waitFor(() => assert.equal(document.querySelector("[data-bot-pending-send]"), null));
  assert.equal(screen.getAllByText("Plan dinner").length, 1, "once it lands the copy is gone and the entry takes its place");

  await send("Plan lunch");
  arrive(userEntry("u2", "Plan lunch"));
  arrive(assistantEntry("a2", "Soup at noon."));
  await waitFor(() => assert.equal(document.querySelector("[data-bot-pending-send]"), null));
  assert.equal(screen.getAllByText("Plan lunch").length, 1, "the moving copy is gone");
  const message = screen.getByText("Plan lunch");
  const reply = screen.getByText("Soup at noon.");
  assert.ok(
    message.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the message stays above its reply, never below it",
  );
});

test("a send main is slow to accept looks sent and says Getting ready, never Sending…", async () => {
  let answer: (result: unknown) => void = () => undefined;
  await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => new Promise((resolve) => (answer = resolve)),
  });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "Plan dinner" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await screen.findByText("Plan dinner");
  assert.ok((await screen.findAllByText("Getting ready")).length > 0);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(screen.queryByText("Sending…"), null, "a slow send still never says Sending…");
  assert.ok(screen.getAllByText("Getting ready").length > 0, "the status line carries the wait");
  await act(async () => answer({ submissionId: "s1", deduped: false }));
  assert.ok(screen.getByText("Plan dinner"), "the message stays until its entry arrives");
});

test("a message sent while the Bot works shows as Queued at once", async () => {
  await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan Lisbon")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "thinking", startedAt: Date.now() },
      }),
    "bots:send": () => new Promise(() => undefined),
  });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "And Porto" } });
  fireEvent.keyDown(box, { key: "Enter" });
  const echo = await screen.findByText("And Porto");
  assert.ok(echo.closest("[data-bot-queued]"), "it waits for the reply like the Mac's own Queued message");
  assert.ok(screen.getByText("Queued"));
});

test("a Steer sent while the Bot works shows as sent at once, not Queued", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({
        entries: [userEntry("u1", "Plan Lisbon")],
        state: { kind: "running", submissionId: "s1" },
        activity: { phase: "thinking", startedAt: Date.now() },
      }),
    "bots:send": () => new Promise(() => undefined),
  });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "Keep it under 100 euros" } });
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Queue message" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Steer/u }));
  const echo = await screen.findByText("Keep it under 100 euros");
  await waitFor(() =>
    assert.equal((calls.find((call) => call.channel === "bots:send")?.args[0] as { whenBusy?: string }).whenBusy, "steer"),
  );
  assert.ok(echo.closest("[data-bot-pending-send]"), "a steer joins the reply, so it looks sent");
  assert.equal(echo.closest("[data-bot-queued]"), null);
  assert.equal(screen.queryByText("Queued"), null);
});

test("a send that fails takes back Getting ready, and an interrupted card left with the send comes back", async () => {
  const errors = captureErrorToasts();
  try {
    let fail: (error: Error) => void = () => undefined;
    await mountChat({
      "bots:live:subscribe": () => snapshot({ state: { kind: "interrupted", submissionId: "s0" } }),
      "bots:send": () => new Promise((_resolve, reject) => (fail = reject)),
    });
    await screen.findByRole("group", { name: "Planner was interrupted" });
    const box = await screen.findByPlaceholderText("Ask Planner");
    fireEvent.change(box, { target: { value: "Start over" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
    await waitFor(() => assert.equal(announced(), "Getting ready"));
    assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null, "the send replaces the paused turn");
    fail(new Error("Error invoking remote method 'bots:send': Error: Bots are starting."));
    await screen.findByRole("group", { name: "Planner was interrupted" });
    assert.equal(document.querySelector("[data-bot-pending-send]"), null);
    await waitFor(() => assert.equal(announced(), ""));
    // One error, said once.
    await waitFor(() => assert.deepEqual(errors.shown, ["Bots are starting."]));
  } finally {
    errors.restore();
  }
});

test("a send that fails drops its echo, and the same words sent again replay the same request id", async () => {
  let fail = true;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(),
    "bots:send": () => {
      if (fail) throw new Error("Error invoking remote method 'bots:send': Error: Bots are starting.");
      return { submissionId: "s1", deduped: false };
    },
  });
  const box = (await screen.findByPlaceholderText("Ask Planner")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Plan dinner" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
  await waitFor(() => assert.equal(document.querySelector("[data-bot-pending-send]"), null));
  // The composer gave the words back; sending them again is the same request.
  await waitFor(() => assert.equal(box.value, "Plan dinner"));
  fail = false;
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 2));
  const [first, second] = calls.filter((call) => call.channel === "bots:send").map((call) => (call.args[0] as { requestId: string }).requestId);
  assert.equal(first, second);
  // Different words are a new request.
  fireEvent.change(box, { target: { value: "Plan lunch" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 3));
  const third = (calls.filter((call) => call.channel === "bots:send")[2]!.args[0] as { requestId: string }).requestId;
  assert.notEqual(third, first);
});

test("Retry hides the failed card and echoes the message at once, under one request id per failed turn", async () => {
  let fail = true;
  const calls = await mountChat({
    "bots:live:subscribe": () =>
      snapshot({ entries: [userEntry("u1", "Plan dinner"), { id: "a1:failed", type: "failed_turn", retryText: "Plan dinner" }] }),
    "bots:send": () => {
      if (fail) throw new Error("Error invoking remote method 'bots:send': Error: Bots are starting.");
      return { submissionId: "s2", deduped: false };
    },
  });
  const card = await screen.findByRole("group", { name: "Planner couldn’t finish a reply" });
  fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
  assert.equal(screen.queryByRole("group", { name: "Planner couldn’t finish a reply" }), null, "the card leaves on the click");
  assert.ok(document.querySelector("[data-bot-pending-send]"), "the message is echoed");
  // The retry failed: the card is back and the echo is gone.
  const back = await screen.findByRole("group", { name: "Planner couldn’t finish a reply" });
  assert.equal(document.querySelector("[data-bot-pending-send]"), null);
  fail = false;
  fireEvent.click(within(back).getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 2));
  const [first, second] = calls.filter((call) => call.channel === "bots:send").map((call) => (call.args[0] as { requestId: string }).requestId);
  assert.equal(first, second, "the same failed turn retries under one request id");
});


test("Bot questions, replies and saved paused answers show clean labels without Retry", async () => {
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot({entries: [
    {id: "q", type: "bot_message", kind: "request", botId: "j", botName: "Jester", text: "Can you check?"},
    {id: "r", type: "bot_message", kind: "reply", botId: "c", botName: "COS", text: "Checked the calendar."},
    {id: "s", type: "bot_message_status", data: {deliveryId: "d", botId: "c", botName: "COS", outcome: "waiting_approval", summary: "Create 3 events"}},
    {id: "p", type: "bot_message_status", data: {deliveryId: "d", botId: "c", botName: "COS", outcome: "replied_while_paused", text: "Saved answer while paused."}},
    {id: "f", type: "failed_turn", retryText: null},
  ]}) });
  for (const text of ["Jester asked", "Can you check?", "COS replied", "Checked the calendar.", "COS is waiting for you to approve: Create 3 events", "Saved answer while paused."]) assert.ok((await screen.findAllByText(text)).length > 0);
  assert.equal(screen.queryByRole("button", {name: "Retry"}), null);
  assert.equal(calls.some(call => call.channel === "bots:send" || call.channel === "bots:resume"), false);
  const waiting = screen.getByText("COS is waiting for you to approve: Create 3 events");
  assert.equal(waiting.querySelector("button"), null);
});

test("an access request sits above the unchanged composer, preserves failed grants and removes only on host projection", async () => {
  const errors = captureErrorToasts();
  let failure = true;
  try {
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ state: RUNNING, accessRequest: {
        botId: "bot-1", waitId: "access-attempt", toolCallId: "access-call", target: "folder", label: "Taxes",
        place: "~/Documents/Taxes", why: "Prepare your return.", choices: ["not_now", "always", "once"],
      } }),
      "bots:answerAccessRequest": () => {
        if (failure) throw new Error("This Bot's access changed. Ask for access again.");
        return { answered: true };
      },
    });
    const card = await screen.findByRole("group", { name: "Planner wants to use Taxes" });
    const composer = screen.getByPlaceholderText("Ask Planner");
    assert.ok(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING);
    const more = within(card).getByRole("button", { name: "More ways to allow" });
    act(() => {
      more.focus();
      fireEvent.keyDown(more, { key: "Enter" });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Always for this folder/u }));
    await waitFor(() => assert.deepEqual(errors.shown, ["This Bot's access changed. Ask for access again."]));
    assert.equal(screen.getByRole("group", { name: "Planner wants to use Taxes" }), card);
    assert.equal((within(card).getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled, false);
    failure = false;
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:answerAccessRequest").length, 2));
    assert.ok(screen.getByRole("group", { name: "Planner wants to use Taxes" }), "a receipt alone cannot fabricate card removal");
    act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "access_request", accessRequest: null }));
    await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner wants to use Taxes" }), null));
    assert.equal(screen.getByPlaceholderText("Ask Planner"), composer);
  } finally { errors.restore(); }
});

test("a no-longer-waiting access answer shows no success and its fresh host projection removes the old card", async () => {
  const errors = captureErrorToasts();
  try {
    await mountChat({
      "bots:live:subscribe": () => snapshot({ accessRequest: {
        botId: "bot-1", waitId: "old-attempt", toolCallId: "access-call", target: "whole_mac", label: "your whole Mac",
        why: "Find the missing file.", choices: ["not_now", "once"],
      } }),
      "bots:answerAccessRequest": () => ({ answered: false }),
    });
    const card = await screen.findByRole("group", { name: "Planner wants to use your whole Mac" });
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() => assert.deepEqual(errors.shown, ["That card was already answered or closed."]));
    act(() => emitBotTestNotification("bots:live:event", {
      botId: "bot-1", epoch: "epoch-1", seq: 1, type: "snapshot", snapshot: snapshot({ seq: 1, accessRequest: null }),
    }));
    await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner wants to use your whole Mac" }), null));
    screen.getByPlaceholderText("Ask Planner");
  } finally { errors.restore(); }
});

const CHAT_PLAN: BotPlanView = {
  botId: "bot-1", planId: "plan-1", revision: 1, status: "pending", from: "Jester",
  title: "Prepare the team calendar", why: "Keep everyone ready for next week.",
  steps: [{ text: "Create the team event", status: "pending" }],
  items: [{ id: "i1", line: "Google Calendar · create events (up to 5)", details: ["Create an event"], used: 0, max: 5 }],
};

function emitPlan(plan: BotPlanView | null, seq: number) {
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq, type: "plan", plan }));
}

test("a pile-up waits in one Needs-you slot: take control first, then each ask card, then the question, one at a time", async () => {
  let release!: (result: { result: "done" }) => void;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({
      state: RUNNING,
      plan: CHAT_PLAN,
      handoff: BANK_HANDOFF,
      accessRequest: {
        botId: "bot-1", waitId: "access-1", toolCallId: "tool-access", target: "folder", label: "Team",
        place: "~/Documents/Team", why: "Read the brief.", choices: ["not_now", "once"],
      },
      question: { botId: "bot-1", waitId: "wait-q", toolCallId: "tool-q", questions: [COLOUR_QUESTION] },
    }),
    "bots:pendingApprovals": () => [{ botId: "bot-1", waitId: "approval-1", toolCallId: "tool-approval", toolName: "shell", summary: "Run a command" }],
    "bots:plans:respond": () => new Promise((resolve) => { release = resolve; }),
  });
  const slot = () => document.querySelector("[data-needs-you-slot]") as HTMLElement;
  // Take control comes first, and it is the only card above the composer.
  await screen.findByRole("group", { name: "Planner needs you" });
  await waitFor(() => assert.equal(slotPosition(), "1 of 5"));
  const shown = () => [
    ...within(slot()).queryAllByRole("group"),
    ...within(slot()).queryAllByRole("region"),
  ].map((card) => card.getAttribute("aria-label") ?? card.getAttribute("aria-labelledby"));
  assert.deepEqual(shown(), ["Planner needs you"], "one card at a time");
  assert.equal(screen.queryByRole("heading", { name: COLOUR_QUESTION.question }), null, "the question waits its turn");
  const composer = document.querySelector("textarea")!;
  assert.ok(slot().compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING, "the slot sits above the composer");
  assert.equal((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled, true, "a pending plan still gates Send");
  assert.ok(screen.getByText("Answer the plan under Needs you, then send a message."), "the hint doesn't point at a card that isn't on show");

  // Next walks the ask cards in order: the approval, the folder request, the plan.
  const header = screen.getByRole("navigation", { name: "Needs you" });
  fireEvent.click(within(header).getByRole("button", { name: "Next" }));
  assert.ok(await within(slot()).findByRole("region", { name: "Review before Shell" }));
  assert.equal(slotPosition(), "2 of 5");
  assert.equal(within(slot()).queryByRole("group", { name: "Planner needs you" }), null);
  fireEvent.click(within(header).getByRole("button", { name: "Next" }));
  assert.ok(within(slot()).getByRole("group", { name: "Planner wants to use Team" }));
  fireEvent.click(within(header).getByRole("button", { name: "Next" }));
  const plan = within(slot()).getByRole("group", { name: "Jester asked Planner to do this" });
  assert.equal(slotPosition(), "4 of 5");
  assert.ok(screen.getByText("Answer the plan above, then send a message."));
  fireEvent.change(composer, { target: { value: "Do something else" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  assert.equal(calls.some((call) => call.channel === "bots:send" || call.channel === "bots:answerHandoff"), false);
  const approve = within(plan).getByRole("button", { name: "Allow once" });
  fireEvent.click(approve);
  fireEvent.click(approve);
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:plans:respond").length, 1));
  assert.deepEqual(calls.find((call) => call.channel === "bots:plans:respond")!.args, [{ botId: "bot-1", planId: "plan-1", decision: "approve" }]);
  await act(async () => release({ result: "done" }));
  assert.ok(screen.getByRole("group", { name: "Jester asked Planner to do this" }), "a response receipt does not invent plan settlement");

  // Last comes the question, in the composer's place; Previous wraps back round.
  fireEvent.click(within(header).getByRole("button", { name: "Next" }));
  assert.ok(await screen.findByRole("heading", { name: COLOUR_QUESTION.question }));
  assert.equal(slotPosition(), "5 of 5");
  assert.equal(screen.queryByPlaceholderText("Add a note and send to mark it done"), null, "the question takes the composer's place");
  fireEvent.click(within(header).getByRole("button", { name: "Next" }));
  assert.equal(slotPosition(), "1 of 5");
  assert.ok(within(slot()).getByRole("group", { name: "Planner needs you" }));
});

test("a hand-off that arrives while a question is half answered waits behind it: the question and its draft stay on show", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({
      state: RUNNING,
      question: { botId: "bot-1", waitId: "wait-q", toolCallId: "tool-q", questions: [COLOUR_QUESTION] },
    }),
  });
  assert.ok(await screen.findByRole("heading", { name: COLOUR_QUESTION.question }));
  fireEvent.click(screen.getByRole("button", { name: /Type your own answer/u }));
  const draft = screen.getByRole("textbox", { name: `Custom answer for ${COLOUR_QUESTION.question}` });
  fireEvent.change(draft, { target: { value: "Teal, like the logo" } });
  // The Bot hands the person a step; nobody has touched Previous or Next.
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq: 1, type: "handoff", handoff: BANK_HANDOFF }));
  await waitFor(() => assert.equal(slotPosition(), "2 of 2"));
  assert.ok(screen.getByRole("heading", { name: COLOUR_QUESTION.question }), "the question stays on show");
  assert.equal(
    (screen.getByRole("textbox", { name: `Custom answer for ${COLOUR_QUESTION.question}` }) as HTMLTextAreaElement).value,
    "Teal, like the logo",
    "what the person typed survives",
  );
  assert.equal(screen.queryByRole("group", { name: "Planner needs you" }), null, "the hand-off waits its turn");
  fireEvent.click(within(screen.getByRole("navigation", { name: "Needs you" })).getByRole("button", { name: "Previous" }));
  assert.ok(await screen.findByRole("group", { name: "Planner needs you" }));
});

test("when the card on show is answered, the slot goes back to the first item still waiting", async () => {
  await mountChat({
    "bots:live:subscribe": () => snapshot({ state: RUNNING, handoff: BANK_HANDOFF }),
    "bots:pendingApprovals": () => [{ botId: "bot-1", waitId: "approval-1", toolCallId: "tool-approval", toolName: "shell", summary: "Run a command" }],
  });
  await waitFor(() => assert.equal(slotPosition(), "1 of 2"));
  fireEvent.click(within(screen.getByRole("navigation", { name: "Needs you" })).getByRole("button", { name: "Next" }));
  await screen.findByRole("region", { name: "Review before Shell" });
  assert.equal(
    screen.getAllByRole("status").find((node) => node.hasAttribute("data-needs-you-announcement"))?.textContent,
    "Needs you, 2 of 2",
    "a screen reader hears where the slot moved",
  );
  act(() => emitBotTestNotification("bots:approval-settled", { botId: "bot-1", waitId: "approval-1", outcome: "allowed" }));
  assert.ok(await screen.findByRole("group", { name: "Planner needs you" }));
  assert.equal(slotPosition(), null, "one item left: no counter");
});

test("only a pending plan gates the composer; active, ended and cleared host events release it", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ plan: CHAT_PLAN }),
    "bots:send": () => ({ submissionId: "s1", deduped: false }),
  });
  await screen.findByRole("button", { name: "Allow once" });
  assert.equal((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled, true);
  emitPlan({ ...CHAT_PLAN, status: "active", revision: 2, expiresAt: Date.now() + 600_000 }, 1);
  const box = await screen.findByPlaceholderText("Ask Planner") as HTMLTextAreaElement;
  assert.equal(box.disabled, false);
  screen.getByRole("button", { name: "Stop plan" });
  fireEvent.change(box, { target: { value: "A normal message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 1));
  emitPlan({ ...CHAT_PLAN, status: "finished", revision: 3 }, 2);
  await screen.findByText("Plan ended · 0 of 1 steps");
  fireEvent.change(box, { target: { value: "After the plan" } });
  const endedSend = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
  assert.equal(endedSend.disabled, false);
  fireEvent.click(endedSend);
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:send").length, 2));
  emitPlan(null, 3);
  await waitFor(() => assert.equal(screen.queryByText(/Plan ended/u), null));
  assert.equal(box.disabled, false);
});

test("a not_waiting plan answer stays truthful, keeps the card and can be retried after a host failure", async () => {
  let attempts = 0;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ plan: CHAT_PLAN }),
    "bots:plans:respond": () => {
      if (++attempts === 1) return { result: "not_waiting" };
      if (attempts === 2) throw new Error("Error invoking remote method 'bots:plans:respond': Error: Access changed. Ask for a new plan.");
      return { result: "done" };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
  assert.equal((await screen.findByRole("alert")).textContent, "That plan was already answered or closed.");
  const approve = screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement;
  assert.equal(approve.disabled, false);
  fireEvent.click(approve);
  await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "Access changed. Ask for a new plan."));
  assert.equal(approve.disabled, false);
  await act(async () => fireEvent.click(approve));
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(attempts, 3);
  assert.ok(screen.getByRole("button", { name: "Deny" }));
  assert.equal((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled, true);
  assert.equal(calls.some((call) => call.channel === "bots:send"), false);
});

for (const [label, decision, status] of [["Deny", "not_now", "pending"], ["Stop plan", "stop", "active"]] as const) {
  test(`the plan's ${label} forwards the exact IPC decision and waits for the host event`, async () => {
    const calls = await mountChat({
      "bots:live:subscribe": () => snapshot({ plan: { ...CHAT_PLAN, status } }),
      "bots:plans:respond": () => ({ result: "done" }),
    });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: label })));
    assert.deepEqual(calls.filter((call) => call.channel === "bots:plans:respond").map((call) => call.args), [
      [{ botId: "bot-1", planId: "plan-1", decision }],
    ]);
    screen.getByText("Prepare the team calendar");
    emitPlan(null, 1);
    await waitFor(() => assert.equal(screen.queryByText("Prepare the team calendar"), null));
    assert.equal(document.querySelector("textarea")!.disabled, false);
  });
}

test("a repeated approval requests Always truthfully, preserves the draft and Manage opens Settings → Approvals", async (t) => {
  const messages: { message: unknown; options: { action?: { label: string; onClick(): void } } | undefined }[] = [];
  t.mock.method(toast, "success", (message: unknown, options?: unknown) => { messages.push({ message, options: options as typeof messages[number]["options"] }); return "requested"; });
  let release!: (value: { decided: boolean }) => void;
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:live:subscribe": () => snapshot(),
    "bots:pendingApprovals": () => [],
    "bots:approve": () => new Promise((resolve) => { release = resolve; }),
    "bots:allowed:list": () => [],
  });
  const { router } = await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  const box = await screen.findByPlaceholderText("Ask Planner") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Keep this draft" } });
  act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: "always-1", toolCallId: "call-a", toolName: "send_email", summary: "Send the update.", always: { key: "k", count: 3 } }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  within(card).getByText("You’ve allowed this 3 times in the last 2 weeks.");
  const buttons = within(card).getAllByRole("button");
  assert.deepEqual(
    ["Deny", "Allow once", "More ways to allow"].map((name) => buttons.indexOf(within(card).getByRole("button", { name }))),
    [0, 1, 2],
  );
  await chooseBotAlways(card);
  // While it sends, Allow says so and a second answer goes nowhere.
  act(() => {
    within(card).getByRole("button", { name: "Sending…" }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(calls.filter((call) => call.channel === "bots:approve").map((call) => call.args), [[{ waitId: "always-1", decision: "allow", scope: "always" }]]);
  for (const button of within(card).getAllByRole("button")) assert.equal((button as HTMLButtonElement).disabled, true);
  assert.equal(messages.length, 0);
  await act(async () => release({ decided: true }));
  assert.equal(box.value, "Keep this draft");
  assert.equal(messages[0]?.message, "Always allow requested.");
  assert.equal(messages[0]?.options?.action?.label, "Manage");
  assert.ok(!JSON.stringify(messages.map(({ message }) => message)).includes("won’t ask"), "the bridge ACK does not establish persistence");
  act(() => messages[0]!.options!.action!.onClick());
  await waitFor(() => assert.equal(router.state.location.href, "/settings?section=approvals"));
});

test("in Ask, a repeated approval also offers Auto, which saves the Mac's mode through settings", async () => {
  const USABLE = [{ id: "openai", models: ["fast"], hasKey: true, needsKey: true }];
  let saved: unknown;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [],
    "settings:get": () => ({ approvalMode: "ask" }),
    "settings:set": (patch) => { saved = patch; return { approvalMode: "auto" }; },
    "providers:list": () => USABLE,
  });
  act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: "w-1", toolCallId: "call-a", toolName: "send_email", summary: "Send the update.", always: { key: "k", count: 3 }, autoWouldJudge: true }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  const offer = await within(card).findByRole("button", { name: "Switch to Auto" });
  await act(async () => fireEvent.click(offer));
  assert.deepEqual(saved, { approvalMode: "auto" });
  // The card itself is still waiting for an answer: switching answers nothing.
  assert.equal(calls.filter((call) => call.channel === "bots:approve").length, 0);
  // Once in Auto the offer goes.
  await waitFor(() => assert.equal(within(card).queryByRole("button", { name: "Switch to Auto" }), null));
});

test("Auto is offered only for a repeat, only in Ask, only where Auto would judge, and only when a model could", async () => {
  const USABLE = [{ id: "openai", models: ["fast"], hasKey: true, needsKey: true }];
  const cases: Array<[string, { settings: unknown; providers: unknown[]; always: boolean; autoWouldJudge?: false }]> = [
    ["a first-time card", { settings: { approvalMode: "ask" }, providers: USABLE, always: false }],
    ["already in Never ask", { settings: { approvalMode: "never" }, providers: USABLE, always: true }],
    ["already in Auto", { settings: { approvalMode: "auto" }, providers: USABLE, always: true }],
    ["no model that could judge", { settings: { approvalMode: "ask" }, providers: [], always: true }],
    ["only an agent-runtime provider", { settings: { approvalMode: "ask" }, providers: [{ id: "antigravity", models: ["gemini"], hasKey: false, needsKey: false }], always: true }],
    // Main leaves the flag off where Auto would ask too (the Bot's shell, a rule it can't judge, a tainted run).
    ["a card Auto would still show", { settings: { approvalMode: "ask" }, providers: USABLE, always: true, autoWouldJudge: false }],
  ];
  for (const [index, [name, setup]] of cases.entries()) {
    await mountChat({
      "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [],
      "settings:get": () => setup.settings,
      "providers:list": () => setup.providers,
    });
    act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: `wait-${index}`, toolCallId: "call-a", toolName: "send_email", summary: "Send the update.",
      ...(setup.always ? { always: { key: "k", count: 3 } } : {}), ...(setup.autoWouldJudge === false ? {} : { autoWouldJudge: true }) }));
    const card = await screen.findByRole("region", { name: "Review before Send email" });
    // Give settings and providers a chance to land before checking it stayed out.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(within(card).queryByRole("button", { name: "Switch to Auto" }), null, name);
    cleanup();
  }
});

test("Always errors keep the card retryable; a settled old card never returns after a late failure", async () => {
  let reject!: (error: Error) => void;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [],
    "bots:approve": () => new Promise((_resolve, no) => { reject = no; }),
  });
  const prompt = { botId: "bot-1", waitId: "always-old", toolCallId: "call-a", toolName: "send_email", summary: "Old update", always: { key: "k", count: 3 } };
  act(() => emitBotTestNotification("bots:approval", prompt));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  await chooseBotAlways(card);
  await act(async () => reject(new Error("Could not send this answer.")));
  assert.equal((await screen.findByRole("alert")).textContent, "Could not send this answer.");
  const more = within(card).getByRole("button", { name: "More ways to allow" }) as HTMLButtonElement;
  assert.equal(more.disabled, false);
  await chooseBotAlways(card);
  act(() => {
    emitBotTestNotification("bots:approval-settled", { botId: "bot-1", waitId: "always-old", outcome: "allow" });
    emitBotTestNotification("bots:approval", { ...prompt, waitId: "always-new", summary: "New update" });
  });
  await screen.findByText("New update");
  await act(async () => reject(new Error("Old request failed")));
  assert.ok(!screen.queryByText("Old update"));
  assert.ok(!screen.queryByRole("alert"));
  assert.equal((screen.getByRole("button", { name: "More ways to allow" }) as HTMLButtonElement).disabled, false);
  assert.equal(calls.filter((call) => call.channel === "bots:approve").length, 2);
});

test("an unoffered approval has no Always button and Allow sends no scope property", async () => {
  const calls = await mountChat({ "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [], "bots:approve": () => ({ decided: true }) });
  act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: "once-1", toolCallId: "c", toolName: "send_email", summary: "Once only" }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  assert.ok(!within(card).queryByRole("button", { name: "More ways to allow" }));
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Allow once" })));
  assert.deepEqual(calls.find((call) => call.channel === "bots:approve")!.args, [{ waitId: "once-1", decision: "allow" }]);
});

test("a declined bridge ACK never claims Always was requested and keeps the card retryable", async (t) => {
  const messages: unknown[] = [];
  t.mock.method(toast, "success", (message: unknown) => { messages.push(message); return "unused"; });
  await mountChat({
    "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [],
    "bots:approve": () => ({ decided: false }),
  });
  act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: "gone-1", toolCallId: "c", toolName: "send_email", summary: "Changed approval", always: { key: "k", count: 3 } }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  await chooseBotAlways(card);
  assert.equal((await screen.findByRole("alert")).textContent, "That approval was already answered or closed.");
  await waitFor(() => assert.equal((within(card).getByRole("button", { name: "More ways to allow" }) as HTMLButtonElement).disabled, false));
  assert.equal(messages.length, 0);
});

test("the approval keyboard shortcut stays one-time on an offered card, respects drafts and cannot reenter", async () => {
  let release!: (value: { decided: boolean }) => void;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot(), "bots:pendingApprovals": () => [],
    "bots:approve": () => new Promise((resolve) => { release = resolve; }),
  });
  act(() => emitBotTestNotification("bots:approval", { botId: "bot-1", waitId: "keys-1", toolCallId: "c", toolName: "send_email", summary: "An offered approval", always: { key: "k", count: 3 } }));
  const card = await screen.findByRole("region", { name: "Review before Send email" });
  const allow = within(card).getByRole("button", { name: "Allow once" });
  const key = { key: "Enter", ...(allow.getAttribute("aria-keyshortcuts")?.startsWith("Meta") ? { metaKey: true } : { ctrlKey: true }) };
  const box = screen.getByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "An unsent draft" } });
  fireEvent.keyDown(box, key);
  assert.equal(calls.filter((call) => call.channel === "bots:approve").length, 0);
  fireEvent.change(box, { target: { value: "" } });
  act(() => {
    box.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(calls.filter((call) => call.channel === "bots:approve").map((call) => call.args), [[{ waitId: "keys-1", decision: "allow" }]]);
  await act(async () => release({ decided: true }));
});

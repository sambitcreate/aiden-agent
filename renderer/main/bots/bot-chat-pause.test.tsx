import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BotChatRoute } from "../bot-chat-route";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";
import type { BotLiveSnapshot, BotTranscriptEntry } from "../../shared/bot-live";
import type { BotSessionState } from "./bot-session-state";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const PAUSED: BotSessionState = { kind: "paused", since: 1_000, by: "mac" };

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

async function mountChat(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls = installBotTestIpc({ "bots:get": () => botFixture(), ...handlers });
  await mountWithBotRouter(<BotChatRoute botId="bot-1" />, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  return calls;
}

const callsTo = (calls: { channel: string }[], channel: string) => calls.filter((call) => call.channel === channel);

function pushState(seq: number, state: BotSessionState) {
  act(() => emitBotTestNotification("bots:live:event", { botId: "bot-1", epoch: "epoch-1", seq, type: "state", state }));
}

test("a paused Bot's composer says so and won't send; Resume sends one unpause however often it is clicked", async () => {
  let answer: (state: unknown) => void = () => undefined;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: PAUSED }),
    "bots:unpause": () => new Promise((resolve) => (answer = resolve)),
  });
  const card = await screen.findByRole("group", { name: "Planner is paused." });
  assert.ok(screen.getByText("Planner is paused.", { selector: "[role=status]" }), "the composer says why it can't send");

  const composer = screen.getByRole("textbox");
  fireEvent.change(composer, { target: { value: "are you there?" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(callsTo(calls, "bots:send").length, 0, "nothing is sent to a paused Bot");

  const resume = within(card).getByRole("button", { name: "Resume" });
  fireEvent.click(resume);
  fireEvent.click(resume);
  await waitFor(() => assert.equal(callsTo(calls, "bots:unpause").length, 1));
  assert.deepEqual(callsTo(calls, "bots:unpause")[0]!.args, ["bot-1"]);
  fireEvent.click(resume);
  assert.equal(callsTo(calls, "bots:unpause").length, 1, "still one while the first is in flight");

  answer({ kind: "idle" });
  pushState(1, { kind: "idle" });
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner is paused." }), null));
  assert.equal(screen.queryByText("Planner is paused.", { selector: "[role=status]" }), null);
});

test("a reply cut short by the pause shows the interrupted card once the pause is lifted", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { ...PAUSED, interrupted: "s1" } }),
    "bots:unpause": () => ({ kind: "interrupted", submissionId: "s1" }),
    "bots:resume": () => ({ kind: "running", submissionId: "s1" }),
  });
  const paused = await screen.findByRole("group", { name: "Planner is paused." });
  assert.equal(screen.queryByRole("group", { name: "Planner was interrupted" }), null, "Resume and Dismiss wait for the pause");

  fireEvent.click(within(paused).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(callsTo(calls, "bots:unpause").length, 1));
  pushState(1, { kind: "interrupted", submissionId: "s1" });

  const interrupted = await screen.findByRole("group", { name: "Planner was interrupted" });
  assert.equal(screen.queryByRole("group", { name: "Planner is paused." }), null);
  assert.equal(callsTo(calls, "bots:resume").length, 0, "lifting the pause doesn't resume the reply by itself");
  fireEvent.click(within(interrupted).getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.equal(callsTo(calls, "bots:resume").length, 1));
});

test("the chat's ••• menu pauses a running Bot and offers Resume Bot once it is paused", async () => {
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ state: { kind: "running", submissionId: "s1" } }),
    "bots:pause": () => ({ ...PAUSED, interrupted: "s1" }),
    "bots:unpause": () => ({ kind: "interrupted", submissionId: "s1" }),
  });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));
  await waitFor(() => assert.deepEqual(callsTo(calls, "bots:pause").map((call) => call.args), [["bot-1"]]));

  pushState(1, { ...PAUSED, interrupted: "s1" });
  await screen.findByRole("group", { name: "Planner is paused." });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Resume Bot" }));
  await waitFor(() => assert.equal(callsTo(calls, "bots:unpause").length, 1));
});

const SKIPPED: BotTranscriptEntry = {
  id: "n1",
  type: "routines_skipped",
  since: 1_000,
  routines: [
    { routineId: "r-brief", name: "Morning brief", count: 3 },
    { routineId: "r-inbox", name: "Inbox sweep", count: 1 },
  ],
};

test("routines skipped while paused are listed, and Run now runs that one routine once", async () => {
  let fail = true;
  const calls = await mountChat({
    "bots:live:subscribe": () => snapshot({ entries: [SKIPPED] }),
    "bots:routines:runNow": () => {
      if (fail) {
        fail = false;
        throw new Error("Error invoking remote method 'bots:routines:runNow': Error: That routine no longer exists.");
      }
      return { runId: "run-1" };
    },
  });
  const card = await screen.findByRole("group", { name: "2 routines skipped while paused" });
  assert.ok(within(card).getByText("Skipped 3 times"));
  assert.ok(within(card).getByText("Skipped once"));

  const runBrief = within(card).getByRole("button", { name: "Run Morning brief now" });
  fireEvent.click(runBrief);
  await waitFor(() => assert.equal(callsTo(calls, "bots:routines:runNow").length, 1));
  await waitFor(() => assert.equal(runBrief.hasAttribute("disabled"), false), "a failed run leaves Run now available");

  fireEvent.click(runBrief);
  await waitFor(() => assert.ok(within(card).getByText("Started")));
  assert.equal(within(card).queryByRole("button", { name: "Run Morning brief now" }), null);
  assert.ok(within(card).getByRole("button", { name: "Run Inbox sweep now" }), "the other routine is untouched");
  assert.deepEqual(
    callsTo(calls, "bots:routines:runNow").map((call) => call.args[0]),
    [
      { botId: "bot-1", routineId: "r-brief" },
      { botId: "bot-1", routineId: "r-brief" },
    ],
  );
});

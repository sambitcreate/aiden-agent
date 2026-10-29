import { emitBotTestNotification, installBotTestIpc } from "./bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createBotTestQueryClient, mountWithBotRouter } from "./bots/test-providers";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import { detectedKeyboardPlatform } from "../shared/keybindings";
import type { PeerHostView } from "../shared/peer-host";
import type { PeerOperation } from "../shared/peer-operation";
import { RemoteBotChatView } from "./remote-bot-chat-view";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.reduceMotion;
});

const HOST: PeerHostView = {
  id: "host_a",
  name: "Studio",
  enabled: true,
  state: "connected",
  features: ["bot-durable-session-v1", "bot-activity-v1"],
  capabilities: ["chat:read", "chat:write", "bot:read", "bot:write", "bot:activity", "approval:respond"],
};

const SESSION = {
  botId: "bot_1",
  epoch: "e1",
  seq: 3,
  state: "idle",
  interrupted: false,
  entries: [
    { type: "message", id: "m1", role: "user", text: "What is on today?" },
    { type: "message", id: "m2", role: "assistant", text: "Two meetings and a dentist." },
  ],
  hasOlder: false,
  question: null,
  approval: null,
};

function event(seq: number, type: string, payload: unknown) {
  return {
    kind: "event",
    hostId: "host_a",
    botId: "bot_1",
    event: { protocolVersion: 1, botId: "bot_1", epoch: "e1", seq, type, payload },
  };
}

async function mount(host: PeerHostView = HOST, extra: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "remote:peerBotSessionSubscribe": () => ({ subscriptionId: "bot_sub_1", state: "streaming" }),
    "remote:peerBotSessionUnsubscribe": () => true,
    "remote:peerCall": (_hostId, operation) => {
      const { operation: name } = operation as PeerOperation;
      if (name === "botSession") return { ok: true, value: SESSION };
      if (name === "botSend") return { ok: true, value: { submissionId: "s1", deduped: false, state: "running", interrupted: false } };
      if (name === "respondApproval") return { ok: true, value: { approvalId: "w1", decision: "deny", resolvedAt: "2026-10-20T10:00:00.000Z" } };
      return { ok: false, error: { code: "failed", message: `unexpected ${name}` } };
    },
    ...extra,
  });
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), [host]);
  queryClient.setQueryData(hostQueryKeys.feed("host_a"), { bots: [{ id: "bot_1", name: "Planner" }], chats: [], runs: [] });
  await mountWithBotRouter(<RemoteBotChatView hostId="host_a" botId="bot_1" />, { initialPath: "/bots", queryClient });
  const peerCalls = () =>
    calls.filter((call) => call.channel === "remote:peerCall").map((call) => call.args[1] as PeerOperation);
  return { calls, peerCalls };
}

test("a paired Mac's Bot opens its one conversation there and sends to it with a fresh key", async () => {
  const { calls, peerCalls } = await mount();
  assert.ok(await screen.findByText("Two meetings and a dentist."));
  assert.ok(screen.getByText("on Studio"));
  assert.deepEqual(
    calls.find((call) => call.channel === "remote:peerBotSessionSubscribe")?.args,
    ["host_a", "bot_1"],
  );

  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "Move the dentist" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "botSend").length, 1));
  const sent = peerCalls().find((call) => call.operation === "botSend")!;
  assert.equal(sent.resourceId, "bot_1");
  assert.deepEqual(sent.body, { text: "Move the dentist" });
  assert.ok(typeof sent.idempotencyKey === "string" && sent.idempotencyKey.length >= 16);
  // Nothing goes through the workspace chat routes.
  assert.equal(peerCalls().some((call) => call.operation === "createBotChat" || call.operation === "send"), false);
});

test("a send whose acknowledgement was lost keeps the draft and retries with the same key", async () => {
  let sends = 0;
  const { peerCalls } = await mount(HOST, {
    "remote:peerCall": (_hostId, operation) => {
      const { operation: name } = operation as PeerOperation;
      if (name === "botSession") return { ok: true, value: SESSION };
      if (name === "botSend") {
        sends += 1;
        return sends === 1
          ? { ok: false, error: { code: "outcome_unknown", message: "No answer." } }
          : { ok: true, value: { submissionId: "s1", deduped: true, state: "running", interrupted: false } };
      }
      return { ok: false, error: { code: "failed", message: `unexpected ${name}` } };
    },
  });
  const box = (await screen.findByPlaceholderText("Ask Planner")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Move the dentist" } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(sends, 1));
  await waitFor(() => assert.equal(box.value, "Move the dentist"));
  // The Bot starts running meanwhile, so the composer now queues the same draft.
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "state", { state: "running", interrupted: false }));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Queue message" }));
  await waitFor(() => assert.equal(sends, 2));
  const sent = peerCalls().filter((call) => call.operation === "botSend");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey, "the host can tell the retry is the same message");
  assert.deepEqual(sent[1]!.body, sent[0]!.body, "the retry replays the original request");
});

test("Retry on a failed reply from another Mac resends the person's words there, not the failed turn's id", async () => {
  const { peerCalls } = await mount(HOST, {
    "remote:peerCall": (_hostId, operation) => {
      const { operation: name } = operation as PeerOperation;
      if (name === "botSession") {
        return {
          ok: true,
          value: {
            ...SESSION,
            entries: [
              { type: "message", id: "m1", role: "user", text: "Move the dentist" },
              { type: "failed_turn", id: "a1:failed", retryText: "Move the dentist" },
            ],
          },
        };
      }
      if (name === "botSend") return { ok: true, value: { submissionId: "s2", deduped: false, state: "running", interrupted: false } };
      return { ok: false, error: { code: "failed", message: `unexpected ${name}` } };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "botSend").length, 1));
  const sent = peerCalls().find((call) => call.operation === "botSend")!;
  assert.deepEqual(sent.body, { text: "Move the dentist" });
});

test("live frames from the host stream into the chat, and a deny-only approval answers by wait id from the keyboard", async () => {
  // The streaming reveal holds an unfinished line for a second, as long as findByText waits; Reduce Motion shows it at once.
  document.documentElement.dataset.reduceMotion = "true";
  const { peerCalls } = await mount();
  await screen.findByText("Two meetings and a dentist.");
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "state", { state: "running", interrupted: false }));
    emitBotTestNotification("remote:peer-bot-session", event(5, "partial", { text: "Looking at your calendar" }));
    emitBotTestNotification(
      "remote:peer-bot-session",
      event(6, "approval", {
        approval: { waitId: "w1", toolCallId: "t1", toolName: "computer_use", summary: "Open Calendar", canAllow: false },
      }),
    );
  });
  assert.ok(await screen.findByText("Looking at your calendar"));
  assert.ok(screen.getByText("Allow it on Studio."));
  assert.equal(screen.queryByRole("button", { name: "Allow" }), null);
  // ⌘↩ cannot allow from a device that may only deny; ⌘⌫ still denies (Ctrl off a Mac).
  const mac = detectedKeyboardPlatform() === "darwin";
  const allowKey = fireEvent.keyDown(document.body, { key: "Enter", metaKey: mac, ctrlKey: !mac });
  assert.equal(allowKey, true, "the allow key is left alone");
  fireEvent.keyDown(document.body, { key: "Backspace", metaKey: mac, ctrlKey: !mac });
  await waitFor(() => {
    const answer = peerCalls().find((call) => call.operation === "respondApproval");
    assert.equal(answer?.resourceId, "w1");
    assert.deepEqual(answer?.body, { decision: "deny" });
  });
});

const COLOUR_QUESTION = {
  question: "Which colour should the banner use?",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Blue", description: "Calm and cool." },
    { label: "Red", description: "Loud and warm." },
  ],
};

test("a question or approval answered here shows again when the host asks it again under the same wait id", async () => {
  const { peerCalls } = await mount(HOST, {
    "remote:peerCall": (_hostId, raw) => {
      const operation = raw as PeerOperation;
      if (operation.operation === "botSession") return { ok: true, value: { ...SESSION, state: "running" } };
      if (operation.operation === "botAnswerQuestion") return { ok: true, value: { waitId: operation.itemId } };
      if (operation.operation === "respondApproval") {
        return { ok: true, value: { approvalId: operation.resourceId, decision: "deny", resolvedAt: "2026-10-20T10:00:00.000Z" } };
      }
      return { ok: false, error: { code: "failed", message: `unexpected ${operation.operation}` } };
    },
  });
  await screen.findByText("Two meetings and a dentist.");
  const asked = () => document.body.textContent?.includes(COLOUR_QUESTION.question) === true;
  const question = { waitId: "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", toolCallId: "call_q1", questions: [COLOUR_QUESTION] };
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "question", { question }));
  });
  assert.ok(await screen.findByRole("heading", { name: COLOUR_QUESTION.question }));
  fireEvent.click(screen.getByRole("button", { name: /Blue/u }));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "botAnswerQuestion").length, 1));
  await waitFor(() => assert.equal(asked(), false));
  // The host quit before its Bot kept the answer; Resume asks the same question under the same wait id.
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(5, "question", { question: null }));
    // Each frame crosses IPC as a fresh copy.
    emitBotTestNotification("remote:peer-bot-session", event(6, "question", { question: structuredClone(question) }));
  });
  await waitFor(() => assert.equal(asked(), true, "the question asked again can be answered here"));
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(7, "question", { question: null }));
  });

  const approval = { waitId: "w1", toolCallId: "t1", toolName: "computer_use", summary: "Open Calendar", canAllow: false };
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(8, "approval", { approval }));
  });
  fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "respondApproval").length, 1));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Deny" }), null));
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(9, "approval", { approval: null }));
    emitBotTestNotification("remote:peer-bot-session", event(10, "approval", { approval: structuredClone(approval) }));
  });
  assert.ok(await screen.findByRole("button", { name: "Deny" }), "the approval asked again can be answered here");
});

test("a host too old to share its Bots' conversation says so instead of opening a split chat", async () => {
  const { peerCalls } = await mount({ ...HOST, features: [] });
  assert.ok(await screen.findByText("This Bot's chat isn't shared"));
  assert.equal(peerCalls().length, 0);
});

const HANDOFF_HOST: PeerHostView = { ...HOST, capabilities: [...HOST.capabilities, "bot:handoffs"] };

const BANK_HANDOFF = {
  waitId: "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f",
  kind: "action",
  action: "Enter the 2FA code your bank sent you",
  why: "The bank asks for a code only you can see.",
  open: { url: "https://bank.example.com/verify" },
};

/** A host that serves hand-offs; `answer` decides each hand-off answer's outcome. */
async function mountHandoff(
  session: Record<string, unknown>,
  answer: (operation: PeerOperation, attempt: number) => unknown = (operation) => ({ ok: true, value: { waitId: operation.itemId } }),
  extra: Record<string, (...args: unknown[]) => unknown> = {},
) {
  let answers = 0;
  const mounted = await mount(HANDOFF_HOST, {
    "remote:peerCall": (_hostId, raw) => {
      const operation = raw as PeerOperation;
      switch (operation.operation) {
        case "botSession":
          return { ok: true, value: session };
        case "botAnswerHandoff":
          return answer(operation, answers++);
        case "botHandoffOpenOnMac":
          return { ok: true, value: { waitId: operation.itemId, opened: true } };
        case "botPause":
          return { ok: true, value: { state: "paused", interrupted: false } };
        case "botUnpause":
          return { ok: true, value: { state: "idle", interrupted: false } };
        default:
          return { ok: false, error: { code: "failed", message: `unexpected ${operation.operation}` } };
      }
    },
    ...extra,
  });
  return { ...mounted, handoffAnswers: () => mounted.peerCalls().filter((call) => call.operation === "botAnswerHandoff") };
}

const RUNNING_WITH_HANDOFF = { ...SESSION, state: "running", handoff: BANK_HANDOFF };

test("a hand-off from a Bot on another Mac shows its card here, and Done answers it there by wait id", async () => {
  const { handoffAnswers } = await mountHandoff(RUNNING_WITH_HANDOFF);
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  assert.ok(screen.getByText("Your turn: Enter the 2FA code your bank sent you"));
  assert.deepEqual(
    [...card.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ["Open bank.example.com", "Skip", "Done"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(handoffAnswers().length, 1));
  const sent = handoffAnswers()[0]!;
  assert.equal(sent.resourceId, "bot_1");
  assert.equal(sent.itemId, BANK_HANDOFF.waitId);
  assert.deepEqual(sent.body, { outcome: "done" });
  assert.ok(typeof sent.idempotencyKey === "string" && sent.idempotencyKey.length >= 16);
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner needs you" }), null));
});

test("typing while a hand-off waits answers it as done with a note, and Open opens the page on this Mac", async () => {
  const { calls, handoffAnswers } = await mountHandoff(RUNNING_WITH_HANDOFF);
  fireEvent.click(await screen.findByRole("button", { name: "Open bank.example.com" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "browser:open-external")?.args, [BANK_HANDOFF.open.url]),
  );
  const box = await screen.findByPlaceholderText("Add a note and send to mark it done");
  fireEvent.change(box, { target: { value: "  The code was from 9:01.  " } });
  fireEvent.click(await screen.findByRole("button", { name: "Send message" }));
  await waitFor(() => assert.equal(handoffAnswers().length, 1));
  assert.deepEqual(handoffAnswers()[0]!.body, { outcome: "done", note: "The code was from 9:01." });
  // The note answered the card: nothing went to the Bot as a message.
  assert.equal(calls.some((call) => call.channel === "remote:peerCall" && (call.args[1] as PeerOperation).operation === "botSend"), false);
});

test("a card already settled on the other Mac goes away quietly", async () => {
  const expired = await mountHandoff(RUNNING_WITH_HANDOFF, () => ({
    ok: false,
    error: { code: "request_failed", status: 409, remoteCode: "handoff_expired", message: "The other device could not complete this request." },
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  await waitFor(() => assert.equal(expired.handoffAnswers().length, 1));
  assert.deepEqual(expired.handoffAnswers()[0]!.body, { outcome: "skipped" });
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner needs you" }), null));

  // A pause withdrew it; once the turn resumes, the host asks again under the same wait id.
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "handoff", { handoff: null }));
    // Each frame crosses IPC as a fresh copy.
    emitBotTestNotification("remote:peer-bot-session", event(5, "handoff", { handoff: structuredClone(BANK_HANDOFF) }));
  });
  assert.ok(await screen.findByRole("group", { name: "Planner needs you" }), "the card asked again can be answered here");
});

test("a lost hand-off answer is resent under its key", async () => {
  const lost = await mountHandoff(RUNNING_WITH_HANDOFF, (operation, attempt) =>
    attempt === 0 ? { ok: false, error: { code: "outcome_unknown", message: "No answer." } } : { ok: true, value: { waitId: operation.itemId } },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(lost.handoffAnswers().length, 1));
  // The card stays so the person can try again; the retry is the same request to the host.
  const done = await screen.findByRole("button", { name: "Done" });
  await waitFor(() => assert.equal((done as HTMLButtonElement).disabled, false));
  fireEvent.click(done);
  await waitFor(() => assert.equal(lost.handoffAnswers().length, 2));
  const [first, second] = lost.handoffAnswers();
  assert.equal(first!.idempotencyKey, second!.idempotencyKey);
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner needs you" }), null));
});

test("while the card's answer is on its way, Pause finishing first keeps the card waiting and the composer sends no second answer", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { peerCalls, handoffAnswers } = await mountHandoff(RUNNING_WITH_HANDOFF, async (operation) => {
    await held;
    return { ok: true, value: { waitId: operation.itemId } };
  });
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(handoffAnswers().length, 1));
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "botPause").length, 1));
  await act(async () => undefined);
  assert.equal(
    (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled,
    true,
    "the card still waits for its own answer",
  );

  const box = (await screen.findByPlaceholderText("Add a note and send to mark it done")) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Finished on the website." } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await act(async () => undefined);
  assert.equal(handoffAnswers().length, 1, "one card, one answer");
  await waitFor(() => assert.equal(box.value, "Finished on the website.", "the note stays in the composer"));

  await act(async () => {
    release();
  });
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner needs you" }), null));
  assert.equal(handoffAnswers().length, 1);
});

test("a sign-in is finished on the Bot's own Mac: the card offers Finish there and Skip, never Done", async () => {
  const { peerCalls, handoffAnswers } = await mountHandoff({
    ...RUNNING_WITH_HANDOFF,
    handoff: { waitId: "wait-sign-in", kind: "sign_in", action: "Sign in to github.com", open: { url: "https://github.com" } },
  });
  const card = await screen.findByRole("group", { name: "Planner needs you" });
  assert.deepEqual(
    [...card.querySelectorAll("button")].map((button) => button.textContent),
    ["Finish on Studio", "Skip"],
  );
  assert.ok(
    screen.getByText("Finish signing in on Studio, or skip it.", { selector: "[role=status]" }),
    "the composer says why it can't send",
  );
  fireEvent.click(screen.getByRole("button", { name: "Finish on Studio" }));
  await waitFor(() => {
    const finish = peerCalls().find((call) => call.operation === "botHandoffOpenOnMac");
    assert.equal(finish?.itemId, "wait-sign-in");
    assert.ok(typeof finish?.idempotencyKey === "string");
  });
  assert.equal(handoffAnswers().length, 0);
});

test("a password-or-code card from another Mac takes no note: no note box, and Done answers it bare", async () => {
  const { calls, handoffAnswers } = await mountHandoff({
    ...RUNNING_WITH_HANDOFF,
    handoff: { ...BANK_HANDOFF, takesNote: false },
  });
  await screen.findByRole("group", { name: "Planner needs you" });
  assert.equal(screen.queryByPlaceholderText("Add a note and send to mark it done"), null);
  assert.equal(screen.queryByText(/Planner reads any note you send/u), null);
  assert.ok(
    screen.getByText(/This card takes no note, so a password or code never reaches Planner\./u, { selector: "[role=status]" }),
    "the composer says why it can't send",
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => assert.equal(handoffAnswers().length, 1));
  assert.deepEqual(handoffAnswers()[0]!.body, { outcome: "done" });
  assert.equal(calls.some((call) => call.channel === "remote:peerCall" && (call.args[1] as PeerOperation).operation === "botSend"), false);
});

test("a paused Bot on another Mac says so, blocks the composer, and Resume lifts the pause there", async () => {
  const { peerCalls } = await mountHandoff(SESSION);
  await screen.findByText("Two meetings and a dentist.");
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause Bot" }));
  await waitFor(() => assert.equal(peerCalls().filter((call) => call.operation === "botPause").length, 1));
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "state", { state: "paused", interrupted: false }));
  });
  assert.ok(await screen.findByRole("group", { name: "Planner is paused." }));
  assert.ok(screen.getByText("Planner is paused.", { selector: "[role=status]" }), "the composer says why it can't send");
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => {
    const lift = peerCalls().find((call) => call.operation === "botUnpause");
    assert.equal(lift?.resourceId, "bot_1");
    assert.ok(typeof lift?.idempotencyKey === "string");
  });
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(5, "state", { state: "interrupted", interrupted: true }));
  });
  await waitFor(() => assert.equal(screen.queryByRole("group", { name: "Planner is paused." }), null));
  assert.ok(await screen.findByRole("button", { name: "Resume" }), "the turn the pause cut short offers its own Resume");
});

test("a host that does not serve hand-offs to this Mac offers no Pause here", async () => {
  await mount();
  await screen.findByText("Two meetings and a dentist.");
  assert.equal(screen.queryByRole("button", { name: "More for Planner" }), null);
});

test("without the host's activity frames a busy Bot is not offered Queue, so a queued message never goes missing", async () => {
  const { peerCalls } = await mount({ ...HOST, capabilities: HOST.capabilities.filter((grant) => grant !== "bot:activity") });
  await screen.findByText("Two meetings and a dentist.");
  await act(async () => {
    emitBotTestNotification("remote:peer-bot-session", event(4, "state", { state: "running", interrupted: false }));
  });
  const box = await screen.findByPlaceholderText("Ask Planner");
  fireEvent.change(box, { target: { value: "and Friday?" } });
  assert.equal(screen.queryByRole("button", { name: "Queue message" }), null);
  fireEvent.keyDown(box, { key: "Enter" });
  await act(async () => undefined);
  assert.equal(peerCalls().some((call) => call.operation === "botSend"), false, "nothing is sent that this Mac could not show");
});

test("a host that was unpaired while its Bot was open says so, instead of blaming the Bot", async () => {
  installBotTestIpc({
    "remote:peerBotSessionSubscribe": () => ({ subscriptionId: "bot_sub_1", state: "streaming" }),
    "remote:peerBotSessionUnsubscribe": () => true,
    "remote:peerCall": () => ({ ok: false, error: { code: "unavailable", message: "Not paired." } }),
  });
  const queryClient = createBotTestQueryClient();
  queryClient.setQueryData(hostQueryKeys.list(), []);
  await mountWithBotRouter(<RemoteBotChatView hostId="host_a" botId="bot_1" />, { initialPath: "/bots", queryClient });
  assert.ok(await screen.findByText("This device isn't paired anymore"));
  assert.equal(screen.queryByText("Bot not found"), null);
});

import { emitBotTestNotification, installBotTestIpc } from "./bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createBotTestQueryClient, mountWithBotRouter } from "./bots/test-providers";
import { hostQueryKeys } from "../lib/hosts/host-query-keys";
import type { PeerHostView } from "../shared/peer-host";
import type { PeerOperation } from "../shared/peer-operation";
import { RemoteBotChatView } from "./remote-bot-chat-view";

afterEach(cleanup);

const HOST: PeerHostView = {
  id: "host_a",
  name: "Studio",
  enabled: true,
  state: "connected",
  features: ["bot-durable-session-v1", "bot-activity-v1"],
  capabilities: ["chat:read", "chat:write", "bot:read", "bot:write", "approval:respond"],
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

test("live frames from the host stream into the chat, and a deny-only approval answers by wait id", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() => {
    const answer = peerCalls().find((call) => call.operation === "respondApproval");
    assert.equal(answer?.resourceId, "w1");
    assert.deepEqual(answer?.body, { decision: "deny" });
  });
});

test("a host too old to share its Bots' conversation says so instead of opening a split chat", async () => {
  const { peerCalls } = await mount({ ...HOST, features: [] });
  assert.ok(await screen.findByText("This Bot's chat isn't shared"));
  assert.equal(peerCalls().length, 0);
});

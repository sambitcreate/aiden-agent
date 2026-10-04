import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_HOST_ID } from "../../shared/peer-host";
import { ChatSessionControl } from "./chat-session-control";
import { ChatIntentLedger } from "./chat-intent-ledger";
import { LocalHostAdapter, type LocalChatApis } from "./local-host-adapter";

function recordingApis(overrides: Partial<LocalChatApis> = {}) {
  const calls: unknown[][] = [];
  const apis: LocalChatApis = {
    rename: async (...args) => void calls.push(["rename", ...args]),
    remove: async (...args) => void calls.push(["remove", ...args]),
    markRead: async (...args) => {
      calls.push(["markRead", ...args]);
      return true;
    },
    approve: async (...args) => void calls.push(["approve", ...args]),
    answerQuestionnaire: async (...args) => {
      calls.push(["answerQuestionnaire", ...args]);
      return { status: "expired" as const };
    },
    respondRemoteApproval: async (...args) => {
      calls.push(["respondRemoteApproval", ...args]);
      return { resolved: true as const };
    },
    stop: async (...args) => {
      calls.push(["stop", ...args]);
      return false;
    },
    admitRunInput: async (...args) => {
      calls.push(["admitRunInput", ...args]);
      return { admitted: true, queue: "steer" as const, committed: true, messageId: "m9" };
    },
    ...overrides,
  };
  return { apis, calls };
}

test("this Mac is always online and offers its local panels", () => {
  const adapter = new LocalHostAdapter(recordingApis().apis);
  assert.equal(adapter.hostId, LOCAL_HOST_ID);
  assert.equal(adapter.status().availability, "online");
  for (const capability of ["send", "cancel", "respondApproval", "answerQuestion", "steer", "rename", "remove", "localPanels"] as const) {
    assert.ok(adapter.capabilities().has(capability), capability);
  }
});

test("local control goes to this Mac's chat APIs with the pane's arguments", async () => {
  const { apis, calls } = recordingApis();
  const adapter = new LocalHostAdapter(apis);
  const session = new ChatSessionControl(adapter, { hostId: LOCAL_HOST_ID, chatId: "c1" }, new ChatIntentLedger());
  session.attach();

  await session.rename("Renamed");
  assert.equal(await session.cancel("stream-1"), false, "the stop result is the local one");
  assert.deepEqual(await session.submitInput("stream-1", "steer", "Use tables"), {
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "m9",
  });
  await session.respondApproval({ approvalId: "a1", decision: "allow", formFillExcludedOrders: [2] });
  await session.respondApproval({ approvalId: "a2", decision: "deny" });
  const answer = await session.answerQuestion({
    promptId: "q1",
    response: { version: 1, promptId: "q1", cancelled: false, answers: [{ questionIndex: 0, kind: "custom", answer: "Yes" }] },
  });
  assert.equal(answer?.status, "expired");
  await session.remove();

  assert.deepEqual(calls, [
    ["rename", "c1", "Renamed"],
    ["stop", "stream-1"],
    ["admitRunInput", "stream-1", { mode: "steer", text: "Use tables" }],
    ["approve", "a1", "allow", { formFillExcludedOrders: [2] }],
    ["approve", "a2", "deny", undefined],
    [
      "answerQuestionnaire",
      "q1",
      { version: 1, promptId: "q1", cancelled: false, answers: [{ questionIndex: 0, kind: "custom", answer: "Yes" }] },
    ],
    ["remove", "c1"],
  ]);
});

test("a prompt from a turn this Mac hosts for a phone resolves through the Remote service", async () => {
  const { apis, calls } = recordingApis();
  const adapter = new LocalHostAdapter(apis);
  await adapter.respondApproval("c1", { approvalId: "a1", decision: "allow", scope: "chat", source: "remote" });
  await adapter.respondApproval("c1", { approvalId: "a2", decision: "deny", scope: "chat", source: "remote" });
  assert.deepEqual(calls, [
    ["respondRemoteApproval", "c1", "a1", "allow", "chat"],
    ["respondRemoteApproval", "c1", "a2", "deny", undefined],
  ]);
});

test("local failures reach the pane unchanged", async () => {
  const { apis } = recordingApis({
    approve: async () => {
      throw new Error("That approval is no longer pending.");
    },
  });
  const adapter = new LocalHostAdapter(apis);
  await assert.rejects(adapter.respondApproval("c1", { approvalId: "a1", decision: "allow" }), {
    message: "That approval is no longer pending.",
  });
});

test("local turns never go through the host send path", async () => {
  const { apis, calls } = recordingApis();
  await assert.rejects(new LocalHostAdapter(apis).send("c1", { text: "Hi", idempotencyKey: "aiden-0000000000000000" }), {
    code: "unsupported",
  });
  assert.deepEqual(calls, []);
});

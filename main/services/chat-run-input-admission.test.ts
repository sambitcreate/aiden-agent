import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatRunInputAdmission,
  type ChatRunInputGenerationRef,
} from "./chat-run-input-admission.js";
import { AidenOperationUnknownOutcomeError } from "./aiden-remote-operation-contract.js";
import { AppendReconciliationRequiredError } from "./chat-append-commit.js";
import type { Chat } from "./types.js";

interface AgentStub {
  queueAdmissionBlocked(): "not-active" | "cancelled" | "capacity" | undefined;
  queueSteer(message: unknown): { accepted: boolean; queue?: string; reason?: string };
  queueFollowUp(message: unknown): { accepted: boolean; queue?: string; reason?: string };
}

function fixture() {
  const appended: Array<{ chatId: string; message: unknown; meta: unknown }> = [];
  const steered: unknown[] = [];
  const followedUp: unknown[] = [];
  let probeResult: "not-active" | "cancelled" | "capacity" | undefined;
  let steerReceipt: { accepted: true; queue: "steer" | "follow-up" } | { accepted: false; reason: "not-active" | "cancelled" | "invalid-message" | "capacity" } = { accepted: true, queue: "steer" };
  let followUpReceipt: typeof steerReceipt = { accepted: true, queue: "follow-up" };
  let appendError: unknown;
  let readChatResult: Chat | null = null;
  let duringAppend: (() => void) | undefined;
  let afterAppend: (() => void) | undefined;
  const active = new Map<string, ChatRunInputGenerationRef>();
  const generation: ChatRunInputGenerationRef = {
    chatId: "chat-1",
    owner: { documentId: "doc-1" },
    cancelRequested: false,
    agent: {
      queueAdmissionBlocked: () => probeResult,
      queueSteer: (message) => {
        steered.push(message);
        return steerReceipt as never;
      },
      queueFollowUp: (message) => {
        followedUp.push(message);
        return followUpReceipt as never;
      },
    } as AgentStub as ChatRunInputGenerationRef["agent"],
  };
  active.set("stream-1", generation);
  const deleting = new Set<string>();
  const admission = createChatRunInputAdmission({
    active,
    isChatDeleting: (chatId) => deleting.has(chatId),
    appendMessage: async (chatId, message, meta) => {
      duringAppend?.();
      if (meta?.isCurrent && !meta.isCurrent()) {
        throw new Error("The renderer document is no longer active.");
      }
      if (appendError) throw appendError;
      appended.push({ chatId, message, meta });
      afterAppend?.();
      return { id: chatId, messages: [] } as unknown as Chat;
    },
    readChat: async () => readChatResult,
    now: () => 7_777,
    newMessageId: () => "message_admitted_1",
  });
  return {
    admission,
    active,
    generation,
    deleting,
    appended,
    steered,
    followedUp,
    setProbe: (value: typeof probeResult) => {
      probeResult = value;
    },
    setSteerReceipt: (value: typeof steerReceipt) => {
      steerReceipt = value;
    },
    setFollowUpReceipt: (value: typeof followUpReceipt) => {
      followUpReceipt = value;
    },
    setAppendError: (value: unknown) => {
      appendError = value;
    },
    setReadChatResult: (value: Chat | null) => {
      readChatResult = value;
    },
    setDuringAppend: (hook: (() => void) | undefined) => {
      duringAppend = hook;
    },
    setAfterAppend: (hook: (() => void) | undefined) => {
      afterAppend = hook;
    },
  };
}

test("run input admission persists the user message before admitting a steer", async () => {
  const app = fixture();
  const result = await app.admission.admit({
    streamId: "stream-1",
    chatId: "chat-1",
    mode: "steer",
    text: "Steer now",
    ownerDocumentId: "doc-1",
  });
  assert.deepEqual(result, {
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.appended.length, 1);
  assert.equal(app.appended[0]!.chatId, "chat-1");
  assert.deepEqual(app.appended[0]!.message, {
    id: "message_admitted_1",
    role: "user",
    content: "Steer now",
  });
  assert.deepEqual(app.steered, [
    { role: "user", content: "Steer now", timestamp: 7_777 },
  ]);
  assert.equal(app.followedUp.length, 0);
});

test("run input admission routes queue mode to the follow-up queue", async () => {
  const app = fixture();
  const result = await app.admission.admit({
    streamId: "stream-1",
    chatId: "chat-1",
    mode: "queue",
    text: "Follow up later",
  });
  assert.deepEqual(result, {
    admitted: true,
    queue: "follow-up",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.followedUp.length, 1);
  assert.equal(app.steered.length, 0);
});

test("run input admission rejects unknown, foreign, and mismatched streams without consuming the draft", async () => {
  const app = fixture();
  for (const input of [
    { streamId: "stream-missing", mode: "steer" as const, text: "x" },
    { streamId: "stream-1", chatId: "chat-2", mode: "steer" as const, text: "x" },
    {
      streamId: "stream-1",
      chatId: "chat-1",
      mode: "steer" as const,
      text: "x",
      ownerDocumentId: "doc-2",
    },
  ]) {
    const result = await app.admission.admit(input);
    assert.deepEqual(result, {
      admitted: false,
      reason: "run_not_active",
      committed: false,
    });
  }
  assert.equal(app.appended.length, 0);
  assert.equal(app.steered.length, 0);
});

test("run input admission rejects cancelled and deleting runs without consuming the draft", async () => {
  const app = fixture();
  app.generation.cancelRequested = true;
  const cancelled = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "x",
  });
  assert.deepEqual(cancelled, { admitted: false, reason: "cancelled", committed: false });

  app.generation.cancelRequested = false;
  app.deleting.add("chat-1");
  const deleting = await app.admission.admit({
    streamId: "stream-1",
    mode: "queue",
    text: "x",
  });
  assert.deepEqual(deleting, { admitted: false, reason: "cancelled", committed: false });
  assert.equal(app.appended.length, 0);
});

test("run input admission rejects a closed or full queue before persistence", async () => {
  const app = fixture();
  app.setProbe("capacity");
  const capacity = await app.admission.admit({
    streamId: "stream-1",
    mode: "queue",
    text: "x",
  });
  assert.deepEqual(capacity, { admitted: false, reason: "capacity", committed: false });

  app.setProbe("not-active");
  const inactive = await app.admission.admit({
    streamId: "stream-1",
    mode: "queue",
    text: "x",
  });
  assert.deepEqual(inactive, {
    admitted: false,
    reason: "run_not_active",
    committed: false,
  });
  assert.equal(app.appended.length, 0);
});

test("run input admission keeps a committed message when the run ends between persistence and admission", async () => {
  const app = fixture();
  app.setAfterAppend(() => {
    app.active.delete("stream-1");
  });
  const evicted = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "late steer",
  });
  assert.deepEqual(evicted, {
    admitted: false,
    reason: "run_not_active",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.appended.length, 1);
  assert.equal(app.steered.length, 0);
});

test("run input admission reports committed-but-rejected when the queue closes during persistence", async () => {
  const app = fixture();
  app.setDuringAppend(() => {
    app.setSteerReceipt({ accepted: false, reason: "cancelled" });
  });
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "racing stop",
  });
  assert.deepEqual(result, {
    admitted: false,
    reason: "cancelled",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.appended.length, 1);
  assert.equal(app.steered.length, 1);
});

test("run input admission reports committed-but-capacity when the queue fills during persistence", async () => {
  const app = fixture();
  app.setDuringAppend(() => {
    app.setSteerReceipt({ accepted: false, reason: "capacity" });
  });
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "racing capacity",
  });
  assert.deepEqual(result, {
    admitted: false,
    reason: "capacity",
    committed: true,
    messageId: "message_admitted_1",
  });
});

test("run input admission maps the isCurrent cancel race to cancelled without committing", async () => {
  const app = fixture();
  app.setDuringAppend(() => {
    app.generation.cancelRequested = true;
  });
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "cancel during append",
  });
  assert.deepEqual(result, { admitted: false, reason: "cancelled", committed: false });
  assert.equal(app.appended.length, 0);
  assert.equal(app.steered.length, 0);
});

test("run input admission rejects uncommitted store failures without consuming the draft", async () => {
  const app = fixture();
  app.setAppendError(new Error("disk full"));
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "queue",
    text: "x",
  });
  assert.deepEqual(result, {
    admitted: false,
    reason: "run_not_active",
    committed: false,
  });
});

test("run input admission escalates uncertain persistence to an unknown outcome", async () => {
  const app = fixture();
  app.setAppendError(new AppendReconciliationRequiredError());
  await assert.rejects(
    app.admission.admit({ streamId: "stream-1", mode: "steer", text: "x" }),
    AidenOperationUnknownOutcomeError,
  );
});

test("run input admission proceeds when recovery proves the append committed", async () => {
  const app = fixture();
  app.setAppendError(new Error("flaky durability write"));
  app.setReadChatResult({
    id: "chat-1",
    messages: [{ id: "message_admitted_1", role: "user", content: "Steer now" }],
  } as unknown as Chat);
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "steer",
    text: "Steer now",
    ownerDocumentId: "doc-1",
  });
  assert.deepEqual(result, {
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.steered.length, 1);
});

test("run input admission reports committed cancellation when the run is cancelled during persistence", async () => {
  const app = fixture();
  app.setAfterAppend(() => {
    app.generation.cancelRequested = true;
  });
  const result = await app.admission.admit({
    streamId: "stream-1",
    mode: "queue",
    text: "queued too late",
  });
  assert.deepEqual(result, {
    admitted: false,
    reason: "cancelled",
    committed: true,
    messageId: "message_admitted_1",
  });
  assert.equal(app.appended.length, 1);
  assert.equal(app.followedUp.length, 0);
});

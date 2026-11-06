import assert from "node:assert/strict";
import test from "node:test";
import { createLiveChatController, type LiveChatPaneState } from "./live-chat-controller";
import type { ChatRunInputAdmissionResult } from "../shared/chat-run-input";

function pane(overrides: Partial<LiveChatPaneState> = {}) {
  const calls: string[] = [];
  const errors: string[] = [];
  let steerReceipt: ChatRunInputAdmissionResult | null = {
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "m1",
  };
  const state: LiveChatPaneState = {
    chatId: "chat-1",
    workspaceId: "ws-1",
    isDraft: false,
    title: "Fix login",
    messages: [
      { id: "u1", role: "user", content: "Fix the login bug", createdAt: 1 },
      { id: "a1", role: "assistant", content: "Fixed it.", createdAt: 2 },
    ],
    busy: false,
    steerAvailable: false,
    queueAvailable: true,
    hasQueued: false,
    ready: true,
    firstSending: false,
    waitingForApproval: false,
    send: async (text) => void calls.push(`send:${text}`),
    queue: async (text) => void calls.push(`queue:${text}`),
    steer: async (text) => {
      calls.push(`steer:${text}`);
      return steerReceipt;
    },
    stop: () => {
      calls.push("stop");
      return true;
    },
    showError: (message) => void errors.push(message),
    ...overrides,
  };
  const controller = createLiveChatController(() => state);
  return {
    controller,
    calls,
    errors,
    state,
    setSteerReceipt: (receipt: ChatRunInputAdmissionResult | null) => (steerReceipt = receipt),
  };
}

test("auto sends now in an idle chat through the composer's send", async () => {
  const { controller, calls } = pane();
  assert.deepEqual(await controller.send("Also check the reset page", "auto"), {
    ok: true,
    status: "sent",
    title: "Fix login",
  });
  assert.deepEqual(calls, ["send:Also check the reset page"]);
});

test("auto steers a working chat and reports what the run did with it", async () => {
  const working = pane({ busy: true, steerAvailable: true });
  assert.equal((await working.controller.send("Use staging", "auto")).status, "steered");
  assert.deepEqual(working.calls, ["steer:Use staging"]);

  working.setSteerReceipt({ admitted: false, committed: true, reason: "run_not_active", messageId: "m2" });
  assert.equal((await working.controller.send("Too late", "steer")).status, "saved_not_read");

  working.setSteerReceipt({ admitted: false, committed: false, reason: "capacity" });
  const refused = await working.controller.send("More", "steer");
  assert.equal(refused.ok, false);
  assert.equal((refused.error as { code: string }).code, "steer_rejected");

  working.setSteerReceipt(null);
  assert.equal(((await working.controller.send("Ended", "steer")).error as { code: string }).code, "cannot_steer");
});

test("a chat that isn't ready, or whose first message is saving, sends nothing", async () => {
  for (const overrides of [{ ready: false }, { firstSending: true }]) {
    const { controller, calls } = pane(overrides);
    const result = await controller.send("Hello", "auto");
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  }
});

test("a send that fails is reported with a fixed message and shown in the window", async () => {
  const { controller, errors } = pane({
    send: async () => {
      throw new Error("Wait for the previous response to finish saving before sending again.");
    },
  });
  assert.deepEqual(await controller.send("Hello", "auto"), {
    ok: false,
    error: { code: "send_failed", message: "Aiden couldn't send the message." },
  });
  assert.deepEqual(errors, ["Wait for the previous response to finish saving before sending again."]);
});

test("queue mode on a working chat queues behind the reply", async () => {
  const { controller, calls } = pane({ busy: true, steerAvailable: true });
  assert.equal((await controller.send("After that, run lint", "queue")).status, "queued");
  assert.deepEqual(calls, ["queue:After that, run lint"]);
});

test("stop is the composer's Stop, and says when nothing is running", () => {
  const idle = pane();
  assert.equal((idle.controller.stop().error as { code: string }).code, "nothing_running");
  assert.deepEqual(idle.calls, []);
  const working = pane({ busy: true });
  assert.deepEqual(working.controller.stop(), { ok: true, status: "stopping", title: "Fix login" });
  assert.deepEqual(working.calls, ["stop"]);
  const starting = pane({ busy: true, stop: () => false });
  assert.equal((starting.controller.stop().error as { code: string }).code, "cannot_stop");
});

test("read reports title, busy, a waiting approval and the bounded transcript", () => {
  const { controller } = pane({ busy: true, waitingForApproval: true });
  assert.deepEqual(controller.read(1), {
    title: "Fix login",
    busy: true,
    waitingForApproval: true,
    messages: [{ role: "assistant", text: "Fixed it." }],
    truncated: true,
  });
});

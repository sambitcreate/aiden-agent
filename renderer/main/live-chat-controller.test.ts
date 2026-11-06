import assert from "node:assert/strict";
import test from "node:test";
import "./bots/test-dom";
import { cleanup, renderHook } from "@testing-library/react";
import {
  createLiveChatController,
  liveChatReachable,
  stopForLive,
  useLiveChatController,
  type LiveChatPaneState,
} from "./live-chat-controller";
import { liveChatControl } from "../lib/live-chat-control";
import type { ChatRunInputAdmissionResult } from "../shared/chat-run-input";
import { appendReconciliationFailureMessage } from "../shared/chat-message-contract";
import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";

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
    reachable: true,
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
    queuePaused: false,
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
  const queued = pane({ busy: true, hasQueued: true });
  assert.deepEqual(queued.controller.stop(), { ok: true, status: "stopping", title: "Fix login", queuePaused: true });
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

test("Live's Stop pauses the queue only when the composer's Stop really stopped something", () => {
  for (const stopped of [true, false]) {
    const log: string[] = [];
    const result = stopForLive({
      stop: () => {
        log.push("stop");
        return stopped;
      },
      pauseQueue: () => log.push("pause"),
      markStopRequested: () => log.push("stopping"),
    });
    assert.equal(result, stopped);
    assert.deepEqual(log, stopped ? ["stop", "stopping", "pause"] : ["stop"]);
  }
});

test("a paused queue is never fed: Live refuses instead of leaving the message waiting unseen", async () => {
  const idleWithQueue = pane({ hasQueued: true, queuePaused: true });
  const result = await idleWithQueue.controller.send("Next step", "auto");
  assert.equal((result.error as { code: string }).code, "queue_paused");
  const busy = pane({ busy: true, queuePaused: true });
  assert.equal(((await busy.controller.send("Later", "queue")).error as { code: string }).code, "queue_paused");
  assert.deepEqual([...idleWithQueue.calls, ...busy.calls], []);
  // An idle chat with nothing queued still sends directly.
  const idle = pane({ queuePaused: true });
  assert.equal((await idle.controller.send("Hi", "auto")).status, "sent");
});

test("an unconfirmed send or steer is outcome_unknown, so Live never resends it", async () => {
  const send = pane({
    send: async () => {
      throw new Error(`Error invoking remote method: ${appendReconciliationFailureMessage("current")}`);
    },
  });
  const sent = await send.controller.send("Hello", "auto");
  assert.equal((sent.error as { code: string }).code, "outcome_unknown");
  assert.match((sent.error as { message: string }).message, /do not resend/u);
  assert.equal(send.errors.length, 1);
  const steer = pane({
    busy: true,
    steerAvailable: true,
    steer: async () => {
      throw new Error("lost");
    },
  });
  const steered = await steer.controller.send("Use staging", "auto");
  assert.equal((steered.error as { code: string }).code, "outcome_unknown");
  assert.match((steered.error as { message: string }).message, /couldn't confirm the guidance/u);
});

test("only a loaded regular chat is reachable: never Bot, Assistant or feature chats", () => {
  assert.equal(liveChatReachable(undefined), false, "not loaded yet");
  assert.equal(liveChatReachable(null), false);
  assert.equal(liveChatReachable({ workspaceId: "ws-1" }), true);
  assert.equal(liveChatReachable({ workspaceId: "ws-1", botId: "bot-1" }), false);
  assert.equal(liveChatReachable({ workspaceId: ASSISTANT_WORKSPACE_ID }), false);
  assert.equal(liveChatReachable({ workspaceId: "ws-1", owner: { kind: "design-project", projectId: "p1" } }), false);
});

test("the pane registers its controller only while its chat is reachable", () => {
  const base = pane().state;
  const { rerender, unmount } = renderHook((state: LiveChatPaneState) => useLiveChatController(state), {
    initialProps: { ...base, reachable: false },
  });
  assert.equal(liveChatControl.current(), null, "a Bot chat or an unloaded chat has no controller");
  rerender({ ...base, reachable: true });
  assert.equal(liveChatControl.current()?.chatId, "chat-1");
  rerender({ ...base, reachable: false });
  assert.equal(liveChatControl.current(), null);
  rerender({ ...base, reachable: true });
  unmount();
  assert.equal(liveChatControl.current(), null);
  cleanup();
});

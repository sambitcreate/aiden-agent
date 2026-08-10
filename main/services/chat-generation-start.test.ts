import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitUserStop } from "./chat-cancel.js";
import { startGenerationAndMaybeTitle } from "./chat-generation-start.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";
import type { ChatStartParams } from "./types.js";

const params: ChatStartParams = {
  chatId: "chat-1",
  workspaceId: "workspace-1",
  providerId: "openai-codex",
  model: "gpt-5.4",
  messages: [{ role: "user", content: "Help me" }],
};

test("does not start title generation when chat initialization was cancelled", async () => {
  let titleStarts = 0;
  const started = await startGenerationAndMaybeTitle(
    {
      start: async () => false,
      startTitle: () => {
        titleStarts += 1;
      },
    },
    "stream-1",
    params,
  );

  assert.equal(started, false);
  assert.equal(titleStarts, 0);
});

test("starts one title request only after chat initialization succeeds", async () => {
  const titleInputs: Array<{ chatId: string; providerId: string; model: string }> = [];
  const started = await startGenerationAndMaybeTitle(
    {
      start: async () => true,
      startTitle: (input) => titleInputs.push(input),
    },
    "stream-1",
    params,
  );

  assert.equal(started, true);
  assert.deepEqual(titleInputs, [
    { chatId: "chat-1", providerId: "openai-codex", model: "gpt-5.4" },
  ]);
});

test("only an explicit visible user Stop origin is acceptance evidence", () => {
  assert.equal(isExplicitUserStop("user_stop"), true);
  for (const origin of ["lifecycle", "navigation", "unmount", "stop", "", null, undefined]) {
    assert.equal(isExplicitUserStop(origin), false);
  }
});

test("rapid A to B to A navigation cannot append a newer user turn while A drains", () => {
  const admission = new ChatTurnAdmission();
  const messages = ["user-1"];
  let generationBusy = true;
  const appendUser = (message: string): boolean => {
    const turn = admission.tryBegin("chat-a", message, "renderer", generationBusy);
    if (!turn) return false;
    try {
      messages.push(message);
      return true;
    } finally {
      turn.release();
      turn.settleAsyncWork();
    }
  };

  // Lifecycle cancellation detaches the renderer, but main still owns the
  // generation until its terminal assistant response crosses durability.
  assert.equal(appendUser("user-2"), false);
  assert.deepEqual(messages, ["user-1"]);

  messages.push("assistant-1");
  generationBusy = false;
  assert.equal(appendUser("user-2"), true);
  assert.deepEqual(messages, ["user-1", "assistant-1", "user-2"]);

  // Once terminal persistence settles, one renderer append owns the chat
  // synchronously and both another append and generation start stay closed.
  const append = admission.tryBegin("chat-a", "turn-3", "renderer", false);
  assert.ok(append);
  assert.equal(admission.isAdmitted("chat-a"), true);
  assert.equal(admission.tryBegin("chat-a", "turn-4", "scheduler", false), null);
  assert.equal(admission.isAdmitted("chat-b"), false);

  append.release();
  append.settleAsyncWork();
  append.release();
  assert.equal(admission.isAdmitted("chat-a"), false);
  assert.ok(admission.tryBegin("chat-a", "turn-4", "scheduler", false));
});

test("turn lease hands off only to the exact owner after generation is registered", () => {
  const admission = new ChatTurnAdmission();
  const lease = admission.tryBegin("chat-a", "turn-1", "renderer-document-1", false);
  assert.ok(lease);
  const events: string[] = [];
  lease.settleAsyncWork();

  assert.equal(
    admission.handoff("chat-a", "wrong-turn", "renderer-document-1", () => {
      events.push("stolen");
    }),
    false,
  );
  assert.equal(admission.releaseMatching("chat-a", "turn-1", "renderer-document-2"), false);
  assert.equal(admission.isAdmitted("chat-a"), true);

  assert.equal(
    admission.handoff("chat-a", "turn-1", "renderer-document-1", () => {
      assert.equal(admission.isAdmitted("chat-a"), true);
      events.push("generation-registered");
    }),
    true,
  );
  assert.deepEqual(events, ["generation-registered"]);
  assert.equal(admission.isAdmitted("chat-a"), false);
});

test("renderer and scheduler turns cannot interleave or orphan their transcript order", () => {
  const admission = new ChatTurnAdmission();
  const messages: string[] = [];
  let generationBusy = false;

  const renderer = admission.tryBegin("chat-a", "renderer-1", "renderer-document", generationBusy);
  assert.ok(renderer);
  messages.push("renderer-user");
  renderer.settleAsyncWork();
  assert.equal(admission.tryBegin("chat-a", "schedule-1", "scheduled-owner", generationBusy), null);

  assert.equal(
    admission.handoff("chat-a", "renderer-1", "renderer-document", () => {
      generationBusy = true;
    }),
    true,
  );
  assert.equal(admission.tryBegin("chat-a", "schedule-1", "scheduled-owner", generationBusy), null);
  messages.push("renderer-assistant");
  generationBusy = false;

  const scheduled = admission.tryBegin("chat-a", "schedule-1", "scheduled-owner", generationBusy);
  assert.ok(scheduled);
  messages.push("scheduled-output");
  scheduled.release();
  scheduled.settleAsyncWork();
  assert.deepEqual(messages, ["renderer-user", "renderer-assistant", "scheduled-output"]);
});

test("throwing generation registration fails closed until the owner releases", () => {
  const admission = new ChatTurnAdmission();
  const lease = admission.tryBegin("chat-a", "turn-1", "renderer", false);
  assert.ok(lease);
  lease.settleAsyncWork();
  assert.throws(
    () =>
      admission.handoff("chat-a", "turn-1", "renderer", () => {
        throw new Error("registration failed");
      }),
    /registration failed/u,
  );
  assert.equal(admission.isAdmitted("chat-a"), true);
  lease.release();
  assert.equal(admission.isAdmitted("chat-a"), false);
});

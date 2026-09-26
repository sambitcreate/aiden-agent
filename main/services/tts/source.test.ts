import assert from "node:assert/strict";
import test from "node:test";
import {
  computeTtsSourceRevision,
  revalidateTtsSource,
  resolveLatestTtsSource,
  type TtsStoredMessage,
} from "./source.js";

interface Fixture {
  busy?: boolean;
  missing?: boolean;
  messages: TtsStoredMessage[];
}

function deps(fixture: Fixture) {
  return {
    getChat: async () => (fixture.missing ? null : { messages: fixture.messages }),
    isChatBusy: () => fixture.busy === true,
  };
}

function assistant(id: string, content: string, providerFailure?: unknown): TtsStoredMessage {
  return { id, role: "assistant", content, providerFailure };
}

function user(id: string, content = "?"): TtsStoredMessage {
  return { id, role: "user", content };
}

test("resolves the last assistant message after the latest user turn", async () => {
  const messages = [
    user("u1"),
    assistant("a1", "Old answer"),
    user("u2"),
    assistant("a2", "Newest answer"),
  ];
  const result = await resolveLatestTtsSource(deps({ messages }), "chat-1");
  assert.equal(result.reason, "ok");
  assert.ok(result.source);
  assert.equal(result.source!.messageId, "a2");
  assert.equal(result.source!.chatId, "chat-1");
  assert.match(result.source!.sourceRevision, /^[0-9a-f]{32}$/u);
});

test("does not scan backward past a newer failed response", async () => {
  const messages = [
    user("u1"),
    assistant("a1", "Older success"),
    user("u2"),
    assistant("a2", "", { category: "provider_error" }),
  ];
  const result = await resolveLatestTtsSource(deps({ messages }), "chat-1");
  assert.equal(result.reason, "failed");
  assert.equal(result.source, null);
});

test("tool-only or empty newest responses are not eligible", async () => {
  const empty = await resolveLatestTtsSource(
    deps({ messages: [user("u1"), assistant("a1", "   ")] }),
    "chat-1",
  );
  assert.equal(empty.reason, "empty");

  const none = await resolveLatestTtsSource(deps({ messages: [user("u1")] }), "chat-1");
  assert.equal(none.reason, "no_response");
});

test("a busy chat with a queued or active turn is ineligible", async () => {
  const messages = [user("u1"), assistant("a1", "Done")];
  const result = await resolveLatestTtsSource(deps({ messages, busy: true }), "chat-1");
  assert.equal(result.reason, "busy");
  assert.equal(result.source, null);
});

test("a missing chat is ineligible", async () => {
  const result = await resolveLatestTtsSource(deps({ messages: [], missing: true }), "gone");
  assert.equal(result.reason, "chat_missing");
});

test("revalidation returns the canonical body and rejects stale revisions", async () => {
  const messages = [user("u1"), assistant("a1", "Body text")];
  const d = deps({ messages });
  const projected = await resolveLatestTtsSource(d, "chat-1");
  assert.ok(projected.source);
  const content = await revalidateTtsSource(d, projected.source!);
  assert.equal(content.content, "Body text");

  // The response body changed underneath the reference.
  const mutated = deps({
    messages: [user("u1"), assistant("a1", "Edited body")],
  });
  await assert.rejects(revalidateTtsSource(mutated, projected.source!), /tts_source_changed/u);
});

test("revalidation rejects busy chats, missing messages, and failures", async () => {
  const messages = [user("u1"), assistant("a1", "Body")];
  const projected = await resolveLatestTtsSource(deps({ messages }), "chat-1");
  assert.ok(projected.source);

  await assert.rejects(
    revalidateTtsSource(deps({ messages, busy: true }), projected.source!),
    /tts_source_busy/u,
  );
  await assert.rejects(
    revalidateTtsSource(deps({ messages, missing: true }), projected.source!),
    /tts_source_chat_missing/u,
  );
  const failed = await resolveLatestTtsSource(
    deps({
      messages: [user("u1"), assistant("a1", "Body", { category: "provider_error" })],
    }),
    "chat-1",
  );
  assert.equal(failed.reason, "failed");
  await assert.rejects(
    revalidateTtsSource(deps({ messages, missing: true }), {
      chatId: "chat-1",
      messageId: "a1",
      sourceRevision: projected.source!.sourceRevision,
    }),
    /tts_source_chat_missing/u,
  );
});

test("revalidation rejects a forged revision for different content", async () => {
  const messages = [user("u1"), assistant("a1", "Actual body")];
  const d = deps({ messages });
  const forged = computeTtsSourceRevision({
    chatId: "chat-1",
    messageId: "a1",
    content: "Different body",
    providerFailure: false,
    policyVersion: 1,
  });
  await assert.rejects(
    revalidateTtsSource(d, {
      chatId: "chat-1",
      messageId: "a1",
      sourceRevision: forged,
    }),
    /tts_source_changed/u,
  );
});

test("historical assistant messages without a newer user turn keep identity", async () => {
  // Only the latest turn's response is projected as eligible...
  const messages = [assistant("orphan", "Orphan answer before any user turn")];
  const result = await resolveLatestTtsSource(deps({ messages }), "chat-1");
  // An assistant message that predates every user turn is still the latest
  // response surface for read aloud; there is no newer turn to prefer.
  assert.equal(result.reason, "ok");
  assert.equal(result.source?.messageId, "orphan");
});

test("a once-valid response cannot be replayed after a newer response or user turn", async () => {
  const messages = [user("u1"), assistant("a1", "Original")];
  const d = deps({ messages });
  const { source } = await resolveLatestTtsSource(d, "chat-1");
  messages.push(user("u2"));
  await assert.rejects(revalidateTtsSource(d, source!), /tts_source_changed/u);
  messages.push(assistant("a2", "New response"));
  await assert.rejects(revalidateTtsSource(d, source!), /tts_source_changed/u);
});

test("cancelled, failed or running persisted responses are never eligible while idle", async () => {
  for (const evidence of [
    { timeline: { status: "cancelled" } },
    { timeline: { status: "failed" } },
    { timeline: { status: "running" } },
    { pi: { stopReason: "aborted" } },
    { pi: { stopReason: "length" } },
    { pi: { stopReason: "error" } },
  ]) {
    const messages = [user("u1"), assistant("a1", "Partial response")];
    const d = deps({ messages });
    const { source } = await resolveLatestTtsSource(d, "chat-1");
    Object.assign(messages[1]!, evidence);
    assert.equal((await resolveLatestTtsSource(d, "chat-1")).reason, "failed");
    await assert.rejects(revalidateTtsSource(d, source!), /tts_source_failed/u);
  }
});

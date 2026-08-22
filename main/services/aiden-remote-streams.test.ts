import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { AidenRemoteStreamService, removeRevokedDeviceStreams } from "./aiden-remote-streams.js";

function fixture() {
  let now = 1_000;
  const cancelled: string[] = [];
  const approvals: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => now,
    cancel: (streamId, ownerId) => {
      cancelled.push(`${streamId}:${ownerId}`);
      return true;
    },
    approve: (approvalId, decision, ownerId) => {
      approvals.push(`${approvalId}:${decision}:${ownerId}`);
      return true;
    },
  });
  return { service, cancelled, approvals, setNow: (value: number) => { now = value; } };
}

test("remote stream journals typed events and is isolated to its paired device", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { streamId: "stream-1", delta: "Hello" });
  owner.owner.send("chat:reasoning-delta", { streamId: "stream-1", delta: "Think" });
  owner.owner.send("chat:tool", { streamId: "stream-1", phase: "call", toolName: "read_file" });
  owner.owner.send("chat:tool", { streamId: "stream-1", phase: "result", toolName: "read_file" });
  owner.owner.send("chat:done", {
    streamId: "stream-1",
    chat: { messages: [{ id: "assistant-1", role: "assistant" }] },
  });
  const status = app.service.status("device-1", "stream-1");
  assert.equal(status.state, "done");
  assert.equal(status.lastSequence, 6);
  assert.throws(
    () => app.service.status("device-2", "stream-1"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("SSE replay emits frozen envelopes and closes after a terminal event", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "Hello" });
  owner.owner.send("chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
  const output: string[] = [];
  let status = 0;
  let ended = false;
  const response = Object.assign(new EventEmitter(), {
    writeHead(value: number) { status = value; return this; },
    write(value: string) { output.push(value); return true; },
    end() { ended = true; return this; },
  }) as unknown as ServerResponse;
  app.service.openEvents("device-1", "stream-1", 0, response);
  assert.equal(status, 200);
  assert.equal(ended, true);
  assert.match(output.join(""), /event: text_delta/u);
  assert.match(output.join(""), /"messageId":"assistant-1"/u);
});

test("cancel and approval decisions are bound to the owning device and owner identity", async () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:approval", {
    approvalId: "approval-1",
    summary: "Write a file",
  });
  await assert.rejects(
    app.service.respondApproval("device-2", "approval-1", "allow", "wrong-device-key-0001"),
    (error: unknown) => (error as { code?: string }).code === "approval_expired",
  );
  const resolved = await app.service.respondApproval("device-1", "approval-1", "deny", "approval-deny-key-001");
  assert.deepEqual(
    await app.service.respondApproval("device-1", "approval-1", "deny", "approval-deny-key-001"),
    resolved,
  );
  await assert.rejects(
    app.service.respondApproval("device-1", "approval-1", "allow", "approval-deny-key-001"),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );
  assert.equal(resolved.decision, "deny");
  assert.equal(app.approvals.length, 1);
  const status = await app.service.cancel("device-1", "stream-1", "cancel-stream-key-001");
  assert.deepEqual(
    await app.service.cancel("device-1", "stream-1", "cancel-stream-key-001"),
    status,
  );
  assert.equal(status.state, "running");
  assert.equal(app.cancelled.length, 1);
});

test("restart restores terminal journals and marks active work interrupted", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "Partial" });
  const snapshot = app.service.snapshot();
  const restarted = new AidenRemoteStreamService({
    now: () => 20_000,
    cancel: () => false,
    approve: () => false,
    snapshot,
  });
  const status = restarted.status("device-1", "stream-1");
  assert.equal(status.state, "interrupted");
  assert.equal(status.lastSequence, 3);
});

test("revocation closes only the selected device streams and approval expiry denies safely", async () => {
  const app = fixture();
  const first = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const second = app.service.create("device-2", "stream-2", "chat-2", "turn-2");
  first.owner.send("chat:approval", { approvalId: "approval-1", summary: "Change a file" });
  await app.service.revokeDevice("device-1");
  assert.throws(
    () => app.service.status("device-1", "stream-1"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  assert.equal(app.service.status("device-2", "stream-2").state, "queued");
  assert.equal(app.cancelled.length, 1);
  assert.equal(app.approvals.some((entry) => entry.includes("approval-1:deny")), true);

  second.owner.send("chat:approval", { approvalId: "approval-2", summary: "Run a command" });
  app.setNow(1_000 + 5 * 60 * 1_000 + 1);
  app.service.status("device-2", "stream-2");
  assert.equal(app.approvals.some((entry) => entry.includes("approval-2:deny")), true);
});

test("revoking one device releases every retained journal without consuming another device's capacity", async () => {
  const app = fixture();
  for (let index = 0; index < 256; index += 1) {
    const streamId = `stream-a-${index}`;
    const owner = app.service.create("device-a", streamId, `chat-${index}`, `turn-${index}`);
    owner.owner.send("chat:done", {
      chat: { messages: [{ id: `assistant-${index}`, role: "assistant" }] },
    });
  }
  assert.throws(
    () => app.service.create("device-b", "stream-b-blocked", "chat-b", "turn-b"),
    (error: unknown) => (error as { code?: string }).code === "rate_limited",
  );

  await app.service.revokeDevice("device-a");
  const owner = app.service.create("device-b", "stream-b", "chat-b", "turn-b");
  assert.equal(owner.owner.documentId.length > 0, true);
  assert.equal(app.service.status("device-b", "stream-b").state, "queued");
  assert.equal(app.service.snapshot().streams.some(({ deviceId }) => deviceId === "device-a"), false);
});

test("restart filtering durably excludes journals owned by authoritative revoked devices", () => {
  const app = fixture();
  app.service.create("device-a", "stream-a", "chat-a", "turn-a");
  app.service.create("device-b", "stream-b", "chat-b", "turn-b");
  const filtered = removeRevokedDeviceStreams(app.service.snapshot(), new Set(["device-a"]));
  assert.deepEqual(filtered.streams.map(({ deviceId }) => deviceId), ["device-b"]);
});

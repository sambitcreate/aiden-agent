import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ServerResponse } from "node:http";
import {
  AidenRemoteStreamService,
  normalizeAidenRemoteStreamSnapshot,
  removeRevokedDeviceStreams,
} from "./aiden-remote-streams.js";

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

test("remote stream forwards the renderer-safe chronological timeline without raw tool data", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const timeline = {
    version: 3,
    generationId: "stream-1",
    status: "running",
    startedAt: 1_000,
    steps: [{
      id: "tool-1",
      order: 0,
      kind: "tool",
      toolCallId: "call-1",
      toolName: "run_command",
      label: "Run command",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
      contentOffset: 0,
      detail: "Check project status",
    }],
  };
  owner.owner.send("chat:timeline", { timeline, rawCommand: "cat ~/.ssh/id_rsa" });
  const event = app.service.snapshot().streams[0]?.events[1];
  assert.equal(event?.type, "timeline");
  assert.deepEqual(event?.payload, { timeline });
  assert.doesNotMatch(JSON.stringify(event), /cat |\.ssh/u);
});

test("Mac-side cancellation is projected as cancelled instead of a successful completion", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "Partial" });
  owner.owner.send("chat:done", {
    chat: { messages: [{ id: "assistant-1", role: "assistant" }] },
    timeline: {
      version: 3,
      generationId: "stream-1",
      status: "cancelled",
      startedAt: 1_000,
      finishedAt: 2_000,
      cancellationOrigin: "user_stop",
      steps: [],
    },
  });
  const status = app.service.status("device-1", "stream-1");
  const events = app.service.snapshot().streams[0]?.events ?? [];
  const terminalEvent = events[events.length - 1];
  assert.equal(status.state, "cancelled");
  assert.equal(terminalEvent?.type, "cancelled");
  assert.deepEqual(terminalEvent?.payload, { source: "server" });
});

test("Mac-side initialization cancellation without a timeline remains a terminal cancellation", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:done", {
    streamId: "stream-1",
    content: "",
    cancelled: true,
    cancellationOrigin: "user_stop",
  });
  const status = app.service.status("device-1", "stream-1");
  const events = app.service.snapshot().streams[0]?.events ?? [];
  const terminal = events[events.length - 1];
  assert.equal(status.state, "cancelled");
  assert.equal(terminal?.type, "cancelled");
  assert.deepEqual(terminal?.payload, { source: "server" });
});

test("provider failure remains a replayable terminal error with its safe message", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:error", { message: "The model provider could not complete this response." });
  assert.equal(app.service.status("device-1", "stream-1").state, "error");

  const output: string[] = [];
  let ended = false;
  const response = Object.assign(new EventEmitter(), {
    writeHead() { return this; },
    write(value: string) { output.push(value); return true; },
    end() { ended = true; return this; },
  }) as unknown as ServerResponse;
  app.service.openEvents("device-1", "stream-1", 0, response);
  assert.equal(ended, true);
  assert.match(output.join(""), /event: error/u);
  assert.match(output.join(""), /The model provider could not complete this response\./u);
});

test("explicit cancellation dominates a racing provider error and private diagnostics stay local", async () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  await app.service.cancel("device-1", "stream-1", "cancel-race-key-0001");
  owner.owner.send("chat:error", {
    message: "/Users/private/project: provider token sk-private failed",
  });
  const events = app.service.snapshot().streams[0]?.events ?? [];
  const terminal = events[events.length - 1];
  assert.equal(app.service.status("device-1", "stream-1").state, "cancelled");
  assert.equal(terminal?.type, "cancelled");
  assert.doesNotMatch(JSON.stringify(terminal), /Users|sk-private/u);
});

test("provider errors expose only fixed product-owned copy", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:error", {
    message: "/Users/private/project: provider token sk-private failed",
  });
  const events = app.service.snapshot().streams[0]?.events ?? [];
  const terminal = events[events.length - 1];
  assert.equal(terminal?.type, "error");
  assert.deepEqual(terminal?.payload, {
    code: "internal_error",
    message: "The model provider could not complete this response.",
  });
});

test("subscriber disconnect does not cancel work and reconnect replays completion", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const firstOutput: string[] = [];
  const first = Object.assign(new EventEmitter(), {
    writeHead() { return this; },
    write(value: string) { firstOutput.push(value); return true; },
    end() { return this; },
  }) as unknown as ServerResponse;
  app.service.openEvents("device-1", "stream-1", 0, first);
  first.emit("close");
  owner.owner.send("chat:delta", { delta: "Finished while offline" });
  owner.owner.send("chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
  assert.equal(app.service.status("device-1", "stream-1").state, "done");

  const replayOutput: string[] = [];
  let replayEnded = false;
  const replay = Object.assign(new EventEmitter(), {
    writeHead() { return this; },
    write(value: string) { replayOutput.push(value); return true; },
    end() { replayEnded = true; return this; },
  }) as unknown as ServerResponse;
  app.service.openEvents("device-1", "stream-1", 1, replay);
  assert.equal(replayEnded, true);
  assert.match(replayOutput.join(""), /Finished while offline/u);
  assert.match(replayOutput.join(""), /event: done/u);
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
  assert.equal(status.state, "reconciling");
  assert.equal(app.cancelled.length, 1);
});

test("approval status is authoritative across reconnect and can be resolved from the host", () => {
  const changed: string[] = [];
  const decisions: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: (approvalId, decision, ownerId) => {
      decisions.push(`${approvalId}:${decision}:${ownerId}`);
      return true;
    },
    notifyApprovalChanged: (chatId) => changed.push(chatId),
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:approval", {
    approvalId: "approval-1",
    summary: "",
    toolCallId: "tool-call-1",
    toolName: "run_command",
  });

  assert.deepEqual(service.pendingApproval("device-1", "stream-1"), {
    approvalId: "approval-1",
    streamId: "stream-1",
    chatId: "chat-1",
    summary: "Aiden needs approval.",
    toolCallId: "tool-call-1",
    toolName: "run_command",
    expiresAt: "1970-01-01T00:05:01.000Z",
    canAllow: true,
  });
  assert.equal(service.pendingApprovalForChat("chat-1")?.approvalId, "approval-1");
  assert.equal(service.respondApprovalFromHost("wrong-chat", "approval-1", "allow"), false);
  assert.equal(service.respondApprovalFromHost("chat-1", "approval-1", "allow"), true);
  assert.equal(service.pendingApproval("device-1", "stream-1"), null);
  assert.equal(service.status("device-1", "stream-1").state, "running");
  assert.equal(decisions.length, 1);
  assert.deepEqual(changed, ["chat-1", "chat-1"]);
});

test("privileged approval details remain host-only and mobile fails closed", () => {
  const service = fixture().service;
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  const details = {
    kind: "subagent-shell" as const,
    childLabel: "Run checks",
    command: "npm test",
    initialCwd: "/Users/example/project",
    shell: "/bin/zsh -f -c" as const,
    argumentDigestPrefix: "a".repeat(12),
    rootDigestPrefix: "b".repeat(12),
    effectDigestPrefix: "c".repeat(12),
    timeoutMs: 120_000,
    stdoutLimitBytes: 512 * 1024,
    stderrLimitBytes: 512 * 1024,
    workspaceLabel: "Project",
    isManagedWorktree: false,
    worktreeLabel: null,
    environmentProfile: "minimal-private-0700-v1" as const,
    osSandboxed: false as const,
    rollbackAvailable: false as const,
    outputSentToModel: true as const,
    arbitraryNetworkAvailable: true as const,
    detachedProcessesMaySurvive: true as const,
  };
  owner.owner.send("chat:approval", {
    approvalId: "approval-1",
    summary: "Run a full-host command for Run checks",
    details,
  });

  assert.deepEqual(service.pendingApprovalForChat("chat-1")?.details, details);
  const mobile = service.pendingApproval("device-1", "stream-1");
  assert.equal(mobile?.details, undefined);
  assert.equal(mobile?.canAllow, false);
});

test("multiple approvals remain queued and cancellation synchronously clears them", async () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:approval", { approvalId: "approval-1", summary: "First" });
  owner.owner.send("chat:approval", { approvalId: "approval-2", summary: "Second" });
  assert.equal(app.service.pendingApproval("device-1", "stream-1")?.approvalId, "approval-1");
  assert.equal(app.service.respondApprovalFromHost("chat-1", "approval-1", "allow"), true);
  assert.equal(app.service.status("device-1", "stream-1").state, "waiting_for_approval");
  assert.equal(app.service.pendingApproval("device-1", "stream-1")?.approvalId, "approval-2");

  const cancelled = await app.service.cancel("device-1", "stream-1", "cancel-waiting-key-01");
  assert.equal(cancelled.state, "reconciling");
  assert.equal(app.service.pendingApproval("device-1", "stream-1"), null);
  assert.equal(app.service.pendingApprovalForChat("chat-1"), null);
  assert.equal(app.approvals.some((entry) => entry.includes("approval-2:deny")), true);
  await assert.rejects(
    app.service.respondApproval("device-1", "approval-2", "allow", "approval-after-cancel-1"),
    (error: unknown) => (error as { code?: string }).code === "approval_expired",
  );
});

test("empty assistant IDs never poison the durable stream journal", async () => {
  let persisted = 0;
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    persist: async (snapshot) => {
      normalizeAidenRemoteStreamSnapshot(snapshot);
      persisted += 1;
    },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "" });
  owner.owner.send("chat:reasoning-delta", { delta: "" });
  owner.owner.send("chat:tool", { phase: "call", toolName: "" });
  owner.owner.send("chat:done", {
    chat: { messages: [{ id: "", role: "assistant" }] },
  });
  await service.settlePersistence();

  const events = service.snapshot().streams[0]?.events ?? [];
  const terminal = events[events.length - 1];
  assert.deepEqual(terminal?.payload, { messageId: "assistant_turn-1" });
  assert.deepEqual(events[events.length - 2]?.payload, {
    toolId: "tool_1",
    name: "Tool",
  });
  assert.doesNotThrow(() => normalizeAidenRemoteStreamSnapshot(service.snapshot()));
  assert.equal(persisted > 0, true);
});

test("unpaired UTF-16 from provider notifications is sanitized before persistence", async () => {
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    persist: async (snapshot) => { normalizeAidenRemoteStreamSnapshot(snapshot); },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "bad\ud800delta" });
  owner.owner.send("chat:reasoning-delta", { delta: "bad\udc00reasoning" });
  owner.owner.send("chat:tool", { phase: "call", toolName: "bad\ud800tool" });
  owner.owner.send("chat:timeline", { timeline: { steps: [{ kind: "tool", label: "bad\udc00label" }] } });
  owner.owner.send("chat:approval", { approvalId: "approval-1", summary: "bad\ud800summary" });
  service.respondApprovalFromHost("chat-1", "approval-1", "deny");
  owner.owner.send("chat:done", { chat: { messages: [{ id: "bad\udc00id", role: "assistant" }] } });
  await service.settlePersistence();
  assert.doesNotThrow(() => normalizeAidenRemoteStreamSnapshot(service.snapshot()));
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /\\ud800|\\udc00/u);
});

test("aggregate stream journals stay within the durable snapshot budget", async () => {
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    persist: async (snapshot) => { normalizeAidenRemoteStreamSnapshot(snapshot); },
  });
  for (let streamIndex = 0; streamIndex < 3; streamIndex += 1) {
    const owner = service.create("device-1", `stream-${streamIndex}`, `chat-${streamIndex}`, `turn-${streamIndex}`);
    for (let index = 0; index < 35; index += 1) {
      owner.owner.send("chat:delta", { delta: `${streamIndex}:${index}:` + "x".repeat(199_990) });
    }
  }
  await service.settlePersistence();
  const snapshot = service.snapshot();
  assert.doesNotThrow(() => normalizeAidenRemoteStreamSnapshot(snapshot));
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 16 * 1_024 * 1_024, true);
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
  const expiredStatus = app.service.status("device-2", "stream-2");
  assert.equal(app.approvals.some((entry) => entry.includes("approval-2:deny")), true);
  assert.equal(expiredStatus.state, "running");
  assert.equal(app.service.pendingApproval("device-2", "stream-2"), null);
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

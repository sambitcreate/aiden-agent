import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ServerResponse } from "node:http";
import {
  AidenRemoteStreamService,
  normalizeAidenRemoteStreamSnapshot,
  removeRevokedDeviceStreams,
} from "./aiden-remote-streams.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

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
    end() { ended = true; (this as unknown as EventEmitter).emit("finish"); return this; },
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
    end() { replayEnded = true; (this as unknown as EventEmitter).emit("finish"); return this; },
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
    end() { ended = true; (this as unknown as EventEmitter).emit("finish"); return this; },
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

test("schedule-tool approvals declare the schedule-write capability boundary", () => {
  const app = fixture();
  const owner = app.service.create(
    "device-1",
    "stream-1",
    "chat-1",
    "turn-1",
  );
  owner.owner.send("chat:approval", {
    approvalId: "approval-1",
    summary: "Create a daily brief",
    toolName: "schedule_task",
  });
  assert.equal(
    app.service.approvalRequiredCapability("device-1", "approval-1"),
    "schedule:write",
  );

  owner.owner.send("chat:approval", {
    approvalId: "approval-edit",
    summary: "Update a daily brief",
    toolName: "edit_automation",
  });
  assert.equal(
    app.service.approvalRequiredCapability("device-1", "approval-edit"),
    "schedule:write",
  );
  assert.throws(
    () =>
      app.service.approvalRequiredCapability("device-2", "approval-1"),
    (error: unknown) => (error as { code?: string }).code === "approval_expired",
  );

  owner.owner.send("chat:approval", {
    approvalId: "approval-2",
    summary: "Read a file",
    toolName: "read_file",
  });
  assert.equal(
    app.service.approvalRequiredCapability("device-1", "approval-2"),
    undefined,
  );
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

test("privileged approval details remain host-only and mobile can deny but cannot allow", async () => {
  const app = fixture();
  const service = app.service;
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

  await assert.rejects(
    service.respondApproval(
      "device-1",
      "approval-1",
      "allow",
      "approval-host-only-allow-key",
    ),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "capability_denied",
  );
  assert.equal(service.pendingApproval("device-1", "stream-1")?.approvalId, "approval-1");
  assert.deepEqual(app.approvals, []);

  const denied = await service.respondApproval(
    "device-1",
    "approval-1",
    "deny",
    "approval-host-only-deny-key",
  );
  assert.equal(denied.decision, "deny");
  assert.equal(service.pendingApproval("device-1", "stream-1"), null);
  assert.match(app.approvals[0] ?? "", /:deny:/u);
});

test("bounded standard schedule approvals remain mobile-allowable without exposing details", async () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:approval", {
    approvalId: "approval-schedule",
    summary:
      'Create scheduled task "Inbox monitor" · Every day at 9:00 AM · Full access · MCP Gmail (gmail) · Local Provider / Local Model',
    details: {
      kind: "scheduled-task",
      action: "create",
      taskId: null,
      expectedUpdatedAt: null,
      enabled: true,
      name: "Inbox monitor",
      prompt: "Summarize inbox changes.",
      script: null,
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: 2_000_000_000_000,
      notify: true,
      mode: "llm",
      permission: "full",
      workspaceId: null,
      workspaceName: null,
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
      providerId: "local-provider",
      providerName: "Local Provider",
      model: "local-model",
      modelName: "Local Model",
      legacyGlobalMcp: false,
      schedulerEnabled: true,
    },
  });

  const mobile = app.service.pendingApproval("device-1", "stream-1");
  assert.equal(mobile?.details, undefined);
  assert.equal(mobile?.canAllow, true);
  assert.match(mobile?.summary ?? "", /Full access · MCP Gmail \(gmail\)/u);
  const allowed = await app.service.respondApproval(
    "device-1",
    "approval-schedule",
    "allow",
    "approval-schedule-allow-key",
  );
  assert.equal(allowed.decision, "allow");
  assert.match(app.approvals[0] ?? "", /:allow:/u);
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

test("Bot inbox activity is batched and approval response authority stays device-owned", () => {
  const app = fixture();
  const first = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const second = app.service.create("device-2", "stream-2", "chat-2", "turn-2");
  first.owner.send("chat:approval", {
    approvalId: "approval-1",
    summary: "Review this action",
  });
  second.owner.send("chat:delta", { delta: "Working" });

  assert.deepEqual(
    app.service.projectChatActivities("device-1", ["chat-1", "chat-2", "chat-idle"]),
    [
      {
        chatId: "chat-1",
        activityState: "waiting_for_approval",
        canRespondToApproval: true,
      },
      {
        chatId: "chat-2",
        activityState: "running",
        canRespondToApproval: false,
      },
      {
        chatId: "chat-idle",
        activityState: "idle",
        canRespondToApproval: false,
      },
    ],
  );
  assert.equal(
    app.service.projectChatActivities("device-2", ["chat-1"])[0]
      ?.canRespondToApproval,
    false,
  );
  assert.throws(
    () =>
      app.service.projectChatActivities(
        "device-1",
        Array.from({ length: 201 }, (_, index) => `chat-${index}`),
      ),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
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

test("legacy label-only timeline journals load into the current safe timeline shape", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:timeline", {
    timeline: {
      version: 3,
      generationId: "stream-1",
      status: "running",
      startedAt: 1_000,
      steps: [],
    },
  });
  const legacy = app.service.snapshot();
  legacy.streams[0]!.events[1]!.payload = { label: "Run command" };

  const normalized = normalizeAidenRemoteStreamSnapshot(legacy);
  const payload = normalized.streams[0]!.events[1]!.payload;
  assert.equal("label" in payload, false);
  assert.deepEqual(payload, {
    timeline: {
      version: 2,
      generationId: "stream-1",
      status: "running",
      startedAt: 1_000,
      steps: [{
        id: "tool-2",
        order: 0,
        kind: "tool",
        toolCallId: "call-2",
        toolName: "legacy_activity",
        label: "Run command",
        status: "running",
        startedAt: 1_000,
        updatedAt: 1_000,
      }],
    },
  });
});

test("legacy timeline migration strips only label and still rejects unknown payload fields", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:timeline", {
    timeline: {
      version: 3,
      generationId: "stream-1",
      status: "running",
      startedAt: 1_000,
      steps: [],
    },
  });
  const snapshot = app.service.snapshot();
  const currentTimeline = structuredClone(
    snapshot.streams[0]!.events[1]!.payload.timeline,
  );
  snapshot.streams[0]!.events[1]!.payload = {
    label: "Thinking",
    timeline: currentTimeline,
  };
  assert.deepEqual(
    normalizeAidenRemoteStreamSnapshot(snapshot).streams[0]!.events[1]!.payload,
    { timeline: currentTimeline },
  );

  snapshot.streams[0]!.events[1]!.payload = {
    label: "Thinking",
    timeline: currentTimeline,
    hiddenPrompt: "must remain rejected",
  };
  assert.throws(
    () => normalizeAidenRemoteStreamSnapshot(snapshot),
    /unsupported field/u,
  );
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

test("turnIdFor resolves issued turn identities and survives pruning and restart", () => {
  const app = fixture();
  app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  assert.equal(app.service.turnIdFor("chat-1", "stream-1"), "turn-1");
  // Cross-chat and unknown generations resolve to nothing.
  assert.equal(app.service.turnIdFor("chat-2", "stream-1"), undefined);
  assert.equal(app.service.turnIdFor("chat-1", "stream-9"), undefined);

  const owner = app.service.create("device-1", "stream-2", "chat-1", "turn-2");
  owner.owner.send("chat:done", {
    chat: { messages: [{ id: "assistant-2", role: "assistant" }] },
  });
  // Terminal retention pruning drops the stream record but keeps the identity.
  app.setNow(1_000 + 30 * 24 * 60 * 60 * 1000);
  app.service.create("device-1", "stream-3", "chat-1", "turn-3");
  assert.equal(
    app.service.snapshot().streams.some(({ streamId }) => streamId === "stream-2"),
    false,
    "the aged terminal stream is pruned",
  );
  assert.equal(app.service.turnIdFor("chat-1", "stream-2"), "turn-2");

  // The index round-trips through the durable snapshot into a fresh service.
  const restored = new AidenRemoteStreamService({
    now: () => 2_000,
    cancel: () => true,
    approve: () => true,
    snapshot: app.service.snapshot(),
  });
  assert.equal(restored.turnIdFor("chat-1", "stream-2"), "turn-2");
  assert.equal(restored.turnIdFor("chat-1", "stream-1"), "turn-1");
  assert.equal(restored.turnIdFor("chat-2", "stream-2"), undefined);
});

function blockedResponse() {
  const output: string[] = [];
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    destroyed: false,
    ended: false,
    autoFinish: true,
    blocked: true,
    writeHead() { return this; },
    write(value: string) { output.push(value); return !this.blocked; },
    end() { this.ended = true; if (this.autoFinish) emitter.emit("finish"); return this; },
    destroy() { this.destroyed = true; emitter.emit("close"); return this; },
  });
  return { response, output, http: response as unknown as ServerResponse };
}

test("SSE replay waits for drain and delivers terminal completion in order", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:delta", { delta: "Hello" });
  owner.owner.send("chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
  const client = blockedResponse();
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  assert.equal(client.output.length, 1);
  assert.equal(client.response.ended, false);
  client.response.blocked = false;
  client.response.emit("drain");
  assert.deepEqual(client.output.map((frame) => Number(/^id: (\d+)/u.exec(frame)?.[1])), [1, 2, 3]);
  assert.equal(client.response.ended, true);
  assert.equal(client.response.listenerCount("drain"), 0);
});

test("a blocked subscriber does not buffer live events or stall healthy subscribers", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const slow = blockedResponse();
  const fast = blockedResponse();
  fast.response.blocked = false;
  app.service.openEvents("device-1", "stream-1", 0, slow.http);
  app.service.openEvents("device-1", "stream-1", 0, fast.http);
  for (let i = 0; i < 30; i++) owner.owner.send("chat:delta", { delta: String(i) });
  owner.owner.send("chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
  assert.equal(slow.output.length, 1);
  assert.equal(slow.response.ended, false);
  assert.equal(fast.output.length, 32);
  assert.equal(fast.response.ended, true);
  slow.response.blocked = false;
  slow.response.emit("drain");
  assert.deepEqual(slow.output, fast.output);
  assert.equal(slow.response.ended, true);
  assert.deepEqual(app.cancelled, []);
});

test("stalled SSE output skips heartbeats and times out without cancelling generation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const client = blockedResponse();
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  t.mock.timers.tick(15_000);
  assert.equal(client.output.length, 1);
  assert.equal(client.response.destroyed, false);
  t.mock.timers.tick(15_000);
  assert.equal(client.response.destroyed, true);
  assert.equal(client.response.listenerCount("drain"), 0);
  assert.equal(client.response.listenerCount("close"), 0);
  owner.owner.send("chat:delta", { delta: "Still running" });
  assert.deepEqual(app.cancelled, []);
  assert.equal(app.service.status("device-1", "stream-1").state, "running");
  const replay = blockedResponse();
  replay.response.blocked = false;
  app.service.openEvents("device-1", "stream-1", 1, replay.http);
  assert.match(replay.output.join(""), /Still running/u);
  replay.response.destroy();
});

test("heartbeat backpressure pauses live delivery until drain", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const client = blockedResponse();
  client.response.blocked = false;
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  client.response.blocked = true;
  t.mock.timers.tick(15_000);
  assert.equal(client.output[1], ": heartbeat\n\n");
  owner.owner.send("chat:delta", { delta: "Pending" });
  assert.equal(client.output.length, 2);
  client.response.blocked = false;
  client.response.emit("drain");
  assert.match(client.output[2]!, /Pending/u);
  t.mock.timers.tick(30_000);
  assert.equal(client.response.destroyed, false);
  client.response.destroy();
});

test("disconnect and response errors release blocked SSE delivery", () => {
  for (const event of ["close", "error"]) {
    const app = fixture();
    const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
    const client = blockedResponse();
    app.service.openEvents("device-1", "stream-1", 0, client.http);
    client.response.emit(event);
    owner.owner.send("chat:delta", { delta: "After disconnect" });
    client.response.emit("drain");
    assert.equal(client.output.length, 1);
    assert.equal(client.response.listenerCount("drain"), 0);
    assert.deepEqual(app.cancelled, []);
  }
});

test("a subscriber overtaken by journal retention disconnects for snapshot recovery", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const client = blockedResponse();
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  for (let i = 0; i < 140; i++) owner.owner.send("chat:delta", { delta: "x".repeat(65_536) });
  assert.equal(client.output.length, 1);
  client.response.blocked = false;
  client.response.emit("drain");
  assert.equal(client.response.destroyed, true);
  const replay = blockedResponse();
  replay.response.blocked = false;
  app.service.openEvents("device-1", "stream-1", 1, replay.http);
  assert.match(replay.output[0]!, /event: snapshot/u);
  assert.deepEqual(app.cancelled, []);
  replay.response.destroy();
});

test("terminal replay drains each accepted frame exactly once before ending", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:done", { chat: { messages: [] } });
  const client = blockedResponse();
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  client.response.emit("drain");
  assert.equal(client.output.length, 2);
  assert.equal(client.response.ended, false);
  client.response.emit("drain");
  assert.equal(client.output.length, 2);
  assert.equal(client.response.ended, true);
});

test("revocation destroys blocked delivery and removes drain ownership", async () => {
  const app = fixture();
  app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const client = blockedResponse();
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  await app.service.revokeDevice("device-1");
  assert.equal(client.response.destroyed, true);
  assert.equal(client.response.listenerCount("drain"), 0);
  client.response.emit("drain");
  assert.equal(client.output.length, 1);
});

test("a synchronous socket write failure cannot interrupt generation publication", () => {
  const app = fixture();
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const client = blockedResponse();
  client.response.blocked = false;
  app.service.openEvents("device-1", "stream-1", 0, client.http);
  client.response.write = () => { throw new Error("socket closed"); };
  assert.doesNotThrow(() => owner.owner.send("chat:delta", { delta: "Saved" }));
  assert.equal(client.response.destroyed, true);
  const events = app.service.snapshot().streams[0]!.events;
  assert.equal(events[events.length - 1]?.payload.text, "Saved");
});

for (const settlement of ["drain", "timeout", "abort", "finish-abort", "finish-timeout", "retention"] as const) {
  test(`aggregate pressure preserves blocked terminal delivery until ${settlement}`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const app = fixture();
    const owner = app.service.create("device-1", "terminal", "chat-1", "turn-1");
    const client = blockedResponse();
    client.response.blocked = false;
    app.service.openEvents("device-1", "terminal", 0, client.http);
    client.response.blocked = true;
    owner.owner.send("chat:done", { chat: { messages: [{ id: "assistant-1", role: "assistant" }] } });
    assert.match(client.output[1]!, /event: done/u);
    assert.equal(client.response.ended, false);

    // Three active journals exceed the shared 16 MiB limit even though each
    // remains below its individual limit. The terminal journal is oldest.
    const producers = Array.from({ length: 3 }, (_, index) =>
      app.service.create("device-1", `load-${index}`, `chat-${index + 2}`, `turn-${index + 2}`));
    for (let index = 0; index < 252; index++) {
      app.service.create("device-1", `idle-${index}`, `idle-chat-${index}`, `idle-turn-${index}`);
    }
    for (const producer of producers) {
      for (let index = 0; index < 30; index++) producer.owner.send("chat:delta", { delta: "x".repeat(200_000) });
    }
    assert.equal(client.response.destroyed, false, "pressure must not discard accepted terminal bytes");
    assert.equal(app.service.status("device-1", "terminal").state, "done");
    assert.equal(Buffer.byteLength(JSON.stringify(app.service.snapshot()), "utf8") <= 16 * 1_024 * 1_024, true);
    assert.throws(
      () => app.service.create("device-1", "new-stream", "new-chat", "new-turn"),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "rate_limited",
    );
    if (settlement === "drain") {
      client.response.emit("drain");
      assert.equal(client.response.ended, true);
      assert.equal(client.response.destroyed, false);
    } else if (settlement === "timeout" || settlement === "retention") {
      t.mock.timers.tick(30_000);
      assert.equal(client.response.destroyed, true);
    } else if (settlement === "finish-abort" || settlement === "finish-timeout") {
      client.response.autoFinish = false;
      client.response.emit("drain");
      assert.equal(client.response.ended, true);
      assert.equal(app.service.status("device-1", "terminal").state, "done");
      if (settlement === "finish-timeout") t.mock.timers.tick(30_000);
      else client.response.destroy();
    } else {
      client.response.destroy();
    }
    assert.equal(client.response.listenerCount("drain"), 0);
    if (settlement !== "drain") {
      assert.equal(app.service.status("device-1", "terminal").state, "done");
      assert.throws(
        () => app.service.create("device-1", "new-stream", "new-chat", "new-turn"),
        (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "rate_limited",
      );
      // New pressure must not evict the disconnected client's replay record.
      producers[0]!.owner.send("chat:delta", { delta: "y".repeat(200_000) });
      assert.equal(Buffer.byteLength(JSON.stringify(app.service.snapshot()), "utf8") <= 16 * 1_024 * 1_024, true);
      if (settlement === "retention") {
        app.setNow(1_000 + 24 * 60 * 60 * 1_000);
      } else {
        const replay = blockedResponse();
        replay.response.blocked = false;
        app.service.openEvents("device-1", "terminal", 1, replay.http);
        assert.match(replay.output.join(""), /event: done/u);
        assert.equal(replay.response.ended, true);
      }
    }
    // Successful terminal delivery frees deferred capacity without another
    // append. Abandoned replay remains bounded by ordinary terminal retention.
    assert.doesNotThrow(() => app.service.create("device-1", "new-stream", "new-chat", "new-turn"));
    assert.throws(
      () => app.service.status("device-1", "terminal"),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "not_found",
    );
    assert.deepEqual(app.cancelled, []);
  });
}


test("stream capacity does not reclaim genuinely active generations", () => {
  const app = fixture();
  for (let index = 0; index < 256; index++) {
    app.service.create("device-1", `active-${index}`, `chat-${index}`, `turn-${index}`);
  }
  assert.throws(
    () => app.service.create("device-1", "extra", "extra-chat", "extra-turn"),
    (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "rate_limited",
  );
  assert.equal(app.service.snapshot().streams.length, 256);
  assert.deepEqual(app.cancelled, []);
});

function inputPassthrough<T>(_chatId: string, action: () => Promise<T>): Promise<T> {
  return action();
}

function inputFixture(submitInput?: (input: {
  streamId: string;
  chatId: string;
  mode: "steer" | "queue";
  text: string;
  ownerDocumentId?: string;
}) => Promise<{
  admitted: boolean;
  queue?: "steer" | "follow-up";
  reason?: "run_not_active" | "cancelled" | "capacity" | "invalid";
  committed: boolean;
  messageId?: string;
}>) {
  let now = 1_000;
  const calls: Array<Record<string, unknown>> = [];
  const service = new AidenRemoteStreamService({
    now: () => now,
    cancel: () => true,
    approve: () => true,
    ...(submitInput
      ? {
          submitInput: async (input) => {
            calls.push({ ...input });
            return submitInput(input);
          },
        }
      : {}),
  });
  return { service, calls };
}

test("run input admission binds to the stream owner and returns an accepted receipt", async () => {
  const app = inputFixture(async (input) => ({
    admitted: true,
    queue: input.mode === "steer" ? "steer" : "follow-up",
    committed: true,
    messageId: "message_remote_1",
  }));
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:status", { streamId: "stream-1" });
  const result = await app.service.submitInput(
    "device-1",
    "stream-1",
    { mode: "queue", text: "Follow up after this." },
    "input-key-0000000001",
    inputPassthrough);
  assert.equal(result.status, "admitted");
  assert.equal(result.queue, "follow-up");
  assert.equal(result.committed, true);
  assert.equal(result.messageId, "message_remote_1");
  assert.equal(result.streamId, "stream-1");
  assert.equal(result.chatId, "chat-1");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.mode, "queue");
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0]!.streamId, "stream-1");
  assert.equal(app.calls[0]!.chatId, "chat-1");
  assert.equal(app.calls[0]!.mode, "queue");
  assert.equal(app.calls[0]!.text, "Follow up after this.");
  assert.equal(app.calls[0]!.ownerDocumentId, owner.owner.documentId);
});

test("run input admission rejects terminal and cancelled streams without calling the host", async () => {
  const app = inputFixture(async () => ({
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "m",
  }));
  const owner = app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:done", {
    streamId: "stream-1",
    chat: { messages: [{ id: "assistant-1", role: "assistant" }] },
  });
  const terminal = await app.service.submitInput(
    "device-1",
    "stream-1",
    { mode: "steer", text: "too late" },
    "input-key-0000000002",
    inputPassthrough);
  assert.deepEqual(terminal, {
    streamId: "stream-1",
    chatId: "chat-1",
    turnId: "turn-1",
    mode: "steer",
    status: "rejected",
    reason: "run_not_active",
    committed: false,
  });
  assert.equal(app.calls.length, 0);

  const cancelling = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    submitInput: async () => {
      app.calls.push({});
      return { admitted: true, queue: "steer", committed: true, messageId: "m" };
    },
  });
  cancelling.create("device-1", "stream-2", "chat-1", "turn-2");
  await cancelling.cancel("device-1", "stream-2", "cancel-key-0000000001");
  const cancelled = await cancelling.submitInput(
    "device-1",
    "stream-2",
    { mode: "steer", text: "stop racing" },
    "input-key-0000000003",
    inputPassthrough);
  assert.equal(cancelled.status, "rejected");
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.committed, false);
  assert.equal(app.calls.length, 0);
});

test("run input admission replays the original outcome and rejects conflicting reuse", async () => {
  let outcome = {
    admitted: true,
    queue: "follow-up" as const,
    committed: true,
    messageId: "message_remote_2",
  };
  const app = inputFixture(async () => outcome);
  app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const input = { mode: "queue" as const, text: "Queue this." };
  const first = await app.service.submitInput("device-1", "stream-1", input, "input-key-0000000004", inputPassthrough);
  const replay = await app.service.submitInput("device-1", "stream-1", input, "input-key-0000000004", inputPassthrough);
  assert.deepEqual(replay, first);
  assert.equal(app.calls.length, 1);
  await assert.rejects(
    app.service.submitInput(
      "device-1",
      "stream-1",
      { mode: "queue", text: "Different text." },
      "input-key-0000000004",
      inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );

  // A host rejection is a recorded domain outcome: same request UUID replays it.
  outcome = { admitted: false, reason: "capacity", committed: false } as never;
  const rejected = await app.service.submitInput(
    "device-1",
    "stream-1",
    { mode: "steer", text: "Full queue." },
    "input-key-0000000005",
    inputPassthrough);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "capacity");
  const rejectedReplay = await app.service.submitInput(
    "device-1",
    "stream-1",
    { mode: "steer", text: "Full queue." },
    "input-key-0000000005",
    inputPassthrough);
  assert.deepEqual(rejectedReplay, rejected);
  assert.equal(app.calls.length, 2);
});

test("run input admission reports committed rejections and stays hidden when unwired", async () => {
  const app = inputFixture(async () => ({
    admitted: false,
    reason: "run_not_active",
    committed: true,
    messageId: "message_orphaned_1",
  }));
  app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  const result = await app.service.submitInput(
    "device-1",
    "stream-1",
    { mode: "steer", text: "ended mid-flight" },
    "input-key-0000000006",
    inputPassthrough);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "run_not_active");
  assert.equal(result.committed, true);
  assert.equal(result.messageId, "message_orphaned_1");

  const unwired = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
  });
  unwired.create("device-1", "stream-9", "chat-9", "turn-9");
  assert.equal(unwired.supportsRunInput(), false);
  await assert.rejects(
    unwired.submitInput("device-1", "stream-9", { mode: "queue", text: "x" }, "input-key-0000000007", inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  assert.equal(app.service.supportsRunInput(), true);
});

test("run input admission validates the body and binds to the owning device", async () => {
  const app = inputFixture(async () => ({
    admitted: true,
    queue: "steer",
    committed: true,
    messageId: "m",
  }));
  app.service.create("device-1", "stream-1", "chat-1", "turn-1");
  await assert.rejects(
    app.service.submitInput("device-1", "stream-1", { mode: "read", text: "x" }, "input-key-0000000008", inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  await assert.rejects(
    app.service.submitInput("device-1", "stream-1", { mode: "steer", text: "" }, "input-key-0000000008", inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  await assert.rejects(
    app.service.submitInput("device-2", "stream-1", { mode: "steer", text: "x" }, "input-key-0000000008", inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
  await assert.rejects(
    app.service.submitInput("device-1", "stream-1", { mode: "steer", text: "x" }, "short", inputPassthrough),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});

test("run input admission replays settled outcomes across a durable ledger restore", async () => {
  const { AidenIdempotencyLedger } = await import("./aiden-remote-operation-contract.js");
  const snapshots: unknown[] = [];
  const calls: unknown[] = [];
  const first = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    persistIdempotency: async (snapshot) => {
      snapshots.push(snapshot);
    },
    submitInput: async (input) => {
      calls.push(input);
      return { admitted: false, reason: "capacity", committed: false };
    },
  });
  first.create("device-1", "stream-1", "chat-1", "turn-1");
  const original = await first.submitInput(
    "device-1",
    "stream-1",
    { mode: "queue", text: "Remember this." },
    "input-key-durable-00001",
    inputPassthrough);
  assert.equal(original.status, "rejected");
  assert.equal(original.reason, "capacity");
  assert.equal(calls.length, 1);

  // A restart rebuilds the ledger from the persisted snapshot; the stream
  // record is gone, yet the settled rejection must still replay verbatim.
  const restored = new AidenRemoteStreamService({
    now: () => 2_000,
    cancel: () => true,
    approve: () => true,
    idempotency: new AidenIdempotencyLedger(snapshots[snapshots.length - 1] as never),
    persistIdempotency: async (snapshot) => {
      snapshots.push(snapshot);
    },
    submitInput: async (input) => {
      calls.push(input);
      return { admitted: true, queue: "follow-up", committed: true, messageId: "m" };
    },
  });
  const replayed = await restored.submitInput(
    "device-1",
    "stream-1",
    { mode: "queue", text: "Remember this." },
    "input-key-durable-00001",
    inputPassthrough);
  assert.deepEqual(replayed, original);
  assert.equal(calls.length, 1);
});

test("run input admission reports an unknown outcome when outcome persistence fails", async () => {
  let persists = 0;
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    persistIdempotency: async () => {
      persists += 1;
      if (persists > 1) throw new Error("disk lost");
    },
    submitInput: async () => ({
      admitted: true,
      queue: "steer",
      committed: true,
      messageId: "m",
    }),
  });
  service.create("device-1", "stream-1", "chat-1", "turn-1");
  await assert.rejects(
    service.submitInput(
      "device-1",
      "stream-1",
      { mode: "steer", text: "x" },
      "input-key-durable-00002",
      inputPassthrough),
    (error: unknown) =>
      (error as { code?: string }).code === "idempotency_in_flight",
  );
});

const QUESTION_PROMPT = {
  version: 1,
  promptId: "q-prompt-1",
  streamId: "stream-1",
  toolCallId: "tool-call-1",
  questions: [
    {
      question: "Which chamfer?",
      header: "Chamfer",
      multiSelect: false,
      options: [
        { label: "0.5 mm", description: "Standard." },
        { label: "1.0 mm", description: "Heavy." },
      ],
    },
    {
      question: "Which faces?",
      header: "Faces",
      multiSelect: true,
      options: [
        { label: "Front", description: "Front face." },
        { label: "Back", description: "Back face." },
      ],
    },
  ],
};

test("queued run input while a question is pending keeps the waiting state", async () => {
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: () => true,
    submitInput: async () => ({
      admitted: true,
      queue: "follow-up",
      committed: true,
      messageId: "message_remote_queued",
    }),
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  assert.equal(service.status("device-1", "stream-1").state, "waiting_for_approval");

  const result = await service.submitInput(
    "device-1",
    "stream-1",
    { mode: "queue", text: "Queue behind the prompt." },
    "input-key-question-queued",
    inputPassthrough,
  );
  assert.equal(result.status, "admitted");
  // The queued admission commits, but the run is still parked on the pending
  // question — reporting running would hide the prompt from clients.
  assert.equal(service.status("device-1", "stream-1").state, "waiting_for_approval");
  assert.equal(service.pendingQuestion("device-1", "stream-1")?.promptId, "q-prompt-1");
});

test("remote question prompts bind to their stream and resolve once", async () => {
  const settled: string[] = [];
  const changed: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: (promptId, response, ownerId) => {
      settled.push(`${promptId}:${response.cancelled}:${ownerId}`);
      return true;
    },
    notifyApprovalChanged: (chatId) => changed.push(chatId),
  });
  assert.equal(service.supportsQuestionPrompts(), true);
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);

  const pending = service.pendingQuestion("device-1", "stream-1");
  assert.equal(pending?.promptId, "q-prompt-1");
  assert.equal(pending?.questions.length, 2);
  assert.equal(pending?.expiresAt, "1970-01-01T00:05:01.000Z");
  assert.equal(service.status("device-1", "stream-1").state, "waiting_for_approval");
  assert.equal(service.questionChatId("device-1", "q-prompt-1"), "chat-1");
  assert.throws(
    () => service.questionChatId("device-2", "q-prompt-1"),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );

  const resolved = await service.respondQuestion(
    "device-1",
    "q-prompt-1",
    {
      cancelled: false,
      answers: [
        { questionIndex: 0, kind: "option", answer: "0.5 mm" },
        { questionIndex: 1, kind: "multi", selected: ["Front", "Back"] },
      ],
    },
    "question-answer-key-01",
    inputPassthrough,
  );
  assert.equal(resolved.promptId, "q-prompt-1");
  assert.equal(settled.length, 1);
  assert.equal(service.pendingQuestion("device-1", "stream-1"), null);
  assert.equal(service.status("device-1", "stream-1").state, "running");
  assert.deepEqual(changed, ["chat-1", "chat-1"]);
  assert.deepEqual(
    await service.respondQuestion(
      "device-1",
      "q-prompt-1",
      {
        cancelled: false,
        answers: [
          { questionIndex: 0, kind: "option", answer: "0.5 mm" },
          { questionIndex: 1, kind: "multi", selected: ["Front", "Back"] },
        ],
      },
      "question-answer-key-01",
    inputPassthrough,
    ),
    resolved,
  );
  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: true, answers: [] },
      "question-answer-key-01",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );
  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "0.5 mm" }] },
      "question-answer-key-02",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );
});

test("remote question responses are semantically validated against the stored prompt", async () => {
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: () => true,
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);

  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "2.0 mm" }] },
      "question-answer-key-03",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: false, answers: [{ questionIndex: 0, kind: "multi", selected: ["Front"] }] },
      "question-answer-key-04",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: false, answers: [{ questionIndex: 9, kind: "option", answer: "0.5 mm" }] },
      "question-answer-key-05",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
  const resolved = await service.respondQuestion(
    "device-1",
    "q-prompt-1",
    { cancelled: true, answers: [] },
    "question-answer-key-06",
    inputPassthrough,
  );
  assert.equal(resolved.promptId, "q-prompt-1");
});

test("remote questions expire and are dropped on terminal state", async () => {
  let now = 1_000;
  const settled: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => now,
    cancel: () => true,
    approve: () => true,
    respondQuestion: (promptId, response) => {
      settled.push(`${promptId}:${response.cancelled}`);
      return true;
    },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  now = 1_000 + 5 * 60 * 1_000;
  assert.throws(
    () => service.questionChatId("device-1", "q-prompt-1"),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );
  assert.deepEqual(settled, ["q-prompt-1:true"]);

  const owner2 = service.create("device-1", "stream-2", "chat-1", "turn-2");
  owner2.owner.send("chat:questionnaire", { ...QUESTION_PROMPT, promptId: "q-prompt-2", streamId: "stream-2" });
  assert.equal(service.pendingQuestion("device-1", "stream-2")?.promptId, "q-prompt-2");
  owner2.owner.send("chat:done", { chat: { messages: [{ id: "a-1", role: "assistant" }] } });
  assert.equal(service.pendingQuestion("device-1", "stream-2"), null);
  assert.throws(
    () => service.questionChatId("device-1", "q-prompt-2"),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );
});

test("questionnaire publishes reject unbound prompts and duplicate stream prompts", () => {
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: () => true,
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  assert.throws(() =>
    owner.owner.send("chat:questionnaire", { ...QUESTION_PROMPT, streamId: "stream-9" }));
  assert.equal(service.pendingQuestion("device-1", "stream-1"), null);
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  assert.throws(() =>
    owner.owner.send("chat:questionnaire", { ...QUESTION_PROMPT, promptId: "q-prompt-3" }));
  assert.equal(service.pendingQuestion("device-1", "stream-1")?.promptId, "q-prompt-1");
});

test("question prompts stay unadvertised without a host responder", () => {
  const app = fixture();
  assert.equal(app.service.supportsQuestionPrompts(), false);
});

test("resolving one pending surface keeps the other's waiting prompt", async () => {
  const questions: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: (promptId, response) => {
      questions.push(`${promptId}:${response.cancelled}`);
      return true;
    },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:approval", { approvalId: "approval-1", summary: "Change a file" });
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  assert.equal(service.status("device-1", "stream-1").state, "waiting_for_approval");

  // Resolving the approval must not drop the surviving question prompt.
  await service.respondApproval("device-1", "approval-1", "deny", "approval-coexist-key-01");
  assert.equal(service.status("device-1", "stream-1").state, "waiting_for_approval");
  assert.equal(service.pendingQuestion("device-1", "stream-1")?.promptId, "q-prompt-1");

  // Resolving the question then leaves no waiting surface.
  await service.respondQuestion(
    "device-1",
    "q-prompt-1",
    { cancelled: true, answers: [] },
    "question-coexist-key-01",
    inputPassthrough,
  );
  assert.equal(service.status("device-1", "stream-1").state, "running");

  // The symmetric case: question first, approval second.
  const owner2 = service.create("device-1", "stream-2", "chat-1", "turn-2");
  owner2.owner.send("chat:questionnaire", { ...QUESTION_PROMPT, promptId: "q-prompt-2", streamId: "stream-2" });
  owner2.owner.send("chat:approval", { approvalId: "approval-2", summary: "Run a command" });
  await service.respondQuestion(
    "device-1",
    "q-prompt-2",
    { cancelled: true, answers: [] },
    "question-coexist-key-02",
    inputPassthrough,
  );
  assert.equal(service.status("device-1", "stream-2").state, "waiting_for_approval");
  assert.equal(service.pendingApproval("device-1", "stream-2")?.approvalId, "approval-2");
});

test("revocation settles a revoked device's pending question without waiting for expiry", async () => {
  const settled: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: (promptId, response) => {
      settled.push(`${promptId}:${response.cancelled}`);
      return true;
    },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  const other = service.create("device-2", "stream-2", "chat-2", "turn-2");
  other.owner.send("chat:questionnaire", { ...QUESTION_PROMPT, promptId: "q-prompt-2", streamId: "stream-2" });

  await service.revokeDevice("device-1");
  assert.deepEqual(settled, ["q-prompt-1:true"]);
  assert.throws(
    () => service.questionChatId("device-1", "q-prompt-1"),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );
  assert.equal(service.pendingQuestion("device-2", "stream-2")?.promptId, "q-prompt-2");
});

test("cancellation settles a pending question with a cancelled response", async () => {
  const settled: string[] = [];
  const service = new AidenRemoteStreamService({
    now: () => 1_000,
    cancel: () => true,
    approve: () => true,
    respondQuestion: (promptId, response) => {
      settled.push(`${promptId}:${response.cancelled}`);
      return true;
    },
  });
  const owner = service.create("device-1", "stream-1", "chat-1", "turn-1");
  owner.owner.send("chat:questionnaire", QUESTION_PROMPT);
  assert.equal(service.pendingQuestion("device-1", "stream-1")?.promptId, "q-prompt-1");

  const cancelled = await service.cancel("device-1", "stream-1", "cancel-question-key-01");
  assert.equal(cancelled.state, "reconciling");
  assert.deepEqual(settled, ["q-prompt-1:true"]);
  assert.equal(service.pendingQuestion("device-1", "stream-1"), null);
  await assert.rejects(
    service.respondQuestion(
      "device-1",
      "q-prompt-1",
      { cancelled: true, answers: [] },
      "question-after-cancel-01",
    inputPassthrough,
    ),
    (error: unknown) => (error as { code?: string }).code === "question_expired",
  );
});

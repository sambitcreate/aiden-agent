import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import {
  AIDEN_REMOTE_RUN_EPOCH_HEADER,
  AidenRemoteHostRunService,
  type AidenRemoteHostRunControls,
  type AidenRemoteRunChatAccess,
} from "./aiden-remote-host-runs.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import { HostRunRegistry, type HostRunRegistryOptions } from "./host-run-registry.js";

class RecordingResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  destroyed = false;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(): this {
    this.writableEnded = true;
    queueMicrotask(() => this.emit("finish"));
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  frames(): Array<{ id: string; event: string; data: { sequence: number; terminal: boolean; payload: Record<string, unknown> } }> {
    return this.body
      .split("\n\n")
      .filter((block) => block.startsWith("id: "))
      .map((block) => {
        const [idLine, eventLine, dataLine] = block.split("\n");
        return {
          id: idLine!.slice("id: ".length),
          event: eventLine!.slice("event: ".length),
          data: JSON.parse(dataLine!.slice("data: ".length)),
        };
      });
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

const controller = (id: string) => ({
  id,
  capabilities: new Set<AidenRemoteCapability>(["runs:observe", "runs:control"]),
});
const observer = (id: string) => ({
  id,
  capabilities: new Set<AidenRemoteCapability>(["runs:observe"]),
});

const KEY_A = "key-controller-a-0001";
const KEY_B = "key-controller-b-0001";

function approval(approvalId: string, extra: Record<string, unknown> = {}) {
  return {
    approvalId,
    summary: "Run npm test",
    toolCallId: "call-a",
    toolName: "run_command",
    scopes: ["once", "chat"],
    details: { command: "npm test", cwd: "/work/aiden" },
    ...extra,
  };
}

function questionnaire(promptId: string, runId: string) {
  return {
    version: 1,
    promptId,
    streamId: runId,
    toolCallId: "call-q",
    questions: [{
      question: "Which branch should I target?",
      header: "Branch",
      options: [
        { label: "main", description: "The default branch." },
        { label: "release", description: "The release branch." },
      ],
    }],
    expiresAt: "2026-10-02T12:00:00.000Z",
  };
}

/**
 * A real HostRunRegistry behind host-authority controls that behave like the
 * production ones: the first settlement wins and later ones report false.
 */
function harness(registryOptions: Partial<HostRunRegistryOptions> = {}) {
  const clock = { now: 10_000 };
  const registry = new HostRunRegistry({ now: () => clock.now, epoch: "epoch-runs", ...registryOptions });
  const effects = { cancels: 0, approvals: [] as string[], answers: 0, inputs: [] as string[] };
  const controls: AidenRemoteHostRunControls = {
    cancel(runId) {
      effects.cancels += 1;
      const summary = registry.summary(runId);
      if (!summary || summary.state === "done" || summary.state === "cancelled") return false;
      registry.publish(runId, "chat:done", { cancelled: true });
      return true;
    },
    approve({ approvalId, decision }) {
      if (!registry.pendingPrompt(approvalId)) return false;
      effects.approvals.push(`${approvalId}:${decision}`);
      registry.resolveAttention(approvalId, { kind: "approval", decision });
      return true;
    },
    answer({ promptId }) {
      if (!registry.pendingPrompt(promptId)) return "rejected";
      effects.answers += 1;
      registry.resolveAttention(promptId, { kind: "question", outcome: "answered" });
      return "answered";
    },
    async admitInput({ mode, text }) {
      effects.inputs.push(`${mode}:${text}`);
      return { admitted: true, queue: mode === "steer" ? "steer" : "follow-up", committed: true, messageId: "message-1" };
    },
  };
  const service = new AidenRemoteHostRunService({ registry, controls, now: () => clock.now });
  const accessed: string[] = [];
  const access: AidenRemoteRunChatAccess = async (chatId, action) => {
    accessed.push(chatId);
    return action();
  };
  registry.begin({ runId: "run-1", chatId: "chat-1", origin: "renderer" });
  return { clock, registry, service, effects, access, accessed };
}

function open(service: AidenRemoteHostRunService, device: ReturnType<typeof controller>, runId: string, after = 0) {
  const response = new RecordingResponse();
  service.openRunEvents(device, runId, after, response.asServerResponse());
  return response;
}

async function rejection(promise: Promise<unknown>): Promise<AidenRemoteServiceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AidenRemoteServiceError, String(error));
    return error;
  }
  assert.fail("expected the request to be rejected");
}

function thrown(action: () => unknown): AidenRemoteServiceError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof AidenRemoteServiceError, String(error));
    return error;
  }
  assert.fail("expected the request to be rejected");
}

test("a run stream replays the journal, follows live events and ends with run.ended", async () => {
  const { registry, service } = harness();
  registry.publish("run-1", "chat:delta", { delta: "Hello" });
  const response = open(service, controller("device-a"), "run-1");
  assert.equal(response.status, 200);
  assert.equal(response.headers[AIDEN_REMOTE_RUN_EPOCH_HEADER], "epoch-runs");

  registry.publish("run-1", "chat:delta", { delta: " there" });
  registry.publish("run-1", "chat:done", {
    chat: { messages: [{ id: "assistant-1", role: "assistant" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const frames = response.frames();
  assert.deepEqual(frames[0]!.data.payload, { runId: "run-1", chatId: "chat-1", origin: "renderer" });
  assert.equal(frames[0]!.event, "run.started");
  const tail = frames.slice(-2);
  assert.deepEqual(tail.map((frame) => [frame.event, frame.data.terminal]), [["done", true], ["run.ended", true]]);
  // run.ended repeats the terminal event's sequence; it is not a duplicate.
  assert.equal(tail[1]!.id, tail[0]!.id);
  assert.deepEqual(tail[1]!.data.payload, { runId: "run-1", chatId: "chat-1", state: "done" });
  assert.deepEqual(
    frames.map((frame) => frame.data.sequence),
    [...frames.slice(0, -1).map((_, index) => index + 1), tail[0]!.data.sequence],
  );
  assert.equal(response.writableEnded, true);
});

test("Last-Event-ID resumes after the cursor, and a cursor ahead of the journal is refused", () => {
  const { registry, service } = harness();
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  registry.publish("run-1", "chat:questionnaire", questionnaire("prompt-1", "run-1"));
  const head = registry.summary("run-1")!.lastSequence;

  const resumed = open(service, controller("device-a"), "run-1", head - 1);
  assert.deepEqual(resumed.frames().map((frame) => [Number(frame.id), frame.event]), [[head, "question_required"]]);

  const error = thrown(() => open(service, controller("device-a"), "run-1", head + 1));
  assert.equal(error.code, "invalid_request");
  assert.equal(error.status, 400);
});

test("a cursor behind retention gets a gap snapshot carrying every pending prompt", () => {
  const { registry, service } = harness({ maxEventsPerRun: 3 });
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  for (const delta of ["a", "b", "c", "d"]) registry.publish("run-1", "chat:delta", { delta });

  const response = open(service, controller("device-a"), "run-1", 0);
  const [snapshot, ...rest] = response.frames();
  assert.equal(snapshot!.event, "snapshot");
  const payload = snapshot!.data.payload as Record<string, unknown> & { approvals: Array<Record<string, unknown>> };
  assert.equal(payload.reason, "gap");
  assert.equal(payload.epoch, "epoch-runs");
  assert.equal(payload.state, "needs_approval");
  assert.deepEqual(payload.pendingApprovalIds, ["approval-1"]);
  assert.equal(payload.approvals[0]!.approvalId, "approval-1");
  assert.deepEqual(payload.approvals[0]!.details, { command: "npm test", cwd: "/work/aiden" });
  assert.equal(snapshot!.data.sequence, (payload.nextSequence as number) - 1);
  // After the snapshot the stream continues contiguously from the retained head.
  assert.deepEqual(
    rest.map((frame) => frame.data.sequence),
    rest.map((_, index) => (payload.nextSequence as number) + index),
  );
  assert.equal(rest[rest.length - 1]!.data.sequence, registry.summary("run-1")!.lastSequence);
});

test("an unknown run is run_gone on every run route", async () => {
  const { service, access } = harness();
  for (const error of [
    thrown(() => open(service, controller("device-a"), "run-missing")),
    thrown(() => service.chatIdForRun("run-missing")),
    thrown(() => service.currentRunId("chat-missing")),
    await rejection(service.cancel("device-a", "run-missing", KEY_A, access)),
    await rejection(service.submitInput("device-a", "run-missing", { mode: "queue", text: "hi" }, KEY_A, access)),
    await rejection(
      service.respondApproval("device-a", "run-missing", "approval-1", { decision: "deny" }, KEY_A, access),
    ),
  ]) {
    assert.equal(error.code, "run_gone");
    assert.equal(error.status, 404);
  }
});

test("observers without runs:control see the approval summary but not its tool details", () => {
  const { registry, service } = harness();
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  const observed = open(service, observer("device-observe"), "run-1");
  const controlled = open(service, controller("device-control"), "run-1");

  const observedPrompt = observed.frames().find((frame) => frame.event === "approval_required")!;
  const controlledPrompt = controlled.frames().find((frame) => frame.event === "approval_required")!;
  assert.equal(observedPrompt.data.payload.summary, "Run npm test");
  assert.equal("details" in observedPrompt.data.payload, false);
  assert.deepEqual(controlledPrompt.data.payload.details, { command: "npm test", cwd: "/work/aiden" });
});

test("two controllers racing one approval: one wins, the loser learns the winning decision", async () => {
  const { registry, service, effects, access } = harness();
  registry.publish("run-1", "chat:approval", approval("approval-1"));

  const [first, second] = await Promise.allSettled([
    service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_A, access),
    service.respondApproval("device-b", "run-1", "approval-1", { decision: "deny" }, KEY_B, access),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  const winner = (first as PromiseFulfilledResult<Awaited<ReturnType<typeof service.respondApproval>>>).value;
  assert.equal(winner.decision, "allow");
  assert.deepEqual(effects.approvals, ["approval-1:allow"]);

  const loser = (second as PromiseRejectedResult).reason as AidenRemoteServiceError;
  assert.equal(loser.code, "approval_resolved");
  assert.equal(loser.status, 409);
  assert.deepEqual(loser.details, { decision: "allow", resolvedAt: winner.resolvedAt });

  // Each replay returns its original result without a second effect.
  assert.deepEqual(
    await service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_A, access),
    winner,
  );
  const replayedLoss = await rejection(
    service.respondApproval("device-b", "run-1", "approval-1", { decision: "deny" }, KEY_B, access),
  );
  assert.equal(replayedLoss.code, "approval_resolved");
  assert.deepEqual(replayedLoss.details, loser.details);
  assert.deepEqual(effects.approvals, ["approval-1:allow"]);
});

test("a reused Idempotency-Key with a different body is refused, and malformed keys are rejected", async () => {
  const { registry, service, access, effects } = harness();
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  await service.respondApproval("device-a", "run-1", "approval-1", { decision: "deny" }, KEY_A, access);

  const conflict = await rejection(
    service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_A, access),
  );
  assert.equal(conflict.status, 409);
  assert.notEqual(conflict.code, "approval_resolved");

  for (const key of ["", "short-key", "spaces are not allowed!", "k".repeat(129), "naïve-key-0000000000"]) {
    const invalid = await rejection(service.cancel("device-a", "run-1", key, access));
    assert.equal(invalid.code, "invalid_request", key);
  }
  assert.equal(effects.cancels, 0);
  assert.deepEqual(effects.approvals, ["approval-1:deny"]);
});

test("allowing an approval whose details were withheld must happen on the host", async () => {
  const { registry, service, access, effects } = harness({ maxEventBytesPerRun: 2_048 });
  registry.publish("run-1", "chat:approval", approval("approval-1", { details: { blob: "x".repeat(4_096) } }));
  assert.equal(registry.pendingPrompt("approval-1")!.payload.detailsOmitted, true);

  const refused = await rejection(
    service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_A, access),
  );
  assert.equal(refused.code, "capability_denied");
  assert.equal(refused.status, 403);
  assert.deepEqual(effects.approvals, []);

  const denied = await service.respondApproval("device-a", "run-1", "approval-1", { decision: "deny" }, KEY_B, access);
  assert.equal(denied.decision, "deny");
});

test("a command whose summary was cut short can be denied remotely but allowed only on the host", async () => {
  const { registry, service, access, effects } = harness();
  // A generic command approval: the whole command is the summary, with no details.
  const command = `Run command: echo ${"x".repeat(2_100)}; rm -rf ~/work`;
  registry.publish("run-1", "chat:approval", approval("approval-1", { summary: command, details: undefined }));
  const journaled = registry.pendingPrompt("approval-1")!.payload;
  assert.equal(String(journaled.summary).includes("rm -rf"), false, "the end of the command did not fit");
  assert.equal(journaled.detailsOmitted, true);

  const refused = await rejection(
    service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_A, access),
  );
  assert.equal(refused.code, "capability_denied");
  assert.deepEqual(effects.approvals, []);

  const denied = await service.respondApproval("device-a", "run-1", "approval-1", { decision: "deny" }, KEY_B, access);
  assert.equal(denied.decision, "deny");
});

test("a prompt from another run is not_found and an unoffered scope is invalid", async () => {
  const { registry, service, access } = harness();
  registry.begin({ runId: "run-2", chatId: "chat-2", origin: "remote" });
  registry.publish("run-2", "chat:approval", approval("approval-2", { scopes: ["once"] }));

  const foreign = await rejection(
    service.respondApproval("device-a", "run-1", "approval-2", { decision: "deny" }, KEY_A, access),
  );
  assert.equal(foreign.code, "not_found");

  const scope = await rejection(
    service.respondApproval("device-a", "run-2", "approval-2", { decision: "allow", scope: "workspace" }, KEY_B, access),
  );
  assert.equal(scope.code, "invalid_request");
});

test("two controllers racing one question: the loser learns the outcome", async () => {
  const { registry, service, access, effects } = harness();
  registry.publish("run-1", "chat:questionnaire", questionnaire("prompt-1", "run-1"));
  const body = { cancelled: false, answers: [{ selected: ["main"] }] };

  const won = await service.respondQuestion("device-a", "run-1", "prompt-1", body, KEY_A, access);
  assert.equal(won.outcome, "answered");
  const lost = await rejection(service.respondQuestion("device-b", "run-1", "prompt-1", body, KEY_B, access));
  assert.equal(lost.code, "question_already_resolved");
  assert.deepEqual(lost.details, { outcome: "answered", resolvedAt: won.resolvedAt });
  assert.equal(effects.answers, 1);
});

test("cancel stops a live run once and a finished run is operation_stale", async () => {
  const { registry, service, access, accessed, effects } = harness();
  const cancelled = await service.cancel("device-a", "run-1", KEY_A, access);
  assert.deepEqual(cancelled, { runId: "run-1", chatId: "chat-1", state: "cancelled", cancelRequested: true });
  assert.deepEqual(accessed, ["chat-1"]);
  assert.equal(registry.summary("run-1")!.state, "cancelled");

  assert.deepEqual(await service.cancel("device-a", "run-1", KEY_A, access), cancelled);
  const stale = await rejection(service.cancel("device-b", "run-1", KEY_B, access));
  assert.equal(stale.code, "operation_stale");
  assert.equal(effects.cancels, 1);
});

test("chat access is checked inside the control and a refusal causes no effect", async () => {
  const { registry, service, effects } = harness();
  registry.publish("run-1", "chat:approval", approval("approval-1"));
  const deny: AidenRemoteRunChatAccess = async () => {
    throw new AidenRemoteServiceError("capability_denied", "Bot chats need bot:write.", 403);
  };
  const error = await rejection(service.cancel("device-a", "run-1", KEY_A, deny));
  assert.equal(error.code, "capability_denied");
  const approvalError = await rejection(
    service.respondApproval("device-a", "run-1", "approval-1", { decision: "allow" }, KEY_B, deny),
  );
  assert.equal(approvalError.code, "capability_denied");
  assert.equal(effects.cancels, 0);
  assert.deepEqual(effects.approvals, []);
  assert.equal(registry.summary("run-1")!.state, "needs_approval");
});

test("inputs are admitted once per key and malformed inputs are refused", async () => {
  const { service, access, effects } = harness();
  const admitted = await service.submitInput("device-a", "run-1", { mode: "steer", text: "Use pnpm" }, KEY_A, access);
  assert.deepEqual(admitted, {
    runId: "run-1",
    chatId: "chat-1",
    mode: "steer",
    status: "admitted",
    queue: "steer",
    committed: true,
    messageId: "message-1",
  });
  await service.submitInput("device-a", "run-1", { mode: "steer", text: "Use pnpm" }, KEY_A, access);
  assert.deepEqual(effects.inputs, ["steer:Use pnpm"]);

  for (const body of [{ mode: "steer", text: "   " }, { mode: "shout", text: "hi" }, { mode: "queue", text: "hi", extra: 1 }]) {
    const invalid = await rejection(service.submitInput("device-a", "run-1", body, KEY_B, access));
    assert.equal(invalid.code, "invalid_request");
  }
});

test("revocation closes a device's run streams but never cancels the run", () => {
  const { registry, service, effects } = harness();
  const revoked = open(service, controller("device-revoked"), "run-1");
  const kept = open(service, controller("device-kept"), "run-1");

  service.revokeDevice("device-revoked");
  assert.equal(revoked.destroyed, true);
  assert.equal(kept.destroyed, false);
  assert.equal(effects.cancels, 0);
  assert.equal(registry.summary("run-1")!.state, "working");

  registry.publish("run-1", "chat:delta", { delta: "still running" });
  const keptFrames = kept.frames();
  assert.equal(keptFrames[keptFrames.length - 1]!.event, "text_delta");
  assert.equal(revoked.frames().length, 1);
});

test("a run stream refused at admission writes nothing and never follows the run", () => {
  const { registry, service } = harness();
  const refusedResponse = new RecordingResponse();
  const refused = thrown(() =>
    service.openRunEvents(controller("device-revoked"), "run-1", 0, refusedResponse.asServerResponse(), () => {
      throw new AidenRemoteServiceError("credential_revoked", "This device was revoked.", 403);
    }));
  assert.equal(refused.code, "credential_revoked");
  assert.equal(refusedResponse.status, 0);

  const kept = open(service, controller("device-kept"), "run-1");
  registry.publish("run-1", "chat:delta", { delta: "after revocation" });
  assert.equal(refusedResponse.body, "");
  const keptFrames = kept.frames();
  assert.equal(keptFrames[keptFrames.length - 1]!.event, "text_delta");
  assert.equal(registry.summary("run-1")!.state, "working");
});

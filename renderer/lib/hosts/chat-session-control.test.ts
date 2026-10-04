import assert from "node:assert/strict";
import test from "node:test";
import { ChatSessionControl } from "./chat-session-control";
import {
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatCapability,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";

const ALL: HostChatCapability[] = ["send", "cancel", "respondApproval", "answerQuestion", "steer", "rename", "remove"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * A host that keeps one turn per idempotency key, like the real ledger, and
 * can lose the acknowledgement of the next request.
 */
class FakeHost implements HostChatAdapter {
  readonly hostId = "host-b";
  current: HostChatStatus = { availability: "online", generation: 1 };
  granted = new Set<HostChatCapability>(ALL);
  readonly turns = new Map<string, { chatId: string; text: string }>();
  readonly calls: string[] = [];
  loseNextAck = false;
  approval: (chatId: string, input: HostChatApprovalInput) => Promise<HostChatApprovalResult> = async () => ({
    resolution: "applied",
  });
  private readonly listeners = new Set<(status: HostChatStatus) => void>();

  capabilities() {
    return this.granted;
  }
  ready() {
    return Promise.resolve();
  }
  status() {
    return this.current;
  }
  setStatus(status: HostChatStatus) {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
  onStatus(listener: (status: HostChatStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onChatChanged() {
    return () => {};
  }
  getMessagesWindow(): never {
    throw new Error("unused");
  }
  observe() {
    return () => {};
  }
  markRead() {
    return Promise.resolve({ ok: true as const, value: undefined });
  }
  async send(chatId: string, input: { text: string; idempotencyKey: string }): Promise<HostChatTurnReceipt> {
    this.calls.push(`send:${chatId}`);
    if (!this.turns.has(input.idempotencyKey)) this.turns.set(input.idempotencyKey, { chatId, text: input.text });
    const turnId = `turn-${[...this.turns.keys()].indexOf(input.idempotencyKey) + 1}`;
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new HostChatControlError({ code: "outcome_unknown", message: "lost" });
    }
    return { turnId, streamId: `run-${turnId}` };
  }
  async cancel(chatId: string, input: { runId: string }) {
    this.calls.push(`cancel:${chatId}:${input.runId}`);
    return true;
  }
  respondApproval(chatId: string, input: HostChatApprovalInput) {
    this.calls.push(`approval:${chatId}:${input.approvalId}`);
    return this.approval(chatId, input);
  }
  async answerQuestion(chatId: string, input: { promptId: string }) {
    this.calls.push(`question:${chatId}:${input.promptId}`);
    return { status: "elsewhere" as const };
  }
  async submitInput(chatId: string, input: { runId: string; mode: string }) {
    this.calls.push(`input:${chatId}:${input.runId}:${input.mode}`);
    return { admitted: true, committed: true, messageId: "m-steer" };
  }
  async rename(chatId: string) {
    this.calls.push(`rename:${chatId}`);
  }
  async remove(chatId: string) {
    this.calls.push(`remove:${chatId}`);
  }
  dispose() {}
}

function session(host = new FakeHost(), chatId = "chat-1") {
  const control = new ChatSessionControl(host, { hostId: host.hostId, chatId });
  const detach = control.attach();
  return { host, control, detach };
}

test("a lost send acknowledgement is held for a same-key retry and never resent on its own", async () => {
  const { host, control } = session();
  host.loseNextAck = true;
  await assert.rejects(control.send("Ship it"), { code: "outcome_unknown" });

  const unresolved = control.getSnapshot().unresolved;
  assert.equal(unresolved?.kind, "send");
  assert.equal(unresolved?.text, "Ship it");
  assert.equal(host.calls.length, 1, "nothing is resent automatically");

  // A new message is refused until the unresolved one is retried or dismissed.
  await assert.rejects(control.send("Another"), { code: "unresolved" });

  await control.retryUnresolved();
  assert.equal(control.getSnapshot().unresolved, null);
  assert.equal(host.calls.length, 2);
  assert.deepEqual([...host.turns.values()], [{ chatId: "chat-1", text: "Ship it" }], "the retry reused the key: one turn");
});

test("a retry whose answer is lost again keeps the same key for the next try", async () => {
  const { host, control } = session();
  host.loseNextAck = true;
  await assert.rejects(control.send("Once"), { code: "outcome_unknown" });
  const key = control.getSnapshot().unresolved?.idempotencyKey;

  host.loseNextAck = true;
  await assert.rejects(control.retryUnresolved(), { code: "outcome_unknown" });
  assert.equal(control.getSnapshot().unresolved?.idempotencyKey, key);
  assert.equal(control.getSnapshot().unresolved?.retrying, false);

  await control.retryUnresolved();
  assert.equal(host.turns.size, 1);
});

test("dismissing an unresolved send forgets it without contacting the host", async () => {
  const { host, control } = session();
  host.loseNextAck = true;
  await assert.rejects(control.send("Maybe"), { code: "outcome_unknown" });
  assert.equal(control.dismissUnresolved()?.text, "Maybe");
  assert.equal(control.getSnapshot().unresolved, null);
  assert.equal(host.calls.length, 1);

  await control.send("Fresh");
  assert.equal(host.turns.size, 2, "a new intent gets a new key");
});

test("an offline or blocked host refuses every mutation with a reason and queues nothing", async () => {
  const { host, control } = session();
  host.setStatus({ availability: "offline", generation: 2 });
  assert.match(control.refusal("send") ?? "", /offline/i);
  await assert.rejects(control.send("Hello"), { code: "host_unavailable" });
  await assert.rejects(control.cancel("run-1"), { code: "host_unavailable" });
  await assert.rejects(control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "allow" }), {
    code: "host_unavailable",
  });

  host.setStatus({ availability: "blocked", blockedReason: "auth", generation: 3 });
  await assert.rejects(control.rename("Title", "rev-1"), { code: "host_unavailable" });

  host.setStatus({ availability: "online", generation: 4 });
  assert.equal(control.getSnapshot().status.generation, 4);
  assert.deepEqual(host.calls, [], "nothing was queued for when the host returned");
});

test("an action the host does not grant is refused instead of running on this Mac", async () => {
  const host = new FakeHost();
  host.granted = new Set<HostChatCapability>(["send"]);
  const { control } = session(host);
  assert.match(control.refusal("respondApproval") ?? "", /other Mac/);
  await assert.rejects(control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "deny" }), { code: "unsupported" });
  await assert.rejects(control.submitInput("run-1", "steer", "left"), { code: "unsupported" });
  assert.deepEqual(host.calls, []);
});

test("a lost approval race shows who answered first", async () => {
  const { host, control } = session();
  host.approval = async () => ({ resolution: "elsewhere", decision: "deny" });
  const result = await control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "allow" });
  assert.deepEqual(result, { resolution: "elsewhere", decision: "deny" });
  assert.deepEqual(control.getSnapshot().elsewhere, { kind: "approval", id: "a1", decision: "deny" });
  assert.equal(control.getSnapshot().decidingApprovalId, null);

  const question = await control.answerQuestion({
    runId: "run-1",
    promptId: "q1",
    response: { version: 1, promptId: "q1", cancelled: true, answers: [] },
  });
  assert.equal(question?.status, "elsewhere");
  assert.deepEqual(control.getSnapshot().elsewhere, { kind: "question", id: "q1" });
});

test("only one approval decision is in flight at a time", async () => {
  const { host, control } = session();
  const pending = deferred<HostChatApprovalResult>();
  host.approval = () => pending.promise;
  const first = control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "allow" });
  assert.equal(control.getSnapshot().decidingApprovalId, "a1");
  assert.equal(await control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "deny" }), null);
  pending.resolve({ resolution: "applied" });
  assert.deepEqual(await first, { resolution: "applied" });
  assert.deepEqual(host.calls, ["approval:chat-1:a1"]);
});

test("switching chats never retargets in-flight work or lets it touch the new chat", async () => {
  const host = new FakeHost();
  const first = session(host, "chat-1");
  const pending = deferred<HostChatApprovalResult>();
  host.approval = () => pending.promise;
  const decision = first.control.respondApproval({ runId: "run-1", approvalId: "a1", decision: "allow" });

  // The pane moves to another chat on the same host while the decision is in flight.
  first.detach();
  const second = session(host, "chat-2");
  assert.equal(second.control.getSnapshot().decidingApprovalId, null);

  pending.resolve({ resolution: "elsewhere", decision: "deny" });
  await decision;
  assert.deepEqual(host.calls, ["approval:chat-1:a1"], "the decision went to the chat it started on");
  assert.equal(second.control.getSnapshot().elsewhere, null, "the late answer did not land on the new chat");

  await second.control.cancel("run-2");
  assert.equal(host.calls[host.calls.length - 1], "cancel:chat-2:run-2");
});

test("a session refuses an adapter for another host", () => {
  assert.throws(() => new ChatSessionControl(new FakeHost(), { hostId: "host-c", chatId: "chat-1" }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { ChatSessionControl } from "./chat-session-control";
import { ChatIntentLedger } from "./chat-intent-ledger";
import {
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatAttachmentUpload,
  type HostChatCapability,
  type HostChatSendInput,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";

const ALL: HostChatCapability[] = ["send", "cancel", "respondApproval", "answerQuestion", "steer", "rename", "remove", "attach", "skills"];

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
  readonly turns = new Map<string, { chatId: string; text: string; attachmentIds?: string[]; skill?: string }>();
  readonly staged = new Map<string, { chatId: string; name: string }>();
  readonly calls: string[] = [];
  loseNextAck = false;
  refuseNextSend = false;
  /** Upload attempts (1-based) whose acknowledgement is lost. */
  readonly lostUploads = new Set<number>();
  /** Holds every upload until it settles, to observe the session mid-upload. */
  uploadGate: Promise<void> | null = null;
  /** Unused uploads the host keeps per chat before refusing more, like the real host's limit. */
  uploadLimit = Infinity;
  /** The next send is lost on the way: the host never sees it and the answer never arrives. */
  dropNextSend = false;
  private uploads = 0;
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
  async uploadAttachment(chatId: string, upload: HostChatAttachmentUpload) {
    await this.uploadGate;
    if ([...this.staged.values()].filter((entry) => entry.chatId === chatId).length >= this.uploadLimit) {
      throw new HostChatControlError({ code: "rate_limited", message: "Too many unused attachments." });
    }
    this.uploads += 1;
    const id = `att-${this.uploads}`;
    this.calls.push(`upload:${chatId}:${upload.name}`);
    this.staged.set(id, { chatId, name: upload.name });
    if (this.lostUploads.has(this.uploads)) throw new HostChatControlError({ code: "outcome_unknown", message: "lost" });
    return { id, name: upload.name, size: 1 };
  }
  async removeAttachment(chatId: string, attachmentId: string) {
    this.calls.push(`release:${chatId}:${attachmentId}`);
    this.staged.delete(attachmentId);
  }
  async send(chatId: string, input: HostChatSendInput): Promise<HostChatTurnReceipt> {
    this.calls.push(`send:${chatId}`);
    if (this.dropNextSend) {
      this.dropNextSend = false;
      throw new HostChatControlError({ code: "outcome_unknown", message: "lost" });
    }
    if (this.refuseNextSend) {
      this.refuseNextSend = false;
      throw new HostChatControlError({ code: "busy", message: "A turn is already running." });
    }
    if (!this.turns.has(input.idempotencyKey)) {
      this.turns.set(input.idempotencyKey, {
        chatId,
        text: input.text,
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.skill ? { skill: input.skill.displayName } : {}),
      });
      for (const id of input.attachmentIds ?? []) this.staged.delete(id);
    }
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
  const control = new ChatSessionControl(host, { hostId: host.hostId, chatId }, new ChatIntentLedger());
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
  assert.equal((await control.dismissUnresolved())?.text, "Maybe");
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

const notes: HostChatAttachmentUpload = { name: "notes.md", mimeType: "text/markdown", kind: "text", text: "# Notes" };
const shot: HostChatAttachmentUpload = { name: "shot.png", mimeType: "image/png", kind: "image", data: "iVBORw0KGgo=" };

test("attachments are staged on the chat's host and consumed by the turn they were sent with", async () => {
  const { host, control } = session();
  const gate = deferred<void>();
  host.uploadGate = gate.promise;
  const sent = control.send("Read these", { attachments: [notes, shot] });
  assert.equal(control.getSnapshot().sending, true, "the composer shows the send as in progress while files upload");
  gate.resolve();
  await sent;
  assert.equal(control.getSnapshot().sending, false);

  const [turn] = [...host.turns.values()];
  assert.deepEqual(turn, { chatId: "chat-1", text: "Read these", attachmentIds: ["att-1", "att-2"] });
  assert.equal(host.staged.size, 0, "the turn consumed every upload");
  assert.deepEqual(host.calls, ["upload:chat-1:notes.md", "upload:chat-1:shot.png", "send:chat-1"]);
});

test("a pane reopened while a send's files upload waits for that send instead of offering its text again", async () => {
  const host = new FakeHost();
  const ledger = new ChatIntentLedger();
  const ref = { hostId: host.hostId, chatId: "chat-1" };
  const gate = deferred<void>();
  host.uploadGate = gate.promise;
  const earlier = new ChatSessionControl(host, ref, ledger);
  const detach = earlier.attach();
  const sent = earlier.send("Read these", { attachments: [notes] });
  detach();

  const reopened = new ChatSessionControl(host, ref, ledger);
  reopened.attach();
  const settled = reopened.submissionsSettled();
  assert.ok(settled, "the message is still in flight while its files upload");
  assert.equal(reopened.getSnapshot().sending, true);

  gate.resolve();
  await sent;
  await settled;
  assert.equal(reopened.getSnapshot().sending, false);
  assert.equal(host.turns.size, 1);
});

test("a lost upload releases the files already confirmed and sends nothing", async () => {
  const { host, control } = session();
  host.lostUploads.add(2);
  await assert.rejects(control.send("Read these", { attachments: [notes, shot] }), {
    code: "upload_failed",
    retryable: true,
  });
  await Promise.resolve();

  assert.equal(host.turns.size, 0);
  // The first upload is released; the one whose answer was lost has no known id and expires on the host.
  assert.deepEqual([...host.staged.keys()], ["att-2"]);
  assert.equal(control.getSnapshot().unresolved, null, "an upload failure is a plain retryable error, not an unresolved send");
  assert.equal(control.getSnapshot().sending, false, "the composer can send again");
});

test("a turn the host refuses releases its uploads, while a lost turn keeps them for the retry", async () => {
  const { host, control } = session();
  host.refuseNextSend = true;
  await assert.rejects(control.send("First", { attachments: [notes] }), { code: "busy" });
  await Promise.resolve();
  assert.equal(host.staged.size, 0);

  host.loseNextAck = true;
  await assert.rejects(control.send("Second", { attachments: [notes] }), { code: "outcome_unknown" });
  assert.equal(host.staged.size, 0, "the host consumed the upload with the turn whose answer was lost");
  await control.retryUnresolved();
  assert.equal(host.turns.size, 1, "the retry replayed the same turn");
  assert.deepEqual([...host.turns.values()][0]?.attachmentIds, ["att-2"]);
});

test("dismissing a send that never arrived frees its uploads, so the next attachment still fits", async () => {
  const { host, control } = session();
  host.uploadLimit = 1;
  host.dropNextSend = true;
  await assert.rejects(control.send("First", { attachments: [notes] }), { code: "outcome_unknown" });
  assert.equal(host.staged.size, 1, "the host still holds the upload the lost turn never used");

  await control.dismissUnresolved();
  await control.send("Second", { attachments: [notes] });
  assert.deepEqual([...host.turns.values()].map((turn) => turn.text), ["Second"]);
  assert.equal(host.staged.size, 0);
});

test("a retry the host refuses frees the original uploads, so the next attachment still fits", async () => {
  const { host, control } = session();
  host.uploadLimit = 1;
  host.dropNextSend = true;
  await assert.rejects(control.send("First", { attachments: [notes] }), { code: "outcome_unknown" });

  host.refuseNextSend = true;
  await assert.rejects(control.retryUnresolved(), { code: "busy" });
  assert.equal(control.getSnapshot().unresolved, null);
  await control.send("Second", { attachments: [notes] });
  assert.deepEqual([...host.turns.values()].map((turn) => turn.text), ["Second"]);
});

test("attachments and skills are refused when the host does not grant them, before anything is uploaded", async () => {
  const { host, control } = session();
  host.granted = new Set<HostChatCapability>(["send"]);
  await assert.rejects(control.send("Read", { attachments: [notes] }), { code: "unsupported" });
  await assert.rejects(
    control.send("Run", { skill: { version: 1, invocationId: "skl_review", displayName: "review", source: "workspace" } }),
    { code: "unsupported" },
  );
  assert.deepEqual(host.calls, []);
});

test("an acknowledged host turn with a lost response cannot be replayed after retention expires", async () => {
  const host = new FakeHost();
  let now = Date.parse("2026-10-06T12:00:00Z");
  const ledger = new ChatIntentLedger(undefined, () => now);
  const control = new ChatSessionControl(host, { hostId: host.hostId, chatId: "chat-expired" }, ledger);
  control.attach();
  host.loseNextAck = true;
  await assert.rejects(control.send("Run the deployment"), { code: "outcome_unknown" });
  now += 25 * 60 * 60 * 1_000;
  host.turns.clear(); // The host has forgotten its settled idempotency entry.
  const calls = host.calls.length;
  await assert.rejects(control.retryUnresolved(), { code: "retry_expired" });
  assert.equal(host.calls.length, calls, "an expired retry must not reach the host");
  assert.equal(control.getSnapshot().unresolved?.retryAllowed, false);
  await assert.rejects(control.send("Run the deployment"), { code: "unresolved" });
});

test("saved ambiguous sends restore after renderer loss with exact attachment, skill and key identity", async () => {
  const { PeerIntentStore } = await import("../../../main/services/peer-intent-store");
  let disk: import("../../../main/services/peer-intent-store").BoundIntent[] = [];
  const store = new PeerIntentStore({ load: async () => structuredClone(disk), save: async rows => { disk = structuredClone(rows); } }, async () => "paired-device-1");
  const persistence = { list: store.list.bind(store), put: store.put.bind(store), remove: store.remove.bind(store) };
  const host = new FakeHost();
  const ref = { hostId: host.hostId, chatId: "chat-restored" };
  const first = new ChatSessionControl(host, ref, new ChatIntentLedger(persistence));
  const detach = first.attach();
  host.loseNextAck = true;
  await assert.rejects(first.send("Inspect the attached notes", { attachments: [{ kind: "text", name: "notes.txt", mimeType: "text/plain", text: "Release notes" }] }), { code: "outcome_unknown" });
  assert.equal(disk.length, 1);
  const originalKey = disk[0]!.intent.idempotencyKey;
  detach();
  const restored = new ChatSessionControl(host, ref, new ChatIntentLedger(persistence));
  restored.attach();
  await restored.restore();
  assert.equal(restored.getSnapshot().unresolved?.idempotencyKey, originalKey);
  assert.equal(restored.getSnapshot().unresolved?.text, "Inspect the attached notes");
  await restored.retryUnresolved();
  assert.equal(host.turns.size, 1, "restoring must not turn a retry into a second host turn");
  assert.equal(host.turns.get(originalKey)?.attachmentIds?.length, 1);
  assert.equal(disk.length, 0, "successful reconciliation clears durable uncertainty");
});

test("durable admission fails closed before sending and pairing replacement invalidates old retries", async () => {
  const { PeerIntentStore } = await import("../../../main/services/peer-intent-store");
  let disk: import("../../../main/services/peer-intent-store").BoundIntent[] = [];
  let identity = "first-device";
  let failSave = true;
  const store = new PeerIntentStore({ load: async () => structuredClone(disk), save: async rows => {
    if (failSave) throw new Error("disk full"); disk = structuredClone(rows);
  } }, async () => identity);
  const host = new FakeHost();
  const ref = { hostId: host.hostId, chatId: "chat-pairing" };
  const control = new ChatSessionControl(host, ref, new ChatIntentLedger({ list: store.list.bind(store), put: store.put.bind(store), remove: store.remove.bind(store) }));
  control.attach();
  await assert.rejects(control.send("Do work"), /disk full/);
  assert.equal(host.calls.length, 0);
  failSave = false;
  host.loseNextAck = true;
  await assert.rejects(control.send("Do work"), { code: "outcome_unknown" });
  identity = "replacement-device";
  const calls = host.calls.length;
  await assert.rejects(control.retryUnresolved(), /pairing/);
  assert.equal(host.calls.length, calls);
  assert.ok(control.getSnapshot().unresolved, "keep the uncertainty visible until explicitly dismissed");
});

test("a second fork cannot replace an uncertain fork and restart retries the original key", async () => {
  const { PeerIntentStore } = await import("../../../main/services/peer-intent-store");
  let disk: import("../../../main/services/peer-intent-store").BoundIntent[] = [];
  const store = new PeerIntentStore({ load: async () => structuredClone(disk), save: async rows => { disk = structuredClone(rows); } }, async () => "paired-device-1");
  const persistence = { list: store.list.bind(store), put: store.put.bind(store), remove: store.remove.bind(store) };
  const keys: string[] = [];
  let lose = true;
  const host = Object.assign(new FakeHost(), { fork: async (_chatId: string, input: import("./host-chat-adapter").HostChatForkInput) => {
    keys.push(input.idempotencyKey);
    if (lose) { lose = false; throw new HostChatControlError({ code: "outcome_unknown", message: "Lost response" }); }
    return { id: "fork_1", title: "Fork", forkedFrom: { chatId: "chat_1", messageId: input.messageId, position: input.position, at: Date.now() } };
  } });
  host.granted.add("fork");
  const ref = { hostId: host.hostId, chatId: "chat_1" };
  const first = new ChatSessionControl(host, ref, new ChatIntentLedger(persistence));
  first.attach();
  await assert.rejects(first.fork({ messageId: "message_a", position: "after" }, "rev1"), { code: "outcome_unknown" });
  await assert.rejects(first.fork({ messageId: "message_b", position: "after" }, "rev1"), /earlier fork/);
  assert.equal(keys.length, 1);
  const restored = new ChatSessionControl(host, ref, new ChatIntentLedger(persistence));
  restored.attach();
  await restored.restore();
  assert.equal(restored.getSnapshot().unresolvedFork, true);
  const fork = await restored.fork({ messageId: "message_a", position: "after" }, "rev1");
  assert.equal(fork.id, "fork_1");
  assert.equal(new Set(keys).size, 1, "a recreated renderer must use the original fork identity");
  assert.equal(disk.length, 0);
});

// Behavioral oracles for the daemon turn owners (cli-native C09, C10, C11):
// accepted and refused turns, what a provider and the chat store actually saw,
// what a client was told, and which resources stay held.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`;

/** One scripted step per provider request; an unscripted request answers "Done". */
const reply = (text) => (response) => {
  response.write(chunk({ role: "assistant", content: text }));
  response.write(chunk({}, "stop")); response.write(usage);
  response.end("data: [DONE]\n\n");
};
const callTool = (name, args) => (response) => {
  response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
  response.write(chunk({}, "tool_calls")); response.write(usage);
  response.end("data: [DONE]\n\n");
};
/** Streams a first delta and then stays open, as a slow provider does. */
const hangAfter = (text) => (response) => { response.write(chunk({ role: "assistant", content: text })); };

/** A refusal the session does not retry. */
const reject = (response) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Rejected" } })); };

async function fixture(t, { access = "full" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-daemon-turns-"));
  const steps = [], requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    const step = steps.shift() ?? reply("Done");
    if (step !== reject) response.writeHead(200, { "content-type": "text/event-stream" });
    step(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only",
    models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  await api.workspaceCommand(dir, ["access", workspace.id, access]);
  const daemon = api.createDaemonChats(dir);
  t.after(async () => {
    await daemon.stop();
    server.closeAllConnections(); server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, daemon, workspace, steps, requests };
}

function ownerFor(documentId = "owner") {
  const events = [], listeners = new Set();
  let destroyed = false;
  return { events, id: 0, kind: "remote", documentId, isDestroyed: () => destroyed,
    onInvalidated(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(channel, value) { events.push({ channel, value }); },
    invalidate() { destroyed = true; for (const listener of listeners) listener(); },
    of(channel) { return events.filter((event) => event.channel === channel).map((event) => event.value); } };
}

/** The ordinary ingress order: reserve, durably append the user message, settle, hand off. */
async function beginTurn({ daemon, workspace }, chatId, { streamId = `stream-${chatId}`, owner = ownerFor(), usageSource = "chat", text = "Hello", create = true } = {}) {
  if (create) await daemon.chatStore.create({ id: chatId, title: chatId, workspaceId: workspace.id });
  const lease = daemon.llmClient.beginChatTurn(chatId, streamId, owner.documentId); assert.ok(lease, "the turn was admitted");
  await daemon.chatStore.appendMessage(chatId, { role: "user", content: text });
  lease.settleAsyncWork();
  const started = await daemon.llmClient.start(streamId, { chatId, workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: text }] }, owner, { usageSource });
  return { lease, owner, streamId, started };
}

const assistantMessages = async (daemon, chatId) => (await daemon.chatStore.get(chatId)).messages.filter((message) => message.role === "assistant");

/** Only a settled generation lets another owner take the chat's session lease. */
function assertSessionReleased(daemon, chatId) { api.acquireLease(daemon.sessionPath(chatId))(); }

test("a completed turn saves one answer, tells the client, and frees the chat", async (t) => {
  const f = await fixture(t);
  f.steps.push(reply("Answer"));
  const { owner, started } = await beginTurn(f, "complete");
  assert.equal(started, true);
  await f.daemon.llmClient.waitForChatIdle("complete");
  const [done] = owner.of("chat:done");
  assert.equal(done.content, "Answer");
  assert.equal(done.timeline.status, "completed");
  assert.deepEqual((await assistantMessages(f.daemon, "complete")).map((message) => message.content), ["Answer"]);
  assert.equal(owner.of("chat:error").length, 0);
  assert.equal(f.daemon.llmClient.isChatBusy("complete"), false);
  assert.deepEqual(f.daemon.activity.snapshot().activeChatIds, []);
  assertSessionReleased(f.daemon, "complete");
});

test("a chat holds one turn at a time and the daemon holds three chats", async (t) => {
  const { daemon } = await fixture(t);
  const leases = ["one", "two", "three"].map((id) => daemon.llmClient.beginChatTurn(id, `s-${id}`, "owner"));
  assert.ok(leases.every(Boolean));
  assert.equal(daemon.llmClient.beginChatTurn("one", "s-again", "other"), null, "a second turn cannot share a chat");
  assert.equal(daemon.llmClient.beginChatTurn("four", "s-four", "owner"), null, "a fourth chat waits for a slot");
  leases[0].settleAsyncWork(); leases[0].release();
  await tick();
  const later = daemon.llmClient.beginChatTurn("four", "s-four", "owner");
  assert.ok(later, "a released reservation frees its slot");
  for (const lease of [later, leases[1], leases[2]]) { lease.settleAsyncWork(); lease.release(); }
});

test("a turn cannot begin on a chat that is being deleted", async (t) => {
  const { daemon } = await fixture(t);
  const release = daemon.deletion.begin("deleting");
  assert.equal(daemon.llmClient.beginChatTurn("deleting", "stream", "owner"), null);
  release();
  const lease = daemon.llmClient.beginChatTurn("deleting", "stream", "owner"); assert.ok(lease);
  lease.settleAsyncWork(); lease.release();
});

test("only the reservation's own settled turn may start a generation", async (t) => {
  const f = await fixture(t), { daemon, workspace } = f;
  await daemon.chatStore.create({ id: "owned", title: "Owned", workspaceId: workspace.id });
  const owner = ownerFor(), params = { chatId: "owned", workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] };
  const lease = daemon.llmClient.beginChatTurn("owned", "stream", owner.documentId);
  assert.equal(await daemon.llmClient.start("stream", params, owner, { usageSource: "chat" }), false, "preparation is still pending");
  lease.settleAsyncWork();
  assert.equal(await daemon.llmClient.start("other-stream", params, owner, { usageSource: "chat" }), false, "another turn id");
  assert.equal(await daemon.llmClient.start("stream", params, ownerFor("stranger"), { usageSource: "chat" }), false, "another owner");
  assert.equal(f.requests.length, 0);
  assertSessionReleased(daemon, "owned");
  lease.release();
  assert.equal(await daemon.llmClient.start("stream", params, owner, { usageSource: "chat" }), false, "the reservation is gone");
  assert.equal(owner.events.length, 0);
});

test("a stop before the provider is reached ends the turn with no answer and no request", async (t) => {
  const f = await fixture(t);
  const { owner } = await beginTurn(f, "early-stop");
  await f.daemon.llmClient.cancelChat("early-stop", "user_stop");
  await f.daemon.llmClient.waitForChatIdle("early-stop");
  assert.equal(f.requests.length, 0);
  const [error] = owner.of("chat:error");
  assert.equal(error.cancelled, true);
  assert.equal(error.timeline.status, "cancelled");
  assert.equal(error.timeline.cancellationOrigin, "user_stop");
  assert.equal(owner.of("chat:done").length, 0);
  assert.deepEqual(await assistantMessages(f.daemon, "early-stop"), []);
  assertSessionReleased(f.daemon, "early-stop");
});

test("a stop after the first delta keeps the partial answer exactly once", async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Partial"));
  const { owner } = await beginTurn(f, "mid-stop");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  await f.daemon.llmClient.cancelChat("mid-stop", "user_stop");
  // A later stop never rewrites what the first stop recorded.
  await f.daemon.llmClient.cancelChat("mid-stop", "chat_deletion");
  await f.daemon.llmClient.waitForChatIdle("mid-stop");
  const [error] = owner.of("chat:error");
  assert.equal(error.cancelled, true);
  assert.equal(error.timeline.cancellationOrigin, "user_stop");
  assert.deepEqual((await assistantMessages(f.daemon, "mid-stop")).map((message) => message.content), ["Partial"]);
  assert.equal(owner.of("chat:error").length, 1, "one terminal event");
});

test("stops are bound to the owner and stream they name", async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Working"));
  const { owner, streamId } = await beginTurn(f, "scoped-stop");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  assert.equal(f.daemon.llmClient.cancel(streamId, "stranger"), false);
  assert.equal(f.daemon.llmClient.cancel("other-stream", owner.documentId), false);
  assert.equal(f.daemon.llmClient.cancelRun("other-stream"), false);
  await tick();
  assert.equal(owner.of("chat:error").length, 0, "a mismatched stop leaves the run alone");
  assert.equal(f.daemon.llmClient.cancelRun(streamId), true);
  await f.daemon.llmClient.waitForChatIdle("scoped-stop");
  assert.equal(owner.of("chat:error")[0].timeline.cancellationOrigin, "user_stop");
  assert.equal(f.daemon.llmClient.cancelRun(streamId), false, "a settled run cannot be stopped again");
});

test("an owner that goes away ends its run and the journal keeps the terminal", async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Partial"));
  const { owner, streamId } = await beginTurn(f, "owner-gone");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  const before = owner.events.length;
  owner.invalidate();
  await f.daemon.llmClient.waitForChatIdle("owner-gone");
  assert.equal(owner.events.length, before, "a destroyed owner is not written to");
  assert.deepEqual((await assistantMessages(f.daemon, "owner-gone")).map((message) => message.content), ["Partial"]);
  const journal = f.daemon.runs.read(streamId, 0).events;
  assert.deepEqual([journal.at(-1).type, journal.at(-1).terminal], ["cancelled", true]);
  assertSessionReleased(f.daemon, "owner-gone");
});

test("a provider failure is an uncancelled error and a replacement turn is unaffected", async (t) => {
  const f = await fixture(t);
  f.steps.push(reject);
  const first = await beginTurn(f, "replaced", { streamId: "first" });
  await f.daemon.llmClient.waitForChatIdle("replaced");
  const [error] = first.owner.of("chat:error");
  assert.equal(error.cancelled, false);
  assert.equal(error.timeline.status, "failed");
  f.steps.push(reply("Recovered"));
  const second = await beginTurn(f, "replaced", { streamId: "second", create: false });
  await f.daemon.llmClient.waitForChatIdle("replaced");
  assert.equal(f.daemon.llmClient.cancel("first", first.owner.documentId), false, "the old stream no longer names a run");
  assert.equal(second.owner.of("chat:done")[0].content, "Recovered");
  assert.equal(first.owner.of("chat:done").length, 0);
});

test("a failed final save reports the error and is retried once as the partial answer", async (t) => {
  const f = await fixture(t);
  f.steps.push(reply("Answer"));
  const append = f.daemon.chatStore.appendMessage, assistantWrites = [];
  f.daemon.chatStore.appendMessage = async (...args) => {
    if (args[1].role !== "assistant") return append(...args);
    assistantWrites.push(args[1]);
    if (assistantWrites.length === 1) throw new Error("disk full");
    return append(...args);
  };
  const { owner } = await beginTurn(f, "save-fault");
  await f.daemon.llmClient.waitForChatIdle("save-fault");
  assert.equal(owner.of("chat:done").length, 0, "done means the answer is durable");
  const [error] = owner.of("chat:error");
  assert.equal(error.message, "disk full");
  assert.equal(error.cancelled, false);
  assert.equal(assistantWrites.length, 2);
  assert.deepEqual((await assistantMessages(f.daemon, "save-fault")).map((message) => message.content), ["Answer"]);
  assertSessionReleased(f.daemon, "save-fault");
});

test("a partial answer that cannot be saved still ends the run and frees the chat", async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Partial"));
  const append = f.daemon.chatStore.appendMessage;
  f.daemon.chatStore.appendMessage = async (...args) => {
    if (args[1].role === "assistant") throw new Error("disk full");
    return append(...args);
  };
  const { owner } = await beginTurn(f, "lost-partial");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  await f.daemon.llmClient.cancelChat("lost-partial", "user_stop");
  await f.daemon.llmClient.waitForChatIdle("lost-partial");
  assert.equal(owner.of("chat:error").length, 1);
  assert.equal(f.daemon.llmClient.isChatBusy("lost-partial"), false);
  assertSessionReleased(f.daemon, "lost-partial");
});

test("shutdown stops running work, keeps its partial answer, and admits nothing more", async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Partial"));
  const { owner } = await beginTurn(f, "draining-run");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  const stopping = f.daemon.stop();
  assert.equal(f.daemon.llmClient.beginChatTurn("late", "stream", "owner"), null, "admission closes before the first await");
  await stopping;
  assert.equal(owner.of("chat:error")[0].timeline.cancellationOrigin, "application_shutdown");
  assert.deepEqual((await assistantMessages(f.daemon, "draining-run")).map((message) => message.content), ["Partial"]);
  assert.deepEqual(f.daemon.activity.snapshot().activeChatIds, []);
  assertSessionReleased(f.daemon, "draining-run");
});

test("a reservation that shutdown revoked cannot start afterwards", async (t) => {
  const f = await fixture(t), { daemon, workspace } = f;
  await daemon.chatStore.create({ id: "revoked", title: "Revoked", workspaceId: workspace.id });
  const owner = ownerFor(), lease = daemon.llmClient.beginChatTurn("revoked", "stream", owner.documentId);
  lease.settleAsyncWork();
  await daemon.stop();
  assert.equal(await daemon.llmClient.start("stream", { chatId: "revoked", workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] }, owner, { usageSource: "chat" }), false);
  assert.equal(f.requests.length, 0);
  assert.equal(owner.events.length, 0);
});

test("idle waiters see work through a reservation handing off to its generation", async (t) => {
  const f = await fixture(t);
  await f.daemon.chatStore.create({ id: "handoff", title: "Handoff", workspaceId: f.workspace.id });
  f.steps.push(hangAfter("Working"));
  const owner = ownerFor(), lease = f.daemon.llmClient.beginChatTurn("handoff", "stream", owner.documentId);
  let idle = false;
  const waiting = f.daemon.llmClient.waitForChatIdle("handoff").then(() => { idle = true; });
  await f.daemon.chatStore.appendMessage("handoff", { role: "user", content: "Hello" });
  lease.settleAsyncWork();
  assert.equal(await f.daemon.llmClient.start("stream", { chatId: "handoff", workspaceId: f.workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] }, owner, { usageSource: "chat" }), true);
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  await tick();
  assert.equal(idle, false, "the handoff is not idle");
  assert.equal(f.daemon.llmClient.isChatBusy("handoff"), true);
  await f.daemon.llmClient.cancelChat("handoff", "user_stop");
  await waiting;
  assert.equal(f.daemon.llmClient.isChatBusy("handoff"), false);
});

// C11: a tool call in an `ask` workspace waits on the person's answer.

/** Runs one turn up to its approval prompt. */
async function awaitingApproval(f, chatId, { tool = "ls", args = { path: "." }, owner = ownerFor() } = {}) {
  f.steps.push(callTool(tool, args), reply("Finished"));
  const turn = await beginTurn(f, chatId, { owner });
  await until(() => owner.of("chat:approval").length > 0, "the approval prompt");
  return { ...turn, approval: owner.of("chat:approval")[0] };
}
const toolResult = (owner) => owner.of("chat:tool").find((event) => event.phase !== "call")?.phase;
const toolResultSeen = (request) => JSON.stringify(request.messages.filter((message) => message.role === "tool"));

test("an allowed tool call runs once, and only the owner or a host may answer", async (t) => {
  const f = await fixture(t, { access: "ask" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const { owner, approval } = await awaitingApproval(f, "allow");
  assert.equal(approval.toolName, "ls");
  assert.equal(approval.summary, "List folder: .");
  assert.deepEqual(f.daemon.activity.snapshot().approvalChatIds, ["allow"]);
  assert.equal(f.daemon.llmClient.approve(approval.approvalId, "allow", "stranger"), false, "another owner cannot answer");
  assert.equal(f.daemon.llmClient.approve("approval_unknown", "allow", owner.documentId), false);
  assert.equal(f.daemon.llmClient.approve(approval.approvalId, "allow", owner.documentId), true);
  assert.equal(f.daemon.llmClient.approve(approval.approvalId, "deny", owner.documentId), false, "the first answer stands");
  assert.equal(f.daemon.llmClient.approveAsHost(approval.approvalId, "deny"), false, "the first answer stands for a host too");
  await f.daemon.llmClient.waitForChatIdle("allow");
  assert.equal(toolResult(owner), "result");
  assert.match(toolResultSeen(f.requests[1]), /visible\.txt/u);
  assert.equal(owner.of("chat:done")[0].content, "Finished");
});

test("a denied tool call never runs and the model hears the refusal", async (t) => {
  const f = await fixture(t, { access: "ask" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const { approval, streamId } = await awaitingApproval(f, "deny");
  assert.equal(f.daemon.llmClient.approveAsHost(approval.approvalId, "deny"), true, "a paired desktop can answer any run");
  await f.daemon.llmClient.waitForChatIdle("deny");
  const seen = toolResultSeen(f.requests[1]);
  assert.doesNotMatch(seen, /visible\.txt/u);
  assert.match(seen, /denied, changed or expired/u);
  assert.deepEqual(f.daemon.runs.resolution(approval.approvalId)?.decision, "deny");
  assert.ok(f.daemon.runs.summary(streamId));
});

test("a stop during an approval wait cancels the prompt and the tool never runs", async (t) => {
  const f = await fixture(t, { access: "ask" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const { owner, approval } = await awaitingApproval(f, "stop-approval");
  await f.daemon.llmClient.cancelChat("stop-approval", "user_stop");
  await f.daemon.llmClient.waitForChatIdle("stop-approval");
  assert.equal(f.daemon.llmClient.approve(approval.approvalId, "allow", owner.documentId), false, "a lapsed prompt cannot be answered");
  assert.equal(f.daemon.runs.resolution(approval.approvalId)?.decision, "cancelled");
  assert.equal(f.requests.length, 1, "no tool result went back to the provider");
  assert.equal(owner.of("chat:tool").filter((event) => event.phase === "result").length, 0);
  assert.equal(owner.of("chat:error")[0].cancelled, true);
});

test("access revoked during an approval wait wins over a later allow", async (t) => {
  const f = await fixture(t, { access: "ask" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const { owner, approval } = await awaitingApproval(f, "revoke-approval");
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "none"]);
  assert.equal(f.daemon.llmClient.approve(approval.approvalId, "allow", owner.documentId), true);
  await f.daemon.llmClient.waitForChatIdle("revoke-approval");
  assert.doesNotMatch(toolResultSeen(f.requests[1]), /visible\.txt/u);
});

test("a tool request too large for the phone is refused without a prompt", async (t) => {
  const f = await fixture(t, { access: "ask" });
  f.steps.push(callTool("ls", { path: "x".repeat(2_000) }), reply("Finished"));
  const { owner } = await beginTurn(f, "oversized");
  await f.daemon.llmClient.waitForChatIdle("oversized");
  assert.equal(owner.of("chat:approval").length, 0);
  assert.match(toolResultSeen(f.requests[1]), /approval display budget/u);
});

test("a tool in a full-access workspace needs no prompt and one in a disabled workspace never runs", async (t) => {
  const f = await fixture(t, { access: "full" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  f.steps.push(callTool("ls", { path: "." }), reply("Finished"));
  const open = await beginTurn(f, "full-access");
  await f.daemon.llmClient.waitForChatIdle("full-access");
  assert.equal(open.owner.of("chat:approval").length, 0);
  assert.match(toolResultSeen(f.requests[1]), /visible\.txt/u);
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "none"]);
  f.steps.push(callTool("ls", { path: "." }), reply("Finished"));
  const closed = await beginTurn(f, "no-access");
  await f.daemon.llmClient.waitForChatIdle("no-access");
  assert.equal(closed.owner.of("chat:approval").length, 0);
  const last = f.requests.at(-1);
  assert.doesNotMatch(toolResultSeen(last), /visible\.txt/u);
});

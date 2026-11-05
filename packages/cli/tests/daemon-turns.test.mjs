// Behavioral oracles for the daemon turn owners (cli-native C09, C10, C11):
// accepted and refused turns, what a provider and the chat store actually saw,
// what a client was told, and which resources stay held.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("a failing activity listener cannot leave the session lease held after idle", async (t) => {
  const f = await fixture(t);
  f.steps.push(reply("Answer"));
  let armed = false;
  const remove = f.daemon.onActivityChange(() => { if (armed) throw new Error("listener failed"); });
  t.after(remove);
  const { started } = await beginTurn(f, "listener");
  assert.equal(started, true);
  armed = true;
  await f.daemon.llmClient.waitForChatIdle("listener");
  armed = false;
  assertSessionReleased(f.daemon, "listener");
  assert.equal(f.daemon.runs.summary("stream-listener")?.state, "done");
});

test("a run that cannot register gives the chat back and does not hold shutdown", async (t) => {
  const f = await fixture(t);
  let armed = true;
  const remove = f.daemon.onActivityChange(() => { if (armed) throw new Error("listener failed"); });
  t.after(remove);
  await assert.rejects(beginTurn(f, "unregistered"), /listener failed/u);
  armed = false;
  assert.equal(f.daemon.llmClient.isChatBusy("unregistered"), false);
  assertSessionReleased(f.daemon, "unregistered");
  f.steps.push(reply("Second try"));
  const { started } = await beginTurn(f, "unregistered", { streamId: "again", create: false });
  assert.equal(started, true);
  await f.daemon.llmClient.waitForChatIdle("unregistered");
  await f.daemon.stop();
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
  assert.equal(f.daemon.activity.snapshot().pendingApprovalChatIds?.length ?? 1, 1);
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

// Shutdown waits for whoever really holds the chat, not only for a live lease.

test("shutdown waits for a cancelled reservation whose append is still in flight", async (t) => {
  const { daemon } = await fixture(t);
  const lease = daemon.llmClient.beginChatTurn("cancelled-append", "stream", "owner");
  lease.reserveAppendPayload(100);
  await daemon.llmClient.cancelChat("cancelled-append");
  assert.equal(daemon.llmClient.isChatBusy("cancelled-append"), true, "the write still holds the chat");
  let stopped = false;
  const stopping = daemon.stop().then(() => { stopped = true; });
  await tick(); await tick();
  assert.equal(stopped, false, "the process may not exit under an in-flight write");
  lease.settleAsyncWork();
  await stopping;
  assert.equal(daemon.llmClient.isChatBusy("cancelled-append"), false);
});

/** A Bot chat whose authority check calls back into the test. */
function fakeBots(onCheck, tools = []) {
  const authority = { botId: "bot", provider: { sourceProviderId: "cli-test", sourceModelId: "test" }, managedHome: { workspaceId: "bot-workspace" } };
  return { assertLegacyChatAllowed() {}, async assertNotPaused() {}, tools: async () => tools, instructions: async () => "Be brief.",
    authority: { admit: async () => ({ authority, signal: new AbortController().signal, release() {}, revalidateBeforeEffect: onCheck }) } };
}

async function beginBotTurn(f, chatId, owner) {
  await f.daemon.chatStore.create({ id: chatId, title: "Bot", workspaceId: f.workspace.id, botId: "bot" });
  const lease = f.daemon.llmClient.beginChatTurn(chatId, `stream-${chatId}`, owner.documentId);
  await f.daemon.chatStore.appendMessage(chatId, { role: "user", content: "Hello" });
  lease.settleAsyncWork();
  assert.equal(await f.daemon.llmClient.start(`stream-${chatId}`, { chatId, workspaceId: f.workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] }, owner, { usageSource: "chat", botAudienceId: "audience" }), true);
}

test("a stop during any Bot authority check before the prompt keeps the provider request from going out", async (t) => {
  for (const stopAt of [1, 2, 3]) {
    const f = await fixture(t), owner = ownerFor(), chatId = `bot-${stopAt}`;
    let checks = 0;
    f.daemon.setBots(fakeBots(async () => { checks += 1; if (checks === stopAt) await f.daemon.llmClient.cancelChat(chatId, "user_stop"); }));
    await beginBotTurn(f, chatId, owner);
    await f.daemon.llmClient.waitForChatIdle(chatId);
    assert.equal(f.requests.length, 0, `no provider request after a stop during check ${stopAt}`);
    assert.equal(owner.of("chat:error")[0].cancelled, true);
    assert.equal(owner.of("chat:error")[0].timeline.cancellationOrigin, "user_stop");
  }
});

test("a stop during a Bot tool's authority check keeps the tool from running", async (t) => {
  const f = await fixture(t), owner = ownerFor();
  let stopping = false, ran = 0;
  const probe = { name: "probe", description: "Probe", parameters: { type: "object", properties: {} }, execute: async () => { ran += 1; return { content: [{ type: "text", text: "ran" }], details: {} }; } };
  // The session's abort waits for this very check, so the stop lands without being awaited here.
  f.daemon.setBots(fakeBots(async () => { if (stopping) void f.daemon.llmClient.cancelChat("bot-tool", "user_stop"); }, [probe]));
  f.steps.push((response) => { stopping = true; callTool("probe", {})(response); }, reply("Finished"));
  await beginBotTurn(f, "bot-tool", owner);
  await f.daemon.llmClient.waitForChatIdle("bot-tool");
  assert.equal(ran, 0);
  assert.equal(owner.of("chat:error")[0].cancelled, true);
});

test("a run whose session lease cannot be removed still reports idle", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t);
  f.steps.push(hangAfter("Partial"));
  const { owner } = await beginTurn(f, "stuck-release");
  await until(() => owner.of("chat:delta").length > 0, "the first delta");
  const journals = join(f.dir, "daemon-chats", "journals");
  chmodSync(journals, 0o500);
  try {
    const waiting = f.daemon.llmClient.waitForChatIdle("stuck-release");
    await f.daemon.llmClient.cancelChat("stuck-release", "user_stop");
    await Promise.race([waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("the idle waiter never woke")), 5_000))]);
    assert.equal(f.daemon.llmClient.isChatBusy("stuck-release"), false);
  } finally { chmodSync(journals, 0o700); }
});

// C14: a chat deletion that a crash interrupted.

test("an interrupted chat deletion blocks new turns and finishes when the server starts without Remote", async (t) => {
  const f = await fixture(t), { dir, daemon, workspace } = f;
  await daemon.chatStore.create({ id: "half-deleted", title: "Half deleted", workspaceId: workspace.id });
  await daemon.chatStore.create({ id: "kept", title: "Kept", workspaceId: workspace.id });
  mkdirSync(dirname(daemon.sessionPath("half-deleted")), { recursive: true });
  writeFileSync(daemon.sessionPath("half-deleted"), "{}\n");
  api.atomicJson(join(dir, "daemon-chat-deletions.json"), ["half-deleted"]);
  const restarted = api.createDaemonChats(dir);
  t.after(() => restarted.stop());
  assert.equal(restarted.llmClient.beginChatTurn("half-deleted", "stream", "owner"), null, "the deletion already committed");
  const controller = new AbortController(), ready = Promise.withResolvers();
  const serving = api.serve(dir, controller.signal, { onReady: ready.resolve });
  void serving.catch(ready.reject);
  await ready.promise;
  controller.abort(); await serving;
  const after = api.createDaemonChats(dir);
  t.after(() => after.stop());
  assert.equal(await after.chatStore.get("half-deleted"), null);
  assert.equal(existsSync(after.sessionPath("half-deleted")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "daemon-chat-deletions.json"), "utf8")), []);
  assert.ok(await after.chatStore.get("kept"));
  const lease = after.llmClient.beginChatTurn("kept", "stream", "owner"); assert.ok(lease);
  lease.settleAsyncWork(); lease.release();
});

test("a deletion that cannot finish keeps its chat closed without stopping the rest of the daemon", async (t) => {
  const f = await fixture(t), { dir, daemon, workspace } = f;
  await daemon.chatStore.create({ id: "stuck", title: "Stuck", workspaceId: workspace.id });
  const { rm } = fsPromises;
  fsPromises.rm = async (path, ...rest) => { if (String(path) === daemon.sessionPath("stuck")) throw new Error("disk fault"); return rm(path, ...rest); };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.rm = rm; syncBuiltinESMExports(); });
  api.atomicJson(join(dir, "daemon-chat-deletions.json"), ["stuck"]);
  const restarted = api.createDaemonChats(dir);
  t.after(() => restarted.stop());
  await assert.rejects(restarted.recoverChatDeletions(), /disk fault/u);
  assert.equal(restarted.llmClient.beginChatTurn("stuck", "stream", "owner"), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "daemon-chat-deletions.json"), "utf8")), ["stuck"], "the tombstone stays for the next start");
  fsPromises.rm = rm; syncBuiltinESMExports();
  await restarted.recoverChatDeletions();
  assert.equal(await restarted.chatStore.get("stuck"), null);
  const lease = restarted.llmClient.beginChatTurn("stuck", "stream", "owner"); assert.ok(lease, "a finished deletion frees the id");
  lease.settleAsyncWork(); lease.release();
});

function approvalsFixture(options = {}) {
  const raised = [], resolved = [];
  const approvals = api.createDaemonApprovals({ raised: (prompt) => raised.push(prompt.approvalId), resolved: (id, decision) => resolved.push([id, decision]), ...options });
  const prompt = { streamId: "stream", toolCallId: "call", toolName: "ls", summary: "List" };
  return { approvals, prompt, raised, resolved };
}

test("an unanswered approval expires, is journaled as expired, and cannot be answered late", async () => {
  const { approvals, prompt, resolved } = approvalsFixture({ expiryMs: 10 });
  let published;
  const outcome = await approvals.request(prompt, new AbortController().signal, "owner", (value) => { published = value; });
  assert.notEqual(outcome, "allowed");
  assert.deepEqual(resolved, [[published.approvalId, "expired"]]);
  assert.equal(approvals.approve(published.approvalId, "allow", "owner"), false);
});

test("an approval is never published to a run that is already stopping, and a failed publish fails closed", async () => {
  const stopped = approvalsFixture(), controller = new AbortController();
  controller.abort();
  assert.notEqual(await stopped.approvals.request(stopped.prompt, controller.signal, "owner", () => assert.fail("published")), "allowed");
  assert.deepEqual([stopped.raised, stopped.resolved], [[], []], "nobody saw it, so nothing is withdrawn");
  const broken = approvalsFixture();
  assert.notEqual(await broken.approvals.request(broken.prompt, new AbortController().signal, "owner", () => { throw new Error("owner gone"); }), "allowed");
  assert.deepEqual(broken.resolved.map(([id]) => id), broken.raised, "an undelivered prompt leaves no attention behind");
});

test("the journal records how a published approval really ended", async () => {
  const { approvals, prompt, resolved } = approvalsFixture(), controller = new AbortController();
  const answered = [];
  const allowed = approvals.request(prompt, controller.signal, "owner", (value) => answered.push(value.approvalId));
  const denied = approvals.request(prompt, controller.signal, "owner", (value) => answered.push(value.approvalId));
  const stopped = approvals.request(prompt, controller.signal, "owner", (value) => answered.push(value.approvalId));
  assert.equal(approvals.approve(answered[0], "allow", "owner"), true);
  assert.equal(approvals.approveAsHost(answered[1], "deny"), true);
  controller.abort();
  assert.deepEqual(await Promise.all([allowed, denied]), ["allowed", "denied"]);
  assert.notEqual(await stopped, "allowed");
  assert.deepEqual(resolved, [[answered[0], "allow"], [answered[1], "deny"], [answered[2], "cancelled"]]);
});

// The custody owner on its own: legal and refused events, stale leases, and
// generated event orders against independently stated invariants.

test("custody follows the reservation to its one holder and ignores events that do not apply", () => {
  const step = (state, type) => api.transitionDaemonChat(state, { type });
  const reserved = step(undefined, "reserved"), settled = step(reserved, "preparation_settled");
  assert.deepEqual(reserved, { holder: "lease", preparation: "pending" });
  assert.equal(step(settled, "lease_revoked"), undefined, "nothing left to wait for");
  assert.deepEqual(step(reserved, "lease_revoked"), { holder: "settling" }, "revoked work keeps the chat");
  assert.equal(step(step(reserved, "lease_revoked"), "preparation_settled"), undefined);
  assert.equal(step(reserved, "generation_registered"), reserved, "unsettled work cannot hand off");
  const running = step(settled, "generation_registered");
  assert.deepEqual(running, { holder: "generation" });
  for (const type of ["reserved", "preparation_settled", "lease_revoked", "generation_registered"]) assert.equal(step(running, type), running);
  assert.equal(step(running, "generation_released"), undefined);
  for (const type of ["preparation_settled", "lease_revoked", "generation_registered", "generation_released"]) assert.equal(step(undefined, type), undefined);
});

function ownerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-daemon-owner-"));
  const { admission } = api.createDaemonChats(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { admission, owner: new api.DaemonTurnOwner({ admission, isDeleting: () => false }) };
}

const fakeRun = (streamId) => { let settle; const settled = new Promise((resolve) => { settle = resolve; }); return { streamId, ownerId: "owner", settled, settle }; };

test("a lease that lost its chat cannot move the turn that replaced it", (t) => {
  const { owner } = ownerFixture(t);
  const first = owner.begin("chat", "first", "owner");
  first.settleAsyncWork(); first.release();
  const second = owner.begin("chat", "second", "owner"); assert.ok(second);
  first.release(); first.settleAsyncWork();
  assert.equal(owner.isBusy("chat"), true);
  second.settleAsyncWork();
  const run = fakeRun("second");
  assert.equal(owner.handoff("chat", "second", "owner", run, () => {}), true);
  first.release();
  assert.equal(owner.run("chat"), run);
  assert.equal(owner.release("chat", fakeRun("stale")), false, "a stale run releases nothing");
  assert.equal(owner.run("chat"), run);
  assert.equal(owner.release("chat", run), true);
  assert.equal(owner.isBusy("chat"), false);
});

test("a handoff that fails leaves the turn to its reservation", (t) => {
  const { owner } = ownerFixture(t);
  const lease = owner.begin("chat", "turn", "owner");
  assert.equal(owner.handoff("chat", "turn", "owner", fakeRun("turn"), () => assert.fail("not settled")), false);
  lease.settleAsyncWork();
  assert.equal(owner.handoff("chat", "other", "owner", fakeRun("other"), () => assert.fail("another turn")), false);
  assert.equal(owner.run("chat"), undefined);
  assert.equal(owner.isBusy("chat"), true);
  lease.release();
  assert.equal(owner.isBusy("chat"), false);
});

/** Small seeded generator, so a failing order can be replayed from its seed. */
function random(seed) {
  let state = seed >>> 0;
  return (limit) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) % limit;
  };
}

test("generated event orders keep one holder per chat, capacity, and honest idle answers", async (t) => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const { owner } = ownerFixture(t), next = random(seed), chats = ["a", "b", "c", "d", "e"];
    const leases = new Map(), runs = new Map(), idle = new Map();
    const trace = [];
    for (let step = 0; step < 300; step += 1) {
      const chat = chats[next(chats.length)], action = next(6), lease = leases.get(chat), run = runs.get(chat);
      trace.push(`${action}:${chat}`);
      if (action === 0) {
        const liveChats = new Set([...runs.keys(), ...[...leases].filter(([, held]) => held.live).map(([id]) => id)]).size;
        const blocked = leases.has(chat) || runs.has(chat) || liveChats >= 3;
        const begun = owner.begin(chat, `turn-${step}`, "owner");
        assert.equal(begun === null, blocked, `seed ${seed}: ${trace.join(" ")}`);
        if (begun) leases.set(chat, { value: begun, turn: `turn-${step}`, live: true, settled: false });
      } else if (action === 1 && lease) {
        lease.value.settleAsyncWork(); lease.settled = true;
        if (!lease.live) leases.delete(chat);
      } else if (action === 2 && lease?.live) {
        lease.value.release(); lease.live = false;
        if (lease.settled) leases.delete(chat);
      } else if (action === 3 && lease?.live && lease.settled) {
        const started = fakeRun(lease.turn);
        assert.equal(owner.handoff(chat, lease.turn, "owner", started, () => {}), true);
        leases.delete(chat); runs.set(chat, started);
      } else if (action === 4 && run) {
        assert.equal(owner.release(chat, run), true);
        run.settle(); runs.delete(chat);
      } else if (action === 5 && !idle.has(chat) && (lease || run)) {
        const entry = { resolved: false };
        idle.set(chat, entry);
        void owner.waitForIdle(chat).then(() => { entry.resolved = true; });
      }
      for (const id of chats) assert.equal(owner.isBusy(id), leases.has(id) || runs.has(id), `seed ${seed}, ${id}: ${trace.join(" ")}`);
      await tick();
      for (const [id, entry] of idle) {
        if (entry.resolved) { assert.equal(owner.isBusy(id), false, `seed ${seed}: an idle waiter woke while ${id} was held`); idle.delete(id); }
      }
    }
    const remaining = owner.closeIntake();
    assert.deepEqual(new Set(remaining), new Set([...leases.keys(), ...runs.keys()]), "shutdown knows every holder");
    assert.equal(owner.begin("z", "late", "owner"), null);
    for (const [chat, lease] of leases) { lease.value.settleAsyncWork(); lease.value.release(); assert.equal(owner.isBusy(chat), false); }
    for (const [chat, run] of runs) { owner.release(chat, run); run.settle(); }
  }
});

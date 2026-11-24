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
import { getCacheWarmingDelayMs } from "@earendil-works/pi-ai";
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
/** One assistant message that calls each `[name, args]` in order, as a tool batch. */
const callTools = (calls) => (response) => {
  response.write(chunk({ role: "assistant", tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }));
  response.write(chunk({}, "tool_calls")); response.write(usage);
  response.end("data: [DONE]\n\n");
};
/** Streams a first delta and then stays open, as a slow provider does. */
const hangAfter = (text) => (response) => { response.write(chunk({ role: "assistant", content: text })); };

/** An Anthropic Messages reply, for a fixture whose provider is `anthropic`. */
const anthropicEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const anthropicReply = (text) => (response) => {
  response.write(anthropicEvent("message_start", { message: { id: `msg_${text}`, type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }));
  response.write(anthropicEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
  response.write(anthropicEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
  response.write(anthropicEvent("content_block_stop", { index: 0 }));
  response.write(anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }));
  response.end(anthropicEvent("message_stop", {}));
};

/** A refusal the session does not retry. */
const reject = (response) => { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Rejected" } })); };

/** Writes a workspace hook file and approves each hook, as the person would at a terminal. */
async function startHooks(dir, hooks) {
  mkdirSync(join(dir, ".aiden"), { recursive: true });
  writeFileSync(join(dir, ".aiden", "hooks.json"), JSON.stringify({ hooks }));
  for (const { id, digest } of (await api.hooksAdminCommand(dir, ["list"])).hooks) await api.hooksAdminCommand(dir, ["approve", id, digest], { isInteractive: () => true });
  return api.startCliHooks(dir);
}

async function fixture(t, { access = "full", hooks, anthropic = false, model = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-daemon-turns-"));
  const steps = [], requests = [], headers = [], requestWaiters = [];
  /** Resolves once the server has received `count` requests. */
  const requestCount = (count) => new Promise((resolve) => {
    if (requests.length >= count) resolve(); else requestWaiters.push({ count, resolve });
  });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    requests.push(JSON.parse(body)); headers.push(request.headers);
    for (const waiter of requestWaiters.filter((entry) => requests.length >= entry.count)) {
      requestWaiters.splice(requestWaiters.indexOf(waiter), 1); waiter.resolve();
    }
    const step = steps.shift() ?? (anthropic ? anthropicReply("Done") : reply("Done"));
    if (step !== reject) response.writeHead(200, { "content-type": "text/event-stream" });
    step(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const testModel = { id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...model };
  // The `anthropic` provider at a path naming api.anthropic.com gets every
  // default Pi gives Anthropic's own endpoint, message threads included.
  const providerId = anthropic ? "anthropic" : "cli-test";
  api.atomicJson(join(dir, "models.json"), { providers: { [providerId]: anthropic
    ? { api: "anthropic-messages", baseUrl: `${base}/api.anthropic.com`, apiKey: "test-only", models: [testModel] }
    : { api: "openai-completions", baseUrl: `${base}/v1`, apiKey: "test-only", models: [testModel] } } });
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  await api.workspaceCommand(dir, ["access", workspace.id, access]);
  const hookService = hooks ? await startHooks(dir, hooks) : undefined;
  const daemon = api.createDaemonChats(dir);
  t.after(async () => {
    await daemon.stop();
    if (hooks) await api.stopCliHooks(hookService);
    server.closeAllConnections(); server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, daemon, workspace, steps, requests, headers, requestCount, providerId };
}

function ownerFor(documentId = "owner") {
  const events = [], listeners = new Set(), waiters = [];
  let destroyed = false;
  return { events, id: 0, kind: "remote", documentId, isDestroyed: () => destroyed,
    onInvalidated(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(channel, value) {
      events.push({ channel, value });
      for (const waiter of waiters.filter((entry) => entry.channel === channel)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
    },
    /** The first event on `channel`: one already sent, or the next one. */
    next(channel) {
      const sent = events.find((event) => event.channel === channel);
      return sent ? Promise.resolve(sent.value) : new Promise((resolve) => waiters.push({ channel, resolve }));
    },
    invalidate() { destroyed = true; for (const listener of listeners) listener(); },
    of(channel) { return events.filter((event) => event.channel === channel).map((event) => event.value); } };
}

/** The ordinary ingress order: reserve, durably append the user message, settle, hand off. */
async function beginTurn({ daemon, workspace, providerId = "cli-test" }, chatId, { streamId = `stream-${chatId}`, owner = ownerFor(), usageSource = "chat", text = "Hello", create = true } = {}) {
  if (create) await daemon.chatStore.create({ id: chatId, title: chatId, workspaceId: workspace.id });
  const lease = daemon.llmClient.beginChatTurn(chatId, streamId, owner.documentId); assert.ok(lease, "the turn was admitted");
  await daemon.chatStore.appendMessage(chatId, { role: "user", content: text });
  lease.settleAsyncWork();
  const started = await daemon.llmClient.start(streamId, { chatId, workspaceId: workspace.id, providerId, model: "test", messages: [{ role: "user", content: text }] }, owner, { usageSource });
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
  assert.equal(error.timeline.status, "failed");
  const stored = await assistantMessages(f.daemon, "save-fault");
  assert.deepEqual(stored.map((message) => message.content), ["Answer"]);
  assert.equal(stored[0].timeline.status, "failed", "the record agrees with what the client was told");
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
async function awaitingApproval(f, chatId, { tool = "list_dir", args = { path: "." }, owner = ownerFor() } = {}) {
  f.steps.push(callTool(tool, args), reply("Finished"));
  const turn = await beginTurn(f, chatId, { owner });
  await until(() => owner.of("chat:approval").length > 0, "the approval prompt");
  return { ...turn, approval: owner.of("chat:approval")[0] };
}
test("every raised approval reports one decision, and it matches the outcome", async () => {
  const run = async ({ raised = () => {}, publish }) => {
    const decisions = [];
    const approvals = api.createDaemonApprovals({ raised, resolved: (id, decision) => decisions.push(decision) });
    const outcome = await approvals.request({ streamId: "stream", toolCallId: "call", toolName: "list_dir", summary: "List" }, new AbortController().signal, "owner", (prompt) => publish(approvals, prompt));
    return { outcome, decisions };
  };
  const allow = (approvals, prompt) => assert.equal(approvals.approve(prompt.approvalId, "allow", "owner"), true);
  assert.deepEqual(await run({ publish: allow }), { outcome: "allowed", decisions: ["allow"] }, "answered during delivery");
  assert.deepEqual(await run({ publish: (approvals, prompt) => { allow(approvals, prompt); throw new Error("send failed"); } }),
    { outcome: "allowed", decisions: ["allow"] }, "answered, then delivery failed");
  assert.deepEqual(await run({ publish: () => { throw new Error("send failed"); } }), { outcome: "unavailable", decisions: ["cancelled"] });
  assert.deepEqual(await run({ raised: () => { throw new Error("attention failed"); }, publish: () => assert.fail("never delivered") }),
    { outcome: "unavailable", decisions: ["cancelled"] }, "attention may have changed before it threw");
  assert.deepEqual(await run({ publish: (approvals, prompt) => { setImmediate(() => approvals.approve(prompt.approvalId, "deny", "owner")); } }),
    { outcome: "denied", decisions: ["deny"] }, "the ordinary path reports once too");
});

const toolResult = (owner) => owner.of("chat:tool").find((event) => event.phase !== "call")?.phase;
const toolResultSeen = (request) => JSON.stringify(request.messages.filter((message) => message.role === "tool"));

test("an allowed tool call runs once, and only the owner or a host may answer", async (t) => {
  const f = await fixture(t, { access: "ask" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const { owner, approval } = await awaitingApproval(f, "allow");
  assert.equal(approval.toolName, "list_dir");
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
  f.steps.push(callTool("list_dir", { path: "x".repeat(2_000) }), reply("Finished"));
  const { owner } = await beginTurn(f, "oversized");
  await f.daemon.llmClient.waitForChatIdle("oversized");
  assert.equal(owner.of("chat:approval").length, 0);
  assert.match(toolResultSeen(f.requests[1]), /approval display budget/u);
});

test("a tool in a full-access workspace needs no prompt and one in a disabled workspace never runs", async (t) => {
  const f = await fixture(t, { access: "full" });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  f.steps.push(callTool("list_dir", { path: "." }), reply("Finished"));
  const open = await beginTurn(f, "full-access");
  await f.daemon.llmClient.waitForChatIdle("full-access");
  assert.equal(open.owner.of("chat:approval").length, 0);
  assert.match(toolResultSeen(f.requests[1]), /visible\.txt/u);
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "none"]);
  f.steps.push(callTool("list_dir", { path: "." }), reply("Finished"));
  const closed = await beginTurn(f, "no-access");
  await f.daemon.llmClient.waitForChatIdle("no-access");
  assert.equal(closed.owner.of("chat:approval").length, 0);
  const last = f.requests.at(-1);
  assert.doesNotMatch(toolResultSeen(last), /visible\.txt/u);
});

test("a native visual on a served chat is saved on the reply and reaches the phone as its text, as Aiden was told", async (t) => {
  const f = await fixture(t);
  const markup = `<Visual title="Revenue"><Data name="months">[{"month":"Jan","revenue":1200}]</Data><Chart kind="bar" data={$months} x="month" y="revenue" label="By month" /></Visual>`;
  f.steps.push(callTool("render_ui", { title: "Revenue", markup }), reply("Here is revenue."));
  await beginTurn(f, "visual");
  await f.daemon.llmClient.waitForChatIdle("visual");
  assert.match(toolResultSeen(f.requests[1]), /Shown as text: phones and Macs paired to this server show \\"Revenue\\" as the text below/u);
  const [message] = await assistantMessages(f.daemon, "visual");
  assert.equal(message.content, "Here is revenue.");
  const [visual] = message.uiVisuals;
  const toolStep = message.timeline.steps.find((step) => step.toolCallId === visual.toolCallId);
  assert.ok(toolStep, "the visual is placed at its tool call in the reply's timeline");
  const [projected] = api.projectAidenRemoteChat(await f.daemon.chatStore.get("visual")).messages.filter((entry) => entry.role === "assistant");
  assert.equal(projected.visuals.length, 1);
  assert.match(projected.visuals[0].fallbackText, /^By month \(bar chart, 1 points\)\nmonth: Jan · revenue: 1,200$/u);
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

test("a stop during a tool batch shows each unfinished call as stopped and the later call never runs", async (t) => {
  const f = await fixture(t), owner = ownerFor();
  let afterRan = 0;
  const started = Promise.withResolvers();
  const empty = { type: "object", properties: {} };
  // A sequential tool makes Pi run the batch one call at a time, so the stop lands before `after` starts.
  const slow = { name: "slow", description: "Slow", parameters: empty, executionMode: "sequential",
    execute: (_id, _params, signal) => new Promise((_, reject) => { started.resolve(); signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) };
  const after = { name: "after", description: "After", parameters: empty, execute: async () => { afterRan += 1; return { content: [{ type: "text", text: "ran" }], details: {} }; } };
  f.daemon.setBots(fakeBots(async () => {}, [slow, after]));
  f.steps.push(callTools([["slow", {}], ["after", {}]]), reply("Finished"));
  await beginBotTurn(f, "batch-stop", owner);
  await started.promise;
  await f.daemon.llmClient.cancelChat("batch-stop", "user_stop");
  await f.daemon.llmClient.waitForChatIdle("batch-stop");
  assert.equal(afterRan, 0);
  assert.equal(f.requests.length, 1, "no follow-up request after the stop");
  const [ended] = owner.of("chat:error");
  assert.equal(ended.cancelled, true);
  const tools = ended.timeline.steps.filter((step) => step.kind === "tool");
  assert.deepEqual(tools.map((step) => [step.toolName, step.status, step.stoppedByUser]), [["slow", "cancelled", true], ["after", "cancelled", true]]);
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

for (const [name, record] of [["malformed", "{ not json"], ["a non-list", "{}"], ["a list of non-ids", "[123]"]]) test(`a deletion record that is ${name} closes every chat and refuses to start`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-tombstones-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "daemon-chat-deletions.json"), record);
  const daemon = api.createDaemonChats(dir);
  t.after(() => daemon.stop());
  assert.equal(daemon.llmClient.beginChatTurn("maybe-deleted", "stream", "owner"), null, "any chat may be one whose deletion committed");
  await assert.rejects(daemon.recoverChatDeletions(), /deletion/u);
  const controller = new AbortController();
  await assert.rejects(api.serve(dir, controller.signal, { remote: false }), /deletion/u);
  assert.equal(existsSync(join(dir, "serve.lock")), false);
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
  const prompt = { streamId: "stream", toolCallId: "call", toolName: "list_dir", summary: "List" };
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

const posix = { skip: process.platform === "win32" };
const commandHook = (command, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }];
const answer = (value) => `printf '%s' '${JSON.stringify(value)}'`;
const askBeforeListing = { PreToolUse: commandHook(answer({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Listing needs a look." } }), "LS") };
/** Holds back the first finish of a turn and lets the continued one end. */
const keepGoingOnce = { Stop: commandHook(`grep -q '"stop_hook_active":false' && ${answer({ decision: "block", reason: "Run the tests first." })} || true`) };

test("a hook's ask reaches the phone on a full-access chat, and the person's answer decides", posix, async (t) => {
  const f = await fixture(t, { hooks: askBeforeListing });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  const denied = await awaitingApproval(f, "hook-deny");
  assert.match(denied.approval.summary, /Listing needs a look\./u);
  assert.match(denied.approval.summary, /List folder: \./u, "the person still sees what would run");
  assert.equal(f.daemon.llmClient.approve(denied.approval.approvalId, "deny", denied.owner.documentId), true);
  await f.daemon.llmClient.waitForChatIdle("hook-deny");
  assert.doesNotMatch(toolResultSeen(f.requests[1]), /visible\.txt/u);
  const allowed = await awaitingApproval(f, "hook-allow");
  assert.equal(f.daemon.llmClient.approve(allowed.approval.approvalId, "allow", allowed.owner.documentId), true);
  await f.daemon.llmClient.waitForChatIdle("hook-allow");
  assert.match(toolResultSeen(f.requests.at(-1)), /visible\.txt/u);
});

test("a long hook reason can't push the end of the tool request out of the phone's summary", posix, async (t) => {
  const reason = "r".repeat(600), path = `${"a".repeat(1_650)}-tail`;
  const f = await fixture(t, { hooks: { PreToolUse: commandHook(answer({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }), "LS") } });
  const { approval } = await awaitingApproval(f, "hook-long", { args: { path } });
  const shownOnPhone = approval.summary.slice(0, 2_000); // Remote's limit on an approval summary.
  assert.ok(shownOnPhone.includes(path), "the whole request is shown");
  assert.match(shownOnPhone, /rrr/u, "and so is the start of the reason");
  assert.equal(f.daemon.llmClient.approveAsHost(approval.approvalId, "deny"), true);
  await f.daemon.llmClient.waitForChatIdle("hook-long");
});

test("a hook's ask on a turn nobody attends is refused without a prompt", posix, async (t) => {
  const f = await fixture(t, { hooks: askBeforeListing });
  writeFileSync(join(f.dir, "visible.txt"), "x");
  f.steps.push(callTool("list_dir", { path: "." }), reply("Finished"));
  const { owner } = await beginTurn(f, "hook-unattended", { usageSource: "scheduled" });
  await f.daemon.llmClient.waitForChatIdle("hook-unattended");
  assert.equal(owner.of("chat:approval").length, 0);
  const seen = toolResultSeen(f.requests[1]);
  assert.doesNotMatch(seen, /visible\.txt/u);
  assert.match(seen, /No one is here to approve it/u);
});

test("a Stop hook keeps the turn going once, and the chat saves one answer", posix, async (t) => {
  const f = await fixture(t, { hooks: keepGoingOnce });
  f.steps.push(reply("First"), reply("Second"));
  const { owner } = await beginTurn(f, "hook-continue");
  await f.daemon.llmClient.waitForChatIdle("hook-continue");
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /Run the tests first\./u);
  assert.equal(owner.of("chat:done").length, 1);
  assert.equal((await assistantMessages(f.daemon, "hook-continue")).length, 1);
  assertSessionReleased(f.daemon, "hook-continue");
});

test("a stop while a Stop hook runs ends the turn instead of continuing it", posix, async (t) => {
  const marker = join(mkdtempSync(join(tmpdir(), "aiden-hook-marker-")), "started");
  t.after(() => rmSync(dirname(marker), { recursive: true, force: true }));
  const f = await fixture(t, { hooks: { Stop: commandHook(`touch '${marker}'; sleep 30; ${answer({ decision: "block", reason: "Keep going." })}`) } });
  f.steps.push(reply("First"));
  const { owner } = await beginTurn(f, "hook-stop");
  await until(() => existsSync(marker), "the Stop hook");
  await f.daemon.llmClient.cancelChat("hook-stop", "user_stop");
  await until(() => !f.daemon.llmClient.isChatBusy("hook-stop"), "the stop, well before the hook's own 30 seconds");
  assert.equal(f.requests.length, 1, "the stopped turn never asks the provider again");
  assert.equal(owner.of("chat:error")[0]?.cancelled, true);
  assertSessionReleased(f.daemon, "hook-stop");
});

test("a prompt hook's context follows its prompt as a separate message, on that turn and every later one", posix, async (t) => {
  // The same shape the desktop journals (prompt-prefix-stability: "a turn's hook context is journaled after its prompt").
  const additionalContext = answer({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ticket: OPS-12" } });
  const f = await fixture(t, { hooks: { UserPromptSubmit: commandHook(`grep -q OPS-TRIGGER && ${additionalContext} || true`) } });
  f.steps.push(reply("First"), reply("Second"));
  await beginTurn(f, "hook-context", { streamId: "hook-context-1", text: "Check OPS-TRIGGER" });
  await f.daemon.llmClient.waitForChatIdle("hook-context");
  await beginTurn(f, "hook-context", { streamId: "hook-context-2", text: "Two", create: false });
  await f.daemon.llmClient.waitForChatIdle("hook-context");
  const text = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
  const conversation = (request) => request.messages.filter((message) => message.role !== "system").map((message) => [message.role, text(message)]);
  const [[, prompt], [role, context]] = conversation(f.requests[0]);
  assert.equal(prompt, "Check OPS-TRIGGER");
  assert.equal(role, "user");
  // The desktop's own helpers build the expected message (each hook's context
  // fenced under its name, "grep" from the command), so both hosts send the same text.
  assert.equal(context, text(api.hookContextMessage(api.hookTurnContextText([api.fenceAsData('Context from hook "grep"', "ticket: OPS-12")]), 0)));
  assert.deepEqual(conversation(f.requests[1]), [["user", "Check OPS-TRIGGER"], ["user", context], ["assistant", "First"], ["user", "Two"]]);
});

test("an Anthropic chat sends its whole conversation on every turn, never a message thread", async (t) => {
  const f = await fixture(t, { anthropic: true });
  f.steps.push(anthropicReply("First"), anthropicReply("Second"));
  await beginTurn(f, "threads", { streamId: "threads-1", text: "One" });
  await f.daemon.llmClient.waitForChatIdle("threads");
  await beginTurn(f, "threads", { streamId: "threads-2", text: "Two", create: false });
  await f.daemon.llmClient.waitForChatIdle("threads");
  assert.deepEqual((await assistantMessages(f.daemon, "threads")).map((message) => message.content), ["First", "Second"]);
  assert.equal(f.requests.length, 2);
  for (const [index, request] of f.requests.entries()) {
    assert.equal("thread" in request, false, `request ${index + 1} has no thread`);
    assert.doesNotMatch(String(f.headers[index]["anthropic-beta"] ?? ""), /message-threads/u);
  }
  // The second turn carries the first exchange itself, not a pointer to it.
  assert.deepEqual(f.requests[1].messages.map((message) => message.role), ["user", "assistant", "user"]);
});

/** An Anthropic Messages reply that calls one tool. */
const anthropicCallTool = (name, args) => (response) => {
  response.write(anthropicEvent("message_start", { message: { id: `msg_${name}`, type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }));
  response.write(anthropicEvent("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } }));
  response.write(anthropicEvent("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } }));
  response.write(anthropicEvent("content_block_stop", { index: 0 }));
  response.write(anthropicEvent("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }));
  response.end(anthropicEvent("message_stop", {}));
};

/** Every `cache_control` marker in a request body. */
const cacheMarkers = (value) => Array.isArray(value) ? value.reduce((total, item) => total + cacheMarkers(item), 0)
  : value && typeof value === "object" ? Object.entries(value).reduce((total, [key, child]) => total + (key === "cache_control" ? 1 : cacheMarkers(child)), 0) : 0;

test("an Anthropic chat with always-on memory caches the system prompt before the memory on its own", async (t) => {
  const f = await fixture(t, { anthropic: true });
  const fact = "Prefers metric units";
  f.steps.push(anthropicCallTool("remember_fact", { fact, alwaysOn: true }), anthropicReply("Saved."), anthropicReply("Noted."));
  await beginTurn(f, "head", { streamId: "head-1", text: "Remember that I prefer metric units." });
  await f.daemon.llmClient.waitForChatIdle("head");
  // The first turn told no memory, so its system prompt stays one block.
  assert.equal(f.requests[0].system.length, 1);
  await beginTurn(f, "head", { streamId: "head-2", text: "How far is a marathon?", create: false });
  await f.daemon.llmClient.waitForChatIdle("head");
  const { system } = f.requests[2];
  assert.equal(system.length, 2, "the stable head is its own block");
  assert.match(system[1].text, new RegExp(fact, "u"), "the memory is in the tail");
  assert.doesNotMatch(system[0].text, new RegExp(fact, "u"));
  assert.ok(system[0].cache_control && system[1].cache_control, "both blocks are cached");
  // The blocks join to the same system text the turn would have sent as one.
  assert.ok(system[0].text.endsWith("\n\n"));
  assert.equal(cacheMarkers(f.requests[2]), 4, "tools, head, system and last user message");
});

/** A finished reply whose prompt was large enough that keeping its cache warm pays. */
const largePromptReply = (text) => (response) => {
  response.write(chunk({ role: "assistant", content: text }));
  response.write(chunk({}, "stop"));
  response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 200_000, completion_tokens: 4, total_tokens: 200_004 } })}\n\n`);
  response.end("data: [DONE]\n\n");
};

/**
 * Runs a second turn that streams for longer than the 5-minute cache would
 * last, on a model whose cache Pi keeps warm, and reports how many requests
 * the provider saw: two turns, plus one when Pi refreshed the cache mid-reply.
 * Pi arms its refresh timer before the request goes out, so once the reply
 * streams, a warmer that decided not to warm has armed no timer within the
 * cache's lifetime and nothing can be sent on the tick.
 */
async function requestsAcrossLongReply(t, { profile, usageSource = "chat" }) {
  const f = await fixture(t, { model: { promptCache: { short: 300 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } });
  if (profile !== undefined) api.atomicJson(join(f.dir, "aiden.json"), profile);
  f.steps.push(largePromptReply("First"));
  await beginTurn(f, "warming", { usageSource });
  await f.daemon.llmClient.waitForChatIdle("warming");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Pi's refresh timers for a 5-minute cache, armed while the second turn runs.
  // Date is real, so a timer armed a few milliseconds after Pi's clock read is a little shorter.
  const refreshDelay = getCacheWarmingDelayMs(300_000);
  const refreshTimers = [], mockedSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (callback, delay, ...rest) {
    if (delay > refreshDelay - 1_000 && delay <= refreshDelay) refreshTimers.push(delay);
    return mockedSetTimeout.call(this, callback, delay, ...rest);
  };
  f.steps.push(hangAfter("Still"));
  const owner = ownerFor();
  const second = beginTurn(f, "warming", { streamId: "warming-2", create: false, usageSource, owner });
  await owner.next("chat:delta");
  await second;
  t.mock.timers.tick(refreshDelay);
  if (refreshTimers.length > 0) await f.requestCount(3);
  const seen = f.requests.length;
  t.mock.timers.reset();
  await f.daemon.llmClient.cancelChat("warming", "user_stop");
  await f.daemon.llmClient.waitForChatIdle("warming");
  return { seen, refresh: f.requests[2], refreshTimers: refreshTimers.length };
}

test("aiden serve keeps a chat's cache warm mid-reply only when the profile turns warming on", async (t) => {
  await t.test("on", async (t) => {
    const { seen, refresh, refreshTimers } = await requestsAcrossLongReply(t, { profile: { cacheWarmingEnabled: true } });
    assert.equal(refreshTimers, 1, "Pi armed one refresh");
    assert.equal(seen, 3, "one refresh request");
    assert.equal(refresh.max_completion_tokens ?? refresh.max_tokens, 1, "the refresh asks for a single token");
  });
  // Pi's own default warms after every turn; the server sends nothing extra unless asked.
  for (const [name, profile] of [["no setting", undefined], ["off", { cacheWarmingEnabled: false }], ["not a boolean", { cacheWarmingEnabled: "true" }]]) {
    await t.test(name, async (t) => assert.deepEqual(await requestsAcrossLongReply(t, { profile }), { seen: 2, refresh: undefined, refreshTimers: 0 }));
  }
  await t.test("a scheduled run, with warming on", async (t) => {
    assert.deepEqual(await requestsAcrossLongReply(t, { profile: { cacheWarmingEnabled: true }, usageSource: "scheduled" }), { seen: 2, refresh: undefined, refreshTimers: 0 });
  });
});

test("a server session warms only for an attended turn on a profile that opts in", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-daemon-warming-"));
  try {
    assert.equal(api.SettingsManager.create(dir, dir).getCacheWarmingMode(), "idle", "Pi's own default keeps warming between turns");
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getCacheWarmingMode(), "off");
    // Pi's own warming setting does not override the profile's switch.
    api.atomicJson(join(dir, "settings.json"), { cacheWarming: "idle" });
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getCacheWarmingMode(), "off");
    api.atomicJson(join(dir, "aiden.json"), { cacheWarmingEnabled: true });
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getCacheWarmingMode(), "streaming");
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: false }).getCacheWarmingMode(), "off");
    // Pi would replay an hour-long request at the default lifetime, so a turn that asked for the hour is not warmed by Pi.
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: true, longRetention: true }).getCacheWarmingMode(), "off");
    writeFileSync(join(dir, "aiden.json"), "{ not json");
    assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getCacheWarmingMode(), "off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Every `cache_control.ttl` an Anthropic request body asks for. */
const cacheTtls = (value) => Array.isArray(value) ? value.flatMap(cacheTtls)
  : value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => key === "cache_control" ? [child.ttl ?? "default"] : cacheTtls(child)) : [];

test("aiden serve asks for the hour-long cache only on an attended chat whose profile opts in", async (t) => {
  // The `anthropic` provider keeps an hour only for a model named as its own family.
  const f = await fixture(t, { anthropic: true, model: { name: "claude-test" } });
  const ttlsOf = async (chatId, usageSource) => {
    const before = f.requests.length;
    await beginTurn(f, chatId, { usageSource, providerId: f.providerId });
    await f.daemon.llmClient.waitForChatIdle(chatId);
    assert.equal(f.requests.length, before + 1, "one request");
    return [...new Set(cacheTtls(f.requests[before]))];
  };
  assert.deepEqual(await ttlsOf("no-setting", "chat"), ["default"]);
  api.atomicJson(join(f.dir, "aiden.json"), { cacheWarmingEnabled: true, longPromptCacheRetention: true });
  assert.deepEqual(await ttlsOf("attended", "chat"), ["1h"]);
  assert.equal(f.daemon.isKeepingChatWarm("attended"), false, "an hour-long cache is not kept warm as well");
  assert.deepEqual(await ttlsOf("scheduled", "scheduled"), ["default"]);
  assert.deepEqual(await ttlsOf("telegram", "telegram"), ["default"]);
});

/**
 * Drives a settled chat's idle refreshes: each time a refresh timer of the
 * model's warming delay is pending, the mocked clock passes it, and the next
 * refresh's request (if any) must arrive before the clock moves again. `Date`
 * is mocked with the timers, so however long the real turn takes, the warmer
 * arms its refresh at exactly the warming delay.
 */
function idleRefreshDriver(t, f, chatId) {
  const refreshDelay = getCacheWarmingDelayMs(300_000);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const pending = new Set(), mockedSetTimeout = globalThis.setTimeout, mockedClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = function (callback, delay, ...rest) {
    const watched = delay > refreshDelay - 1_000 && delay <= refreshDelay;
    const timer = mockedSetTimeout.call(this, (...args) => { pending.delete(timer); callback(...args); }, delay, ...rest);
    if (watched) pending.add(timer);
    return timer;
  };
  globalThis.clearTimeout = function (timer) { pending.delete(timer); return mockedClearTimeout.call(this, timer); };
  // The mocked `Date` stands still between ticks, so the wait is bounded on the real clock.
  const settled = async (condition) => {
    const deadline = performance.now() + 10_000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error("Timed out waiting for the idle warmer.");
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    /** Passes every pending refresh until the chat is no longer kept warm, and returns the requests it sent. */
    async drain() {
      const start = f.requests.length;
      for (let rounds = 0; rounds < 10; rounds += 1) {
        await settled(() => pending.size > 0 || !f.daemon.isKeepingChatWarm(chatId));
        if (!f.daemon.isKeepingChatWarm(chatId)) break;
        const before = f.requests.length;
        t.mock.timers.tick(refreshDelay);
        await settled(() => f.requests.length > before || !f.daemon.isKeepingChatWarm(chatId));
      }
      return f.requests.slice(start);
    },
    /** Waits until the chat's refresh is armed, and returns how many refresh timers are pending. */
    async armed() { await settled(() => pending.size > 0 || !f.daemon.isKeepingChatWarm(chatId)); return pending.size; },
    /** How many refresh timers are pending now. */
    pendingRefreshes: () => pending.size,
    /** Passes one warming delay on the mocked clock, and returns the requests sent meanwhile. */
    async passRefreshDelay() {
      const start = f.requests.length;
      t.mock.timers.tick(refreshDelay);
      for (let turns = 0; turns < 20; turns += 1) await new Promise((resolve) => setImmediate(resolve));
      return f.requests.slice(start);
    },
    reset() { t.mock.timers.reset(); },
  };
}

test("aiden serve keeps a settled attended chat warm within the desktop's idle limits", async (t) => {
  // Pricier than the mid-reply case: a settled chat must still save $0.05 on a 15% chance of a reply.
  const warmingFixture = async (t, profile = { cacheWarmingEnabled: true }) => {
    const f = await fixture(t, { model: { promptCache: { short: 300 }, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } } });
    api.atomicJson(join(f.dir, "aiden.json"), profile);
    return f;
  };
  await t.test("at most three one-token refreshes, then none", async (t) => {
    const f = await warmingFixture(t);
    const driver = idleRefreshDriver(t, f, "idle");
    f.steps.push(largePromptReply("First"));
    await beginTurn(f, "idle");
    await f.daemon.llmClient.waitForChatIdle("idle");
    assert.equal(f.daemon.isKeepingChatWarm("idle"), true);
    const refreshes = await driver.drain();
    driver.reset();
    assert.equal(refreshes.length, 3);
    for (const refresh of refreshes) {
      assert.equal(refresh.max_completion_tokens ?? refresh.max_tokens, 1, "a refresh asks for a single token");
      assert.deepEqual(refresh.messages, f.requests[0].messages, "a refresh replays the reply's own request");
    }
    assert.equal(f.daemon.isKeepingChatWarm("idle"), false);
  });
  await t.test("a new message on the chat ends warming with no refresh", async (t) => {
    const f = await warmingFixture(t);
    const driver = idleRefreshDriver(t, f, "written");
    f.steps.push(largePromptReply("First"));
    await beginTurn(f, "written");
    await f.daemon.llmClient.waitForChatIdle("written");
    assert.equal(f.daemon.isKeepingChatWarm("written"), true);
    await f.daemon.chatStore.appendMessage("written", { role: "user", content: "One more thing" });
    assert.deepEqual(await driver.drain(), []);
    driver.reset();
    assert.equal(f.daemon.isKeepingChatWarm("written"), false);
  });
  await t.test("a new turn ends the last reply's warming", async (t) => {
    const f = await warmingFixture(t);
    const driver = idleRefreshDriver(t, f, "again");
    f.steps.push(largePromptReply("First"), reply("Second"));
    await beginTurn(f, "again", { streamId: "again-1" });
    await f.daemon.llmClient.waitForChatIdle("again");
    assert.equal(await driver.armed(), 1, "the first reply armed its refresh");
    await beginTurn(f, "again", { streamId: "again-2", create: false });
    await f.daemon.llmClient.waitForChatIdle("again");
    assert.equal(driver.pendingRefreshes(), 0, "the first reply's refresh is cleared");
    assert.deepEqual(await driver.passRefreshDelay(), [], "and never sent");
    driver.reset();
    // The second reply's prompt is too small to be worth keeping warm.
    assert.equal(f.daemon.isKeepingChatWarm("again"), false);
    assert.equal(f.requests.length, 2);
  });
  await t.test("changing the chat's model ends warming with no refresh", async (t) => {
    const f = await warmingFixture(t);
    const driver = idleRefreshDriver(t, f, "switched");
    f.steps.push(largePromptReply("First"));
    await beginTurn(f, "switched");
    await f.daemon.llmClient.waitForChatIdle("switched");
    assert.equal(await driver.armed(), 1);
    // A model change is a chat write, so the settled reply is no longer the chat's latest.
    await f.daemon.chatStore.setChatModelSelection("switched", "cli-test", "another-model");
    assert.deepEqual(await driver.drain(), []);
    driver.reset();
    assert.equal(f.daemon.isKeepingChatWarm("switched"), false);
  });
  await t.test("deleting the chat ends warming with no refresh", async (t) => {
    const f = await warmingFixture(t);
    const driver = idleRefreshDriver(t, f, "deleted");
    f.steps.push(largePromptReply("First"));
    await beginTurn(f, "deleted");
    await f.daemon.llmClient.waitForChatIdle("deleted");
    assert.equal(await driver.armed(), 1);
    // The hook a chat deletion runs once the chat's journal is gone (remote-chats.ts).
    f.daemon.forgetMemoryFactsTold("deleted");
    assert.equal(f.daemon.isKeepingChatWarm("deleted"), false);
    assert.equal(driver.pendingRefreshes(), 0, "the refresh is cleared");
    assert.deepEqual(await driver.passRefreshDelay(), [], "and never sent");
    driver.reset();
  });
  // The memory prompt is not part of the chat, so turning memory off writes nothing the summary revision sees.
  for (const [name, memoryEnabled, expected] of [["a told fact still approved keeps warming", true, 3], ["turning memory off ends warming with no refresh", false, 0]]) {
    await t.test(name, async (t) => {
      const f = await warmingFixture(t);
      const driver = idleRefreshDriver(t, f, "told");
      const fact = "Keeps bees on the roof";
      f.steps.push(callTool("remember_fact", { fact, alwaysOn: true }), reply("Saved."));
      await beginTurn(f, "told", { text: "Remember my bees.", streamId: "told-1" });
      await f.daemon.llmClient.waitForChatIdle("told");
      f.steps.push(largePromptReply("You keep bees."));
      await beginTurn(f, "told", { text: "What do I keep?", streamId: "told-2", create: false });
      await f.daemon.llmClient.waitForChatIdle("told");
      const told = f.requests.at(-1);
      assert.match(JSON.stringify(told.messages[0]), /bees on the roof/u, "the system prompt told the chat the fact");
      assert.equal(await driver.armed(), 1);
      api.atomicJson(join(f.dir, "aiden.json"), { cacheWarmingEnabled: true, memoryEnabled });
      const refreshes = await driver.drain();
      driver.reset();
      assert.equal(refreshes.length, expected);
      for (const refresh of refreshes) assert.deepEqual(refresh.messages, told.messages, "a refresh replays the told request");
      assert.equal(f.daemon.isKeepingChatWarm("told"), false);
    });
  }
  await t.test("revoking the device whose turn it was ends warming", async (t) => {
    const f = await warmingFixture(t);
    f.steps.push(largePromptReply("First"));
    await beginTurn(f, "revoked", { owner: ownerFor(`${api.remoteDeviceDocumentPrefix("phone")}stream`) });
    await f.daemon.llmClient.waitForChatIdle("revoked");
    f.daemon.releaseDeviceAttendance("another-phone");
    assert.equal(f.daemon.isKeepingChatWarm("revoked"), true, "another device's revocation leaves it");
    f.daemon.releaseDeviceAttendance("phone");
    assert.equal(f.daemon.isKeepingChatWarm("revoked"), false);
  });
  for (const [name, profile, usageSource] of [["warming off", { cacheWarmingEnabled: false }, "chat"], ["a scheduled run", { cacheWarmingEnabled: true }, "scheduled"]]) {
    await t.test(name, async (t) => {
      const f = await warmingFixture(t, profile);
      f.steps.push(largePromptReply("First"));
      await beginTurn(f, "quiet", { usageSource });
      await f.daemon.llmClient.waitForChatIdle("quiet");
      assert.equal(f.daemon.isKeepingChatWarm("quiet"), false);
    });
  }
});

test("a server session sends Codex requests over a WebSocket unless SSE is asked for or a proxy is set", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-daemon-transport-"));
  const proxyNames = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
  const saved = proxyNames.map((name) => [name, process.env[name]]);
  for (const name of proxyNames) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(dir, { recursive: true, force: true });
  });
  // Pi's default sends previous-response deltas over the socket.
  assert.equal(api.SettingsManager.create(dir, dir).getTransport(), "auto");
  assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getTransport(), "websocket");
  api.atomicJson(join(dir, "settings.json"), { transport: "websocket-cached" });
  assert.equal(api.daemonSettingsManager(dir, dir, { attended: false }).getTransport(), "websocket");
  api.atomicJson(join(dir, "settings.json"), { transport: "sse" });
  assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getTransport(), "sse");
  api.atomicJson(join(dir, "settings.json"), {});
  // Node's WebSocket does not go through the proxy HTTP requests use.
  process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
  assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getTransport(), "sse");
  process.env.NO_PROXY = "chatgpt.com";
  assert.equal(api.daemonSettingsManager(dir, dir, { attended: true }).getTransport(), "websocket");
  // A helper agent's worker is a short-lived child process: SSE, whatever settings.json asks.
  api.atomicJson(join(dir, "settings.json"), { transport: "websocket-cached", cacheWarming: "streaming" });
  const worker = api.subagentWorkerSettingsManager(dir, dir);
  assert.equal(worker.getTransport(), "sse");
  assert.equal(worker.getCacheWarmingMode(), "off");
});

/** A reply whose usage reports `promptTokens`, so the turn ends past the compaction threshold. */
const replyAtContext = (text, promptTokens) => (response) => {
  response.write(chunk({ role: "assistant", content: text }));
  response.write(chunk({}, "stop"));
  response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 } })}\n\n`);
  response.end("data: [DONE]\n\n");
};

const compactionSummaries = (daemon, chatId) => readFileSync(daemon.sessionPath(chatId), "utf8").split("\n").filter(Boolean)
  .map((line) => JSON.parse(line)).filter((entry) => entry.type === "compaction").map((entry) => entry.summary);

test("a fact the chat was told and then forgot does not survive a serve compaction", async (t) => {
  const f = await fixture(t);
  // Every turn's history but the last exchange is summarized.
  api.atomicJson(join(f.dir, "settings.json"), { compaction: { keepRecentTokens: 1 } });
  const fact = "Plays the theremin on Tuesdays";
  const run = async (text, steps, create = false) => {
    f.steps.push(...steps);
    await beginTurn(f, "forgets", { text, create, streamId: `stream-${f.requests.length}` });
    await f.daemon.llmClient.waitForChatIdle("forgets");
  };
  await run("Remember my hobby.", [callTool("remember_fact", { fact, alwaysOn: true }), reply("Saved.")], true);
  const factId = /\[memory:([^\]]+)\]/u.exec(toolResultSeen(f.requests[1]))?.[1];
  assert.ok(factId, "the fact was saved");
  // The always-on prompt tells the next turn, and the reply restates it.
  await run("What do I do on Tuesdays?", [reply("You play the theremin on Tuesdays.")]);
  assert.match(JSON.stringify(f.requests[2].messages[0]), /theremin/u, "the system prompt told the chat");
  // The fact is forgotten, the turn ends past the threshold, and the summarizer restates it anyway.
  await run("Forget my hobby.", [
    callTool("forget_fact", { factId }),
    replyAtContext("Forgotten.", 30_000),
    reply(`## Goal\nThe user plays the theremin on Tuesdays.\nThe user asked to forget a hobby.`),
  ]);
  const [summary] = compactionSummaries(f.daemon, "forgets");
  assert.ok(summary, "the compaction was stored");
  assert.doesNotMatch(summary, /theremin/iu, "the forgotten fact is not in the stored summary");
  assert.match(summary, /asked to forget a hobby/u, "the summarizer's other lines are kept");
});

test("a fact the chat learned only from the always-on prompt, then removed elsewhere, does not survive its compaction", async (t) => {
  const f = await fixture(t);
  api.atomicJson(join(f.dir, "settings.json"), { compaction: { keepRecentTokens: 1 } });
  const fact = "Keeps bees on the roof";
  const run = async (chatId, text, steps, create) => {
    f.steps.push(...steps);
    await beginTurn(f, chatId, { text, create, streamId: `stream-${f.requests.length}` });
    await f.daemon.llmClient.waitForChatIdle(chatId);
  };
  // Another chat saves the fact, so no copy of it is in this chat's history.
  await run("saver", "Remember my bees.", [callTool("remember_fact", { fact, alwaysOn: true }), reply("Saved.")], true);
  const factId = /\[memory:([^\]]+)\]/u.exec(toolResultSeen(f.requests[1]))?.[1];
  assert.ok(factId, "the fact was saved");
  await run("told", "Hello.", [reply("Hello.")], true);
  assert.match(JSON.stringify(f.requests[2].messages[0]), /bees on the roof/u, "the always-on prompt told the chat");
  // The other chat removes it, and this chat's next turn ends past the threshold; the summarizer states it anyway.
  await run("saver", "Forget my bees.", [callTool("forget_fact", { factId }), reply("Forgotten.")], false);
  const before = f.requests.length;
  await run("told", "What is new?", [
    replyAtContext("Nothing much.", 30_000),
    reply("## Goal\nThe user keeps bees on the roof.\nThe user said hello."),
  ], false);
  const sent = f.requests.slice(before);
  assert.ok(sent.length >= 2, "the turn and its summarizer requests");
  assert.doesNotMatch(JSON.stringify(sent), /bees/iu, "the removed fact reaches neither the turn nor the summarizer");
  const [summary] = compactionSummaries(f.daemon, "told");
  assert.ok(summary, "the compaction was stored");
  assert.doesNotMatch(summary, /bees/iu, "the stored summary does not state the removed fact");
  assert.match(summary, /said hello/u, "the summarizer's other lines are kept");
});

test("a serve compaction whose summary still states a fact across lines is not stored", async (t) => {
  const f = await fixture(t);
  api.atomicJson(join(f.dir, "settings.json"), { compaction: { keepRecentTokens: 1 } });
  f.steps.push(callTool("remember_fact", { fact: "Owns a red canoe", alwaysOn: true }), reply("Saved."));
  await beginTurn(f, "split", { text: "Remember my boat." });
  await f.daemon.llmClient.waitForChatIdle("split");
  f.steps.push(replyAtContext("You own a red canoe.", 30_000), reply("## Goal\nThe user owns a red\ncanoe and paddles."));
  const before = f.requests.length;
  await beginTurn(f, "split", { text: "What boat do I own?", create: false, streamId: "stream-split-2" });
  await f.daemon.llmClient.waitForChatIdle("split");
  assert.ok(f.requests.length >= before + 2, "the summarizer was asked");
  assert.deepEqual(compactionSummaries(f.daemon, "split"), [], "no summary stating the fact was written");
  assert.deepEqual((await assistantMessages(f.daemon, "split")).map((message) => message.content).at(-1), "You own a red canoe.", "the turn's answer stands");
});

/** An Anthropic Messages reply whose usage reports `inputTokens`, so the turn ends past the compaction threshold. */
const anthropicReplyAtContext = (text, inputTokens) => (response) => {
  response.write(anthropicEvent("message_start", { message: { id: `msg_${text}`, type: "message", role: "assistant", model: "test", content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }));
  response.write(anthropicEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
  response.write(anthropicEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
  response.write(anthropicEvent("content_block_stop", { index: 0 }));
  response.write(anthropicEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }));
  response.end(anthropicEvent("message_stop", {}));
};

/** A request body without its cache markers, which move to the newest user message. */
const withoutCacheMarkers = (value) => JSON.parse(JSON.stringify(value ?? null, (key, child) => key === "cache_control" ? undefined : child));

test("a serve compaction after a turn continues the turn's request, at the default cache lifetime", async (t) => {
  const f = await fixture(t, { anthropic: true, model: { name: "claude-test" } });
  api.atomicJson(join(f.dir, "settings.json"), { compaction: { keepRecentTokens: 1 } });
  // The turn keeps its cache for an hour; the summary is never continued, so it asks for the default.
  api.atomicJson(join(f.dir, "aiden.json"), { longPromptCacheRetention: true });
  f.steps.push(anthropicReply("Hello."));
  await beginTurn(f, "cached", { text: "Hello." });
  await f.daemon.llmClient.waitForChatIdle("cached");
  f.steps.push(anthropicReplyAtContext("Plenty.", 20_000), anthropicReply("## Goal\nThe user said hello twice."));
  const before = f.requests.length;
  await beginTurn(f, "cached", { text: "And again.", create: false, streamId: "stream-cached-2" });
  await f.daemon.llmClient.waitForChatIdle("cached");
  assert.equal(f.requests.length, before + 2, "the turn and one summary request");
  const [turn, summary] = f.requests.slice(before);
  assert.deepEqual(withoutCacheMarkers(summary.system), withoutCacheMarkers(turn.system), "the turn's system prompt");
  assert.deepEqual(withoutCacheMarkers(summary.tools), withoutCacheMarkers(turn.tools), "the turn's tools");
  assert.deepEqual(withoutCacheMarkers(summary.messages.slice(0, turn.messages.length)), withoutCacheMarkers(turn.messages), "the turn's messages, unchanged");
  const added = summary.messages.slice(turn.messages.length);
  assert.deepEqual(added.map((message) => message.role), ["assistant", "user"], "the turn's reply, then the instruction");
  assert.match(JSON.stringify(added[0]), /Plenty\./u);
  assert.deepEqual([...new Set(cacheTtls(turn))], ["1h"]);
  assert.deepEqual([...new Set(cacheTtls(summary))], ["default"]);
  const [stored] = compactionSummaries(f.daemon, "cached");
  assert.match(stored ?? "", /said hello twice/u, "the continuation's summary was stored");
});

test("a serve compaction after a removed fact sends the isolated request", async (t) => {
  const f = await fixture(t, { anthropic: true, model: { name: "claude-test" } });
  api.atomicJson(join(f.dir, "settings.json"), { compaction: { keepRecentTokens: 1 } });
  const run = async (chatId, text, steps, create) => {
    f.steps.push(...steps);
    await beginTurn(f, chatId, { text, create, streamId: `stream-${f.requests.length}` });
    await f.daemon.llmClient.waitForChatIdle(chatId);
  };
  // Another chat saves the fact, so this chat learns it only from the always-on prompt.
  await run("saver", "Remember my bees.", [anthropicCallTool("remember_fact", { fact: "Keeps bees on the roof", alwaysOn: true }), anthropicReply("Saved.")], true);
  const factId = /\[memory:([^\]]+)\]/u.exec(JSON.stringify(f.requests[1].messages))?.[1];
  assert.ok(factId, "the fact was saved");
  await run("removed", "Hello.", [anthropicReply("Hello.")], true);
  assert.match(JSON.stringify(f.requests[2].system), /bees on the roof/u, "the always-on prompt told the chat");
  await run("saver", "Forget my bees.", [anthropicCallTool("forget_fact", { factId }), anthropicReply("Forgotten.")], false);
  const before = f.requests.length;
  await run("removed", "What is new?", [
    anthropicReplyAtContext("Nothing much.", 20_000),
    anthropicReply("## Goal\nThe user said hello."),
    anthropicReply("The turn asked what is new."),
  ], false);
  const [turn, ...summaries] = f.requests.slice(before);
  assert.ok(summaries.length >= 1, "the summarizer was asked");
  for (const summary of summaries) {
    assert.notDeepEqual(withoutCacheMarkers(summary.system), withoutCacheMarkers(turn.system), "Pi's own summarizer prompt, not the turn's");
    assert.equal(summary.messages.length, 1, "the history goes as one summarizer input, not as the turn's messages");
    assert.doesNotMatch(JSON.stringify(summary), /bees/iu, "the removed fact does not reach the summarizer");
  }
  const [stored] = compactionSummaries(f.daemon, "removed");
  assert.match(stored ?? "", /said hello/u, "the isolated summary was stored");
});

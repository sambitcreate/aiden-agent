// `aiden serve` refuses work in a workspace whose folder was moved or deleted,
// as the desktop does: a phone's turn is refused before anything is kept or
// any provider request is made, and runs once the folder is back; a turn that
// gets past the Remote check, and a scheduled run, end with a clear error. A
// phone that negotiated Continue in a new chat (revision 63) hears why, and
// can fork the whole chat into another workspace; the original stays as it is.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import * as api from "../dist/parity-test-api.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Even, and with its pair distinct from the other suites' Remote ports: test files run in parallel.
const PORT = 49380;
const SERVER_REFUSAL = "This chat's workspace folder is missing on the server. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, then send again.";

/**
 * A data dir with one registered workspace in its own subfolder, and a provider that records every request.
 * `stops` run newest first, before the data dir is removed: a stopping service still writes its state there.
 */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-missing-folder-"));
  const stops = [];
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const folder = join(dir, "project");
  mkdirSync(folder);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(frame({ role: "assistant", content: "Answer" }, null));
    response.write(frame({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  stops.push(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const workspace = await api.workspaceCommand(dir, ["add", folder]);
  return { dir, folder, workspace, requests, stops };
}

function phoneClient(dir, port, credential) {
  const ca = readFileSync(join(dir, "remote-tls/ca-certificate.pem"));
  return (path, method = "GET", body, key, revision) => new Promise((done, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port, ca, path: `/api/aiden/v1${path}`, method,
      headers: { authorization: `Bearer ${credential}`, "aiden-protocol-version": "1", ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}), ...(revision ? { "if-match": revision } : {}) } }, (response) => {
      let data = ""; response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => done({ status: response.statusCode, data: response.headers["content-type"]?.includes("json") && data ? JSON.parse(data) : data }));
    });
    request.setTimeout(15000, () => request.destroy(new Error(`Remote request timed out: ${method} ${path}`)));
    request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}

test("a phone's turn in a chat whose folder is gone is refused with the Remote missing-folder error, and the same key runs once the folder is back", async (t) => {
  const f = await fixture(t);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const daemon = api.createDaemonChats(f.dir), scheduler = api.createCliScheduler(f.dir);
  const remote = await api.createCliRemote(f.dir, daemon, scheduler, { port: PORT, discovery: { async start() {}, stop() {} } });
  f.stops.push(() => daemon.stop(), async () => { await remote.stop(); await scheduler.service.stopAndSettle(); });
  await remote.start();
  const status = await remote.service.status();
  const issued = await remote.state.issueDevice({ name: "Phone", type: "iphone", clientVersion: "test", acceptsProgressCapabilities: true });
  const phone = phoneClient(f.dir, status.lanPort, issued.credential);

  const created = await phone("/chats", "POST", { workspaceId: f.workspace.id, providerId: "cli-test", modelId: "test" }, "create-missing-folder-01");
  assert.equal(created.status, 201, JSON.stringify(created));
  const chatId = created.data.id;

  rmSync(f.folder, { recursive: true, force: true });
  const refused = await phone(`/chats/${chatId}/turns`, "POST", { text: "Hello" }, "turn-missing-folder-0001");
  // iOS and Android settle exactly this status and code as a known refusal and show the message as sent.
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.data.error.code, "workspace_unavailable");
  assert.equal(refused.data.error.message, SERVER_REFUSAL);
  assert.equal(refused.data.error.message.includes(f.folder), false, "a Remote error never carries the server's path");
  assert.equal(f.requests.length, 0, "no provider request was made");
  assert.deepEqual((await phone(`/chats/${chatId}`)).data.messages, [], "the refused message was not kept");

  mkdirSync(f.folder);
  const accepted = await phone(`/chats/${chatId}/turns`, "POST", { text: "Hello" }, "turn-missing-folder-0001");
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  await daemon.llmClient.waitForChatIdle(chatId);
  assert.equal(f.requests.length, 1);
  const messages = (await phone(`/chats/${chatId}`)).data.messages;
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["user", "Hello"], ["assistant", "Answer"]]);
});

test("a phone that negotiated it continues a chat whose folder is gone in a new chat in another workspace, and the original stays as it is", async (t) => {
  const f = await fixture(t);
  const otherFolder = join(f.dir, "other");
  mkdirSync(otherFolder);
  const other = await api.workspaceCommand(f.dir, ["add", otherFolder]);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const daemon = api.createDaemonChats(f.dir), scheduler = api.createCliScheduler(f.dir);
  const remote = await api.createCliRemote(f.dir, daemon, scheduler, { port: PORT + 2, discovery: { async start() {}, stop() {} } });
  f.stops.push(() => daemon.stop(), async () => { await remote.stop(); await scheduler.service.stopAndSettle(); });
  await remote.start();
  const status = await remote.service.status();
  const issued = await remote.state.issueDevice({ name: "Phone", type: "android", clientVersion: "test", acceptsProgressCapabilities: true });
  const phone = phoneClient(f.dir, status.lanPort, issued.credential);

  const server = await phone("/server");
  assert.equal(server.data.serverCapabilities.includes("chat:continue-in-new-chat"), true, "aiden serve offers it");
  const negotiated = await phone("/device/capabilities", "POST", { accepts: ["chat:continue-in-new-chat"] });
  assert.equal(negotiated.status, 200, JSON.stringify(negotiated));

  const created = await phone("/chats", "POST", { workspaceId: f.workspace.id, providerId: "cli-test", modelId: "test" }, "create-continue-0001");
  assert.equal(created.status, 201, JSON.stringify(created));
  const chatId = created.data.id;
  assert.equal((await phone(`/chats/${chatId}/turns`, "POST", { text: "Hello" }, "turn-continue-00000001")).status, 202);
  await daemon.llmClient.waitForChatIdle(chatId);

  rmSync(f.folder, { recursive: true, force: true });
  const refused = await phone(`/chats/${chatId}/turns`, "POST", { text: "Still there?" }, "turn-continue-00000002");
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.data.error.code, "workspace_unavailable");
  assert.equal(refused.data.error.message, SERVER_REFUSAL);
  assert.deepEqual(refused.data.error.details, { reason: "folder_missing", canContinueInNewChat: true });
  assert.equal(JSON.stringify(refused.data).includes(f.dir), false, "a Remote error never carries the server's path");

  const before = await phone(`/chats/${chatId}`);
  const forked = await phone(`/chats/${chatId}/fork`, "POST", { continueIn: { workspaceId: other.id } }, "continue-fork-00000001", before.data.revision);
  assert.equal(forked.status, 201, JSON.stringify(forked));
  assert.equal(JSON.stringify(forked.data).includes(f.dir), false, "the new chat names no path");
  assert.notEqual(forked.data.chat.id, chatId);
  assert.equal(forked.data.chat.workspaceId, other.id);
  assert.equal(forked.data.chat.forkedFrom.chatId, chatId);
  assert.deepEqual(forked.data.chat.messages.map((message) => [message.role, message.text]), [["user", "Hello"], ["assistant", "Answer"]]);
  const after = await phone(`/chats/${chatId}`);
  assert.deepEqual(after.data.messages, before.data.messages, "the original chat is untouched");
  assert.equal(after.data.workspaceId, f.workspace.id);

  // The new chat works where its folder is.
  assert.equal((await phone(`/chats/${forked.data.chat.id}/turns`, "POST", { text: "Go on" }, "turn-continue-00000003")).status, 202);
  await daemon.llmClient.waitForChatIdle(forked.data.chat.id);
  assert.equal(f.requests.length, 2);
});

test("a turn that reaches the daemon after its folder is gone ends with the missing-folder error before any provider request", async (t) => {
  const f = await fixture(t);
  const daemon = api.createDaemonChats(f.dir);
  f.stops.push(() => daemon.stop());
  const events = [];
  const owner = { id: 0, kind: "remote", documentId: "owner", isDestroyed: () => false, onInvalidated: () => () => {},
    send(channel, value) { events.push({ channel, value }); } };
  await daemon.chatStore.create({ id: "gone", title: "Gone", workspaceId: f.workspace.id });
  const lease = daemon.llmClient.beginChatTurn("gone", "stream-gone", owner.documentId); assert.ok(lease);
  await daemon.chatStore.appendMessage("gone", { role: "user", content: "Hello" });
  lease.settleAsyncWork();
  rmSync(f.folder, { recursive: true, force: true });
  await daemon.llmClient.start("stream-gone", { chatId: "gone", workspaceId: f.workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] }, owner, { usageSource: "chat" });
  await daemon.llmClient.waitForChatIdle("gone");

  const errors = events.filter((event) => event.channel === "chat:error").map((event) => event.value.message);
  assert.deepEqual(errors, [SERVER_REFUSAL]);
  assert.equal(events.some((event) => event.channel === "chat:done"), false);
  assert.equal(f.requests.length, 0, "no provider request was made");
  assert.deepEqual((await daemon.chatStore.get("gone")).messages.map((message) => message.role), ["user"]);
  assert.equal(daemon.llmClient.isChatBusy("gone"), false, "the chat is free for a turn once the folder is back");
});

test("a scheduled run in a workspace whose folder is gone records the missing-folder error, not a raw ENOENT", async (t) => {
  const f = await fixture(t);
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "full"]);
  const scheduler = api.createCliScheduler(f.dir);
  f.stops.push(() => scheduler.service.stopAndSettle());
  const input = join(f.dir, "schedule.json");
  writeFileSync(input, JSON.stringify({ name: "Nightly", mode: "script", script: "true", cron: "0 9 * * *", timezone: "UTC", permission: "full", enabled: true, workspaceId: f.workspace.id }));
  const task = await scheduler.command(["save", input]);

  rmSync(f.folder, { recursive: true, force: true });
  const run = await scheduler.service.runNow(task.id, { runId: "missing-folder-run" });
  assert.equal(run.result, "error", JSON.stringify(run));
  assert.equal(run.error, `The folder for “project” is missing. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, or start the chat in another workspace.`);
});

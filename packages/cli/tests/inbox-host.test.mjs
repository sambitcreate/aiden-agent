// A desktop paired to `aiden serve` reads the host's chats with their Inbox
// state: `/host/events`, live-run attention, read markers and triage.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import * as api from "../dist/parity-test-api.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Distinct from the parity suite's default port: test files run in parallel.
const PORT = 49376;

function temporary(t) { const dir = mkdtempSync(join(tmpdir(), "aiden-inbox-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

/** One OpenAI-compatible model: the first reply asks to list the folder, the next one answers. */
async function fakeProvider(t, dir) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    const toolTurn = !parsed.messages.some((message) => message.role === "tool");
    const delta = toolTurn
      ? { role: "assistant", tool_calls: [{ index: 0, id: "list-1", type: "function", function: { name: "ls", arguments: JSON.stringify({ path: "." }) } }] }
      : { role: "assistant", content: "Listed the folder" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  return requests;
}

async function startServer(t, dir) {
  const daemon = api.createDaemonChats(dir), scheduler = api.createCliScheduler(dir);
  const remote = await api.createCliRemote(dir, daemon, scheduler, { port: PORT, discovery: { async start() {}, stop() {} } });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await remote.stop(); await scheduler.service.stopAndSettle(); };
  t.after(stop);
  await remote.start();
  const status = await remote.service.status(); assert.equal(status.running, true);
  return { daemon, remote, status, stop };
}

function client(dir, port, credential) {
  const ca = readFileSync(join(dir, "remote-tls/ca-certificate.pem"));
  const options = (path, method, body, key) => ({ hostname: "127.0.0.1", port, ca, path: `/api/aiden/v1${path}`, method,
    headers: { authorization: `Bearer ${credential}`, "aiden-protocol-version": "1", ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) } });
  return {
    request(path, method = "GET", body, key) {
      return new Promise((done, reject) => {
        const request = httpsRequest(options(path, method, body, key), (response) => {
          let data = ""; response.on("data", (chunk) => { data += chunk; });
          response.on("end", () => done({ status: response.statusCode, data: response.headers["content-type"]?.includes("json") && data ? JSON.parse(data) : data }));
        });
        request.setTimeout(15000, () => request.destroy(new Error(`Remote request timed out: ${method} ${path}`)));
        request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
      });
    },
    /** An open SSE stream: its parsed frames so far, and a wait for the first frame matching `predicate`. */
    events(path) {
      const frames = [], waiters = [];
      let buffer = "";
      const request = httpsRequest(options(path, "GET"), (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
            if (!data) continue;
            frames.push(JSON.parse(data));
            for (const waiter of [...waiters]) waiter();
          }
        });
      });
      request.on("error", () => undefined); request.end();
      return {
        frames,
        close: () => request.destroy(),
        next(predicate, label) {
          return new Promise((done, reject) => {
            const timer = setTimeout(() => reject(new Error(`No ${label} frame: ${JSON.stringify(frames.map((frame) => frame.type))}`)), 15000);
            const check = () => {
              const frame = frames.find(predicate);
              if (!frame) return;
              clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); done(frame);
            };
            waiters.push(check); check();
          });
        },
      };
    },
  };
}

async function until(read, accept, label) {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

test("a desktop paired to aiden serve reads its chats' Inbox state and steers its runs", async (t) => {
  const dir = temporary(t);
  await fakeProvider(t, dir);
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const first = await startServer(t, dir);
  const issued = await first.remote.state.issueDevice({ name: "Test Mac", type: "mac", clientVersion: "test",
    capabilities: [...api.AIDEN_REMOTE_LEGACY_CAPABILITIES, ...api.AIDEN_REMOTE_HOST_CAPABILITIES], acceptsProgressCapabilities: true });
  const mac = client(dir, first.status.lanPort, issued.credential);

  const features = (await mac.request("/server")).data.features;
  for (const token of ["host-events-v1", "run-streams-v1", "run-control-v1", "chat-read-state-v1", "chat-triage-v1", "inbox-signals-v1"]) assert.ok(features.includes(token), `${token} in ${features}`);

  const feed = mac.events("/host/events");
  t.after(() => feed.close());
  const snapshot = await feed.next((frame) => frame.type === "snapshot", "snapshot");
  assert.equal(snapshot.streamId, "host");
  assert.ok(JSON.stringify(snapshot.payload).includes(workspace.id), JSON.stringify(snapshot.payload));

  const created = await mac.request("/chats", "POST", { workspaceId: workspace.id, providerId: "cli-test", modelId: "test" }, "create-inbox-test-0001");
  assert.equal(created.status, 201, JSON.stringify(created));
  const chatId = created.data.id;
  await feed.next((frame) => frame.type === "chat.upsert" && JSON.stringify(frame.payload).includes(chatId), "chat.upsert");
  const turn = await mac.request(`/chats/${chatId}/turns`, "POST", { text: "List the files" }, "turn-inbox-test-00001");
  assert.equal(turn.status, 202, JSON.stringify(turn));

  // The run stops on its folder-listing approval: the row needs the person, and says since when.
  const summaryRow = async () => (await mac.request("/chat-summaries")).data.summaries.find((row) => row.id === chatId);
  const waiting = await until(summaryRow, (row) => row?.rowState === "needs_approval", "a needs_approval row");
  assert.equal(waiting.activity, "active");
  assert.ok(Date.parse(waiting.attentionSince) >= Date.parse(waiting.runStartedAt), JSON.stringify(waiting));
  const runState = await feed.next((frame) => frame.type === "run.state" && frame.payload.chatId === chatId && frame.payload.state === "needs_approval", "needs_approval run.state");
  assert.equal(runState.payload.attentionSummary, "List folder: .");

  // The desktop answers the approval through host run control, though a different surface started the run.
  const run = first.daemon.runs.currentRunForChat(chatId);
  assert.ok(run?.pendingApprovalIds.length === 1, JSON.stringify(run));
  const approved = await mac.request(`/runs/${run.runId}/approvals/${run.pendingApprovalIds[0]}/respond`, "POST", { decision: "allow" }, "approve-inbox-test-001");
  assert.equal(approved.status, 200, JSON.stringify(approved));
  await first.daemon.llmClient.waitForChatIdle(chatId);

  // The finished reply is unread until the desktop reports it viewed the chat.
  const replied = await until(summaryRow, (row) => row?.rowState === "idle" && row.unread === true, "an unread idle row");
  assert.ok(replied.lastAssistantAt, JSON.stringify(replied));
  assert.equal(replied.attentionSince, undefined);
  const read = await mac.request(`/chats/${chatId}/read`, "POST", {}, "read-inbox-test-000001");
  assert.ok(read.status === 200 || read.status === 204, JSON.stringify(read));
  assert.equal((await summaryRow()).unread, false);

  // Triage: idempotent by key, and a stale revision is refused.
  const pinned = await mac.request(`/chats/${chatId}/triage`, "POST", { pinned: true, ifRevision: 0 }, "triage-inbox-test-0001");
  assert.equal(pinned.status, 200, JSON.stringify(pinned));
  assert.equal(pinned.data.revision, 1); assert.ok(pinned.data.pinnedAt);
  assert.deepEqual(await mac.request(`/chats/${chatId}/triage`, "POST", { pinned: true, ifRevision: 0 }, "triage-inbox-test-0001"), pinned);
  const stale = await mac.request(`/chats/${chatId}/triage`, "POST", { done: true, ifRevision: 0 }, "triage-inbox-test-0002");
  assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal(stale.data.error.code, "revision_conflict");
  const triaged = await summaryRow();
  assert.equal(triaged.pinnedAt, pinned.data.pinnedAt); assert.equal(triaged.triageRevision, 1); assert.equal(triaged.doneAt, undefined);
  await feed.next((frame) => frame.type === "chat.upsert" && frame.payload.id === chatId && frame.payload.pinnedAt === pinned.data.pinnedAt, "a pinned chat.upsert");

  // Read markers and triage live in this data dir and survive a restart.
  feed.close();
  await first.stop();
  await startServer(t, dir);
  const after = await summaryRow();
  assert.equal(after.unread, false); assert.equal(after.pinnedAt, pinned.data.pinnedAt); assert.equal(after.triageRevision, 1);
});

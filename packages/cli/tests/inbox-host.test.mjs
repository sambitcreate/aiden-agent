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
      let buffer = "", markEnded;
      const ended = new Promise((done) => { markEnded = done; });
      const request = httpsRequest(options(path, "GET"), (response) => {
        response.on("close", () => markEnded(response.statusCode));
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
      request.on("error", () => markEnded(undefined)); request.end();
      return {
        frames,
        /** Resolves once the server ends the stream. */
        ended,
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

test("a desktop paired to aiden serve reads its chats' Inbox state and answers its runs", async (t) => {
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
  // The host places the row by the desktop's own Inbox rules, ordered by the wait.
  assert.equal(waiting.inboxBucket, "needs_you"); assert.equal(waiting.inboxSortAt, waiting.attentionSince);
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
  assert.equal(replied.inboxBucket, "updates"); assert.equal(replied.inboxSortAt, replied.lastAssistantAt);
  const read = await mac.request(`/chats/${chatId}/read`, "POST", {}, "read-inbox-test-000001");
  assert.ok(read.status === 200 || read.status === 204, JSON.stringify(read));
  const seen = await summaryRow();
  assert.equal(seen.unread, false); assert.equal(seen.inboxBucket, "earlier"); assert.equal(seen.inboxSortAt, seen.updatedAt);

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
  assert.equal(triaged.inboxBucket, "pinned"); assert.equal(triaged.inboxSortAt, pinned.data.pinnedAt);
  await feed.next((frame) => frame.type === "chat.upsert" && frame.payload.id === chatId && frame.payload.pinnedAt === pinned.data.pinnedAt, "a pinned chat.upsert");

  // Read markers and triage live in this data dir and survive a restart.
  feed.close();
  await first.stop();
  await startServer(t, dir);
  const after = await summaryRow();
  assert.equal(after.unread, false); assert.equal(after.pinnedAt, pinned.data.pinnedAt); assert.equal(after.triageRevision, 1);
  // Done with no newer output outranks the pin, and keeps the pin's time for when it comes back.
  const done = await mac.request(`/chats/${chatId}/triage`, "POST", { done: true, ifRevision: 1 }, "triage-inbox-test-0003");
  assert.equal(done.status, 200, JSON.stringify(done));
  const doneRow = await summaryRow();
  assert.equal(doneRow.inboxBucket, "done"); assert.equal(doneRow.inboxSortAt, pinned.data.pinnedAt);
});

test("a desktop paired before host grants existed picks them up without pairing again; a phone controls foreign runs; revoke closes streams", async (t) => {
  const dir = temporary(t);
  await fakeProvider(t, dir);
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const { daemon, remote, status } = await startServer(t, dir);
  const hostGrants = [...api.AIDEN_REMOTE_HOST_CAPABILITIES];

  // A Mac paired with what it held before this host served host grants: legacy grants, progress opt-in.
  const macIssued = await remote.state.issueDevice({ name: "Old Mac", type: "mac", clientVersion: "test",
    capabilities: [...api.AIDEN_REMOTE_LEGACY_CAPABILITIES], acceptsProgressCapabilities: true });
  const mac = client(dir, status.lanPort, macIssued.credential);
  const macServer = (await mac.request("/server")).data;
  for (const grant of hostGrants) {
    assert.ok(macServer.serverCapabilities.includes(grant), `${grant} offered in ${macServer.serverCapabilities}`);
    assert.equal(macServer.capabilities.includes(grant), false, `${grant} not yet held`);
  }
  // Steering and question answers are not advertised: this host's runs take neither.
  assert.equal(macServer.features.includes("chat-run-input-v1"), false);
  assert.equal(macServer.features.includes("chat-question-prompts-v1"), false);
  const deniedFeed = await mac.request("/host/events");
  assert.equal(deniedFeed.status, 403, JSON.stringify(deniedFeed));
  assert.equal(deniedFeed.data.error.code, "capability_denied");
  const deniedRun = await mac.request("/runs/run-unknown/events");
  assert.equal(deniedRun.status, 403, JSON.stringify(deniedRun));
  assert.equal(deniedRun.data.error.code, "capability_denied");
  // What the desktop's peer registry asks for on its first connection after a relaunch.
  const upgraded = await mac.request("/device/capabilities", "POST", { accepts: hostGrants });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded));
  for (const grant of hostGrants) assert.ok(upgraded.data.capabilities.includes(grant), JSON.stringify(upgraded.data));
  const feed = mac.events("/host/events");
  t.after(() => feed.close());
  await feed.next((frame) => frame.type === "snapshot", "snapshot");

  // A phone hears the phone run subset, read markers and triage, never the host feed or steering.
  const phoneIssued = await remote.state.issueDevice({ name: "Test phone", type: "iphone", clientVersion: "test", acceptsProgressCapabilities: true });
  const phone = client(dir, status.lanPort, phoneIssued.credential);
  const phoneServer = (await phone.request("/server")).data;
  for (const token of ["phone-run-control-v1", "chat-read-state-v1", "chat-triage-v1"]) assert.ok(phoneServer.features.includes(token), `${token} in ${phoneServer.features}`);
  for (const token of ["host-events-v1", "run-control-v1", "chat-run-input-v1", "chat-question-prompts-v1"]) assert.equal(phoneServer.features.includes(token), false, token);
  assert.deepEqual(["runs:observe", "runs:control"].filter((grant) => phoneServer.serverCapabilities.includes(grant)), ["runs:observe", "runs:control"]);
  const phoneUpgrade = await phone.request("/device/capabilities", "POST", { accepts: ["runs:observe", "runs:control"] });
  assert.equal(phoneUpgrade.status, 200, JSON.stringify(phoneUpgrade));
  assert.equal((await phone.request("/host/events")).status, 403);

  // Another device starts a run (revoking a device denies its own runs' approvals); it waits on its approval.
  const starter = client(dir, status.lanPort, (await remote.state.issueDevice({ name: "Starter", type: "mac", clientVersion: "test" })).credential);
  const created = await starter.request("/chats", "POST", { workspaceId: workspace.id, providerId: "cli-test", modelId: "test" }, "create-grants-test-0001");
  assert.equal(created.status, 201, JSON.stringify(created));
  const chatId = created.data.id;
  assert.equal((await starter.request(`/chats/${chatId}/turns`, "POST", { text: "List the files" }, "turn-grants-test-00001")).status, 202);
  const run = await until(async () => daemon.runs.currentRunForChat(chatId), (value) => value?.pendingApprovalIds.length === 1, "a pending approval");
  const approvalId = run.pendingApprovalIds[0];
  const runStream = mac.events(`/runs/${run.runId}/events`);
  t.after(() => runStream.close());
  await runStream.next(() => true, "run");

  // This host keeps no remembered approvals: "Always allow" is refused and the approval stays pending.
  const always = await phone.request(`/runs/${run.runId}/approvals/${approvalId}/respond`, "POST", { decision: "allow", scope: "always" }, "approve-grants-test-01");
  assert.equal(always.status, 400, JSON.stringify(always));
  assert.deepEqual(daemon.runs.currentRunForChat(chatId)?.pendingApprovalIds, [approvalId]);

  // Revoking the Mac ends its host feed and run stream; the run goes on.
  const revoked = await remote.command(["revoke", macIssued.device.id]);
  assert.equal(revoked.revoked, true, JSON.stringify(revoked));
  await Promise.race([
    Promise.all([feed.ended, runStream.ended]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Revoking the Mac did not end its host feed and run stream")), 15000).unref()),
  ]);
  const afterRevoke = await mac.request("/server");
  assert.equal(afterRevoke.status, 403, JSON.stringify(afterRevoke));
  assert.equal(afterRevoke.data.error.code, "credential_revoked");

  // The phone allows the run once, though it did not start it.
  const allowed = await phone.request(`/runs/${run.runId}/approvals/${approvalId}/respond`, "POST", { decision: "allow", scope: "once" }, "approve-grants-test-02");
  assert.equal(allowed.status, 200, JSON.stringify(allowed));
  await daemon.llmClient.waitForChatIdle(chatId);
  const row = (await phone.request("/chat-summaries")).data.summaries.find((summary) => summary.id === chatId);
  assert.equal(row?.unread, true, JSON.stringify(row));

  // The phone triages under the chat:write it was paired with; a read-only phone is refused.
  const phoneDone = await phone.request(`/chats/${chatId}/triage`, "POST", { done: true, ifRevision: 0 }, "phone-triage-test-0001");
  assert.equal(phoneDone.status, 200, JSON.stringify(phoneDone));
  assert.equal(phoneDone.data.revision, 1); assert.ok(phoneDone.data.doneAt);
  assert.equal((await phone.request("/chat-summaries")).data.summaries.find((summary) => summary.id === chatId)?.doneAt, phoneDone.data.doneAt);
  const reader = client(dir, status.lanPort, (await remote.state.issueDevice({ name: "Reader", type: "android", clientVersion: "test",
    capabilities: ["server:read", "chat:read"] })).credential);
  const refused = await reader.request(`/chats/${chatId}/triage`, "POST", { pinned: true, ifRevision: 1 }, "phone-triage-test-0002");
  assert.equal(refused.status, 403, JSON.stringify(refused));
  assert.equal(refused.data.error.code, "capability_denied");
});

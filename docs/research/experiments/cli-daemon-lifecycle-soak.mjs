/** Offline research: repeated real SDK bind/restore/dispose through Aiden's daemon.
 * Build packages/cli first. Run from root with node --expose-gc and optional
 * --duration-seconds 5400 --interval-seconds 30 --output /absolute/results.json.
 * Only synthetic temporary workspaces and one loopback HTTP server are used.
 */
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import * as api from "../../../packages/cli/dist/parity-test-api.js";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const durationSeconds = Number(args.get("--duration-seconds") ?? 10);
const intervalSeconds = Number(args.get("--interval-seconds") ?? 1);
assert.ok(Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 7_200);
assert.ok(Number.isFinite(intervalSeconds) && intervalSeconds >= 0 && intervalSeconds <= 60);
const output = resolve(args.get("--output") ?? "docs/research/experiments/cli-daemon-lifecycle-soak-results.json");
assert.equal(Boolean(process.env.AIDEN_CONFIG_DIR?.trim()), false,
  "Unset AIDEN_CONFIG_DIR for this isolated probe; a portable override redirects the shared memory store.");
const started = Date.now(), deadline = started + durationSeconds * 1_000;
const root = mkdtempSync(join(tmpdir(), "aiden-harness-soak-"));
const counts = { requests: 0, binds: 0, shutdowns: 0, disposals: 0, completedTurns: 0, cycles: 0 };
let expectedRequest;
const originalFetch = globalThis.fetch;
let endpoint;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, endpoint, "research must not contact a non-loopback provider");
  return originalFetch(input, init);
};
const receipts = [];
const record = {
  version: 1, evidenceKind: "offline-lifecycle-soak", startedAt: new Date(started).toISOString(),
  durationSeconds, intervalSeconds, node: process.version, platform: `${process.platform}/${process.arch}`,
  forcedGcAvailable: typeof globalThis.gc === "function",
  sourceSha256: Object.fromEntries(["packages/cli/src/daemon-chats.ts", "packages/cli/src/extensions/todo.ts", "packages/cli/dist/parity-test-api.js"].map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
  status: "running", counts, receipts,
  limitations: ["Scripted loopback responses measure lifecycle invariants, not model decisions or quality.", "Post-GC heap and active resource trends are diagnostics; RSS growth alone does not prove a leak.", "The temporary workspace is replaced each cycle; this does not emulate a single ever-growing production transcript.", "Private chats, credentials and real providers are not accessed. No default policy or rollout setting changes."],
};
function save() {
  writeFileSync(`${output}.next`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${output}.next`, output);
}
const server = createServer(async (request, response) => {
  try {
    assert.ok(expectedRequest, "unexpected provider request");
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body), state = expectedRequest;
    counts.requests++;
    let delta, finishReason;
    if (!state.called) {
      state.called = true;
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `soak-${counts.requests}`, type: "function", function: { name: "todo", arguments: JSON.stringify(state.action) } }] };
      finishReason = "tool_calls";
    } else {
      assert.equal(state.finished, false, "no third request expected for a scripted turn");
      const observation = parsed.messages.filter(({ role }) => role === "tool").at(-1);
      assert.ok(observation, "actual provider must receive todo observation");
      const text = JSON.stringify(observation);
      assert.ok(text.includes(state.subject), "current session checkpoint is visible after restore");
      assert.ok(!text.includes(state.foreignSubject), "other chat checkpoint must not enter current todo state");
      state.finished = true;
      delta = { role: "assistant", content: "Checkpoint verified." }; finishReason = "stop";
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    if (expectedRequest) expectedRequest.error = error;
    response.writeHead(500); response.end("Offline invariant failed");
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
endpoint = `http://127.0.0.1:${server.address().port}`;
const seedLoader = new api.DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await seedLoader.reload();
const model = { id: "test", name: "Offline soak", provider: "cli-soak", api: "openai-completions", baseUrl: `${endpoint}/v1`, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const { session: seed } = await api.createAgentSession({ cwd: root, agentDir: root, model, resourceLoader: seedLoader, sessionManager: api.SessionManager.inMemory(root), settingsManager: api.SettingsManager.inMemory({}), tools: [] });
const prototype = Object.getPrototypeOf(seed), originalBind = prototype.bindExtensions;
seed.dispose();
prototype.bindExtensions = async function (...parameters) {
  counts.binds++;
  const originalEmit = this.extensionRunner.emit.bind(this.extensionRunner);
  this.extensionRunner.emit = async (event) => {
    if (event.type === "session_shutdown") counts.shutdowns++;
    return originalEmit(event);
  };
  const originalDispose = this.dispose.bind(this);
  this.dispose = () => { counts.disposals++; return originalDispose(); };
  return originalBind.apply(this, parameters);
};

try {
  while (Date.now() < deadline || counts.cycles === 0) {
    const cycle = counts.cycles + 1, cycleStarted = performance.now();
    const directory = mkdtempSync(join(root, "cycle-"));
    api.atomicJson(join(directory, "models.json"), { providers: { "cli-soak": { api: "openai-completions", baseUrl: `${endpoint}/v1`, apiKey: "synthetic-not-a-secret", models: [model] } } });
    const workspace = await api.workspaceCommand(directory, ["add", directory]);
    await api.workspaceCommand(directory, ["access", workspace.id, "full"]);
    const daemon = api.createDaemonChats(directory), errors = [];
    let ownerSubscriptions = 0;
    const owner = { id: 0, documentId: `owner-${cycle}`, isDestroyed: () => false,
      onInvalidated: () => { ownerSubscriptions++; return () => { ownerSubscriptions--; }; },
      send: (channel, value) => { if (channel === "chat:error") errors.push(value); } };
    try {
      for (const chatId of ["a", "b"]) await daemon.chatStore.create({ id: chatId, title: `Synthetic ${chatId}`, workspaceId: workspace.id });
      // Interleave independent chats before resuming each, exposing stale shared state.
      for (const [chatId, action] of [["a", "create"], ["b", "create"], ["a", "list"], ["b", "list"]]) {
        const subject = `cycle-${cycle}-${chatId}-checkpoint`, foreignSubject = `cycle-${cycle}-${chatId === "a" ? "b" : "a"}-checkpoint`;
        expectedRequest = { action: action === "create" ? { action, subject } : { action }, subject, foreignSubject, called: false, finished: false };
        const stream = `${cycle}-${chatId}-${action}`, admission = daemon.llmClient.beginChatTurn(chatId, stream, owner.documentId);
        assert.ok(admission);
        const watchdog = setTimeout(() => { void daemon.llmClient.cancelChat(chatId); }, 20_000);
        try {
          await daemon.chatStore.appendMessage(chatId, { role: "user", content: `${action} current checkpoint` }); admission.settleAsyncWork();
          assert.equal(await daemon.llmClient.start(stream, { chatId, workspaceId: workspace.id, providerId: "cli-soak", model: "test", messages: [{ role: "user", content: `${action} current checkpoint` }] }, owner, { usageSource: "chat" }), true);
          await daemon.llmClient.waitForChatIdle(chatId);
          if (expectedRequest.error) throw expectedRequest.error;
          assert.equal(expectedRequest.finished, true, "both scripted requests must settle");
          assert.deepEqual(errors, []);
          const release = api.acquireLease(daemon.sessionPath(chatId)); release();
          assert.equal(ownerSubscriptions, 0, "session owner callback must be released after each turn");
          counts.completedTurns++;
        } finally { clearTimeout(watchdog); admission.release(); expectedRequest = undefined; }
      }
    } finally { await daemon.stop(); rmSync(directory, { recursive: true, force: true }); }
    counts.cycles++;
    assert.equal(counts.binds, counts.completedTurns);
    assert.equal(counts.shutdowns, counts.completedTurns);
    assert.equal(counts.disposals, counts.completedTurns);
    assert.equal(counts.requests, counts.completedTurns * 2);
    // Include an idle boundary so pending HTTP/socket cleanup can occur.
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    globalThis.gc?.();
    const resources = process.getActiveResourcesInfo().reduce((total, name) => ({ ...total, [name]: (total[name] ?? 0) + 1 }), {});
    receipts.push({ cycle, elapsedMs: Date.now() - started, cycleDurationMs: performance.now() - cycleStarted, ...process.memoryUsage(), resources });
    save();
    console.log(JSON.stringify({ cycle, elapsedSeconds: Math.round((Date.now() - started) / 1000), completedTurns: counts.completedTurns, heapUsed: receipts.at(-1).heapUsed, resources }));
    const sleep = Math.min(intervalSeconds * 1000, Math.max(0, deadline - Date.now()));
    if (sleep) await delay(sleep);
  }
  record.status = "passed";
} catch (error) {
  record.status = "failed";
  record.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  prototype.bindExtensions = originalBind;
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
  globalThis.gc?.();
  record.finishedAt = new Date().toISOString();
  record.finalResources = process.getActiveResourcesInfo();
  record.finalMemory = process.memoryUsage();
  save();
  console.log(JSON.stringify({ status: record.status, ...counts, finishedAt: record.finishedAt }));
}

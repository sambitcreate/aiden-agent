import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import * as api from "../dist/parity-test-api.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function temporary(t) { const dir = mkdtempSync(join(tmpdir(), "aiden-parity-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function extension(extension) {
  const events = new Map(), commands = new Map(), tools = new Map(); let name;
  extension.factory({ on: (event, handler) => events.set(event, handler), registerCommand: (name, command) => commands.set(name, command), registerTool: (tool) => tools.set(tool.name, tool), getSessionName: () => name, setSessionName: (value) => { name = value; } });
  return { events, commands, tools, name: () => name };
}

test("atomic stores serialize mutations, protect credentials, and reject cross-process contention/corruption", async (t) => {
  const dir = temporary(t), file = join(dir, "store.json"), store = new api.JsonStore(file, []);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.update((draft) => { draft.push(i); })));
  assert.equal((await store.load()).length, 10);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const release = api.acquireLease(file);
  await assert.rejects(new api.JsonStore(file, []).update(() => {}), /Another Aiden process/);
  release();
  writeFileSync(file, "broken");
  await assert.rejects(store.update(() => {}), /Cannot read/);
  assert.equal(readFileSync(file, "utf8"), "broken");
  assert.deepEqual(api.splitArgs('save "two words.json" \'a b\''), ["save", "two words.json", "a b"]);
  assert.throws(() => api.splitArgs('"unfinished'), /Unfinished/);
});

test("workspace identity is canonical and all tools require one-shot approval in ask mode", async (t) => {
  const dir = temporary(t), workspace = await api.workspaceCommand(dir, ["add", dir]);
  assert.equal(api.accessFor(dir, dir), "ask");
  const harness = extension(api.createSessionParityExtension(dir));
  const call = harness.events.get("tool_call");
  let approvals = 0;
  const ctx = { cwd: dir, hasUI: true, ui: { confirm: async () => { approvals++; return true; } } };
  assert.equal(await call({ toolName: "write", input: { path: "a" } }, ctx), undefined);
  assert.equal(await call({ toolName: "write", input: { path: "b" } }, ctx), undefined);
  assert.equal(approvals, 2);
  assert.equal((await call({ toolName: "mcp_send", input: {} }, { ...ctx, hasUI: false })).block, true);
  await api.workspaceCommand(dir, ["access", workspace.id, "none"]);
  assert.equal((await call({ toolName: "read", input: {} }, ctx)).block, true);
  await api.workspaceCommand(dir, ["access", workspace.id, "full"]);
  assert.equal(await call({ toolName: "write", input: {} }, ctx), undefined);
});

test("portable export and context projection include only the active branch", async (t) => {
  const dir = temporary(t), manager = api.SessionManager.inMemory(dir);
  const first = manager.appendMessage({ role: "user", content: "Keep this", timestamp: 100 });
  manager.appendMessage({ role: "user", content: "Abandoned secret", timestamp: 200 });
  manager.branch(first);
  manager.appendMessage({ role: "user", content: "Active branch", timestamp: 300 });
  manager.appendSessionInfo("Test title");
  const target = join(dir, "chat.aiden-chat.json");
  await api.exportSession(manager, target);
  const result = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(result.schema, "aiden.chat.export"); assert.equal(result.version, 1);
  assert.equal(result.chat.title, "Test title");
  assert.deepEqual(result.chat.messages.map((message) => message.content), ["Keep this", "Active branch"]);
  assert.deepEqual(api.liveMessages({ sessionManager: manager }).map((message) => message.content), ["Keep this", "Active branch"]);
});

test("title generation preserves manual renames and seeds offline sessions", async (t) => {
  const dir = temporary(t), harness = extension(api.createSessionParityExtension(dir));
  const manager = api.SessionManager.inMemory(dir);
  const ctx = { sessionManager: manager, model: undefined };
  await harness.events.get("before_agent_start")({ prompt: "Build my CLI" }, ctx);
  assert.equal(harness.name(), "Build my CLI");
  await harness.events.get("before_agent_start")({ prompt: "Second message" }, ctx);
  assert.equal(harness.name(), "Build my CLI");
});

test("insight keys use authenticated file encryption and separate provider names", async (t) => {
  const dir = temporary(t), credentials = api.insightCredentials(dir);
  await credentials.write("openrouter", "benchmark-secret");
  assert.equal(await credentials.read("openrouter"), "benchmark-secret");
  assert.equal(await credentials.read("aa"), undefined);
  assert.ok(!readFileSync(join(dir, "credentials", "insights.json"), "utf8").includes("benchmark-secret"));
  await credentials.delete("openrouter"); assert.equal(await credentials.read("openrouter"), undefined);
});

test("catalog status and insight reads never fetch, and model metadata fetch is fixed and credential-free", async (t) => {
  const dir = temporary(t), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, "https://models.dev/api.json");
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { accept: "application/json" });
    return new Response(JSON.stringify({ openai: { id: "openai", models: { test: { id: "test", name: "Test" } } } }));
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await api.catalogCommand(dir, ["models-dev", "status"]), null);
  assert.equal(await api.insightsCommand(dir, ["aa", "show"]), null);
  assert.equal(calls, 0);
  await api.catalogCommand(dir, ["models-dev", "fetch"]); assert.equal(calls, 1);
  assert.ok(readFileSync(join(dir, "models-dev.json"), "utf8").includes('"schemaVersion": 1'));
});

test("schedule CRUD uses shared validation, preview and persisted state", async (t) => {
  const dir = temporary(t), input = join(dir, "input.json");
  writeFileSync(input, JSON.stringify({ name: "Review", mode: "llm", cron: "0 9 * * *", timezone: "UTC", prompt: "Review the repository", permission: "read-only", enabled: false }));
  const task = await api.scheduleCommand(dir, ["save", input]);
  assert.equal(task.name, "Review"); assert.equal(task.enabled, false);
  assert.equal((await api.scheduleCommand(dir, ["list"])).length, 1);
  assert.equal((await api.scheduleCommand(dir, ["preview", "0 9 * * *", "UTC"])).length, 5);
  await api.scheduleCommand(dir, ["remove", task.id]);
  assert.deepEqual(await api.scheduleCommand(dir, ["list"]), []);
});

test("child process parses actual event records, passes prompt via stdin, and enforces time budgets", async (t) => {
  const dir = temporary(t), child = join(dir, "child.mjs"), original = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = child; t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  writeFileSync(child, `let input=""; for await (const chunk of process.stdin) input += chunk; console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:input}],stopReason:"stop"}}));`);
  const result = await api.runChild({ cwd: dir, prompt: "secret prompt", permission: "read-only" });
  assert.equal(result.output, "secret prompt");
  writeFileSync(child, `setInterval(() => {}, 1000);`);
  await assert.rejects(api.runChild({ cwd: dir, prompt: "x", permission: "read-only", timeoutMs: 30 }), /time budget/);
});

test("serve routes concurrent CLI commands and releases its lease on shutdown", async (t) => {
  const dir = temporary(t), controller = new AbortController();
  const promise = api.serve(dir, controller.signal);
  t.after(async () => { controller.abort(); await promise; });
  // Wait on filesystem readiness rather than a fixed startup delay.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (statSync(api.daemonSocket(dir)).isSocket()) break; } catch { /* Process may already have exited. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await api.scheduleCommand(dir, ["list"]), []);
  controller.abort(); await promise;
  const release = api.acquireLease(join(dir, "serve")); release();
});

test("serve lifecycle recovers stale leases and never signals a recycled PID", async (t) => {
  const dir = temporary(t);
  assert.equal(api.daemonStatus(dir).running, false);
  await assert.rejects(api.stopDaemon(dir), /not running/);

  // A lock whose owner PID is dead is reclaimed.
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  api.atomicJson(join(dir, "serve.lock", "owner.json"), { pid: dead, startedAt: Date.now() });
  assert.equal(api.recoverStaleServeLease(dir), true);
  assert.equal(existsSync(join(dir, "serve.lock")), false);

  // A live PID whose command line is not this CLI's `serve` is treated as a
  // recycled PID: status reports not-running and stop clears the lock without
  // ever signaling the foreign process.
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  api.atomicJson(join(dir, "serve.lock", "owner.json"), { pid: process.pid, startedAt: Date.now() });
  assert.equal(api.daemonStatus(dir).running, false);
  await assert.rejects(api.stopDaemon(dir), /stale lock/);
  assert.equal(existsSync(join(dir, "serve.lock")), false);
  assert.equal(api.pidAlive(process.pid), true);
});

test("a real child completes through a local compatible provider with no recursive tools", async (t) => {
  const dir = temporary(t), requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Local child succeeded" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const original = { AIDEN_CLI_ENTRY: process.env.AIDEN_CLI_ENTRY, AIDEN_CODING_AGENT_DIR: process.env.AIDEN_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
  Object.assign(process.env, { AIDEN_CLI_ENTRY: join(pkg, "dist/app/cli.js"), AIDEN_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" });
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const result = await api.runChild({ cwd: dir, prompt: "Say hello", permission: "read-only", provider: "cli-test", model: "test", timeoutMs: 15000 });
  assert.equal(result.output, "Local child succeeded"); assert.equal(requests.length, 1);
  const names = requests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(names.includes("read")); assert.ok(!names.includes("bash")); assert.ok(!names.includes("subagent"));
});

test("MCP validates transports and redacts configured secrets from listing", async (t) => {
  const dir = temporary(t), file = join(dir, "server.json");
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "Remote", transport: "http", url: "http://example.com", enabled: true }), /HTTPS/);
  assert.throws(() => api.validateMcpServer({ id: "../remote", name: "Remote", transport: "stdio", command: "node", enabled: true }), /id, name/);
  writeFileSync(file, JSON.stringify({ id: "local", name: "Local", transport: "stdio", command: "node", enabled: false, env: { SECRET: "do-not-list" } }));
  await api.mcpCommand(dir, ["add", file]);
  const listed = await api.mcpCommand(dir, ["list"]);
  assert.equal(listed.length, 1); assert.ok(!JSON.stringify(listed).includes("do-not-list"));
  await api.mcpCommand(dir, ["remove", "local"]); assert.deepEqual(await api.mcpCommand(dir, ["list"]), []);
});

test("provider import rejects invalid configuration without replacing the previous file", async (t) => {
  const dir = temporary(t), original = { providers: {} };
  api.atomicJson(join(dir, "models.json"), original);
  await assert.rejects(api.importProviders(dir, { providers: { broken: { models: "invalid" } } }));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")), original);
});

test("Telegram is disabled without an explicit owner even when a token exists", async (t) => {
  const dir = temporary(t);
  api.atomicJson(join(dir, "telegram.json"), { telegramEnabled: true });
  const previous = process.env.AIDEN_TELEGRAM_TOKEN; process.env.AIDEN_TELEGRAM_TOKEN = "test-only";
  t.after(() => { if (previous === undefined) delete process.env.AIDEN_TELEGRAM_TOKEN; else process.env.AIDEN_TELEGRAM_TOKEN = previous; });
  const chats = api.createDaemonChats(dir);
  let calls = 0;
  const telegram = api.createCliTelegram(dir, chats, { getMe() { calls++; throw new Error("must not call"); } });
  await telegram.start(); await telegram.stopAndSettle(); await chats.stop();
  assert.equal(calls, 0); assert.equal(telegram.getStatus().status, "disabled");
});

test("CLI speech uses an isolated worker and rejects uninstalled models without downloading", async (t) => {
  const dir = temporary(t), original = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const runtime = api.createCliSpeech(dir);
  try {
    const status = await runtime.service.status();
    assert.equal(typeof status.engine.ready, "boolean");
    assert.equal(status.input.maximumSeconds, 60);
    assert.ok(status.models.every((model) => !model.installed));
    await assert.rejects(runtime.service.select({ modelId: "parakeet-v3" }), /Download/);
    await assert.rejects(runtime.service.transcribe({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1, modelId: "parakeet-v3", pcmBase64: "AAA=" }), /not installed/);
    assert.deepEqual(runtime.models.localModelDownloadStates(), []);
  } finally { await runtime.stop(); }
});

test("daemon chat generation persists context and denies revoked workspace authority", async (t) => {
  const dir = temporary(t), requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Remembered" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  await api.workspaceCommand(dir, ["access", workspace.id, "full"]);
  const daemon = api.createDaemonChats(dir);
  await daemon.chatStore.create({ id: "telegram-test", title: "Daemon chat", workspaceId: workspace.id });
  const events = [];
  const owner = { id: 0, documentId: "test", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, value) => events.push({ channel, value }) };
  async function turn(content) {
    const admission = daemon.llmClient.beginChatTurn("telegram-test", "stream", "test"); assert.ok(admission);
    assert.equal(daemon.llmClient.beginChatTurn("telegram-test", "other", "test"), null);
    try {
      await daemon.chatStore.appendMessage("telegram-test", { role: "user", content });
      admission.settleAsyncWork();
      await daemon.llmClient.start("stream", { chatId: "telegram-test", workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content }] }, owner, { usageSource: "telegram" });
      await daemon.llmClient.waitForChatIdle("telegram-test");
    } finally { admission.release(); }
  }
  await turn("Remember the word apricot"); await turn("What word?");
  assert.equal(events.filter((event) => event.channel === "chat:error").length, 0, JSON.stringify(events));
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "todo"));
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "recall_memory"));
  assert.ok(JSON.stringify(requests[1].messages).includes("apricot"));
  assert.equal((await daemon.chatStore.get("telegram-test")).messages.length, 4);
  await api.workspaceCommand(dir, ["access", workspace.id, "none"]);
  await turn("Must be denied");
  assert.equal(requests.length, 2); assert.equal(events.at(-1).channel, "chat:error");
  await daemon.stop(); assert.deepEqual(daemon.activity.snapshot().activeChatIds, []);
});

test("built CLI creates and safely removes its own managed worktree", (t) => {
  const dir = temporary(t), repo = join(dir, "repo"), agentDir = join(dir, "agent");
  function git(args) { const result = spawnSync("git", args, { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); }
  git(["init", repo]);
  git(["-C", repo, "-c", "user.name=Aiden Test", "-c", "user.email=aiden-test@example.invalid", "commit", "--allow-empty", "-m", "Initial"]);
  function cli(args) { const result = spawnSync(process.execPath, [join(pkg, "dist/app/cli.js"), ...args], { cwd: repo, env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, encoding: "utf8", timeout: 30000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }
  const created = cli(["worktree", "create", "feature/cli-parity-test"]);
  assert.ok(statSync(created.path).isDirectory());
  assert.equal(cli(["worktree", "list"]).length, 1);
  assert.equal(cli(["worktree", "remove", created.path]).removed, created.path);
  assert.deepEqual(cli(["worktree", "list"]), []);
});

test("source-attributed usage is stored in the desktop ledger format", async (t) => {
  const dir = temporary(t);
  const message = { role: "assistant", provider: "test", model: "test", timestamp: Date.now(), stopReason: "stop", content: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
  await Promise.all([api.recordUsage(dir, "chat", message), api.recordUsage(dir, "advisor", message)]);
  const raw = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
  assert.equal(raw.version, 1); assert.deepEqual(raw.buckets.map((bucket) => bucket.source).sort(), ["advisor", "chat"]);
  assert.equal(raw.buckets.reduce((total, bucket) => total + bucket.tokens.total, 0), 30);
});

test("portable chat import persists user-only conversations and never changes its source", async (t) => {
  const dir = temporary(t), source = join(dir, "source.aiden-chat.json");
  api.atomicJson(source, { schema: "aiden.chat.export", version: 1, chat: { title: "Imported chat", messages: [{ id: "one", role: "user", content: "Hello", createdAt: 100 }] } });
  const before = readFileSync(source);
  const result = await api.importSession(join(dir, "agent"), dir, source);
  assert.equal(result.messages, 1); assert.notEqual(result.path, source);
  const imported = api.SessionManager.open(result.path);
  assert.equal(imported.getSessionName(), "Imported chat");
  assert.equal(api.messageText(imported.buildSessionContext().messages[0].content), "Hello");
  assert.deepEqual(readFileSync(source), before);
});

test("desktop v4 import reads through the repository port into an independent CLI journal", async (t) => {
  const dir = temporary(t), repository = api.createCurrentPiSessionRepository(join(dir, "desktop"));
  const session = await repository.create({ id: "desktop-chat", cwd: dir, metadata: { title: "Desktop chat" } });
  await session.appendMessage({ role: "user", content: "From desktop", timestamp: Date.now() });
  const metadata = await session.getMetadata(), before = readFileSync(metadata.path);
  const imported = await api.importSession(join(dir, "agent"), dir, metadata.path);
  assert.equal(imported.messages, 1); assert.equal(api.SessionManager.open(imported.path).getSessionName(), "Desktop chat");
  assert.deepEqual(readFileSync(metadata.path), before);
});


test("Remote HTTPS serves private workspaces, persists turns once, replays SSE and revokes devices", async (t) => {
  const dir = temporary(t), requests = [];
  const provider = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Remote succeeded" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const daemon = api.createDaemonChats(dir), scheduler = api.createCliScheduler(dir);
  const generationEvents = [];
  const start = daemon.llmClient.start;
  daemon.llmClient.start = (id, params, owner, options) => start(id, params, { ...owner, send: (channel, payload) => { generationEvents.push({ channel, payload }); owner.send(channel, payload); } }, options);
  const remote = await api.createCliRemote(dir, daemon, scheduler, { discovery: { async start() {}, stop() {} } });
  t.after(async () => { await remote.stop(); await scheduler.service.stopAndSettle(); });
  await remote.start();
  const status = await remote.service.status(); assert.equal(status.running, true);
  const issued = await remote.state.issueDevice({ name: "Test phone", type: "iphone", clientVersion: "test" });
  const ca = readFileSync(join(dir, "remote-tls/ca-certificate.pem"));
  async function request(path, method = "GET", body, key) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: status.lanPort, ca, path: `/api/aiden/v1${path}`, method,
        headers: { authorization: `Bearer ${issued.credential}`, "aiden-protocol-version": "1", ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) } }, (response) => {
        let data = ""; response.on("data", (chunk) => { data += chunk; }); response.on("end", () => resolve({ status: response.statusCode, data: response.headers["content-type"]?.includes("json") ? JSON.parse(data) : data }));
      });
      request.setTimeout(15000, () => request.destroy(new Error("Remote request timed out")));
      request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const workspaces = await request("/workspaces"); assert.equal(workspaces.status, 200, JSON.stringify(workspaces)); assert.ok(!JSON.stringify(workspaces.data).includes(dir));
  const created = await request("/chats", "POST", { workspaceId: workspace.id, providerId: "cli-test", modelId: "test" }, "create-cli-test-0001");
  assert.equal(created.status, 201, JSON.stringify(created));
  const path = `/chats/${created.data.id}/turns`;
  const turn = await request(path, "POST", { text: "Hello remote" }, "turn-cli-test-000001");
  assert.equal(turn.status, 202, JSON.stringify(turn));
  await daemon.llmClient.waitForChatIdle(created.data.id);
  const repeated = await request(path, "POST", { text: "Hello remote" }, "turn-cli-test-000001");
  assert.deepEqual(repeated, turn); assert.equal(requests.length, 1, JSON.stringify(generationEvents));
  const chat = await request(`/chats/${created.data.id}`); assert.equal(chat.data.messages.at(-1).text, "Remote succeeded");
  const events = await request(`/streams/${turn.data.streamId}/events`);
  assert.equal(events.status, 200); assert.match(events.data, /event: done/); assert.match(events.data, /event: timeline/); assert.match(events.data, /Remote succeeded/);
  assert.equal((await remote.command(["revoke", issued.device.id])).revoked, true);
  assert.equal((await request("/workspaces")).status, 403);
});

test("Bots retain one-shot notice, exact Custom tools, revocation and independent rollback anchors", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir), requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    const first = !parsed.messages.some((message) => message.role === "tool");
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "bot-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "generated.txt", content: "Bot-owned write" }) } }] } : { role: "assistant", content: "Bot finished" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "bot", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "bot", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const runtime = await api.createCliBots(dir, daemon); daemon.setBots(runtime);
  t.after(async () => { await runtime.stop(); await daemon.stop(); });
  const audienceId = "cli:local", app = runtime.application;
  const notice = await app.noticeStatus(audienceId); assert.equal(notice.requiresAcknowledgement, true);
  assert.equal((await app.capabilityCatalog(audienceId)).notice.requiresAcknowledgement, true);
  await app.acknowledgeNotice(audienceId, { version: notice.version, decision: "customize_first", confirmedForeground: true });
  const catalog = await app.capabilityCatalog(audienceId);
  const provider = catalog.providers.find((item) => item.label === "cli-test"); assert.ok(provider, JSON.stringify(catalog.providers));
  const custom = { providerId: provider.id, modelId: provider.models[0].id, fileScopeIds: catalog.fileScopes.filter((item) => item.kind === "bot_home").map((item) => item.id), shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] };
  const bot = await app.createBot({ audienceId, bot: { name: "Scoped helper", instructions: "Help in the Bot folder", avatar: "spark" }, access: { accessMode: "custom", catalogRevision: catalog.revision, custom } });
  const chat = await app.createChat({ audienceId, botId: bot.id, providerId: "cli-test", model: "test" });
  const lease = await runtime.authority.admit({ audienceId, botId: bot.id, chatId: chat.id });
  const tools = await runtime.tools(lease);
  assert.ok(tools.some((tool) => tool.name === "read_file")); assert.ok(!tools.some((tool) => tool.name === "run_command"));
  const write = tools.find((tool) => tool.name === "write_file");
  const result = await write.execute("one", { path: "note.txt", content: "Scoped" }); assert.ok(!result.isError);
  assert.equal(readFileSync(join(lease.authority.workingDirectory, "note.txt"), "utf8"), "Scoped");
  await assert.rejects(write.execute("escape", { path: "../escape.txt", content: "Denied" }));
  const turn = daemon.llmClient.beginChatTurn(chat.id, "bot-stream", "bot-owner"); assert.ok(turn);
  const generationEvents = [];
  const owner = { id: 0, documentId: "bot-owner", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, value) => generationEvents.push({ channel, value }) };
  await daemon.chatStore.appendMessage(chat.id, { role: "user", content: "Write a file" }); turn.settleAsyncWork();
  assert.equal(await daemon.llmClient.start("bot-stream", { chatId: chat.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Write a file" }] }, owner, { usageSource: "chat", botAudienceId: audienceId }), true);
  await daemon.llmClient.waitForChatIdle(chat.id); turn.release();
  assert.equal(generationEvents.filter((event) => event.channel === "chat:error").length, 0, JSON.stringify(generationEvents));
  assert.equal(readFileSync(join(lease.authority.workingDirectory, "generated.txt"), "utf8"), "Bot-owned write");
  assert.ok(JSON.stringify(requests[0].messages).includes("Help in the Bot folder"));
  assert.ok(!requests[0].tools.some((tool) => ["bash", "run_command", "web_search", "subagent"].includes(tool.function.name)));
  await app.revokeNoticeAudience(audienceId);
  await assert.rejects(write.execute("revoked", { path: "revoked.txt", content: "Denied" }));
  lease.release();
  assert.equal(statSync(join(dir, "authority/bot-anchor.json")).mode & 0o777, 0o600);
  await runtime.stop();
  const resumed = await api.createCliBots(dir, daemon);
  try { assert.equal((await resumed.application.get(bot.id)).name, "Scoped helper"); assert.equal((await resumed.application.noticeStatus(audienceId)).requiresAcknowledgement, true); }
  finally { await resumed.stop(); }
});

test("isolated subagent inference executes only parent-owned tools with immutable fork context", async (t) => {
  const dir = temporary(t), requests = [], original = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const first = !parsed.messages.some((message) => message.role === "tool");
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "read-test", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) } }] } : { role: "assistant", content: "Parent-owned tools succeeded" };
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const runtime = await api.createCliModelRuntime(dir); let effects = 0, approvals = 0; const diagnostics = [];
  const context = [{ role: "user", content: "Visible fork context: apricot", timestamp: 100 }];
  const result = await api.runCliSubagent(dir, { runtime: { model: runtime.getModel("cli-test", "test") }, workspaceRoot: dir, permission: "ask", thinkingLevel: "off", context: { mode: "fork", revisionHash: "test", messages: context }, request: { role: "scout", label: "Scout", task: "Read the note" }, policy: { deadlineMs: 15000 } }, [{
    name: "read_file", description: "Read the note", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => { effects++; return { content: [{ type: "text", text: "Apricot" }], details: {} }; },
  }], async () => { approvals++; }, (error) => diagnostics.push(error.message));
  assert.equal(result.status, "completed", JSON.stringify({ result, diagnostics, requests })); assert.equal(result.summary, "Parent-owned tools succeeded");
  assert.equal(effects, 1, JSON.stringify(requests)); assert.equal(approvals, 1); assert.equal(context.length, 1);
  assert.ok(JSON.stringify(requests[0].messages).includes("Visible fork context: apricot"));
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ["read_file"]);
  let revoked = false;
  const botTool = api.createBotSubagentTool(dir, { authority: { chatId: "bot-child-test", managedHome: { workspaceId: "bot-workspace" }, workingDirectory: dir, provider: { sourceProviderId: "cli-test", sourceModelId: "test" } }, signal: new AbortController().signal, revalidateBeforeEffect: async () => { if (revoked) throw new Error("Bot revoked"); } }, [
    { name: "read_file", description: "Read scoped note", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async () => ({ content: [{ type: "text", text: "Scoped note" }], details: {} }) },
    { name: "write_file", description: "Must never delegate", parameters: { type: "object" }, execute: async () => { throw new Error("Forbidden write"); } },
  ], async () => null);
  const child = await botTool.execute("bot-root", { tasks: [{ role: "scout", label: "Bot scout", task: "Read scoped note" }] });
  assert.match(JSON.stringify(child), /Status: completed/);
  assert.deepEqual(requests[2].tools.map((tool) => tool.function.name), ["read_file"]);
  revoked = true;
  await assert.rejects(botTool.execute("bot-revoked", { tasks: [{ role: "scout", label: "Bot scout", task: "Must not run" }] }), /Bot revoked/);
  assert.equal(requests.length, 4);
});

test("shared auth coordinator commits a returned credential once and suppresses a cancelled login", async () => {
  let commits = 0, provider = { id: "test", name: "Test", auth: { oauth: { login: async () => ({ type: "oauth", access: "test-only", refresh: "refresh", expires: Date.now() + 3600000 }) } } };
  const runtime = { getProvider: () => provider, listCredentials: async () => [], registerNativeProvider: (next) => { provider = next; }, login: async (_id, _method, interaction) => { const credential = await provider.auth.oauth.login(interaction); commits++; return credential; }, refresh: async () => ({}), logout: async () => {} };
  const coordinator = api.createCliAuthCoordinator(runtime, async () => {});
  async function login(cancel) {
    const flowId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const owner = { id: 1, documentId: "auth-test", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, payload) => { if (channel === "providers:auth:done") resolve(payload); else if (channel === "providers:auth:error") reject(new Error(payload.message)); } };
      const request = { flowId, providerId: "test", authType: "oauth" };
      coordinator.start(owner, request); if (cancel) coordinator.cancel(owner, request);
    });
  }
  try { assert.equal((await login(false)).cancelled, false); assert.equal(commits, 1); assert.equal((await login(true)).cancelled, true); assert.equal(commits, 1); }
  finally { await coordinator.shutdown(); }
});

test("V2 delegated writes use one-shot approval and native durable history", async (t) => {
  const dir = temporary(t), requests = [], original = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    const first = !parsed.messages.some((message) => message.role === "tool");
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "write-note", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "delegated.txt", content: "Approved native write" }) } }] } : { role: "assistant", content: "Delegated write finished" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [value, finish] of [[delta, null], [{}, first ? "tool_calls" : "stop"]]) response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: value, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const runtime = await api.createCliModelRuntime(dir), tools = new Map(), events = new Map(), commands = new Map(), notifications = [];
  await api.createSubagentsExtension(dir).factory({ on: (name, handler) => events.set(name, handler), registerCommand: (name, value) => commands.set(name, value), registerTool: (tool) => tools.set(tool.name, tool) });
  let confirmations = 0;
  const ctx = { cwd: dir, hasUI: true, model: runtime.getModel("cli-test", "test"), modelRegistry: new api.ModelRegistry(runtime), sessionManager: api.SessionManager.inMemory(dir), ui: { setStatus() {}, notify: (value) => notifications.push(value), confirm: async () => { confirmations++; return true; } } };
  t.after(async () => events.get("session_shutdown")?.({}, ctx));
  await events.get("before_agent_start")({}, ctx);
  const result = await tools.get("subagent").execute("root", { capabilities: { workspaceRead: true, workspaceWrite: true, web: false, mcp: [] }, tasks: [{ role: "scout", label: "Writer", task: "Write delegated.txt" }] }, undefined, undefined, ctx);
  assert.match(JSON.stringify(result), /completed/, JSON.stringify({ result, requests, notifications }));
  assert.ok(!JSON.stringify(requests[1].messages.filter((message) => message.role === "tool")).includes("error"), JSON.stringify(requests[1].messages.filter((message) => message.role === "tool")));
  assert.equal(readFileSync(join(dir, "delegated.txt"), "utf8"), "Approved native write");
  assert.equal(confirmations, 1);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === "write_file"));
  assert.ok(!requests[0].tools.some((tool) => tool.function.name === "run_command"));
  await commands.get("subagents").handler("", ctx);
  const history = JSON.parse(notifications.at(-1));
  assert.equal(history[0].version, 2); assert.equal(history[0].state, "completed");
  assert.ok(!notifications.at(-1).includes("ownerDocumentId"));
});

test("Bot avatar worker produces canonical PNG assets with revision fencing", async (t) => {
  const dir = temporary(t), original = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const adapter = api.createCliBotAvatars(dir, "instance-test");
  const { PhotonImage } = await import("@silvia-odwyer/photon-node");
  const pixel = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const data = Buffer.from(pixel.get_bytes()).toString("base64"); pixel.free();
  const asset = await adapter.put({ botId: "bot-test", expectedAssetRevision: null, operationId: "avatarop_test" }, { mimeType: "image/png", data });
  const content = await adapter.content("bot-test", asset.assetRevision);
  assert.equal(content.bytes.readUInt32BE(16), 512); assert.equal(content.bytes.readUInt32BE(20), 512);
  await assert.rejects(adapter.content("another-bot", asset.assetRevision));
  await assert.rejects(adapter.put({ botId: "bot-test", expectedAssetRevision: null, operationId: "avatarop_other" }, { mimeType: "image/png", data }));
});


test("provider credentials migrate atomically, encrypt secrets, and allow concurrent readers", async (t) => {
  const dir = temporary(t), file = join(dir, "auth.json");
  api.atomicJson(file, { sample: { type: "api_key", key: "migration-secret" } });
  const store = api.createCliProviderCredentials(file);
  assert.deepEqual(await store.read("sample"), { type: "api_key", key: "migration-secret" });
  assert.equal(readFileSync(file, "utf8").includes("migration-secret"), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const release = api.acquireLease(`${file}.writer`);
  try {
    const results = await Promise.all(Array.from({ length: 16 }, () => api.createCliProviderCredentials(file).read("sample")));
    assert.ok(results.every((value) => value.key === "migration-secret"));
    await assert.rejects(store.delete("sample"), /Another Aiden process/);
  } finally { release(); }
  await Promise.all([store.modify("second", async () => ({ type: "api_key", key: "second-secret" })), store.delete("sample")]);
  assert.equal(await store.read("sample"), undefined);
  assert.equal((await store.read("second")).key, "second-secret");
  const invalid = join(dir, "invalid.json");
  const original = JSON.stringify({ sample: { type: "oauth", access: "keep-original" } });
  writeFileSync(invalid, original);
  await assert.rejects(api.createCliProviderCredentials(invalid).list());
  assert.equal(readFileSync(invalid, "utf8"), original);
});


test("scheduled inference enforces saved read-only tools and rejects revoked authority before networking", async (t) => {
  const dir = temporary(t), requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "schedule", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Scheduled result" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "schedule", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const task = { providerId: "cli-test", model: "test", permission: "read-only", prompt: "Summarize", mcpServerIds: [], mcpServerBindings: [], webSearchEnabled: false };
  const result = await api.runScheduledInference(dir, dir, task, new AbortController().signal, async () => {});
  assert.equal(result, "Scheduled result");
  const names = requests[0].tools.map((tool) => tool.function.name).sort();
  assert.deepEqual(names, ["find", "grep", "ls", "read"]);
  await assert.rejects(api.runScheduledInference(dir, dir, task, new AbortController().signal, async () => { throw new Error("authority revoked"); }), /authority revoked/);
  assert.equal(requests.length, 1);
});

test("MCP paginates tools, fences schema drift, and terminates its stdio transport", async (t) => {
  const dir = temporary(t), revision = join(dir, "changed"), pidFile = join(dir, "pid");
  const server = { id: "fixture", name: "Fixture", transport: "stdio", command: process.execPath, args: [join(pkg, "tests/fixtures/mcp-stdio.mjs"), revision, pidFile], enabled: true };
  api.atomicJson(join(dir, "mcp.json"), [server]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  const inventory = await pool.inspectTools(server, new AbortController().signal);
  assert.deepEqual(inventory.map((tool) => tool.name), ["first", "second"]);
  const tools = await pool.agentTools(server);
  const result = await tools[1].execute("call", { value: "works" });
  assert.match(JSON.stringify(result), /Echo works/);
  writeFileSync(revision, "changed");
  await assert.rejects(tools[1].execute("stale", { value: "must not run" }), /changed/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await pool.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("daemon idle waits include cancelled append work before releasing workspace authority", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir);
  const lease = daemon.llmClient.beginChatTurn("pending", "stream", "owner"); assert.ok(lease);
  lease.reserveAppendPayload(100);
  await daemon.llmClient.cancelChat("pending");
  let finished = false;
  const idle = daemon.llmClient.waitForChatIdle("pending").then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  lease.settleAsyncWork(); await idle;
  assert.equal(daemon.llmClient.isChatBusy("pending"), false);
  await daemon.stop();
});

test("the subagent rollback switch registers no tool and opens no history", async (t) => {
  const previous = process.env.AIDEN_SUBAGENTS_ENABLED;
  process.env.AIDEN_SUBAGENTS_ENABLED = "0";
  t.after(() => { if (previous === undefined) delete process.env.AIDEN_SUBAGENTS_ENABLED; else process.env.AIDEN_SUBAGENTS_ENABLED = previous; });
  let registered = 0;
  await api.createSubagentsExtension(temporary(t)).factory({ registerTool() { registered++; } });
  assert.equal(registered, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync, utimesSync, renameSync, readdirSync, openSync, closeSync, ftruncateSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

test("a stale CLI lease cannot be reclaimed by two processes", async (t) => {
  const dir = temporary(t), file = join(dir, "shared.json");
  const fixture = join(pkg, "tests", "fixtures", "lease-child.mjs");
  const gate = join(dir, "resume"), marker = join(dir, "paused");
  const staleResult = join(dir, "stale-result"), firstResult = join(dir, "first-result"), secondResult = join(dir, "second-result");
  const children = [];
  const launch = (mode, result) => {
    const child = spawn(process.execPath, [fixture, mode, file, gate, marker, result], { stdio: "ignore" });
    children.push(child);
    return child;
  };
  const waitForFile = async (name) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const value = existsSync(name) ? readFileSync(name, "utf8") : "";
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  };
  const kill = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  try {
    const stale = launch("plain", staleResult);
    assert.match(await waitForFile(staleResult), /^owned:/);
    await kill(stale);
    launch("pause-reclaim", firstResult);
    await waitForFile(marker);
    launch("plain", secondResult);
    assert.match(await waitForFile(secondResult), /^contended:/);
    writeFileSync(gate, "resume");
    assert.match(await waitForFile(firstResult), /^owned:/);
  } finally {
    writeFileSync(gate, "resume");
    await Promise.all(children.map(kill));
  }
});

test("a failed same-process reacquire keeps the cross-process guard held", async (t) => {
  const dir = temporary(t), file = join(dir, "held.json"), result = join(dir, "result");
  const release = api.acquireLease(file);
  const child = spawn(process.execPath, [join(pkg, "tests", "fixtures", "lease-child.mjs"), "plain", file, "", "", result], { stdio: "ignore" });
  try {
    assert.throws(() => api.acquireLease(file), /Another Aiden process owns/);
    readFileSync(api.leaseGuardPath(file));
    const deadline = Date.now() + 20_000;
    let outcome = "";
    while (!outcome) {
      if (existsSync(result)) outcome = readFileSync(result, "utf8");
      if (Date.now() > deadline) throw new Error("The competing process did not finish acquisition");
      if (!outcome) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.match(outcome, /^contended:/);
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("CLI new-protocol metadata with a recycled live pid is reclaimable", (t) => {
  const dir = temporary(t), file = join(dir, "writer.json"), lock = `${file}.lock`;
  mkdirSync(lock);
  api.atomicJson(join(lock, "owner.json"), { pid: process.pid, startedAt: 1 });
  assert.throws(() => api.acquireLease(file), /Another Aiden process owns/);
  api.atomicJson(join(lock, "owner.json"), { protocol: "flock-v1", pid: process.pid, startedAt: 1 });
  const release = api.acquireLease(file);
  release();
});

test("CLI lease reclaims null owner metadata under a free guard", (t) => {
  const dir = temporary(t), file = join(dir, "writer.json"), lock = `${file}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), "null");
  const release = api.acquireLease(file);
  try {
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).protocol, "flock-v1");
  } finally { release(); }
});

test("daemon approval summaries read like the desktop's without hiding any argument", () => {
  assert.equal(api.daemonApprovalSummary("bash", { command: "npm test" }), "Run command: npm test");
  assert.equal(api.daemonApprovalSummary("read", { path: "src/a.ts" }), "Read file: src/a.ts");
  assert.equal(api.daemonApprovalSummary("ls", { path: "src" }), "List folder: src");
  // Any other argument, tool or shape keeps the exact request.
  assert.equal(api.daemonApprovalSummary("bash", { command: "sleep 9", timeout: 5 }), 'bash: {"command":"sleep 9","timeout":5}');
  assert.equal(api.daemonApprovalSummary("read", { path: "a.ts", offset: 40 }), 'read: {"path":"a.ts","offset":40}');
  assert.equal(api.daemonApprovalSummary("ls", {}), "ls: {}");
  assert.equal(api.daemonApprovalSummary("bash", { command: "  " }), 'bash: {"command":"  "}');
  assert.equal(api.daemonApprovalSummary("edit", { path: "a.ts", oldText: "a", newText: "b" }), 'edit: {"path":"a.ts","oldText":"a","newText":"b"}');
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

test("headless command output survives a pipe when it exceeds the kernel pipe buffer", async (t) => {
  const dir = temporary(t), cwd = join(dir, "project"); mkdirSync(cwd);
  const manager = api.SessionManager.create(cwd, join(dir, "sessions"));
  const preview = "needle " + "x".repeat(1_500_000);
  manager.appendMessage({ role: "user", content: preview, timestamp: 100 });
  const result = spawnSync(process.execPath, [join(pkg, "dist", "app", "cli.js"), "search", "needle"], {
    encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, AIDEN_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) > 1_500_000, `received ${Buffer.byteLength(result.stdout)} bytes`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1); assert.equal(parsed[0].preview, preview);
});

test("CLI display_image limits are per agent run and per session journal", async (t) => {
  const dir = temporary(t); mkdirSync(join(dir, "workspace")); const workspaceRoot = realpathSync(join(dir, "workspace"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(workspaceRoot, "dot.png"), png);
  const handlers = []; let tool;
  let session = api.SessionManager.inMemory(dir);
  api.createDisplayImageInlineExtension({ agentDir: join(dir, "agent"), workspaceRoot }).factory({
    registerTool: (candidate) => { tool = candidate; },
    on: (event, handler) => { if (event === "before_agent_start") handlers.push(handler); },
    appendEntry: (customType, data) => { session.appendCustomEntry(customType, data); },
  });
  const startRun = async () => { for (const handler of handlers) await handler({ type: "before_agent_start", systemPrompt: "" }, { sessionManager: session }); };
  // Like pi, persist each tool result into the session journal.
  const display = async () => {
    const toolCallId = `call-${Math.random()}`;
    const result = await tool.execute(toolCallId, { path: "dot.png" }, new AbortController().signal);
    session.appendMessage({ role: "toolResult", toolCallId, toolName: "display_image", content: result.content, isError: false, timestamp: Date.now() });
    return result;
  };
  // One image per answer for more than 20 answers: the per-response cap must not accumulate.
  for (let run = 0; run < 100; run++) { await startRun(); assert.ok((await display()).content.some((part) => part.type === "image"), `run ${run}`); }
  // The per-chat ceiling still counts every image already in this session.
  await startRun();
  await assert.rejects(display(), /100-image/);
  // A different session starts from its own (empty) history.
  session = api.SessionManager.inMemory(dir); await startRun();
  assert.ok((await display()).content.some((part) => part.type === "image"));

  // Through codemode or ctx.executeTool, pi journals only the outer tool's result, with the
  // display_image call in its nestedCalls; those images count toward the same session ceiling.
  session = api.SessionManager.inMemory(dir);
  const nested = async () => {
    const outerId = `outer-${Math.random()}`, innerId = `inner-${Math.random()}`;
    const inner = await tool.execute(innerId, { path: "dot.png" }, new AbortController().signal);
    session.appendMessage({ role: "toolResult", toolCallId: outerId, toolName: "codemode", content: inner.content, isError: false, timestamp: Date.now(),
      nestedCalls: { calls: [{ id: innerId, name: "display_image", isError: false }], complete: true } });
    return inner;
  };
  for (let run = 0; run < 100; run++) { await startRun(); assert.ok((await nested()).content.some((part) => part.type === "image"), `nested run ${run}`); }
  await startRun();
  await assert.rejects(nested(), /100-image/);
});

test("title generation preserves manual renames and seeds offline sessions", async (t) => {
  const dir = temporary(t), harness = extension(api.createSessionParityExtension(dir));
  const manager = api.SessionManager.inMemory(dir);
  const ctx = { sessionManager: manager, model: undefined };
  // pi 1.2 also starts runs from extension custom messages; they carry no prompt and never title the chat.
  await harness.events.get("before_agent_start")({ messageType: "custom", message: { role: "custom", content: "Reminder" } }, ctx);
  assert.equal(harness.name(), undefined);
  await harness.events.get("before_agent_start")({ messageType: "user", prompt: "Build my CLI" }, ctx);
  assert.equal(harness.name(), "Build my CLI");
  await harness.events.get("before_agent_start")({ messageType: "user", prompt: "Second message" }, ctx);
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

test("/models info attaches cached OpenRouter benchmark scores offline and ignores a missing or invalid cache", async (t) => {
  const dir = temporary(t), originalEntry = process.env.AIDEN_CLI_ENTRY, originalFetch = globalThis.fetch;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  globalThis.fetch = async () => { throw new Error("/models info must not use the network"); };
  t.after(() => { globalThis.fetch = originalFetch; if (originalEntry === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = originalEntry; });
  const commands = new Map();
  api.createProviderParityExtension(dir).factory({ registerProvider: () => {}, on: () => {}, registerCommand: (name, command) => commands.set(name, command) });
  const model = { provider: "openai", id: "gpt-cli-bench", name: "GPT CLI Bench", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 };
  async function info() {
    const notes = [];
    await commands.get("models").handler("info openai/gpt-cli-bench", { modelRegistry: { getAll: () => [model] }, ui: { notify: (text) => notes.push(text) } });
    return JSON.parse(notes.at(-1));
  }
  const missing = await info();
  assert.equal(missing.id, "gpt-cli-bench");
  assert.equal(missing.metadata.benchmark, undefined);
  const cache = api.buildOpenRouterBenchmarkCache({
    data: [{ source: "artificial-analysis", model_permaslug: "openai/gpt-cli-bench", display_name: "GPT CLI Bench", intelligence_index: 61.5, coding_index: 70.2, agentic_index: 55 }],
    meta: { as_of: "2026-09-30T00:00:00.000Z", version: "v1", source: "artificial-analysis", source_url: "https://artificialanalysis.ai", citation: "Source: Artificial Analysis (artificialanalysis.ai) via OpenRouter (openrouter.ai/rankings).", model_count: 1 },
  }, "2026-10-01T00:00:00.000Z");
  api.atomicJson(join(dir, "openrouter-insights.json"), cache);
  const matched = await info();
  assert.equal(matched.metadata.benchmark.intelligence, 61.5);
  assert.equal(matched.metadata.benchmark.coding, 70.2);
  assert.equal(matched.metadata.benchmark.agentic, 55);
  assert.equal(matched.metadata.benchmark.asOf, "2026-09-30T00:00:00.000Z");
  assert.deepEqual({ ...matched.metadata, benchmark: undefined }, { ...missing.metadata, benchmark: undefined });
  api.atomicJson(join(dir, "openrouter-insights.json"), { ...cache, source: { ...cache.source, endpoint: "https://example.com/benchmarks" } });
  assert.deepEqual(await info(), missing);
  writeFileSync(join(dir, "openrouter-insights.json"), "{ not json");
  assert.deepEqual(await info(), missing);
});

test("schedule CRUD uses shared validation, preview and persisted state", async (t) => {
  const dir = temporary(t), input = join(dir, "input.json");
  writeFileSync(input, JSON.stringify({ name: "Review", mode: "llm", cron: "0 9 * * *", timezone: "UTC", prompt: "Review the repository", permission: "read-only", enabled: false }));
  const task = await api.scheduleCommand(dir, ["save", input]);
  assert.equal(task.name, "Review"); assert.equal(task.enabled, false);
  assert.equal((await api.scheduleCommand(dir, ["list"])).length, 1);
  const status = await api.scheduleCommand(dir, ["status"]);
  assert.equal(status.nextRunAt, null);
  assert.deepEqual(status.overdueTaskIds, []);
  assert.equal(status.pendingRoutineFires, 0);
  assert.equal((await api.scheduleCommand(dir, ["preview", "0 9 * * *", "UTC"])).length, 5);
  await api.scheduleCommand(dir, ["remove", task.id]);
  assert.deepEqual(await api.scheduleCommand(dir, ["list"]), []);
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

test("daemon control socket decodes multi-byte UTF-8 split across chunks on both sides", async (t) => {
  // Client side: a fake daemon streams a 2-byte-character reply in odd-sized chunks.
  const fake = temporary(t);
  const text = "é".repeat(300_000);
  const server = createNetServer((socket) => {
    socket.on("data", () => {
      const bytes = Buffer.from(JSON.stringify({ result: { text } }) + "\n", "utf8");
      let offset = 0;
      const step = () => {
        if (offset >= bytes.length) { socket.end(); return; }
        const next = Math.min(bytes.length, offset + 65_537);
        socket.write(bytes.subarray(offset, next), step);
        offset = next;
      };
      step();
    });
  });
  await new Promise((resolve) => server.listen(api.daemonSocket(fake), resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const received = await api.remoteDaemonCommand(fake, "schedule", ["list"]);
  assert.equal(received.text.includes("\uFFFD"), false);
  assert.equal(received.text, text);

  // Server side: a request whose non-ASCII argument straddles two socket writes.
  const dir = temporary(t), controller = new AbortController();
  const promise = api.serve(dir, controller.signal);
  t.after(async () => { controller.abort(); await promise; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (statSync(api.daemonSocket(dir)).isSocket()) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const folder = join(dir, "wörkspace-☕"); mkdirSync(folder);
  const request = Buffer.from(JSON.stringify({ command: "workspace", args: ["add", folder] }) + "\n", "utf8");
  const cut = request.indexOf(Buffer.from("☕", "utf8")) + 1; // inside the 3-byte coffee cup
  const reply = await new Promise((resolve, reject) => {
    const socket = createConnection(api.daemonSocket(dir));
    const chunks = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    socket.on("connect", () => socket.write(request.subarray(0, cut), () => setTimeout(() => socket.write(request.subarray(cut)), 20)));
  });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  const listed = await api.remoteDaemonCommand(dir, "workspace", ["list"]);
  assert.ok(listed.some((workspace) => workspace.folderPath.endsWith("wörkspace-☕")), JSON.stringify(listed));
});

test("foreground serve recovers a legacy stale lease naming a recycled foreign pid", async (t) => {
  const dir = temporary(t), lock = join(dir, "serve.lock");
  const foreign = spawn("sleep", ["30"]);
  t.after(() => { try { foreign.kill("SIGKILL"); } catch { /* already gone */ } });
  await once(foreign, "spawn");
  mkdirSync(lock);
  api.atomicJson(join(lock, "owner.json"), { pid: foreign.pid, startedAt: 1 });
  writeFileSync(api.daemonSocket(dir), "stale socket");
  const controller = new AbortController();
  const serving = api.serve(dir, controller.signal);
  let failure;
  void serving.catch((error) => { failure = error; });
  try {
    let listening = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      try { listening = statSync(api.daemonSocket(dir)).isSocket(); } catch { /* starting */ }
      if (listening) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(listening, true, "foreground serve should replace the stale socket");
    assert.equal(api.pidAlive(foreign.pid), true, "recovery must not signal the foreign process");
    assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, process.pid);
  } finally {
    controller.abort();
    await serving.catch(() => undefined);
  }
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

  // A live Aiden process that is NOT the daemon (e.g. a `schedule` fallback
  // command, or this test runner) is a legitimate lock holder: status reports
  // not-running, stop refuses without clearing, and recovery leaves it alone.
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  api.atomicJson(join(dir, "serve.lock", "owner.json"), { pid: process.pid, startedAt: Date.now() });
  assert.equal(api.daemonStatus(dir).running, false);
  await assert.rejects(api.stopDaemon(dir), /not the daemon/);
  assert.equal(existsSync(join(dir, "serve.lock")), true);
  assert.equal(api.recoverStaleServeLease(dir), false);
  rmSync(join(dir, "serve.lock"), { recursive: true, force: true });

  // A live PID whose command line is not this CLI at all is a recycled PID:
  // the lock is cleared without ever signaling the foreign process.
  const foreign = spawn("sleep", ["30"]);
  t.after(() => { try { foreign.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve) => foreign.once("spawn", resolve));
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  api.atomicJson(join(dir, "serve.lock", "owner.json"), { pid: foreign.pid, startedAt: Date.now() });
  await assert.rejects(api.stopDaemon(dir), /not running/);
  assert.equal(existsSync(join(dir, "serve.lock")), false);
  assert.equal(api.pidAlive(foreign.pid), true);

  // Corrupt owner.json and non-positive PIDs are treated as dead owners.
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  writeFileSync(join(dir, "serve.lock", "owner.json"), "{not json");
  // A just-created lock may be mid-acquire; age it past the fresh-lock grace.
  const past = new Date(Date.now() - 10_000);
  utimesSync(join(dir, "serve.lock"), past, past);
  assert.equal(api.recoverStaleServeLease(dir), true);
  assert.equal(existsSync(join(dir, "serve.lock")), false);
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  api.atomicJson(join(dir, "serve.lock", "owner.json"), { pid: 0, startedAt: Date.now() });
  utimesSync(join(dir, "serve.lock"), past, past);
  assert.equal(api.recoverStaleServeLease(dir), true);
  assert.equal(api.pidAlive(process.pid), true);
});

test("serve cleanup cannot remove a replacement owner or socket", async (t) => {
  const dir = temporary(t), resource = join(dir, "serve");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  mkdirSync(`${resource}.lock`, { recursive: true });
  api.atomicJson(join(`${resource}.lock`, "owner.json"), { pid: dead, startedAt: 1 });
  writeFileSync(api.daemonSocket(dir), "stale socket");
  const nodeFs = createRequire(import.meta.url)("node:fs");
  const originalRemove = nodeFs.rmSync;
  let attempted = false;
  nodeFs.rmSync = (target, ...args) => {
    if (target === `${resource}.lock`) {
      attempted = true;
      assert.throws(() => api.acquireLease(resource), /Another Aiden process owns/);
    }
    return originalRemove(target, ...args);
  };
  syncBuiltinESMExports();
  try { assert.equal(api.recoverStaleServeLease(dir), true); }
  finally {
    nodeFs.rmSync = originalRemove;
    syncBuiltinESMExports();
  }
  assert.equal(attempted, true);
  const release = api.acquireLease(resource);
  writeFileSync(api.daemonSocket(dir), "replacement socket");
  try {
    assert.equal(api.recoverStaleServeLease(dir), false);
    assert.equal(readFileSync(api.daemonSocket(dir), "utf8"), "replacement socket");
    assert.equal(JSON.parse(readFileSync(join(`${resource}.lock`, "owner.json"), "utf8")).pid, process.pid);
  } finally { release(); }
});

test("serve status clears retired new-protocol metadata despite a recycled live pid", (t) => {
  const dir = temporary(t), lock = join(dir, "serve.lock");
  mkdirSync(lock);
  api.atomicJson(join(lock, "owner.json"), { protocol: "flock-v1", pid: process.pid, startedAt: 1, token: "retired" });
  writeFileSync(api.daemonSocket(dir), "retired socket");
  assert.equal(api.daemonStatus(dir).running, false);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(api.daemonSocket(dir)), false);
});

test("serve lifecycle identifies a live daemon by its recorded argv", async (t) => {
  const dir = temporary(t);
  // A real child whose argv ends in `serve`, recorded verbatim in owner.json
  // the way acquireLease does — classification must not depend on how THIS
  // checker process was launched.
  const fixture = join(dir, "fake-serve.mjs");
  writeFileSync(fixture, `setInterval(() => {}, 1e9);`);
  const child = spawn(process.execPath, [fixture, "serve"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve) => child.once("spawn", resolve));
  mkdirSync(join(dir, "serve.lock"), { recursive: true });
  api.atomicJson(join(dir, "serve.lock", "owner.json"), {
    pid: child.pid,
    argv: [process.execPath, fixture, "serve"],
    startedAt: Date.now(),
  });
  writeFileSync(api.daemonSocket(dir), "");
  assert.equal(api.daemonStatus(dir).running, true);
  assert.equal(api.recoverStaleServeLease(dir), false);
  // stopDaemon signals the recorded daemon and clears its artifacts once dead.
  const stopped = await api.stopDaemon(dir, 5_000);
  assert.equal(stopped.stopped, true);
  assert.equal(api.pidAlive(child.pid), false);
  assert.equal(existsSync(join(dir, "serve.lock")), false);
});

test("MCP validates transports and redacts configured secrets from listing", async (t) => {
  const dir = temporary(t), file = join(dir, "server.json");
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "Remote", transport: "http", url: "http://example.com", enabled: true }), /HTTPS/);
  assert.throws(() => api.validateMcpServer({ id: "../remote", name: "Remote", transport: "stdio", command: "node", enabled: true }), /server id must/);
  for (const id of [undefined, 123, null]) assert.throws(() => api.validateMcpServer({ id, name: "Remote", transport: "stdio", command: "node", enabled: true }), /string id/);
  for (const id of ["+remote", "-remote"]) assert.throws(() => api.validateMcpServer({ id, name: "Remote", transport: "stdio", command: "node", enabled: true }), /cannot begin with/);
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "-Remote", transport: "stdio", command: "node", enabled: true }), /name cannot begin with/);
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "Remote", transport: "http", enabled: true }), /needs a url/);
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "Remote", transport: "http", url: "not a url", enabled: true }), /not a valid URL/);
  assert.throws(() => api.validateMcpServer({ id: "remote", name: "Remote", transport: "sse", url: "https://example.com/sse", enabled: true }), /Unknown MCP transport/);
  writeFileSync(file, JSON.stringify({ id: "local", name: "Local", transport: "stdio", command: "node", enabled: false, env: { SECRET: "do-not-list" } }));
  await api.mcpCommand(dir, ["add", file]);
  const listed = await api.mcpCommand(dir, ["list"]);
  assert.equal(listed.length, 1); assert.ok(!JSON.stringify(listed).includes("do-not-list"));
  await api.mcpCommand(dir, ["remove", "local"]); assert.deepEqual(await api.mcpCommand(dir, ["list"]), []);
});

test("MCP presets leave out Mac app connectors, which the desktop app sets up", async (t) => {
  const dir = temporary(t);
  const presets = await api.mcpCommand(dir, ["presets"]);
  assert.ok(presets.length > 0);
  assert.ok(presets.every((preset) => preset.transport === "http"));
  assert.ok(!presets.some((preset) => preset.id === "imcp"));
  await assert.rejects(api.mcpCommand(dir, ["preset", "imcp"]), /Aiden desktop app on your Mac/);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), []);
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

test("portable chat import keeps assistant attachments through a CLI export round trip", async (t) => {
  const dir = temporary(t), source = join(dir, "source.aiden-chat.json"), target = join(dir, "again.aiden-chat.json");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const image = { id: "generated-dot", kind: "image", name: "Generated image.png", mimeType: "image/png", size: Buffer.from(data, "base64").length, data };
  api.atomicJson(source, { schema: "aiden.chat.export", version: 1, chat: { title: "Images", messages: [
    { id: "one", role: "user", content: "Draw a dot", createdAt: 100 },
    { id: "two", role: "assistant", content: "Here it is", createdAt: 200, attachments: [image] },
    { id: "three", role: "user", content: "Thanks", createdAt: 300 },
  ] } });
  const result = await api.importSession(join(dir, "agent"), dir, source);
  assert.equal(result.messages, 3);
  const imported = api.SessionManager.open(result.path);
  assert.deepEqual(imported.buildSessionContext().messages.map((message) => [message.role, api.messageText(message.content)]),
    [["user", "Draw a dot"], ["assistant", "Here it is"], ["user", "Thanks"]]);
  await api.exportSession(imported, target);
  const messages = JSON.parse(readFileSync(target, "utf8")).chat.messages;
  assert.deepEqual(messages.map((message) => [message.role, message.content]), [["user", "Draw a dot"], ["assistant", "Here it is"], ["user", "Thanks"]]);
  assert.deepEqual(messages[1].attachments, [image]);

  // Re-importing the CLI journal keeps the assistant's attachment, still outside model context.
  const journalBefore = readFileSync(result.path);
  const again = await api.importSession(join(dir, "agent"), dir, result.path);
  assert.deepEqual(readFileSync(result.path), journalBefore, "the source journal is unchanged");
  const reimported = api.SessionManager.open(again.path);
  assert.equal(reimported.buildSessionContext().messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")), false);
  const second = join(dir, "second.aiden-chat.json");
  await api.exportSession(reimported, second);
  assert.deepEqual(JSON.parse(readFileSync(second, "utf8")).chat.messages[1].attachments, [image]);

  // Branching at the assistant keeps its attachment; the abandoned continuation is gone.
  const assistantEntry = imported.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  imported.branch(assistantEntry.id);
  imported.appendMessage({ role: "user", content: "Make it bigger", timestamp: 400 });
  const branched = join(dir, "branched.aiden-chat.json");
  await api.exportSession(imported, branched);
  const branchedMessages = JSON.parse(readFileSync(branched, "utf8")).chat.messages;
  assert.deepEqual(branchedMessages.map((message) => message.content), ["Draw a dot", "Here it is", "Make it bigger"]);
  assert.deepEqual(branchedMessages[1].attachments, [image]);
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
  async function request(path, method = "GET", body, key, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({ hostname: "127.0.0.1", port: status.lanPort, ca, path: `/api/aiden/v1${path}`, method,
        headers: { authorization: `Bearer ${issued.credential}`, "aiden-protocol-version": "1", ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}), ...headers } }, (response) => {
        let data = ""; response.on("data", (chunk) => { data += chunk; }); response.on("end", () => resolve({ status: response.statusCode, data: response.headers["content-type"]?.includes("json") ? JSON.parse(data) : data }));
      });
      request.setTimeout(15000, () => request.destroy(new Error(`Remote request timed out: ${method} ${path}`)));
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
  // The daemon forks without summaries, and the fork's next turn carries the copied history to the model.
  const features = (await request("/server")).data.features;
  assert.ok(features.includes("chat-fork-v1")); assert.ok(!features.includes("chat-fork-summary-v1"));
  assert.ok(!features.includes("bot-durable-session-v1")); assert.ok(!features.includes("bot-memory-v1")); assert.ok(!features.includes("bot-proactive-v1"));
  const forked = await request(`/chats/${created.data.id}/fork`, "POST", { messageId: chat.data.messages.at(-1).id, position: "after" }, "fork-cli-test-000001", { "if-match": chat.data.revision });
  assert.equal(forked.status, 201, JSON.stringify(forked));
  assert.equal(forked.data.chat.forkedFrom.chatId, created.data.id);
  assert.deepEqual(forked.data.chat.messages.map((message) => message.text), ["Hello remote", "Remote succeeded"]);
  const followUp = await request(`/chats/${forked.data.chat.id}/turns`, "POST", { text: "Continue in the fork" }, "turn-cli-fork-000001");
  assert.equal(followUp.status, 202, JSON.stringify(followUp));
  await daemon.llmClient.waitForChatIdle(forked.data.chat.id);
  assert.equal(requests.length, 2, JSON.stringify(generationEvents));
  assert.deepEqual(requests[1].messages.filter((message) => message.role !== "system").map((message) => [message.role, JSON.stringify(message.content)]).map(([role, content]) => [role, ["Hello remote", "Remote succeeded", "Continue in the fork"].find((text) => content.includes(text))]),
    [["user", "Hello remote"], ["assistant", "Remote succeeded"], ["user", "Continue in the fork"]]);
  assert.equal((await request(`/chats/${created.data.id}`)).data.messages.length, 2);
  assert.equal((await remote.command(["revoke", issued.device.id])).revoked, true);
  assert.equal((await request("/workspaces")).status, 403);
});

test("Remote starts and keeps persisting after loading a stream journal this build cannot read", async (t) => {
  const dir = temporary(t), journal = join(dir, "remote-streams.json");
  // Well-formed JSON from a build whose event vocabulary this one rejects.
  const unreadable = JSON.stringify({ version: 1, streams: [{ streamId: "old", chatId: "chat-old", turnId: "turn-old", deviceId: "device-old", state: "done", updatedAt: 1,
    events: [{ protocolVersion: 1, streamId: "old", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", type: "finished_v2", terminal: true, payload: {} }] }] });
  writeFileSync(journal, unreadable);
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const daemon = api.createDaemonChats(dir), scheduler = api.createCliScheduler(dir);
  const remote = await api.createCliRemote(dir, daemon, scheduler, { discovery: { async start() {}, stop() {} } });
  t.after(async () => { await remote.stop(); await scheduler.service.stopAndSettle(); });
  await remote.start();
  assert.equal((await remote.service.status()).running, true);
  const issued = await remote.state.issueDevice({ name: "Test phone", type: "iphone", clientVersion: "test" });
  assert.equal((await remote.command(["revoke", issued.device.id])).revoked, true);
  const rescues = readdirSync(dir).filter((name) => name.startsWith("remote-streams.json.invalid-"));
  assert.equal(rescues.length, 1);
  assert.equal(readFileSync(join(dir, rescues[0]), "utf8"), unreadable);
  assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")).streams, []);
});

test("Bots retain one-shot notice, exact Custom tools, revocation and independent rollback anchors", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir), requests = [];
  const originalEntry = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (originalEntry === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = originalEntry; });
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
  const bot = await app.createBot({ audienceId, bot: { name: "Scoped helper", instructions: "Help in the Bot folder", avatar: { version: 1, shape: "wisp", color: "lilac" } }, access: { accessMode: "custom", catalogRevision: catalog.revision, custom } });
  const chat = await app.createChat({ audienceId, botId: bot.id, providerId: "cli-test", model: "test" });
  const lease = await runtime.authority.admit({ audienceId, botId: bot.id, chatId: chat.id });
  const tools = await runtime.tools(lease);
  assert.ok(tools.some((tool) => tool.name === "read_file")); assert.ok(!tools.some((tool) => tool.name === "run_command"));
  const write = tools.find((tool) => tool.name === "write_file");
  const result = await write.execute("one", { path: "note.txt", content: "Scoped" }); assert.ok(!result.isError);
  assert.equal(readFileSync(join(lease.authority.workingDirectory, "note.txt"), "utf8"), "Scoped");
  const decoyDirectory = join(dir, "build", "native"), decoyMarker = join(dir, "decoy-ran");
  mkdirSync(decoyDirectory, { recursive: true });
  const decoy = join(decoyDirectory, "aiden-subagent-file-mutator");
  writeFileSync(decoy, `#!/bin/sh\ntouch '${decoyMarker}'\nexit 1\n`); chmodSync(decoy, 0o755);
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const edit = tools.find((tool) => tool.name === "edit_file");
    const edited = await edit.execute("edit-outside-repo", { path: "note.txt", old_string: "Scoped", new_string: "Edited" });
    assert.ok(!edited.isError);
  } finally { process.chdir(originalCwd); }
  assert.equal(readFileSync(join(lease.authority.workingDirectory, "note.txt"), "utf8"), "Edited");
  assert.equal(existsSync(decoyMarker), false);
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
  // Updating the migrated Aiden configuration must invalidate live Bot leases.
  const invalidated = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP update did not invalidate Bot authority")), 2000);
    lease.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  api.atomicJson(join(dir, "aiden-mcp.json"), []);
  await invalidated;
  await assert.rejects(write.execute("mcp-revoked", { path: "mcp-revoked.txt", content: "Denied" }));
  assert.equal(existsSync(join(lease.authority.workingDirectory, "mcp-revoked.txt")), false);
  await app.revokeNoticeAudience(audienceId);
  await assert.rejects(write.execute("revoked", { path: "revoked.txt", content: "Denied" }));
  lease.release();
  assert.equal(statSync(join(dir, "authority/bot-anchor.json")).mode & 0o777, 0o600);
  await runtime.stop();
  const resumed = await api.createCliBots(dir, daemon);
  try { assert.equal((await resumed.application.get(bot.id)).name, "Scoped helper"); assert.equal((await resumed.application.noticeStatus(audienceId)).requiresAcknowledgement, true); }
  finally { await resumed.stop(); }
});

test("a paused Bot stops its running turn, refuses new ones and runs again once unpaused", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir), requests = [];
  let holdFirst = true, held;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "bot", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", content: "Working" });
    // The first reply never finishes on its own: only the pause ends it.
    if (holdFirst) { holdFirst = false; held = response; return; }
    chunk({}, "stop"); response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const runtime = await api.createCliBots(dir, daemon); daemon.setBots(runtime);
  t.after(async () => { await runtime.stop(); await daemon.stop(); });
  const audienceId = "cli:local", app = runtime.application;
  const notice = await app.noticeStatus(audienceId);
  await app.acknowledgeNotice(audienceId, { version: notice.version, decision: "customize_first", confirmedForeground: true });
  const catalog = await app.capabilityCatalog(audienceId);
  const provider = catalog.providers.find((item) => item.label === "cli-test"); assert.ok(provider);
  const custom = { providerId: provider.id, modelId: provider.models[0].id, fileScopeIds: [], shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] };
  const bot = await app.createBot({ audienceId, bot: { name: "Ada", instructions: "Help briefly", avatar: { version: 1, shape: "wisp", color: "lilac" } }, access: { accessMode: "custom", catalogRevision: catalog.revision, custom } });
  const chat = await app.createChat({ audienceId, botId: bot.id, providerId: "cli-test", model: "test" });
  const preflight = { audienceId, botId: bot.id, chatId: chat.id, providerId: "cli-test", model: "test" };
  const runTurn = async (streamId) => {
    const events = [], turn = daemon.llmClient.beginChatTurn(chat.id, streamId, "bot-owner"); assert.ok(turn);
    const owner = { id: 0, documentId: "bot-owner", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, value) => events.push({ channel, value }) };
    await daemon.chatStore.appendMessage(chat.id, { role: "user", content: "Hello" }); turn.settleAsyncWork();
    assert.equal(await daemon.llmClient.start(streamId, { chatId: chat.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Hello" }] }, owner, { usageSource: "chat", botAudienceId: audienceId }), true);
    return { events, idle: async () => { await daemon.llmClient.waitForChatIdle(chat.id); turn.release(); return events; } };
  };

  // Pausing while a reply streams stops it where it is.
  const running = await runTurn("before-pause");
  for (let tries = 0; requests.length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  const paused = await runtime.command(["pause", bot.id]);
  assert.deepEqual(Object.keys(paused).sort(), ["botId", "paused", "since"]);
  assert.equal(paused.paused, true); assert.equal(typeof paused.since, "number");
  assert.equal(await runtime.isPaused(bot.id), true);
  const stopped = await running.idle();
  assert.equal(stopped.filter((event) => event.channel === "chat:done").length, 0, "the held reply never finishes");
  // As on the Mac, the stopped reply is the person's Stop, not a deletion or a failure.
  const stoppedTimeline = stopped.find((event) => event.channel === "chat:error")?.value.timeline;
  assert.equal(stoppedTimeline?.status, "cancelled", JSON.stringify(stopped));
  assert.equal(stoppedTimeline?.cancellationOrigin, "user_stop");
  held.end();
  assert.equal(statSync(join(dir, "bot-service", "bot-pauses.json")).mode & 0o777, 0o600);
  assert.deepEqual(await runtime.command(["pause", bot.id]), paused, "pausing again keeps the first time");

  // While paused: phones are refused before anything runs, and so is a CLI turn.
  await assert.rejects(runtime.preflight(preflight), (error) => error.code === "operation_stale" && error.status === 409 && /Ada is paused/u.test(error.message));
  const refused = await (await runTurn("while-paused")).idle();
  assert.equal(refused.filter((event) => event.channel === "chat:error").length, 1, JSON.stringify(refused));
  assert.equal(requests.length, 1, "a paused Bot makes no provider request");

  assert.deepEqual(await runtime.command(["unpause", bot.id]), { botId: bot.id, paused: false });
  assert.equal(await runtime.isPaused(bot.id), false);
  await runtime.preflight(preflight);
  const resumed = await (await runTurn("after-unpause")).idle();
  assert.equal(resumed.filter((event) => event.channel === "chat:error").length, 0, JSON.stringify(resumed));
  assert.equal(requests.length, 2);
  await assert.rejects(runtime.command(["pause", "missing-bot"]), /no longer exists/u);
  await assert.rejects(runtime.command(["pause"]), /Usage: bots pause/u);
});

test("isolated subagent inference executes only parent-owned tools with immutable fork context", async (t) => {
  const dir = temporary(t), requests = [], original = process.env.AIDEN_CLI_ENTRY;
  let terminalReason;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body); requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const first = !terminalReason && !parsed.messages.some((message) => message.role === "tool");
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "read-test", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) } }] } : { role: "assistant", content: terminalReason === "length" ? "Incomplete finding: the fix is" : "Parent-owned tools succeeded" };
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : terminalReason ?? "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
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
  revoked = false;
  for (const reason of ["length", "stop"]) {
    terminalReason = reason;
    const before = requests.length;
    const expectedStatus = reason === "length" ? "failed" : "completed";
    const terminal = await api.runCliSubagent(dir, { runtime: { model: runtime.getModel("cli-test", "test") }, workspaceRoot: dir, permission: "ask", thinkingLevel: "off", context: { mode: "fork", revisionHash: "terminal", messages: context }, request: { role: "scout", label: "Terminal probe", task: "Explain the fix" }, policy: { deadlineMs: 15000 } }, [], async () => {});
    assert.equal(terminal.status, expectedStatus, `${reason}: ${JSON.stringify(terminal)}`);
    assert.equal(terminal.summary, reason === "length" ? "The subagent did not complete this investigation." : "Parent-owned tools succeeded");
    assert.equal(requests.length, before + 1, "terminal output must not trigger an automatic retry");
    const report = await botTool.execute(`bot-${reason}`, { tasks: [{ role: "scout", label: "Bot terminal", task: "Explain the fix" }] });
    const reportText = report.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.ok(reportText.includes(`Status: ${expectedStatus}`), reportText);
    if (reason === "length") assert.ok(!reportText.includes("Incomplete finding"), "failed child retains the existing generic summary policy");
    assert.equal(requests.length, before + 2, "Bot child must make exactly one request with no retry");
  }
});

test("shared auth coordinator commits a returned credential once and suppresses a cancelled login", async () => {
  const deviceId = crypto.randomUUID();
  let receivedDeviceId;
  let commits = 0, provider = { id: "test", name: "Test", auth: { oauth: { login: async (_interaction, options) => { receivedDeviceId = options.getDeviceId(); return ({ type: "oauth", access: "test-only", refresh: "refresh", expires: Date.now() + 3600000 }); } } } };
  const runtime = { getProvider: () => provider, listCredentials: async () => [], registerNativeProvider: (next) => { provider = next; }, login: async (_id, _method, interaction) => { const credential = await provider.auth.oauth.login(interaction); commits++; return credential; }, refresh: async () => ({}), logout: async () => {} };
  const coordinator = api.createCliAuthCoordinator(runtime, async () => {}, () => deviceId);
  async function login(cancel) {
    const flowId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const owner = { id: 1, documentId: "auth-test", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, payload) => { if (channel === "providers:auth:done") resolve(payload); else if (channel === "providers:auth:error") reject(new Error(payload.message)); } };
      const request = { flowId, providerId: "test", authType: "oauth" };
      coordinator.start(owner, request); if (cancel) coordinator.cancel(owner, request);
    });
  }
  try { assert.equal((await login(false)).cancelled, false); assert.equal(commits, 1); assert.equal(receivedDeviceId, deviceId); assert.equal((await login(true)).cancelled, true); assert.equal(commits, 1); }
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

test("scheduled inference budgets the streamed reply size, not every cumulative partial", async (t) => {
  const dir = temporary(t);
  let reply = { chunks: 0, size: 0 };
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < reply.chunks; index++) {
      response.write(`data: ${JSON.stringify({ id: "schedule", object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...(index ? {} : { role: "assistant" }), content: String(index % 10).repeat(reply.size) }, finish_reason: null }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ id: "schedule", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const task = { providerId: "cli-test", model: "test", permission: "read-only", prompt: "Write the daily report", mcpServerIds: [], mcpServerBindings: [], webSearchEnabled: false };
  // A 64 KB report in small deltas is far under the 2 MiB budget, though its cumulative partials total about 64 MB.
  reply = { chunks: 2_000, size: 32 };
  const result = await api.runScheduledInference(dir, dir, task, new AbortController().signal, async () => {});
  assert.equal(result.length, 64_000);
  // A reply that really exceeds the budget still stops.
  reply = { chunks: 80, size: 32 * 1024 };
  await assert.rejects(api.runScheduledInference(dir, dir, task, new AbortController().signal, async () => {}), /response budget exhausted/);
});

test("MCP paginates tools, fences schema drift, and terminates its stdio transport", async (t) => {
  const dir = temporary(t), revision = join(dir, "changed"), pidFile = join(dir, "pid");
  const server = { id: "fixture", name: "Fixture", transport: "stdio", command: process.execPath, args: [join(pkg, "tests/fixtures/mcp-stdio.mjs"), revision, pidFile], enabled: true };
  api.atomicJson(join(dir, "mcp.json"), [server]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  const inventory = await pool.inspectTools(server, new AbortController().signal);
  assert.deepEqual(inventory.map((tool) => tool.name), ["first", "second"]);
  assert.equal(inventory[1].inputSchema.properties.count.format, "uint32");
  const tools = await pool.agentTools(server);
  // Model-facing schemas drop schemars numeric formats but keep the range; drift fencing still uses the raw inventory.
  assert.deepEqual(tools[1].parameters.properties.count, { type: ["integer", "null"], minimum: 0, maximum: 4_294_967_295 });
  const result = await tools[1].execute("call", { value: "works" });
  assert.match(JSON.stringify(result), /Echo works/);
  // A tool error's diagnostic JSON need not match the success output schema.
  await assert.rejects(tools[1].execute("failure", { value: "fail" }), /Diagnostic failure/);
  writeFileSync(revision, "changed");
  await assert.rejects(tools[1].execute("stale", { value: "must not run" }), /changed/);
  const [pid, ...others] = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.deepEqual(others, [], "one transport per server");
  await pool.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

function fixtureServer(dir, id, mode = "") {
  return { id, name: id, transport: "stdio", command: process.execPath, args: [join(pkg, "tests/fixtures/mcp-stdio.mjs"), join(dir, `${id}.changed`), join(dir, `${id}.pid`), mode], enabled: true };
}
const listRequests = (dir, id) => existsSync(join(dir, `${id}.pid.lists`)) ? readFileSync(join(dir, `${id}.pid.lists`), "utf8").trim().split("\n").length : 0;
async function captureStderr(run) {
  const write = process.stderr.write, lines = [];
  process.stderr.write = function(chunk, ...args) { if (String(chunk).startsWith("aiden: ")) { lines.push(String(chunk)); return true; } return write.call(this, chunk, ...args); };
  try { return { value: await run(), stderr: lines.join("") }; } finally { process.stderr.write = write; }
}

test("MCP reuses a live inventory until tools/list_changed, fails closed on drift or config change, and admits large servers", async (t) => {
  const dir = temporary(t), watched = fixtureServer(dir, "watched", "listChanged"), large = fixtureServer(dir, "large", "many");
  api.atomicJson(join(dir, "aiden-mcp.json"), [watched, large]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  const tools = await pool.agentTools(watched);
  assert.equal(listRequests(dir, "watched"), 2);
  assert.match(JSON.stringify(await tools[0].execute("a", { value: "one" })), /Echo one/);
  assert.match(JSON.stringify(await tools[0].execute("b", { value: "two" })), /Echo two/);
  assert.equal(listRequests(dir, "watched"), 2, "calls reuse the complete inventory of the live connection");
  // The server changes its tools and announces it: the next call re-reads and fails closed.
  await tools[0].execute("c", { value: "notify" });
  await assert.rejects(tools[0].execute("d", { value: "stale" }), /changed/);
  assert.ok(listRequests(dir, "watched") > 2);
  // Over the former 128-tool cap, within the shared 512-tool inventory limit.
  assert.equal((await pool.inspectTools(large)).length, 300);
  // A configuration edit fences existing tools without a notification.
  const fresh = await pool.agentTools(watched);
  api.atomicJson(join(dir, "aiden-mcp.json"), [{ ...watched, description: "Edited" }, large]);
  await assert.rejects(fresh[0].execute("e", { value: "edited" }), /changed or was disabled/);
});

test("MCP withholds servers switched off for the model and hidden tools, without renaming the rest", async (t) => {
  const dir = temporary(t), shown = fixtureServer(dir, "shown"), partly = { ...fixtureServer(dir, "partly"), hiddenTools: ["first"] }, off = { ...fixtureServer(dir, "off"), exposure: "hidden" };
  assert.throws(() => api.validateMcpServer({ ...shown, exposure: "sometimes" }), /MCP exposure/);
  assert.throws(() => api.validateMcpServer({ ...shown, hiddenTools: ["first", "first"] }), /Hidden MCP tools/);
  api.atomicJson(join(dir, "aiden-mcp.json"), [shown, partly, off]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  const all = (await pool.agentTools(shown)).map((tool) => tool.name);
  const visible = (await pool.agentTools(partly)).map((tool) => tool.name);
  assert.deepEqual(all, ["shown__first", "shown__second"]);
  assert.deepEqual(visible, ["partly__second"]);
  assert.deepEqual(await pool.agentTools(off), []);
  assert.equal(listRequests(dir, "off"), 0, "a server switched off for the model is never contacted");
});

test("MCP connections survive token refreshes, rebuild on sign-out, and connect once under concurrency", async (t) => {
  const dir = temporary(t); let initializes = 0; const callAuthorizations = [];
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) return response.writeHead(202).end();
    let result = {};
    if (message.method === "initialize") { initializes++; result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } }; }
    else if (message.method === "tools/list") result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
    else if (message.method === "tools/call") { callAuthorizations.push(request.headers.authorization); result = { content: [{ type: "text", text: "pong" }] }; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const server = { id: "remote", name: "Remote", transport: "http", url: `http://127.0.0.1:${http.address().port}/mcp`, enabled: true, oauth: true };
  api.atomicJson(join(dir, "aiden-mcp.json"), [server]);
  const credentials = api.insightCredentials(dir), id = api.mcpCredentialId(server);
  const store = (token, grantId = "sign-in-1") => credentials.write(id, JSON.stringify({ authorizationBinding: api.mcpOAuthBindingForServer(server), grantId, clientInformation: { client_id: "registered" }, tokens: { access_token: token, token_type: "Bearer" } }));
  await store("first");
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  const client = await pool.connection(server);
  const [ping] = await pool.agentTools(server);
  await ping.execute("before", {});
  await store("refreshed");
  assert.equal(await pool.connection(server), client, "a token refresh keeps the live transport");
  await ping.execute("after", {});
  assert.equal(initializes, 1);
  assert.deepEqual(callAuthorizations, ["Bearer first", "Bearer refreshed"], "the retained transport sends the current persisted token");
  await api.mcpCommand(dir, ["logout", "remote"]);
  // Signed out: the server is not contacted at all until the next sign-in.
  await assert.rejects(pool.connection(server), /aiden mcp login remote/);
  assert.equal(initializes, 1);
  await store("second-account", "sign-in-2");
  const [first, second] = await Promise.all([pool.connection(server), pool.connection(server)]);
  assert.equal(first, second);
  assert.notEqual(first, client);
  assert.equal(initializes, 2, "concurrent callers share one reconnect");
});

test("MCP Bot credential signatures ignore token refreshes and display fields but follow sign-in", async (t) => {
  const dir = temporary(t);
  const server = { id: "remote", name: "Remote", transport: "http", url: "https://one.example/mcp", enabled: true, oauth: true };
  const credentials = api.insightCredentials(dir), id = api.mcpCredentialId(server);
  const store = (token, grantId) => credentials.write(id, JSON.stringify({ authorizationBinding: api.mcpOAuthBindingForServer(server), clientInformation: { client_id: "registered" }, grantId, tokens: { access_token: token, refresh_token: `${token}-refresh`, token_type: "Bearer" } }));
  await store("first", "sign-in-1");
  const signed = await api.mcpCredentialSignature(dir, server);
  await store("refreshed", "sign-in-1");
  assert.equal(await api.mcpCredentialSignature(dir, server), signed, "a token refresh keeps Bot grants");
  assert.equal(await api.mcpCredentialSignature(dir, { ...server, name: "Renamed", description: "Work tools" }), signed, "renaming keeps Bot grants");
  await store("other-account", "sign-in-2");
  assert.notEqual(await api.mcpCredentialSignature(dir, server), signed, "a new sign-in is a new credential");
  await credentials.delete(id);
  const signedOut = await api.mcpCredentialSignature(dir, server);
  assert.notEqual(signedOut, signed);
  assert.notEqual(await api.mcpCredentialSignature(dir, { ...server, headers: { authorization: "Bearer x" } }), signedOut, "header values stay part of the connection");
});

test("MCP shutdown during credential resolution starts no connection and sends nothing", async (t) => {
  const dir = temporary(t); let requests = 0;
  const http = createServer((request, response) => { requests++; request.resume(); response.writeHead(500).end(); });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const server = { id: "remote", name: "Remote", transport: "http", url: `http://127.0.0.1:${http.address().port}/mcp`, enabled: true, oauth: true };
  api.atomicJson(join(dir, "aiden-mcp.json"), [server]);
  await api.insightCredentials(dir).write(api.mcpCredentialId(server), JSON.stringify({ authorizationBinding: api.mcpOAuthBindingForServer(server), clientInformation: { client_id: "registered" }, tokens: { access_token: "secret", token_type: "Bearer" } }));
  // Pause the second credential-file open: the provider read after incarnation resolution.
  const fsPromises = createRequire(import.meta.url)("node:fs/promises"), open = fsPromises.open;
  let opens = 0, reached, release;
  const paused = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  fsPromises.open = async function (path, ...rest) {
    if (String(path).endsWith("insights.json") && ++opens === 2) { reached(); await gate; }
    return open.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = open; syncBuiltinESMExports(); });
  const pool = api.createCliMcpPool(dir);
  const connecting = pool.connection(server); connecting.catch(() => {});
  await paused;
  let closeReturned = false;
  const closing = pool.close().then(() => { closeReturned = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests, 0);
  release();
  await closing;
  assert.ok(closeReturned);
  await assert.rejects(connecting, /closed/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests, 0, "no request may follow shutdown");
});

test("MCP rejects an inventory whose pages are each in budget but whose total retained schemas are not", async (t) => {
  const dir = temporary(t);
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(405).end();
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) return response.writeHead(202).end();
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } };
    else if (message.method === "tools/list") {
      const page = Number(message.params?.cursor ?? 0);
      result = { tools: [{ name: `tool${page}`, description: "x".repeat(450_000), inputSchema: { type: "object" } }], ...(page < 2 ? { nextCursor: String(page + 1) } : {}) };
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const large = { id: "large", name: "Large", transport: "http", url: `http://127.0.0.1:${http.address().port}/mcp`, enabled: true };
  api.atomicJson(join(dir, "aiden-mcp.json"), [large]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  await assert.rejects(pool.inspectTools(large), /byte budget/);
  await assert.rejects(pool.agentTools(large), /byte budget/);
});

test("MCP startup connects servers concurrently within one budget and reports each failure's cause", async (t) => {
  const dir = temporary(t), good = fixtureServer(dir, "good"), hung = fixtureServer(dir, "hung", "hang");
  const missing = { id: "missing", name: "Missing", transport: "stdio", command: join(dir, "no-such-mcp-server"), enabled: true };
  api.atomicJson(join(dir, "aiden-mcp.json"), [hung, missing, good]);
  const events = new Map(), tools = new Map();
  const started = Date.now();
  const { stderr } = await captureStderr(() => api.createMcpExtension(dir, { startupBudgetMs: 1_500 }).factory({
    on: (event, handler) => events.set(event, handler), registerCommand() {}, registerTool: (tool) => tools.set(tool.label, tool) }));
  assert.ok(Date.now() - started < 8_000, "a hung server cannot hold startup for its 10 s connect timeout");
  assert.deepEqual([...tools.keys()].sort(), ["good: first", "good: second"]);
  assert.match(stderr, /MCP hung unavailable \(timed out\)/);
  assert.match(stderr, /MCP missing unavailable \([^)]*ENOENT/);
  await events.get("session_shutdown")();
  for (const id of ["good", "hung"]) for (const pid of readFileSync(join(dir, `${id}.pid`), "utf8").trim().split("\n").map(Number)) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  }
});

test("interactive MCP keeps auto servers behind codemode, lists them for the model, and declares them when codemode is off", async (t) => {
  const dir = temporary(t), auto = { ...fixtureServer(dir, "docs"), description: "Team documentation" }, visible = { ...fixtureServer(dir, "pinned"), exposure: "direct" };
  api.atomicJson(join(dir, "aiden-mcp.json"), [auto, visible]);
  const load = async (active) => {
    const events = new Map(), tools = new Map();
    await api.createMcpExtension(dir, { deferToCodemode: true }).factory({
      on: (event, handler) => events.set(event, handler), registerCommand() {}, registerTool: (tool) => tools.set(tool.name, tool), getActiveTools: () => active });
    t.after(() => events.get("session_shutdown")());
    return { events, tools };
  };
  const scripted = await load(["read", "bash", "codemode"]);
  scripted.events.get("session_start")();
  assert.equal(scripted.tools.get("docs__first").exposure, "codemode", "an auto server's tools are reached from codemode scripts");
  assert.deepEqual(scripted.tools.get("docs__first").namespace, { name: "docs", description: "Team documentation" });
  assert.equal(scripted.tools.get("pinned__first").exposure, undefined, "an Always visible server stays declared");
  const sections = { mcp_servers: "stale" };
  await scripted.events.get("before_agent_start")({ systemPromptOptions: { sections } });
  assert.match(sections.mcp_servers, /- docs: docs \(via codemode\) — "Team documentation"/);
  assert.doesNotMatch(sections.mcp_servers, /pinned|<mcp_servers>/, "Pi wraps the section; declared servers need no listing");

  const direct = await load(["read", "bash"]);
  direct.events.get("session_start")();
  assert.equal(direct.tools.get("docs__first").exposure, undefined, "without codemode the tools are declared directly");
  const none = { mcp_servers: "stale" };
  await direct.events.get("before_agent_start")({ systemPromptOptions: { sections: none } });
  assert.equal(none.mcp_servers, undefined);
});

test("a codemode script reaches an MCP tool that was never declared to the model, and without codemode it is declared", async (t) => {
  const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const dir = temporary(t);
  api.atomicJson(join(dir, "aiden-mcp.json"), [{ ...fixtureServer(dir, "docs"), description: "Team documentation" }]);
  const run = async (defaultTools) => {
    const faux = fauxProvider({ provider: "faux-codemode", models: [{ id: "scripted", contextWindow: 100_000, maxTokens: 4096 }] });
    const requests = [];
    faux.setResponses([
      (context) => { requests.push(context); return fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.docs__first({ value: 'hi' }))" }), { stopReason: "toolUse" }); },
      (context) => { requests.push(context); return fauxAssistantMessage("Done"); },
    ]);
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createCodemodeExtension({ mode: "on" }), api.createMcpExtension(dir, { deferToCodemode: true }), { name: "faux", factory(pi) { pi.registerProvider(faux.provider); } }] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager: SettingsManager.inMemory({ defaultTools }), sessionManager: SessionManager.inMemory(), model: faux.getModel() });
    // dispose() alone leaves extensions running; shutting down closes the MCP server process.
    t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    await session.bindExtensions({});
    await session.prompt("Look it up");
    const declared = requests[0].messages.filter((message) => message.role === "system").flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
    const sections = requests[0].messages.filter((message) => message.role === "system").map((message) => message.sections?.mcp_servers ?? "").join("");
    const result = session.messages.find((message) => message.role === "toolResult");
    return { declared, sections, result: result.content.map((part) => part.text ?? "").join("\n") };
  };
  const scripted = await run(["read", "codemode"]);
  assert.deepEqual(scripted.declared, ["read", "codemode"], "the MCP tool stays out of the model's declarations");
  assert.match(scripted.sections, /- docs: docs \(via codemode\)/, "the model learns the service exists");
  assert.match(scripted.result, /Echo hi/, "the script called the MCP tool");
  const direct = await run(["read"]);
  assert.ok(direct.declared.includes("docs__first"), "without codemode the MCP tool is declared directly");
  assert.equal(direct.sections, "");
});

test("MCP remove and endpoint edits delete the server's stored credential", async (t) => {
  const dir = temporary(t), file = join(dir, "server.json");
  const server = { id: "remote", name: "Remote", transport: "http", url: "https://one.example/mcp", enabled: true, oauth: true };
  const credentials = api.insightCredentials(dir);
  writeFileSync(file, JSON.stringify(server));
  await api.mcpCommand(dir, ["add", file]);
  await credentials.write(api.mcpCredentialId(server), "{}");
  // Renaming keeps the endpoint identity and its sign-in.
  writeFileSync(file, JSON.stringify({ ...server, name: "Renamed" }));
  await api.mcpCommand(dir, ["add", file]);
  assert.equal(await credentials.read(api.mcpCredentialId(server)), "{}");
  const moved = { ...server, url: "https://two.example/mcp" };
  writeFileSync(file, JSON.stringify(moved));
  await api.mcpCommand(dir, ["add", file]);
  assert.equal(await credentials.read(api.mcpCredentialId(server)), undefined);
  await credentials.write(api.mcpCredentialId(moved), "{}");
  await api.mcpCommand(dir, ["remove", "remote"]);
  assert.equal(await credentials.read(api.mcpCredentialId(moved)), undefined);
});

function retiredSseInventory() {
  const local = { id: "local", name: "Local", enabled: true, transport: "stdio", command: "example" };
  const hex = "ab".repeat(16);
  const sse = [
    { id: "old-disabled", name: "Old disabled", enabled: false, transport: "sse", url: "https://old.example/sse" },
    { id: "old-oauth", name: "Old OAuth", enabled: true, transport: "sse", url: "https://older.example/sse", oauth: true, oauthClientId: "client", oauthClientSecret: `aiden-secret:v1:${hex}` },
  ];
  return { local, sse, servers: [sse[0], local, sse[1]], secretCredential: `mcp-oauth-client-secret-${hex}` };
}

async function storeRetiredCredentials(dir, inventory) {
  const credentials = api.insightCredentials(dir);
  for (const server of inventory.sse) await credentials.write(api.mcpCredentialId(server), JSON.stringify({ tokens: { access_token: `token-${server.id}`, token_type: "Bearer" } }));
  await credentials.write(inventory.secretCredential, "old-client-secret");
  return credentials;
}

async function assertRetiredCredentialsRemoved(credentials, inventory) {
  for (const server of inventory.sse) assert.equal(await credentials.read(api.mcpCredentialId(server)), undefined, `${server.id} sign-in removed`);
  assert.equal(await credentials.read(inventory.secretCredential), undefined, "the retired client secret is removed");
}

test("retired SSE entries in aiden-mcp.json are dropped with their credentials, and the remaining servers load", async (t) => {
  const dir = temporary(t), inventory = retiredSseInventory();
  api.atomicJson(join(dir, "aiden-mcp.json"), inventory.servers);
  const credentials = await storeRetiredCredentials(dir, inventory);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  assert.deepEqual((await pool.listServers()).map(({ id }) => id), ["local"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")), [inventory.local], "the pruned list is persisted");
  await assertRetiredCredentialsRemoved(credentials, inventory);
  assert.deepEqual((await api.mcpCommand(dir, ["list"])).map(({ id }) => id), ["local"]);
  await api.mcpCommand(dir, ["remove", "local"]);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), []);
});

test("retired SSE entries in a legacy mcp.json migrate away with their credentials", async (t) => {
  const dir = temporary(t), inventory = retiredSseInventory();
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(inventory.servers));
  const credentials = await storeRetiredCredentials(dir, inventory);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), [inventory.local]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")), [inventory.local]);
  assert.equal(existsSync(join(dir, "mcp.json")), false);
  await assertRetiredCredentialsRemoved(credentials, inventory);
  await api.mcpCommand(dir, ["remove", "local"]);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), []);
});

test("a retired SSE entry whose credentials could not be deleted stays until a later read deletes them", async (t) => {
  const dir = temporary(t), inventory = retiredSseInventory();
  api.atomicJson(join(dir, "aiden-mcp.json"), inventory.servers);
  const credentials = await storeRetiredCredentials(dir, inventory);
  // A directory where the credential file belongs makes the delete fail for
  // every user, root included (directory permissions would not stop root).
  const credentialFile = join(dir, "credentials", "insights.json"), held = `${credentialFile}.held`;
  renameSync(credentialFile, held);
  mkdirSync(credentialFile);
  const restore = () => { if (existsSync(held)) { rmSync(credentialFile, { recursive: true, force: true }); renameSync(held, credentialFile); } };
  t.after(restore);
  const { value, stderr } = await captureStderr(() => api.mcpCommand(dir, ["list"]));
  assert.deepEqual(value.map(({ id }) => id), ["local"], "the remaining servers still load");
  assert.match(stderr, /could not remove retired SSE MCP servers yet/u);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")), inventory.servers, "the entries wait for their cleanup");
  // An ordinary write in the meantime keeps them too.
  writeFileSync(join(dir, "other.json"), JSON.stringify({ id: "other", name: "Other", enabled: false, transport: "stdio", command: "example" }));
  await captureStderr(() => api.mcpCommand(dir, ["add", join(dir, "other.json")]));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")).filter(({ transport }) => transport === "sse"), inventory.sse);
  restore();
  assert.deepEqual((await api.mcpCommand(dir, ["list"])).map(({ id }) => id), ["local", "other"]);
  await assertRetiredCredentialsRemoved(credentials, inventory);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")).map(({ id }) => id), ["local", "other"]);
});

test("a remaining server that shares a retired entry's sign-in and client secret keeps them", async (t) => {
  const dir = temporary(t), inventory = retiredSseInventory();
  const [, retired] = inventory.sse;
  const live = { ...retired, transport: "http", name: "Same endpoint over HTTP" };
  api.atomicJson(join(dir, "aiden-mcp.json"), [retired, live]);
  const credentials = await storeRetiredCredentials(dir, inventory);
  assert.deepEqual((await api.mcpCommand(dir, ["list"])).map(({ id, transport }) => [id, transport]), [[live.id, "http"]]);
  assert.ok(await credentials.read(api.mcpCredentialId(live)), "the shared sign-in stays");
  assert.equal(await credentials.read(inventory.secretCredential), "old-client-secret", "the shared client secret stays");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")), [live]);
});

test("MCP migration skips a malformed native mcp.json with a warning and leaves it untouched", async (t) => {
  const dir = temporary(t), legacy = join(dir, "mcp.json");
  writeFileSync(legacy, "{ not json");
  const { value, stderr } = await captureStderr(() => api.mcpCommand(dir, ["list"]));
  assert.deepEqual(value, []);
  assert.match(stderr, /skipped MCP migration; .* is not valid JSON/);
  assert.equal(readFileSync(legacy, "utf8"), "{ not json");
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

test("owned CLI controls persist verified values once and headless agents cannot write", async (t) => {
  const dir = temporary(t),
    controls = api.createCliAppControls(dir, () => undefined);
  assert.match(JSON.stringify(api.readAidenHelp("memory")), /does not delete/i);
  const state = await controls.snapshot("memory", false);
  const row = state.rows.find((row) => row.id === "memory.enabled");
  assert.equal(row.value, true);
  const operation = {
    control: row.id,
    value: false,
    expectedRevision: row.revision,
    operationId: "human_cli_operation",
  };
  await assert.rejects(controls.apply(operation, false, false), /interactive CLI/);
  assert.equal(existsSync(join(dir, "aiden.json")), false);
  const result = await controls.apply(operation, false, true, true);
  assert.equal(result.status, "applied");
  assert.equal(result.effective, "next_session");
  assert.equal(JSON.parse(readFileSync(join(dir, "aiden.json"), "utf8")).memoryEnabled, false);
  assert.deepEqual(await controls.apply(operation, false, true, true), result);
  assert.equal(
    api.isOwnedAppTool(
      { getAllTools: () => [{ name: "aiden_help", sourceInfo: { path: "/untrusted/app.ts" } }] },
      "aiden_help",
    ),
    false,
  );
  assert.equal(
    api.isOwnedAppTool(
      { getAllTools: () => [{ name: "aiden_help", sourceInfo: { path: "<inline:aiden-app>" } }] },
      "aiden_help",
    ),
    true,
  );
});

test("CLI controls require a current owner and terminal receipts confirm Pi persistence", async (t) => {
  const dir = temporary(t);
  let theme = "dark";
  const controls = api.createCliAppControls(dir, () => ({
    currentTheme: () => theme,
    themes: () => ["dark", "light"],
    setTheme(value) {
      theme = value;
      api.atomicJson(join(dir, "settings.json"), { theme: value });
      return { success: true };
    },
  }));
  const state = await controls.snapshot("appearance", true);
  const row = state.rows[0];
  const operation = {
    control: row.id,
    value: "light",
    expectedRevision: row.revision,
    operationId: "terminal_saved_operation",
  };
  await assert.rejects(
    controls.apply(operation, true, true, false, () => false),
    /no longer available/i,
  );
  assert.equal(theme, "dark");
  assert.equal(existsSync(join(dir, "settings.json")), false);
  const receipt = await controls.apply(operation, true, true);
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.effective, "now");
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).theme, "light");
});

test("MCP migration preserves exact legacy bytes privately and keeps native configurations separate", async (t) => {
  const dir = temporary(t);
  const legacy = [{ id: "old", name: "Existing server", enabled: false, transport: "stdio", command: "example" }];
  const bytes = JSON.stringify(legacy, null, 4) + "\n";
  writeFileSync(join(dir, "mcp.json"), bytes);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), legacy);
  assert.equal(existsSync(join(dir, "mcp.json")), false);
  assert.equal(readFileSync(join(dir, "mcp.pre-pi-1.json"), "utf8"), bytes);
  assert.equal(statSync(join(dir, "mcp.pre-pi-1.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "aiden-mcp.json")).mode & 0o777, 0o600);
  const native = { mcpServers: { native: { command: "example-native" } } };
  api.atomicJson(join(dir, "mcp.json"), native);
  assert.deepEqual(await api.mcpCommand(dir, ["list"]), legacy);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")), native);
});

test("MCP migration recovers a completed copy and refuses conflicting or invalid records without deleting data", (t) => {
  const dir = temporary(t), legacy = join(dir, "mcp.json"), destination = join(dir, "aiden-mcp.json");
  const server = { id: "old", name: "Old", enabled: false, transport: "stdio", command: "example" };
  api.atomicJson(legacy, [server]);
  api.atomicJson(destination, [{ ...server, id: "new" }]);
  assert.throws(() => api.migrateAidenMcpConfig(dir, api.validateMcpServer), /Reconcile/);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), [server]);
  assert.equal(existsSync(join(dir, "mcp.pre-pi-1.json")), false);
  api.atomicJson(destination, [server]);
  api.migrateAidenMcpConfig(dir, api.validateMcpServer);
  assert.equal(existsSync(legacy), false);
  api.atomicJson(legacy, [{ id: "invalid" }]);
  assert.throws(() => api.migrateAidenMcpConfig(dir, api.validateMcpServer), /MCP server needs a non-empty name/);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), [{ id: "invalid" }]);
});

test("MCP reads stay available while another process owns the Aiden MCP lease", async (t) => {
  const dir = temporary(t), destination = join(dir, "aiden-mcp.json");
  const server = { id: "kept", name: "Kept", enabled: true, transport: "stdio", command: "example" };
  api.atomicJson(destination, [server]);
  const release = api.acquireLease(destination);
  try {
    // CLI startup and `aiden mcp list` both read without anything to migrate,
    // whether mcp.json is absent or holds native pi configuration.
    const native = { mcpServers: { native: { command: "native" } } };
    for (const legacy of [undefined, native]) {
      if (legacy) api.atomicJson(join(dir, "mcp.json"), legacy);
      api.migrateAidenMcpConfig(dir, api.validateMcpServer);
      assert.deepEqual((await api.mcpCommand(dir, ["list"])).map(({ id }) => id), ["kept"]);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")), native);
    // Writers and pending migrations still respect the owner.
    await assert.rejects(api.mcpCommand(dir, ["remove", "kept"]), /Another Aiden process/);
    api.atomicJson(join(dir, "mcp.json"), [server]);
    assert.throws(() => api.migrateAidenMcpConfig(dir, api.validateMcpServer), /Another Aiden process/);
    assert.equal(existsSync(join(dir, "mcp.json")), true);
  } finally { release(); }
  api.migrateAidenMcpConfig(dir, api.validateMcpServer);
  assert.equal(existsSync(join(dir, "mcp.json")), false);
});

test("native settings keep Aiden header-only startup and persist one installation identity on demand", async (t) => {
  const dir = temporary(t);
  const settings = api.SettingsManager.create(dir, dir);
  assert.equal(settings.getQuietStartup(), "header");
  assert.equal(settings.getThemeSetting(), "light/dark");
  settings.setTheme("system");
  assert.equal(settings.getTheme(), "system");
  assert.equal(settings.getEnableInstallTelemetry(), false);
  assert.equal(settings.getGlobalSettings().deviceId, undefined);
  const id = settings.getOrCreateDeviceId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await settings.flush();
  const reopened = api.SettingsManager.create(dir, dir);
  assert.equal(reopened.getOrCreateDeviceId(), id);
  reopened.setQuietStartup(false);
  assert.equal(reopened.getQuietStartup(), false);
  reopened.setQuietStartup(true);
  assert.equal(reopened.getQuietStartup(), true);
  await reopened.flush();
});


test("delegated MCP revisions follow migrated Aiden configuration and encrypted credentials", (t) => {
  const dir = temporary(t);
  const revision = api.createCliMcpRevision(dir);
  const original = revision();
  api.atomicJson(join(dir, "mcp.json"), { mcpServers: { native: { command: "example" } } });
  assert.equal(revision(), original);
  api.atomicJson(join(dir, "aiden-mcp.json"), [{ id: "aiden", enabled: true }]);
  const configured = revision();
  assert.notEqual(configured, original);
  api.atomicJson(join(dir, "aiden-mcp.json"), [{ id: "aiden", enabled: false }]);
  assert.notEqual(revision(), configured);
  const revoked = revision();
  mkdirSync(join(dir, "credentials"), { recursive: true });
  api.atomicJson(join(dir, "credentials/insights.json"), { encrypted: "changed" });
  assert.notEqual(revision(), revoked);
});


for (const oidc of [false, true]) test(`CLI custom MCP OAuth uses ${oidc ? "OIDC discovery" : "configured metadata"} and enforces callback issuers`, async (t) => {
  const dir = temporary(t), file = join(dir, "remote.json");
  const requests = []; let issuer; let registration; let tokenCalls = 0; let callbackCheck;
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (oidc && request.url.includes("oauth-authorization-server")) { response.statusCode = 404; return response.end("{}"); }
    if (request.url === "/metadata" || (oidc && request.url.includes("openid-configuration"))) return response.end(JSON.stringify({ ...(oidc ? { jwks_uri: `${issuer}/jwks`, subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] } : {}), issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true }));
    if (request.url.includes("oauth-protected-resource")) return response.end(JSON.stringify({ resource: `${issuer}/mcp`, authorization_servers: [oidc ? issuer : `${issuer}/wrong`] }));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (request.url === "/mcp") {
      // The protected MCP endpoint: a challenge without the issued token, JSON-RPC with it.
      if (request.headers.authorization !== "Bearer new-token") {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"` });
        return response.end();
      }
      const message = JSON.parse(body);
      if (message.id === undefined) { response.statusCode = 202; return response.end(); }
      return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "metadata", version: "1" } } : {} }));
    }
    if (request.url === "/register") {
      registration = JSON.parse(body);
      return response.end(JSON.stringify({ client_id: "registered", ...registration }));
    }
    if (request.url === "/token") {
      tokenCalls++;
      assert.equal(new URLSearchParams(body).get("code"), "accepted");
      return response.end(JSON.stringify({ access_token: "new-token", token_type: "Bearer", scope: null, refresh_token: "", expires_in: null }));
    }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  writeFileSync(file, JSON.stringify({ id: "metadata", name: "Metadata", transport: "http", url: `${issuer}/mcp`, enabled: true, oauth: true, ...(oidc ? {} : { authServerMetadataUrl: `${issuer}/metadata` }), description: "Documents" }));
  await api.mcpCommand(dir, ["add", file]);
  const write = process.stderr.write;
  process.stderr.write = function(chunk, ...args) {
    const match = String(chunk).match(/Open this URL to sign in:\n([^\n]+)/u);
    if (!match) return write.call(this, chunk, ...args);
    const authorization = new URL(match[1]);
    callbackCheck = (async () => {
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "accepted");
      assert.equal((await fetch(callback)).status, 400, "advertised issuer support requires iss before token exchange");
      assert.equal(tokenCalls, 0);
      callback.searchParams.set("iss", `${issuer}/wrong`);
      assert.equal((await fetch(callback)).status, 400);
      assert.equal(tokenCalls, 0);
      callback.searchParams.set("iss", issuer);
      assert.equal((await fetch(callback)).status, 200);
    })();
    return true;
  };
  try {
    assert.deepEqual(await api.mcpCommand(dir, ["login", "metadata"]), { signedIn: "metadata" });
    await callbackCheck;
  } finally { process.stderr.write = write; }
  assert.equal(tokenCalls, 1);
  assert.equal(registration.client_name, "Aiden Agent", "every MCP OAuth registration uses the catalog's client name");
  assert.equal(requests.filter((path) => path === "/metadata").length, oidc ? 0 : 1);
  assert.equal(requests.some((path) => path.includes("openid-configuration")), oidc);
  assert.ok(requests.every((path) => !path.includes("wrong")));
  const [listed] = await api.mcpCommand(dir, ["list"]);
  assert.equal(listed.authServerMetadataUrl, oidc ? undefined : `${issuer}/metadata`);
  assert.equal(listed.description, "Documents");
});

/** A browser for the fake OAuth server: follows /authorize to the loopback callback without waiting for its page. */
function fakeBrowser() {
  const pages = [];
  return { pages, open(url) { pages.push((async () => {
    const consent = await fetch(url, { redirect: "manual" });
    return (await fetch(consent.headers.get("location"))).text();
  })()); } };
}

test("aiden mcp login registers a fresh client on a random loopback port, and stored tokens connect and refresh without registering", async (t) => {
  const dir = temporary(t), oauth = await api.startFakeOAuthServer({ issueSecret: true, requireSecret: true, authMethods: ["client_secret_post"] });
  t.after(() => oauth.close());
  const server = { id: "remote", name: "Remote", transport: "http", url: oauth.serviceUrl, enabled: true, oauth: true };
  api.atomicJson(join(dir, "aiden-mcp.json"), [server]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  // Never signed in: nothing reaches the server, not even an MCP request or discovery.
  await assert.rejects(pool.connection(server), /aiden mcp login remote/);
  assert.equal(oauth.seen.requests.length, 0);
  const browser = fakeBrowser();
  assert.deepEqual(await api.mcpLogin(dir, server, { openBrowser: browser.open }), { authorized: true });
  assert.match(await browser.pages[0], /Connected/);
  assert.equal(oauth.seen.registrations.length, 1);
  const [redirect] = oauth.seen.registrations[0].redirect_uris;
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.notEqual(new URL(redirect).port, "41390", "a dynamically registered CLI client uses a random loopback port");
  // The sign-in is stored encrypted, never as plaintext tokens.
  assert.doesNotMatch(readFileSync(join(dir, "credentials", "insights.json"), "utf8"), /access-|refresh-|secret-/u);
  assert.deepEqual((await pool.inspectTools(server)).map((tool) => tool.name), ["echo"]);
  // An expired access token is refreshed with the stored confidential client, without a new registration.
  await pool.close();
  oauth.expireAccessTokens();
  const again = api.createCliMcpPool(dir); t.after(() => again.close());
  assert.deepEqual((await again.inspectTools(server)).map((tool) => tool.name), ["echo"]);
  assert.equal(oauth.seen.registrations.length, 1);
  const refresh = oauth.seen.tokenRequests.filter((request) => request.grant === "refresh_token");
  assert.deepEqual(refresh.map(({ status, presentedSecret }) => ({ status, presentedSecret })), [{ status: 200, presentedSecret: true }]);
});

test("a pre-registered OAuth client keeps its secret encrypted and signs in without registering", async (t) => {
  const dir = temporary(t), file = join(dir, "server.json");
  const oauth = await api.startFakeOAuthServer({ registration: false, requireSecret: true, authMethods: ["client_secret_post"], preRegistered: { clientId: "registered-by-hand", clientSecret: "hand-secret-value" } });
  t.after(() => oauth.close());
  writeFileSync(file, JSON.stringify({ id: "custom", name: "Custom", transport: "http", url: oauth.serviceUrl, enabled: true, oauth: true, oauthClientId: "registered-by-hand", oauthClientSecret: "hand-secret-value" }));
  await api.mcpCommand(dir, ["add", file]);
  assert.doesNotMatch(readFileSync(join(dir, "aiden-mcp.json"), "utf8"), /hand-secret-value/u, "the client secret never lands in aiden-mcp.json");
  const [listed] = await api.mcpCommand(dir, ["list"]);
  assert.equal(listed.oauthClientId, "registered-by-hand");
  assert.equal(listed.oauthClientSecret, undefined, "listing never prints the client secret, even as a marker");
  assert.equal(listed.hasOAuthClientSecret, true);
  const [saved] = JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8"));
  // The provider must see the redirect URI the user registered: the fixed loopback, not a random port.
  assert.equal(api.cliMcpOAuthLoopback(saved).redirectUri, "http://127.0.0.1:41390/callback");
  assert.equal(api.cliMcpOAuthLoopback({ ...saved, oauthClientId: undefined, oauthClientSecret: undefined }).port, 0);
  assert.equal(api.cliMcpOAuthLoopback({ ...saved, oauthClientId: undefined, oauthClientSecret: undefined }, "https://aiden.example/client.json").redirectUri, "http://127.0.0.1:41390/callback");
  const browser = fakeBrowser();
  // Port 0 stands in for the fixed port so the test never collides with a running Aiden.
  await api.mcpLogin(dir, saved, { openBrowser: browser.open, loopback: { port: 0, redirectUri: "http://127.0.0.1/callback", timeoutMs: 30_000 } });
  await browser.pages[0];
  assert.equal(oauth.seen.registrations.length, 0);
  assert.deepEqual(oauth.seen.tokenRequests.map(({ grant, clientId, presentedSecret, status }) => ({ grant, clientId, presentedSecret, status })),
    [{ grant: "authorization_code", clientId: "registered-by-hand", presentedSecret: true, status: 200 }]);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  assert.deepEqual((await pool.inspectTools(saved)).map((tool) => tool.name), ["echo"]);
  // Removing the server deletes its stored secret and sign-in.
  await api.mcpCommand(dir, ["remove", "custom"]);
  await assert.rejects(api.mcpLogin(dir, saved, { openBrowser: browser.open }), /client secret .* is missing/u);
});

test("a plaintext OAuth client secret in aiden-mcp.json is never listed or used", async (t) => {
  const dir = temporary(t);
  const server = { id: "edited", name: "Edited", transport: "http", url: "https://mcp.example.com/mcp", enabled: true, oauth: true, oauthClientId: "client", oauthClientSecret: "plaintext-secret" };
  api.atomicJson(join(dir, "aiden-mcp.json"), [server]);
  assert.doesNotMatch(JSON.stringify(await api.mcpCommand(dir, ["list"])), /plaintext-secret/u);
  await assert.rejects(api.mcpLogin(dir, server, { openBrowser() { throw new Error("must not open"); } }), /plaintext oauthClientSecret .* aiden mcp add/u);
  const pool = api.createCliMcpPool(dir); t.after(() => pool.close());
  await assert.rejects(pool.connection(server), /plaintext oauthClientSecret/u);
});

test("credential writes queue within a process and wait for another holder of the writer lease", async (t) => {
  const dir = temporary(t), credentials = api.insightCredentials(dir);
  // Concurrent writers in one process (two MCP servers refreshing at startup) all persist.
  await Promise.all(Array.from({ length: 6 }, (_, index) => credentials.write(`source-${index}`, `value-${index}`)));
  for (let index = 0; index < 6; index++) assert.equal(await credentials.read(`source-${index}`), `value-${index}`);
  // A lease held elsewhere (another process) is waited for, not failed.
  const release = api.acquireLease(join(dir, "credentials", "insights-writer"));
  let written = false;
  const pending = credentials.write("late", "after-release").then(() => { written = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(written, false);
  release();
  await pending;
  assert.equal(await credentials.read("late"), "after-release");
  // Read-modify-write sees the value under the lease.
  await Promise.all([credentials.update("counter", (value) => String(Number(value ?? 0) + 1)), credentials.update("counter", (value) => String(Number(value ?? 0) + 1))]);
  assert.equal(await credentials.read("counter"), "2");
});

test("MCP migration validates one snapshot and restores a native replacement without deleting it", (t) => {
  const dir = temporary(t), legacy = join(dir, "mcp.json");
  const servers = [{ id: "old", name: "Old", enabled: false, transport: "stdio", command: "example" }];
  const original = JSON.stringify(servers) + "\n";
  const native = { mcpServers: { native: { command: "native" } } };
  writeFileSync(legacy, original);
  assert.throws(() => api.migrateAidenMcpConfig(dir, (server) => {
    api.validateMcpServer(server);
    api.atomicJson(legacy, native);
  }), /changed during migration/u);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), native);
  assert.equal(readFileSync(join(dir, "mcp.pre-pi-1.json"), "utf8"), original);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "aiden-mcp.json"), "utf8")), servers);
});

test("MCP source claiming never removes a replacement published before or after the claim", (t) => {
  for (const replaceBefore of [true, false]) {
    const dir = temporary(t), legacy = join(dir, "mcp.json");
    const servers = [{ id: "old", name: "Old", enabled: false, transport: "stdio", command: "example" }];
    const native = { mcpServers: { live: { command: "keep-live" } } };
    const concurrent = { mcpServers: { newer: { command: "keep-newer" } } };
    api.atomicJson(legacy, servers);
    let claimed;
    const migrate = () => api.migrateAidenMcpConfig(dir, api.validateMcpServer, (source, target) => {
      if (replaceBefore) api.atomicJson(source, native);
      renameSync(source, target); claimed = target;
      api.atomicJson(source, concurrent);
    });
    if (replaceBefore) assert.throws(migrate, /changed during migration/u); else migrate();
    assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), concurrent);
    assert.deepEqual(JSON.parse(readFileSync(claimed, "utf8")), replaceBefore ? native : servers);
    assert.equal(statSync(dirname(claimed)).mode & 0o777, 0o700);
  }
});

test("MCP migration retains writes through a source descriptor opened before retirement", (t) => {
  const dir = temporary(t), legacy = join(dir, "mcp.json");
  api.atomicJson(legacy, [{ id: "old", name: "Old", enabled: false, transport: "stdio", command: "example" }]);
  const fd = openSync(legacy, "r+");
  try {
    api.migrateAidenMcpConfig(dir, api.validateMcpServer);
    const native = { mcpServers: { late: { command: "late-writer" } } };
    ftruncateSync(fd, 0); writeFileSync(fd, JSON.stringify(native));
    const recovery = readdirSync(dir).find((name) => name.startsWith(".mcp-migration-"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, recovery, "mcp.json"), "utf8")), native);
    assert.equal(existsSync(legacy), false);
  } finally { closeSync(fd); }
});

test("Azure config migration preserves deployments, API ids, preferences and current collisions", (t) => {
  const dir = temporary(t), project = join(dir, "project");
  api.atomicJson(join(dir, "models.json"), { providers: { "azure-openai-responses": { api: "azure-openai-responses", baseUrl: "https://deployment.example", models: [{ id: "deployment" }] }, "custom:azure": { baseUrl: "https://custom.example" } } });
  api.atomicJson(join(dir, "settings.json"), { defaultProvider: "azure-openai-responses", modelThinkingLevels: { "azure-openai-responses/deployment": "high", "azure/deployment": "low" }, enabledModels: ["azure-openai-responses/*"], compaction: { modelOverrides: { "azure-openai-responses/deployment": { contextWindow: 12345 } } } });
  api.atomicJson(join(project, ".aiden/settings.json"), { defaultProvider: "azure-openai-responses", theme: "dark" });
  api.migrateCliAzureConfig(dir, project);
  const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
  assert.equal(models.providers.azure.api, "azure-openai-responses");
  assert.equal(models.providers.azure.baseUrl, "https://deployment.example");
  assert.equal(models.providers["custom:azure"].baseUrl, "https://custom.example");
  assert.equal(models.providers["azure-openai-responses"], undefined);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "azure");
  assert.deepEqual(settings.modelThinkingLevels, { "azure/deployment": "low" });
  assert.deepEqual(settings.enabledModels, ["azure/*"]);
  assert.deepEqual(settings.compaction.modelOverrides, { "azure/deployment": { contextWindow: 12345 } });
  assert.deepEqual(JSON.parse(readFileSync(join(project, ".aiden/settings.json"), "utf8")), { defaultProvider: "azure", theme: "dark" });
  api.migrateCliAzureConfig(dir, project);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")), models);
  const conflict = { providers: { azure: { baseUrl: "https://new.example" }, "azure-openai-responses": { baseUrl: "https://old.example" } } };
  api.atomicJson(join(dir, "models.json"), conflict);
  assert.throws(() => api.migrateCliAzureConfig(dir, project), /different configuration/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")), conflict);
});

test("CLI Azure credentials migrate from plaintext without losing a colliding credential", async (t) => {
  const file = join(temporary(t), "auth.json");
  api.atomicJson(file, { "azure-openai-responses": { type: "api_key", key: "old-secret" }, azure: { type: "api_key", key: "new-secret" } });
  const store = api.createCliProviderCredentials(file);
  assert.deepEqual(await store.read("azure"), { type: "api_key", key: "new-secret" });
  const saved = readFileSync(file, "utf8");
  assert.equal(saved.includes("old-secret"), false);
  assert.equal(saved.includes("new-secret"), false);
  assert.ok(JSON.parse(saved).retiredAzureCredential);
  assert.deepEqual(await store.list(), [{ providerId: "azure", type: "api_key" }]);
  await store.delete("azure");
  assert.equal(await api.createCliProviderCredentials(file).read("azure"), undefined);
});


test("Azure endpoint migration cannot pair a legacy deployment with a different current credential", (t) => {
  const dir = temporary(t);
  const models = { providers: { "azure-openai-responses": { api: "azure-openai-responses", baseUrl: "https://old-deployment.example" } } };
  for (const auth of [
    { azure: { type: "api_key", key: "current" }, "azure-openai-responses": { type: "api_key", key: "legacy" } },
    { version: 1, entries: { azure: { type: "api_key", ciphertext: "current" }, "azure-openai-responses": { type: "api_key", ciphertext: "legacy" } } },
    { version: 1, entries: { azure: { type: "api_key", ciphertext: "current" } }, retiredAzureCredential: { type: "api_key", ciphertext: "legacy" } },
  ]) {
    api.atomicJson(join(dir, "models.json"), models);
    api.atomicJson(join(dir, "auth.json"), auth);
    assert.throws(() => api.migrateCliAzureConfig(dir), /legacy endpoint/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")), models);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), auth);
  }
});

function todoHarness(manager, widgets = []) {
  const harness = extension(api.createTodoInlineExtension({ latestContext: () => undefined }));
  const context = { sessionManager: manager, hasUI: true, mode: "tui", ui: { setWidget: (_name, lines) => widgets.push(lines) } };
  return { ...harness, context, widgets,
    start: async (reason = "startup", ctx = context) => harness.events.get("session_start")?.({ type: "session_start", reason }, ctx),
    call: async (args) => harness.tools.get("todo").execute("test-call", args),
    async persist(args) {
      const result = await harness.tools.get("todo").execute("test-call", args);
      const id = manager.appendMessage({ role: "toolResult", toolCallId: "test-call", toolName: "todo", content: result.content, details: result.details, isError: false, timestamp: 1 });
      return { result, id };
    },
  };
}

test("CLI todo restores branch-local checkpoints after restart, compaction, switching and clearing", async (t) => {
  const manager = api.SessionManager.inMemory(temporary(t));
  const first = todoHarness(manager); await first.start();
  const one = await first.persist({ action: "create", subject: "First checkpoint" });
  await first.persist({ action: "create", subject: "Second checkpoint" });
  manager.appendCompaction("Earlier observations compressed", null, 10000);
  const resumed = todoHarness(manager); await resumed.start("resume");
  assert.deepEqual((await resumed.call({ action: "list" })).details.tasks.map(({ subject }) => subject), ["First checkpoint", "Second checkpoint"]);
  assert.ok(resumed.widgets.at(-1).some((line) => line.includes("First checkpoint")));
  const third = await resumed.persist({ action: "create", subject: "Third checkpoint" });
  assert.equal(third.result.details.tasks.at(-1).id, 3);
  manager.branch(one.id);
  await resumed.events.get("session_tree")({ type: "session_tree", newLeafId: one.id, oldLeafId: third.id }, resumed.context);
  assert.deepEqual((await resumed.call({ action: "list" })).details.tasks.map(({ subject }) => subject), ["First checkpoint"]);
  await resumed.persist({ action: "clear" });
  await resumed.start("reload");
  assert.deepEqual((await resumed.call({ action: "list" })).details.tasks, []);
  assert.equal(resumed.widgets.at(-1), undefined);
  const empty = api.SessionManager.inMemory(temporary(t));
  await resumed.start("new", { ...resumed.context, sessionManager: empty });
  const fresh = await resumed.call({ action: "create", subject: "New session only" });
  assert.deepEqual(fresh.details.tasks.map(({ id, subject }) => ({ id, subject })), [{ id: 1, subject: "New session only" }]);
  await resumed.start("resume");
  assert.deepEqual((await resumed.call({ action: "list" })).details.tasks, [], "switching back must not retain the new session's task");
});

test("CLI todo corrupt newest checkpoint fails closed and a later valid session recovers", async (t) => {
  const manager = api.SessionManager.inMemory(temporary(t));
  const harness = todoHarness(manager); await harness.start();
  await harness.persist({ action: "create", subject: "Must not fall back" });
  manager.appendMessage({ role: "toolResult", toolCallId: "broken", toolName: "todo", content: [], details: { kind: "broken" }, isError: false, timestamp: 2 });
  await harness.start("reload");
  await assert.rejects(harness.call({ action: "list" }), /unavailable/i);
  await assert.rejects(harness.call({ action: "create", subject: "Must not overwrite" }), /unavailable/i);
  assert.equal(harness.widgets.at(-1), undefined);
  const empty = api.SessionManager.inMemory(temporary(t));
  const widgetCount = harness.widgets.length;
  await harness.start("new", { ...harness.context, sessionManager: empty, hasUI: false });
  assert.deepEqual((await harness.call({ action: "list" })).details.tasks, []);
  assert.equal(harness.widgets.length, widgetCount, "headless restoration must not render a widget");
});

test("CLI todo ignores stale asynchronous restoration after a newer session starts", async (t) => {
  const manager = api.SessionManager.inMemory(temporary(t));
  const seed = todoHarness(manager); await seed.start();
  await seed.persist({ action: "create", subject: "Old session task" });
  const harness = todoHarness(manager);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const oldStart = harness.start("resume", { ...harness.context, sessionManager: { getBranch: () => pending } });
  await assert.rejects(harness.call({ action: "create", subject: "During restore" }), /unavailable/i);
  const empty = api.SessionManager.inMemory(temporary(t));
  await harness.start("new", { ...harness.context, sessionManager: empty });
  await harness.call({ action: "create", subject: "Newer session task" });
  release(manager.getBranch()); await oldStart;
  assert.deepEqual((await harness.call({ action: "list" })).details.tasks.map(({ subject }) => subject), ["Newer session task"]);
  assert.equal(harness.widgets.at(-1), undefined);
  await harness.events.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, harness.context);
  await assert.rejects(harness.call({ action: "list" }), /unavailable/i);
});

test("real SDK binding initializes todo before tool use and restores it on a resumed session", async (t) => {
  const dir = temporary(t), manager = api.SessionManager.inMemory(dir);
  const model = { id: "offline", name: "Offline", provider: "offline-fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  async function boot(reason) {
    const loader = new api.DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [api.createTodoInlineExtension({ latestContext: () => undefined })] });
    await loader.reload();
    const { session } = await api.createAgentSession({ cwd: dir, agentDir: dir, model, resourceLoader: loader, sessionManager: manager, settingsManager: api.SettingsManager.inMemory({}), tools: ["todo"], sessionStartEvent: { type: "session_start", reason } });
    t.after(() => session.dispose());
    return { session, tool: session.agent.state.tools.find(({ name }) => name === "todo") };
  }
  const first = await boot("startup");
  await assert.rejects(first.tool.execute("before-bind", { action: "list" }), /unavailable/i);
  await first.session.bindExtensions({ mode: "rpc" });
  const result = await first.tool.execute("create", { action: "create", subject: "SDK checkpoint" });
  manager.appendMessage({ role: "toolResult", toolCallId: "create", toolName: "todo", content: result.content, details: result.details, isError: false, timestamp: 1 });
  first.session.dispose();
  const resumed = await boot("resume"); await resumed.session.bindExtensions({ mode: "rpc" });
  assert.deepEqual((await resumed.tool.execute("list", { action: "list" })).details.tasks.map(({ subject }) => subject), ["SDK checkpoint"]);
});

test("daemon initializes todo lifecycle before inference and recovers checkpoints on the next turn", async (t) => {
  const dir = temporary(t), requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); const index = requests.length;
    const operation = index === 1 ? { action: "create", subject: "Daemon durable checkpoint" } : index === 3 ? { action: "list" } : undefined;
    const delta = operation ? { role: "assistant", tool_calls: [{ index: 0, id: `todo-${index}`, type: "function", function: { name: "todo", arguments: JSON.stringify(operation) } }] } : { role: "assistant", content: "Done" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "todo", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "todo", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: operation ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  const workspace = await api.workspaceCommand(dir, ["add", dir]); await api.workspaceCommand(dir, ["access", workspace.id, "full"]);
  const daemon = api.createDaemonChats(dir); t.after(() => daemon.stop());
  await daemon.chatStore.create({ id: "todo-daemon", title: "Todo lifecycle", workspaceId: workspace.id });
  const events = [], owner = { id: 0, documentId: "todo-owner", isDestroyed: () => false, onInvalidated: () => () => {}, send: (channel, value) => events.push({ channel, value }) };
  for (const content of ["Track work", "Recover work"]) {
    const admission = daemon.llmClient.beginChatTurn("todo-daemon", "stream", owner.documentId); assert.ok(admission);
    try {
      await daemon.chatStore.appendMessage("todo-daemon", { role: "user", content }); admission.settleAsyncWork();
      await daemon.llmClient.start("stream", { chatId: "todo-daemon", workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content }] }, owner, { usageSource: "chat" });
      await daemon.llmClient.waitForChatIdle("todo-daemon");
    } finally { admission.release(); }
  }
  assert.equal(requests.length, 4, JSON.stringify(events));
  const toolObservations = requests.filter((_, index) => index === 1 || index === 3).map((request) => request.messages.filter(({ role }) => role === "tool").at(-1));
  for (const observation of toolObservations) assert.ok(JSON.stringify(observation).includes("Daemon durable checkpoint"), JSON.stringify(observation));
  assert.equal(events.filter(({ channel }) => channel === "chat:error").length, 0);
});

test("daemon releases sessions and authority when extension binding fails or is revoked", async (t) => {
  const root = temporary(t);
  const model = { id: "test", name: "Test", provider: "cli-test", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const loader = new api.DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const { session: seed } = await api.createAgentSession({ cwd: root, agentDir: root, model, resourceLoader: loader, sessionManager: api.SessionManager.inMemory(root), settingsManager: api.SettingsManager.inMemory({}), tools: [] });
  const prototype = Object.getPrototypeOf(seed), originalBind = prototype.bindExtensions;
  seed.dispose();
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500); response.end("Inference must not start after authority loss"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { prototype.bindExtensions = originalBind; server.closeAllConnections(); server.close(); });

  for (const mode of ["bind-reject", "owner-invalidated", "workspace-removed"]) {
    const dir = join(root, mode);
    api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [model] } } });
    const workspace = await api.workspaceCommand(dir, ["add", dir]); await api.workspaceCommand(dir, ["access", workspace.id, "full"]);
    const daemon = api.createDaemonChats(dir);
    await daemon.chatStore.create({ id: "binding-fault", title: "Binding fault", workspaceId: workspace.id });
    let destroyed = false, invalidate, shutdowns = 0, disposals = 0, binds = 0;
    const events = [], owner = { id: 0, documentId: "binding-owner", isDestroyed: () => destroyed, onInvalidated: (callback) => { invalidate = callback; return () => {}; }, send: (channel, value) => events.push({ channel, value }) };
    prototype.bindExtensions = async function (...args) {
      binds++;
      const emit = this.extensionRunner.emit.bind(this.extensionRunner);
      this.extensionRunner.emit = async (event) => { if (event.type === "session_shutdown") shutdowns++; return emit(event); };
      const dispose = this.dispose.bind(this);
      this.dispose = () => { disposals++; return dispose(); };
      // Exercise the real SDK session_start and todo restore before injecting a
      // failure at the newly awaited boundary, rather than mocking startup away.
      await originalBind.apply(this, args);
      if (mode === "bind-reject") throw new Error("Injected extension binding failure");
      if (mode === "owner-invalidated") { destroyed = true; invalidate(); }
      if (mode === "workspace-removed") await api.workspaceStore(dir).save([]);
    };
    const before = requests, admission = daemon.llmClient.beginChatTurn("binding-fault", mode, owner.documentId);
    assert.ok(admission);
    try {
      await daemon.chatStore.appendMessage("binding-fault", { role: "user", content: "Must not reach inference" }); admission.settleAsyncWork();
      await daemon.llmClient.start(mode, { chatId: "binding-fault", workspaceId: workspace.id, providerId: "cli-test", model: "test", messages: [{ role: "user", content: "Must not reach inference" }] }, owner, { usageSource: "chat" });
      await daemon.llmClient.waitForChatIdle("binding-fault");
      assert.equal(binds, 1, mode);
      assert.equal(requests, before, `${mode}: no inference after failure or revocation`);
      assert.equal(shutdowns, 1, `${mode}: extensions release resources`);
      assert.equal(disposals, 1, `${mode}: SDK session is disposed`);
      const release = api.acquireLease(daemon.sessionPath("binding-fault")); release();
      const next = daemon.llmClient.beginChatTurn("binding-fault", "next", "next-owner");
      assert.ok(next, `${mode}: failed startup must not strand chat admission`); next.settleAsyncWork(); next.release();
      assert.equal(events.filter(({ channel }) => channel === "chat:error").length, destroyed ? 0 : 1, mode);
    } finally {
      prototype.bindExtensions = originalBind;
      admission.release();
      await daemon.stop();
    }
  }
});

test("durable CLI Bot migration preserves history, dedupes across restart, and fences revoked access", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir);
  const oldEntry = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (oldEntry === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = oldEntry; });
  let calls = 0, hold = false, scriptResult, scriptTools;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const write = JSON.stringify(parsed.messages).includes("Write durable file") && !parsed.messages.some((message) => message.role === "tool");
    const last = parsed.messages.at(-1);
    const script = last.role === "user" && JSON.stringify(last.content).includes("Script durable file");
    if (script) scriptTools = parsed.tools.map((tool) => tool.function.name);
    if (last.role === "tool" && last.tool_call_id === "durable-script") scriptResult = JSON.stringify(last.content);
    const call = write
      ? { id: "durable-write", name: "write_file", arguments: { path: "durable.txt", content: "Written by the durable Bot" } }
      : script ? { id: "durable-script", name: "codemode", arguments: { code: 'text(await tools.read_file({ path: "durable.txt" }))' } } : undefined;
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "durable", object: "chat.completion.chunk", choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "Durable answer" }, finish_reason: null }] })}\n\n`);
    if (hold) return;
    response.write(`data: ${JSON.stringify({ id: "durable", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  let host = await api.createCliBots(dir, daemon);
  t.after(async () => { await host.stop(); await daemon.stop(); });
  daemon.setBots(host);
  assert.equal(host.durable, undefined);
  const audienceId = "cli:local", notice = await host.application.noticeStatus(audienceId);
  await host.application.acknowledgeNotice(audienceId, { version: notice.version, decision: "customize_first", confirmedForeground: true });
  const catalog = await host.application.capabilityCatalog(audienceId), provider = catalog.providers.find((item) => item.label === "cli-test");
  const bot = await host.application.createBot({ audienceId, bot: { name: "Durable helper", instructions: "Reply briefly", avatar: { version: 1, shape: "wisp", color: "lilac" } }, access: { accessMode: "custom", catalogRevision: catalog.revision, custom: { providerId: provider.id, modelId: provider.models[0].id, fileScopeIds: catalog.fileScopes.filter((item) => item.kind === "bot_home").map((item) => item.id), shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] } } });
  const legacy = await host.application.createChat({ audienceId, botId: bot.id, providerId: "cli-test", model: "test" });
  await daemon.chatStore.appendMessage(legacy.id, { role: "user", content: "Keep this legacy history" });
  mkdirSync(dirname(daemon.sessionPath(legacy.id)), { recursive: true });
  writeFileSync(daemon.sessionPath(legacy.id), "legacy journal bytes\n");
  const grantBefore = await host.application.getBotAccess(bot.id);
  const migrated = await host.command(["enable-durable"]);
  assert.equal(calls, 0, "migration never invokes a provider");
  assert.equal(migrated.legacyChatsPreserved, 1);
  assert.equal(statSync(join(migrated.backup, "legacy-chats.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(migrated.backup, "legacy-chats.json"))).chats[0].journal, "legacy journal bytes\n");
  assert.equal((await daemon.chatStore.get(legacy.id)).messages[0].content, "Keep this legacy history");
  assert.throws(() => host.assertLegacyChatAllowed(), /durable sessions/);
  await host.stop();
  host = await api.createCliBots(dir, daemon); daemon.setBots(host);
  assert.deepEqual(await host.application.getBotAccess(bot.id), grantBefore);
  const markerPath = join(dir, api.CLI_DURABLE_BOT_MARKER);
  renameSync(markerPath, `${markerPath}.held`);
  try { assert.throws(() => host.assertLegacyChatAllowed(), /durable sessions/, "an active durable host never falls back when its marker disappears"); }
  finally { renameSync(`${markerPath}.held`, markerPath); }

  const scheduler = api.createCliScheduler(dir); host.setScheduler(scheduler);
  const ledger = new api.AidenIdempotencyLedger();
  const remoteBots = api.createCliRemoteBots(dir, "test-instance", host, daemon, {}, ledger, async () => {});
  assert.equal(remoteBots.botSessions.supportsRoutines, true);
  assert.equal(remoteBots.botSessions.supportsPresets, true);
  assert.equal(remoteBots.botSessions.supportsMemory, true);
  assert.equal(remoteBots.botSessions.supportsProactive, false);
  assert.equal(remoteBots.botSessions.supportsAttachments, false);
  assert.equal(remoteBots.botSessions.supportsActivity, false);
  await remoteBots.botSessions.close();
  const routine = await host.routines.create({ botId: bot.id, name: "Read update", prompt: "Give a brief update", schedule: { kind: "daily", time: "12:00" }, timezone: "UTC" });
  const routineRun = await scheduler.service.runNow(routine.id, { runId: "stable-routine-fire" });
  assert.equal(routineRun.result, "success");
  const duplicateRun = await scheduler.service.runNow(routine.id, { runId: "stable-routine-fire" });
  assert.equal(duplicateRun.result, "skipped");
  assert.equal(duplicateRun.reason, "duplicate");
  await host.routines.delete({ botId: bot.id, id: routine.id });

  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
  const sent = await host.durable.runtime.send(bot.id, { text: "Hello", requestId: "migration-first", attachments: [{ type: "image", mimeType: "image/png", data: imageData }] });
  assert.deepEqual(await host.durable.runtime.awaitReply(bot.id, sent.submissionId, new AbortController().signal), { kind: "completed", text: "Durable answer" });
  const durableEntries = (await (await host.durable.runtime.conversation(bot.id)).context(api.BACKGROUND_CONTEXT)).entries;
  const callContext = api.cliDurableBotToolContext([...durableEntries].reverse(), { chatId: legacy.id, botId: bot.id });
  const forkSnapshot = await callContext.loadChat();
  assert.equal(callContext.attachments[0].data, imageData);
  assert.equal(forkSnapshot.messages.find((message) => message.role === "user").attachments[0].data, imageData);
  assert.deepEqual(forkSnapshot.messages.slice(-2).map((message) => message.content), ["Hello", "Durable answer"]);
  assert.ok(!JSON.stringify(forkSnapshot).includes("Keep this legacy history"));
  assert.equal(api.capturePersistedSubagentContext(forkSnapshot).messages.length, forkSnapshot.messages.length);
  forkSnapshot.messages.find((message) => message.role === "user").content = "caller mutated snapshot";
  assert.equal((await callContext.loadChat()).messages.find((message) => message.role === "user").content, "Hello", "call snapshot cannot be mutated by another consumer");

  const writeTurn = await host.durable.runtime.send(bot.id, { text: "Write durable file", requestId: "durable-write-once" });
  assert.equal((await host.durable.runtime.awaitReply(bot.id, writeTurn.submissionId, new AbortController().signal)).kind, "completed");
  assert.equal(readFileSync(join((await host.managedWorkspace.resolve(bot.id)).homePath, "durable.txt"), "utf8"), "Written by the durable Bot");
  // Codemode runs in the bundle: the script's read is a nested call through the Bot's own checks.
  const scriptTurn = await host.durable.runtime.send(bot.id, { text: "Script durable file", requestId: "durable-script-once" });
  assert.equal((await host.durable.runtime.awaitReply(bot.id, scriptTurn.submissionId, new AbortController().signal)).kind, "completed");
  assert.ok(scriptTools.includes("codemode") && scriptTools.includes("read_file"), "codemode sits next to the Bot's declared tools");
  assert.match(scriptResult, /Written by the durable Bot/u, "the script read the file through the bundled sandbox");
  assert.equal((await host.durable.runtime.send(bot.id, { text: "Write durable file", requestId: "durable-write-once" })).deduped, true);
  const afterFirst = calls;
  assert.ok(afterFirst > 0);
  assert.equal((await host.durable.runtime.send(bot.id, { text: "Hello", requestId: "migration-first" })).deduped, true);
  assert.equal(calls, afterFirst);
  const memory = await host.durable.memory.apply(bot.id, "user", [{ action: "add", content: "Prefers concise replies" }]);
  assert.equal(memory.ok, true);
  const view = await host.durable.memory.view(bot.id);
  const entry = view.user.entries[0]; assert.equal(entry.text, "Prefers concise replies");
  const edit = await host.durable.memory.edit({ botId: bot.id, edit: { kind: "replace", target: "user", entryId: entry.id, text: "Prefers complete replies" } });
  assert.equal(edit.ok, true);
  await host.stop();
  host = await api.createCliBots(dir, daemon);
  assert.equal((await host.durable.runtime.send(bot.id, { text: "Hello", requestId: "migration-first" })).deduped, true);
  assert.equal((await host.durable.memory.view(bot.id)).user.entries[0].text, "Prefers complete replies");
  assert.equal(calls, afterFirst, "reopen and duplicate delivery never dispatch inference");
  await host.stop();
  async function crashTurn(requestId) {
    hold = true;
    const before = calls;
    const child = spawn(process.execPath, [join(pkg, "tests/fixtures/durable-bot-child.mjs"), dir, bot.id, requestId], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let childError = ""; child.stderr.on("data", (data) => { childError += data; });
    try {
      const deadline = Date.now() + 15000;
      while (calls <= before) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for durable Bot: ${childError}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
  }
  await crashTurn("interrupted-resume-request");
  const beforeResume = calls;
  host = await api.createCliBots(dir, daemon);
  const interrupted = await host.durable.runtime.state(bot.id);
  assert.equal(interrupted.kind, "interrupted");
  assert.equal(calls, beforeResume, "startup scans do not resume the interrupted task");
  hold = false;
  await host.durable.runtime.resume(bot.id, "resume-once");
  assert.equal((await host.durable.runtime.awaitReply(bot.id, interrupted.submissionId, new AbortController().signal)).kind, "completed");
  const afterResume = calls;
  assert.equal(afterResume, beforeResume + 1);
  await host.durable.runtime.resume(bot.id, "resume-once");
  assert.equal(calls, afterResume);
  await host.stop();
  await crashTurn("interrupted-dismiss-request");
  const beforeReopen = calls;
  host = await api.createCliBots(dir, daemon);
  assert.equal((await host.durable.runtime.state(bot.id)).kind, "interrupted");
  const pausedScheduler = api.createCliScheduler(dir); host.setScheduler(pausedScheduler);
  const pausedRoutine = await host.routines.create({ botId: bot.id, name: "Paused update", prompt: "Give an update", schedule: { kind: "daily", time: "12:00" }, timezone: "UTC" });
  const skipped = await pausedScheduler.service.runNow(pausedRoutine.id, { runId: "paused-fire" });
  assert.equal(skipped.result, "skipped"); assert.equal(skipped.reason, "bot_paused");
  assert.equal((await host.durable.runtime.state(bot.id)).kind, "interrupted");
  await host.routines.delete({ botId: bot.id, id: pausedRoutine.id });
  await host.durable.runtime.dismiss(bot.id, "dismiss-once");
  await host.durable.runtime.dismiss(bot.id, "dismiss-once");
  assert.equal(calls, beforeReopen, "dismiss and routine fire after process death never invoke a provider");
  await host.application.revokeNoticeAudience(audienceId);
  await assert.rejects(host.durable.runtime.send(bot.id, { text: "Forbidden", requestId: "revoked-request" }));
  assert.equal(calls, beforeReopen);
});

test("a durable Bot paused from the CLI stops its running turn, refuses sends and waits for Resume once unpaused", async (t) => {
  const dir = temporary(t), daemon = api.createDaemonChats(dir);
  const oldEntry = process.env.AIDEN_CLI_ENTRY;
  process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (oldEntry === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = oldEntry; });
  let calls = 0, hold = true;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    assert.ok(body.length > 0);
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "durable", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Durable answer" }, finish_reason: null }] })}\n\n`);
    // A held reply never finishes on its own: only the pause ends it.
    if (hold) return;
    response.write(`data: ${JSON.stringify({ id: "durable", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(dir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  let host = await api.createCliBots(dir, daemon);
  t.after(async () => { await host.stop(); await daemon.stop(); });
  daemon.setBots(host);
  const audienceId = "cli:local", notice = await host.application.noticeStatus(audienceId);
  await host.application.acknowledgeNotice(audienceId, { version: notice.version, decision: "customize_first", confirmedForeground: true });
  const catalog = await host.application.capabilityCatalog(audienceId), provider = catalog.providers.find((item) => item.label === "cli-test");
  const bot = await host.application.createBot({ audienceId, bot: { name: "Ada", instructions: "Reply briefly", avatar: { version: 1, shape: "wisp", color: "lilac" } }, access: { accessMode: "custom", catalogRevision: catalog.revision, custom: { providerId: provider.id, modelId: provider.models[0].id, fileScopeIds: [], shellEnabled: false, connectionIds: [], skillIds: [], otherCapabilityIds: [] } } });
  await host.command(["enable-durable"]);
  await host.stop();
  host = await api.createCliBots(dir, daemon); daemon.setBots(host);
  const never = new AbortController().signal;

  // Pausing while a reply streams stops it where it is and leaves it for Resume.
  const running = await host.durable.runtime.send(bot.id, { text: "Hello", requestId: "before-pause" });
  for (let tries = 0; calls === 0 && tries < 500; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  const paused = await host.command(["pause", bot.id]);
  assert.deepEqual(Object.keys(paused).sort(), ["botId", "paused", "since"]);
  assert.equal(paused.paused, true);
  // Bounded: a pause that leaves the turn running would otherwise wait here for good.
  assert.equal((await host.durable.runtime.awaitReply(bot.id, running.submissionId, AbortSignal.timeout(20_000))).kind, "interrupted");
  const state = await host.durable.runtime.state(bot.id);
  assert.equal(state.kind, "paused"); assert.equal(state.by, "cli"); assert.equal(state.since, paused.since);
  assert.equal(state.interrupted, running.submissionId);
  assert.equal(await host.isPaused(bot.id), true, "the CLI's own check reads the same pause");
  await assert.rejects(host.durable.runtime.send(bot.id, { text: "Again", requestId: "while-paused" }), (error) => error.reason === "paused_by_person");
  assert.equal(calls, 1, "a paused Bot makes no provider request");
  const scheduler = api.createCliScheduler(dir); host.setScheduler(scheduler);
  const routine = await host.routines.create({ botId: bot.id, name: "Paused check", prompt: "Check in", schedule: { kind: "daily", time: "12:00" }, timezone: "UTC" });
  await assert.rejects(host.routines.runNow({ botId: bot.id, routineId: routine.id }), /paused\. Resume it/u);
  assert.deepEqual(await scheduler.store.runs(routine.id), [], "refused Run now does not create a skipped run");
  await host.routines.delete({ botId: bot.id, id: routine.id });

  // The pause outlives the daemon.
  await host.stop();
  host = await api.createCliBots(dir, daemon); daemon.setBots(host);
  assert.equal((await host.durable.runtime.state(bot.id)).kind, "paused");
  await assert.rejects(host.durable.runtime.send(bot.id, { text: "Again", requestId: "after-restart" }), (error) => error.reason === "paused_by_person");

  // Unpausing leaves the stopped turn waiting for Resume; nothing runs on its own.
  assert.deepEqual(await host.command(["unpause", bot.id]), { botId: bot.id, paused: false });
  const interrupted = await host.durable.runtime.state(bot.id);
  assert.equal(interrupted.kind, "interrupted"); assert.equal(interrupted.submissionId, running.submissionId);
  assert.equal(calls, 1);
  hold = false;
  await host.durable.runtime.resume(bot.id, "resume-after-unpause");
  assert.equal((await host.durable.runtime.awaitReply(bot.id, running.submissionId, never)).kind, "completed");
  assert.equal(calls, 2);

  // A phone watching the idle Bot hears the pause and the unpause at once; without bot:handoffs it reads unavailable.
  const remoteBots = api.createCliRemoteBots(dir, "test-instance", host, daemon, {}, new api.AidenIdempotencyLedger(), async () => {});
  const sse = createServer((_request, response) => { void remoteBots.botSessions.openEvents("device_1", bot.id, response).catch(() => response.destroy()); });
  await new Promise((resolve) => sse.listen(0, "127.0.0.1", resolve));
  const frames = [], watching = new AbortController();
  const reading = (async () => {
    const response = await fetch(`http://127.0.0.1:${sse.address().port}/`, { signal: watching.signal });
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      for (let index; (index = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(index + 2)) {
        const data = buffer.slice(0, index).split("\n").find((line) => line.startsWith("data: "));
        if (data) frames.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(() => {});
  const states = () => frames.map((frame) => frame.type === "snapshot" ? frame.payload.session.state : frame.type === "state" ? frame.payload.state : undefined).filter(Boolean);
  const until = async (predicate, what) => {
    for (let tries = 0; !predicate(); tries += 1) {
      if (tries > 1000) assert.fail(`Timed out waiting for ${what}; states: ${states().join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    await until(() => states().length > 0, "the snapshot");
    assert.deepEqual(states(), ["idle"]);
    await host.command(["pause", bot.id]);
    await until(() => states().at(-1) === "unavailable", "the pause");
    await host.command(["unpause", bot.id]);
    await until(() => states().at(-1) === "idle", "the unpause");
    assert.deepEqual(states(), ["idle", "unavailable", "idle"]);
  } finally {
    watching.abort(); sse.closeAllConnections(); sse.close(); await reading;
    await remoteBots.botSessions.close();
  }

  // Deleting the Bot forgets its pause.
  await host.command(["pause", bot.id]);
  await host.command(["delete", bot.id]);
  assert.equal(await host.isPaused(bot.id), false);
});

test("failed advisor attempts retain unknown usage and persist idempotently", async (t) => {
  const dir = temporary(t);
  const record = { source: "advisor", providerId: "test", providerLabel: "Test", modelId: "model", modelLabel: "Model", local: false, status: "failed", tokens: null, costStatus: "unavailable" };
  await Promise.all([api.recordUsageRecord(dir, record, "attempt-one"), api.recordUsageRecord(dir, record, "attempt-one")]);
  await api.recordUsageRecord(dir, { ...record, status: "cancelled" }, "attempt-two");
  await api.recordUsageRecord(dir, { ...record, source: "chat", status: "completed", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 }, costStatus: "reported", costUsd: 0.01 });
  await api.recordUsageRecord(dir, record, "attempt-one");
  const summary = await api.usageSummary(dir);
  assert.equal(summary.totals.requests, 3);
  assert.equal(summary.totals.failedRequests, 1);
  assert.equal(summary.totals.cancelledRequests, 1);
  assert.equal(summary.totals.unmeteredRequests, 2);
  assert.equal(summary.totals.unpricedHostedRequests, 2);
});

test("durable migration fails closed on backup errors and can be completed explicitly", async (t) => {
  const dir = temporary(t), journal = join(dir, "journal"), cancelled = [];
  const chat = { id: "chat-migration", botId: "bot:migration", messages: [{ role: "user", content: "Original history" }] };
  mkdirSync(journal);
  const daemon = { chatStore: { list: async () => [chat], get: async () => chat },
    llmClient: { cancelChat: async (id) => cancelled.push(id), waitForChatIdle: async () => {} }, sessionPath: () => journal };
  await assert.rejects(api.enableCliDurableBots(dir, daemon), /directory|EISDIR/i);
  const preparing = api.cliDurableBotMarker(dir);
  assert.equal(preparing.state, "preparing");
  assert.equal(existsSync(join(preparing.backup, "recovery.json")), false);
  rmSync(journal, { recursive: true }); writeFileSync(journal, "Original journal");
  const completed = await api.enableCliDurableBots(dir, daemon);
  assert.equal(api.cliDurableBotMarker(dir).state, "enabled");
  assert.notEqual(completed.backup, preparing.backup);
  assert.equal(readFileSync(journal, "utf8"), "Original journal");
  assert.equal(JSON.parse(readFileSync(join(completed.backup, "legacy-chats.json"))).chats[0].chat.messages[0].content, "Original history");
  const replay = await api.enableCliDurableBots(dir, daemon);
  assert.equal(replay.backup, completed.backup);
  assert.deepEqual(cancelled, [chat.id, chat.id]);
});

test("CLI advisor failures and cancellation persist unknown attempts before marking usage", async (t) => {
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  for (const mode of ["failed", "cancelled", "persistence-failed"]) {
    const dir = temporary(t);
    const controller = new AbortController();
    const provider = fauxProvider({ api: "advisor-fixture", provider: "advisor-fixture", models: [{ id: "reviewer", contextWindow: 32000, maxTokens: 4096 }] });
    const model = provider.getModel();
    provider.provider.streamSimple = () => { if (mode === "cancelled") controller.abort(); throw new Error("Provider failed before response"); };
    const ctx = { model: { ...model, id: "executor" }, scopedModels: [{ model }], hasUI: false,
      sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Review this fixture", timestamp: 1 } }] },
      modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }), getProvider: () => provider.provider },
    };
    const hooks = new Map(); let tool;
    api.createAdvisorInlineExtension({ agentDir: dir, latestContext: () => ctx }).factory({ on: (name, handler) => hooks.set(name, handler), registerTool: (value) => { tool = value; } });
    await hooks.get("before_agent_start")({ systemPrompt: "Fixture" }, ctx);
    if (mode === "persistence-failed") mkdirSync(join(dir, "usage.json"));
    await tool.execute("advisor-call", { providerId: model.provider, modelId: model.id }, controller.signal);
    const attempt = JSON.parse(readFileSync(join(dir, "advisor", "advisor-attempts.json"), "utf8")).attempts[0];
    assert.equal(attempt.state, mode === "cancelled" ? "cancelled" : "failed");
    assert.equal(attempt.usageRecorded, mode !== "persistence-failed");
    if (mode !== "persistence-failed") {
      const summary = await api.usageSummary(dir);
      assert.equal(summary.totals.requests, 1);
      assert.equal(summary.totals.unmeteredRequests, 1);
      assert.equal(summary.totals.unpricedHostedRequests, 1);
      const ledger = JSON.parse(readFileSync(join(dir, "usage.json"), "utf8"));
      assert.equal(ledger.accountedAttempts.length, 1);
    }
  }
});

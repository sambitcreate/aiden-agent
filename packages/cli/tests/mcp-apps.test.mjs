// `aiden serve` hosts the loopback `/mcp` endpoint, and `aiden apps`
// connects, lists and disconnects the outside apps that use it. Everything
// runs through the real CLI: the daemon, its control socket and the listener.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkg, "dist", "app", "cli.js");

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "aiden-mcp-apps-"));
  const home = join(root, "home"), agentDir = join(root, "agent"), workspace = join(root, "project");
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // CI keeps analytics off for runs nobody started; the server would send nothing anyway.
  return { agentDir, workspace, env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", AIDEN_ANALYTICS: "0" } };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function serve(t, env, args = []) {
  const child = spawn(process.execPath, [cli, "serve", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { text: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output.text += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output.text += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  };
  t.after(stop);
  const ready = /Aiden Remote listening|Aiden Remote is off/;
  const deadline = Date.now() + 60_000;
  while (!ready.test(output.text)) {
    if (child.exitCode !== null) throw new Error(`serve exited early (${child.exitCode}):\n${output.text}`);
    if (Date.now() > deadline) throw new Error(`serve did not become ready:\n${output.text}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  return { output, stop };
}

/** An OpenAI-compatible model that answers every turn with one line of text. */
async function fakeProvider(t, agentDir) {
  const server = createServer(async (request, response) => {
    request.resume();
    await once(request, "end");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the server" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  api.atomicJson(join(agentDir, "models.json"), { providers: { "cli-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-only", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
}

let rpcId = 0;
/** One MCP JSON-RPC request over Streamable HTTP, as Claude Code or Codex would send it. */
function mcp(url, token, method, params = {}) {
  const target = new URL(url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((done, reject) => {
    const request = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      let data = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => done({ status: response.statusCode, body: response.headers["content-type"]?.includes("json") && data ? JSON.parse(data) : data }));
    });
    request.setTimeout(60_000, () => request.destroy(new Error(`MCP request timed out: ${method}`)));
    request.on("error", reject);
    request.end(body);
  });
}

async function callTool(url, token, name, args) {
  const response = await mcp(url, token, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.result?.isError, undefined, JSON.stringify(response.body));
  return response.body.result.structuredContent;
}

async function toolNames(url, token) {
  const response = await mcp(url, token, "tools/list");
  assert.equal(response.status, 200, JSON.stringify(response));
  return response.body.result.tools.map((tool) => tool.name);
}

test("aiden serve keeps /mcp off until an app is connected, then the app runs a chat until it is disconnected", async (t) => {
  const { agentDir, workspace, env } = sandbox(t);
  await fakeProvider(t, agentDir);
  const { id: workspaceId } = json(runCli(["workspace", "add", workspace], env));
  const first = await serve(t, env);

  // Off by default: no listener, nothing saved, no app.
  const before = json(runCli(["apps", "list"], env));
  assert.equal(before.server.enabled, false);
  assert.equal(before.server.running, false);
  assert.equal(before.server.url, undefined);
  assert.deepEqual(before.apps, []);

  // Piped output is a log: the token comes as JSON with a warning on stderr.
  const connectedResult = runCli(["apps", "connect", "Claude", "Code", "--access", "supervised"], env);
  const connected = json(connectedResult);
  assert.match(connectedResult.stderr, /token.*keep it out of logs/);
  assert.equal(connected.app.name, "Claude Code");
  assert.equal(connected.app.access, "supervised");
  assert.match(connected.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(connected.server.running, true);
  assert.match(connected.server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const { url } = connected.server;
  assert.match(first.output.text, /Aiden Remote listening/);

  // The token is what admits an app; nothing else does.
  assert.equal((await mcp(url, undefined, "tools/list")).status, 401);
  assert.equal((await mcp(url, "x".repeat(43), "tools/list")).status, 401);

  // Supervised can start chats; a Read app sees only the reading tools.
  const supervisedTools = await toolNames(url, connected.token);
  assert.ok(supervisedTools.includes("aiden_chat_start"), supervisedTools.join());
  const refused = runCli(["apps", "connect", "Codex", "--access", "admin"], env);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stderr, /read or supervised/);
  const reader = json(runCli(["apps", "connect", "Codex"], env));
  assert.equal(reader.app.access, "read");
  const readTools = await toolNames(url, reader.token);
  assert.ok(readTools.includes("aiden_chat_read"), readTools.join());
  assert.equal(readTools.includes("aiden_chat_start"), false, readTools.join());
  assert.ok(readTools.every((name) => supervisedTools.includes(name)));

  // A chat started by the app runs on the server's model and reads back.
  const workspaces = await callTool(url, connected.token, "aiden_workspace_list", {});
  assert.ok(JSON.stringify(workspaces).includes(workspaceId), JSON.stringify(workspaces));
  const started = await callTool(url, connected.token, "aiden_chat_start",
    { clientRequestId: "mcp-apps-test-0001", workspaceId, text: "Say hello", providerId: "cli-test", modelId: "test" });
  let run = { state: "running" };
  for (let attempt = 0; attempt < 6 && run.state === "running"; attempt += 1) {
    run = await callTool(url, connected.token, "aiden_chat_wait", { chatId: started.chatId, runId: started.runId, timeoutSeconds: 10 });
  }
  assert.equal(run.state, "done", JSON.stringify(run));
  const transcript = await callTool(url, connected.token, "aiden_chat_read", { chatId: started.chatId });
  assert.ok(JSON.stringify(transcript).includes("Hello from the server"), JSON.stringify(transcript));
  // The server notes, on this computer only, which app started the chat.
  const provenance = JSON.parse(readFileSync(join(agentDir, "aiden-mcp-chat-provenance.json"), "utf8"));
  assert.deepEqual(provenance.entries.map(({ chatId, appId, name }) => ({ chatId, appId, name })),
    [{ chatId: started.chatId, appId: connected.app.id, name: "Claude Code" }]);

  // Disconnecting ends that token at once; the other app keeps working.
  assert.deepEqual(json(runCli(["apps", "revoke", connected.app.id], env)), { revoked: true });
  assert.equal((await mcp(url, connected.token, "tools/list")).status, 401);
  assert.ok((await toolNames(url, reader.token)).length > 0);
  const listed = json(runCli(["apps", "list"], env));
  assert.ok(listed.apps.find((app) => app.id === connected.app.id).revokedAt, JSON.stringify(listed.apps));
  assert.equal(listed.apps.find((app) => app.id === reader.app.id).revokedAt, undefined);

  // Off closes the listener; the saved port comes back with it.
  assert.equal(json(runCli(["apps", "off"], env)).running, false);
  await assert.rejects(mcp(url, reader.token, "tools/list"), { code: "ECONNREFUSED" });
  const on = json(runCli(["apps", "on"], env));
  assert.equal(on.url, url);
  assert.ok((await toolNames(url, reader.token)).length > 0);

  // A restarted server opens the same URL, so a configured app keeps working.
  await first.stop();
  const second = await serve(t, env);
  assert.match(second.output.text, new RegExp(`Aiden MCP server listening at ${url.replace(/[.]/g, "\\.")}`));
  assert.ok((await toolNames(url, reader.token)).length > 0);
});

test("aiden apps refuses what it cannot do, and never disconnects a phone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-mcp-apps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = cli;
  t.after(() => { if (original === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = original; });
  const daemon = api.createDaemonChats(dir), scheduler = api.createCliScheduler(dir);
  // Distinct from the other suites' Remote ports: test files run in parallel.
  const remote = await api.createCliRemote(dir, daemon, scheduler, { port: 49378, mcpPort: 0, discovery: { async start() {}, stop() {} } });
  t.after(async () => { await remote.stop(); await scheduler.service.stopAndSettle(); });
  await remote.start();

  for (const [args, pattern] of [
    [["connect"], /Name the app/],
    [["connect", "Claude", "--access", "admin"], /read or supervised/],
    [["connect", "x".repeat(81)], /at most 80/],
    [["connect", "Claude", "--scope", "user"], /Usage: apps/],
    [["revoke", "dev_unknown"], /No connected app/],
    [["rename"], /Usage: apps/],
  ]) await assert.rejects(remote.apps(args), pattern, args.join(" "));
  // A refused connect turned nothing on and connected nothing.
  const listed = await remote.apps(["list"]);
  assert.equal(listed.server.enabled, false);
  assert.equal(listed.server.running, false);
  assert.deepEqual(listed.apps, []);

  // A phone's id is not an app's, so `aiden apps revoke` leaves it paired.
  const phone = await remote.state.issueDevice({ name: "Phone", type: "iphone", clientVersion: "test" });
  await assert.rejects(remote.apps(["revoke", phone.device.id]), /No connected app/);
  const devices = await remote.state.listDevices();
  assert.equal(devices.find((device) => device.id === phone.device.id)?.revokedAt, undefined, JSON.stringify(devices));
  // `aiden apps list` shows only the apps, never the phone.
  const app = await remote.apps(["connect", "Codex"]);
  assert.match(app.server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.deepEqual((await remote.apps(["list"])).apps.map(({ id }) => id), [app.app.id]);
});

test("aiden serve --no-remote has no /mcp, and aiden apps says how to get it", async (t) => {
  const { env } = sandbox(t);
  await serve(t, env, ["--no-remote"]);
  const result = runCli(["apps", "list"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /without --no-remote/);
});

test("the Claude Code and Codex commands keep the token out of their config files", () => {
  const url = "http://127.0.0.1:49500/mcp", token = "t".repeat(43);
  const snippets = api.aidenMcpClientSnippets(url, token);
  assert.ok(snippets.environment.includes(token));
  for (const command of [snippets.claude, snippets.codex]) {
    assert.ok(command.includes(url), command);
    assert.equal(command.includes(token), false, command);
    assert.ok(command.includes("AIDEN_MCP_TOKEN"), command);
  }
  // A server that could not start gives no commands to copy, only the way to retry.
  const blocked = api.renderAppConnection({ token, app: { id: "dev_1", name: "Claude Code", access: "read" },
    server: { supported: true, enabled: true, running: false, port: 49500, problem: "port_in_use" } });
  assert.equal(blocked.includes("claude mcp add"), false);
  assert.match(blocked, /aiden apps on/);
  assert.equal(blocked.split(token).length - 1, 1, "the token is shown once");
});

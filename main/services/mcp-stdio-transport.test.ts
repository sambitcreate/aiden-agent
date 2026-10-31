import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpClient } from "@earendil-works/pi-mcp";
import { createMcpStdioTransport } from "./mcp-stdio-transport.js";

/**
 * A wrapper-shaped server (like `npx`/`uvx`): it starts a long-lived
 * grandchild, answers `initialize` over newline-delimited JSON-RPC, reports
 * what environment it received, and exits as soon as stdin closes (or, with
 * EXIT_WHEN_INITIALIZED, on its own once initialized), leaving the grandchild
 * behind unless its process group is terminated.
 */
const SERVER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.REPORT_FILE, JSON.stringify({
  grandchild: grandchild.pid,
  inherited: process.env.AIDEN_STDIO_INHERITED_MARKER ?? null,
  declared: process.env.DECLARED_SETTING ?? null,
  hasPath: Boolean(process.env.PATH),
}));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "notifications/initialized" && process.env.EXIT_WHEN_INITIALIZED) process.exit(0);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "wrapper", version: "1" },
      } }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/**
 * A terminated process that nobody has reaped yet is a zombie: `kill(pid, 0)`
 * still succeeds for it. In containers whose PID 1 does not reap orphans, the
 * killed grandchild stays a zombie indefinitely, so read its state on Linux.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

test("stdio servers get only the safe default plus declared environment, and close ends their whole process tree", {
  skip: process.platform === "win32" ? "POSIX process groups" : false,
  timeout: 15_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-mcp-stdio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportFile = join(directory, "report.json");
  process.env.AIDEN_STDIO_INHERITED_MARKER = "must-not-leak";
  t.after(() => { delete process.env.AIDEN_STDIO_INHERITED_MARKER; });
  const transport = createMcpStdioTransport({
    command: "node",
    args: ["-e", SERVER],
    env: { DECLARED_SETTING: "declared", REPORT_FILE: reportFile },
    closeGraceMs: 500,
  });
  const client = new McpClient({ name: "stdio-regression", version: "1" });
  await client.connect(transport);
  assert.equal(client.serverInfo?.name, "wrapper", "framing round-trips over the transport");
  const report = JSON.parse(await readFile(reportFile, "utf8")) as { grandchild: number; inherited: unknown; declared: unknown; hasPath: boolean };
  assert.equal(report.inherited, null, "Aiden's own environment is not forwarded");
  assert.equal(report.declared, "declared");
  assert.equal(report.hasPath, true, "PATH still resolves commands like node, npx and uvx");
  assert.equal(alive(report.grandchild), true);
  await client.close();
  for (let attempt = 0; attempt < 100 && alive(report.grandchild); attempt += 1) await delay(20);
  assert.equal(alive(report.grandchild), false, "the grandchild left by the exited wrapper was terminated");
});

test("a wrapper that exits on its own does not leave its server running after the transport closes", {
  skip: process.platform === "win32" ? "POSIX process groups" : false,
  timeout: 15_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-mcp-stdio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportFile = join(directory, "report.json");
  const transport = createMcpStdioTransport({
    command: "node",
    args: ["-e", SERVER],
    env: { REPORT_FILE: reportFile, EXIT_WHEN_INITIALIZED: "1" },
    closeGraceMs: 500,
  });
  const client = new McpClient({ name: "stdio-natural-exit", version: "1" });
  let closed = false;
  client.onClose(() => { closed = true; });
  await client.connect(transport);
  const report = JSON.parse(await readFile(reportFile, "utf8")) as { grandchild: number };
  t.after(() => { try { process.kill(report.grandchild, "SIGKILL"); } catch { /* already gone */ } });
  for (let attempt = 0; attempt < 250 && !closed; attempt += 1) await delay(20);
  assert.equal(closed, true, "the wrapper exited and the transport reported closure");
  for (let attempt = 0; attempt < 150 && alive(report.grandchild); attempt += 1) await delay(20);
  assert.equal(alive(report.grandchild), false, "the server the wrapper left behind was terminated without client.close()");
  await client.close();
});

/** A newline-framed MCP server with one tool, `echo`, that returns its input as text and structured content. */
const TOOL_SERVER = `
let buffer = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "initialize") reply(message.id, {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" },
    });
    if (message.method === "tools/list") reply(message.id, { tools: [{
      name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: { type: "object", required: ["echoed"], properties: { echoed: { type: "string" } } },
    }] });
    if (message.method === "tools/call") reply(message.id, {
      content: [{ type: "text", text: message.params.arguments.text }], structuredContent: { echoed: message.params.arguments.text },
    });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

test("a stdio server's tools are listed and called end to end through the guarded inventory", { timeout: 15_000 }, async (t) => {
  const { listMcpToolInventory, listMcpToolPage, createMcpToolCallGuard, guardedMcpToolCall } = await import("./mcp-tool-inventory.js");
  const client = new McpClient({ name: "stdio-tools", version: "1" });
  t.after(() => client.close());
  await client.connect(createMcpStdioTransport({ command: process.execPath, args: ["-e", TOOL_SERVER], closeGraceMs: 500 }));
  const tools = await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) });
  assert.deepEqual(tools.map(({ name }) => name), ["echo"]);
  const guard = createMcpToolCallGuard(tools);
  const result = await guardedMcpToolCall(guard, client, { name: "echo", arguments: { text: "hello" } }, { timeoutMs: 5_000 });
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result.structuredContent, { echoed: "hello" });
  await assert.rejects(guardedMcpToolCall(guard, client, { name: "missing", arguments: {} }), /no longer offered/u);
});

/**
 * A wrapper that starts a server in its own session (`setsid`, outside the
 * wrapper's process group) which inherits the wrapper's stdout, so the pipe
 * stays open after the wrapper exits.
 */
const ESCAPED_SERVER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
writeFileSync(process.env.REPORT_FILE, JSON.stringify({ escaped: escaped.pid }));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "escaped", version: "1" },
      } }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

test("close is bounded when a process outside the server's group holds its stdout", {
  skip: process.platform === "win32" ? "POSIX sessions" : false,
  timeout: 15_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-mcp-stdio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reportFile = join(directory, "report.json");
  const client = new McpClient({ name: "stdio-escaped", version: "1" });
  await client.connect(createMcpStdioTransport({
    command: process.execPath, args: ["-e", ESCAPED_SERVER], env: { REPORT_FILE: reportFile }, closeGraceMs: 300,
  }));
  const { escaped } = JSON.parse(await readFile(reportFile, "utf8")) as { escaped: number };
  t.after(() => { try { process.kill(escaped, "SIGKILL"); } catch { /* already gone */ } });
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 5_000, `close settled after ${Date.now() - started} ms`);
});

test("an oversized stdio message fails the pending call at once instead of at its timeout", { timeout: 15_000 }, async (t) => {
  const server = TOOL_SERVER.replace(
    "content: [{ type: \"text\", text: message.params.arguments.text }]",
    "content: [{ type: \"text\", text: \"x\".repeat(4096) }]",
  );
  assert.notEqual(server, TOOL_SERVER);
  const { callMcpTool } = await import("./mcp-tool-inventory.js");
  const client = new McpClient({ name: "stdio-oversized", version: "1" });
  t.after(() => client.close());
  await client.connect(createMcpStdioTransport({ command: process.execPath, args: ["-e", server], maxBufferSize: 1024, closeGraceMs: 300 }));
  const started = Date.now();
  await assert.rejects(callMcpTool(client, { name: "echo", arguments: { text: "hi" } }, { timeoutMs: 10_000 }), /closed/iu);
  assert.ok(Date.now() - started < 5_000, "the call failed when the oversized reply arrived");
});

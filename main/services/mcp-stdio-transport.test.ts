import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpStdioTransport } from "./mcp-stdio-transport.js";

/**
 * A wrapper-shaped server (like `npx`/`uvx`): it starts a long-lived
 * grandchild, answers `initialize` over newline-delimited JSON-RPC, reports
 * what environment it received, and exits as soon as stdin closes, leaving
 * the grandchild behind unless its process group is terminated.
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
  const client = new Client({ name: "stdio-regression", version: "1" });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "wrapper", "SDK framing round-trips over the custom transport");
  const report = JSON.parse(await readFile(reportFile, "utf8")) as { grandchild: number; inherited: unknown; declared: unknown; hasPath: boolean };
  assert.equal(report.inherited, null, "Aiden's own environment is not forwarded");
  assert.equal(report.declared, "declared");
  assert.equal(report.hasPath, true, "PATH still resolves commands like node, npx and uvx");
  assert.equal(alive(report.grandchild), true);
  await client.close();
  for (let attempt = 0; attempt < 100 && alive(report.grandchild); attempt += 1) await delay(20);
  assert.equal(alive(report.grandchild), false, "the grandchild left by the exited wrapper was terminated");
});

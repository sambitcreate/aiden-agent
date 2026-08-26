import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diagnosticSnapshot } from "./performance-diagnostics.js";
import {
  acquireDiagnosticMcpClient,
  resetDiagnosticMcpClientTrackingForTest,
} from "./performance-mcp.js";
import { DiagnosticStdioClientTransport } from "./diagnostic-stdio-client-transport.js";

test("MCP client accounting counts actual concurrent objects and releases once", () => {
  resetDiagnosticMcpClientTrackingForTest();
  const first = acquireDiagnosticMcpClient("status");
  const second = acquireDiagnosticMcpClient("status");
  const isolated = acquireDiagnosticMcpClient("isolated");
  let snapshot = diagnosticSnapshot();
  assert.equal(snapshot.gauges["live:mcp-client"]?.current, 3);
  assert.equal(snapshot.gauges["live:mcp-client:status"]?.current, 2);
  assert.equal(snapshot.gauges["live:mcp-client"]?.peak >= 3, true);

  first();
  first();
  isolated();
  snapshot = diagnosticSnapshot();
  assert.equal(snapshot.gauges["live:mcp-client"]?.current, 1);
  second();
  assert.equal(diagnosticSnapshot().gauges["live:mcp-client"]?.current, 0);
});

test("the packaged duplicate-connect scenario drives 100 production manager attempts", async () => {
  const source = await readFile(path.join(process.cwd(), "main", "index.ts"), "utf8");
  const start = source.indexOf("async function runFixedMcpDuplicateConnectBenchmark");
  const end = source.indexOf("\nasync function shutdownAndQuit", start);
  const driver = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(driver, /AIDEN_PERFORMANCE_DIAGNOSTICS !== "1"/u);
  assert.match(driver, /AIDEN_BENCHMARK_SCENARIO !== "mcp-duplicate-connect"/u);
  assert.match(driver, /Array\.from\(\{ length: 100 \}/u);
  assert.match(driver, /mcpManager\.status\(server/u);
  assert.match(source, /await runFixedMcpDuplicateConnectBenchmark\(\)/u);
});

test("stdio MCP transport accounts for the actual helper process until close", async () => {
  const before = diagnosticSnapshot().counters["child:mcp-stdio"]?.count ?? 0;
  const transport = new DiagnosticStdioClientTransport({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    stderr: "pipe",
  });
  await transport.start();
  assert.equal(diagnosticSnapshot().counters["child:mcp-stdio"]?.count, before + 1);
  assert.equal(diagnosticSnapshot().gauges["live:child-mcp-stdio"]?.current, 1);
  await transport.close();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(diagnosticSnapshot().gauges["live:child-mcp-stdio"]?.current, 0);
});

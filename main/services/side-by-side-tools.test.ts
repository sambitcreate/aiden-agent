import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { tagMcpAgentTool } from "./mcp-agent-tool-descriptor.js";
import { markMcpAgentTool } from "./mcp-tool-identity.js";
import { createSideBySideToolPolicy, runsSideBySide } from "./side-by-side-tools.js";

function tool(name: string, execute?: AgentTool["execute"]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: execute ?? (async () => ({ content: [{ type: "text", text: name }], details: null })),
  };
}

function mcpTool(name: string, annotations: unknown): AgentTool {
  return tagMcpAgentTool(markMcpAgentTool(tool(name), { serverId: "docs", toolName: name }), {
    name,
    annotations,
  });
}

test("reads, searches and read-only MCP tools run side by side; everything else does not", () => {
  for (const name of ["read_file", "list_dir", "glob", "grep", "web_search", "web_fetch"]) {
    assert.equal(runsSideBySide(tool(name)), true, name);
  }
  for (const name of ["write_file", "edit_file", "run_command", "codemode", "browser_open"]) {
    assert.equal(runsSideBySide(tool(name)), false, name);
  }
  assert.equal(runsSideBySide(mcpTool("docs_search", { readOnlyHint: true })), true);
  assert.equal(runsSideBySide(mcpTool("docs_write", { readOnlyHint: false })), false);
  assert.equal(runsSideBySide(mcpTool("docs_unknown", {})), false);
  // A remote tool cannot run side by side by borrowing a built-in read's name.
  assert.equal(runsSideBySide(markMcpAgentTool(tool("grep"), { serverId: "evil", toolName: "grep" })), false);
  assert.equal(runsSideBySide({ ...tool("read_file"), executionMode: "sequential" }), false);
});

test("the policy marks every other tool sequential and keeps one copy per tool", () => {
  const policy = createSideBySideToolPolicy();
  const read = tool("read_file");
  const write = tool("write_file");
  const [readCopy, writeCopy] = policy([read, write]);
  assert.notEqual(readCopy!.executionMode, "sequential");
  assert.equal(writeCopy!.executionMode, "sequential");
  assert.equal(writeCopy!.name, "write_file");
  const [readAgain, writeAgain] = policy([read, write]);
  assert.equal(readAgain, readCopy);
  assert.equal(writeAgain, writeCopy);
});

test("side-by-side calls share a few slots, and a waiting call can be stopped", async () => {
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const read = tool("grep", async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve) => releases.push(resolve));
    running -= 1;
    return { content: [{ type: "text", text: "found" }], details: null };
  });
  const [limited] = createSideBySideToolPolicy(2)([read]);
  const calls = [1, 2, 3].map((n) => limited!.execute(`call-${n}`, {}, undefined, undefined));
  const stopper = new AbortController();
  const stopped = limited!.execute("call-4", {}, stopper.signal, undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(running, 2);
  stopper.abort(new Error("stopped while waiting"));
  await assert.rejects(stopped, /stopped while waiting/);
  while (releases.length > 0 || running > 0) {
    releases.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(calls);
  assert.equal(peak, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { assertUniqueMcpAgentToolNames, mcpAgentToolName } from "./mcp-tool-identity.js";
import { executeMcpAgentTool, mcpAgentToolResult } from "./mcp-tool-result.js";

test("MCP agent tool names bind to stable server and raw tool identities", () => {
  const first = mcpAgentToolName({ id: "github-work", name: "GitHub" }, "create_issue");
  const second = mcpAgentToolName({ id: "github-personal", name: "GitHub" }, "create_issue");
  const punctuationA = mcpAgentToolName({ id: "server", name: "Same" }, "foo!");
  const punctuationB = mcpAgentToolName({ id: "server", name: "Same" }, "foo?");
  assert.notEqual(first, second);
  assert.notEqual(punctuationA, punctuationB);
  assert.ok(first.length <= 64);
  assert.ok(mcpAgentToolName({ id: "long", name: "x".repeat(200) }, "y".repeat(200)).length <= 64);
  assert.doesNotThrow(() => assertUniqueMcpAgentToolNames([{ name: first }, { name: second }]));
  assert.throws(
    () => assertUniqueMcpAgentToolNames([{ name: first }, { name: first }]),
    /identity collision/iu,
  );
});

test("maps a successful MCP result into Pi tool content", () => {
  assert.deepEqual(
    mcpAgentToolResult({
      content: [{ type: "text", text: "created issue 42" }],
      isError: false,
    }),
    {
      content: [{ type: "text", text: "created issue 42" }],
      details: null,
    },
  );
});

test("throws a standard resolved MCP isError result so Pi records tool failure", async () => {
  await assert.rejects(
    executeMcpAgentTool(async () => ({
      content: [{ type: "text", text: "permission denied" }],
      isError: true,
    })),
    /permission denied/u,
  );
});

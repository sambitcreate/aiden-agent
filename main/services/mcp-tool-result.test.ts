import assert from "node:assert/strict";
import test from "node:test";
import { executeMcpAgentTool, mcpAgentToolResult } from "./mcp-tool-result.js";

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

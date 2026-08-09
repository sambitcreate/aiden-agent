import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantProjectTool, LIST_PROJECTS_TOOL_NAME } from "./project-tool.js";

function jsonResult(value: AgentToolResult<null>): Record<string, unknown> {
  const block = value.content[0];
  assert.equal(block?.type, "text");
  if (!block || block.type !== "text") throw new Error("Expected a text tool result.");
  return JSON.parse(block.text) as Record<string, unknown>;
}

test("list_projects returns only eligible identities without folder paths", async () => {
  const tool = createAssistantProjectTool({
    listWorkspaces: async () => [
      {
        id: "project-1",
        name: "Website",
        folderPath: "/private/website",
        permission: "ask",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "no-access",
        name: "Private",
        folderPath: "/private/secret",
        permission: "none",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "empty",
        name: "No folder",
        permission: "full",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  assert.equal(tool.name, LIST_PROJECTS_TOOL_NAME);
  const listed = jsonResult(await tool.execute("list", {}));
  assert.deepEqual(listed.projects, [{ id: "project-1", name: "Website" }]);
  assert.doesNotMatch(JSON.stringify(listed), /private\/website/u);
  await assert.rejects(tool.execute("invalid", { extra: true }), /does not accept arguments/iu);
});

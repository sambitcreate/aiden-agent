import assert from "node:assert/strict";
import test from "node:test";

import { subagentsAllowedForGeneration } from "./eligibility.js";

test("agent-backed providers never delegate to Aiden subagents", () => {
  const base = {
    assistantMode: false,
    allowSubagents: true,
    usageSource: "chat",
    workspaceId: "w",
    folderPath: "/w",
    permission: "ask",
  };
  assert.equal(subagentsAllowedForGeneration({ ...base, providerId: "openai" }), true);
  assert.equal(subagentsAllowedForGeneration({ ...base, providerId: "antigravity" }), false);
});

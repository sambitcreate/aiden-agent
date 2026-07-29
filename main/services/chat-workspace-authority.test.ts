import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativeChatWorkspaceId,
  persistedChatReferencesSubagentRun,
  persistedChatWorkspaceId,
} from "./chat-workspace-authority.js";

test("persisted chat workspace ownership is authoritative over renderer input", () => {
  assert.equal(authoritativeChatWorkspaceId("workspace-a", "workspace-a"), "workspace-a");
  assert.throws(
    () => authoritativeChatWorkspaceId("workspace-a", "workspace-b"),
    /different workspace/u,
  );
  assert.throws(
    () => authoritativeChatWorkspaceId("workspace-a", undefined),
    /different workspace/u,
  );
});

test("legacy and omitted chat workspace ids normalize to the default workspace", () => {
  assert.equal(persistedChatWorkspaceId(undefined), "default");
  assert.equal(authoritativeChatWorkspaceId(undefined, undefined), "default");
  assert.equal(authoritativeChatWorkspaceId(undefined, "default"), "default");
  assert.throws(
    () => authoritativeChatWorkspaceId(undefined, "workspace-b"),
    /different workspace/u,
  );
});

test("historical subagent reads require an exact persisted assistant-message reference", () => {
  const exactReference = {
    role: "assistant",
    subagents: {
      version: 1,
      generationId: "generation-1",
      runIds: ["run-1", "run-2"],
    },
  };
  assert.equal(persistedChatReferencesSubagentRun([exactReference], "run-1", "generation-1"), true);
  assert.equal(persistedChatReferencesSubagentRun([], "run-1", "generation-1"), false);
  assert.equal(
    persistedChatReferencesSubagentRun([exactReference], "run-orphan", "generation-1"),
    false,
  );
  assert.equal(
    persistedChatReferencesSubagentRun([exactReference], "run-1", "generation-other"),
    false,
  );
  assert.equal(
    persistedChatReferencesSubagentRun(
      [{ ...exactReference, role: "system" }],
      "run-1",
      "generation-1",
    ),
    false,
  );
});

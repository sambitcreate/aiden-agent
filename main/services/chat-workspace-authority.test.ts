import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  authoritativeChatGenerationMode,
  authoritativeChatWorkspaceId,
  persistedChatReferencesSubagentRun,
  persistedChatWorkspaceId,
} from "./chat-workspace-authority.js";

test("persisted chat workspace ownership is authoritative over renderer input", () => {
  assert.equal(
    authoritativeChatWorkspaceId("workspace-a", "workspace-a"),
    "workspace-a",
  );
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

test("persisted chat identity is authoritative for attended Assistant mode", () => {
  assert.equal(
    authoritativeChatGenerationMode("assistant", undefined),
    "assistant",
  );
  assert.equal(
    authoritativeChatGenerationMode("assistant", "assistant"),
    "assistant",
  );
  assert.equal(
    authoritativeChatGenerationMode("workspace-a", undefined),
    undefined,
  );
  assert.throws(
    () => authoritativeChatGenerationMode("workspace-a", "assistant"),
    /not an Aiden Assistant chat/u,
  );
  assert.equal(
    authoritativeChatGenerationMode("workspace-a", "assistant-unattended"),
    "assistant-unattended",
  );
  assert.equal(
    authoritativeChatGenerationMode("workspace-a", "assistant-automation"),
    "assistant-automation",
  );
});

test("generation uses the persisted Assistant mode for handoff, tools, and prompts", () => {
  const llmClientSource = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const startSource = llmClientSource.slice(llmClientSource.indexOf("export const llmClient"));
  assert.match(
    startSource,
    /authoritativeMode = authoritativeChatGenerationMode\(\s*chat\.workspaceId,\s*params\.mode,?\s*\)/u,
  );
  assert.match(
    startSource,
    /\{\s*\.\.\.params,\s*workspaceId: authoritativeWorkspaceId,\s*mode: authoritativeMode,?\s*\}/u,
  );
  assert.match(startSource, /authoritativeMode === "assistant"/u);
  assert.doesNotMatch(startSource, /params\.mode\s*===/u);
});

test("generation initialization persists terminal outcomes before releasing ownership", () => {
  const llmClientSource = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const startSource = llmClientSource.slice(llmClientSource.indexOf("export const llmClient"));
  const helperStart = startSource.indexOf("const initializationTerminalState = { attempted: false }");
  const firstCleanup = startSource.indexOf("releaseGenerationSkillReservation(initialization)");
  assert.ok(helperStart >= 0, "terminal persistence helper must be part of generation start");
  assert.ok(
    helperStart < firstCleanup,
    "terminal persistence must be established before an initialization cleanup can run",
  );
  assert.match(llmClientSource, /import \{ persistGenerationInitializationTerminal \}/u);
  assert.match(startSource, /await persistGenerationInitializationTerminal\(\{/u);
  assert.match(startSource, /append: \(message, meta\) => chatStore\.appendMessage\(params\.chatId, message, meta\)/u);
  assert.match(startSource, /initializing\.get\(streamId\) === initialization/u);
  assert.match(startSource, /active\.get\(streamId\)\?\.owner === owner/u);

  const cancellationPersists = startSource.match(
    /await persistInitializationTerminal\(\s*"cancelled",\s*(?:initialization|activeGeneration)\.cancellationOrigin,?\s*\)/gu,
  );
  const failurePersists = startSource.match(
    /await persistInitializationTerminal\("failed"\)/gu,
  );
  assert.equal(cancellationPersists?.length, 3);
  assert.equal(failurePersists?.length, 3);

  for (const status of ["cancelled", "failed"] as const) {
    const persistIndex = startSource.indexOf(
      status === "cancelled"
        ? 'await persistInitializationTerminal(\n          "cancelled"'
        : 'await persistInitializationTerminal("failed")',
    );
    assert.ok(persistIndex >= 0);
    const cleanupIndex = startSource.indexOf(
      "releaseGenerationSkillReservation(initialization)",
      persistIndex,
    );
    assert.ok(
      cleanupIndex > persistIndex,
      `${status} outcome must become durable before generation ownership is released`,
    );
  }
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
  assert.equal(
    persistedChatReferencesSubagentRun(
      [exactReference],
      "run-1",
      "generation-1",
    ),
    true,
  );
  assert.equal(
    persistedChatReferencesSubagentRun([], "run-1", "generation-1"),
    false,
  );
  assert.equal(
    persistedChatReferencesSubagentRun(
      [exactReference],
      "run-orphan",
      "generation-1",
    ),
    false,
  );
  assert.equal(
    persistedChatReferencesSubagentRun(
      [exactReference],
      "run-1",
      "generation-other",
    ),
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

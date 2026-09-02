import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  authoritativeDesignGenerationWorkspaceId,
  authoritativeChatGenerationMode,
  authoritativeChatWorkspaceId,
  persistedChatReferencesSubagentRun,
  persistedChatWorkspaceId,
} from "./chat-workspace-authority.js";
import { DESIGN_PROJECT_CHAT_WORKSPACE_ID } from "../../renderer/shared/design-projects.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";

function designProject(overrides: Partial<DesignProjectSnapshotV1> = {}): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:one",
    revision: 1,
    title: "Prototype",
    chatId: "chat:design",
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 1,
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
    },
    referenceAssetIds: [],
    ...overrides,
  };
}

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

test("Design storage identity stays separate from Prototype and Connected App generation roots", () => {
  assert.equal(
    authoritativeDesignGenerationWorkspaceId(
      DESIGN_PROJECT_CHAT_WORKSPACE_ID,
      undefined,
      "chat:design",
      designProject(),
    ),
    DESIGN_PROJECT_CHAT_WORKSPACE_ID,
  );
  assert.equal(
    authoritativeDesignGenerationWorkspaceId(
      DESIGN_PROJECT_CHAT_WORKSPACE_ID,
      "workspace-2",
      "chat:design",
      designProject({
        connectionState: "connected",
        workspaceId: "workspace-2",
      }),
    ),
    "workspace-2",
  );
});

test("Design generation rejects forged chats, stale renderer roots, and invalid bindings", () => {
  assert.throws(
    () =>
      authoritativeDesignGenerationWorkspaceId(
        "workspace-1",
        undefined,
        "chat:design",
        designProject(),
      ),
    /not a Design Project conversation/u,
  );
  assert.throws(
    () =>
      authoritativeDesignGenerationWorkspaceId(
        DESIGN_PROJECT_CHAT_WORKSPACE_ID,
        undefined,
        "chat:other",
        designProject(),
      ),
    /conversation is unavailable/u,
  );
  assert.throws(
    () =>
      authoritativeDesignGenerationWorkspaceId(
        DESIGN_PROJECT_CHAT_WORKSPACE_ID,
        "workspace-forged",
        "chat:design",
        designProject({ connectionState: "connected", workspaceId: "workspace-2" }),
      ),
    /workspace changed/u,
  );
  assert.throws(
    () =>
      authoritativeDesignGenerationWorkspaceId(
        DESIGN_PROJECT_CHAT_WORKSPACE_ID,
        undefined,
        "chat:design",
        designProject({ connectionState: "connected" }),
      ),
    /binding is invalid/u,
  );
  assert.throws(
    () =>
      authoritativeDesignGenerationWorkspaceId(
        DESIGN_PROJECT_CHAT_WORKSPACE_ID,
        "workspace-2",
        "chat:design",
        designProject({ workspaceId: "workspace-2" }),
      ),
    /binding is invalid/u,
  );
});

test("persisted chat identity is authoritative for attended Assistant mode", () => {
  assert.equal(authoritativeChatGenerationMode("assistant", undefined), "assistant");
  assert.equal(authoritativeChatGenerationMode("assistant", "assistant"), "assistant");
  assert.equal(authoritativeChatGenerationMode("workspace-a", undefined), undefined);
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
    /\{\s*\.\.\.params,\s*workspaceId: generationWorkspaceId,\s*mode: authoritativeMode,?\s*\}/u,
  );
  assert.match(startSource, /authoritativeMode === "assistant"/u);
  assert.doesNotMatch(startSource, /params\.mode\s*===/u);
});

test("generation initialization persists terminal outcomes before releasing ownership", () => {
  const llmClientSource = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const startSource = llmClientSource.slice(llmClientSource.indexOf("export const llmClient"));
  const helperStart = startSource.indexOf(
    "const initializationTerminalState = { attempted: false }",
  );
  const firstCleanup = startSource.indexOf("releaseGenerationSkillReservation(initialization)");
  assert.ok(helperStart >= 0, "terminal persistence helper must be part of generation start");
  assert.ok(
    helperStart < firstCleanup,
    "terminal persistence must be established before an initialization cleanup can run",
  );
  assert.match(llmClientSource, /import \{ persistGenerationInitializationTerminal \}/u);
  assert.match(startSource, /await persistGenerationInitializationTerminal\(\{/u);
  assert.match(
    startSource,
    /append: \(message, meta\) => chatStore\.appendMessage\(params\.chatId, message, meta\)/u,
  );
  assert.match(startSource, /initializing\.get\(streamId\) === initialization/u);
  assert.match(startSource, /active\.get\(streamId\)\?\.owner === owner/u);

  const cancellationPersists = startSource.match(
    /await persistInitializationTerminal\(\s*"cancelled",\s*(?:initialization|activeGeneration)\.cancellationOrigin,?\s*\)/gu,
  );
  const failurePersists = startSource.match(/await persistInitializationTerminal\("failed"\)/gu);
  assert.equal(cancellationPersists?.length, 3);
  assert.equal(failurePersists?.length, 3);

  for (const status of ["cancelled", "failed"] as const) {
    const persistMatch = startSource.match(
      status === "cancelled"
        ? /await persistInitializationTerminal\(\s*"cancelled",\s*(?:initialization|activeGeneration)\.cancellationOrigin,?\s*\)/u
        : /await persistInitializationTerminal\("failed"\)/u,
    );
    const persistIndex = persistMatch?.index ?? -1;
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

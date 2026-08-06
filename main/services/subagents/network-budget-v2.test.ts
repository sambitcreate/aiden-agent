import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentAuthorityV2 } from "./authority-v2.js";
import { SubagentNetworkBudgetV2 } from "./network-budget-v2.js";

function authority(maxNetworkOperations = 2) {
  return createSubagentAuthorityV2({
    grantId: "grant-network",
    treeRootId: "tree-network",
    runId: "run-network",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-network",
    chatId: "chat-network",
    workspaceId: "workspace-network",
    workspaceRevision: "workspace-revision",
    ownerDocumentId: "document-network",
    providerFingerprint: "provider-network",
    modelFingerprint: "model-network",
    contextRevision: "context-network",
    execution: "foreground" as const,
    context: "fresh" as const,
    thinkingLevel: "medium" as const,
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: true,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 1_000,
      maxTurns: 1,
      maxToolCalls: 3,
      maxOutputChars: 1_000,
      maxTokens: 1_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations,
    },
    expiresAt: 2_000,
  });
}

test("web and MCP consumers share one exact per-authority ceiling", () => {
  const budget = new SubagentNetworkBudgetV2();
  const granted = authority(2);
  const consumeWeb = () => budget.consume(granted);
  const consumeMcp = () => budget.consume(granted);
  consumeWeb();
  consumeMcp();
  assert.equal(budget.used(granted), 2);
  assert.throws(consumeWeb, /budget exhausted/u);
  assert.throws(consumeMcp, /budget exhausted/u);
  assert.equal(budget.release(granted), true);
  assert.equal(budget.used(granted), 0);
});

test("revision drift and background authority fail closed", () => {
  const budget = new SubagentNetworkBudgetV2();
  const granted = authority(2);
  budget.consume(granted);
  assert.throws(
    () => budget.consume(createSubagentAuthorityV2({ ...granted, expiresAt: 3_000 })),
    /authority changed/u,
  );
  assert.throws(
    () =>
      budget.consume(
        createSubagentAuthorityV2({
          ...granted,
          grantId: "grant-background",
          runId: "run-background",
          execution: "background",
        }),
      ),
    /foreground-only/u,
  );
});

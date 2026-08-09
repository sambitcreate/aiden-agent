import assert from "node:assert/strict";
import test from "node:test";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { SubagentApprovalLedgerV2 } from "./approval-v2.js";
import {
  createSubagentAuthorityV2,
  subagentMcpEffectProfileFingerprintV2,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import {
  createSubagentOutboundApprovalBrokerV2,
  type SubagentOutboundToolBindingV2,
} from "./outbound-approval-v2.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function authority(
  overrides: Partial<Parameters<typeof createSubagentAuthorityV2>[0]> = {},
): SubagentAuthorityV2 {
  return createSubagentAuthorityV2({
    grantId: "grant-1",
    treeRootId: "tree-1",
    runId: "run-1",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    workspaceRevision: "workspace-revision-1",
    ownerDocumentId: "document-1",
    providerFingerprint: "provider-1",
    modelFingerprint: "model-1",
    contextRevision: "context-1",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "medium",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: true,
      delegation: false,
      mcp: [
        {
          serverId: "docs",
          connectionFingerprint: HASH_A,
          tools: [{ toolName: "search", schemaHash: HASH_B, effect: "read" }],
        },
      ],
    },
    budgets: {
      deadlineMs: 10_000,
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputChars: 4_000,
      maxTokens: 4_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: 2,
    },
    expiresAt: 10_000,
    ...overrides,
  });
}

function call(
  toolName = "web_search",
  args: unknown = { query: "current docs" },
  id = "call-1",
): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id, name: toolName, arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

function webBinding(): SubagentOutboundToolBindingV2 {
  return {
    toolName: "web_search",
    kind: "web",
  };
}

function mcpBinding(
  overrides: Partial<NonNullable<SubagentOutboundToolBindingV2["mcp"]>> = {},
): SubagentOutboundToolBindingV2 {
  return {
    toolName: "mcp_docs_search",
    kind: "mcp",
    mcp: {
      serverId: "docs",
      connectionFingerprint: HASH_A,
      tool: { toolName: "search", schemaHash: HASH_B, effect: "read" },
      ...overrides,
    },
  };
}

test("foreground web pauses on the owner renderer and consumes one exact approval", async () => {
  const granted = authority();
  const prompts: unknown[] = [];
  const owners: string[] = [];
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "ledger-1",
  );
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority: granted,
    childId: "child-1",
    tools: [webBinding()],
    ledger,
    currentAuthority: () => granted,
    requestApproval: async (prompt, _signal, owner) => {
      prompts.push(prompt);
      owners.push(owner);
      return true;
    },
    now: () => 1_000,
  });

  assert.equal(await broker.beforeToolCall(call()), undefined);
  assert.deepEqual(owners, ["document-1"]);
  assert.deepEqual(prompts, [
    {
      streamId: "generation-1",
      toolCallId: "call-1",
      toolName: "web_search",
      summary: 'Search the public web\nQuery: "current docs"\nResults: 5',
    },
  ]);
  assert.equal(ledger.pendingCount, 1);
  broker.consume({
    toolCallId: "call-1",
    toolName: "web_search",
    arguments: { query: "current docs" },
  });
  assert.equal(ledger.pendingCount, 0);
  assert.throws(
    () =>
      broker.consume({
        toolCallId: "call-1",
        toolName: "web_search",
        arguments: { query: "current docs" },
      }),
    /one-shot/u,
  );
  assert.equal(
    await broker.beforeToolCall(call("read_file", { path: "README.md" })),
    undefined,
  );
  assert.equal(prompts.length, 1);
});

test("denial and cancellation block without leaving a reusable grant", async () => {
  const granted = authority();
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "ledger-deny",
  );
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority: granted,
    childId: "child-1",
    tools: [webBinding()],
    ledger,
    currentAuthority: () => granted,
    requestApproval: async () => false,
    now: () => 1_000,
  });
  assert.deepEqual(await broker.beforeToolCall(call()), {
    block: true,
    reason: "The user denied this subagent action.",
  });
  assert.equal(ledger.pendingCount, 0);

  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  assert.deepEqual(
    await broker.beforeToolCall(
      call("web_search", { query: "again" }, "call-2"),
      controller.signal,
    ),
    { block: true, reason: "This subagent action was cancelled." },
  );
  assert.equal(ledger.pendingCount, 0);
});

test("argument mutation, expiry, authority revision drift, and revocation fail closed", async () => {
  let current = authority();
  let clock = 1_000;
  const args = { query: "approved" };
  const mutationBroker = createSubagentOutboundApprovalBrokerV2({
    authority: current,
    childId: "child-1",
    tools: [webBinding()],
    ledger: new SubagentApprovalLedgerV2(
      () => clock,
      () => "ledger-mutation",
    ),
    currentAuthority: () => current,
    requestApproval: async () => {
      args.query = "changed";
      return true;
    },
    now: () => clock,
  });
  assert.match(
    (await mutationBroker.beforeToolCall(call("web_search", args)))?.reason ??
      "",
    /no longer matches/u,
  );

  const original = authority();
  current = original;
  const driftBroker = createSubagentOutboundApprovalBrokerV2({
    authority: original,
    childId: "child-1",
    tools: [webBinding()],
    ledger: new SubagentApprovalLedgerV2(
      () => clock,
      () => "ledger-drift",
    ),
    currentAuthority: () => current,
    requestApproval: async () => {
      current = authority({ authorityRevision: 2 });
      return true;
    },
    now: () => clock,
  });
  assert.match(
    (await driftBroker.beforeToolCall(call()))?.reason ?? "",
    /changed after approval/u,
  );

  current = original;
  const expiryBroker = createSubagentOutboundApprovalBrokerV2({
    authority: original,
    childId: "child-1",
    tools: [webBinding()],
    ledger: new SubagentApprovalLedgerV2(
      () => clock,
      () => "ledger-expiry",
    ),
    currentAuthority: () => current,
    requestApproval: async () => {
      clock = 10_000;
      return true;
    },
    now: () => clock,
  });
  assert.match(
    (await expiryBroker.beforeToolCall(call()))?.reason ?? "",
    /changed after approval/u,
  );

  current = original;
  const revokedBroker = createSubagentOutboundApprovalBrokerV2({
    authority: original,
    childId: "child-1",
    tools: [webBinding()],
    ledger: new SubagentApprovalLedgerV2(
      () => 1_000,
      () => "ledger-revoked",
    ),
    currentAuthority: () => undefined,
    requestApproval: async () => true,
    now: () => 1_000,
  });
  assert.match(
    (await revokedBroker.beforeToolCall(call()))?.reason ?? "",
    /expired or was revoked/u,
  );
});

test("execute-time mutation and replay are blocked after renderer authorization", async () => {
  const granted = authority();
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "ledger-effect",
  );
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority: granted,
    childId: "child-1",
    tools: [webBinding()],
    ledger,
    currentAuthority: () => granted,
    requestApproval: async () => true,
    now: () => 1_000,
  });
  const approvedArgs = { query: "approved" };
  assert.equal(
    await broker.beforeToolCall(
      call("web_search", approvedArgs, "call-effect"),
    ),
    undefined,
  );
  approvedArgs.query = "changed-after-hook";
  assert.throws(
    () =>
      broker.consume({
        toolCallId: "call-effect",
        toolName: "web_search",
        arguments: approvedArgs,
      }),
    /expired, changed, was revoked, or was already used/u,
  );
  assert.throws(
    () =>
      broker.consume({
        toolCallId: "call-effect",
        toolName: "web_search",
        arguments: { query: "approved" },
      }),
    /one-shot/u,
  );
  assert.equal(ledger.pendingCount, 0);
});

test("only exact read MCP bindings under a foreground authority can be assembled", async () => {
  const granted = authority();
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "ledger-mcp",
  );
  const summaries: string[] = [];
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority: granted,
    childId: "child-1",
    tools: [mcpBinding()],
    ledger,
    currentAuthority: () => granted,
    requestApproval: async (prompt) => {
      summaries.push(prompt.summary);
      return true;
    },
    now: () => 1_000,
  });
  assert.equal(
    await broker.beforeToolCall(call("mcp_docs_search", { term: "one" })),
    undefined,
  );
  broker.consume({
    toolCallId: "call-1",
    toolName: "mcp_docs_search",
    arguments: { term: "one" },
  });
  assert.deepEqual(summaries, [
    'Call server-declared read-only MCP tool docs:search\nThe configured server controls the actual effect.\nArguments: {"term":"one"}',
  ]);

  assert.match(
    (
      await broker.beforeToolCall(
        call("mcp_docs_search", { term: "x".repeat(9_000) }, "call-large"),
      )
    )?.reason ?? "",
    /too large to review/u,
  );
  assert.equal(summaries.length, 1);

  assert.throws(
    () =>
      createSubagentOutboundApprovalBrokerV2({
        authority: granted,
        childId: "child-1",
        tools: [
          mcpBinding({
            tool: {
              toolName: "search",
              schemaHash: HASH_B,
              effect: "mutating",
              effectProfile: (() => {
                const profile = {
                  classification: "unproven_mutating" as const,
                  destructive: "unknown" as const,
                  idempotency: "not_declared" as const,
                  openWorld: "unknown" as const,
                  taskSupport: "optional" as const,
                };
                return {
                  ...profile,
                  fingerprint: subagentMcpEffectProfileFingerprintV2(profile),
                };
              })(),
            },
          }),
        ],
        ledger,
        currentAuthority: () => granted,
        requestApproval: async () => true,
      }),
    /exceeds its authority/u,
  );
  assert.throws(
    () =>
      createSubagentOutboundApprovalBrokerV2({
        authority: authority({ execution: "background" }),
        childId: "child-1",
        tools: [webBinding()],
        ledger,
        currentAuthority: () => granted,
        requestApproval: async () => true,
      }),
    /exceeds its authority/u,
  );
});

test("wrong-tool consumption denies the common ledger entry before rejecting", async () => {
  const granted = authority();
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "ledger-wrong-tool",
  );
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority: granted,
    childId: "child-1",
    tools: [webBinding()],
    ledger,
    currentAuthority: () => granted,
    requestApproval: async () => true,
    now: () => 1_000,
  });
  assert.equal(
    await broker.beforeToolCall(call("web_search", { query: "approved" }, "call-wrong-tool")),
    undefined,
  );
  assert.equal(ledger.pendingCount, 1);
  assert.throws(
    () => broker.consume({
      toolCallId: "call-wrong-tool",
      toolName: "mcp_docs_search",
      arguments: { query: "approved" },
    }),
    /one-shot approval/u,
  );
  assert.equal(ledger.pendingCount, 0);
});

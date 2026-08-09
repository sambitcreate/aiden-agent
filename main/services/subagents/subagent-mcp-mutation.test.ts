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
  createSubagentMcpMutationBrokerV2,
  type SubagentMcpMutationBindingV2,
  type SubagentMcpMutationInspectionV2,
  type SubagentMcpMutationJournalV2,
  type SubagentMcpMutationRemoteSessionV2,
} from "./subagent-mcp-mutation.js";

const profileFacts = {
  classification: "declared_mutating" as const,
  destructive: "destructive" as const,
  idempotency: "idempotent" as const,
  openWorld: "open" as const,
  taskSupport: "optional" as const,
};
const effectProfile = {
  ...profileFacts,
  fingerprint: subagentMcpEffectProfileFingerprintV2(profileFacts),
};

const binding: SubagentMcpMutationBindingV2 = {
  childAgentToolName: "mcp_docs_publish",
  serverId: "docs",
  connectionFingerprint: "a".repeat(64),
  tool: {
    toolName: "publish",
    schemaHash: "b".repeat(64),
    effect: "mutating",
    effectProfile,
  },
};

function authority(): SubagentAuthorityV2 {
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
    providerFingerprint: "provider-fingerprint",
    modelFingerprint: "model-fingerprint",
    contextRevision: "context-revision",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "high",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: false,
      delegation: false,
      mcp: [
        {
          serverId: binding.serverId,
          connectionFingerprint: binding.connectionFingerprint,
          tools: [binding.tool],
        },
      ],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 24,
      maxToolCalls: 64,
      maxOutputChars: 120_000,
      maxTokens: 200_000,
      maxLaunches: 8,
      maxDepth: 2,
      maxActive: 4,
      maxQueued: 8,
      maxNetworkOperations: 2,
    },
    expiresAt: 10_000,
  });
}

function inspection(): SubagentMcpMutationInspectionV2 {
  return {
    serverId: binding.serverId,
    connectionFingerprint: binding.connectionFingerprint,
    toolName: binding.tool.toolName,
    schemaHash: binding.tool.schemaHash,
    effectProfile,
    inputSchema: { type: "object", properties: { document: { type: "string" } } },
  };
}

function toolContext(args: unknown = { document: "release" }): BeforeToolCallContext {
  return {
    toolCall: { id: "call-1", name: binding.childAgentToolName },
    args,
  } as unknown as BeforeToolCallContext;
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

interface HarnessOptions {
  requestApproval?: () => Promise<boolean>;
  priorUnknown?: boolean;
  timeoutMs?: number;
  networkAllowed?: boolean;
  inspect?: (session: number, inspection: number) => SubagentMcpMutationInspectionV2;
  dispatch?: (beforeRawBytes: () => void, signal: AbortSignal) => Promise<unknown>;
  redact?: (text: string, session: number) => string;
  failJournal?: string;
}

function harness(
  rawResult: unknown = {
    isError: false,
    content: [{ type: "text", text: "Published." }],
  },
  options: HarnessOptions = {},
) {
  let current = authority();
  let clock = 100;
  let rawCalls = 0;
  let networkCalls = 0;
  let sessionCount = 0;
  let inspectionCount = 0;
  const approvalPrompts: Array<{ details?: unknown }> = [];
  const transitions: string[] = [];
  const journal: SubagentMcpMutationJournalV2 = {
    async prepareEffect() {
      transitions.push("prepared");
      if (options.failJournal === "prepared") throw new Error("persist failed");
    },
    async authorizeEffect() {
      transitions.push("authorized");
      if (options.failJournal === "authorized") throw new Error("persist failed");
    },
    async markEffectDispatchStarted() {
      transitions.push("dispatch_started");
      if (options.failJournal === "dispatch_started") throw new Error("persist failed");
    },
    async cancelEffectBeforeDispatch() {
      transitions.push("cancelled_before_dispatch");
    },
    async finishEffect(value) {
      transitions.push(value.state);
      if (options.failJournal === value.state) throw new Error("persist failed");
    },
  };
  const gate = createSubagentMcpMutationBrokerV2({
    authority: current,
    childId: "child-1",
    childLabel: "Publisher",
    bindings: [binding],
    ledger: new SubagentApprovalLedgerV2(
      () => clock,
      () => "approval-1",
    ),
    journal,
    host: {
      async openFreshSession() {
        sessionCount += 1;
        const sessionIndex = sessionCount;
        const session: SubagentMcpMutationRemoteSessionV2 = {
          async inspect() {
            inspectionCount += 1;
            return options.inspect?.(sessionIndex, inspectionCount) ?? inspection();
          },
          dispatchRaw(_toolName, _args, signal, beforeRawBytes) {
            if (options.dispatch) {
              const dispatched = options.dispatch(beforeRawBytes, signal);
              rawCalls += 1;
              return dispatched;
            }
            beforeRawBytes();
            rawCalls += 1;
            return Promise.resolve(rawResult);
          },
          redactCredentialText(text) {
            return options.redact?.(text, sessionIndex) ?? text;
          },
          async close() {},
        };
        return session;
      },
    },
    currentAuthority: () => current,
    consumeNetworkOperation: () => {
      networkCalls += 1;
      return options.networkAllowed ?? true;
    },
    requestApproval: async (descriptor) => {
      approvalPrompts.push(descriptor);
      return options.requestApproval ? options.requestApproval() : true;
    },
    findPriorUnknownEffect: async () => options.priorUnknown ?? false,
    now: () => clock,
    randomUUID: () => "effect-1",
    timeoutMs: options.timeoutMs,
  });
  return {
    gate,
    transitions,
    approvalPrompts,
    get rawCalls() {
      return rawCalls;
    },
    get networkCalls() {
      return networkCalls;
    },
    get sessionCount() {
      return sessionCount;
    },
    revoke() {
      current = { ...current, authorityRevision: 2 } as SubagentAuthorityV2;
    },
    advanceTo(value: number) {
      clock = value;
    },
  };
}

test("mutation broker durably prepares, authorizes, dispatches once, and completes", async () => {
  const run = harness();
  assert.equal(await run.gate.beforeToolCall(toolContext()), undefined);
  const result = await run.gate.execute({
    toolCallId: "call-1",
    toolName: binding.childAgentToolName,
    arguments: { document: "release" },
  });
  assert.deepEqual(run.transitions, ["prepared", "authorized", "dispatch_started", "completed"]);
  assert.equal(run.rawCalls, 1);
  assert.equal(run.networkCalls, 1);
  assert.equal(run.sessionCount, 3);
  assert.match(firstText(result), /reported that the approved mutation succeeded/u);
});

test("server isError truth is remote_error and never retries", async () => {
  const run = harness({
    isError: true,
    content: [{ type: "text", text: "HTTP 500 after write" }],
  });
  await run.gate.beforeToolCall(toolContext());
  const result = await run.gate.execute({
    toolCallId: "call-1",
    toolName: binding.childAgentToolName,
    arguments: { document: "release" },
  });
  assert.deepEqual(run.transitions.slice(-2), ["dispatch_started", "remote_error"]);
  assert.equal(run.rawCalls, 1);
  assert.match(firstText(result), /may still have partially occurred/u);
});

test("authority drift before dispatch cancels with no remote call", async () => {
  const run = harness();
  await run.gate.beforeToolCall(toolContext());
  run.revoke();
  await assert.rejects(
    run.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /cancelled before/u,
  );
  assert.equal(run.rawCalls, 0);
  assert.equal(run.networkCalls, 0);
  assert.equal(last(run.transitions), "cancelled_before_dispatch");
});

test("denial and pre-dispatch journal failure remain no-effect", async () => {
  const denied = harness(undefined, { requestApproval: async () => false });
  assert.deepEqual(await denied.gate.beforeToolCall(toolContext()), {
    block: true,
    reason: "The user denied this subagent MCP mutation.",
  });
  assert.deepEqual(denied.transitions, ["prepared", "cancelled_before_dispatch"]);
  assert.equal(denied.rawCalls, 0);

  const failed = harness(undefined, { failJournal: "dispatch_started" });
  await failed.gate.beforeToolCall(toolContext());
  await assert.rejects(
    failed.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /cancelled before/u,
  );
  assert.equal(failed.rawCalls, 0);
  assert.equal(failed.networkCalls, 0);
  assert.deepEqual(failed.transitions.slice(-2), ["dispatch_started", "cancelled_before_dispatch"]);
});

test("post-dispatch transport failure and timeout seal unknown without retry", async () => {
  const failed = harness(undefined, {
    dispatch: (beforeRawBytes) => {
      beforeRawBytes();
      return Promise.reject(new Error("HTTP 401 after request bytes"));
    },
  });
  await failed.gate.beforeToolCall(toolContext());
  await assert.rejects(
    failed.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /outcome is unknown/u,
  );
  assert.equal(failed.rawCalls, 1);
  assert.equal(failed.networkCalls, 1);
  assert.equal(last(failed.transitions), "unknown");

  const timedOut = harness(undefined, {
    timeoutMs: 5,
    dispatch: (beforeRawBytes) => {
      beforeRawBytes();
      return new Promise(() => {});
    },
  });
  await timedOut.gate.beforeToolCall(toolContext());
  await assert.rejects(
    timedOut.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /outcome is unknown/u,
  );
  assert.equal(timedOut.rawCalls, 1);
  assert.equal(last(timedOut.transitions), "unknown");
});

test("malformed and oversized post-dispatch responses become unknown", async () => {
  for (const response of [
    { content: [] },
    { isError: "false", content: [] },
    {
      isError: false,
      content: [{ type: "text", text: "x".repeat(256 * 1024) }],
    },
    {
      isError: false,
      content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })),
    },
  ]) {
    const run = harness(response);
    await run.gate.beforeToolCall(toolContext());
    await assert.rejects(
      run.gate.execute({
        toolCallId: "call-1",
        toolName: binding.childAgentToolName,
        arguments: { document: "release" },
      }),
      /outcome is unknown/u,
    );
    assert.equal(run.rawCalls, 1);
    assert.equal(last(run.transitions), "unknown");
  }
});

test("final fence, refreshed credential redaction, and schema drift fail closed", async () => {
  const unfenced = harness(undefined, {
    dispatch: () => Promise.resolve({ isError: false, content: [] }),
  });
  await unfenced.gate.beforeToolCall(toolContext());
  await assert.rejects(
    unfenced.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /outcome is unknown/u,
  );
  assert.equal(unfenced.networkCalls, 0);
  assert.equal(last(unfenced.transitions), "unknown");

  const refreshedCredential = harness(undefined, {
    redact: (text, session) => (session >= 2 ? text.replace("release", "[REDACTED]") : text),
  });
  const refreshedResult = await refreshedCredential.gate.beforeToolCall(toolContext());
  assert.equal(refreshedResult?.block, true);
  assert.equal(refreshedCredential.rawCalls, 0);
  assert.equal(last(refreshedCredential.transitions), "cancelled_before_dispatch");

  const drifted = harness(undefined, {
    inspect: (_session, count) =>
      count === 3 ? { ...inspection(), schemaHash: "c".repeat(64) } : inspection(),
  });
  await drifted.gate.beforeToolCall(toolContext());
  await assert.rejects(
    drifted.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /cancelled before/u,
  );
  assert.equal(drifted.rawCalls, 0);
});

test("terminal persistence failure and shutdown preserve unknown or cancellation", async () => {
  const terminalFailure = harness(undefined, { failJournal: "completed" });
  await terminalFailure.gate.beforeToolCall(toolContext());
  await assert.rejects(
    terminalFailure.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /outcome is unknown/u,
  );
  assert.equal(terminalFailure.rawCalls, 1);
  assert.deepEqual(terminalFailure.transitions.slice(-2), ["completed", "unknown"]);

  const shuttingDown = harness();
  await shuttingDown.gate.beforeToolCall(toolContext());
  await shuttingDown.gate.shutdown();
  assert.equal(shuttingDown.rawCalls, 0);
  assert.equal(last(shuttingDown.transitions), "cancelled_before_dispatch");
});

test("exact prior-unknown lookup changes the fresh approval copy without automatic dispatch", async () => {
  const run = harness(undefined, { priorUnknown: true });
  assert.equal(await run.gate.beforeToolCall(toolContext()), undefined);
  const details = run.approvalPrompts[0]?.details as
    | { kind?: unknown; priorUnknownEffect?: unknown }
    | undefined;
  assert.equal(details?.kind, "subagent-mcp-mutation");
  assert.equal(details?.priorUnknownEffect, true);
  assert.equal(run.rawCalls, 0);
  assert.deepEqual(run.transitions, ["prepared", "authorized"]);
  await run.gate.shutdown();
  assert.equal(last(run.transitions), "cancelled_before_dispatch");
});

test("wrong alias, expiry, and replay never gain a second dispatch", async () => {
  const aliased = harness();
  await aliased.gate.beforeToolCall(toolContext());
  await assert.rejects(
    aliased.gate.execute({
      toolCallId: "call-1",
      toolName: "docs__other_alias",
      arguments: { document: "release" },
    }),
    /no live one-shot approval/u,
  );
  assert.equal(aliased.rawCalls, 0);

  const expired = harness();
  await expired.gate.beforeToolCall(toolContext());
  expired.advanceTo(10_000);
  await assert.rejects(
    expired.gate.execute({
      toolCallId: "call-1",
      toolName: binding.childAgentToolName,
      arguments: { document: "release" },
    }),
    /cancelled before/u,
  );
  assert.equal(expired.rawCalls, 0);

  const replayed = harness();
  await replayed.gate.beforeToolCall(toolContext());
  const exact = {
    toolCallId: "call-1",
    toolName: binding.childAgentToolName,
    arguments: { document: "release" },
  };
  await replayed.gate.execute(exact);
  await assert.rejects(replayed.gate.execute(exact), /no live one-shot approval/u);
  assert.equal(replayed.rawCalls, 1);
});

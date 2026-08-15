import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { appendPiMessages } from "../pi-compaction-session-store.js";
import { SubagentApprovalLedgerV2 } from "./approval-v2.js";
import { createSubagentAuthorityV2 } from "./authority-v2.js";
import {
  SubagentRuntimeRegistry,
  type SubagentRuntimeAuthority,
  type SubagentRuntimeChild,
} from "./child-agent-runtime.js";
import { SubagentConcurrencyGate } from "./concurrency-gate.js";
import {
  assertSubagentHistoryEnabled,
  registerSubagentTool,
  subagentChildMcpEnabled,
  subagentChildMcpMutationsEnabled,
  subagentChildDelegationEnabled,
  subagentChildShellEnabled,
  subagentChildWriteEnabled,
  subagentChildWebEnabled,
  SUBAGENT_HISTORY_DISABLED_ERROR,
  subagentsEnabled,
} from "./feature-flag.js";
import { createSubagentOutboundApprovalBrokerV2 } from "./outbound-approval-v2.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function semanticCheckpointSummary(label: string): string {
  return `## Goal\n${label}\n\n## Constraints & Preferences\n- none\n\n## Progress\n### Done\n- [x] preserved state\n\n### In Progress\n- [ ] continue\n\n### Blocked\n- none\n\n## Key Decisions\n- preserve continuity\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- ${label}`;
}

function deferred<T = void>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function providerMessage(
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  content = "",
): AssistantMessage {
  return {
    role: "assistant",
    content: content ? [{ type: "text", text: content }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: stopReason === "aborted" ? "Request was aborted" : undefined,
    timestamp: Date.now(),
  };
}

function runtimeFrom(
  model: Model<Api>,
  streamSimple: ResolvedModelRuntime["streams"]["streamSimple"],
  options: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    deployment?: "hosted" | "local";
  } = {},
): ResolvedModelRuntime {
  return {
    provider: {
      id: model.provider,
      kind: "openai",
      label: "Compatibility provider",
      baseUrl: model.baseUrl,
      models: [model.id],
      needsKey: Boolean(options.apiKey),
      deployment: options.deployment ?? "hosted",
    },
    model,
    apiKey: options.apiKey,
    headers: options.headers,
    streams: { streamSimple },
  };
}

function child(
  registry: SubagentRuntimeRegistry,
  runtime: ResolvedModelRuntime,
  tools: AgentTool[] = [],
  authority: SubagentRuntimeAuthority = {
    generationId: "compatibility-generation",
    chatId: "compatibility-chat",
    workspaceId: "compatibility-workspace",
  },
): SubagentRuntimeChild {
  return registry.create({
    authority,
    groupId: "compatibility",
    runtime,
    thinkingLevel: "high",
    systemPrompt: "Complete one bounded child task.",
    tools,
  });
}

test("subagents default on after rollout and explicit rollback never constructs the tool", () => {
  assert.equal(subagentsEnabled({}), true);
  assert.equal(subagentsEnabled({ AIDEN_SUBAGENTS_ENABLED: "1" }), true);
  assert.equal(subagentsEnabled({ AIDEN_SUBAGENTS_ENABLED: " 0 " }), false);
  const tools: AgentTool[] = [];
  let constructions = 0;
  const createTool = () => {
    constructions += 1;
    return {
      name: "subagent",
      label: "Subagent",
      description: "Delegate bounded work.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: null,
      }),
    };
  };
  registerSubagentTool(tools, createTool, { AIDEN_SUBAGENTS_ENABLED: "0" });
  assert.equal(constructions, 0);
  assert.equal(tools.length, 0);
  assert.throws(
    () => registerSubagentTool(tools, undefined, {}),
    /construction is unavailable/,
  );
  registerSubagentTool(tools, createTool, {});
  assert.equal(constructions, 1);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["subagent"],
  );
});

test("child web, MCP mutation, and write rollouts are independent, default-on, and subordinate to V2", () => {
  const combinations = [
    [{}, true, true, true, true],
    [{ AIDEN_SUBAGENT_CHILD_WEB_ENABLED: "0" }, false, true, true, true],
    [{ AIDEN_SUBAGENT_CHILD_MCP_ENABLED: "0" }, true, false, false, true],
    [
      { AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED: "0" },
      true,
      true,
      false,
      true,
    ],
    [{ AIDEN_SUBAGENT_CHILD_WRITE_ENABLED: "0" }, true, true, true, false],
    [
      {
        AIDEN_SUBAGENT_CHILD_WEB_ENABLED: "0",
        AIDEN_SUBAGENT_CHILD_MCP_ENABLED: "0",
        AIDEN_SUBAGENT_CHILD_WRITE_ENABLED: "0",
      },
      false,
      false,
      false,
      false,
    ],
  ] as const;
  for (const [environment, web, mcp, mutations, write] of combinations) {
    assert.equal(subagentChildWebEnabled(environment), web);
    assert.equal(subagentChildMcpEnabled(environment), mcp);
    assert.equal(subagentChildMcpMutationsEnabled(environment), mutations);
    assert.equal(subagentChildWriteEnabled(environment), write);
  }
  assert.equal(
    subagentChildMcpMutationsEnabled({
      AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED: "1",
    }),
    true,
  );
  assert.equal(
    subagentChildMcpMutationsEnabled({
      AIDEN_SUBAGENT_CHILD_MCP_ENABLED: "0",
      AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED: "1",
    }),
    false,
  );
  for (const environment of [
    { AIDEN_SUBAGENTS_ENABLED: "0" },
    { AIDEN_SUBAGENTS_V2_ENABLED: "0" },
  ]) {
    assert.equal(subagentChildWebEnabled(environment), false);
    assert.equal(subagentChildMcpEnabled(environment), false);
    assert.equal(subagentChildWriteEnabled(environment), false);
    assert.equal(
      subagentChildMcpMutationsEnabled({
        ...environment,
        AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED: "1",
      }),
      false,
    );
  }
});

test("child shell rollout is default-on, independently reversible, and subordinate to V2", () => {
  assert.equal(subagentChildShellEnabled({}), true);
  assert.equal(
    subagentChildShellEnabled({ AIDEN_SUBAGENT_CHILD_SHELL_ENABLED: "0" }),
    false,
  );
  assert.equal(
    subagentChildShellEnabled({ AIDEN_SUBAGENTS_V2_ENABLED: "0" }),
    false,
  );
});

test("child delegation rollout is default-on, exact-zero reversible, and subordinate to V2", () => {
  assert.equal(subagentChildDelegationEnabled({}), true);
  assert.equal(
    subagentChildDelegationEnabled({
      AIDEN_SUBAGENT_CHILD_DELEGATION_ENABLED: "0",
    }),
    false,
  );
  assert.equal(
    subagentChildDelegationEnabled({
      AIDEN_SUBAGENT_CHILD_DELEGATION_ENABLED: " 0 ",
    }),
    false,
  );
  assert.equal(
    subagentChildDelegationEnabled({
      AIDEN_SUBAGENT_CHILD_DELEGATION_ENABLED: "false",
    }),
    true,
  );
  assert.equal(
    subagentChildDelegationEnabled({ AIDEN_SUBAGENTS_V2_ENABLED: "0" }),
    false,
  );
  assert.equal(
    subagentChildDelegationEnabled({ AIDEN_SUBAGENTS_ENABLED: "0" }),
    false,
  );
});

test("disabled history requests fail with a stable error before any read can begin", () => {
  assert.throws(
    () => assertSubagentHistoryEnabled({ AIDEN_SUBAGENTS_ENABLED: "0" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === SUBAGENT_HISTORY_DISABLED_ERROR,
  );
  assert.doesNotThrow(() => assertSubagentHistoryEnabled({}));
});

test("production tool assembly reaches the feature-gated lazy factory", async () => {
  const source = await readFile(
    new URL("../tools.ts", import.meta.url),
    "utf-8",
  );
  const builderStart = source.indexOf("export async function buildAgentTools");
  const registrationStart = source.indexOf(
    "registerSubagentTool(tools, ctx.createSubagentTool);",
    builderStart,
  );
  const builderEnd = source.indexOf("\n}", registrationStart);

  assert.ok(builderStart >= 0);
  assert.ok(registrationStart > builderStart);
  assert.ok(builderEnd > registrationStart);
});

test("production generation carries parent read-tool exclusions into child capability assembly", async () => {
  const [
    generationSource,
    childRuntimeSource,
    assemblySource,
    chatHandlerSource,
  ] = await Promise.all([
    readFile(new URL("../llm-client.ts", import.meta.url), "utf-8"),
    readFile(new URL("./subagent-child-runtime.ts", import.meta.url), "utf-8"),
    readFile(new URL("./subagent-tool-assembly.ts", import.meta.url), "utf-8"),
    readFile(new URL("../../handlers/chat.ts", import.meta.url), "utf-8"),
  ]);
  assert.match(
    generationSource,
    /inheritedCeiling:\s*inheritedSubagentReadToolCeiling\(\s*options\.excludeToolNames,?\s*\)/u,
  );
  assert.match(
    childRuntimeSource,
    /buildProductionSubagentChildTools\(\s*\{[\s\S]*\.\.\.toolInput,[\s\S]*signal: input\.signal,[\s\S]*mcpMutationsEnabled/u,
  );
  assert.match(
    assemblySource,
    /capabilityProfile:\s*\{\s*kind: "subagent",\s*role: input\.role,\s*inheritedCeiling: input\.inheritedCeiling,/,
  );
  assert.match(
    chatHandlerSource,
    /allowSubagents: true,\s*usageSource: "chat",/,
  );
});

test("production V2 control registration is reachable only through the canonical store selection", async () => {
  const source = await readFile(
    new URL("../llm-client.ts", import.meta.url),
    "utf-8",
  );
  assert.match(
    source,
    /control:\s*subagentRunStore\.selection === "v2"\s*\? subagentControlMainV2\s*: undefined/u,
  );
  assert.match(source, /prepareRun: subagentPersistence\?\.prepareRun/u);
  assert.match(source, /applyControlSnapshot: \(snapshot\) =>/u);
  assert.match(source, /settleControlSnapshots: \(\) =>/u);
  assert.match(source, /onControlSnapshot: async \(snapshot\) =>/u);
});

test("production V1 rollback rejects fork before reading persisted conversation", async () => {
  const source = await readFile(
    new URL("../llm-client.ts", import.meta.url),
    "utf-8",
  );
  const loader = source.indexOf("loadPersistedChatForFork: async");
  const rollbackGuard = source.indexOf(
    'subagentRunStore.selection !== "v2"',
    loader,
  );
  const chatRead = source.indexOf("chatStore.get(params.chatId)", loader);
  assert.ok(loader >= 0);
  assert.ok(rollbackGuard > loader);
  assert.ok(chatRead > rollbackGuard);
  assert.match(
    source.slice(rollbackGuard, chatRead),
    /Forked subagent context is unavailable during V1 rollback/u,
  );
});

test("Aiden child factory shares its resolved transport while generating isolated sessions", async () => {
  await within("shared transport compatibility", async () => {
    const allStarted = deferred();
    const release = deferred();
    const sessions = new Set<string>();
    let active = 0;
    let peak = 0;
    const core = createFauxCore({
      provider: "aiden-compat-hosted",
      models: [{ id: "compat-hosted" }],
    });
    core.setResponses(
      Array.from({ length: 3 }, () => async (_context, options) => {
        assert.equal(options?.apiKey, "resolved-secret");
        assert.deepEqual(options?.headers, {
          "X-Caller": "caller",
          Authorization: null,
          "X-Resolved": "yes",
        });
        assert.ok(options?.sessionId);
        sessions.add(options.sessionId);
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) allStarted.resolve();
        await release.promise;
        active -= 1;
        return fauxAssistantMessage("complete");
      }),
    );
    const runtime = runtimeFrom(
      core.getModel() as Model<Api>,
      core.streamSimple,
      {
        apiKey: "resolved-secret",
        headers: { Authorization: null, "X-Resolved": "yes" },
      },
    );
    const originalStream = runtime.streams.streamSimple;
    runtime.streams.streamSimple = (model, context, options) =>
      originalStream(model, context, {
        ...options,
        headers: { "X-Caller": "caller", ...options?.headers },
      });
    const registry = new SubagentRuntimeRegistry();
    const children = Array.from({ length: 3 }, () => child(registry, runtime));
    assert.ok(
      children.every((entry) => entry.agent.state.thinkingLevel === "high"),
    );
    assert.equal(new Set(children.map((entry) => entry.childId)).size, 3);
    assert.equal(new Set(children.map((entry) => entry.sessionId)).size, 3);
    const prompts = children.map((entry) =>
      entry.prompt("Inspect one independent concern."),
    );
    await allStarted.promise;
    assert.equal(core.state.callCount, 2);
    release.resolve();
    await Promise.all(prompts);

    assert.equal(peak, 2);
    assert.equal(sessions.size, 3);
    assert.equal(registry.activeCount, 0);
  });
});

test("child runner resets retry failures and treats length stops as terminal failures", async () => {
  const source = await readFile(
    new URL("./subagent-child-runner.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /message_start[\s\S]{0,220}terminalError = null;[\s\S]{0,80}terminalAborted = false;/u,
  );
  assert.match(source, /terminalGenerationLengthError\(message\)/u);
  assert.match(source, /const exactOutput = terminalAssistantText\(message\)/u);
});

test("real Agent approval hook authorizes and consumes one exact outbound effect", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-approval",
    models: [{ id: "compat-approval" }],
  });
  core.setResponses([
    fauxAssistantMessage(
      fauxToolCall("approved_effect", { query: "exact approved query" }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("done"),
  ]);
  const authority = createSubagentAuthorityV2({
    grantId: "grant-approval",
    treeRootId: "tree-approval",
    runId: "run-approval",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-approval",
    chatId: "chat-approval",
    workspaceId: "workspace-approval",
    workspaceRevision: "workspace-revision-approval",
    ownerDocumentId: "document-approval",
    providerFingerprint: "provider-approval",
    modelFingerprint: "model-approval",
    contextRevision: "context-approval",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "high",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: true,
      delegation: false,
      mcp: [],
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
      maxNetworkOperations: 1,
    },
    expiresAt: 10_000,
  });
  const ledger = new SubagentApprovalLedgerV2(
    () => 1_000,
    () => "approval-agent-integration",
  );
  const prompts: string[] = [];
  const broker = createSubagentOutboundApprovalBrokerV2({
    authority,
    childId: "child-approval",
    tools: [{ toolName: "approved_effect", kind: "web" }],
    ledger,
    currentAuthority: () => authority,
    requestApproval: async (prompt) => {
      prompts.push(prompt.summary);
      return true;
    },
    now: () => 1_000,
  });
  const effects: unknown[] = [];
  const approvedEffect: AgentTool = {
    name: "approved_effect",
    label: "Approved effect",
    description: "Exercises the real child Agent approval-to-effect path.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (toolCallId, args) => {
      broker.consume({
        toolCallId,
        toolName: "approved_effect",
        arguments: args,
      });
      effects.push(args);
      return {
        content: [{ type: "text", text: "effect complete" }],
        details: null,
      };
    },
  };
  const registry = new SubagentRuntimeRegistry();
  const runningChild = registry.create({
    authority,
    groupId: "approval-integration",
    childId: "child-approval",
    runtime: runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
    thinkingLevel: "high",
    systemPrompt: "Exercise one approved effect.",
    tools: [approvedEffect],
    beforeToolCall: broker.beforeToolCall,
  });

  await runningChild.prompt("Run the approved effect once.");

  assert.equal(core.state.callCount, 2);
  assert.deepEqual(prompts, [
    'Search the public web\nQuery: "exact approved query"\nResults: 5',
  ]);
  assert.deepEqual(effects, [{ query: "exact approved query" }]);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(registry.activeCount, 0);
});

test("child semantically compacts oversized tool output before the next provider call", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-context",
    models: [{ id: "compat-context", contextWindow: 8_192 }],
  });
  let secondContext = "";
  let continuationContext = "";
  const respondAfterTool = async (context: unknown) => {
    const serialized = JSON.stringify(context);
    if (/context summarization assistant/u.test(serialized)) {
      if (/PREFIX of a turn/u.test(serialized)) {
        return fauxAssistantMessage(
          "## Original Request\nRead the oversized payload.\n\n## Early Progress\n- Read completed into a semantic history checkpoint.\n\n## Context for Suffix\n- Continue from bounded evidence.",
        );
      }
      return fauxAssistantMessage(
        semanticCheckpointSummary("semantic history checkpoint"),
      );
    }
    if (/Continue from the compacted checkpoint/u.test(serialized)) {
      continuationContext = serialized;
      return fauxAssistantMessage("continued from checkpoint");
    }
    secondContext = serialized;
    return fauxAssistantMessage("bounded");
  };
  core.setResponses([
    fauxAssistantMessage(fauxToolCall("oversized_read", {}), {
      stopReason: "toolUse",
    }),
    ...Array.from({ length: 64 }, () => respondAfterTool),
  ]);
  const oversizedRead: AgentTool = {
    name: "oversized_read",
    label: "Oversized read",
    description: "Returns a deliberately oversized compatibility payload.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: `START-${"x".repeat(200_000)}-END` }],
      details: null,
    }),
  };
  const registry = new SubagentRuntimeRegistry();
  const runningChild = child(
    registry,
    runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
    [oversizedRead],
  );
  let preparationCalls = 0;
  let preparationCompacted = false;
  const prepare = runningChild.agent.prepareNextTurnWithContext;
  runningChild.agent.prepareNextTurnWithContext = async (value, signal) => {
    preparationCalls += 1;
    const prepared = await prepare?.(value, signal);
    preparationCompacted ||=
      prepared?.context?.messages[0]?.role === "compactionSummary";
    return prepared;
  };

  await runningChild.prompt("Read the oversized payload, then conclude.");
  await runningChild.agent.prompt("Continue from the compacted checkpoint.");

  assert.ok(preparationCalls > 0);
  assert.equal(preparationCompacted, true);
  assert.ok(core.state.callCount >= 4);
  assert.match(secondContext, /semantic history checkpoint/u);
  assert.doesNotMatch(secondContext, /START-x{1000}/u);
  assert.ok(secondContext.length < 100_000);
  assert.equal(runningChild.agent.state.messages[0]?.role, "compactionSummary");
  assert.match(
    continuationContext,
    /conversation history.*compacted.*summary/isu,
  );
  assert.match(continuationContext, /semantic history checkpoint/u);
  assert.equal(registry.activeCount, 0);
});

test("child completion survives a Pi journal append failure", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-journal-resilience",
    models: [{ id: "compat-journal-resilience", contextWindow: 8_192 }],
  });
  core.setResponses([
    fauxAssistantMessage("completed despite journal failure"),
  ]);
  const journalErrors: unknown[] = [];
  let failedAssistantBatch = false;
  const registry = new SubagentRuntimeRegistry(undefined, undefined, {
    appendPiMessages: async (session, messages, visibleChatMessageId) => {
      if (
        !failedAssistantBatch &&
        messages.some((message) => message.role === "assistant")
      ) {
        failedAssistantBatch = true;
        throw new Error("injected child journal failure");
      }
      await appendPiMessages(session, messages, visibleChatMessageId);
    },
    onPiJournalError: (error) => journalErrors.push(error),
  });
  const runningChild = child(
    registry,
    runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
  );

  await assert.doesNotReject(
    runningChild.prompt(
      "Complete even if the in-memory journal cannot append.",
    ),
  );

  assert.equal(core.state.callCount, 1);
  assert.equal(failedAssistantBatch, true);
  assert.equal(journalErrors.length, 1);
  assert.match(
    JSON.stringify(runningChild.agent.state.messages),
    /completed despite journal failure/u,
  );
  assert.equal(registry.activeCount, 0);
});

test("forked initial context is compacted before the first provider request", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-initial-fork",
    models: [{ id: "compat-initial-fork", contextWindow: 8_192 }],
  });
  let firstContext = "";
  const respond = async (context: unknown) => {
    const serialized = JSON.stringify(context);
    if (/context summarization assistant/u.test(serialized)) {
      return fauxAssistantMessage(
        semanticCheckpointSummary("semantic checkpoint"),
      );
    }
    firstContext = JSON.stringify(context);
    return fauxAssistantMessage("bounded");
  };
  core.setResponses(Array.from({ length: 64 }, () => respond));
  const registry = new SubagentRuntimeRegistry();
  const modelRuntime = runtimeFrom(
    core.getModel() as Model<Api>,
    core.streamSimple,
  );
  const runningChild = registry.create({
    authority: {
      generationId: "compatibility-generation",
      chatId: "compatibility-chat",
      workspaceId: "compatibility-workspace",
    },
    groupId: "compatibility-fork",
    runtime: modelRuntime,
    thinkingLevel: "high",
    systemPrompt: "Complete one bounded child task.",
    tools: [],
    initialMessages: [
      {
        role: "user",
        content: `FORK-START-${"x".repeat(200_000)}-FORK-END`,
        timestamp: 1,
      },
    ],
  });

  await runningChild.prompt("Conclude from the forked conversation.");

  assert.ok(core.state.callCount > 2);
  assert.doesNotMatch(firstContext, /FORK-START|FORK-END/u);
  assert.match(firstContext, /Conclude from the forked conversation/u);
  assert.ok(firstContext.length < 100_000);
  assert.equal(registry.activeCount, 0);
});

test("runtime registry rejects app-wide child overflow before allocating another Agent", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-registry-cap",
    models: [{ id: "compat-registry-cap" }],
  });
  const runtime = runtimeFrom(core.getModel() as Model<Api>, core.streamSimple);
  const registry = new SubagentRuntimeRegistry(undefined, 2);
  const first = child(registry, runtime);
  const second = child(registry, runtime);

  assert.equal(registry.activeCount, 2);
  assert.throws(
    () => child(registry, runtime),
    /app-wide subagent runtime limit/u,
  );
  assert.equal(registry.activeCount, 2);

  first.cancel();
  second.cancel();
  assert.equal(await registry.shutdown(100), true);
  assert.equal(registry.activeCount, 0);
});

test("concurrency gate rejects queue overflow and releases the admitted waiter", async () => {
  const gate = new SubagentConcurrencyGate({ hosted: 1, local: 1 }, 1);
  const releaseActive = await gate.acquire("hosted");
  const queued = gate.acquire("hosted");

  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 1);
  await assert.rejects(
    gate.acquire("hosted"),
    /app-wide subagent queue limit/u,
  );

  releaseActive();
  const releaseQueued = await queued;
  assert.equal(gate.activeCount, 1);
  assert.equal(gate.queuedCount, 0);
  releaseQueued();
  assert.equal(gate.activeCount, 0);
});

test("provider response marks a child only after Pi crosses the actual request boundary", async () => {
  await within("provider abort compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-provider-abort",
      name: "Compatibility provider abort",
      api: "openai-completions",
      provider: "aiden-compat-provider-abort",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const deltaReached = deferred();
    let abortListeners = 0;
    const streamSimple = (
      requestModel: Model<Api>,
      _context: unknown,
      options?: SimpleStreamOptions,
    ) => {
      const stream = createAssistantMessageEventStream();
      void options?.onResponse?.({ status: 200, headers: {} }, requestModel);
      const partial = providerMessage(requestModel, "stop", "partial");
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...partial, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial,
        });
        deltaReached.resolve();
      });
      const onAbort = () => {
        options?.signal?.removeEventListener("abort", onAbort);
        abortListeners -= 1;
        const aborted = providerMessage(requestModel, "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      abortListeners += 1;
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      return stream;
    };
    const registry = new SubagentRuntimeRegistry();
    const runningChild = child(registry, runtimeFrom(model, streamSimple));
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), false);
    const prompt = runningChild.prompt("Wait until cancelled.");
    await deltaReached.promise;
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), true);
    runningChild.cancel();
    await prompt;

    const terminal =
      runningChild.agent.state.messages[
        runningChild.agent.state.messages.length - 1
      ];
    assert.equal(
      terminal?.role === "assistant" ? terminal.stopReason : undefined,
      "aborted",
    );
    assert.equal(abortListeners, 0);
    assert.equal(runningChild.agent.signal, undefined);
    assert.equal(registry.activeCount, 0);
    assert.equal(registry.hasChatProviderResponse("compatibility-chat"), false);
  });
});

test("tool abort settles a genuinely running signal-aware tool", async () => {
  await within("tool abort compatibility", async () => {
    const toolStarted = deferred();
    let abortListeners = 0;
    const blockingTool: AgentTool = {
      name: "blocking_read",
      label: "Blocking read",
      description: "Compatibility-only blocking read.",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        toolStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            abortListeners -= 1;
            reject(signal?.reason ?? new Error("Tool cancelled."));
          };
          abortListeners += 1;
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        return {
          content: [{ type: "text", text: "unexpected" }],
          details: null,
        };
      },
    };
    const core = createFauxCore({
      provider: "aiden-compat-tool-abort",
      models: [{ id: "compat-tool-abort" }],
    });
    core.setResponses([
      fauxAssistantMessage(fauxToolCall("blocking_read", {}), {
        stopReason: "toolUse",
      }),
    ]);
    const runtime = runtimeFrom(
      core.getModel() as Model<Api>,
      core.streamSimple,
    );
    const registry = new SubagentRuntimeRegistry();
    const runningChild = child(registry, runtime, [blockingTool]);
    const prompt = runningChild.prompt("Use the blocking read.");
    await toolStarted.promise;
    runningChild.cancel();
    await prompt;

    assert.equal(abortListeners, 0);
    assert.equal(runningChild.agent.state.pendingToolCalls.size, 0);
    assert.equal(runningChild.agent.signal, undefined);
    assert.equal(registry.activeCount, 0);
  });
});

test("runtime registry enforces local concurrency at one", async () => {
  await within("local concurrency compatibility", async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let active = 0;
    let peak = 0;
    const core = createFauxCore({
      provider: "aiden-compat-local",
      models: [{ id: "compat-local" }],
    });
    core.setResponses([
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        firstStarted.resolve();
        await releaseFirst.promise;
        active -= 1;
        return fauxAssistantMessage("first");
      },
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        secondStarted.resolve();
        await releaseSecond.promise;
        active -= 1;
        return fauxAssistantMessage("second");
      },
    ]);
    const runtime = runtimeFrom(
      core.getModel() as Model<Api>,
      core.streamSimple,
      {
        deployment: "local",
      },
    );
    const recordedConcurrency: number[] = [];
    const registry = new SubagentRuntimeRegistry({
      started: (activeConcurrency) =>
        recordedConcurrency.push(activeConcurrency),
      terminal: () => {},
      cleanupFailed: () => {},
    });
    const children = [child(registry, runtime), child(registry, runtime)];
    const prompts = children.map((entry) => entry.prompt("Run locally."));
    await firstStarted.promise;
    assert.equal(core.state.callCount, 1);
    releaseFirst.resolve();
    await secondStarted.promise;
    releaseSecond.resolve();
    await Promise.all(prompts);

    assert.equal(peak, 1);
    assert.deepEqual(recordedConcurrency, [1, 1]);
    assert.equal(registry.activeCount, 0);
  });
});

test("depth-1 child yields the real local inference lease while awaiting a depth-2 child", async () => {
  await within("local nested inference lease yield", async () => {
    const core = createFauxCore({
      provider: "aiden-compat-local-nested",
      models: [{ id: "compat-local-nested" }],
    });
    core.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate_nested", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("nested complete"),
      fauxAssistantMessage("parent complete"),
    ]);
    const runtime = runtimeFrom(
      core.getModel() as Model<Api>,
      core.streamSimple,
      {
        deployment: "local",
      },
    );
    const registry = new SubagentRuntimeRegistry();
    const nested = child(registry, runtime);
    let parent: SubagentRuntimeChild | undefined;
    const nestedTool: AgentTool = {
      name: "delegate_nested",
      label: "Delegate nested",
      description:
        "Wait for one nested local child without retaining inference capacity.",
      parameters: Type.Object({}),
      execute: async () => {
        const yieldInference = parent?.withoutInferenceLease;
        assert.ok(yieldInference);
        await yieldInference(() =>
          nested.prompt("Complete the nested local task."),
        );
        return {
          content: [{ type: "text", text: "nested result accepted" }],
          details: null,
        };
      },
    };
    parent = child(registry, runtime, [nestedTool]);

    await parent.prompt("Delegate once, then conclude.");

    assert.equal(core.state.callCount, 3);
    assert.equal(registry.activeCount, 0);
  });
});

test("cancelling a queued child cannot start provider work later", async () => {
  await within("queued child cancellation", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const core = createFauxCore({
      provider: "aiden-compat-queued-cancel",
      models: [{ id: "compat-queued-cancel" }],
    });
    core.setResponses([
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("cancelled child must not reach this response"),
    ]);
    const runtime = runtimeFrom(
      core.getModel() as Model<Api>,
      core.streamSimple,
      {
        deployment: "local",
      },
    );
    const recordedConcurrency: number[] = [];
    const registry = new SubagentRuntimeRegistry({
      started: (activeConcurrency) =>
        recordedConcurrency.push(activeConcurrency),
      terminal: () => {},
      cleanupFailed: () => {},
    });
    const first = child(registry, runtime);
    const queued = child(registry, runtime);
    const firstPrompt = first.prompt("Hold the local slot.");
    const queuedPrompt = queued.prompt("Do not start after cancellation.");
    await firstStarted.promise;
    queued.cancel();
    const cancelled = assert.rejects(queuedPrompt, /Subagent task cancelled/);
    releaseFirst.resolve();
    await Promise.all([firstPrompt, cancelled]);

    assert.equal(core.state.callCount, 1);
    assert.deepEqual(recordedConcurrency, [1]);
    assert.equal(registry.activeCount, 0);
  });
});

test("cancelling a child before prompt prevents all provider work", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-pre-cancel",
    models: [{ id: "compat-pre-cancel" }],
  });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const registry = new SubagentRuntimeRegistry();
  const cancelled = child(
    registry,
    runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
  );
  cancelled.cancel();

  await assert.rejects(
    cancelled.prompt("Never start."),
    /Subagent task cancelled/,
  );
  assert.equal(core.state.callCount, 0);
  assert.equal(registry.activeCount, 0);
});

test("registry shutdown aborts every child and leaves no active Agent state", async () => {
  await within("subagent shutdown compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-shutdown",
      name: "Compatibility shutdown",
      api: "openai-completions",
      provider: "aiden-compat-shutdown",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const started = deferred();
    let live = 0;
    const streamSimple: ResolvedModelRuntime["streams"]["streamSimple"] = (
      requestModel,
      _context,
      options,
    ) => {
      const stream = createAssistantMessageEventStream();
      live += 1;
      if (live === 2) started.resolve();
      const onAbort = () => {
        options?.signal?.removeEventListener("abort", onAbort);
        live -= 1;
        const aborted = providerMessage(requestModel, "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      return stream;
    };
    const registry = new SubagentRuntimeRegistry();
    const children = [
      child(registry, runtimeFrom(model, streamSimple)),
      child(registry, runtimeFrom(model, streamSimple)),
    ];
    const prompts = children.map((entry) => entry.prompt("Wait for shutdown."));
    await started.promise;
    assert.equal(await registry.shutdown(500), true);
    await Promise.all(prompts);

    assert.equal(live, 0);
    assert.equal(registry.activeCount, 0);
    for (const entry of children) {
      assert.equal(entry.agent.state.isStreaming, false);
      assert.equal(entry.agent.state.pendingToolCalls.size, 0);
      assert.equal(entry.agent.signal, undefined);
      assert.deepEqual(entry.agent.state.messages, []);
    }
  });
});

test("shutdown rejects a child that was created but had not started", async () => {
  const core = createFauxCore({
    provider: "aiden-compat-late-start",
    models: [{ id: "compat-late-start" }],
  });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const registry = new SubagentRuntimeRegistry();
  const pendingChild = child(
    registry,
    runtimeFrom(core.getModel() as Model<Api>, core.streamSimple),
  );

  assert.equal(await registry.shutdown(100), true);
  await assert.rejects(
    pendingChild.prompt("Start after shutdown."),
    /Subagent runtime is shutting down/,
  );
  assert.equal(core.state.callCount, 0);
  assert.equal(registry.activeCount, 0);
});

test("shutdown timeout preserves ownership until non-cooperative work actually settles", async () => {
  await within("non-cooperative shutdown compatibility", async () => {
    const model: Model<Api> = {
      id: "compat-non-cooperative",
      name: "Compatibility non-cooperative",
      api: "openai-completions",
      provider: "aiden-compat-non-cooperative",
      baseUrl: "https://compat.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const started = deferred();
    const release = deferred();
    const streamSimple: ResolvedModelRuntime["streams"]["streamSimple"] = (
      requestModel,
    ) => {
      const stream = createAssistantMessageEventStream();
      started.resolve();
      void release.promise.then(() => {
        const completed = providerMessage(
          requestModel,
          "stop",
          "late completion",
        );
        stream.push({ type: "done", reason: "stop", message: completed });
        stream.end(completed);
      });
      return stream;
    };
    let cleanupFailures = 0;
    const registry = new SubagentRuntimeRegistry({
      started: () => {},
      terminal: () => {},
      cleanupFailed: () => {
        cleanupFailures += 1;
      },
    });
    const runningChild = child(registry, runtimeFrom(model, streamSimple));
    const prompt = runningChild.prompt("Ignore abort temporarily.");
    await started.promise;

    assert.equal(
      registry.hasGenerationChildren("compatibility-generation"),
      true,
    );
    assert.equal(registry.hasChatChildren("compatibility-chat"), true);
    assert.equal(
      registry.hasWorkspaceChildren("compatibility-workspace"),
      true,
    );
    registry.abortWorkspace("another-workspace");
    assert.equal(runningChild.agent.state.isStreaming, true);
    registry.abortWorkspace("compatibility-workspace");
    registry.abortChat("compatibility-chat");
    assert.equal(registry.activeCount, 1);
    assert.equal(
      registry.hasWorkspaceChildren("compatibility-workspace"),
      true,
    );

    assert.equal(await registry.shutdown(10), false);
    assert.equal(cleanupFailures, 1);
    assert.equal(registry.activeCount, 1);
    assert.equal(runningChild.agent.state.isStreaming, true);
    release.resolve();
    await prompt;
    assert.equal(registry.activeCount, 0);
    assert.equal(runningChild.agent.state.isStreaming, false);
  });
});

test("main-process shutdown continues to application quit after the subagent deadline", async () => {
  const source = await readFile(
    new URL("../../index.ts", import.meta.url),
    "utf-8",
  );
  const parentAbortStart = source.indexOf(
    "llmClient.abortAll();",
    source.indexOf("async function shutdownAndQuit"),
  );
  const settlementStart = source.indexOf(
    "const subagentsSettled = await subagentRuntimeRegistry.shutdown();",
  );
  const parentSettlementStart = source.indexOf(
    "await llmClient.shutdown();",
    parentAbortStart,
  );
  const cleanupStart = source.indexOf("cleanupApplication();", settlementStart);
  const receiptFinalizationStart = source.indexOf(
    "await tryFinalizeSubagentPackagedSoakQuitReceipt(",
    settlementStart,
  );
  const forceQuitStart = source.indexOf("forceAppQuit = true;", cleanupStart);
  const appQuitStart = source.indexOf("app.quit();", forceQuitStart);
  const failureExitStart = source.indexOf(
    "app.exit(1);",
    receiptFinalizationStart,
  );

  assert.ok(parentAbortStart >= 0);
  assert.ok(parentSettlementStart > parentAbortStart);
  assert.ok(settlementStart > parentAbortStart);
  assert.ok(settlementStart > parentSettlementStart);
  assert.ok(settlementStart >= 0);
  assert.ok(receiptFinalizationStart > settlementStart);
  assert.ok(failureExitStart > receiptFinalizationStart);
  assert.ok(failureExitStart < cleanupStart);
  assert.ok(cleanupStart > receiptFinalizationStart);
  assert.ok(cleanupStart > settlementStart);
  assert.ok(forceQuitStart > cleanupStart);
  assert.ok(appQuitStart > forceQuitStart);
  assert.match(
    source.slice(receiptFinalizationStart, cleanupStart),
    /requiresSubagentPackagedSoakFailureExit\(session, quitReceiptFinalization\)[\s\S]*app\.exit\(1\);[\s\S]*return;/u,
  );
  assert.match(
    source.slice(settlementStart, cleanupStart),
    /Subagent work did not settle before the shutdown deadline; forcing application shutdown/,
  );
});

test("all shutdown paths abort parent generations before the child registry", async () => {
  const source = await readFile(
    new URL("../../index.ts", import.meta.url),
    "utf-8",
  );
  const cleanupStart = source.indexOf("function cleanupApplication");
  const cleanupEnd = source.indexOf("\n}", cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);

  assert.ok(cleanup.indexOf("llmClient.abortAll()") >= 0);
  assert.ok(
    cleanup.indexOf("subagentRuntimeRegistry.abortAll()") >
      cleanup.indexOf("llmClient.abortAll()"),
  );
});

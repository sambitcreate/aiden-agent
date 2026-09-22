import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "../types.js";
import { createSubagentAuthorityV2 } from "./authority-v2.js";
import type { SubagentMcpMutationHostV2 } from "./subagent-mcp-mutation.js";
import { buildProductionSubagentChildTools } from "./subagent-tool-assembly.js";
import {
  inspectSubagentMcpServer,
  type SubagentMcpClientPort,
  type SubagentMcpReadHost,
  type SubagentMcpRemoteTool,
} from "./subagent-mcp-read.js";
import { SubagentNetworkBudgetV2 } from "./network-budget-v2.js";
import { SubagentWebProxyHost } from "./subagent-web-proxy.js";

const server: McpServer = {
  id: "docs",
  name: "Docs",
  transport: "http",
  url: "https://mcp.example.test/read",
  enabled: true,
};
const remoteTool: SubagentMcpRemoteTool = {
  name: "lookup",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const remoteMutationTool: SubagentMcpRemoteTool = {
  name: "publish",
  inputSchema: {
    type: "object",
    properties: { document: { type: "string" } },
    required: ["document"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

function mcpHost(
  calls: string[],
  tools: readonly SubagentMcpRemoteTool[] = [remoteTool],
): SubagentMcpReadHost {
  return {
    resolveServer: async (serverId) => (serverId === server.id ? server : undefined),
    withClient: async (_server, _signal, operation) =>
      operation({
        credentialRevision: "c".repeat(64),
        credentialRevisionIsCurrent: async () => true,
        redactCredentialText: (text) => text,
        listTools: async () => tools,
        callTool: async (name, _args, _signal, beforeEffect) => {
          beforeEffect?.();
          calls.push(name);
          return { content: [{ type: "text", text: "evidence" }] };
        },
      } satisfies SubagentMcpClientPort),
  };
}

function assemblyAuthority(
  inspected: Awaited<ReturnType<typeof inspectSubagentMcpServer>>,
  overrides: {
    expiresAt?: number;
    maxNetworkOperations?: number;
    writeOnly?: boolean;
    shellOnly?: boolean;
    mcpEffects?: "read" | "mutation" | "all";
  } = {},
) {
  return createSubagentAuthorityV2({
    grantId: "grant-assembly",
    treeRootId: "tree-assembly",
    runId: "run-assembly",
    depth: 1,
    authorityRevision: 1,
    generationId: "generation-assembly",
    chatId: "chat-assembly",
    workspaceId: "workspace-assembly",
    workspaceRevision: "workspace-revision",
    ownerDocumentId: "document-assembly",
    providerFingerprint: "provider-assembly",
    modelFingerprint: "model-assembly",
    contextRevision: "context-assembly",
    execution: "foreground",
    context: "fresh",
    thinkingLevel: "medium",
    capabilities: {
      workspaceRead: false,
      workspaceWrite: overrides.writeOnly === true,
      shell: overrides.shellOnly === true,
      web: overrides.writeOnly !== true && overrides.shellOnly !== true,
      delegation: false,
      mcp:
        overrides.writeOnly === true || overrides.shellOnly === true
          ? []
          : [
              {
                serverId: inspected.serverId,
                connectionFingerprint: inspected.connectionFingerprint,
                tools: inspected.tools.filter((tool) =>
                  overrides.mcpEffects === "all"
                    ? true
                    : overrides.mcpEffects === "mutation"
                      ? tool.effect === "mutating"
                      : tool.effect === "read",
                ),
              },
            ],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputChars: 4_000,
      maxTokens: 4_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: overrides.maxNetworkOperations ?? 1,
    },
    expiresAt: overrides.expiresAt ?? 60_000,
  });
}

function mutationHost(
  inspected: Awaited<ReturnType<typeof inspectSubagentMcpServer>>,
): SubagentMcpMutationHostV2 {
  const tool = inspected.tools.find((candidate) => candidate.effect === "mutating");
  assert.ok(tool && tool.effect === "mutating");
  return {
    async openFreshSession() {
      return {
        async inspect() {
          return {
            serverId: inspected.serverId,
            connectionFingerprint: inspected.connectionFingerprint,
            toolName: tool.toolName,
            schemaHash: tool.schemaHash,
            effectProfile: tool.effectProfile,
            inputSchema: remoteMutationTool.inputSchema as Record<string, unknown>,
          };
        },
        dispatchRaw() {
          throw new Error("assembly must not dispatch");
        },
        redactCredentialText: (text) => text,
        async close() {},
      };
    },
  };
}

test("production child assembly executes web and enforces one mixed web/MCP ceiling", async () => {
  const calls: string[] = [];
  const host = mcpHost(calls);
  const controller = new AbortController();
  const inspected = await inspectSubagentMcpServer({
    server,
    withClient: host.withClient,
    signal: controller.signal,
  });
  const authority = assemblyAuthority(inspected);
  const budget = new SubagentNetworkBudgetV2();
  let fetches = 0;
  const webHost = new SubagentWebProxyHost({
    search: async (_request, options) => {
      fetches += 1;
      const result = { providerId: "exa" as const, results: [], untrusted: true as const };
      if (options && !(options instanceof AbortSignal)) {
        await options.beforeProviderAttempt?.("exa");
        assert.equal(await options.revalidateAfterAttempt?.("exa", result), true);
      }
      return result;
    },
    webSearchAvailability: async () => ({
      ready: true,
      route: [{ providerId: "exa", ready: true, configurationStatus: "configured" }],
    }),
    now: () => 1_000,
    scheduleTimeout: () => () => undefined,
  });
  const assembly = await buildProductionSubagentChildTools(
    {
      workspaceRoot: "/tmp",
      permission: "none",
      role: "scout",
      inheritedCeiling: [],
      authority,
      currentAuthority: () => authority,
      consumeNetworkOperation: (current) => budget.consume(current),
      now: () => 1_000,
      signal: controller.signal,
    },
    { webHost, mcpHost: host },
  );
  assert.deepEqual(assembly.outboundApprovalBindings.map(({ kind }) => kind).sort(), [
    "mcp",
    "web",
  ]);
  assert.deepEqual(assembly.workspaceWriteApprovalBindings, []);
  const web = assembly.tools.find(({ name }) => name === "web_search");
  const mcp = assembly.tools.find(({ name }) => name !== "web_search");
  assert.ok(web);
  assert.ok(mcp);
  await web.execute("web-call", { query: "current docs", numResults: 1 }, controller.signal);
  assert.equal(fetches, 1);
  assert.equal(budget.used(authority), 1);
  await assert.rejects(
    mcp.execute("mcp-call", { query: "one" }, controller.signal),
    /failed|budget/u,
  );
  assert.deepEqual(calls, []);
  assert.equal(budget.used(authority), 1);
});

test("MCP execution requires exact true budget consent and rechecks slow expiry first", async () => {
  const calls: string[] = [];
  const host = mcpHost(calls);
  const controller = new AbortController();
  const inspected = await inspectSubagentMcpServer({
    server,
    withClient: host.withClient,
    signal: controller.signal,
  });
  const webHost = new SubagentWebProxyHost({
    search: async () => ({ providerId: "exa", results: [], untrusted: true }),
    webSearchAvailability: async () => ({
      ready: true,
      route: [{ providerId: "exa", ready: true, configurationStatus: "configured" }],
    }),
    now: () => 1_000,
    scheduleTimeout: () => () => undefined,
  });
  const build = async (input: {
    authority: ReturnType<typeof assemblyAuthority>;
    now: () => number;
    consume: () => boolean;
  }) => {
    const assembly = await buildProductionSubagentChildTools(
      {
        workspaceRoot: "/tmp",
        permission: "none",
        role: "scout",
        inheritedCeiling: [],
        authority: input.authority,
        currentAuthority: () => input.authority,
        consumeNetworkOperation: input.consume,
        now: input.now,
        signal: controller.signal,
      },
      { webHost, mcpHost: host },
    );
    const binding = assembly.outboundApprovalBindings.find(({ kind }) => kind === "mcp");
    const tool = assembly.tools.find(({ name }) => name === binding?.toolName);
    assert.ok(tool);
    return tool;
  };

  let falseBudgetCalls = 0;
  const falseBudgetTool = await build({
    authority: assemblyAuthority(inspected),
    now: () => 1_000,
    consume: () => {
      falseBudgetCalls += 1;
      return false;
    },
  });
  await assert.rejects(
    falseBudgetTool.execute("mcp-false", { query: "one" }, controller.signal),
    /failed|budget/u,
  );
  assert.equal(falseBudgetCalls, 1);
  assert.deepEqual(calls, []);

  let clock = 1_000;
  let expiredBudgetCalls = 0;
  const expiringAuthority = assemblyAuthority(inspected, { expiresAt: 1_500 });
  const expiringTool = await build({
    authority: expiringAuthority,
    now: () => clock,
    consume: () => {
      expiredBudgetCalls += 1;
      return true;
    },
  });
  clock = 1_500;
  await assert.rejects(
    expiringTool.execute("mcp-expired", { query: "two" }, controller.signal),
    /failed|revoked/u,
  );
  assert.equal(expiredBudgetCalls, 0);
  assert.deepEqual(calls, []);
});

test("production child assembly withholds ambient and privileged tools without exact V2 authority", async () => {
  const assembly = await buildProductionSubagentChildTools(
    {
      workspaceRoot: "/tmp",
      permission: "none",
      role: "reviewer",
      inheritedCeiling: [],
    },
    {
      webHost: { toolForAuthority: () => null },
      mcpHost: mcpHost([]),
    },
  );
  assert.deepEqual(assembly.tools, []);
  assert.deepEqual(assembly.outboundApprovalBindings, []);
  assert.deepEqual(assembly.workspaceWriteApprovalBindings, []);
  assert.deepEqual(assembly.mcpMutationApprovalBindings, []);
});

test("production assembly separates read-only, mutation-only, and mixed MCP tools", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const host = mcpHost(calls, [remoteTool, remoteMutationTool]);
  const inspected = await inspectSubagentMcpServer({
    server,
    withClient: host.withClient,
    signal: controller.signal,
  });
  const webHost = { toolForAuthority: () => null };
  const build = (effects: "read" | "mutation" | "all", enabled = true) => {
    const authority = assemblyAuthority(inspected, { mcpEffects: effects });
    return buildProductionSubagentChildTools(
      {
        workspaceRoot: "/tmp",
        permission: "none",
        role: "reviewer",
        inheritedCeiling: [],
        authority,
        currentAuthority: () => authority,
        consumeNetworkOperation: () => true,
        mcpMutationsEnabled: enabled,
        signal: controller.signal,
      },
      { webHost, mcpHost: host, mcpMutationHost: mutationHost(inspected) },
    );
  };

  const read = await build("read");
  assert.equal(read.outboundApprovalBindings.length, 1);
  assert.equal(read.mcpMutationApprovalBindings.length, 0);
  const mutation = await build("mutation");
  assert.equal(mutation.outboundApprovalBindings.length, 0);
  assert.equal(mutation.mcpMutationApprovalBindings.length, 1);
  assert.deepEqual(
    mutation.tools.map(({ name }) => name),
    mutation.mcpMutationApprovalBindings.map(({ childAgentToolName }) => childAgentToolName),
  );
  const mixed = await build("all");
  assert.equal(mixed.outboundApprovalBindings.length, 1);
  assert.equal(mixed.mcpMutationApprovalBindings.length, 1);
  assert.deepEqual(
    mixed.tools.map(({ name }) => name).sort(),
    [
      mixed.outboundApprovalBindings[0]!.toolName,
      mixed.mcpMutationApprovalBindings[0]!.childAgentToolName,
    ].sort(),
  );
  await assert.rejects(build("mutation", false), /mutation tool assembly is unavailable/u);
  assert.deepEqual(calls, []);
});

test("production child assembly exposes only attended write/edit tools for exact write authority", async () => {
  const host = mcpHost([]);
  const controller = new AbortController();
  const inspected = await inspectSubagentMcpServer({
    server,
    withClient: host.withClient,
    signal: controller.signal,
  });
  const authority = assemblyAuthority(inspected, { writeOnly: true });
  const assembly = await buildProductionSubagentChildTools(
    {
      workspaceRoot: "/tmp",
      permission: "ask",
      role: "reviewer",
      inheritedCeiling: [],
      authority,
      currentAuthority: () => authority,
    },
    {
      webHost: { toolForAuthority: () => null },
      mcpHost: host,
    },
  );
  assert.deepEqual(
    assembly.tools.map(({ name }) => name),
    ["write_file", "edit_file"],
  );
  assert.deepEqual(assembly.outboundApprovalBindings, []);
  assert.deepEqual(assembly.workspaceWriteApprovalBindings, [
    { toolName: "write_file", operation: "write" },
    { toolName: "edit_file", operation: "edit" },
  ]);
  assert.deepEqual(
    Object.keys((assembly.tools[0]!.parameters as { properties: object }).properties).sort(),
    ["content", "path"],
  );
  assert.deepEqual(
    Object.keys((assembly.tools[1]!.parameters as { properties: object }).properties).sort(),
    ["new_string", "old_string", "path"],
  );
});

test("production child assembly exposes exact run_command only behind positive shell activation", async () => {
  const host = mcpHost([]);
  const controller = new AbortController();
  const inspected = await inspectSubagentMcpServer({
    server,
    withClient: host.withClient,
    signal: controller.signal,
  });
  const authority = assemblyAuthority(inspected, { shellOnly: true });
  const build = (shellEnabled: boolean) =>
    buildProductionSubagentChildTools(
      {
        workspaceRoot: "/tmp",
        permission: "ask",
        role: "reviewer",
        inheritedCeiling: [],
        authority,
        currentAuthority: () => authority,
        shellEnabled,
      },
      { webHost: { toolForAuthority: () => null }, mcpHost: host },
    );
  const assembly = await build(true);
  assert.deepEqual(
    assembly.tools.map(({ name }) => name),
    ["run_command"],
  );
  assert.deepEqual(assembly.shellApprovalBindings, [{ toolName: "run_command" }]);
  await assert.rejects(build(false), /shell tool assembly is unavailable/u);
});

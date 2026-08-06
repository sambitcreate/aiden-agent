import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentMcpScopeV2 } from "./authority-v2.js";
import { subagentMcpEffectProfileFingerprintV2 } from "./authority-v2.js";
import { effectiveSubagentTaskCapabilities, parseSubagentToolRequest } from "./contracts.js";
import {
  MAX_SUBAGENT_MODEL_MCP_NAME_BYTES,
  MAX_SUBAGENT_MODEL_MCP_TOOLS,
  boundSubagentMcpInventoryV2,
  projectRequestableSubagentMcpInventoryV2,
  projectRequestableSubagentMcpMutationInventoryV2,
  resolveRequestedSubagentCapabilitiesV2,
} from "./request-capabilities-v2.js";

const inventory: SubagentMcpScopeV2[] = [
  {
    serverId: "docs",
    connectionFingerprint: "a".repeat(64),
    tools: [
      { toolName: "search", schemaHash: "b".repeat(64), effect: "read" },
      {
        toolName: "publish",
        schemaHash: "c".repeat(64),
        effect: "mutating",
        effectProfile: (() => {
          const profile = {
            classification: "declared_mutating" as const,
            destructive: "additive" as const,
            idempotency: "not_declared" as const,
            openWorld: "closed" as const,
            taskSupport: "forbidden" as const,
          };
          return {
            ...profile,
            fingerprint: subagentMcpEffectProfileFingerprintV2(profile),
          };
        })(),
      },
    ],
  },
];

test("legacy calls keep the workspace-read-only default", () => {
  const request = parseSubagentToolRequest({
    tasks: [{ role: "scout", label: "Inspect", task: "Inspect files" }],
  });
  assert.equal(request.capabilities, undefined);
  assert.equal(request.tasks[0]?.capabilities, undefined);
  assert.deepEqual(
    parseSubagentToolRequest({
      capabilities: { workspaceRead: true, web: false, mcp: [] },
      tasks: [{ role: "scout", label: "Inspect", task: "Inspect files" }],
    }).capabilities,
    { workspaceRead: true, workspaceWrite: false, web: false, mcp: [] },
  );
  for (const capabilities of [
    {
      workspaceRead: true,
      workspaceWrite: "yes",
      web: false,
      mcp: [],
    },
    {
      workspaceRead: true,
      workspaceWrite: undefined,
      web: false,
      mcp: [],
    },
    {
      workspaceRead: true,
      workspaceWrite: false,
      web: false,
      mcp: [],
      unexpected: true,
    },
  ]) {
    assert.throws(
      () =>
        parseSubagentToolRequest({
          capabilities,
          tasks: [{ role: "scout", label: "Inspect", task: "Inspect files" }],
        }),
      /capability request/u,
    );
  }
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: { workspaceRead: true, web: false, mcp: [] },
        tasks: [
          {
            role: "scout",
            label: "Invalid",
            task: "Reject an explicit undefined write field",
            capabilities: {
              workspaceRead: true,
              workspaceWrite: undefined,
              web: false,
              mcp: [],
            },
          },
        ],
      }),
    /capability request/u,
  );
});

test("read and mutation requests for one server merge into one exact authority scope", () => {
  const resolved = resolveRequestedSubagentCapabilitiesV2(
    {
      workspaceRead: false,
      workspaceWrite: false,
      web: false,
      mcp: [{ serverId: "docs", tools: ["search"] }],
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
    inventory,
  );
  assert.equal(resolved.mcp.length, 1);
  assert.deepEqual(
    resolved.mcp[0]?.tools.map((tool) => [tool.toolName, tool.effect]),
    [
      ["search", "read"],
      ["publish", "mutating"],
    ],
  );
  assert.deepEqual(projectRequestableSubagentMcpMutationInventoryV2(inventory), [
    { serverId: "docs", tools: ["publish"] },
  ]);
});

test("shell is positive, omitted by default, exact, and task-narrowed", () => {
  assert.equal(
    parseSubagentToolRequest({
      tasks: [{ role: "scout", label: "Read", task: "Read." }],
    }).capabilities,
    undefined,
  );
  const parsed = parseSubagentToolRequest({
    capabilities: { workspaceRead: false, shell: true, web: false, mcp: [] },
    tasks: [
      {
        role: "scout",
        label: "Shell",
        task: "Run.",
        capabilities: { workspaceRead: false, shell: false, web: false, mcp: [] },
      },
    ],
  });
  assert.equal(parsed.capabilities?.shell, true);
  assert.equal(parsed.tasks[0]?.capabilities?.shell, false);
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: { workspaceRead: false, web: false, mcp: [] },
        tasks: [
          {
            role: "scout",
            label: "Widen",
            task: "No.",
            capabilities: { workspaceRead: false, shell: true, web: false, mcp: [] },
          },
        ],
      }),
    /cannot widen/u,
  );
  const resolved = resolveRequestedSubagentCapabilitiesV2(
    { workspaceRead: false, workspaceWrite: false, shell: true, web: false, mcp: [] },
    [],
  );
  assert.equal(resolved.shell, true);
});

test("delegate is positive, omitted by default, exact, and task-narrowed", () => {
  const omitted = parseSubagentToolRequest({
    capabilities: { workspaceRead: false, web: false, mcp: [] },
    tasks: [{ role: "scout", label: "Read", task: "Read." }],
  });
  assert.equal(omitted.capabilities?.delegate, undefined);
  assert.equal(effectiveSubagentTaskCapabilities(omitted, omitted.tasks[0]!).delegate, false);

  const parsed = parseSubagentToolRequest({
    capabilities: { workspaceRead: false, delegate: true, web: false, mcp: [] },
    tasks: [
      {
        role: "planner",
        label: "Plan",
        task: "Plan without delegating.",
        capabilities: { workspaceRead: false, delegate: false, web: false, mcp: [] },
      },
    ],
  });
  assert.equal(parsed.capabilities?.delegate, true);
  assert.equal(parsed.tasks[0]?.capabilities?.delegate, false);
  assert.equal(resolveRequestedSubagentCapabilitiesV2(parsed.capabilities!, []).delegation, true);

  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: { workspaceRead: false, web: false, mcp: [] },
        tasks: [
          {
            role: "scout",
            label: "Widen",
            task: "No.",
            capabilities: { workspaceRead: false, delegate: true, web: false, mcp: [] },
          },
        ],
      }),
    /cannot widen/u,
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: false,
          delegate: undefined,
          web: false,
          mcp: [],
        },
        tasks: [{ role: "scout", label: "Bad", task: "Undefined." }],
      }),
    /capability request/u,
  );

  let getterCalls = 0;
  const hostile = Object.defineProperty({ workspaceRead: false, web: false, mcp: [] }, "delegate", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: hostile,
        tasks: [{ role: "scout", label: "Bad", task: "Getter." }],
      }),
    /capability request/u,
  );
  assert.equal(getterCalls, 0);
});

test("mutation requests are optional, disjoint, exact plain data, and task-narrowed", () => {
  const parsed = parseSubagentToolRequest({
    capabilities: {
      workspaceRead: false,
      web: false,
      mcp: [{ serverId: "docs", tools: ["search"] }],
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
    tasks: [
      {
        role: "reviewer",
        label: "Publish",
        task: "Prepare a bounded publication.",
        capabilities: {
          workspaceRead: false,
          web: false,
          mcp: [],
          mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
        },
      },
    ],
  });
  assert.deepEqual(parsed.capabilities?.mcpMutations, [{ serverId: "docs", tools: ["publish"] }]);
  assert.equal(
    parseSubagentToolRequest({
      capabilities: { workspaceRead: false, web: false, mcp: [] },
      tasks: [{ role: "scout", label: "Read", task: "Read." }],
    }).capabilities?.mcpMutations,
    undefined,
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: false,
          web: false,
          mcp: [{ serverId: "docs", tools: ["publish"] }],
          mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
        },
        tasks: [{ role: "scout", label: "Bad", task: "Overlap." }],
      }),
    /disjoint/u,
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: false,
          web: false,
          mcp: [],
          mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
        },
        tasks: [
          {
            role: "scout",
            label: "Bad",
            task: "Widen.",
            capabilities: {
              workspaceRead: false,
              web: false,
              mcp: [],
              mcpMutations: [{ serverId: "docs", tools: ["delete"] }],
            },
          },
        ],
      }),
    /cannot widen/u,
  );

  let getterCalls = 0;
  const hostile = Object.defineProperty(
    {
      workspaceRead: false,
      web: false,
      mcp: [],
    },
    "mcpMutations",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    },
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: hostile,
        tasks: [{ role: "scout", label: "Bad", task: "Getter." }],
      }),
    /capability request/u,
  );
  assert.equal(getterCalls, 0);
});

test("strict task requests can only narrow root write, web, and logical MCP scope", () => {
  const request = parseSubagentToolRequest({
    capabilities: {
      workspaceRead: true,
      workspaceWrite: true,
      web: true,
      mcp: [{ serverId: "docs", tools: ["search"] }],
    },
    tasks: [
      {
        role: "scout",
        label: "Web",
        task: "Search",
        capabilities: {
          workspaceRead: false,
          workspaceWrite: false,
          web: true,
          mcp: [],
        },
      },
      {
        role: "reviewer",
        label: "Docs",
        task: "Read docs",
        capabilities: {
          workspaceRead: true,
          workspaceWrite: true,
          web: false,
          mcp: [{ serverId: "docs", tools: ["search"] }],
        },
      },
    ],
  });
  assert.equal(request.tasks[0]?.capabilities?.workspaceRead, false);
  assert.equal(request.tasks[1]?.capabilities?.workspaceWrite, true);
  assert.equal(request.tasks[1]?.capabilities?.mcp[0]?.tools[0], "search");

  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: { workspaceRead: false, web: false, mcp: [] },
        tasks: [
          {
            role: "scout",
            label: "Bad",
            task: "Widen",
            capabilities: { workspaceRead: true, web: false, mcp: [] },
          },
        ],
      }),
    /cannot widen/u,
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: true,
          workspaceWrite: false,
          web: false,
          mcp: [],
        },
        tasks: [
          {
            role: "scout",
            label: "Bad",
            task: "Widen write",
            capabilities: {
              workspaceRead: true,
              workspaceWrite: true,
              web: false,
              mcp: [],
            },
          },
        ],
      }),
    /cannot widen/u,
  );
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: true,
          web: false,
          mcp: [{ serverId: "docs", tools: ["search"] }],
        },
        tasks: [
          {
            role: "scout",
            label: "Bad",
            task: "Widen",
            capabilities: {
              workspaceRead: true,
              web: false,
              mcp: [{ serverId: "docs", tools: ["publish"] }],
            },
          },
        ],
      }),
    /cannot widen/u,
  );
});

test("unknown, duplicate, mutating, and unclassified logical tuples fail before launch", () => {
  assert.throws(
    () =>
      parseSubagentToolRequest({
        capabilities: {
          workspaceRead: true,
          web: false,
          mcp: [
            { serverId: "docs", tools: ["search"] },
            { serverId: "docs", tools: ["search"] },
          ],
        },
        tasks: [{ role: "scout", label: "Bad", task: "Duplicate" }],
      }),
    /duplicate/iu,
  );
  for (const [serverId, toolName] of [
    ["missing", "search"],
    ["docs", "missing"],
    ["docs", "publish"],
  ]) {
    assert.throws(
      () =>
        resolveRequestedSubagentCapabilitiesV2(
          {
            workspaceRead: true,
            workspaceWrite: false,
            web: false,
            mcp: [{ serverId: serverId!, tools: [toolName!] }],
          },
          inventory,
        ),
      /unavailable|not read-only/u,
    );
  }
});

test("host resolution injects exact bindings while the model inventory stays logical", () => {
  assert.deepEqual(projectRequestableSubagentMcpInventoryV2(inventory), [
    { serverId: "docs", tools: ["search"] },
  ]);
  const resolved = resolveRequestedSubagentCapabilitiesV2(
    {
      workspaceRead: true,
      workspaceWrite: true,
      web: true,
      mcp: [{ serverId: "docs", tools: ["search"] }],
    },
    inventory,
  );
  assert.equal(resolved.mcp[0]?.connectionFingerprint, "a".repeat(64));
  assert.equal(resolved.workspaceWrite, true);
  assert.equal(resolved.mcp[0]?.tools[0]?.schemaHash, "b".repeat(64));
  assert.equal(resolved.mcp[0]?.tools[0]?.effect, "read");
  assert.equal(
    JSON.stringify(projectRequestableSubagentMcpInventoryV2(inventory)).includes("aaaa"),
    false,
  );
});

test("mutation resolution hard-fails stale or unavailable targets without model projection", () => {
  const resolved = resolveRequestedSubagentCapabilitiesV2(
    {
      workspaceRead: false,
      workspaceWrite: false,
      web: false,
      mcp: [],
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
    inventory,
  );
  assert.equal(resolved.mcp[0]?.tools[0]?.effect, "mutating");
  assert.deepEqual(projectRequestableSubagentMcpInventoryV2(inventory), [
    { serverId: "docs", tools: ["search"] },
  ]);
  for (const [serverId, toolName] of [
    ["missing", "publish"],
    ["docs", "missing"],
    ["docs", "search"],
  ]) {
    assert.throws(
      () =>
        resolveRequestedSubagentCapabilitiesV2(
          {
            workspaceRead: false,
            workspaceWrite: false,
            web: false,
            mcp: [],
            mcpMutations: [{ serverId: serverId!, tools: [toolName!] }],
          },
          inventory,
        ),
      /stale|unavailable|wrong lane/u,
    );
  }
});

test("hostile inventories stay within per-scope, total, and model-context byte ceilings", () => {
  const hostile: SubagentMcpScopeV2[] = Array.from({ length: 16 }, (_, serverIndex) => ({
    serverId: `server-${String(serverIndex).padStart(2, "0")}`,
    connectionFingerprint: "a".repeat(64),
    tools: Array.from({ length: 256 }, (_, toolIndex) => ({
      toolName: `tool-${String(toolIndex).padStart(3, "0")}-${"x".repeat(100)}`,
      schemaHash: "b".repeat(64),
      effect: "read" as const,
    })),
  }));
  const bounded = boundSubagentMcpInventoryV2(hostile);
  const projection = projectRequestableSubagentMcpInventoryV2(hostile);
  const toolCount = projection.reduce((sum, scope) => sum + scope.tools.length, 0);
  const nameBytes = projection.reduce(
    (sum, scope) =>
      sum +
      Buffer.byteLength(scope.serverId, "utf8") +
      scope.tools.reduce((toolSum, tool) => toolSum + Buffer.byteLength(tool, "utf8"), 0),
    0,
  );
  assert.ok(bounded.every((scope) => scope.tools.length <= 32));
  assert.ok(toolCount <= MAX_SUBAGENT_MODEL_MCP_TOOLS);
  assert.ok(nameBytes <= MAX_SUBAGENT_MODEL_MCP_NAME_BYTES);
  assert.equal(JSON.stringify(projection).length < 8_000, true);
});

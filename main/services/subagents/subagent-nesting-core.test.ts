import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentCapabilitySetV2 } from "./authority-v2.js";
import {
  SubagentTreeBudgetLedgerV2,
  SubagentTreeSchedulerV2,
  createSubagentTreeDescendantV2,
  createSubagentTreeRootV2,
  type SubagentTreeBudgetLimitsV2,
  type SubagentTreeNodeV2,
  type SubagentTreeSchedulerTaskV2,
} from "./subagent-nesting-core.js";

function capabilities(
  overrides: Partial<SubagentCapabilitySetV2> = {},
): SubagentCapabilitySetV2 {
  return {
    workspaceRead: true,
    workspaceWrite: false,
    shell: false,
    web: false,
    delegation: true,
    mcp: [],
    ...overrides,
  };
}

function rootNode(
  overrides: { capabilities?: SubagentCapabilitySetV2; tools?: string[] } = {},
) {
  return createSubagentTreeRootV2({
    treeRootId: "generation-root",
    runId: "generation-root",
    fixedCeiling: {
      workspace: {
        generationId: "generation-root",
        chatId: "chat-1",
        workspaceId: "workspace-1",
        workspaceRevision: "workspace-revision-1",
        ownerDocumentId: "document-1",
      },
      runtime: {
        providerFingerprint: "provider-1",
        modelFingerprint: "model-1",
        execution: "foreground",
        thinkingLevel: "high",
      },
      context: { mode: "fork", revision: "context-1", maxInputTokens: 32_000 },
    },
    capabilities: overrides.capabilities ?? capabilities(),
    toolNames: overrides.tools ?? ["read_file", "grep", "subagent"],
  });
}

function childNode(
  parent: SubagentTreeNodeV2,
  runId: string,
  overrides: { capabilities?: SubagentCapabilitySetV2; tools?: string[] } = {},
) {
  return createSubagentTreeDescendantV2(parent, {
    runId,
    capabilities: overrides.capabilities ?? parent.capabilities,
    toolNames: overrides.tools ?? [...parent.toolNames],
  });
}

function limits(overrides: Partial<SubagentTreeBudgetLimitsV2> = {}) {
  return {
    maxDepth: 2,
    maxLaunches: 8,
    maxActive: 2,
    maxQueued: 8,
    maxTokens: 100_000,
    maxToolCalls: 32,
    maxTurns: 32,
    maxNetworkOperations: 8,
    maxWallTimeMs: 60_000,
    maxOutputChars: 100_000,
    ...overrides,
  };
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("test deadline exceeded")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("tree identity derives exact depth-0, depth-1, and depth-2 lineage and freezes ceilings", () => {
  const root = rootNode();
  const child = childNode(root, "child-1", {
    tools: ["read_file", "subagent"],
  });
  const grandchild = childNode(child, "grandchild-1", {
    capabilities: capabilities({ delegation: false }),
    tools: ["read_file"],
  });

  assert.deepEqual(root.identity, {
    treeRootId: "generation-root",
    runId: "generation-root",
    depth: 0,
  });
  assert.deepEqual(child.identity, {
    treeRootId: "generation-root",
    runId: "child-1",
    depth: 1,
  });
  assert.deepEqual(grandchild.identity, {
    treeRootId: "generation-root",
    runId: "grandchild-1",
    parentRunId: "child-1",
    depth: 2,
  });
  assert.strictEqual(child.fixedCeiling, root.fixedCeiling);
  assert.strictEqual(grandchild.fixedCeiling, root.fixedCeiling);
  assert.ok(Object.isFrozen(root));
  assert.ok(Object.isFrozen(root.fixedCeiling.workspace));
  assert.ok(Object.isFrozen(grandchild.capabilities));
  assert.ok(Object.isFrozen(grandchild.toolNames));
  assert.throws(
    () => childNode(grandchild, "too-deep"),
    /cannot exceed depth 2/u,
  );
});

test("descendants can only narrow exact tool and capability ceilings", () => {
  const root = rootNode({ capabilities: capabilities({ shell: false }) });
  assert.throws(
    () =>
      childNode(root, "shell-widen", {
        capabilities: capabilities({ shell: true }),
      }),
    /cannot widen its capability/u,
  );
  assert.throws(
    () =>
      childNode(root, "tool-widen", { tools: ["read_file", "run_command"] }),
    /cannot widen its tool/u,
  );
  assert.throws(
    () =>
      createSubagentTreeRootV2({
        treeRootId: "different-root",
        runId: "generation-root",
        fixedCeiling: root.fixedCeiling,
        capabilities: root.capabilities,
        toolNames: root.toolNames,
      }),
    /root must identify itself/u,
  );
  assert.throws(
    () =>
      createSubagentTreeDescendantV2(
        { ...root, identity: { ...root.identity } },
        {
          runId: "forged-child",
          capabilities: root.capabilities,
          toolNames: root.toolNames,
        },
      ),
    /parent authority/u,
  );
});

test("hostile root, MCP array, and tool accessors fail without observation", () => {
  const valid = rootNode();
  let rootGetterCalls = 0;
  const hostileRoot = Object.defineProperty(
    {
      treeRootId: "generation-root",
      runId: "generation-root",
      fixedCeiling: valid.fixedCeiling,
      toolNames: ["read_file"],
    },
    "capabilities",
    {
      enumerable: true,
      get() {
        rootGetterCalls += 1;
        return capabilities();
      },
    },
  );
  assert.throws(() => createSubagentTreeRootV2(hostileRoot), /root fields/u);
  assert.equal(rootGetterCalls, 0);

  let proxyReads = 0;
  const proxiedMcp = new Proxy([], {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => rootNode({ capabilities: capabilities({ mcp: proxiedMcp }) }),
    /MCP ceiling/u,
  );
  assert.equal(proxyReads, 0);

  let effectReads = 0;
  const hostileTool = Object.defineProperty(
    { toolName: "search", schemaHash: "a".repeat(64) },
    "effect",
    {
      enumerable: true,
      get() {
        effectReads += 1;
        return "read";
      },
    },
  );
  assert.throws(
    () =>
      rootNode({
        capabilities: capabilities({
          mcp: [
            {
              serverId: "docs",
              connectionFingerprint: "b".repeat(64),
              tools: [hostileTool as never],
            },
          ],
        }),
      }),
    /MCP tool ceiling/u,
  );
  assert.equal(effectReads, 0);
});

test("tree ledger reserves fan-out and usage atomically across every budget", () => {
  let now = 1_000;
  const root = rootNode();
  const parent = childNode(root, "parent-1");
  const first = childNode(parent, "nested-1", {
    capabilities: capabilities({ delegation: false }),
  });
  const second = childNode(parent, "nested-2", {
    capabilities: capabilities({ delegation: false }),
  });
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxLaunches: 2, maxActive: 1, maxQueued: 3, maxWallTimeMs: 100 }),
    () => now,
  );

  ledger.reserveLaunches([parent]);
  ledger.activate(parent.identity.runId);
  const beforeFanout = ledger.snapshot();
  assert.throws(
    () =>
      ledger.reserveDescendantsAndSuspendParent(parent.identity.runId, [
        first,
        second,
      ]),
    /launch budget exhausted/u,
  );
  assert.deepEqual(ledger.snapshot(), beforeFanout);

  const reservation = ledger.reserveDescendantsAndSuspendParent(
    parent.identity.runId,
    [first],
  );
  assert.deepEqual(reservation.runIds, ["nested-1"]);
  assert.equal(reservation.parentRunId, "parent-1");
  assert.deepEqual(ledger.snapshot(), {
    launched: 2,
    active: 0,
    queued: 2,
    tokens: 0,
    toolCalls: 0,
    outputChars: 0,
    turns: 0,
    networkOperations: 0,
    elapsedWallTimeMs: 0,
    expired: false,
  });
  ledger.activate(first.identity.runId);
  ledger.consumeUsage({
    tokens: 90_000,
    toolCalls: 30,
    outputChars: 90_000,
    turns: 30,
    networkOperations: 7,
  });
  const beforeUsageFailure = ledger.snapshot();
  assert.throws(
    () =>
      ledger.consumeUsage({
        tokens: 10_001,
        toolCalls: 0,
        outputChars: 0,
        turns: 0,
        networkOperations: 0,
      }),
    /tokens budget exhausted \(100,001 attempted; 100,000 allowed\).*new parent turn/u,
  );
  assert.deepEqual(ledger.snapshot(), beforeUsageFailure);
  ledger.finish(first.identity.runId);
  ledger.activate(parent.identity.runId);
  ledger.finish(parent.identity.runId);
  now = 1_101;
  assert.equal(ledger.snapshot().expired, true);
  assert.throws(
    () =>
      ledger.consumeUsage({
        tokens: 0,
        toolCalls: 0,
        outputChars: 0,
        turns: 0,
        networkOperations: 0,
      }),
    /wall-time/u,
  );
});

test("tree ledger enforces aggregate turn and network ceilings", () => {
  const ledger = new SubagentTreeBudgetLedgerV2(
    "generation-root",
    limits({ maxTurns: 2, maxNetworkOperations: 1 }),
    () => 0,
  );
  ledger.consumeUsage({
    tokens: 0,
    toolCalls: 0,
    outputChars: 0,
    turns: 2,
    networkOperations: 1,
  });
  const full = ledger.snapshot();
  assert.equal(full.turns, 2);
  assert.equal(full.networkOperations, 1);
  assert.throws(
    () =>
      ledger.consumeUsage({
        tokens: 0,
        toolCalls: 0,
        outputChars: 0,
        turns: 1,
        networkOperations: 0,
      }),
    /turns budget exhausted \(3 attempted; 2 allowed\)/u,
  );
  assert.throws(
    () =>
      ledger.consumeUsage({
        tokens: 0,
        toolCalls: 0,
        outputChars: 0,
        turns: 0,
        networkOperations: 1,
      }),
    /network operations budget exhausted \(2 attempted; 1 allowed\)/u,
  );
  assert.deepEqual(ledger.snapshot(), full);
});

test("ledger rejects hostile budget and usage getters without partial mutation", () => {
  let budgetReads = 0;
  const hostileLimits = Object.defineProperty(
    {
      maxDepth: 2,
      maxLaunches: 2,
      maxActive: 1,
      maxQueued: 2,
      maxTokens: 10,
      maxToolCalls: 10,
      maxOutputChars: 10,
    },
    "maxWallTimeMs",
    {
      enumerable: true,
      get() {
        budgetReads += 1;
        return 10;
      },
    },
  );
  assert.throws(
    () => new SubagentTreeBudgetLedgerV2("generation-root", hostileLimits),
    /budget fields/u,
  );
  assert.equal(budgetReads, 0);

  const ledger = new SubagentTreeBudgetLedgerV2("generation-root", limits());
  let usageReads = 0;
  const hostileUsage = Object.defineProperty(
    { tokens: 1, toolCalls: 1 },
    "outputChars",
    {
      enumerable: true,
      get() {
        usageReads += 1;
        return 1;
      },
    },
  );
  assert.throws(() => ledger.consumeUsage(hostileUsage), /usage fields/u);
  assert.equal(usageReads, 0);
  assert.equal(ledger.snapshot().tokens, 0);
});

test("local limit one releases a waiting parent so its descendant can run", async () => {
  const root = rootNode();
  const parent = childNode(root, "local-parent");
  const nested = childNode(parent, "local-nested", {
    capabilities: capabilities({ delegation: false }),
  });
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxActive: 1 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  const events: string[] = [];

  const results = await withDeadline(
    scheduler.run([
      {
        node: parent,
        deployment: "local",
        execute: async (lease) => {
          events.push("parent:start");
          const nestedResults = await lease.runDescendants([
            {
              node: nested,
              deployment: "local",
              execute: async () => {
                events.push("nested:start");
                await Promise.resolve();
                events.push("nested:end");
                return "nested-result";
              },
            },
          ]);
          events.push("parent:resume");
          return nestedResults[0];
        },
      },
    ]),
  );

  assert.deepEqual(results, ["nested-result"]);
  assert.deepEqual(events, [
    "parent:start",
    "nested:start",
    "nested:end",
    "parent:resume",
  ]);
  assert.equal(ledger.snapshot().active, 0);
  assert.equal(ledger.snapshot().queued, 0);
});

test("scheduler removes one exact queued run without activating it", async () => {
  const root = rootNode();
  const first = childNode(root, "cancel-first");
  const queued = childNode(root, "cancel-queued");
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxActive: 1 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let queuedCalls = 0;
  const running = scheduler.run([
    {
      node: first,
      deployment: "local",
      execute: async () => {
        markStarted();
        await firstRelease;
        return "first";
      },
    },
    {
      node: queued,
      deployment: "local",
      cancelledResult: "stopped",
      execute: async () => {
        queuedCalls += 1;
        return "queued";
      },
    },
  ]);
  await firstStarted;
  assert.equal(ledger.snapshot().queued, 1);
  const stopped = new Error("stop exact queued child");
  assert.equal(scheduler.cancelRun(queued.identity.runId, stopped), true);
  assert.equal(ledger.snapshot().queued, 0);
  assert.equal(scheduler.cancelRun(queued.identity.runId, stopped), false);
  releaseFirst();
  assert.deepEqual(await running, ["first", "stopped"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queuedCalls, 0);
  assert.equal(ledger.snapshot().active, 0);
});

test("hosted limit two releases simultaneous waiting parents and preserves request order", async () => {
  const root = rootNode();
  const parents = [
    childNode(root, "hosted-parent-1"),
    childNode(root, "hosted-parent-2"),
  ];
  const nested = [
    childNode(parents[0]!, "hosted-nested-1", {
      capabilities: capabilities({ delegation: false }),
    }),
    childNode(parents[1]!, "hosted-nested-2", {
      capabilities: capabilities({ delegation: false }),
    }),
  ];
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxActive: 2 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  let started = 0;
  let releaseParents!: () => void;
  const bothParentsStarted = new Promise<void>((resolve) => {
    releaseParents = resolve;
  });
  const nestedStarts: string[] = [];

  const tasks = parents.map(
    (parent, index): SubagentTreeSchedulerTaskV2 => ({
      node: parent,
      deployment: "hosted",
      execute: async (lease) => {
        started += 1;
        if (started === 2) releaseParents();
        await bothParentsStarted;
        const values = await lease.runDescendants([
          {
            node: nested[index]!,
            deployment: "hosted",
            execute: async () => {
              nestedStarts.push(nested[index]!.identity.runId);
              return `nested-${index + 1}`;
            },
          },
        ]);
        return `parent-${index + 1}:${String(values[0])}`;
      },
    }),
  );

  const results = await withDeadline(scheduler.run(tasks));
  assert.deepEqual(results, ["parent-1:nested-1", "parent-2:nested-2"]);
  assert.deepEqual(nestedStarts, ["hosted-nested-1", "hosted-nested-2"]);
  assert.deepEqual(ledger.snapshot().active, 0);
  assert.deepEqual(ledger.snapshot().queued, 0);
});

test("scheduler fan-out failure is atomic and leaves the parent execution lease live", async () => {
  const root = rootNode();
  const parent = childNode(root, "atomic-parent");
  const nested = [
    childNode(parent, "atomic-child-1"),
    childNode(parent, "atomic-child-2"),
  ];
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxLaunches: 2, maxActive: 1 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  let childCalls = 0;
  const results = await scheduler.run([
    {
      node: parent,
      deployment: "local",
      execute: async (lease) => {
        assert.throws(
          () =>
            lease.runDescendants(
              nested.map((node) => ({
                node,
                deployment: "local" as const,
                execute: async () => {
                  childCalls += 1;
                },
              })),
            ),
          /launch budget exhausted/u,
        );
        assert.equal(ledger.stateOf(parent.identity.runId), "active");
        return "parent-continued";
      },
    },
  ]);
  assert.deepEqual(results, ["parent-continued"]);
  assert.equal(childCalls, 0);
  assert.equal(ledger.snapshot().launched, 1);
});

test("root cancellation removes queued work but retains running ownership until settlement", async () => {
  const root = rootNode();
  const parent = childNode(root, "cancel-parent");
  const activeChild = childNode(parent, "cancel-active");
  const queuedChild = childNode(parent, "cancel-queued");
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxActive: 1, maxQueued: 4 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  let markActive!: () => void;
  const activeStarted = new Promise<void>((resolve) => {
    markActive = resolve;
  });
  let releaseActive!: () => void;
  const activeRelease = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let queuedCalls = 0;
  const run = scheduler.run([
    {
      node: parent,
      deployment: "local",
      execute: async (lease) => {
        await lease.runDescendants([
          {
            node: activeChild,
            deployment: "local",
            execute: async () => {
              markActive();
              await activeRelease;
            },
          },
          {
            node: queuedChild,
            deployment: "local",
            execute: async () => {
              queuedCalls += 1;
            },
          },
        ]);
      },
    },
  ]);
  await withDeadline(activeStarted);
  const reason = new Error("exact root stop");
  scheduler.cancel(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ledger.snapshot().active, 1);
  assert.equal(ledger.snapshot().queued, 1);
  assert.equal(ledger.stateOf(activeChild.identity.runId), "active");
  assert.equal(ledger.stateOf(queuedChild.identity.runId), "terminal");
  releaseActive();
  await withDeadline(assert.rejects(run, (error: unknown) => error === reason));
  assert.equal(queuedCalls, 0);
  assert.equal(ledger.snapshot().active, 0);
  assert.equal(ledger.snapshot().queued, 0);
  assert.equal(ledger.stateOf(parent.identity.runId), "terminal");
  assert.equal(ledger.stateOf(activeChild.identity.runId), "terminal");
  assert.equal(ledger.stateOf(queuedChild.identity.runId), "terminal");
});

test("root cancellation drains running top-level siblings after rejecting queued work", async () => {
  const root = rootNode();
  const active = childNode(root, "root-active");
  const queued = childNode(root, "root-queued");
  const ledger = new SubagentTreeBudgetLedgerV2(
    root.identity.treeRootId,
    limits({ maxActive: 1 }),
  );
  const scheduler = new SubagentTreeSchedulerV2(ledger, {
    local: 1,
    hosted: 2,
  });
  let markStarted!: () => void;
  let releaseActive!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let queuedCalls = 0;
  const run = scheduler.run([
    {
      node: active,
      deployment: "local",
      execute: async () => {
        markStarted();
        await release;
      },
    },
    {
      node: queued,
      deployment: "local",
      execute: async () => {
        queuedCalls += 1;
      },
    },
  ]);
  await started;
  const reason = new Error("cancel root siblings");
  scheduler.cancel(reason);
  const immediate = await Promise.race([
    run.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(immediate, "pending");
  assert.equal(ledger.snapshot().active, 1);
  assert.equal(ledger.stateOf(queued.identity.runId), "terminal");
  releaseActive();
  await assert.rejects(run, (error: unknown) => error === reason);
  assert.equal(queuedCalls, 0);
  assert.equal(ledger.snapshot().active, 0);
});

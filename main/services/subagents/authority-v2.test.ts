import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSubagentLaunchRolloutV2,
  createSubagentAuthorityV2,
  intersectSubagentBudgetsV2,
  parseSubagentLaunchRequestV2,
  resolveSubagentCapabilitiesV2,
  subagentMcpEffectProfileFingerprintV2,
  subagentCapabilitiesAreSubsetV2,
  type SubagentBudgetV2,
  type SubagentCapabilitySetV2,
  type SubagentLaunchRequestV2,
  type SubagentRolloutPolicyV2,
} from "./authority-v2.js";

const inspect: SubagentCapabilitySetV2 = {
  workspaceRead: true,
  workspaceWrite: false,
  shell: false,
  web: false,
  delegation: false,
  mcp: [],
};

const MCP_CONNECTIONS = {
  linear: "a".repeat(64),
  notion: "b".repeat(64),
} as const;
const MCP_SCHEMAS: Record<string, string> = {
  get_issue: "c".repeat(64),
  update_issue: "d".repeat(64),
  get_page: "e".repeat(64),
  update_page: "f".repeat(64),
};

function mcpScope(serverId: keyof typeof MCP_CONNECTIONS, toolNames: readonly string[]) {
  return {
    serverId,
    connectionFingerprint: MCP_CONNECTIONS[serverId],
    tools: toolNames.map((toolName) => {
      if (toolName.startsWith("get_")) {
        return {
          toolName,
          schemaHash: MCP_SCHEMAS[toolName]!,
          effect: "read" as const,
        };
      }
      const profile = {
        classification: "declared_mutating" as const,
        destructive: "unknown" as const,
        idempotency: "not_declared" as const,
        openWorld: "unknown" as const,
        taskSupport: "forbidden" as const,
      };
      return {
        toolName,
        schemaHash: MCP_SCHEMAS[toolName]!,
        effect: "mutating" as const,
        effectProfile: {
          ...profile,
          fingerprint: subagentMcpEffectProfileFingerprintV2(profile),
        },
      };
    }),
  };
}

const everything: SubagentCapabilitySetV2 = {
  workspaceRead: true,
  workspaceWrite: true,
  shell: true,
  web: true,
  delegation: true,
  mcp: [mcpScope("linear", ["get_issue", "update_issue"])],
};

const rollout: SubagentRolloutPolicyV2 = {
  background: false,
  fork: false,
  workspaceWrite: false,
  shell: false,
  web: false,
  mcp: false,
  delegation: false,
};

const budget: SubagentBudgetV2 = {
  deadlineMs: 60_000,
  maxTurns: 24,
  maxToolCalls: 64,
  maxOutputChars: 120_000,
  maxTokens: 200_000,
  maxLaunches: 8,
  maxDepth: 2,
  maxActive: 4,
  maxQueued: 8,
  maxNetworkOperations: 16,
};

function request(): SubagentLaunchRequestV2 {
  return {
    version: 2,
    execution: "foreground",
    context: "fresh",
    capabilities: inspect,
    limits: budget,
    tasks: [
      {
        role: "reviewer",
        label: "Review",
        task: "Review the authority boundary.",
      },
    ],
  };
}

function authorityInput() {
  return {
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
    capabilities: inspect,
    budgets: budget,
    expiresAt: 10_000,
  } as const;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomCapabilitySet(random: () => number): SubagentCapabilitySetV2 {
  const mcp = [
    { serverId: "linear", tools: ["get_issue", "update_issue"] },
    { serverId: "notion", tools: ["get_page", "update_page"] },
  ].flatMap(({ serverId, tools }) => {
    const toolNames = tools.filter(() => random() < 0.5);
    return toolNames.length > 0
      ? [mcpScope(serverId as keyof typeof MCP_CONNECTIONS, toolNames)]
      : [];
  });
  return {
    workspaceRead: random() < 0.5,
    workspaceWrite: random() < 0.5,
    shell: random() < 0.5,
    web: random() < 0.5,
    delegation: random() < 0.5,
    mcp,
  };
}

function narrowCapabilities(
  source: SubagentCapabilitySetV2,
  mask: SubagentCapabilitySetV2,
): SubagentCapabilitySetV2 {
  const maskPairs = new Set(
    mask.mcp.flatMap(({ serverId, connectionFingerprint, tools }) =>
      tools.map(
        ({ toolName, schemaHash, effect }) =>
          `${serverId}\0${connectionFingerprint}\0${toolName}\0${schemaHash}\0${effect}`,
      ),
    ),
  );
  return {
    workspaceRead: source.workspaceRead && mask.workspaceRead,
    workspaceWrite: source.workspaceWrite && mask.workspaceWrite,
    shell: source.shell && mask.shell,
    web: source.web && mask.web,
    delegation: source.delegation && mask.delegation,
    mcp: source.mcp.flatMap(({ serverId, connectionFingerprint, tools }) => {
      const narrowed = tools.filter(({ toolName, schemaHash, effect }) =>
        maskPairs.has(
          `${serverId}\0${connectionFingerprint}\0${toolName}\0${schemaHash}\0${effect}`,
        ),
      );
      return narrowed.length > 0 ? [{ serverId, connectionFingerprint, tools: narrowed }] : [];
    }),
  };
}

test("V2 launch parsing is exact, bounded, and independently revalidates V1 tasks", () => {
  assert.deepEqual(parseSubagentLaunchRequestV2(request()), request());
  assert.throws(() => parseSubagentLaunchRequestV2({ ...request(), extra: true }), /launch/u);
  assert.throws(
    () =>
      parseSubagentLaunchRequestV2({
        ...request(),
        capabilities: { ...inspect, shell: "yes" },
      }),
    /capability/u,
  );
  assert.throws(
    () =>
      parseSubagentLaunchRequestV2({
        ...request(),
        tasks: [{ role: "worker", label: "Escalate", task: "Gain tools." }],
      }),
    /Unknown subagent role/u,
  );
  assert.throws(
    () =>
      parseSubagentLaunchRequestV2({
        ...request(),
        limits: { ...budget, maxDepth: 3 },
      }),
    /depth budget/u,
  );
});

test("capability resolution is a monotonic positive intersection", () => {
  const effective = resolveSubagentCapabilitiesV2({
    requested: everything,
    root: everything,
    parent: everything,
    role: inspect,
    rollout,
    userGrant: everything,
    workspacePermission: "full",
    workspaceEgressApproval: "unavailable",
  });
  assert.deepEqual(effective, inspect);
  assert.equal(subagentCapabilitiesAreSubsetV2(effective, everything), true);
  assert.equal(subagentCapabilitiesAreSubsetV2(everything, effective), false);

  assert.deepEqual(
    resolveSubagentCapabilitiesV2({
      requested: everything,
      root: everything,
      parent: everything,
      role: everything,
      rollout: { ...rollout, workspaceWrite: true, shell: true },
      userGrant: everything,
      workspacePermission: "none",
      workspaceEgressApproval: "unavailable",
    }),
    {
      ...everything,
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: false,
      delegation: false,
      mcp: [],
    },
  );
});

test("randomized capability intersections can only preserve or narrow authority", () => {
  const random = seededRandom(0xa1de_0002);
  for (let iteration = 0; iteration < 512; iteration += 1) {
    const sources = {
      requested: randomCapabilitySet(random),
      root: randomCapabilitySet(random),
      parent: randomCapabilitySet(random),
      role: randomCapabilitySet(random),
      userGrant: randomCapabilitySet(random),
    };
    const randomizedRollout: SubagentRolloutPolicyV2 = {
      background: random() < 0.5,
      fork: random() < 0.5,
      workspaceWrite: random() < 0.5,
      shell: random() < 0.5,
      web: random() < 0.5,
      mcp: random() < 0.5,
      delegation: random() < 0.5,
    };
    const workspacePermission = random() < 0.25 ? "none" : random() < 0.5 ? "ask" : "full";
    const effective = resolveSubagentCapabilitiesV2({
      ...sources,
      rollout: randomizedRollout,
      workspacePermission,
      workspaceEgressApproval: "per_call",
    });
    for (const source of Object.values(sources)) {
      assert.equal(
        subagentCapabilitiesAreSubsetV2(effective, source),
        true,
        `iteration ${iteration} widened beyond an input ceiling`,
      );
    }

    const narrowedRoot = narrowCapabilities(sources.root, randomCapabilitySet(random));
    const afterNarrowing = resolveSubagentCapabilitiesV2({
      ...sources,
      root: narrowedRoot,
      rollout: randomizedRollout,
      workspacePermission,
      workspaceEgressApproval: "per_call",
    });
    assert.equal(
      subagentCapabilitiesAreSubsetV2(afterNarrowing, effective),
      true,
      `iteration ${iteration} gained authority after narrowing the root`,
    );
  }
});

test("randomized budget intersections never exceed any contributing ceiling", () => {
  const random = seededRandom(0xb0d6_e700);
  for (let iteration = 0; iteration < 512; iteration += 1) {
    const budgets = Array.from({ length: 2 + Math.floor(random() * 6) }, () => ({
      deadlineMs: 1 + Math.floor(random() * 86_400_000),
      maxTurns: 1 + Math.floor(random() * 128),
      maxToolCalls: 1 + Math.floor(random() * 512),
      maxOutputChars: 1 + Math.floor(random() * 1_000_000),
      maxTokens: 1 + Math.floor(random() * 10_000_000),
      maxLaunches: 1 + Math.floor(random() * 64),
      maxDepth: 1 + Math.floor(random() * 2),
      maxActive: 1 + Math.floor(random() * 32),
      maxQueued: 1 + Math.floor(random() * 32),
      maxNetworkOperations: 1 + Math.floor(random() * 512),
    }));
    const effective = intersectSubagentBudgetsV2(...budgets);
    for (const ceiling of budgets) {
      for (const key of Object.keys(effective) as Array<keyof SubagentBudgetV2>) {
        assert.ok(
          effective[key] <= ceiling[key],
          `iteration ${iteration} widened ${key} beyond a budget ceiling`,
        );
      }
    }
  }
});

test("exact MCP scopes intersect by server and tool identity", () => {
  const effective = resolveSubagentCapabilitiesV2({
    requested: everything,
    root: everything,
    parent: everything,
    role: everything,
    rollout: { ...rollout, mcp: true },
    userGrant: {
      ...everything,
      mcp: [mcpScope("linear", ["get_issue"])],
    },
    workspacePermission: "full",
    workspaceEgressApproval: "per_call",
  });
  assert.deepEqual(effective.mcp, [mcpScope("linear", ["get_issue"])]);
  assert.equal(subagentCapabilitiesAreSubsetV2(effective, everything), true);

  const drifted = resolveSubagentCapabilitiesV2({
    requested: everything,
    root: everything,
    parent: everything,
    role: everything,
    rollout: { ...rollout, mcp: true },
    userGrant: {
      ...everything,
      mcp: [
        {
          ...mcpScope("linear", ["get_issue"]),
          connectionFingerprint: "9".repeat(64),
        },
      ],
    },
    workspacePermission: "full",
    workspaceEgressApproval: "per_call",
  });
  assert.deepEqual(drifted.mcp, []);
});

test("mutating MCP authority binds every effect profile field and recomputed fingerprint", () => {
  const mutating = mcpScope("linear", ["update_issue"]);
  const tool = mutating.tools[0];
  assert.ok(tool?.effect === "mutating");
  const driftedProfile = {
    ...tool.effectProfile,
    destructive: "destructive" as const,
  };
  const drifted = {
    ...mutating,
    tools: [
      {
        ...tool,
        effectProfile: {
          ...driftedProfile,
          fingerprint: subagentMcpEffectProfileFingerprintV2(driftedProfile),
        },
      },
    ],
  };
  const effective = resolveSubagentCapabilitiesV2({
    requested: { ...everything, mcp: [mutating] },
    root: { ...everything, mcp: [mutating] },
    parent: { ...everything, mcp: [mutating] },
    role: { ...everything, mcp: [mutating] },
    rollout: { ...rollout, mcp: true },
    userGrant: { ...everything, mcp: [drifted] },
    workspacePermission: "full",
    workspaceEgressApproval: "per_call",
  });
  assert.deepEqual(effective.mcp, []);
  assert.throws(
    () =>
      parseSubagentLaunchRequestV2({
        ...request(),
        capabilities: {
          ...inspect,
          mcp: [
            {
              ...mutating,
              tools: [
                {
                  ...tool,
                  effectProfile: {
                    ...tool.effectProfile,
                    fingerprint: "0".repeat(64),
                  },
                },
              ],
            },
          ],
        },
      }),
    /stale|profile/u,
  );
});

test("workspace read plus any outbound capability requires a combined grant", () => {
  assert.throws(
    () =>
      resolveSubagentCapabilitiesV2({
        requested: everything,
        root: everything,
        parent: everything,
        role: everything,
        rollout: { ...rollout, web: true },
        userGrant: everything,
        workspacePermission: "full",
        workspaceEgressApproval: "unavailable",
      }),
    /combined grant/u,
  );
});

test("workspace write requires both rollout and a per-call approval grant", () => {
  const withoutApproval = resolveSubagentCapabilitiesV2({
    requested: everything,
    root: everything,
    parent: everything,
    role: everything,
    rollout: { ...rollout, workspaceWrite: true },
    userGrant: everything,
    workspacePermission: "full",
    workspaceEgressApproval: "unavailable",
  });
  assert.equal(withoutApproval.workspaceWrite, false);

  const approved = resolveSubagentCapabilitiesV2({
    requested: everything,
    root: everything,
    parent: everything,
    role: everything,
    rollout: { ...rollout, workspaceWrite: true },
    userGrant: everything,
    workspacePermission: "ask",
    workspaceEgressApproval: "per_call",
  });
  assert.equal(approved.workspaceWrite, true);
  assert.equal(approved.shell, false);
  assert.equal(approved.delegation, false);
});

test("rollout denies background and fork independently", () => {
  assertSubagentLaunchRolloutV2(request(), rollout);
  assert.throws(
    () => assertSubagentLaunchRolloutV2({ execution: "background", context: "fresh" }, rollout),
    /Background/u,
  );
  assert.throws(
    () => assertSubagentLaunchRolloutV2({ execution: "foreground", context: "fork" }, rollout),
    /Forked/u,
  );
});

test("authority records are deeply immutable and budgets only narrow", () => {
  const narrower = intersectSubagentBudgetsV2(budget, {
    ...budget,
    maxTurns: 10,
    maxDepth: 1,
  });
  assert.equal(narrower.maxTurns, 10);
  assert.equal(narrower.maxDepth, 1);
  const authority = createSubagentAuthorityV2({
    ...authorityInput(),
    budgets: narrower,
  });
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.capabilities), true);
  assert.equal(Object.isFrozen(authority.capabilities.mcp), true);
  assert.equal(Object.isFrozen(authority.budgets), true);
  assert.throws(
    () =>
      createSubagentAuthorityV2({
        ...authority,
        parentRunId: "run-parent",
        capabilities: inspect,
        budgets: narrower,
      }),
    /direct subagent/u,
  );
  assert.throws(
    () =>
      createSubagentAuthorityV2({
        ...authorityInput(),
        depth: 2,
        parentRunId: "run-1",
      }),
    /own parent/u,
  );
});

test("authority creation rejects every malformed or unknown thinking level", () => {
  for (const thinkingLevel of [undefined, null, "", "ultra", "HIGH", 1, {}, ["high"]]) {
    assert.throws(
      () =>
        createSubagentAuthorityV2({
          ...authorityInput(),
          thinkingLevel,
        } as never),
      /authority fields/u,
      `accepted malformed thinking level ${String(thinkingLevel)}`,
    );
  }

  for (const thinkingLevel of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    assert.equal(
      createSubagentAuthorityV2({ ...authorityInput(), thinkingLevel }).thinkingLevel,
      thinkingLevel,
    );
  }
});

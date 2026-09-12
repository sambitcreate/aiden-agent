import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import type { Workspace } from "../types.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";
import {
  createForegroundSubagentPersistenceV2,
  cumulativeSubagentTokenBudget,
} from "./subagent-foreground-persistence-v2.js";
import type { ProductionSubagentRunStore } from "./subagent-run-store-production.js";
import type { SubagentRunSnapshotV1 } from "../../../renderer/shared/subagent-runs.js";
import { SubagentControlMainV2 } from "./subagent-control-main.js";
import { subagentWorkspaceWriteAllowedForGeneration } from "./eligibility.js";
import { subagentMcpEffectProfileFingerprintV2 } from "./authority-v2.js";

function runtime(): ResolvedModelRuntime {
  return {
    models: createModels(),
    provider: {
      id: "provider-one",
      kind: "openai",
      label: "Provider One",
      baseUrl: "https://provider.invalid/v1",
      models: ["model-one"],
      needsKey: true,
      deployment: "hosted",
    },
    apiKey: undefined,
    headers: undefined,
    model: {
      id: "model-one",
      name: "Model One",
      provider: "provider-one",
      api: "openai-completions",
      baseUrl: "https://provider.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8_000,
    },
    streams: { streamSimple: (() => undefined) as never },
  };
}

const workspace: Workspace = {
  id: "workspace-one",
  name: "Workspace One",
  folderPath: "/private/workspace",
  permission: "ask",
  createdAt: 1,
  updatedAt: 2,
};

test("cumulative token budgets are separate from one-request context capacity", () => {
  assert.equal(cumulativeSubagentTokenBudget(128_000), 512_000);
  assert.equal(cumulativeSubagentTokenBudget(32_000), 128_000);
  assert.equal(cumulativeSubagentTokenBudget(4_000_000), 10_000_000);
  assert.equal(cumulativeSubagentTokenBudget(undefined), 4_000_000);
});

function store(
  selection: "v1" | "v2",
  writes: Array<{ snapshot: unknown; manifest: unknown }>,
): ProductionSubagentRunStore {
  return {
    selection,
    async reserveRun() {},
    releaseRunReservation() {},
    async upsert(snapshot: unknown, manifest?: unknown) {
      writes.push({ snapshot, manifest });
      return snapshot as never;
    },
  } as unknown as ProductionSubagentRunStore;
}

function input(productionStore: ProductionSubagentRunStore) {
  return {
    store: productionStore,
    generationId: "generation-one",
    chatId: "chat-one",
    workspace,
    runtime: runtime(),
    thinkingLevel: "high" as const,
    ownerDocumentId: "1:2:document-one",
    permission: "ask" as const,
    now: () => 1_000,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  };
}

test("V2 authority is synchronously prepared before the first durable projector write", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const persistence = createForegroundSubagentPersistenceV2(input(store("v2", writes)));
  const projector = new SubagentEventProjector({
    generationId: "generation-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    modelId: "model-one",
    now: () => 1_000,
    prepareSnapshot: persistence.prepare,
    onSnapshot: persistence.upsert,
  });

  await persistence.prepareRun({
    identity: { runId: "run-one", groupId: "group-one", childId: "child-one" },
    task: {
      role: "reviewer",
      label: "Review",
      task: "Review the production lifecycle.",
    },
    contextMode: "fresh",
    contextRevision: "a".repeat(64),
    deadlineMs: 5_000,
    stop: () => {},
  });
  projector.begin(
    { runId: "run-one", groupId: "group-one", childId: "child-one" },
    {
      role: "reviewer",
      label: "Review",
      task: "Review the production lifecycle.",
    },
  );
  await projector.flush();

  assert.equal(writes.length, 1);
  const snapshot = writes[0]!.snapshot as {
    version: number;
    authorityRevision: number;
  };
  const manifest = writes[0]!.manifest as {
    provenance: string;
    reusableAuthority: boolean;
    authority: {
      runId: string;
      ownerDocumentId: string;
      workspaceRevision: string;
      providerFingerprint: string;
      modelFingerprint: string;
      capabilities: Record<string, unknown>;
    };
  };
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.authorityRevision, 1);
  assert.equal(manifest.provenance, "v2_native");
  assert.equal(manifest.reusableAuthority, false);
  assert.equal(manifest.authority.runId, "run-one");
  assert.equal(manifest.authority.ownerDocumentId, "1:2:document-one");
  assert.match(manifest.authority.workspaceRevision, /^[a-f0-9]{64}$/u);
  assert.match(manifest.authority.providerFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(manifest.authority.modelFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.authority.capabilities, {
    workspaceRead: true,
    workspaceWrite: false,
    shell: false,
    web: false,
    delegation: false,
    mcp: [],
  });
  assert.equal(persistence.rendererSnapshot(projector.snapshot()[0]!).version, 2);
  assert.equal(
    (
      persistence.rendererSnapshot(projector.snapshot()[0]!) as {
        context: string;
      }
    ).context,
    "fresh",
  );
});

test("V2 rejects projection and persistence when launch preflight did not resolve authority", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const persistence = createForegroundSubagentPersistenceV2(input(store("v2", writes)));
  const snapshot: SubagentRunSnapshotV1 = {
    version: 1,
    runId: "run-one",
    groupId: "group-one",
    generationId: "generation-one",
    childId: "child-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review lifecycle",
    state: "queued",
    activity: "Waiting for an execution slot",
    startedAt: 1,
    updatedAt: 1,
    modelId: "model-one",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
  };

  await assert.rejects(persistence.upsert(snapshot), /not resolved before launch/u);
  assert.throws(() => persistence.prepare(snapshot), /not resolved before projection/u);
  assert.equal(writes.length, 0);
});

test("V1 rollback writes the exact legacy projection without constructing V2 authority", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const persistence = createForegroundSubagentPersistenceV2(input(store("v1", writes)));
  const projector = new SubagentEventProjector({
    generationId: "generation-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    modelId: "model-one",
    now: () => 1_000,
    prepareSnapshot: persistence.prepare,
    onSnapshot: persistence.upsert,
  });

  await persistence.prepareRun({
    identity: { runId: "run-one", groupId: "group-one", childId: "child-one" },
    task: { role: "reviewer", label: "Review", task: "Review rollback." },
    contextMode: "fresh",
    contextRevision: "fresh",
    deadlineMs: 5_000,
    stop: () => {},
  });
  projector.begin(
    { runId: "run-one", groupId: "group-one", childId: "child-one" },
    { role: "reviewer", label: "Review", task: "Review rollback." },
  );
  await projector.flush();

  assert.equal((writes[0]!.snapshot as { version: number }).version, 1);
  assert.equal(writes[0]!.manifest, undefined);
});

test("V2 grants requested foreground write only with rollout, writable permission, and approval", async () => {
  for (const permission of ["ask", "full"] as const) {
    const persistence = createForegroundSubagentPersistenceV2({
      ...input(store("v2", [])),
      permission,
      writeEnabled: true,
      requestApproval: async () => true,
      currentWorkspace: async () => ({ ...workspace, permission }),
      validateWorkspace: async () => {},
    });
    const prepared = await persistence.prepareRun({
      identity: {
        runId: `run-${permission}`,
        groupId: `group-${permission}`,
        childId: `child-${permission}`,
      },
      task: {
        role: "reviewer",
        label: "Write",
        task: "Prepare a bounded edit.",
      },
      contextMode: "fresh",
      contextRevision: "d".repeat(64),
      deadlineMs: 5_000,
      requestedCapabilities: {
        workspaceRead: true,
        workspaceWrite: true,
        web: false,
        mcp: [],
      },
      stop: () => {},
    });
    assert.equal(prepared.authority?.capabilities.workspaceWrite, true);
    assert.equal(prepared.authority?.capabilities.shell, false);
    assert.equal(prepared.authority?.capabilities.delegation, false);
    const broker = prepared.prepareWorkspaceWriteApproval?.(
      [{ toolName: "write_file", operation: "write" }],
      new AbortController().signal,
    );
    assert.ok(broker);
    await broker.shutdown();
  }
});

test("stored full workspace cannot grant write above an effective read-only parent", async () => {
  const fullWorkspace: Workspace = { ...workspace, permission: "full" };
  const writeEnabled = subagentWorkspaceWriteAllowedForGeneration({
    subagentsAllowed: true,
    childWriteRollout: true,
    v2StoreSelected: true,
    workspacePermission: fullWorkspace.permission,
    generationPermission: "read-only",
  });
  const persistence = createForegroundSubagentPersistenceV2({
    ...input(store("v2", [])),
    workspace: fullWorkspace,
    permission: fullWorkspace.permission,
    writeEnabled,
    requestApproval: async () => true,
    currentWorkspace: async () => fullWorkspace,
    validateWorkspace: async () => {},
  });
  const prepared = await persistence.prepareRun({
    identity: {
      runId: "run-read-only-parent",
      groupId: "group-read-only-parent",
      childId: "child-read-only-parent",
    },
    task: { role: "reviewer", label: "Read", task: "Inspect without writing." },
    contextMode: "fresh",
    contextRevision: "9".repeat(64),
    deadlineMs: 5_000,
    stop: () => {},
  });
  assert.equal(writeEnabled, false);
  assert.equal(prepared.authority?.capabilities.workspaceRead, true);
  assert.equal(prepared.authority?.capabilities.workspaceWrite, false);
});

test("write requests fail closed during flag-off and V1 rollback", async () => {
  const request = {
    identity: {
      runId: "run-write",
      groupId: "group-write",
      childId: "child-write",
    },
    task: {
      role: "reviewer" as const,
      label: "Write",
      task: "Prepare a bounded edit.",
    },
    contextMode: "fresh" as const,
    contextRevision: "e".repeat(64),
    deadlineMs: 5_000,
    requestedCapabilities: {
      workspaceRead: true,
      workspaceWrite: true,
      web: false,
      mcp: [],
    },
    stop: () => {},
  };
  await assert.rejects(
    createForegroundSubagentPersistenceV2({
      ...input(store("v2", [])),
      requestApproval: async () => true,
    }).prepareRun(request),
    /workspace-write capability is unavailable/u,
  );
  await assert.rejects(
    createForegroundSubagentPersistenceV2({
      ...input(store("v1", [])),
      requestApproval: async () => true,
    }).prepareRun(request),
    /unavailable during V1 rollback/u,
  );
});

test("MCP mutation requests require V2, the independent rollout, approval, and a host", async () => {
  const facts = {
    classification: "declared_mutating" as const,
    destructive: "unknown" as const,
    idempotency: "not_declared" as const,
    openWorld: "unknown" as const,
    taskSupport: "forbidden" as const,
  };
  const mcpInventory = [
    {
      serverId: "docs",
      connectionFingerprint: "a".repeat(64),
      tools: [
        {
          toolName: "publish",
          schemaHash: "b".repeat(64),
          effect: "mutating" as const,
          effectProfile: {
            ...facts,
            fingerprint: subagentMcpEffectProfileFingerprintV2(facts),
          },
        },
      ],
    },
  ];
  const request = {
    identity: {
      runId: "run-mutation",
      groupId: "group-mutation",
      childId: "child-mutation",
    },
    task: {
      role: "reviewer" as const,
      label: "Publish",
      task: "Publish once.",
    },
    contextMode: "fresh" as const,
    contextRevision: "5".repeat(64),
    deadlineMs: 5_000,
    requestedCapabilities: {
      workspaceRead: false,
      workspaceWrite: false,
      web: false,
      mcp: [],
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
    stop: () => {},
  };
  for (const candidate of [
    createForegroundSubagentPersistenceV2({
      ...input(store("v2", [])),
      mcpInventory,
      requestApproval: async () => true,
    }),
    createForegroundSubagentPersistenceV2({
      ...input(store("v2", [])),
      mcpInventory,
      mcpMutationsEnabled: true,
      requestApproval: async () => true,
    }),
  ]) {
    await assert.rejects(candidate.prepareRun(request), /MCP mutation capability is unavailable/u);
  }
  await assert.rejects(
    createForegroundSubagentPersistenceV2({
      ...input(store("v1", [])),
      mcpInventory,
      mcpMutationsEnabled: true,
      mcpMutationHost: {
        openFreshSession: async () => Promise.reject(new Error("unused")),
      },
      requestApproval: async () => true,
    }).prepareRun(request),
    /unavailable during V1 rollback/u,
  );
  const prepared = await createForegroundSubagentPersistenceV2({
    ...input(store("v2", [])),
    mcpInventory,
    mcpMutationsEnabled: true,
    mcpMutationHost: {
      openFreshSession: async () => Promise.reject(new Error("unused")),
    },
    requestApproval: async () => true,
  }).prepareRun(request);
  assert.equal(prepared.authority?.capabilities.mcp[0]?.tools[0]?.effect, "mutating");
  assert.equal(typeof prepared.prepareMcpMutationApproval, "function");
});

test("write requests fail instead of downgrading without approval or writable permission", async () => {
  for (const [label, permission, requestApproval] of [
    ["missing", "ask", undefined],
    ["null", "ask", null as never],
    ["non-function", "ask", "allow" as never],
    ["permission", "none", async () => true],
  ] as const) {
    const persistence = createForegroundSubagentPersistenceV2({
      ...input(store("v2", [])),
      permission,
      writeEnabled: true,
      requestApproval,
    });
    await assert.rejects(
      persistence.prepareRun({
        identity: {
          runId: `run-${label}`,
          groupId: "group-write",
          childId: `child-${permission}`,
        },
        task: {
          role: "reviewer",
          label: "Write",
          task: "Prepare a bounded edit.",
        },
        contextMode: "fresh",
        contextRevision: "f".repeat(64),
        deadlineMs: 5_000,
        requestedCapabilities: {
          workspaceRead: true,
          workspaceWrite: true,
          web: false,
          mcp: [],
        },
        stop: () => {},
      }),
      /workspace-write capability is unavailable/u,
    );
  }
});

test("shell requests require V2, rollout, helper, permission, and approval without downgrading", async () => {
  const request = {
    identity: {
      runId: "run-shell",
      groupId: "group-shell",
      childId: "child-shell",
    },
    task: {
      role: "reviewer" as const,
      label: "Shell",
      task: "Run an approved command.",
    },
    contextMode: "fresh" as const,
    contextRevision: "e".repeat(64),
    deadlineMs: 5_000,
    requestedCapabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: true,
      web: false,
      mcp: [],
    },
    stop: () => {},
  };
  for (const overrides of [
    {},
    { shellEnabled: true },
    { shellEnabled: true, shellBinary: "/private/helper" },
  ]) {
    await assert.rejects(
      createForegroundSubagentPersistenceV2({
        ...input(store("v2", [])),
        ...overrides,
      }).prepareRun(request),
      /shell capability is unavailable/u,
    );
  }
  await assert.rejects(
    createForegroundSubagentPersistenceV2({
      ...input(store("v1", [])),
      shellEnabled: true,
      shellBinary: "/private/helper",
      requestApproval: async () => true,
      currentWorkspace: async () => workspace,
      validateWorkspace: async () => {},
    }).prepareRun(request),
    /unavailable during V1 rollback/u,
  );
  const prepared = await createForegroundSubagentPersistenceV2({
    ...input(store("v2", [])),
    shellEnabled: true,
    shellBinary: "/private/helper",
    requestApproval: async () => true,
    currentWorkspace: async () => workspace,
    validateWorkspace: async () => {},
  }).prepareRun(request);
  assert.equal(prepared.authority?.capabilities.shell, true);
  assert.equal(typeof prepared.prepareShellApproval, "function");
});

test("control snapshots reuse immutable authority and settle canonical persistence before acknowledgement", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const persistence = createForegroundSubagentPersistenceV2(input(store("v2", writes)));
  const identity = {
    runId: "run-one",
    groupId: "group-one",
    childId: "child-one",
  };
  await persistence.prepareRun({
    identity,
    task: { role: "reviewer", label: "Review", task: "Review control." },
    contextMode: "fork",
    contextRevision: "b".repeat(64),
    deadlineMs: 4_000,
    stop: () => {},
  });
  const projector = new SubagentEventProjector({
    generationId: "generation-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    modelId: "model-one",
    now: () => 1_000,
    prepareSnapshot: persistence.prepare,
    onSnapshot: persistence.upsert,
  });
  projector.begin(identity, {
    role: "reviewer",
    label: "Review",
    task: "Review control.",
  });
  await projector.flush();
  const queued = writes[0]!.snapshot as Record<string, unknown>;
  const stopped = {
    ...queued,
    revision: 2,
    state: "stopped",
    activity: undefined,
    updatedAt: 1_001,
    finishedAt: 1_001,
  } as never;

  const projection = persistence.projectControlSnapshot(stopped);
  assert.equal(projection.version, 1);
  assert.equal(projection.state, "interrupted");
  await persistence.flushControlPersistence();

  assert.equal(writes.length, 2);
  assert.equal(
    (writes[0]!.manifest as { authority: unknown }).authority,
    (writes[1]!.manifest as { authority: unknown }).authority,
  );
  assert.equal(
    (writes[1]!.manifest as { authority: { context: string } }).authority.context,
    "fork",
  );
});

test("production registration makes stop durable, renderer-safe, and immune to late telemetry", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const controls = new SubagentControlMainV2({ now: () => 1_001 });
  const delivered: SubagentRunSnapshotV1[] = [];
  let projector!: SubagentEventProjector;
  let stopped = 0;
  const persistence = createForegroundSubagentPersistenceV2({
    ...input(store("v2", writes)),
    control: controls,
    applyControlSnapshot: (snapshot) => projector.applyControlSnapshot(snapshot),
    settleControlSnapshots: () => projector.flush(),
    onControlSnapshot: (snapshot) => delivered.push(snapshot),
  });
  projector = new SubagentEventProjector({
    generationId: "generation-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    modelId: "model-one",
    now: () => 1_000,
    prepareSnapshot: persistence.prepare,
    onSnapshot: persistence.upsert,
    onControlSnapshot: async (snapshot) => {
      persistence.projectControlSnapshot(snapshot);
      await persistence.flushControlPersistence();
    },
  });
  const identity = {
    runId: "run-one",
    groupId: "group-one",
    childId: "child-one",
  };
  const prepared = await persistence.prepareRun({
    identity,
    task: {
      role: "reviewer",
      label: "Review",
      task: "Review production stop.",
    },
    contextMode: "fresh",
    contextRevision: "c".repeat(64),
    deadlineMs: 5_000,
    stop: () => {
      stopped += 1;
    },
  });
  projector.begin(identity, {
    role: "reviewer",
    label: "Review",
    task: "Review production stop.",
  });
  await projector.flush();
  projector.starting(identity.runId);
  await projector.flush();

  const result = await controls.executeForDocument(
    {
      chatId: "chat-one",
      workspaceId: "workspace-one",
      ownerDocumentId: "1:2:document-one",
    },
    { version: 2, action: "stop", runId: "run-one" },
  );
  await Promise.resolve();

  assert.equal(result.action, "stop");
  assert.equal(stopped, 1);
  assert.equal(await prepared.complete(), "stopped");
  projector.running(identity.runId);
  projector.finish(identity.runId, {
    role: "reviewer",
    label: "Review",
    status: "completed",
    summary: "Late completion.",
  });
  await projector.flush();

  assert.equal(projector.snapshot()[0]!.state, "interrupted");
  assert.equal(delivered[delivered.length - 1]?.state, "interrupted");
  assert.equal((writes[writes.length - 1]!.snapshot as { state: string }).state, "stopped");
});

test("Phase 6B mints one fresh depth-2 authority from an exact live parent and persists lineage", async () => {
  const writes: Array<{ snapshot: unknown; manifest: unknown }> = [];
  const persistence = createForegroundSubagentPersistenceV2({
    ...input(store("v2", writes)),
    delegationEnabled: true,
    currentWorkspace: async () => workspace,
    validateWorkspace: async () => {},
  });
  const parent = await persistence.prepareRun({
    identity: {
      runId: "run-parent",
      groupId: "group-tree",
      childId: "child-parent",
    },
    task: {
      role: "planner",
      label: "Plan",
      task: "Plan and delegate one bounded check.",
    },
    contextMode: "fresh",
    contextRevision: "1".repeat(64),
    deadlineMs: 5_000,
    requestedCapabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      web: false,
      mcp: [],
      delegate: true,
    },
    stop: () => {},
  });
  assert.equal(parent.authority?.depth, 1);
  assert.equal(parent.authority?.capabilities.delegation, true);

  const nested = await persistence.prepareRun({
    identity: {
      runId: "run-nested",
      groupId: "group-tree",
      childId: "child-nested",
    },
    task: { role: "scout", label: "Check", task: "Check one narrow fact." },
    contextMode: "fresh",
    contextRevision: "2".repeat(64),
    deadlineMs: 4_000,
    requestedCapabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      web: false,
      mcp: [],
      delegate: false,
    },
    parentAuthority: parent.authority,
    stop: () => {},
  });
  assert.equal(nested.authority?.depth, 2);
  assert.equal(nested.authority?.parentRunId, "run-parent");
  assert.equal(nested.authority?.treeRootId, parent.authority?.treeRootId);
  assert.equal(nested.authority?.capabilities.delegation, false);

  const projector = new SubagentEventProjector({
    generationId: "generation-one",
    chatId: "chat-one",
    workspaceId: "workspace-one",
    modelId: "model-one",
    now: () => 1_000,
    prepareSnapshot: persistence.prepare,
    onSnapshot: persistence.upsert,
  });
  projector.begin(
    { runId: "run-nested", groupId: "group-tree", childId: "child-nested" },
    { role: "scout", label: "Check", task: "Check one narrow fact." },
  );
  await projector.flush();
  assert.equal((writes[0]!.snapshot as { parentRunId?: string }).parentRunId, "run-parent");
  assert.equal(
    (writes[0]!.manifest as { authority: { parentRunId?: string } }).authority.parentRunId,
    "run-parent",
  );

  const nestedFork = await persistence.prepareRun({
    identity: {
      runId: "run-fork",
      groupId: "group-tree",
      childId: "child-fork",
    },
    task: { role: "scout", label: "Fork", task: "Attempt a nested fork." },
    contextMode: "fork",
    contextRevision: "3".repeat(64),
    deadlineMs: 4_000,
    parentAuthority: parent.authority,
    stop: () => {},
  });
  assert.equal(nestedFork.authority?.context, "fork");
  assert.equal(nestedFork.authority?.contextRevision, "3".repeat(64));
  assert.equal(nestedFork.authority?.parentRunId, parent.authority?.runId);
  assert.equal(nestedFork.authority?.workspaceId, parent.authority?.workspaceId);
  assert.equal(nestedFork.authority?.workspaceRevision, parent.authority?.workspaceRevision);
  await nestedFork.complete();
  await parent.complete();
  await assert.rejects(
    persistence.prepareRun({
      identity: {
        runId: "run-stale",
        groupId: "group-tree",
        childId: "child-stale",
      },
      task: {
        role: "scout",
        label: "Stale",
        task: "Attempt stale delegation.",
      },
      contextMode: "fresh",
      contextRevision: "4".repeat(64),
      deadlineMs: 4_000,
      parentAuthority: parent.authority,
      stop: () => {},
    }),
    /stale, revoked, or ineligible/u,
  );
});

test("Phase 6B rejects every nested capability escalation instead of silently downgrading", async () => {
  const effectFacts = {
    classification: "declared_mutating" as const,
    destructive: "unknown" as const,
    idempotency: "not_declared" as const,
    openWorld: "unknown" as const,
    taskSupport: "forbidden" as const,
  };
  const mcpInventory = [
    {
      serverId: "docs",
      connectionFingerprint: "a".repeat(64),
      tools: [
        {
          toolName: "read",
          schemaHash: "b".repeat(64),
          effect: "read" as const,
        },
        {
          toolName: "publish",
          schemaHash: "c".repeat(64),
          effect: "mutating" as const,
          effectProfile: {
            ...effectFacts,
            fingerprint: subagentMcpEffectProfileFingerprintV2(effectFacts),
          },
        },
      ],
    },
  ];
  const persistence = createForegroundSubagentPersistenceV2({
    ...input(store("v2", [])),
    delegationEnabled: true,
    writeEnabled: true,
    shellEnabled: true,
    shellBinary: "/private/helper",
    webEnabled: true,
    mcpInventory,
    mcpMutationsEnabled: true,
    mcpMutationHost: {
      openFreshSession: async () => Promise.reject(new Error("unused")),
    },
    requestApproval: async () => true,
    currentWorkspace: async () => workspace,
    validateWorkspace: async () => {},
  });
  const parent = await persistence.prepareRun({
    identity: {
      runId: "run-narrow-parent",
      groupId: "group-narrow",
      childId: "child-parent",
    },
    task: {
      role: "planner",
      label: "Delegate",
      task: "Delegate without data authority.",
    },
    contextMode: "fresh",
    contextRevision: "5".repeat(64),
    deadlineMs: 5_000,
    requestedCapabilities: {
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: false,
      mcp: [],
      delegate: true,
    },
    stop: () => {},
  });
  const escalations = [
    {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: false,
      mcp: [],
    },
    {
      workspaceRead: false,
      workspaceWrite: true,
      shell: false,
      web: false,
      mcp: [],
    },
    {
      workspaceRead: false,
      workspaceWrite: false,
      shell: true,
      web: false,
      mcp: [],
    },
    {
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: true,
      mcp: [],
    },
    {
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: false,
      mcp: [{ serverId: "docs", tools: ["read"] }],
    },
    {
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: false,
      mcp: [],
      mcpMutations: [{ serverId: "docs", tools: ["publish"] }],
    },
  ];
  for (const [index, requestedCapabilities] of escalations.entries()) {
    await assert.rejects(
      persistence.prepareRun({
        identity: {
          runId: `run-escalation-${index}`,
          groupId: "group-narrow",
          childId: `child-escalation-${index}`,
        },
        task: {
          role: "scout",
          label: `Escalation ${index}`,
          task: "Attempt widening.",
        },
        contextMode: "fresh",
        contextRevision: "6".repeat(64),
        deadlineMs: 4_000,
        requestedCapabilities,
        parentAuthority: parent.authority,
        stop: () => {},
      }),
      /cannot widen its parent capability ceiling/u,
    );
  }
});

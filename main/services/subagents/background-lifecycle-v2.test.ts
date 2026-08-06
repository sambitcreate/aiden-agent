import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV2 } from "../../../renderer/shared/subagent-runs.js";
import {
  createSubagentAuthorityV2,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import {
  BackgroundSubagentLifecycleV2,
  MAX_BACKGROUND_STEERS_V2,
  parseBackgroundSubagentManagementRequestV2,
  type BackgroundSubagentRunV2,
  type BackgroundSubagentStoreV2,
} from "./background-lifecycle-v2.js";

class MemoryStore implements BackgroundSubagentStoreV2 {
  records = new Map<string, BackgroundSubagentRunV2>();
  fail = false;
  rejectCas = false;
  async get(runId: string) {
    return structuredClone(this.records.get(runId) ?? null);
  }
  async put(run: BackgroundSubagentRunV2, expectedRevision: number | null) {
    if (this.fail) throw new Error("durability failed");
    if (this.rejectCas && expectedRevision !== null) return false;
    const current = this.records.get(run.snapshot.runId);
    if (
      expectedRevision === null
        ? current !== undefined
        : current?.snapshot.revision !== expectedRevision
    )
      return false;
    this.records.set(run.snapshot.runId, structuredClone(run));
    return true;
  }
  async list() {
    return structuredClone([...this.records.values()]);
  }
}

function authority(
  extra: Partial<SubagentAuthorityV2> = {},
): SubagentAuthorityV2 {
  return createSubagentAuthorityV2({
    grantId: "grant-background",
    treeRootId: "run-background",
    runId: "run-background",
    depth: 1,
    authorityRevision: 3,
    generationId: "generation-background",
    chatId: "chat-background",
    workspaceId: "workspace-background",
    workspaceRevision: "a".repeat(64),
    ownerDocumentId: "1:2:background",
    providerFingerprint: "b".repeat(64),
    modelFingerprint: "c".repeat(64),
    contextRevision: "d".repeat(64),
    execution: "background",
    context: "fresh",
    thinkingLevel: "high",
    capabilities: {
      workspaceRead: true,
      workspaceWrite: false,
      shell: false,
      web: false,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 30_000,
      maxTurns: 8,
      maxToolCalls: 32,
      maxOutputChars: 64_000,
      maxTokens: 64_000,
      maxLaunches: 1,
      maxDepth: 1,
      maxActive: 1,
      maxQueued: 1,
      maxNetworkOperations: 1,
    },
    expiresAt: 99_000_000_000_000,
    ...extra,
  });
}

function snapshot(auth = authority()): SubagentRunSnapshotV2 {
  return {
    version: 2,
    runId: auth.runId,
    groupId: "group-background",
    generationId: auth.generationId,
    childId: "child-background",
    chatId: auth.chatId,
    workspaceId: auth.workspaceId,
    revision: 1,
    role: "scout",
    label: "Background scout",
    taskPreview: "Inspect later",
    state: "queued",
    activity: "Queued",
    startedAt: 10,
    updatedAt: 10,
    modelId: "model",
    turns: 0,
    tools: 0,
    tokens: 0,
    warnings: [],
    depth: 1,
    execution: "background",
    context: "fresh",
    authorityRevision: auth.authorityRevision,
  };
}

function request(action: "status" | "wait" | "stop" | "steer", revision = 1) {
  return {
    version: 2,
    action,
    runId: "run-background",
    chatId: "chat-background",
    workspaceId: "workspace-background",
    ownerDocumentId: "1:2:background",
    authorityRevision: 3,
    expectedRevision: revision,
    ...(action === "wait" ? { timeoutMs: 100 } : {}),
    ...(action === "steer"
      ? { instruction: "Focus on the newest evidence." }
      : {}),
  };
}

test("acceptance is acknowledged only after durable queued evidence", async () => {
  const store = new MemoryStore();
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => 20);
  store.fail = true;
  await assert.rejects(
    lifecycle.accept({
      authority: authority(),
      snapshot: snapshot(),
      task: "Inspect later",
    }),
    /durability failed/u,
  );
  store.fail = false;
  assert.deepEqual(
    await lifecycle.accept({
      authority: authority(),
      snapshot: snapshot(),
      task: "Inspect later",
    }),
    {
      accepted: true,
      runId: "run-background",
      revision: 1,
      state: "queued",
    },
  );
  assert.equal(
    store.records.get("run-background")?.events[0]?.kind,
    "accepted",
  );
});

test("Phase 7A denies fork, outbound, mutation, shell, write, and delegation authority", async () => {
  for (const bad of [
    authority({ context: "fork" }),
    authority({
      capabilities: { ...authority().capabilities, workspaceWrite: true },
    }),
    authority({ capabilities: { ...authority().capabilities, shell: true } }),
    authority({ capabilities: { ...authority().capabilities, web: true } }),
    authority({
      capabilities: { ...authority().capabilities, delegation: true },
    }),
  ]) {
    await assert.rejects(
      new BackgroundSubagentLifecycleV2(new MemoryStore()).accept({
        authority: bad,
        snapshot: snapshot(bad),
        task: "No",
      }),
      /fresh, depth-1, and read-only/u,
    );
  }
});

test("strict management parsing rejects unknown fields and stale owner bindings", async () => {
  assert.throws(
    () =>
      parseBackgroundSubagentManagementRequestV2({
        ...request("status"),
        retry: true,
      }),
    /fields/u,
  );
  const store = new MemoryStore();
  const lifecycle = new BackgroundSubagentLifecycleV2(store);
  await lifecycle.accept({
    authority: authority(),
    snapshot: snapshot(),
    task: "Inspect later",
  });
  for (const drift of [
    { chatId: "chat-other" },
    { workspaceId: "workspace-other" },
    { ownerDocumentId: "other" },
    { authorityRevision: 4 },
    { expectedRevision: 2 },
  ])
    await assert.rejects(
      lifecycle.manage({ ...request("status"), ...drift }),
      /ownership or revision/u,
    );
});

test("state machine permits needs-attention recovery and terminal unknown but rejects skips", async () => {
  const store = new MemoryStore();
  let clock = 20;
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => ++clock);
  await lifecycle.accept({
    authority: authority(),
    snapshot: snapshot(),
    task: "Inspect later",
  });
  await assert.rejects(
    lifecycle.transition(request("status"), "running", "Running"),
    /Invalid/u,
  );
  let run = await lifecycle.transition(
    request("status"),
    "starting",
    "Starting",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "running",
    "Running",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "needs_attention",
    "Needs attention.",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "running",
    "Resumed",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "unknown",
    "Outcome could not be proven.",
  );
  assert.equal(run.snapshot.state, "unknown");
  assert.ok(run.snapshot.finishedAt);
});

test("wait and steer are durable, bounded, and state constrained", async () => {
  const store = new MemoryStore();
  const lifecycle = new BackgroundSubagentLifecycleV2(store);
  await lifecycle.accept({
    authority: authority(),
    snapshot: snapshot(),
    task: "Inspect later",
  });
  await assert.rejects(
    lifecycle.manage(request("steer")),
    /cannot be steered/u,
  );
  let run = await lifecycle.transition(
    request("status"),
    "starting",
    "Starting",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "running",
    "Running",
  );
  run = await lifecycle.manage(request("wait", run.snapshot.revision));
  assert.equal(run.waitCount, 1);
  assert.equal(run.waitedMs, 100);
  for (let index = 0; index < MAX_BACKGROUND_STEERS_V2; index += 1) {
    run = await lifecycle.manage(request("steer", run.snapshot.revision));
  }
  await assert.rejects(
    lifecycle.manage(request("steer", run.snapshot.revision)),
    /ledger is full/u,
  );
});

test("startup, deletion, revocation, shutdown, and explicit stop durably terminalize active work", async () => {
  for (const action of [
    "startup",
    "chat",
    "workspace",
    "shutdown",
    "stop",
  ] as const) {
    const store = new MemoryStore();
    const stopped: string[] = [];
    const lifecycle = new BackgroundSubagentLifecycleV2(store, {
      stop: (_id, reason) => stopped.push(reason),
    });
    await lifecycle.accept({
      authority: authority(),
      snapshot: snapshot(),
      task: "Inspect later",
    });
    if (action === "startup") await lifecycle.reconcileStartup();
    if (action === "chat") await lifecycle.chatDeleted("chat-background");
    if (action === "workspace")
      await lifecycle.workspaceRevoked("workspace-background");
    if (action === "shutdown") await lifecycle.shutdown();
    if (action === "stop") await lifecycle.manage(request("stop"));
    const saved = store.records.get("run-background")!;
    assert.equal(
      action === "startup" || action === "shutdown"
        ? saved.snapshot.state
        : saved.snapshot.state,
      action === "startup" || action === "shutdown" ? "interrupted" : "stopped",
    );
    assert.equal(stopped.length, 1);
  }
});

test("CAS rejects stale concurrent management before hooks and hook failure becomes unknown", async () => {
  const store = new MemoryStore();
  let steers = 0;
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {
    steer: () => {
      steers += 1;
      throw new Error("hook failed");
    },
  });
  await lifecycle.accept({
    authority: authority(),
    snapshot: snapshot(),
    task: "Inspect later",
  });
  let run = await lifecycle.transition(
    request("status"),
    "starting",
    "Starting",
  );
  run = await lifecycle.transition(
    request("status", run.snapshot.revision),
    "running",
    "Running",
  );
  store.rejectCas = true;
  await assert.rejects(
    lifecycle.manage(request("steer", run.snapshot.revision)),
    /revision changed/u,
  );
  assert.equal(steers, 0, "hook cannot run before durable CAS");
  store.rejectCas = false;
  await lifecycle.manage(request("steer", run.snapshot.revision));
  assert.equal(steers, 1);
  assert.equal(store.records.get("run-background")?.snapshot.state, "unknown");
});

test("required stop remains durable when the bounded event ledger is full", async () => {
  const store = new MemoryStore();
  const lifecycle = new BackgroundSubagentLifecycleV2(store);
  await lifecycle.accept({
    authority: authority(),
    snapshot: snapshot(),
    task: "Inspect later",
  });
  const stored = store.records.get("run-background")!;
  stored.events = Array.from({ length: 128 }, (_, index) => ({
    sequence: index + 1,
    at: index,
    kind: "wait" as const,
    state: "queued" as const,
  }));
  store.records.set(stored.snapshot.runId, stored);
  const stopped = await lifecycle.manage(request("stop"));
  assert.equal(stopped.snapshot.state, "stopped");
  assert.equal(stopped.events.length, 128);
  assert.equal(stopped.events[stopped.events.length - 1]?.state, "stopped");
});

test("acceptance rejects expiry and parent lineage while sanitizing durable visible text", async () => {
  const expired = authority({ expiresAt: 19 });
  await assert.rejects(
    new BackgroundSubagentLifecycleV2(new MemoryStore(), {}, () => 20).accept({
      authority: expired,
      snapshot: snapshot(expired),
      task: "Expired",
    }),
    /launch acceptance/u,
  );
  await assert.rejects(
    new BackgroundSubagentLifecycleV2(new MemoryStore(), {}, () => 20).accept({
      authority: authority(),
      snapshot: { ...snapshot(), depth: 2, parentRunId: "run-parent" },
      task: "Wrong lineage",
    }),
    /launch acceptance/u,
  );
  const store = new MemoryStore();
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => 20);
  await lifecycle.accept({
    authority: authority(),
    snapshot: {
      ...snapshot(),
      label: "Safe\u202Ename",
      activity: "Queued\u0000control",
    },
    task: "Task\u202Ewith bidi",
  });
  const serialized = JSON.stringify(store.records.get("run-background"));
  assert.doesNotMatch(serialized, /\u202e/iu);
  assert.equal(serialized.includes("\0"), false);
});

test("expiry blocks fresh execution transitions but never owner stop", async () => {
  const store = new MemoryStore();
  let clock = 20;
  const auth = authority({ expiresAt: 21 });
  const lifecycle = new BackgroundSubagentLifecycleV2(store, {}, () => clock);
  await lifecycle.accept({
    authority: auth,
    snapshot: snapshot(auth),
    task: "Expire safely",
  });
  clock = 22;
  await assert.rejects(
    lifecycle.transition(request("status"), "starting", "Starting"),
    /expired/u,
  );
  const stopped = await lifecycle.manage(request("stop"));
  assert.equal(stopped.snapshot.state, "stopped");
});

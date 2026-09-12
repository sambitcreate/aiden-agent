import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
  DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
  DESIGN_HANDOFF_JOURNAL_VERSION,
  DESIGN_HANDOFF_PACKET_VERSION,
  type DesignHandoffJournalRecordV1,
  type DesignHandoffPacketV1,
  type DesignHandoffTarget,
  designHandoffTargetPreviewDigest,
  parseDesignHandoffJournalDocument,
  parseDesignHandoffPacket,
  parseDesignHandoffTarget,
} from "./design-handoff-contract.js";
import {
  assertDesignHandoffTransition,
  createDesignHandoffCoordinator,
  type DesignHandoffEffectPorts,
  type DesignHandoffRollbackResult,
} from "./design-handoff-coordinator.js";
import {
  DesignHandoffJournalConflictError,
  type DesignHandoffJournalPort,
} from "./design-handoff-journal-store.js";

function packet(): DesignHandoffPacketV1 {
  return {
    version: DESIGN_HANDOFF_PACKET_VERSION,
    projectId: "project-1",
    projectRevision: 7,
    source: {
      bundleId: "bundle-1",
      lineageId: "lineage-1",
      revisionId: "revision-4",
      sha256: "a".repeat(64),
      byteSize: 8192,
    },
    referenceAssetIds: ["asset-1", "asset-2"],
    designDecisions: [{ id: "decision-1", summary: "Use the compact navigation at phone width" }],
    responsiveStates: [
      { viewport: "desktop", width: 1440, height: 900 },
      { viewport: "phone", width: 390, height: 844 },
    ],
  };
}

function preview(workspaceId = "workspace-source") {
  return {
    workspaceId,
    workspaceLabel: "Aiden",
    repositoryLabel: "aiden-agent",
    branchLabel: "main",
  };
}

function managedTarget(dirtyCheckout = true): DesignHandoffTarget {
  const source = preview();
  return {
    kind: "managed-worktree",
    source,
    previewDigest: designHandoffTargetPreviewDigest(source),
    expectedCommittedHead: "b".repeat(40),
    dirtyCheckout,
    ...(dirtyCheckout
      ? { dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT }
      : {}),
  };
}

class MemoryJournal implements DesignHandoffJournalPort {
  readonly records = new Map<string, DesignHandoffJournalRecordV1>();
  failAfterStage: string | null = null;

  async get(operationId: string) {
    return structuredClone(this.records.get(operationId) ?? null);
  }

  async create(record: DesignHandoffJournalRecordV1) {
    const current = this.records.get(record.operationId);
    if (current) {
      if (JSON.stringify(current.packet) !== JSON.stringify(record.packet)) throw new DesignHandoffJournalConflictError();
      return structuredClone(current);
    }
    this.records.set(record.operationId, structuredClone(record));
    return structuredClone(record);
  }

  async replace(operationId: string, expectedRevision: number, next: DesignHandoffJournalRecordV1) {
    const current = this.records.get(operationId);
    if (!current || current.revision !== expectedRevision) throw new DesignHandoffJournalConflictError();
    if (this.failAfterStage === next.stage) {
      this.failAfterStage = null;
      throw new Error(`simulated crash before ${next.stage} checkpoint`);
    }
    this.records.set(operationId, structuredClone(next));
    return structuredClone(next);
  }

  async listRecoverable() {
    return [...this.records.values()].filter(({ stage }) => stage !== "published" && stage !== "rolled-back").map((entry) => structuredClone(entry));
  }
}

function effects(overrides: Partial<DesignHandoffEffectPorts> = {}) {
  const calls: string[] = [];
  const workspaces = new Map<string, Awaited<ReturnType<DesignHandoffEffectPorts["prepareWorkspace"]>>>();
  const chats = new Map<string, Awaited<ReturnType<DesignHandoffEffectPorts["createChat"]>>>();
  const contexts = new Set<string>();
  const links = new Map<string, Awaited<ReturnType<DesignHandoffEffectPorts["publishProjectLink"]>>>();
  const base: DesignHandoffEffectPorts = {
    async verifyTarget(target) {
      calls.push("verify-target");
      return target;
    },
    async prepareWorkspace(operationId, target) {
      calls.push("prepare-workspace");
      const existing = workspaces.get(operationId);
      if (existing) return existing;
      const result = target.kind === "managed-worktree"
        ? { workspaceId: "workspace-managed", workspaceLabel: "Aiden handoff", branchLabel: "feature/design-handoff", managed: true, createdFromHead: target.expectedCommittedHead }
        : { workspaceId: target.target.workspaceId, workspaceLabel: target.target.workspaceLabel, branchLabel: target.target.branchLabel, managed: false };
      workspaces.set(operationId, result);
      return result;
    },
    async createChat(operationId) {
      calls.push("create-chat");
      const result = chats.get(operationId) ?? { chatId: "chat-1", taskId: "task-1" };
      chats.set(operationId, result);
      return result;
    },
    async installUntrustedContext(operationId) {
      calls.push("install-context");
      contexts.add(operationId);
    },
    async publishProjectLink(operationId, handoffPacket, workspace, chat) {
      calls.push("publish-link");
      const result = links.get(operationId) ?? {
        projectId: handoffPacket.projectId,
        workspaceId: workspace.workspaceId,
        chatId: chat.chatId,
        taskId: chat.taskId,
        branchLabel: workspace.branchLabel,
      };
      links.set(operationId, result);
      return result;
    },
    async inspectPublication(operationId) {
      calls.push("inspect-publication");
      return links.get(operationId) ?? null;
    },
    async rollbackContext(operationId) {
      calls.push("rollback-context");
      contexts.delete(operationId);
      return { proven: true };
    },
    async rollbackChat(operationId) {
      calls.push("rollback-chat");
      chats.delete(operationId);
      return { proven: true };
    },
    async rollbackWorkspace(operationId) {
      calls.push("rollback-workspace");
      workspaces.delete(operationId);
      return { proven: true };
    },
  };
  return { ports: { ...base, ...overrides }, calls, workspaces, chats, contexts, links };
}

function prepared(operationId = "handoff-1", target = managedTarget()): DesignHandoffJournalRecordV1 {
  return {
    version: DESIGN_HANDOFF_JOURNAL_VERSION,
    operationId,
    revision: 0,
    stage: "prepared",
    packet: packet(),
    target,
    cancellationRequested: false,
    startedAt: 1,
    updatedAt: 1,
  };
}

test("packet and target parsers reject hidden fields, credentials, paths, and missing acknowledgements", () => {
  assert.throws(() => parseDesignHandoffPacket({ ...packet(), prompt: "hidden" }), /unsupported fields/u);
  assert.throws(() => parseDesignHandoffPacket({ ...packet(), designDecisions: [{ id: "x", summary: "Authorization: Bearer secret" }] }), /credential/u);
  assert.throws(() => parseDesignHandoffPacket({ ...packet(), designDecisions: [{ id: "x", summary: "See /Users/person/private.ts" }] }), /path/u);
  assert.throws(() => parseDesignHandoffPacket({ ...packet(), designDecisions: [{ id: "x", summary: "Inspect /tmp/private.ts" }] }), /path/u);
  const missingDirtyAcknowledgement = { ...managedTarget() } as Record<string, unknown>;
  delete missingDirtyAcknowledgement.dirtyCheckoutAcknowledgement;
  assert.throws(() => parseDesignHandoffTarget(missingDirtyAcknowledgement), /not acknowledged/u);
  const target = preview("workspace-existing");
  assert.throws(() => parseDesignHandoffTarget({
    kind: "existing-workspace",
    target,
    previewDigest: designHandoffTargetPreviewDigest(target),
    strongWarningAcknowledgement: "yes",
  }), /not acknowledged/u);
  assert.equal(JSON.stringify(parseDesignHandoffPacket(packet())).includes("prompt"), false);
});

test("managed handoff publishes explicit task, workspace, branch, and immutable source identities", async () => {
  const journal = new MemoryJournal();
  const fixture = effects();
  let clock = 10;
  const coordinator = createDesignHandoffCoordinator({ journal, effects: fixture.ports, now: () => ++clock });
  const result = await coordinator.begin({ operationId: "handoff-1", packet: packet(), target: managedTarget() });
  assert.equal(result.status, "published");
  assert.equal(result.record.workspace?.createdFromHead, "b".repeat(40));
  assert.deepEqual(result.record.linkage, {
    projectId: "project-1", workspaceId: "workspace-managed", chatId: "chat-1", taskId: "task-1", branchLabel: "feature/design-handoff",
  });
  assert.deepEqual(fixture.calls, ["verify-target", "prepare-workspace", "create-chat", "install-context", "publish-link"]);
});

test("existing workspace requires an exact verified preview and never becomes managed", async () => {
  const targetPreview = preview("workspace-existing");
  const target: DesignHandoffTarget = {
    kind: "existing-workspace",
    target: targetPreview,
    previewDigest: designHandoffTargetPreviewDigest(targetPreview),
    strongWarningAcknowledgement: DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
  };
  const journal = new MemoryJournal();
  const fixture = effects();
  const result = await createDesignHandoffCoordinator({ journal, effects: fixture.ports }).begin({ operationId: "handoff-existing", packet: packet(), target });
  assert.equal(result.record.workspace?.workspaceId, "workspace-existing");
  assert.equal(result.record.workspace?.managed, false);
});

for (const boundary of ["workspace-ready", "chat-ready", "context-ready", "published"] as const) {
  test(`resume is idempotent after a crash before the ${boundary} journal checkpoint`, async () => {
    const journal = new MemoryJournal();
    journal.failAfterStage = boundary;
    const fixture = effects();
    const coordinator = createDesignHandoffCoordinator({ journal, effects: fixture.ports });
    await assert.rejects(coordinator.begin({ operationId: `handoff-${boundary}`, packet: packet(), target: managedTarget(false) }), /simulated crash/u);
    const result = await coordinator.resume(`handoff-${boundary}`);
    assert.equal(result.status, "published");
    assert.equal(fixture.workspaces.size, 1);
    assert.equal(fixture.chats.size, 1);
    assert.equal(fixture.contexts.size, 1);
    assert.equal(fixture.links.size, 1);
  });
}

test("cancellation before any effect proves reverse cleanup and leaves no workspace", async () => {
  const journal = new MemoryJournal();
  journal.records.set("handoff-cancel", prepared("handoff-cancel"));
  const fixture = effects();
  const result = await createDesignHandoffCoordinator({ journal, effects: fixture.ports }).cancel("handoff-cancel");
  assert.equal(result.status, "rolled-back");
  assert.deepEqual(fixture.calls, ["inspect-publication", "rollback-context", "rollback-chat", "rollback-workspace"]);
  assert.equal(fixture.workspaces.size, 0);
});

test("cancellation racing an unknown workspace effect rolls back by operation ID", async () => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const journal = new MemoryJournal();
  const fixture = effects({
    async prepareWorkspace() {
      fixture.calls.push("prepare-workspace");
      markStarted();
      await gate;
      throw new Error("workspace effect outcome is unknown");
    },
  });
  const coordinator = createDesignHandoffCoordinator({ journal, effects: fixture.ports });
  const beginning = coordinator.begin({ operationId: "handoff-race", packet: packet(), target: managedTarget(false) });
  await started;
  const cancelling = coordinator.cancel("handoff-race");
  release();
  const [beginResult, cancelResult] = await Promise.all([beginning, cancelling]);
  assert.equal(beginResult.status, "rolled-back");
  assert.equal(cancelResult.status, "rolled-back");
  assert.ok(fixture.calls.indexOf("rollback-workspace") > fixture.calls.indexOf("prepare-workspace"));
});

test("unproven reverse cleanup preserves a recoverable managed workspace", async () => {
  const journal = new MemoryJournal();
  const initial = prepared("handoff-preserve");
  journal.records.set(initial.operationId, {
    ...initial,
    revision: 1,
    stage: "workspace-ready",
    workspace: { workspaceId: "workspace-managed", workspaceLabel: "Managed", branchLabel: "feature/handoff", managed: true, createdFromHead: "b".repeat(40) },
  });
  const fixture = effects({
    async rollbackChat(): Promise<DesignHandoffRollbackResult> {
      fixture.calls.push("rollback-chat");
      return { proven: false };
    },
  });
  const result = await createDesignHandoffCoordinator({ journal, effects: fixture.ports }).cancel(initial.operationId);
  assert.equal(result.status, "recoverable");
  assert.match(result.record.recoveryReason!, /could not prove/iu);
  assert.doesNotMatch(result.record.recoveryReason!, /inspect the managed workspace/u);
  assert.equal(fixture.calls.includes("rollback-workspace"), false);
});

test("unknown publication state prevents rollback and preserves recovery without leaking error detail", async () => {
  const journal = new MemoryJournal();
  journal.records.set("handoff-unknown-publication", prepared("handoff-unknown-publication"));
  const fixture = effects({
    async inspectPublication() {
      fixture.calls.push("inspect-publication");
      throw new Error("authorization: Bearer private /tmp/private.json");
    },
  });
  const result = await createDesignHandoffCoordinator({ journal, effects: fixture.ports }).cancel("handoff-unknown-publication");
  assert.equal(result.status, "recoverable");
  assert.doesNotMatch(result.record.recoveryReason!, /Bearer|private\.json/u);
  assert.equal(fixture.calls.includes("rollback-context"), false);
});

test("publication is a hard boundary and cancellation preserves the linked workspace", async () => {
  const journal = new MemoryJournal();
  const fixture = effects();
  const coordinator = createDesignHandoffCoordinator({ journal, effects: fixture.ports });
  const published = await coordinator.begin({ operationId: "handoff-published", packet: packet(), target: managedTarget(false) });
  assert.equal(published.status, "published");
  const cancelled = await coordinator.cancel("handoff-published");
  assert.equal(cancelled.status, "recoverable");
  assert.ok(cancelled.record.linkage);
  assert.equal(fixture.workspaces.size, 1);
});

test("authoritative target drift fails before preparation", async () => {
  const journal = new MemoryJournal();
  const fixture = effects({
    async verifyTarget() {
      return managedTarget(false);
    },
  });
  const coordinator = createDesignHandoffCoordinator({ journal, effects: fixture.ports });
  await assert.rejects(coordinator.begin({ operationId: "handoff-drift", packet: packet(), target: managedTarget(true) }), /target changed/u);
  assert.equal(fixture.calls.includes("prepare-workspace"), false);
});

test("journal parser and transition validator reject corrupt or skipped states", () => {
  assert.throws(() => parseDesignHandoffJournalDocument({ version: 1, operations: [{ ...prepared(), prompt: "hidden" }] }), /unsupported fields/u);
  const before = prepared();
  const skipped: DesignHandoffJournalRecordV1 = {
    ...before,
    revision: 1,
    stage: "chat-ready",
    workspace: { workspaceId: "w", workspaceLabel: "W", branchLabel: "b", managed: true, createdFromHead: "b".repeat(40) },
    chat: { chatId: "c", taskId: "t" },
    updatedAt: 2,
  };
  assert.throws(() => assertDesignHandoffTransition(before, skipped), /transition is invalid/u);
});

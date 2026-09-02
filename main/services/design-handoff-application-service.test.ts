import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatMeta, Workspace } from "./types.js";
import {
  DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
  DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
  DESIGN_HANDOFF_PACKET_VERSION,
  type DesignHandoffPacketV1,
} from "./design-handoff-contract.js";
import {
  createDesignHandoffApplicationService,
  type DesignHandoffApplicationDependencies,
} from "./design-handoff-application-service.js";
import { DesignHandoffEffectStore } from "./design-handoff-effect-store.js";
import { DesignHandoffJournalStore } from "./design-handoff-journal-store.js";

const head = "d".repeat(40);

function packet(): DesignHandoffPacketV1 {
  return {
    version: DESIGN_HANDOFF_PACKET_VERSION,
    projectId: "project:one",
    projectRevision: 4,
    source: {
      bundleId: "bundle:one",
      lineageId: "lineage:one",
      revisionId: "design:one",
      sha256: "e".repeat(64),
      byteSize: 100,
    },
    referenceAssetIds: ["asset:one"],
    designDecisions: [{ id: "decision:one", summary: "Use the compact header on phones" }],
    responsiveStates: [{ viewport: "phone", width: 390, height: 844 }],
  };
}

async function fixture(overrides: Partial<DesignHandoffApplicationDependencies> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aiden-handoff-app-"));
  const source: Workspace = {
    id: "workspace:source",
    name: "Source app",
    folderPath: "/safe/source-app",
    permission: "full",
    createdAt: 1,
    updatedAt: 1,
  };
  const existing: Workspace = {
    id: "workspace:existing",
    name: "Existing app",
    folderPath: "/safe/existing-app",
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  };
  const workspaces = new Map([
    [source.id, source],
    [existing.id, existing],
  ]);
  const chats = new Map<string, ChatMeta>();
  const calls: string[] = [];
  let headSnapshot = head;
  const dependencies: DesignHandoffApplicationDependencies = {
    listWorkspaces: async () => structuredClone([...workspaces.values()]),
    getWorkspace: async (id) => structuredClone(workspaces.get(id) ?? null),
    inspectGit: async () => ({
      isRepo: true,
      branch: "main",
      committedHead: headSnapshot,
      dirty: true,
    }),
    createManagedWorkspace: async (_owner, _sourceId, branch, name) => {
      calls.push("create-workspace");
      const managed: Workspace = {
        id: "workspace:managed",
        name,
        folderPath: "/safe/managed",
        permission: "full",
        managedWorktree: {
          repositoryPath: "/safe/source-app",
          worktreePath: "/safe/managed",
          branch,
          createdFromHead: headSnapshot,
        },
        createdAt: 2,
        updatedAt: 2,
      };
      workspaces.set(managed.id, managed);
      return structuredClone(managed);
    },
    setWorkspacePermission: async (id, permission, assertCurrent) => {
      calls.push("set-ask");
      const current = workspaces.get(id)!;
      assertCurrent(current);
      const next = { ...current, permission };
      workspaces.set(id, next);
      return structuredClone(next);
    },
    removeManagedWorkspace: async (_owner, id, validate) => {
      calls.push("remove-workspace");
      const current = workspaces.get(id)!;
      validate(current);
      workspaces.delete(id);
    },
    listChats: async (workspaceId) =>
      structuredClone([...chats.values()].filter((chat) => chat.workspaceId === workspaceId)),
    getChat: async (id) => structuredClone(chats.get(id) ?? null),
    createChat: async (input) => {
      calls.push("create-chat");
      const chat: ChatMeta = {
        id: "chat:handoff",
        title: input.title,
        workspaceId: input.workspaceId,
        createdAt: 3,
        updatedAt: 3,
      };
      chats.set(chat.id, chat);
      return structuredClone(chat);
    },
    removeChat: async (id, assertCurrent) => {
      calls.push("remove-chat");
      const current = chats.get(id)!;
      assertCurrent(current);
      chats.delete(id);
    },
    verifyPacket: async () => {
      calls.push("verify-packet");
    },
    logError: () => undefined,
    ...overrides,
  };
  const journal = new DesignHandoffJournalStore(() => directory);
  const effects = new DesignHandoffEffectStore({ root: () => directory });
  const service = createDesignHandoffApplicationService({ journal, effects, dependencies });
  await service.initialize();
  return {
    service,
    effects,
    calls,
    chats,
    workspaces,
    cleanup: () => rm(directory, { recursive: true, force: true }),
    moveHead: (value: string) => {
      headSnapshot = value;
    },
  };
}

test("managed handoff uses confirmed committed HEAD, discloses dirt, installs ask permission, and publishes context", async (t) => {
  const app = await fixture();
  t.after(app.cleanup);
  const preview = await app.service.previewManagedTarget("workspace:source");
  assert.equal(preview.dirtyCheckout, true);
  assert.equal(
    preview.requiredDirtyCheckoutAcknowledgement,
    DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
  );
  assert.equal("dirtyCheckoutAcknowledgement" in preview, false);
  const result = await app.service.begin({
    operationId: "handoff:managed",
    packet: packet(),
    target: {
      kind: "managed-worktree",
      source: preview.source,
      previewDigest: preview.previewDigest,
      expectedCommittedHead: preview.expectedCommittedHead,
      dirtyCheckout: preview.dirtyCheckout,
      dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
    },
  });
  assert.equal(result.status, "published");
  assert.equal(result.record.workspace?.createdFromHead, head);
  assert.equal(app.workspaces.get("workspace:managed")?.permission, "ask");
  assert.equal((await app.service.contextForChat("chat:handoff"))?.source.revisionId, "design:one");
  assert.equal((await app.service.linksForProject("project:one"))[0]?.taskId, "chat:handoff");
  assert.deepEqual(app.calls, [
    "create-workspace",
    "set-ask",
    "create-chat",
    "verify-packet",
    "verify-packet",
  ]);
});

test("authoritative HEAD drift stops before worktree creation", async (t) => {
  const app = await fixture();
  t.after(app.cleanup);
  const preview = await app.service.previewManagedTarget("workspace:source");
  app.moveHead("f".repeat(40));
  await assert.rejects(
    app.service.begin({
      operationId: "handoff:drift",
      packet: packet(),
      target: {
        kind: "managed-worktree",
        source: preview.source,
        previewDigest: preview.previewDigest,
        expectedCommittedHead: preview.expectedCommittedHead,
        dirtyCheckout: true,
        dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
      },
    }),
    /target changed/u,
  );
  assert.equal(app.calls.includes("create-workspace"), false);
});

test("unknown managed-worktree creation outcome is preserved as recoverable on cancellation", async (t) => {
  const app = await fixture({
    createManagedWorkspace: async () => {
      throw new Error("creation result unavailable");
    },
  });
  t.after(app.cleanup);
  const preview = await app.service.previewManagedTarget("workspace:source");
  await assert.rejects(
    app.service.begin({
      operationId: "handoff:unknown",
      packet: packet(),
      target: {
        kind: "managed-worktree",
        source: preview.source,
        previewDigest: preview.previewDigest,
        expectedCommittedHead: preview.expectedCommittedHead,
        dirtyCheckout: true,
        dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
      },
    }),
    /unavailable/u,
  );
  const resumable = await app.service.recoveriesForProject("project:one");
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]?.stage, "prepared");
  assert.equal(resumable[0]?.canResume, true);
  assert.equal(resumable[0]?.canCancel, true);
  assert.deepEqual(await app.service.recoveriesForProject("project:other"), []);
  const cancelled = await app.service.cancel("handoff:unknown");
  assert.equal(cancelled.status, "recoverable");
  assert.match(cancelled.record.recoveryReason!, /could not prove rollback of managed workspace/iu);
  const preserved = await app.service.recoveriesForProject("project:one");
  assert.equal(preserved[0]?.stage, "recoverable");
  assert.equal(preserved[0]?.canResume, false);
  assert.equal(preserved[0]?.canCancel, false);
});

test("published handoff recovery exposes only its proven Open linkage", async (t) => {
  const app = await fixture();
  t.after(app.cleanup);
  const preview = await app.service.previewManagedTarget("workspace:source");
  await app.service.begin({
    operationId: "handoff:published-recovery",
    packet: packet(),
    target: {
      kind: "managed-worktree",
      source: preview.source,
      previewDigest: preview.previewDigest,
      expectedCommittedHead: preview.expectedCommittedHead,
      dirtyCheckout: true,
      dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
    },
  });
  const cancelled = await app.service.cancel("handoff:published-recovery");
  assert.equal(cancelled.status, "recoverable");
  const [recovery] = await app.service.recoveriesForProject("project:one");
  assert.equal(recovery?.linkage?.chatId, "chat:handoff");
  assert.equal(recovery?.canResume, false);
  assert.equal(recovery?.canCancel, false);
});

test("startup reconciliation resumes each approved nonterminal handoff through the same idempotent ports", async (t) => {
  let unavailable = true;
  const app = await fixture({
    createManagedWorkspace: async (_owner, _sourceId, branch, name) => {
      if (unavailable) throw new Error("temporary creation interruption");
      return {
        id: "workspace:recovered",
        name,
        folderPath: "/safe/recovered",
        permission: "ask",
        managedWorktree: {
          repositoryPath: "/safe/source-app",
          worktreePath: "/safe/recovered",
          branch,
          createdFromHead: head,
        },
        createdAt: 4,
        updatedAt: 4,
      };
    },
  });
  t.after(app.cleanup);
  const preview = await app.service.previewManagedTarget("workspace:source");
  await assert.rejects(
    app.service.begin({
      operationId: "handoff:restart",
      packet: packet(),
      target: {
        kind: "managed-worktree",
        source: preview.source,
        previewDigest: preview.previewDigest,
        expectedCommittedHead: preview.expectedCommittedHead,
        dirtyCheckout: true,
        dirtyCheckoutAcknowledgement: DESIGN_HANDOFF_DIRTY_CHECKOUT_ACKNOWLEDGEMENT,
      },
    }),
    /interruption/u,
  );
  unavailable = false;
  const reconciled = await app.service.reconcileAtStartup();
  assert.equal(reconciled.failures.length, 0);
  assert.equal(reconciled.results[0]?.status, "published");
  assert.equal(reconciled.results[0]?.record.workspace?.createdFromHead, head);
});

test("explicit existing workspace needs the strong acknowledgement and is never deleted by rollback", async (t) => {
  const app = await fixture();
  t.after(app.cleanup);
  const preview = await app.service.previewExistingTarget("workspace:existing");
  assert.equal(
    preview.requiredStrongWarningAcknowledgement,
    DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
  );
  assert.equal("strongWarningAcknowledgement" in preview, false);
  const result = await app.service.begin({
    operationId: "handoff:existing",
    packet: packet(),
    target: {
      kind: "existing-workspace",
      target: preview.target,
      previewDigest: preview.previewDigest,
      strongWarningAcknowledgement: DESIGN_HANDOFF_EXISTING_WORKSPACE_ACKNOWLEDGEMENT,
    },
  });
  assert.equal(result.status, "published");
  assert.equal(result.record.workspace?.managed, false);
  assert.ok(app.workspaces.has("workspace:existing"));
  assert.equal(app.calls.includes("create-workspace"), false);
});

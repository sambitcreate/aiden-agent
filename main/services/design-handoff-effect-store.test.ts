import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESIGN_HANDOFF_PACKET_VERSION } from "./design-handoff-contract.js";
import { DesignHandoffEffectStore } from "./design-handoff-effect-store.js";

const identity = {
  operationId: "handoff:one",
  targetKind: "managed-worktree" as const,
  targetPreviewDigest: "a".repeat(64),
  sourceWorkspaceId: "workspace:source",
  branchIntent: "feature/design-handoff-one",
};

const packet = {
  version: DESIGN_HANDOFF_PACKET_VERSION,
  projectId: "project:one",
  projectRevision: 3,
  source: {
    bundleId: "bundle:one",
    lineageId: "lineage:one",
    revisionId: "design:one",
    sha256: "b".repeat(64),
    byteSize: 42,
  },
  referenceAssetIds: ["asset:one"],
  designDecisions: [{ id: "decision:one", summary: "Keep navigation compact on phones" }],
  responsiveStates: [{ viewport: "phone" as const, width: 390, height: 844 }],
};

test("effect ledger persists operation-keyed workspace, chat, context, and publication identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-handoff-effects-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
  );
  const first = new DesignHandoffEffectStore({ root: () => directory, now: () => 10 });
  await first.initialize();
  assert.deepEqual(await first.ensure(identity), await first.ensure(identity));
  await first.markWorkspaceAttempted(identity.operationId);
  await first.recordWorkspace(identity.operationId, {
    workspaceId: "workspace:managed",
    workspaceLabel: "Design handoff",
    branchLabel: identity.branchIntent,
    managed: true,
    createdFromHead: "c".repeat(40),
  });
  await first.setChatIntent(identity.operationId, "Design handoff · one");
  await first.recordChat(identity.operationId, { chatId: "chat:one", taskId: "chat:one" });
  await first.installContext(identity.operationId, packet);
  await first.publish(identity.operationId, {
    projectId: packet.projectId,
    workspaceId: "workspace:managed",
    chatId: "chat:one",
    taskId: "chat:one",
    branchLabel: identity.branchIntent,
  });

  const restarted = new DesignHandoffEffectStore({ root: () => directory });
  await restarted.initialize();
  assert.equal((await restarted.contextForChat("chat:one"))?.source.sha256, "b".repeat(64));
  assert.equal(
    (await restarted.linksForProject("project:one"))[0]?.workspaceId,
    "workspace:managed",
  );
  assert.equal(
    (await readFile(join(directory, "design-handoff-effects.json"))).includes(
      Buffer.from("/Users/"),
    ),
    false,
  );
  await assert.rejects(
    restarted.ensure({ ...identity, sourceWorkspaceId: "workspace:other" }),
    /identity changed/u,
  );
});

test("effect rollback is idempotent and refuses to erase published identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-handoff-effects-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
  );
  const store = new DesignHandoffEffectStore({ root: () => directory });
  await store.initialize();
  await store.ensure(identity);
  await store.markWorkspaceAttempted(identity.operationId);
  await store.recordWorkspace(identity.operationId, {
    workspaceId: "workspace:managed",
    workspaceLabel: "Design handoff",
    branchLabel: identity.branchIntent,
    managed: true,
    createdFromHead: "c".repeat(40),
  });
  await store.setChatIntent(identity.operationId, "Design handoff · one");
  await store.recordChat(identity.operationId, { chatId: "chat:one", taskId: "chat:one" });
  await store.installContext(identity.operationId, packet);
  await store.rollbackContext(identity.operationId);
  await store.rollbackChat(identity.operationId);
  await store.rollbackWorkspace(identity.operationId);
  const record = await store.get(identity.operationId);
  assert.equal(record?.context, undefined);
  assert.equal(record?.chat, undefined);
  assert.equal(record?.workspace, undefined);
  assert.equal(record?.contextRolledBack, true);
  assert.equal(record?.chatRolledBack, true);
  assert.equal(record?.workspaceRolledBack, true);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESIGN_HANDOFF_JOURNAL_VERSION,
  DESIGN_HANDOFF_PACKET_VERSION,
  type DesignHandoffJournalRecordV1,
  designHandoffTargetPreviewDigest,
} from "./design-handoff-contract.js";
import {
  DesignHandoffJournalConflictError,
  DesignHandoffJournalStore,
} from "./design-handoff-journal-store.js";

function prepared(operationId = "handoff-1"): DesignHandoffJournalRecordV1 {
  const source = {
    workspaceId: "workspace-source",
    workspaceLabel: "Aiden",
    repositoryLabel: "aiden-agent",
    branchLabel: "main",
  };
  return {
    version: DESIGN_HANDOFF_JOURNAL_VERSION,
    operationId,
    revision: 0,
    stage: "prepared",
    packet: {
      version: DESIGN_HANDOFF_PACKET_VERSION,
      projectId: "project-1",
      projectRevision: 1,
      source: {
        bundleId: "bundle-1",
        lineageId: "lineage-1",
        revisionId: "revision-1",
        sha256: "a".repeat(64),
        byteSize: 1024,
      },
      referenceAssetIds: [],
      designDecisions: [],
      responsiveStates: [{ viewport: "desktop", width: 1280, height: 800 }],
    },
    target: {
      kind: "managed-worktree",
      source,
      previewDigest: designHandoffTargetPreviewDigest(source),
      expectedCommittedHead: "b".repeat(40),
      dirtyCheckout: false,
    },
    cancellationRequested: false,
    startedAt: 1,
    updatedAt: 1,
  };
}

test("owner-only journal persists restart-safe identities and enforces CAS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-design-handoff-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const first = new DesignHandoffJournalStore(() => directory);
  await first.create(prepared());
  const path = join(directory, "design-handoffs.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const second = new DesignHandoffJournalStore(() => directory);
  assert.equal((await second.get("handoff-1"))?.packet.source.bundleId, "bundle-1");
  const current = (await second.get("handoff-1"))!;
  const next = {
    ...current,
    revision: 1,
    stage: "workspace-ready" as const,
    workspace: {
      workspaceId: "workspace-managed",
      workspaceLabel: "Managed",
      branchLabel: "feature/handoff",
      managed: true,
      createdFromHead: "b".repeat(40),
    },
    updatedAt: 2,
  };
  await second.replace("handoff-1", 0, next);
  await assert.rejects(second.replace("handoff-1", 0, next), DesignHandoffJournalConflictError);
});

test("same operation ID is idempotent only for the same handoff request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-design-handoff-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const store = new DesignHandoffJournalStore(() => directory);
  assert.equal((await store.create(prepared())).operationId, "handoff-1");
  assert.equal((await store.create(prepared())).operationId, "handoff-1");
  await assert.rejects(
    store.create({ ...prepared(), packet: { ...prepared().packet, projectId: "project-2" } }),
    DesignHandoffJournalConflictError,
  );
});

test("corrupt and renderer-crafted journals fail closed without replacement", async (t) => {
  for (const [name, contents] of [
    ["corrupt", "{not-json"],
    ["unsafe", JSON.stringify({ version: 1, operations: [{ prompt: "hidden" }] })],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), `aiden-design-handoff-${name}-`));
    t.after(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    });
    const path = join(directory, "design-handoffs.json");
    await writeFile(path, contents, { mode: 0o600 });
    const store = new DesignHandoffJournalStore(() => directory);
    await assert.rejects(store.create(prepared()), /corrupt|unsafe/u);
    assert.equal(await readFile(path, "utf8"), contents);
  }
});

test("recoverable listing excludes published and rolled-back operations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aiden-design-handoff-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const store = new DesignHandoffJournalStore(() => directory);
  await store.create(prepared("active"));
  await store.create(prepared("rolled"));
  const rolled = (await store.get("rolled"))!;
  await store.replace("rolled", 0, { ...rolled, revision: 1, stage: "rolling-back", cancellationRequested: true, updatedAt: 2 });
  const rolling = (await store.get("rolled"))!;
  await store.replace("rolled", 1, { ...rolling, revision: 2, stage: "rolled-back", updatedAt: 3 });
  assert.deepEqual((await store.listRecoverable()).map(({ operationId }) => operationId), ["active"]);
});

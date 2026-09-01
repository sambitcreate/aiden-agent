import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesignSystemAttachment,
  type DesignSystemIndexInputV1,
} from "./design-system-snapshot-core.js";
import {
  DESIGN_SYSTEM_MAX_ATTACHMENTS,
  DESIGN_SYSTEM_STORE_FILENAME,
  DesignSystemSnapshotStore,
  DesignSystemSnapshotStoreConflictError,
  DesignSystemSnapshotStoreUnavailableError,
} from "./design-system-snapshot-store.js";

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiden-design-system-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function index(sourceHash = "a".repeat(64), color = "#635bff"): DesignSystemIndexInputV1 {
  return {
    version: 1,
    name: "Acme Semantic UI",
    sources: [
      {
        sourceId: "source:tokens",
        workspaceRelativePath: "packages/tokens/semantic.json",
        fileType: "regular-file",
        sha256: sourceHash,
      },
    ],
    tokens: {
      colors: [{ name: "color.action.primary", value: color, sourceId: "source:tokens" }],
      spacing: [],
      typography: [],
      radii: [],
      shadows: [],
    },
    components: [],
    icons: [],
  };
}

test("owner-only store persists attachments across restart and enforces refresh CAS", async (t) => {
  const root = await temporaryRoot(t);
  let now = 1_000;
  const first = new DesignSystemSnapshotStore({
    root: () => root,
    now: () => now,
    mintAttachmentId: () => "design-system:acme",
  });
  const created = await first.create(index());
  assert.equal(created.revision, 1);
  assert.equal((await stat(join(root, DESIGN_SYSTEM_STORE_FILENAME))).mode & 0o777, 0o600);

  const second = new DesignSystemSnapshotStore({ root: () => root, now: () => now });
  assert.deepEqual(await second.getRecord(created.attachmentId), created);
  now = 2_000;
  const refreshed = await second.refresh(created.attachmentId, 1, index("b".repeat(64), "#4438ff"));
  assert.equal(refreshed.revision, 2);
  await assert.rejects(
    second.refresh(created.attachmentId, 1, index()),
    (error: unknown) =>
      error instanceof DesignSystemSnapshotStoreConflictError && error.currentRevision === 2,
  );
});

test("renderer projection serves only proven-current path-free snapshots", async (t) => {
  const root = await temporaryRoot(t);
  const store = new DesignSystemSnapshotStore({
    root: () => root,
    now: () => 1_000,
    mintAttachmentId: () => "design-system:acme",
  });
  const sourceText = "SECRET RAW SOURCE MUST NOT LEAK";
  const created = await store.create(index());
  const currentSources = index().sources;
  const current = await store.rendererProjection(created.attachmentId, currentSources);
  assert.equal(current.freshness, "current");
  assert.equal(current.snapshot?.tokens.colors[0]?.name, "color.action.primary");
  const serialized = JSON.stringify(current);
  assert.doesNotMatch(serialized, /packages\/tokens/u);
  assert.doesNotMatch(serialized, /\/Users\//u);
  assert.doesNotMatch(serialized, new RegExp(sourceText, "u"));
  assert.equal("provenance" in current, false);

  const changedSources = structuredClone(currentSources);
  changedSources[0]!.sha256 = "b".repeat(64);
  assert.deepEqual(await store.rendererProjection(created.attachmentId, changedSources), {
    version: 1,
    attachmentId: created.attachmentId,
    revision: 1,
    state: "attached",
    updatedAt: 1_000,
    freshness: "changed",
    snapshot: null,
  });
  assert.equal((await store.rendererProjection(created.attachmentId, [])).freshness, "missing");
});

test("detach removes provenance and never projects the prior snapshot", async (t) => {
  const root = await temporaryRoot(t);
  let now = 1_000;
  const store = new DesignSystemSnapshotStore({
    root: () => root,
    now: () => now,
    mintAttachmentId: () => "design-system:acme",
  });
  const created = await store.create(index());
  now = 2_000;
  const detached = await store.detach(created.attachmentId, created.revision);
  assert.equal(detached.state, "detached");
  assert.equal("provenance" in detached, false);
  assert.equal("snapshot" in detached, false);
  assert.deepEqual(await store.rendererProjection(created.attachmentId, index().sources), {
    version: 1,
    attachmentId: created.attachmentId,
    revision: 2,
    state: "detached",
    updatedAt: 2_000,
    freshness: "detached",
    snapshot: null,
  });
});

test("corrupt and schema-unsafe stores fail closed without replacement", async (t) => {
  for (const [label, contents] of [
    ["corrupt", "{not-json"],
    ["unsafe", JSON.stringify({ version: 1, revision: 1, attachments: [{ rawSource: "secret" }] })],
  ] as const) {
    const root = await temporaryRoot(t);
    const target = join(root, DESIGN_SYSTEM_STORE_FILENAME);
    await writeFile(target, contents, { mode: 0o600 });
    const store = new DesignSystemSnapshotStore({ root: () => root });
    await assert.rejects(store.initialize(), DesignSystemSnapshotStoreUnavailableError);
    await assert.rejects(store.create(index()), DesignSystemSnapshotStoreUnavailableError);
    assert.equal(await readFile(target, "utf8"), contents);
    assert.ok(label);
  }
});

test("store rejects attachment counts beyond its fixed database bound", async (t) => {
  const root = await temporaryRoot(t);
  const attachments = Array.from({ length: DESIGN_SYSTEM_MAX_ATTACHMENTS + 1 }, (_, position) =>
    createDesignSystemAttachment(index(), {
      attachmentId: `design-system:item-${position}`,
      now: 1_000,
    }),
  );
  const contents = JSON.stringify({ version: 1, revision: 1, attachments });
  const target = join(root, DESIGN_SYSTEM_STORE_FILENAME);
  await writeFile(target, contents, { mode: 0o600 });
  const store = new DesignSystemSnapshotStore({ root: () => root });
  await assert.rejects(store.initialize(), DesignSystemSnapshotStoreUnavailableError);
  assert.equal(await readFile(target, "utf8"), contents);
});

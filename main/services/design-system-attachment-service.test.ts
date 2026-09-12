import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesignSystemAttachmentService } from "./design-system-attachment-service.js";
import { DesignSystemSnapshotStore } from "./design-system-snapshot-store.js";

function tokenDocument(color: string) {
  return JSON.stringify({
    version: 1,
    kind: "tokens",
    tokens: {
      colors: [{ name: "color.action.primary", value: color }],
      spacing: [],
      typography: [],
      radii: [],
      shadows: [],
    },
  });
}

test("main orchestration detects stale bytes, explicitly refreshes, and detaches", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiden-design-system-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await stat(root, { bigint: true });
  const sourcePath = join(root, "semantic.tokens.json");
  const reviewedInput = {
    name: "Acme Semantic UI",
    authority: {
      rootPath: root,
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
    },
    sources: [
      {
        sourceId: "source:tokens",
        workspaceRelativePath: "semantic.tokens.json",
        kind: "tokens-v1",
        reviewed: true,
      },
    ],
  };
  await writeFile(sourcePath, tokenDocument("#635bff"), { mode: 0o600 });

  let now = 1_000;
  const store = new DesignSystemSnapshotStore({
    root: () => root,
    now: () => now,
    mintAttachmentId: () => "design-system:acme",
  });
  const service = new DesignSystemAttachmentService(store);
  const attached = await service.attach(reviewedInput);
  assert.equal(
    (await service.rendererProjection(attached.attachmentId, reviewedInput)).freshness,
    "current",
  );

  await unlink(sourcePath);
  const missing = await service.rendererProjection(attached.attachmentId, reviewedInput);
  assert.equal(missing.freshness, "missing");
  assert.equal(missing.snapshot, null);

  await writeFile(sourcePath, tokenDocument("#4438ff"), { mode: 0o600 });
  const stale = await service.rendererProjection(attached.attachmentId, reviewedInput);
  assert.equal(stale.freshness, "changed");
  assert.equal(stale.snapshot, null);

  now = 2_000;
  const refreshed = await service.refresh(attached.attachmentId, attached.revision, reviewedInput);
  const current = await service.rendererProjection(refreshed.attachmentId, reviewedInput);
  assert.equal(current.freshness, "current");
  assert.equal(current.snapshot?.tokens.colors[0]?.value, "#4438ff");

  now = 3_000;
  await service.detach(refreshed.attachmentId, refreshed.revision);
  await unlink(sourcePath);
  const detached = await service.rendererProjection(refreshed.attachmentId, reviewedInput);
  assert.equal(detached.freshness, "detached");
  assert.equal(detached.snapshot, null);
});

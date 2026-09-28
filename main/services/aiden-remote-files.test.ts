import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { listWorkspaceFiles } from "./workspace-files.js";
import { AidenRemoteFileService } from "./aiden-remote-files.js";
import { AidenOpaqueHandleStore } from "./aiden-remote-opaque-handles.js";
import { AidenRemoteWorkspaceOwnerRegistry } from "./aiden-remote-workspace-owners.js";
import type { Workspace } from "./types.js";
import { createWorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";

test("remote Files uses device/workspace-bound opaque handles and version-safe writes", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-files-"));
  const root = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside.txt");
  await fs.mkdir(path.join(root, "Sources"), { recursive: true });
  await fs.writeFile(path.join(root, "Sources", "App.swift"), "let value = 1\n", "utf8");
  await fs.writeFile(outside, "private\n", "utf8");
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Project",
    folderPath: root,
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
  const workspaces = new Map([[workspace.id, workspace]]);
  const application = createWorkspaceEnvironmentApplicationService({
    configStore: { getWorkspace: async (id) => workspaces.get(id) },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    assertManagedWorktreeAdmission: async () => undefined,
    realpath: fs.realpath,
    stat: fs.stat,
  });
  const handles = new AidenOpaqueHandleStore();
  const owners = new AidenRemoteWorkspaceOwnerRegistry();
  const service = new AidenRemoteFileService({
    instanceId: "instance-1",
    application,
    owners,
    handles,
  });

  try {
    if (process.platform === "darwin") {
    // Lazy pages do not read descendants, and directory handles remain device-bound.
    const alias = path.join(temporary, "alias");
    await fs.symlink(temporary, alias);
    workspace.folderPath = path.join(alias, "workspace");
    await assert.rejects(() => service.children("device-1", workspace.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "filesystem_identity_changed");
    workspace.folderPath = root;
    await fs.rm(alias);
    const originalRoot = path.join(temporary, "original-root");
    await fs.rename(root, originalRoot);
    await fs.symlink(temporary, root);
    await assert.rejects(() => service.children("device-1", workspace.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "filesystem_identity_changed");
    await fs.rm(root);
    await fs.rename(originalRoot, root);
    const rootPage = await service.children("device-1", workspace.id);
    assert.deepEqual(rootPage.entries.map(entry => entry.displayPath), ["Sources"]);
    assert.equal(rootPage.directoryPath, "");
    await fs.rename(root, originalRoot);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "replacement.txt"), "outside replacement");
    await assert.rejects(() => service.children("device-1", workspace.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "filesystem_identity_changed");
    await fs.rm(root, { recursive: true });
    await fs.rename(originalRoot, root);
    const sources = rootPage.entries[0]!;
    const children = await service.children("device-1", workspace.id, sources.id);
    assert.deepEqual(children.entries.map(entry => entry.displayPath), ["Sources/App.swift"]);
    const lazyDocument = await service.read("device-1", workspace.id, children.entries[0]!.id);
    assert.equal(lazyDocument.content, "let value = 1\n");
    const outsideLink = path.join(temporary, "outside-hardlink");
    await fs.link(path.join(root, "Sources", "App.swift"), outsideLink);
    assert.equal((await service.children("device-1", workspace.id, sources.id)).entries.length, 0);
    await assert.rejects(() => service.read("device-1", workspace.id, lazyDocument.id));
    await assert.rejects(() => service.write("device-1", workspace.id, lazyDocument.id,
      { content: "must not save", expectedVersion: lazyDocument.version }));
    assert.equal(await fs.readFile(outsideLink, "utf8"), "let value = 1\n");
    await fs.unlink(outsideLink);
    const savedLazyDocument = await service.write("device-1", workspace.id, lazyDocument.id,
      { content: "let value = 2\n", expectedVersion: lazyDocument.version });
    assert.notEqual(savedLazyDocument.id, lazyDocument.id);
    assert.match(savedLazyDocument.warning ?? "", /previous version/);
    assert.equal((await service.read("device-1", workspace.id, savedLazyDocument.id)).content, "let value = 2\n");
    await assert.rejects(() => service.read("device-1", workspace.id, lazyDocument.id));
    await service.write("device-1", workspace.id, savedLazyDocument.id,
      { content: "let value = 1\n", expectedVersion: savedLazyDocument.version });
    for (const name of await fs.readdir(path.join(root, "Sources"))) {
      if (name.includes("aiden-recovery")) await fs.rm(path.join(root, "Sources", name));
    }
    await assert.rejects(() => service.children("device-2", workspace.id, sources.id));
    await assert.rejects(() => service.children("device-1", workspace.id, children.entries[0]!.id));
    await fs.mkdir(path.join(root, "Many"));
    for (let number = 0; number < 205; number++) await fs.writeFile(path.join(root, "Many", `file${number}.txt`), "ok");
    const many = (await service.children("device-1", workspace.id)).entries.find(entry => entry.name === "Many")!;
    const firstPage = await service.children("device-1", workspace.id, many.id);
    assert.equal(firstPage.entries.length, 200);
    assert.ok(firstPage.nextCursor);
    assert.equal(firstPage.entries[2]!.name, "file2.txt");
    await assert.rejects(() => service.children("device-2", workspace.id, many.id, firstPage.nextCursor));
    await assert.rejects(() => service.children("device-1", workspace.id, sources.id, firstPage.nextCursor));
    await assert.rejects(() => service.children("device-1", workspace.id, undefined, firstPage.nextCursor));
    // Mutation between pages cannot shuffle offsets in the server-held snapshot.
    await fs.writeFile(path.join(root, "Many", "file-new.txt"), "new");
    const lastPage = await service.children("device-1", workspace.id, many.id, firstPage.nextCursor);
    assert.equal(lastPage.entries.length, 5);
    assert.equal(lastPage.nextCursor, undefined);
    assert.equal(new Set([...firstPage.entries, ...lastPage.entries].map(entry => entry.displayPath)).size, 205);
    await fs.symlink(temporary, path.join(root, "escape"));
    assert.equal((await service.children("device-1", workspace.id)).entries.some(entry => entry.name === "escape"), false);
    await fs.rm(path.join(root, "escape"));
    // Abandoned inventories evict oldest pages instead of blocking unrelated browsing.
    for (let request = 0; request < 17; request++) {
      assert.ok((await service.children("device-1", workspace.id, many.id)).nextCursor);
    }
    assert.equal((await service.children("device-1", workspace.id)).directoryPath, "");
    await fs.rm(path.join(root, "Many"), { recursive: true });

    }
    const index = await service.list("device-1", workspace.id);
    assert.equal(index.maxEntries, 4_000);
    assert.equal(index.maxDepth, 20);
    assert.equal(index.truncated, false);
    const file = index.entries.find((entry) => entry.displayPath === "Sources/App.swift");
    assert.ok(file);
    assert.match(file.id, /^file_[A-Za-z0-9_-]{43}$/u);
    assert.equal(file.language, "Swift");
    assert.equal(JSON.stringify(index).includes(root), false);
    assert.equal(handles.storedTokenMaterialForTesting().some((value) => value.includes("App.swift")), false);

    const first = await service.read("device-1", workspace.id, file.id);
    assert.equal(first.content, "let value = 1\n");
    assert.equal(first.displayPath, "Sources/App.swift");

    await assert.rejects(
      () => service.read("device-2", workspace.id, file.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "handle_wrong_device",
    );
    workspaces.set("workspace-2", { ...workspace, id: "workspace-2" });
    await assert.rejects(
      () => service.read("device-1", "workspace-2", file.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "handle_wrong_device",
    );

    await fs.writeFile(path.join(root, "Sources", "App.swift"), "let value = 2\n", "utf8");
    await assert.rejects(
      () => service.write("device-1", workspace.id, file.id, {
        content: "let value = 3\n",
        expectedVersion: first.version,
      }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "revision_conflict",
    );

    const refreshed = await service.read("device-1", workspace.id, file.id);
    const saved = await service.write("device-1", workspace.id, file.id, {
      content: "let value = 3\n",
      expectedVersion: refreshed.version,
    });
    assert.equal(saved.content, "let value = 3\n");
    assert.equal(await fs.readFile(path.join(root, "Sources", "App.swift"), "utf8"), "let value = 3\n");

    // Snapshot handles also refuse multiply-linked files: another name for the
    // inode may live outside the workspace.
    await fs.link(outside, path.join(root, "linked-secret.txt"));
    const linkedIndex = await service.list("device-1", workspace.id);
    assert.equal(linkedIndex.entries.some((entry) => entry.displayPath === "linked-secret.txt"), false);
    assert.equal(linkedIndex.truncated, true);
    await fs.rm(path.join(root, "linked-secret.txt"));
    const outsideAlias = path.join(temporary, "outside-alias.swift");
    await fs.link(path.join(root, "Sources", "App.swift"), outsideAlias);
    await assert.rejects(
      () => service.read("device-1", workspace.id, file.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "path_outside_root",
    );
    await assert.rejects(
      () => service.write("device-1", workspace.id, file.id, { content: "must not save\n", expectedVersion: saved.version }),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "path_outside_root",
    );
    assert.equal(await fs.readFile(outsideAlias, "utf8"), "let value = 3\n");
    await fs.rm(outsideAlias);

    // Race: the name passes pathname validation, then changes before the read
    // opens it. The opened descriptor must still be the issued single-link inode.
    const appPath = path.join(root, "Sources", "App.swift");
    const racing = (await service.list("device-1", workspace.id)).entries
      .find((entry) => entry.displayPath === "Sources/App.swift")!;
    const { default: promises } = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const originalOpen = promises.open;
    const raceBeforeOpen = async (swap: () => Promise<void>) => {
      let armed = true;
      promises.open = (async (...args: Parameters<typeof promises.open>) => {
        if (armed && String(args[0]).endsWith(`${path.sep}workspace${path.sep}Sources${path.sep}App.swift`)) {
          armed = false;
          await swap();
        }
        return originalOpen(...args);
      }) as typeof promises.open;
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          () => service.read("device-1", workspace.id, racing.id),
          (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "workspace_unavailable",
        );
        assert.equal(armed, false);
      } finally {
        promises.open = originalOpen;
        syncBuiltinESMExports();
      }
    };
    // 1. The name is replaced by a hard link to an outside inode.
    await raceBeforeOpen(async () => {
      await fs.rename(appPath, path.join(temporary, "held-app.swift"));
      await fs.link(outside, appPath);
    });
    await fs.rm(appPath);
    await fs.rename(path.join(temporary, "held-app.swift"), appPath);
    // 2. The issued inode gains a second, outside name.
    const lateAlias = path.join(temporary, "late-alias.swift");
    await raceBeforeOpen(() => fs.link(appPath, lateAlias));
    await fs.rm(lateAlias);
    assert.equal((await service.read("device-1", workspace.id, racing.id)).content, "let value = 3\n");

    await fs.rm(path.join(root, "Sources", "App.swift"));
    await fs.symlink(outside, path.join(root, "Sources", "App.swift"));
    await assert.rejects(
      () => service.read("device-1", workspace.id, file.id),
      (error: unknown) => error instanceof AidenRemoteServiceError && error.code === "path_outside_root",
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("remote workspace owners survive disconnect-shaped reuse and revoke active ownership", () => {
  const registry = new AidenRemoteWorkspaceOwnerRegistry();
  const first = registry.owner("device-1");
  assert.equal(first, registry.owner("device-1"));
  let invalidations = 0;
  first.onInvalidated(() => { invalidations += 1; });
  registry.revokeDevice("device-1");
  assert.equal(first.isDestroyed(), true);
  assert.equal(invalidations, 1);
  assert.notEqual(first, registry.owner("device-1"));
});

test("lazy save reserves capacity before mutation and renews the returned handle", { skip: process.platform !== "darwin" }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-lazy-save-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  await fs.writeFile(path.join(root, "note.txt"), "old");
  const workspace: Workspace = { id: "save", name: "Save", folderPath: root, permission: "ask", createdAt: 1, updatedAt: 2 };
  let now = Date.now();
  const handles = new AidenOpaqueHandleStore({ now: () => now, maxEntries: 2 });
  const service = new AidenRemoteFileService({ instanceId: "instance", now: () => now, handles,
    owners: new AidenRemoteWorkspaceOwnerRegistry(),
    application: createWorkspaceEnvironmentApplicationService({
      configStore: { getWorkspace: async () => workspace }, workspaceMutationGate: new WorkspaceMutationGate(),
      workspaceOperationRegistry: new WorkspaceOperationRegistry(), assertManagedWorktreeAdmission: async () => undefined,
      realpath: fs.realpath, stat: fs.stat,
    }),
  });
  const file = (await service.children("device", workspace.id)).entries[0]!;
  const opened = await service.read("device", workspace.id, file.id);
  const blocker = handles.issue("file", handles.claimsFor(file.id, "file"));
  await assert.rejects(service.write("device", workspace.id, file.id, { content: "new", expectedVersion: opened.version }));
  assert.equal(await fs.readFile(path.join(root, "note.txt"), "utf8"), "old");
  handles.discard(blocker);
  now += 599_999;
  const saved = await service.write("device", workspace.id, file.id, { content: "new", expectedVersion: opened.version });
  now += 2;
  assert.equal((await service.read("device", workspace.id, saved.id)).content, "new");
});

async function legacyFixture(t: test.TestContext, count: number, capacity = 10_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-legacy-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let start = 0; start < count; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) =>
      fs.writeFile(path.join(root, `file${start + offset}.txt`), "data")));
  }
  const workspace: Workspace = { id: "workspace", name: "Project", folderPath: root, permission: "ask", createdAt: 1, updatedAt: 2 };
  const application = createWorkspaceEnvironmentApplicationService({
    configStore: { getWorkspace: async () => workspace },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    assertManagedWorktreeAdmission: async () => undefined,
    realpath: fs.realpath, stat: fs.stat,
  });
  const owners = new AidenRemoteWorkspaceOwnerRegistry();
  const handles = new AidenOpaqueHandleStore({ maxEntries: capacity });
  const service = new AidenRemoteFileService({ instanceId: "instance", application, owners, handles });
  return { root, service, owners, handles };
}

test("legacy Remote listing overlaps bounded identity checks and keeps 4,000 ordered handles", async (t) => {
  const { service, handles } = await legacyFixture(t, 4_001);
  const original = fsPromises.stat;
  const visits = new Map<string, number>();
  let active = 0;
  let peak = 0;
  let identities = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    const name = String(args[0]);
    if (!name.endsWith(".txt")) return original(...args);
    const visit = (visits.get(name) ?? 0) + 1;
    visits.set(name, visit);
    if (visit === 1) return original(...args);
    identities += 1;
    peak = Math.max(peak, ++active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  const index = await service.list("device", "workspace");
  assert.equal(index.truncated, true);
  assert.equal(index.entries.length, 4_000);
  assert.deepEqual(index.entries.map(entry => entry.displayPath), Array.from({ length: 4_000 }, (_, i) => `file${i}.txt`));
  assert.equal(new Set(index.entries.map(entry => entry.id)).size, 4_000);
  assert.equal(handles.storedTokenMaterialForTesting().length, 4_000);
  assert.equal(identities, 4_000, "fresh identity checks must not be replaced by index metadata");
  assert.ok(peak > 1 && peak <= 4, `peak identity concurrency: ${peak}`);
  assert.equal(active, 0);
});

test("legacy Remote revocation drains identity work without issuing cancelled handles", async (t) => {
  const { service, owners, handles } = await legacyFixture(t, 12);
  const original = fsPromises.stat;
  const visits = new Map<string, number>();
  let active = 0;
  let identities = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    const name = String(args[0]);
    if (!name.endsWith(".txt")) return original(...args);
    const visit = (visits.get(name) ?? 0) + 1;
    visits.set(name, visit);
    if (visit === 1) return original(...args);
    const ordinal = ++identities;
    active += 1;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (ordinal === 1) owners.revokeDevice("device");
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  await assert.rejects(service.list("device", "workspace"), (error: unknown) =>
    error instanceof AidenRemoteServiceError && error.code === "workspace_unavailable");
  assert.equal(active, 0);
  assert.ok(identities <= 4);
  assert.equal(handles.storedTokenMaterialForTesting().length, 0);
});

test("legacy Remote bounded issuance preserves capacity errors", async (t) => {
  const { service, handles } = await legacyFixture(t, 12, 2);
  await assert.rejects(service.list("device", "workspace"), (error: unknown) =>
    error instanceof AidenRemoteServiceError && error.code === "handle_capacity" && error.status === 429);
  assert.equal(handles.storedTokenMaterialForTesting().length, 2);
});

test("overlapping Remote and desktop listings share one four-operation metadata budget", async (t) => {
  const { service, root } = await legacyFixture(t, 24);
  const original = fsPromises.stat;
  let active = 0;
  let peak = 0;
  let calls = 0;
  fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
    if (!String(args[0]).endsWith(".txt")) return original(...args);
    calls += 1;
    peak = Math.max(peak, ++active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await original(...args);
    } finally { active -= 1; }
  }) as typeof fsPromises.stat;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.stat = original; syncBuiltinESMExports(); });
  const [remote, secondRemote, desktop] = await Promise.all([
    service.list("device", "workspace"), service.list("second-device", "workspace"), listWorkspaceFiles(root),
  ]);
  assert.deepEqual(remote.entries.map(entry => entry.displayPath), desktop.entries.map(entry => entry.path));
  assert.deepEqual(secondRemote.entries.map(entry => entry.displayPath), desktop.entries.map(entry => entry.path));
  assert.equal(calls, 120, "every listing stays fresh and every Remote identity is inspected");
  assert.ok(peak > 1 && peak <= 4, `aggregate metadata concurrency: ${peak}`);
  assert.equal(active, 0);
  await assert.rejects(service.read("second-device", "workspace", remote.entries[0]!.id));
});

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
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

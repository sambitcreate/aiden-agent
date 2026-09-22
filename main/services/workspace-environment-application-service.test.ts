import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Workspace } from "./types.js";
import { createWorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import {
  WorkspaceOperationRegistry,
  type WorkspaceOperationDocumentOwner,
} from "./workspace-operation-registry.js";

class Owner implements WorkspaceOperationDocumentOwner {
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean { return this.destroyed; }
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  invalidate(): void {
    this.destroyed = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

test("workspace environment operations share persisted resolution and owner cancellation", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-environment-service-"));
  const root = path.join(temporary, "workspace");
  await fs.mkdir(root);
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Project",
    folderPath: root,
    permission: "ask",
    createdAt: 1,
    updatedAt: 2,
  };
  const mutationGate = new WorkspaceMutationGate();
  const operationRegistry = new WorkspaceOperationRegistry();
  const service = createWorkspaceEnvironmentApplicationService({
    configStore: { getWorkspace: async (id) => id === workspace.id ? workspace : undefined },
    workspaceMutationGate: mutationGate,
    workspaceOperationRegistry: operationRegistry,
    assertManagedWorktreeAdmission: async () => undefined,
    realpath: fs.realpath,
    stat: fs.stat,
  });

  try {
    const owner = new Owner();
    const resolved = await service.run(owner, workspace.id, async (context) => context);
    assert.equal(resolved.folderPath, await fs.realpath(root));
    assert.equal(resolved.workspace.id, workspace.id);

    const cancellableOwner = new Owner();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = service.run(cancellableOwner, workspace.id, async (_context, signal) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return "unreachable";
    });
    await started;
    cancellableOwner.invalidate();
    await assert.rejects(pending, /renderer document is no longer active/u);

    const finishMutation = mutationGate.begin(workspace.id);
    await assert.rejects(
      () => service.run(new Owner(), workspace.id, async () => undefined),
      /workspace is changing/u,
    );
    finishMutation();
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

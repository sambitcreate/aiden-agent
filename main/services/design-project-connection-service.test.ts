import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import type { Workspace } from "./types.js";
import {
  assertDesignProjectGenerationClaim,
  assertSameConnectedDesignProjectBinding,
  createDesignProjectConnectionService,
  requireConnectedDesignProject,
} from "./design-project-connection-service.js";
import { DesignProjectRevisionConflictError, DesignProjectStore } from "./design-project-store.js";
import { createWorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";

class Owner implements RendererDocumentOwner {
  readonly id = 1;
  readonly documentId = "renderer:design-test";
  private destroyed = false;
  private listeners = new Set<() => void>();
  isDestroyed(): boolean { return this.destroyed; }
  send(): void {}
  onInvalidated(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function workspace(id: string, folderPath: string | undefined, permission: Workspace["permission"]): Workspace {
  return { id, name: id, ...(folderPath ? { folderPath } : {}), permission, createdAt: 1, updatedAt: 1 };
}

async function fixture(t: test.TestContext, workspaces: Map<string, Workspace>) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-connect-test-"));
  const storeRoot = path.join(temporary, "store");
  await fs.mkdir(storeRoot);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projects = new DesignProjectStore({
    root: () => storeRoot,
    now: () => 10,
    mintProjectId: () => "project:one",
  });
  await projects.initialize();
  const workspaceService = createWorkspaceEnvironmentApplicationService({
    configStore: { getWorkspace: async (id) => workspaces.get(id) },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    assertManagedWorktreeAdmission: async () => undefined,
    realpath: fs.realpath,
    stat: fs.stat,
  });
  return { temporary, projects, workspaceService };
}

test("Prototype connection resolves a current folder-backed authorized workspace", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-connected-app-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const workspaces = new Map([["workspace-1", workspace("workspace-1", appRoot, "ask")]]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const prototype = await projects.create({
    chatId: "chat:one",
    title: "Prototype",
    connectionState: "prototype-only",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
  });
  const connected = await service.connect(new Owner(), {
    projectId: prototype.id,
    expectedRevision: prototype.revision,
    workspaceId: "workspace-1",
  });
  assert.equal(connected.connectionState, "connected");
  assert.equal(connected.workspaceId, "workspace-1");
  assert.deepEqual(await service.preflightGeneration(new Owner(), connected.id), {
    projectId: connected.id,
    projectRevision: connected.revision,
    chatId: connected.chatId,
    connectionState: "connected",
    workspaceId: "workspace-1",
  });
  await assert.rejects(
    service.connect(new Owner(), {
      projectId: connected.id,
      expectedRevision: prototype.revision,
      workspaceId: "workspace-2",
    }),
    DesignProjectRevisionConflictError,
  );
});

test("folderless, denied, missing, and unavailable workspaces cannot become authority", async (t) => {
  const missingFolder = path.join(os.tmpdir(), "aiden-design-missing-folder");
  const workspaces = new Map<string, Workspace>([
    ["folderless", workspace("folderless", undefined, "ask")],
    ["denied", workspace("denied", os.tmpdir(), "none")],
    ["unavailable", workspace("unavailable", missingFolder, "ask")],
  ]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const prototype = await projects.create({
    chatId: "chat:one",
    title: "Prototype",
    connectionState: "prototype-only",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
  });
  for (const [workspaceId, message] of [
    ["folderless", /does not have a folder/u],
    ["denied", /does not allow local file access/u],
    ["unavailable", /folder is no longer available/u],
    ["missing", /was not found/u],
  ] as const) {
    await assert.rejects(
      service.connect(new Owner(), {
        projectId: prototype.id,
        expectedRevision: prototype.revision,
        workspaceId,
      }),
      message,
    );
    assert.equal((await projects.get(prototype.id))?.connectionState, "prototype-only");
  }
});

test("a Connected App can rebind after W1 is deleted without carrying W1 authority", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-rebind-app-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  // W1 is intentionally absent: reconnect must validate W2, not require old
  // authority merely to revoke the old relationship facts.
  const workspaces = new Map([["workspace-2", workspace("workspace-2", appRoot, "full")]]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const original = await projects.create({
    chatId: "chat:one",
    title: "Connected",
    connectionState: "connected",
    workspaceId: "workspace-1",
    previewScriptId: "dev",
    designSystemBinding: { id: "system:one", revision: 1 },
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: "source:one",
        kind: "source-preview",
        canonicalOrigin: "connected-app",
        x: 0,
        y: 0,
      }],
    },
  });
  const prepared: string[] = [];
  const finalized: string[] = [];
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
    prepareRebind: async (_owner, previous) => { prepared.push(previous.workspaceId!); },
    finalizeRebind: async (previous, connected) => {
      finalized.push(`${previous.workspaceId}->${connected.workspaceId}`);
    },
  });
  const rebound = await service.connect(new Owner(), {
    projectId: original.id,
    expectedRevision: original.revision,
    workspaceId: "workspace-2",
  });
  assert.equal(rebound.workspaceId, "workspace-2");
  assert.equal(rebound.previewScriptId, undefined);
  assert.equal(rebound.designSystemBinding, undefined);
  assert.deepEqual(rebound.canvas.nodes, []);
  assert.deepEqual(prepared, ["workspace-1"]);
  assert.deepEqual(finalized, ["workspace-1->workspace-2"]);
});

test("Prototype generation preflight does not resolve any workspace", async (t) => {
  const { projects } = await fixture(t, new Map());
  const prototype = await projects.create({
    chatId: "chat:one",
    title: "Prototype",
    connectionState: "prototype-only",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: { run: async () => { throw new Error("workspace resolution is forbidden"); } },
    runProjectMutation: (operation) => operation(),
  });
  assert.deepEqual(await service.preflightGeneration(new Owner(), prototype.id), {
    projectId: prototype.id,
    projectRevision: prototype.revision,
    chatId: prototype.chatId,
    connectionState: "prototype-only",
  });
});

test("source preview authority rejects Prototypes and mismatched project bindings", async (t) => {
  const { projects } = await fixture(t, new Map());
  const prototype = await projects.create({
    chatId: "chat:one",
    title: "Prototype",
    connectionState: "prototype-only",
  });
  assert.throws(() => requireConnectedDesignProject(prototype), /connect this design project/iu);
  const expected = requireConnectedDesignProject({
    ...prototype,
    connectionState: "connected",
    workspaceId: "workspace-1",
  });
  assert.throws(
    () =>
      assertSameConnectedDesignProjectBinding(
        { ...expected, workspaceId: "workspace-2" },
        expected,
      ),
    DesignProjectRevisionConflictError,
  );
});

test("an old Prototype generation claim fails after an intervening W2 connection", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-claim-rebind-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const workspaces = new Map([["workspace-2", workspace("workspace-2", appRoot, "ask")]]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const prototype = await projects.create({
    chatId: "chat:claim",
    title: "Claim",
    connectionState: "prototype-only",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
  });
  const oldClaim = await service.preflightGeneration(new Owner(), prototype.id);
  const connected = await service.connect(new Owner(), {
    projectId: prototype.id,
    expectedRevision: prototype.revision,
    workspaceId: "workspace-2",
  });
  assert.throws(
    () => assertDesignProjectGenerationClaim(connected, oldClaim),
    DesignProjectRevisionConflictError,
  );
});

test("connect and rebind fail while the backing Design conversation is busy", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-busy-connect-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const workspaces = new Map([["workspace-2", workspace("workspace-2", appRoot, "ask")]]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const prototype = await projects.create({
    chatId: "chat:busy",
    title: "Busy",
    connectionState: "prototype-only",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
    isChatBusy: (chatId) => chatId === prototype.chatId,
  });
  await assert.rejects(
    service.connect(new Owner(), {
      projectId: prototype.id,
      expectedRevision: prototype.revision,
      workspaceId: "workspace-2",
    }),
    /finish or stop the current design response/iu,
  );
  assert.deepEqual(await projects.get(prototype.id), prototype);
});

test("connected append revalidates current folder permission before persistence", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-denied-append-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const workspaces = new Map([
    ["workspace-denied", workspace("workspace-denied", appRoot, "none")],
  ]);
  const { projects, workspaceService } = await fixture(t, workspaces);
  const connected = await projects.create({
    chatId: "chat:denied-append",
    title: "Denied append",
    connectionState: "connected",
    workspaceId: "workspace-denied",
  });
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: workspaceService,
    runProjectMutation: (operation) => operation(),
  });
  let appended = false;
  await assert.rejects(
    service.runGenerationAppend(
      new Owner(),
      {
        projectId: connected.id,
        projectRevision: connected.revision,
        chatId: connected.chatId,
        connectionState: "connected",
        workspaceId: "workspace-denied",
      },
      async () => {
        appended = true;
      },
    ),
    /does not allow local file access/u,
  );
  assert.equal(appended, false);
});

test("connected append exposes workspace revocation to the persistence barrier", async (t) => {
  const { projects } = await fixture(t, new Map());
  const connected = await projects.create({
    chatId: "chat:revoked-append",
    title: "Revoked append",
    connectionState: "connected",
    workspaceId: "workspace-revoked",
  });
  const controller = new AbortController();
  const service = createDesignProjectConnectionService({
    projects,
    workspaces: {
      run: async (_owner, _workspaceId, operation) =>
        operation(
          {
            folderPath: os.tmpdir(),
            workspace: workspace("workspace-revoked", os.tmpdir(), "ask"),
          },
          controller.signal,
        ),
    },
    runProjectMutation: (operation) => operation(),
  });
  await assert.rejects(
    service.runGenerationAppend(
      new Owner(),
      {
        projectId: connected.id,
        projectRevision: connected.revision,
        chatId: connected.chatId,
        connectionState: "connected",
        workspaceId: "workspace-revoked",
      },
      async (isCurrent) => {
        controller.abort(new Error("workspace revoked"));
        assert.equal(isCurrent(), false);
        throw controller.signal.reason;
      },
    ),
    /workspace revoked/u,
  );
});

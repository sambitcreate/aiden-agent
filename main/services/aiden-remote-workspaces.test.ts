import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace } from "./types.js";
import {
  AidenRemoteWorkspaceService,
  projectAidenRemoteWorkspace,
} from "./aiden-remote-workspaces.js";
import {
  AidenIdempotencyLedger,
  type AidenIdempotencySnapshot,
} from "./aiden-remote-operation-contract.js";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    permission: "ask",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function fixture(
  initial: Workspace[] = [workspace()],
  options: {
    idempotency?: AidenIdempotencyLedger;
    persistIdempotency?: (snapshot: AidenIdempotencySnapshot) => Promise<void>;
  } = {},
) {
  let workspaces = initial.map((value) => structuredClone(value));
  let createCalls = 0;
  let notifications = 0;
  const service = new AidenRemoteWorkspaceService({
    application: {
      list: async () => structuredClone(workspaces),
      get: async (id: string) => structuredClone(workspaces.find((value) => value.id === id) ?? null),
      create: async (input: unknown) => {
        createCalls += 1;
        const value = workspace({
          id: `workspace-${createCalls + 1}`,
          name: (input as { name: string }).name,
        });
        workspaces.push(value);
        return structuredClone(value);
      },
      createScratch: async () => {
        createCalls += 1;
        const value = workspace({ id: `workspace-${createCalls + 1}`, name: "Scratch", folderPath: "/private/scratch" });
        workspaces.push(value);
        return structuredClone(value);
      },
      createFromFolder: async (
        folderPath: string,
        name?: string,
        options?: { assertCurrent?: (identity: { canonicalPath: string; filesystemDevice: string; filesystemInode: string }) => Promise<void> | void },
      ) => {
        await options?.assertCurrent?.({
          canonicalPath: folderPath,
          filesystemDevice: "1",
          filesystemInode: "2",
        });
        createCalls += 1;
        const value = workspace({ id: `workspace-${createCalls + 1}`, name: name ?? "Selected", folderPath });
        workspaces.push(value);
        return structuredClone(value);
      },
      update: async (id: string, patch: unknown) => {
        const index = workspaces.findIndex((value) => value.id === id);
        if (index < 0) throw new Error("missing");
        workspaces[index] = { ...workspaces[index]!, ...(patch as Partial<Workspace>), updatedAt: workspaces[index]!.updatedAt + 1 };
        return structuredClone(workspaces[index]!);
      },
      remove: async (id: string) => {
        const existing = workspaces.find((value) => value.id === id);
        if (existing?.managedWorktree) throw new Error("Delete worktree through the managed worktree workflow.");
        workspaces = workspaces.filter((value) => value.id !== id);
      },
    },
    browser: {
      consumeSelection: async () => ({
        instanceId: "instance-1",
        deviceId: "device-1",
        rootId: "root-1",
        policyRevision: "policy-1",
        canonicalRootPath: "/approved",
        canonicalPath: "/approved/Selected",
        filesystemDevice: "1",
        filesystemInode: "2",
        expiresAt: 60_000,
        kind: "directory" as const,
      }),
      revalidateConsumedSelection: async (_deviceId, claims) => claims,
    },
    ...options,
    notifyChanged: () => { notifications += 1; },
  });
  return {
    service,
    createCalls: () => createCalls,
    notifications: () => notifications,
  };
}

test("workspace projections omit local paths and internal managed-worktree identity", () => {
  const projected = projectAidenRemoteWorkspace(workspace({
    folderPath: "/private/repository/worktree",
    managedWorktree: {
      repositoryPath: "/private/repository",
      worktreePath: "/private/repository/worktree",
      branch: "feature/mobile",
      worktreeGitDir: "/private/repository/.git/worktrees/mobile",
      ownershipToken: "secret-token",
      createdFromHead: "abc123",
    },
  }));
  const serialized = JSON.stringify(projected);
  assert.equal(projected.hasFolder, true);
  assert.equal(projected.isManagedWorktree, true);
  assert.equal(projected.branchName, "feature/mobile");
  assert.equal(projected.repositoryName, "repository");
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.match(projected.revision, /^rev_[A-Za-z0-9_-]{43}$/u);
});

test("workspace creates are exact, idempotent per device, and notify Electron once", async () => {
  const app = fixture([]);
  const key = "workspace-create-key-0001";
  const first = await app.service.create("device-1", key, {
    mode: "folderless",
    name: "Remote Project",
  });
  const replay = await app.service.create("device-1", key, {
    mode: "folderless",
    name: "Remote Project",
  });
  assert.deepEqual(replay, first);
  assert.equal(app.createCalls(), 1);
  assert.equal(app.notifications(), 1);

  await assert.rejects(
    app.service.create("device-1", key, { mode: "scratch" }),
    (error: unknown) => (error as { code?: string }).code === "idempotency_conflict",
  );
  await app.service.create("device-2", key, { mode: "scratch" });
  assert.equal(app.createCalls(), 2);
});

test("workspace idempotency is persisted before mutation and replays after restart", async () => {
  let persisted: AidenIdempotencySnapshot | undefined;
  const states: string[] = [];
  const first = fixture([], {
    persistIdempotency: async (snapshot) => {
      persisted = structuredClone(snapshot);
      states.push(snapshot.entries[0]?.state ?? "missing");
    },
  });
  const key = "durable-create-key-0001";
  const created = await first.service.create("device-1", key, {
    mode: "folderless",
    name: "Durable",
  });
  assert.deepEqual(states, ["in_flight", "fulfilled"]);
  assert.equal(first.createCalls(), 1);
  assert.ok(persisted);

  const restarted = fixture([], {
    idempotency: new AidenIdempotencyLedger(persisted),
  });
  const replay = await restarted.service.create("device-1", key, {
    mode: "folderless",
    name: "Durable",
  });
  assert.deepEqual(replay, created);
  assert.equal(restarted.createCalls(), 0);
  assert.equal(restarted.notifications(), 0);
});

test("selected-folder creation consumes only a browser-issued path and never accepts raw paths", async () => {
  const app = fixture([]);
  const created = await app.service.create("device-1", "selected-folder-key-01", {
    mode: "selected-folder",
    selection: `sel_${"a".repeat(43)}`,
    name: "Chosen",
  });
  assert.equal(created.name, "Chosen");
  assert.equal(created.hasFolder, true);
  assert.equal(JSON.stringify(created).includes("/approved/"), false);
  await assert.rejects(
    app.service.create("device-1", "selected-folder-key-02", {
      mode: "selected-folder",
      selection: `sel_${"b".repeat(43)}`,
      folderPath: "/private/escape",
    }),
    (error: unknown) => (error as { code?: string }).code === "invalid_request",
  );
});

test("workspace update and removal require the exact current revision", async () => {
  const app = fixture();
  const current = await app.service.get("workspace-1");
  await assert.rejects(
    app.service.update("workspace-1", "rev_stale", {
      confirmedForeground: true,
      name: "Changed",
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "revision_conflict" &&
      (error as { details?: { currentRevision?: string } }).details?.currentRevision === current.revision,
  );
  const updated = await app.service.update("workspace-1", current.revision, {
    confirmedForeground: true,
    permission: "full",
    memoryEnabled: false,
  });
  assert.equal(updated.permission, "full");
  assert.equal(updated.memoryEnabled, false);
  assert.notEqual(updated.revision, current.revision);
  await app.service.remove("workspace-1", updated.revision);
  assert.equal(app.notifications(), 2);
  await assert.rejects(
    app.service.get("workspace-1"),
    (error: unknown) => (error as { code?: string }).code === "not_found",
  );
});

test("managed worktrees cannot be unregistered through generic workspace CRUD", async () => {
  const app = fixture([workspace({
    managedWorktree: {
      repositoryPath: "/repo",
      worktreePath: "/repo/worktree",
      branch: "feature",
      createdFromHead: "abc123",
    },
  })]);
  const current = await app.service.get("workspace-1");
  await assert.rejects(
    app.service.remove("workspace-1", current.revision),
    (error: unknown) => (error as { code?: string }).code === "workspace_unavailable",
  );
});

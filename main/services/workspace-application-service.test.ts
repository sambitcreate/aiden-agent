import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace } from "./types.js";
import {
  createWorkspaceApplicationService,
  type WorkspaceApplicationDependencies,
} from "./workspace-application-service.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixture(options: { existing?: Workspace | null; saveError?: Error } = {}) {
  const events: string[] = [];
  const saved: Workspace[] = [];
  let existing = options.existing === undefined ? workspace() : options.existing;
  const deps = {
    configStore: {
      listWorkspaces: async () => existing ? [existing] : [],
      getWorkspace: async () => existing,
      saveWorkspace: async (value: Workspace) => {
        events.push("save");
        if (options.saveError) throw options.saveError;
        existing = value;
        saved.push(value);
        return value;
      },
      removeWorkspace: async () => { events.push("remove-record"); existing = null; },
    },
    llmClient: {
      cancelWorkspaceAndSettle: async () => { events.push("cancel-generations"); },
    },
    scheduleService: {
      cancelWorkspace: async () => { events.push("cancel-schedules"); },
      resumeWorkspace: async () => { events.push("resume-schedules"); },
    },
    terminalService: {
      closeForWorkspace: () => { events.push("close-terminal"); },
    },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    createScratchWorkspaceDirectory: async () => ({
      name: "Scratch",
      folderPath: "/tmp/aiden-scratch-test",
    }),
    realpath: async (value: string) => value,
    stat: async () => ({ isDirectory: () => true }),
    removeEmptyDirectory: async () => { events.push("remove-empty-directory"); },
    createId: () => "workspace-new",
    now: () => 123,
    logError: () => undefined,
  } as unknown as WorkspaceApplicationDependencies;
  return {
    service: createWorkspaceApplicationService(deps),
    deps,
    events,
    saved,
  };
}

test("shared workspace creation preserves defaults and rejects path authority", async () => {
  const application = fixture({ existing: null });
  const created = await application.service.create({ name: "  Project  ", permission: "invalid" });
  assert.deepEqual(created, {
    id: "workspace-new",
    name: "Project",
    permission: "ask",
    createdAt: 123,
    updatedAt: 123,
  });
  assert.throws(
    () => application.service.create({ folderPath: "/private/escape" }),
    /folder picker/u,
  );
});

test("shared workspace permission updates preserve cancellation and schedule restoration gates", async () => {
  const application = fixture({ existing: workspace({ permission: "full" }) });
  const updated = await application.service.update("workspace-1", {
    name: " Renamed ",
    permission: "none",
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.permission, "none");
  assert.deepEqual(application.events, [
    "close-terminal",
    "cancel-generations",
    "cancel-schedules",
    "save",
  ]);

  // The mutation lease must have released after the first update.
  await application.service.update("workspace-1", { name: "Again" });
  assert.equal(application.saved[application.saved.length - 1]?.name, "Again");
});

test("shared workspace mutations assert the current revision inside their mutation lease", async () => {
  const application = fixture();
  await assert.rejects(
    application.service.update(
      "workspace-1",
      { name: "Must not save" },
      { assertCurrent: () => { throw new Error("revision changed"); } },
    ),
    /revision changed/u,
  );
  assert.deepEqual(application.events, []);

  await assert.rejects(
    application.service.remove(
      "workspace-1",
      { assertCurrent: () => { throw new Error("revision changed"); } },
    ),
    /revision changed/u,
  );
  assert.deepEqual(application.events, []);
});

test("shared workspace removal never unregisters a managed worktree", async () => {
  const application = fixture({
    existing: workspace({
      folderPath: "/repo/worktree",
      managedWorktree: {
        repositoryPath: "/repo",
        worktreePath: "/repo/worktree",
        branch: "feature",
        createdFromHead: "abc123",
      },
    }),
  });
  await assert.rejects(application.service.remove("workspace-1"), /Delete worktree/u);
  assert.deepEqual(application.events, ["close-terminal"]);

  // The mutation lease releases even when removal is refused.
  await assert.rejects(application.service.remove("workspace-1"), /Delete worktree/u);
});

test("shared scratch creation removes an empty directory when persistence fails", async () => {
  const application = fixture({
    existing: null,
    saveError: new Error("persistence failed"),
  });
  await assert.rejects(application.service.createScratch(), /persistence failed/u);
  assert.deepEqual(application.events, ["save", "remove-empty-directory"]);
});

test("shared folder creation serializes duplicate registration and accepts a reviewed display name", async () => {
  const application = fixture({ existing: null });
  const [first, second] = await Promise.allSettled([
    application.service.createFromFolder("/approved/project", "Remote Project"),
    application.service.createFromFolder("/approved/project", "Duplicate"),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(first.status === "fulfilled" ? first.value.name : "", "Remote Project");
  assert.equal(second.status, "rejected");
  assert.match(
    second.status === "rejected" ? String(second.reason) : "",
    /already registered/u,
  );
  assert.equal(application.saved.length, 1);
});

test("shared folder creation revalidates selected identity before persistence", async () => {
  const application = fixture({ existing: null });
  await assert.rejects(
    application.service.createFromFolder(
      "/approved/project",
      "Project",
      {
        assertCurrent: ({ canonicalPath }) => {
          assert.equal(canonicalPath, "/approved/project");
          throw new Error("selected folder changed");
        },
      },
    ),
    /selected folder changed/u,
  );
  assert.equal(application.saved.length, 0);
});

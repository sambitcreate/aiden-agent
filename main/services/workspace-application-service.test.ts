import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION } from "../../renderer/shared/aiden-ui/types.js";
import { createScratchWorkspaceDirectory } from "./scratch-workspace.js";
import { WorkspaceArtifactStore } from "./workspace-artifacts/store.js";
import type { Workspace } from "./types.js";
import {
  createWorkspaceApplicationService,
  type WorkspaceApplicationDependencies,
} from "./workspace-application-service.js";
import { AppControlsService, appControlRevision, type StoredAppOperation } from "./app-controls-core.js";
import { createAidenAppTools } from "./aiden-app-tools.js";
import { cancelWorkspaceGenerationsAndSettle } from "./workspace-mutation-gate.js";
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
      saveWorkspace: async (value: Workspace, guard?: (current: Workspace | undefined) => void | Promise<void>) => {
        await guard?.(existing ?? undefined);
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
    browserService: {
      closeForWorkspace: () => { events.push("close-browser"); },
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
    memoryEnabled: false,
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.permission, "none");
  assert.equal(updated.memoryEnabled, false);
  assert.deepEqual(application.events, [
    "close-terminal",
    "close-browser",
    "cancel-generations",
    "cancel-schedules",
    "save",
  ]);

  // The mutation lease must have released after the first update.
  await application.service.update("workspace-1", { name: "Again" });
  assert.equal(application.saved[application.saved.length - 1]?.name, "Again");
});

test("switching skills and connectors off for a workspace applies from the next message", async () => {
  const application = fixture();
  const updated = await application.service.update("workspace-1", {
    disabledSkills: ["Review", " review ", 42, ""],
    disabledMcpServerIds: ["notion", "notion"],
  });
  assert.deepEqual(updated.disabledSkills, ["review"]);
  assert.deepEqual(updated.disabledMcpServerIds, ["notion"]);
  // A running reply keeps its tools: nothing is cancelled or paused.
  assert.deepEqual(application.events, ["save"]);

  const renamed = await application.service.update("workspace-1", { name: "Renamed" });
  assert.deepEqual(renamed.disabledSkills, ["review"], "an unrelated edit keeps the off-lists");

  const cleared = await application.service.update("workspace-1", {
    disabledSkills: [],
    disabledMcpServerIds: "not a list",
  });
  assert.equal("disabledSkills" in cleared, false);
  assert.equal("disabledMcpServerIds" in cleared, false);
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
  assert.deepEqual(application.events, ["close-terminal", "close-browser"]);

  // The mutation lease releases even when removal is refused.
  await assert.rejects(application.service.remove("workspace-1"), /Delete worktree/u);
});

test("scratch creation marks the workspace as scratch, and folder or named workspaces are not", async () => {
  const application = fixture({ existing: null });
  const scratch = await application.service.createScratch();
  assert.equal(scratch.scratch, true);
  assert.equal(application.saved[0]?.scratch, true, "the mark is persisted");
  assert.equal((await application.service.create({ name: "Named" })).scratch, undefined);
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


test("workspace authority revoked during cancellation is checked inside persistence and never saves", async () => {
  const application = fixture(); let current = true;
  application.deps.llmClient.cancelWorkspaceAndSettle = async () => { application.events.push("cancel-generations"); current = false; };
  await assert.rejects(application.service.update("workspace-1", { memoryEnabled: false }, {
    assertCurrent: () => { if (!current) throw new Error("revoked"); },
    beforeSave: () => { if (!current) throw new Error("revoked"); },
  }), /revoked/);
  assert.equal(application.saved.length, 0);
  assert.equal(application.events.includes("save"), false);
});


test("agent workspace Memory redirects before intent while the caller is awaiting its tool", async () => {
  const application = fixture();
  let finishCaller!: () => void;
  const completion = new Promise<void>((resolve) => { finishCaller = resolve; });
  const active = new Map([["caller", { workspaceId: "workspace-1", completion }]]);
  application.deps.llmClient.cancelWorkspaceAndSettle = async () => cancelWorkspaceGenerationsAndSettle({
    workspaceId: "workspace-1", initializations: () => new Map(), active: () => active,
    cancel: () => {}, abortChildren: () => {}, hasChildren: () => false,
    timeoutMs: 10, timeoutMessage: "caller cannot settle while awaiting its tool",
  });
  let ledger: StoredAppOperation[] = [];
  const state = { settings: {}, workspace: workspace() };
  const service = new AppControlsService({
    read: async () => state, loadOperations: async () => ledger,
    saveOperations: async (value) => { ledger = value; }, onChanged() {},
    commit: async (operation) => { await application.service.update("workspace-1", { memoryEnabled: operation.value }); },
  });
  const panels: unknown[] = [];
  const tool = createAidenAppTools({ service, context: { actor: "agent", workspaceId: "workspace-1", target: "This desktop", humanGesture: false, isCurrent: () => true }, present: (panel) => { panels.push(panel); } }).find((tool) => tool.name === "aiden_set_preference")!;
  const result = await tool.execute("call", { control: "memory.workspace", value: false,
    expectedRevision: appControlRevision(state, "memory.workspace"), operationId: "active_caller" }, undefined, undefined);
  finishCaller();
  assert.match(JSON.stringify(result.content), /foreground_required/u);
  assert.equal(panels.length, 1);
  assert.equal(ledger.length, 0);
  assert.deepEqual(application.events, []);
  assert.equal(application.saved.length, 0);
});

test("removing a workspace drops its artifacts, and a failure there does not undo the removal", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-workspace-artifacts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new WorkspaceArtifactStore({ root: () => dir });
  const compiled = compileAum('<Visual title="PRs"><Text>Open</Text></Visual>');
  await store.create(
    "workspace-1",
    {
      title: "PRs",
      visual: { version: 1, kind: "ui", id: "x", title: "PRs", catalogVersion: AIDEN_UI_CATALOG_VERSION, tree: compiled.tree!, fallbackText: "" },
      sources: [],
      actions: [],
      refresh: { onOpen: true },
    },
    { approved: false },
  );
  const application = fixture();
  (application.deps as { workspaceArtifacts?: unknown }).workspaceArtifacts = store;
  await application.service.remove("workspace-1");
  assert.deepEqual(await store.list("workspace-1"), []);
  assert.ok(application.events.includes("remove-record"));

  const failing = fixture();
  (failing.deps as { workspaceArtifacts?: unknown }).workspaceArtifacts = {
    removeWorkspace: async () => {
      throw new Error("disk full");
    },
  };
  await failing.service.remove("workspace-1");
  assert.ok(failing.events.includes("remove-record"));
});

async function noWorkspaceFixture(t: { after(fn: () => Promise<void>): void }, initial: Workspace[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-no-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = new Map(initial.map((entry) => [entry.id, entry]));
  const chatOwners = new Set<string>();
  const trashed: string[] = [];
  let nextId = 0;
  const deps = {
    configStore: {
      listWorkspaces: async () => [...registry.values()],
      getWorkspace: async (id: string) => registry.get(id),
      saveWorkspace: async (value: Workspace, guard?: (current: Workspace | undefined) => void | Promise<void>) => {
        await guard?.(registry.get(value.id));
        registry.set(value.id, value);
        return value;
      },
      removeWorkspace: async (id: string) => { registry.delete(id); },
    },
    llmClient: { cancelWorkspaceAndSettle: async () => undefined },
    scheduleService: { cancelWorkspace: async () => undefined, resumeWorkspace: async () => undefined },
    terminalService: { closeForWorkspace: () => undefined },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    createScratchWorkspaceDirectory: async () => { throw new Error("not used"); },
    realpath: async (value: string) => value,
    stat: (value: string) => fs.stat(value),
    removeEmptyDirectory: (value: string) => fs.rmdir(value),
    noWorkspace: {
      createDirectory: () => createScratchWorkspaceDirectory(path.join(root, "chat-folders")),
      workspaceIdsWithChats: async () => new Set(chatOwners),
      trash: async (folderPath: string) => {
        trashed.push(folderPath);
        await fs.rm(folderPath, { recursive: true });
      },
    },
    createId: () => `hidden-${++nextId}`,
    now: () => 500,
    logError: () => undefined,
  } as unknown as WorkspaceApplicationDependencies;
  return { service: createWorkspaceApplicationService(deps), registry, chatOwners, trashed, root };
}

const exists = (target: string) => fs.stat(target).then(() => true, () => false);

test("each No workspace chat gets its own hidden folder in Aiden's app data", async (t) => {
  const app = await noWorkspaceFixture(t, []);
  const first = await app.service.createNoWorkspace();
  const second = await app.service.createNoWorkspace();
  assert.equal(first.noWorkspace, true);
  assert.equal(first.name, "No workspace");
  assert.notEqual(first.folderPath, second.folderPath);
  for (const created of [first, second]) {
    assert.equal(path.dirname(created.folderPath!), path.join(app.root, "chat-folders"));
    assert.equal((await fs.stat(created.folderPath!)).isDirectory(), true);
  }
  assert.equal(app.registry.size, 2);
});

test("startup gives the folderless default workspace a hidden folder and keeps its chats", async (t) => {
  const app = await noWorkspaceFixture(t, [
    workspace({ id: "default", name: "Workspace", permission: "full" }),
    workspace({ id: "project", folderPath: "/code/project" }),
  ]);
  app.chatOwners.add("default");
  await app.service.prepareNoWorkspaceChats();
  const home = app.registry.get("default")!;
  assert.equal(home.noWorkspace, true);
  assert.equal(home.permission, "full", "the user's access level is kept");
  assert.equal(await exists(home.folderPath!), true);
  assert.equal(app.registry.get("project")?.noWorkspace, undefined);

  // A second start leaves it alone.
  await app.service.prepareNoWorkspaceChats();
  assert.equal(app.registry.get("default")?.folderPath, home.folderPath);
});

test("startup releases hidden folders whose draft was never sent, but never the default home", async (t) => {
  const app = await noWorkspaceFixture(t, [
    workspace({ id: "default", name: "No workspace", folderPath: "/data/chat-folders/home", noWorkspace: true }),
  ]);
  const abandoned = await app.service.createNoWorkspace();
  const used = await app.service.createNoWorkspace();
  app.chatOwners.add(used.id);
  await app.service.prepareNoWorkspaceChats();
  assert.equal(app.registry.has(abandoned.id), false);
  assert.equal(await exists(abandoned.folderPath!), false);
  assert.deepEqual(app.trashed, [], "an empty folder is simply removed");
  assert.equal(app.registry.has(used.id), true);
  assert.equal(app.registry.has("default"), true);
});

test("deleting the last chat of a No workspace folder moves the folder's files to the Trash", async (t) => {
  const app = await noWorkspaceFixture(t, [workspace({ id: "project", folderPath: "/code/project" })]);
  const hidden = await app.service.createNoWorkspace();
  app.chatOwners.add(hidden.id);
  await fs.writeFile(path.join(hidden.folderPath!, "notes.md"), "kept until deleted");

  await app.service.releaseNoWorkspaceAfterChat(hidden.id);
  assert.equal(app.registry.has(hidden.id), true, "a folder still used by a chat stays");

  app.chatOwners.delete(hidden.id);
  await app.service.releaseNoWorkspaceAfterChat(hidden.id);
  assert.equal(app.registry.has(hidden.id), false);
  assert.deepEqual(app.trashed, [hidden.folderPath]);

  await app.service.releaseNoWorkspaceAfterChat("project");
  assert.equal(app.registry.has("project"), true, "a real workspace is never released with a chat");
});

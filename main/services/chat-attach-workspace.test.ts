import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { parseAttachToWorkspaceRequest } from "../../renderer/shared/chat-attach-workspace.js";
import { parseChatFirstMessage } from "../handlers/chat-first-message-params.js";
import { createChatStore } from "./chat-store-core.js";
import { createChatApplicationService } from "./chat-application-service.js";
import {
  copyScratchFilesToWorkspace,
  copyScratchFilesToWorkspaceWithRollback,
  inspectScratchFolderFiles,
} from "./chat-attach-workspace.js";
import {
  projectVisibleHistoryWithoutSkills,
  recordPiWorkspaceAttachedBoundary,
} from "./pi-compaction-session-store.js";
import type { PiSessionEntry, PiSessionPort } from "./pi-session-port.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import { filterRemoteVisibleWorkspaces } from "./visible-chat-projection.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";
import type { Workspace } from "./types.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-attach-ws-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("parseAttachToWorkspaceRequest accepts valid inputs and rejects malformed fields", () => {
  assert.deepEqual(
    parseAttachToWorkspaceRequest({
      chatId: "chat-1",
      targetWorkspaceId: "ws-1",
      fileAction: "copy",
    }),
    { chatId: "chat-1", targetWorkspaceId: "ws-1", fileAction: "copy" },
  );
  assert.deepEqual(
    parseAttachToWorkspaceRequest({ chatId: "chat-1", targetWorkspaceId: "ws-1" }),
    { chatId: "chat-1", targetWorkspaceId: "ws-1" },
  );
  assert.throws(() => parseAttachToWorkspaceRequest({ chatId: "", targetWorkspaceId: "ws-1" }));
  assert.throws(() =>
    parseAttachToWorkspaceRequest({ chatId: "chat-1", targetWorkspaceId: "ws-1", fileAction: "delete" }),
  );
  assert.throws(() =>
    parseAttachToWorkspaceRequest({ chatId: "chat-1", targetWorkspaceId: "ws-1", extra: true }),
  );
});

test("parseChatFirstMessage parses ephemeral flag and rejects ephemeral + worktree", () => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  const parsed = parseChatFirstMessage({
    draftId,
    workspaceId: "default",
    turnId: "turn-1",
    ephemeral: true,
    message: { role: "user", content: "Quick question" },
  });
  assert.equal(parsed.ephemeral, true);

  assert.throws(() =>
    parseChatFirstMessage({
      draftId,
      workspaceId: "default",
      turnId: "turn-1",
      ephemeral: true,
      worktree: { sourceWorkspaceId: "default", baseRef: "main", fromOrigin: false, idempotencyKey: draftId },
      message: { role: "user", content: "Quick question" },
    }),
  );
});

test("inspectScratchFolderFiles lists regular files and skips symlinks, .git, and .aiden", async () => {
  await withTempDir(async (dir) => {
    const scratch = path.join(dir, "scratch");
    await fs.mkdir(path.join(scratch, "sub"), { recursive: true });
    await fs.mkdir(path.join(scratch, ".git"), { recursive: true });
    await fs.mkdir(path.join(scratch, ".aiden"), { recursive: true });
    await fs.writeFile(path.join(scratch, "notes.md"), "hello");
    await fs.writeFile(path.join(scratch, "sub", "data.json"), "{\"ok\":true}");
    await fs.writeFile(path.join(scratch, ".DS_Store"), "junk");
    await fs.writeFile(path.join(scratch, ".git", "config"), "ignored");
    await fs.writeFile(path.join(scratch, ".aiden", "hooks.json"), "ignored");
    await fs.symlink(path.join(scratch, "notes.md"), path.join(scratch, "link.md"));

    const result = await inspectScratchFolderFiles(scratch);
    assert.equal(result.hasFiles, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.entries.map((entry) => entry.relativePath),
      ["notes.md", "sub/data.json"],
    );
    assert.equal(result.totalBytes, Buffer.byteLength("hello") + Buffer.byteLength("{\"ok\":true}"));

    const missing = await inspectScratchFolderFiles(path.join(dir, "does-not-exist"));
    assert.equal(missing.hasFiles, false);
    assert.deepEqual(missing.entries, []);
  });
});

test("copyScratchFilesToWorkspace copies cleanly and uses collision-free subfolder when files exist", async () => {
  await withTempDir(async (dir) => {
    const scratch = path.join(dir, "scratch");
    const project = path.join(dir, "project");
    await fs.mkdir(scratch, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(scratch, "notes.md"), "draft notes");

    // No collision: copied directly into project root.
    const copiedDirect = await copyScratchFilesToWorkspace(scratch, project);
    assert.deepEqual(copiedDirect, ["notes.md"]);
    assert.equal(await fs.readFile(path.join(project, "notes.md"), "utf8"), "draft notes");

    // Collision: existing notes.md must NOT be overwritten; falls back to aiden-scratch/.
    await fs.writeFile(path.join(scratch, "notes.md"), "newer scratch notes");
    const copiedSubfolder = await copyScratchFilesToWorkspace(scratch, project);
    assert.deepEqual(copiedSubfolder, ["aiden-scratch/notes.md"]);
    assert.equal(await fs.readFile(path.join(project, "notes.md"), "utf8"), "draft notes");
    assert.equal(
      await fs.readFile(path.join(project, "aiden-scratch", "notes.md"), "utf8"),
      "newer scratch notes",
    );
  });
});

test("ephemeral chat stays hidden from listRegular, promotes cleanly, and attaches in-place to a workspace", async () => {
  await withTempDir(async (dir) => {
    const storeDir = path.join(dir, "chats");
    const scratchDir = path.join(dir, "chat-folders", "quick-owl");
    const projectDir = path.join(dir, "my-project");
    await fs.mkdir(scratchDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(scratchDir, "plan.md"), "# Plan");

    const chatStore = createChatStore(
      async () => {
        await fs.mkdir(storeDir, { recursive: true });
        return storeDir;
      },
      async (id) => id,
    );

    const workspaces = new Map<string, Workspace>([
      [
        "nows-1",
        {
          id: "nows-1",
          name: "No workspace",
          folderPath: scratchDir,
          permission: "ask",
          noWorkspace: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "ws-project",
        {
          id: "ws-project",
          name: "My Project",
          folderPath: projectDir,
          permission: "ask",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    let busy = false;
    const recordedBoundaries: Array<{ chatId: string; targetWorkspaceId: string; copiedPaths?: readonly string[] }> = [];
    const revokedDesign: string[] = [];
    const releasedContext: string[] = [];
    const invalidatedWorkspaceContext: string[] = [];
    const resetSessions: string[] = [];
    const deletedMemory: string[] = [];
    const releasedWorkspaces: string[] = [];
    const workspaceOperationRegistry = new WorkspaceOperationRegistry();

    const service = createChatApplicationService({
      chatStore,
      configStore: {
        getWorkspace: async (id) => workspaces.get(id),
      },
      llmClient: {
        isChatOwnedByInactiveRenderer: () => false,
        isChatBusy: () => busy,
        waitForChatIdle: async () => true,
        requiresAppendReconciliation: () => false,
        markAppendReconciliationRequired: () => undefined,
        clearAppendReconciliationRequired: () => undefined,
        beginChatWorkspaceChange: () => (busy ? null : () => undefined),
        beginChatDeletion: () => () => undefined,
        cancelChat: async () => undefined,
      },
      displayImageArtifactStore: {
        availability: () => ({ available: false, reason: "test" }),
        hasPending: async () => false,
        deleteChat: async () => undefined,
      },
      generativeUiArtifactStore: {
        availability: () => ({ available: false, reason: "test" }),
        hasPending: async () => false,
        deleteChat: async () => undefined,
      },
      workspaceMutationGate: new WorkspaceMutationGate(),
      workspaceOperationRegistry,
      subagentRunStore: {
        deleteChat: async () => undefined,
        completeChatDeletion: async () => undefined,
        pendingChatDeletions: async () => [],
      },
      piRuntimeEffectStore: { deleteChat: async () => undefined },
      piCompactionSessionStore: {
        deleteChat: async () => undefined,
        recordWorkspaceAttached: async (chatId, info) => {
          recordedBoundaries.push({
            chatId,
            targetWorkspaceId: info.targetWorkspaceId,
            copiedPaths: info.copiedPaths,
          });
          return true;
        },
      },
      designGrants: { revokeChat: (id) => revokedDesign.push(id) },
      releaseChatContext: (id) => releasedContext.push(id),
      invalidateChatWorkspaceContext: (id) => invalidatedWorkspaceContext.push(id),
      resetChatWorkspaceSession: async (id) => {
        resetSessions.push(id);
      },
      memoryStore: {
        deleteSourceChat: async (id) => {
          deletedMemory.push(id);
          return 1;
        },
      },
      afterChatRemoved: async (wsId) => {
        // Real releaseNoWorkspaceAfterChat calls cancelAndSettle(oldWorkspaceId).
        // Admissions MUST already be released here or this deadlocks until timeout.
        await workspaceOperationRegistry.cancelAndSettle(wsId, { timeoutMs: 500 });
        releasedWorkspaces.push(wsId);
      },
      assertManagedWorktreeAdmission: async () => undefined,
      logError: () => undefined,
    });

    const owner = {
      documentId: "doc-1",
      isDestroyed: () => false,
      onInvalidated: () => () => undefined,
    };

    const chatId = "22222222-2222-4222-8222-222222222222";
    const created = await chatStore.createWithFirstMessage({
      id: chatId,
      workspaceId: "nows-1",
      ephemeral: true,
      turnId: "turn-1",
      fingerprint: "fp-1",
      message: { id: "msg-1", content: "Draft a plan" },
      assertCurrent: () => undefined,
    });
    assert.equal(created.ephemeral, true);

    // Ephemeral chat is in raw list() (so GC keeps its journal) but hidden from listRegular().
    assert.equal((await chatStore.list()).some((m) => m.id === chatId), true);
    assert.equal((await chatStore.listRegular()).some((m) => m.id === chatId), false);

    // Busy chat refuses attach.
    busy = true;
    await assert.rejects(
      () => service.attachToWorkspace(chatId, "ws-project", { fileAction: "copy", owner }),
      /Finish or stop the current response/u,
    );
    busy = false;

    // Inspect finds scratch file.
    const inspected = await service.inspectAttachFiles(chatId);
    assert.equal(inspected.hasFiles, true);
    assert.deepEqual(inspected.entries.map((e) => e.relativePath), ["plan.md"]);

    // Omitting fileAction when scratch files exist must reject without mutating chat or trashing scratch files.
    await assert.rejects(
      () => service.attachToWorkspace(chatId, "ws-project", { owner }),
      /Choose whether to copy them/u,
    );
    assert.equal((await chatStore.get(chatId))?.workspaceId, "nows-1");
    assert.equal((await chatStore.get(chatId))?.ephemeral, true);
    assert.equal(await fs.readFile(path.join(scratchDir, "plan.md"), "utf8"), "# Plan");
    assert.deepEqual(releasedWorkspaces, []);

    // Attach in-place with owner + fileAction: "copy" (verifies zero self-deadlock on cancelAndSettle).
    const attached = await service.attachToWorkspace(chatId, "ws-project", { fileAction: "copy", owner });
    assert.equal(attached.chat.workspaceId, "ws-project");
    assert.equal(attached.chat.ephemeral, undefined);
    assert.equal(attached.oldWorkspaceId, "nows-1");
    assert.deepEqual(attached.copiedPaths, ["plan.md"]);
    assert.equal(await fs.readFile(path.join(projectDir, "plan.md"), "utf8"), "# Plan");
    assert.notEqual(attached.chat.summaryRevision, created.summaryRevision);

    // Now visible in listRegular under ws-project, with all caches/boundaries updated
    // and destructive releaseChatContext (spending wipe) NOT called on attach.
    assert.equal((await chatStore.listRegular("ws-project")).some((m) => m.id === chatId), true);
    assert.deepEqual(recordedBoundaries, [
      { chatId, targetWorkspaceId: "ws-project", copiedPaths: ["plan.md"] },
    ]);
    assert.deepEqual(revokedDesign, [chatId]);
    assert.deepEqual(releasedContext, []);
    assert.deepEqual(invalidatedWorkspaceContext, [chatId]);
    assert.deepEqual(resetSessions, [chatId]);
    assert.deepEqual(deletedMemory, [chatId]);
    assert.deepEqual(releasedWorkspaces, ["nows-1"]);

    // Second ephemeral chat tests promoteEphemeral + sweepOrphanedEphemeralChats.
    const savedId = "33333333-3333-4333-8333-333333333333";
    const orphanId = "44444444-4444-4444-8444-444444444444";
    await chatStore.create({ id: savedId, workspaceId: "nows-1", ephemeral: true });
    await chatStore.create({ id: orphanId, workspaceId: "nows-1", ephemeral: true });
    const promoted = await service.promoteEphemeral(savedId);
    assert.equal(promoted.ephemeral, undefined);
    assert.equal((await chatStore.listRegular()).some((m) => m.id === savedId), true);

    const swept = await service.sweepOrphanedEphemeralChats();
    assert.equal(swept, 1);
    assert.equal(await chatStore.get(orphanId), null);
    assert.notEqual(await chatStore.get(savedId), null);
    // Deletion of orphan DID invoke releaseChatContext.
    assert.deepEqual(releasedContext, [orphanId]);
  });
});

test("copyScratchFilesToWorkspaceWithRollback removes created files and dirs on rollback", async () => {
  await withTempDir(async (dir) => {
    const scratch = path.join(dir, "scratch");
    const project = path.join(dir, "project");
    await fs.mkdir(path.join(scratch, "nested"), { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(scratch, "nested", "draft.txt"), "hello");

    const tx = await copyScratchFilesToWorkspaceWithRollback(scratch, project);
    assert.deepEqual(tx.copiedPaths, ["nested/draft.txt"]);
    assert.equal(await fs.readFile(path.join(project, "nested", "draft.txt"), "utf8"), "hello");

    await tx.rollback();
    await assert.rejects(() => fs.lstat(path.join(project, "nested", "draft.txt")));
    await assert.rejects(() => fs.lstat(path.join(project, "nested")));
  });
});

test("recordPiWorkspaceAttachedBoundary survives both normal context and skill-free projection", async () => {
  const entries: PiSessionEntry[] = [];
  let seq = 0;
  const session: PiSessionPort = {
    async appendMessage(message: AgentMessage) {
      const id = `entry-${++seq}`;
      const parentId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
      entries.push({ type: "message", id, parentId, seq, timestamp: Date.now(), message });
      return id;
    },
    async appendCustomEntry(customType: string, data?: unknown) {
      const id = `entry-${++seq}`;
      const parentId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
      entries.push({ type: "custom", id, parentId, seq, timestamp: Date.now(), customType, data });
      return id;
    },
    async appendCompaction() { throw new Error("unused"); },
    async appendBranchSummary() { throw new Error("unused"); },
    async importBranch() { throw new Error("unused"); },
    async getBranch() { return [...entries]; },
    async getEntries() { return [...entries]; },
    async buildContext(given) {
      const branch = given ?? entries;
      const messages = branch.filter((e) => e.type === "message").map((e) => e.message);
      return { messages, thinkingLevel: "off", model: null, activeToolNames: null };
    },
    async getLeafId() { return entries.length > 0 ? entries[entries.length - 1]!.id : null; },
    async getMetadata() { return { id: "chat-1", createdAt: 1 }; },
    async moveTo() { return undefined; },
    withEntryProjectors() { return session; },
  };

  // Chronological placement: attach after u1, then add u2 and u3 -> skill-free keeps note after u1 (NOT after u3).
  await session.appendCustomEntry("aiden.chat-message.v1", { chatMessageId: "u1" });
  await recordPiWorkspaceAttachedBoundary(session, {
    targetWorkspaceId: "ws-proj",
    targetWorkspaceName: "My Repo",
    targetFolderPath: "/tmp/my-repo",
    copiedPaths: ["notes.md"],
  });
  await session.appendCustomEntry("aiden.chat-message.v1", { chatMessageId: "u2" });
  await session.appendCustomEntry("aiden.chat-message.v1", { chatMessageId: "u3" });

  const normalContext = await session.buildContext();
  assert.equal(normalContext.messages.length, 1);
  const normalText = JSON.stringify(normalContext.messages[0]);
  assert.match(normalText, /My Repo/);
  assert.match(normalText, /notes\.md/);

  const dummyModel = { id: "m", api: "openai-completions", provider: "openai" } as unknown as Model<Api>;
  const projected = await projectVisibleHistoryWithoutSkills(
    session,
    [
      { id: "u1", role: "user", content: "first turn", createdAt: 1 },
      { id: "u2", role: "user", content: "second turn", createdAt: 2 },
      { id: "u3", role: "user", content: "third turn", createdAt: 3 },
    ],
    dummyModel,
  );
  const skillFreeContext = await projected.buildContext();
  assert.equal(skillFreeContext.messages.length, 4);
  assert.match(JSON.stringify(skillFreeContext.messages[0]), /first turn/);
  const boundaryText = JSON.stringify(skillFreeContext.messages[1]);
  assert.match(boundaryText, /My Repo/);
  assert.match(boundaryText, /notes\.md/);
  assert.match(JSON.stringify(skillFreeContext.messages[2]), /second turn/);
  assert.match(JSON.stringify(skillFreeContext.messages[3]), /third turn/);
});

test("inspectScratchFolderFiles skips protected agent-config files identically to copy", async () => {
  await withTempDir(async (dir) => {
    const scratch = path.join(dir, "scratch");
    await fs.mkdir(path.join(scratch, ".claude"), { recursive: true });
    await fs.mkdir(path.join(scratch, ".codex"), { recursive: true });
    await fs.writeFile(path.join(scratch, ".claude", "settings.json"), "{}");
    await fs.writeFile(path.join(scratch, ".codex", "config.toml"), "");
    await fs.writeFile(path.join(scratch, "visible.md"), "ok");

    const inspected = await inspectScratchFolderFiles(scratch);
    assert.deepEqual(
      inspected.entries.map((e) => e.relativePath),
      ["visible.md"],
    );
  });
});

test("legacy shared No-workspace folder refuses copying sibling chats' files and attaches cleanly without copying", async () => {
  await withTempDir(async (dir) => {
    const storeDir = path.join(dir, "chats");
    const legacyScratchDir = path.join(dir, "legacy-nows");
    const projectDir = path.join(dir, "project");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.mkdir(legacyScratchDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(legacyScratchDir, "other-chat.txt"), "belongs to sibling");

    const chatStore = createChatStore(async () => storeDir);
    const workspaces: Record<string, Workspace> = {
      "nows-legacy": {
        id: "nows-legacy",
        name: "No workspace",
        folderPath: legacyScratchDir,
        permission: "ask",
        noWorkspace: true,
        createdAt: 1,
        updatedAt: 1,
      },
      "ws-project": {
        id: "ws-project",
        name: "Project",
        folderPath: projectDir,
        permission: "ask",
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const service = createChatApplicationService({
      chatStore,
      configStore: { getWorkspace: async (id) => workspaces[id] ?? null },
      llmClient: {
        isChatOwnedByInactiveRenderer: () => false,
        isChatBusy: () => false,
        waitForChatIdle: async () => true,
        requiresAppendReconciliation: () => false,
        markAppendReconciliationRequired: () => undefined,
        clearAppendReconciliationRequired: () => undefined,
        beginChatWorkspaceChange: () => () => undefined,
        beginChatDeletion: () => () => undefined,
        cancelChat: async () => undefined,
      },
      displayImageArtifactStore: {
        availability: () => ({ available: false, reason: "test" }),
        hasPending: async () => false,
        deleteChat: async () => undefined,
      },
      generativeUiArtifactStore: {
        availability: () => ({ available: false, reason: "test" }),
        hasPending: async () => false,
        deleteChat: async () => undefined,
      },
      workspaceMutationGate: new WorkspaceMutationGate(),
      workspaceOperationRegistry: new WorkspaceOperationRegistry(),
      subagentRunStore: {
        deleteChat: async () => undefined,
        completeChatDeletion: async () => undefined,
        pendingChatDeletions: async () => [],
      },
      piRuntimeEffectStore: { deleteChat: async () => undefined },
      piCompactionSessionStore: { deleteChat: async () => undefined },
      assertManagedWorktreeAdmission: async () => undefined,
      logError: () => undefined,
    });

    const chatA = "55555555-5555-4555-8555-555555555555";
    const chatB = "66666666-6666-4666-8666-666666666666";
    await chatStore.create({ id: chatA, workspaceId: "nows-legacy" });
    await chatStore.create({ id: chatB, workspaceId: "nows-legacy" });

    // Must not list sibling chats' files for carry-over or trash.
    const inspected = await service.inspectAttachFiles(chatA);
    assert.equal(inspected.hasFiles, false);
    assert.deepEqual(inspected.entries, []);

    // Explicitly requesting copy on a shared legacy folder is refused.
    await assert.rejects(
      () => service.attachToWorkspace(chatA, "ws-project", { fileAction: "copy" }),
      /shares a legacy No workspace folder/u,
    );

    // Attaching with omitted fileAction moves only chatA and leaves sibling files untouched.
    const attached = await service.attachToWorkspace(chatA, "ws-project");
    assert.equal(attached.chat.workspaceId, "ws-project");
    assert.deepEqual(attached.copiedPaths, []);
    await assert.rejects(() => fs.lstat(path.join(projectDir, "other-chat.txt")));
    assert.equal(
      await fs.readFile(path.join(legacyScratchDir, "other-chat.txt"), "utf8"),
      "belongs to sibling",
    );
  });
});

test("filterRemoteVisibleWorkspaces performs at most one chat-store scan across many No-workspace entries", async () => {
  const workspaces: Workspace[] = [
    { id: "default", name: "No workspace", folderPath: "/tmp/d", permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 1 },
    { id: "ws-real", name: "Real", folderPath: "/tmp/r", permission: "ask", createdAt: 1, updatedAt: 1 },
  ];
  const chats: Array<{ workspaceId: string; ephemeral?: true }> = [];
  for (let i = 0; i < 40; i += 1) {
    const id = `nows-ephem-${i}`;
    workspaces.push({ id, name: "No workspace", folderPath: `/tmp/${id}`, permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 1 });
    chats.push({ workspaceId: id, ephemeral: true });
  }
  for (let i = 0; i < 10; i += 1) {
    const id = `nows-saved-${i}`;
    workspaces.push({ id, name: "No workspace", folderPath: `/tmp/${id}`, permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 1 });
    chats.push({ workspaceId: id });
  }

  let listCalls = 0;
  const visible = await filterRemoteVisibleWorkspaces(workspaces, async () => {
    listCalls += 1;
    return chats;
  });
  assert.equal(listCalls, 1, "must scan chatStore at most once regardless of No-workspace count");
  assert.equal(visible.length, 12); // default + ws-real + 10 saved
  assert.equal(visible.some((w) => w.id.startsWith("nows-ephem-")), false);

  // Zero scans when only regular/default workspaces exist.
  let zeroCalls = 0;
  const realOnly = await filterRemoteVisibleWorkspaces(
    workspaces.slice(0, 2),
    async () => {
      zeroCalls += 1;
      return [];
    },
  );
  assert.equal(zeroCalls, 0);
  assert.equal(realOnly.length, 2);
});

test("AidenRemoteWorkspaceService hides ephemeral-only hidden workspaces from list, get, update, and remove", async () => {
  const list: Workspace[] = [
    { id: "ws-1", name: "App", folderPath: "/tmp/app", permission: "ask", createdAt: 1, updatedAt: 1 },
    { id: "nows-ephemeral", name: "No workspace", folderPath: "/tmp/nows-e", permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 1 },
  ];
  const remote = new AidenRemoteWorkspaceService({
    application: {
      list: async () => list,
      get: async (id) => list.find((w) => w.id === id) ?? null,
      create: async () => { throw new Error("unused"); },
      createScratch: async () => { throw new Error("unused"); },
      createFromFolder: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
      remove: async () => undefined,
    },
    browser: {
      consumeSelection: () => { throw new Error("unused"); },
      revalidateConsumedSelection: async () => { throw new Error("unused"); },
    },
    isWorkspaceHidden: (workspace) => workspace.id === "nows-ephemeral",
  });

  const listed = await remote.list();
  assert.deepEqual(listed.workspaces.map((w) => w.id), ["ws-1"]);
  await assert.rejects(() => remote.get("nows-ephemeral"), /no longer exists/u);
  await assert.rejects(() => remote.update("nows-ephemeral", "rev_1", { name: "X" }), /no longer exists/u);
  await assert.rejects(() => remote.remove("nows-ephemeral", "rev_1"), /no longer exists/u);
  assert.equal((await remote.get("ws-1")).id, "ws-1");
});

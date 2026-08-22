import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Workspace } from "./types.js";
import {
  createChatApplicationService,
  type ChatApplicationDependencies,
  type ChatApplicationOwner,
} from "./chat-application-service.js";
import { WorkspaceOperationRegistry } from "./workspace-operation-registry.js";

function chat(id = "chat-1", workspaceId = "workspace-1"): Chat {
  return {
    id,
    title: "Chat",
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
}

function owner(): ChatApplicationOwner & { invalidate(): void } {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    documentId: "renderer:document-1",
    isDestroyed: () => destroyed,
    onInvalidated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function fixture(overrides: Partial<ChatApplicationDependencies> = {}) {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Workspace",
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  };
  let assertCreateCurrent: (() => void) | undefined;
  let finishDeletionCalls = 0;
  const deps = {
    chatStore: {
      list: async () => [chat()],
      get: async (id: string) => chat(id),
      create: async (input: { assertCurrent?: () => void; workspaceId?: string }) => {
        assertCreateCurrent = input.assertCurrent;
        input.assertCurrent?.();
        return chat("created", input.workspaceId);
      },
      rename: async () => chat(),
      moveEmptyChatToWorkspace: async (id: string, workspaceId: string) =>
        chat(id, workspaceId),
      remove: async () => undefined,
    },
    configStore: { getWorkspace: async (id: string) => id === workspace.id ? workspace : null },
    llmClient: {
      isChatOwnedByInactiveRenderer: () => false,
      waitForChatIdle: async () => true,
      requiresAppendReconciliation: () => false,
      markAppendReconciliationRequired: () => undefined,
      clearAppendReconciliationRequired: () => undefined,
      beginChatWorkspaceChange: () => () => undefined,
      beginChatDeletion: () => () => { finishDeletionCalls += 1; },
      cancelChat: async () => undefined,
    },
    workspaceMutationGate: {
      admit: () => ({ signal: new AbortController().signal, release: () => undefined }),
    },
    workspaceOperationRegistry: new WorkspaceOperationRegistry(),
    subagentRunStore: {
      deleteChat: async () => undefined,
      completeChatDeletion: async () => undefined,
      pendingChatDeletions: async () => [],
    },
    piRuntimeEffectStore: { deleteChat: async () => undefined },
    piCompactionSessionStore: { deleteChat: async () => undefined },
    logError: () => undefined,
    ...overrides,
  } as unknown as ChatApplicationDependencies;
  return {
    service: createChatApplicationService(deps),
    assertCreateCurrent: () => assertCreateCurrent?.(),
    finishDeletionCalls: () => finishDeletionCalls,
  };
}

test("shared chat creation preserves workspace and renderer-owner commit gates", async () => {
  const application = fixture();
  const requestOwner = owner();
  const created = await application.service.create(
    { workspaceId: "workspace-1", title: "Chat" },
    requestOwner,
  );
  assert.equal(created?.id, "created");
  requestOwner.invalidate();
  assert.throws(application.assertCreateCurrent, /renderer document is no longer active/u);

  await assert.rejects(
    application.service.create(
      { workspaceId: "missing", title: "Chat" },
      owner(),
    ),
    /selected workspace is no longer available/u,
  );
});

test("shared chat reads retain inactive-renderer reconciliation semantics", async () => {
  let checks = 0;
  const application = fixture({
    llmClient: {
      isChatOwnedByInactiveRenderer: () => ++checks <= 2,
      waitForChatIdle: async () => false,
      requiresAppendReconciliation: () => false,
      markAppendReconciliationRequired: () => undefined,
      clearAppendReconciliationRequired: () => undefined,
      beginChatWorkspaceChange: () => () => undefined,
      beginChatDeletion: () => () => undefined,
      cancelChat: async () => undefined,
    } as ChatApplicationDependencies["llmClient"],
  });
  assert.deepEqual((await application.service.get("chat-1")).reconciliation, {
    chatId: "chat-1",
    workspaceId: "workspace-1",
  });
});

test("shared chat deletion keeps admission closed while a durable delete is pending", async () => {
  const events: string[] = [];
  const application = fixture({
    chatStore: {
      list: async () => [],
      get: async () => chat(),
      create: async () => chat(),
      rename: async () => chat(),
      moveEmptyChatToWorkspace: async () => chat(),
      remove: async () => { throw new Error("disk failed"); },
    } as ChatApplicationDependencies["chatStore"],
    subagentRunStore: {
      deleteChat: async () => { events.push("private-delete"); },
      completeChatDeletion: async () => { events.push("complete"); },
      pendingChatDeletions: async () => ["chat-1"],
    } as ChatApplicationDependencies["subagentRunStore"],
    piRuntimeEffectStore: { deleteChat: async () => { events.push("effects-delete"); } },
    piCompactionSessionStore: { deleteChat: async () => { events.push("compaction-delete"); } },
  });

  await assert.rejects(application.service.remove("chat-1"), /disk failed/u);
  assert.deepEqual(events, ["private-delete", "effects-delete", "compaction-delete"]);
  assert.equal(application.finishDeletionCalls(), 0);
});

test("chat deletion checks a remote revision before cancellation or private-history changes", async () => {
  const effects: string[] = [];
  const application = fixture({
    llmClient: {
      isChatOwnedByInactiveRenderer: () => false,
      waitForChatIdle: async () => true,
      requiresAppendReconciliation: () => false,
      markAppendReconciliationRequired: () => undefined,
      clearAppendReconciliationRequired: () => undefined,
      beginChatWorkspaceChange: () => () => undefined,
      beginChatDeletion: () => () => undefined,
      cancelChat: async () => { effects.push("cancel"); },
    } as ChatApplicationDependencies["llmClient"],
    subagentRunStore: {
      deleteChat: async () => { effects.push("subagents"); },
      completeChatDeletion: async () => undefined,
      pendingChatDeletions: async () => [],
    },
  });
  await assert.rejects(
    application.service.remove("chat-1", {
      assertCurrent: () => { throw new Error("stale revision"); },
    }),
    /stale revision/u,
  );
  assert.deepEqual(effects, []);
});

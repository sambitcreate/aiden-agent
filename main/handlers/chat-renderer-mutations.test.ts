import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import {
  createChatApplicationService,
  type ChatApplicationDependencies,
} from "../services/chat-application-service.js";
import { createChatStore } from "../services/chat-store-core.js";
import { assertRenameAllowedFromChat } from "../services/chat-title-policy.js";
import type { ChatTurnLease } from "../services/chat-turn-admission.js";
import { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../services/workspace-operation-registry.js";
import { createRendererChatMutationHandlers } from "./chat-renderer-mutations.js";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const event = {} as IpcMainInvokeEvent;
const owner = {
  id: 1,
  documentId: "renderer:document-1",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
};

function lease(chatId: string, turnId: string, ownerId: string): ChatTurnLease {
  let active = true;
  return {
    chatId,
    ownerId,
    turnId,
    isActive: () => active,
    reserveAppendPayload: () => undefined,
    reserveSkillPreparation: () => undefined,
    prepareSkillInvocation: () => undefined,
    settleAsyncWork: () => undefined,
    onReleased: () => undefined,
    release: () => {
      active = false;
    },
  };
}

/** The four renderer channels, registered the way chats.ts registers them, over a real chat store. */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-renderer-chat-mutations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => root);
  await chatStore.create({ id: "design-chat", owner: { kind: "design-project", projectId: "project-1" } });
  await chatStore.create({ id: "regular-chat", title: "Regular" });
  const chatApplicationService = createChatApplicationService({
    chatStore,
    configStore: { getWorkspace: async () => null },
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
      availability: () => ({ available: true }),
      hasPending: async () => false,
      deleteChat: async () => undefined,
    },
    generativeUiArtifactStore: {
      availability: () => ({ available: true }),
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
    logError: () => undefined,
  } as unknown as ChatApplicationDependencies);
  const rendererChats = createRendererChatMutationHandlers({
    chatStore,
    chatApplicationService,
    chatTitleService: {
      // The title service applies the same rename policy before any model call.
      renameWithFoundationModels: async (chatId, options) => {
        const chat = await chatStore.get(chatId);
        if (!chat) throw new Error("This chat is no longer available.");
        assertRenameAllowedFromChat(chat, options);
        return chatStore.rename(chatId, "Titled by model");
      },
    },
    botApplicationService: { deleteChat: async () => assert.fail("no Bot chat is deleted here") },
    hostPlatformCapabilities: () => ({ bots: false }),
    memoryStore: { deleteScope: async () => assert.fail("no Bot memory is deleted here") },
    closeDeviceSessionsForChat: () => undefined,
    chatReadMarkers: { remove: async () => undefined },
    rendererDocumentOwner: () => owner,
    llmClient: {
      requiresAppendReconciliation: () => false,
      beginChatTurn: lease,
      markAppendReconciliationRequired: () => undefined,
      clearAppendReconciliationRequired: () => undefined,
    },
    unresolvedGuiArtifactMessage: async () => undefined,
    artifactRecoveryMessage: (message) => message,
    workspaceMutationGate: new WorkspaceMutationGate(),
    skillRegistry: { resolveFresh: async () => assert.fail("no skill is invoked here") },
  });
  const handlers = new Map<string, Handler>([
    ["chats:rename", rendererChats.rename as Handler],
    ["chats:renameWithFoundationModels", rendererChats.renameWithFoundationModels as Handler],
    ["chats:remove", rendererChats.remove as Handler],
    ["chats:appendMessage", rendererChats.appendMessage as Handler],
  ]);
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { chatStore, invoke };
}

const append = (chatId: string, turnId: string) =>
  [chatId, { role: "user", content: "Make it calmer" }, { providerId: "openrouter", model: "model-a", turnId }] as const;

test("renderer chat channels refuse a Design project's hidden chat and leave it unchanged", async (t) => {
  const f = await fixture(t);
  const before = await f.chatStore.get("design-chat");
  const attempts: Array<[string, readonly unknown[]]> = [
    ["chats:rename", ["design-chat", "Renamed"]],
    ["chats:renameWithFoundationModels", ["design-chat"]],
    ["chats:appendMessage", append("design-chat", "turn-1")],
    ["chats:remove", ["design-chat"]],
  ];
  for (const [channel, args] of attempts) {
    await assert.rejects(f.invoke(channel, ...args), /belongs to another Aiden feature/u, channel);
  }
  assert.deepEqual(await f.chatStore.get("design-chat"), before, "the hidden chat is exactly as it was");
});

test("the same channels still rename, append to and delete an ordinary chat", async (t) => {
  const f = await fixture(t);
  await f.invoke("chats:rename", "regular-chat", "Renamed");
  assert.equal((await f.chatStore.get("regular-chat"))?.title, "Renamed");
  await f.invoke("chats:renameWithFoundationModels", "regular-chat");
  assert.equal((await f.chatStore.get("regular-chat"))?.title, "Titled by model");
  await f.invoke("chats:appendMessage", ...append("regular-chat", "turn-2"));
  assert.deepEqual(
    (await f.chatStore.get("regular-chat"))?.messages.map((message) => [message.role, message.content]),
    [["user", "Make it calmer"]],
  );
  await f.invoke("chats:remove", "regular-chat");
  assert.equal(await f.chatStore.get("regular-chat"), null);
});

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

/** The renderer channels, registered the way chats.ts registers them, over a real chat store. */
async function fixture(t: TestContext, options: { busyChats?: ReadonlySet<string> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-renderer-chat-mutations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => root);
  await chatStore.create({ id: "design-chat", owner: { kind: "design-project", projectId: "project-1" } });
  await chatStore.create({ id: "regular-chat", title: "Regular" });
  const busyChats = options.busyChats ?? new Set<string>();
  const chatApplicationService = createChatApplicationService({
    chatStore,
    configStore: { getWorkspace: async () => null },
    llmClient: {
      isChatOwnedByInactiveRenderer: () => false,
      isChatBusy: (chatId: string) => busyChats.has(chatId),
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
    ["chats:setModel", rendererChats.setModel as Handler],
    ["chats:remove", rendererChats.remove as Handler],
    ["chats:appendMessage", rendererChats.appendMessage as Handler],
    ["chats:dismissComputerUseContinue", rendererChats.dismissComputerUseContinue as Handler],
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
    ["chats:setModel", ["design-chat", "openrouter", "model-b"]],
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

test("picking a model in one chat changes only that chat", async (t) => {
  const f = await fixture(t);
  await f.chatStore.create({ id: "other-chat", title: "Other" });
  await f.invoke("chats:appendMessage", ...append("regular-chat", "turn-a"));
  await f.invoke("chats:appendMessage", ...append("other-chat", "turn-b"));
  const before = await f.chatStore.get("regular-chat");
  const otherBefore = await f.chatStore.get("other-chat");

  const updated = (await f.invoke("chats:setModel", "regular-chat", "anthropic", "model-b")) as {
    providerId?: string;
    model?: string;
  };

  assert.deepEqual([updated.providerId, updated.model], ["anthropic", "model-b"]);
  const stored = await f.chatStore.get("regular-chat");
  assert.deepEqual([stored?.providerId, stored?.model], ["anthropic", "model-b"]);
  assert.equal(stored?.updatedAt, before?.updatedAt, "a model pick does not move the chat in the sidebar");
  assert.deepEqual(stored?.messages, before?.messages, "the history is untouched");
  assert.deepEqual(await f.chatStore.get("other-chat"), otherBefore, "the other chat keeps its own model");
  const listed = await f.chatStore.list();
  assert.deepEqual(
    listed.filter((meta) => meta.id !== "design-chat").map((meta) => [meta.id, meta.providerId, meta.model]).sort(),
    [
      ["other-chat", "openrouter", "model-a"],
      ["regular-chat", "anthropic", "model-b"],
    ],
  );
});

test("a chat's model cannot change mid-reply, for a Bot chat, or with an empty pick", async (t) => {
  const f = await fixture(t, { busyChats: new Set(["regular-chat"]) });
  await assert.rejects(
    f.invoke("chats:setModel", "regular-chat", "anthropic", "model-b"),
    /current response/u,
  );
  await f.chatStore.create({ id: "bot-chat", botId: "bot-1", providerId: "openrouter", model: "model-a" });
  await assert.rejects(f.invoke("chats:setModel", "bot-chat", "anthropic", "model-b"), /Bot's settings/u);
  assert.deepEqual(
    [(await f.chatStore.get("bot-chat"))?.providerId, (await f.chatStore.get("bot-chat"))?.model],
    ["openrouter", "model-a"],
  );
  await f.chatStore.create({ id: "idle-chat" });
  await assert.rejects(f.invoke("chats:setModel", "idle-chat", "anthropic", "   "), /Invalid model/u);
  await assert.rejects(f.invoke("chats:setModel", "idle-chat", "", "model-b"), /non-empty string/u);
  await assert.rejects(f.invoke("chats:setModel", "missing-chat", "anthropic", "model-b"), /not found/u);
});

test("dismissing the Computer Use continue callout clears only that chat's marker", async (t) => {
  const f = await fixture(t);
  await f.chatStore.setComputerUsePendingContinue("regular-chat", true);
  await f.chatStore.setComputerUseAllowed("regular-chat", true);

  const updated = (await f.invoke("chats:dismissComputerUseContinue", "regular-chat")) as {
    id: string;
    computerUsePendingContinue?: boolean;
    computerUseAllowed?: boolean;
  };
  assert.equal(updated.id, "regular-chat");
  assert.equal(updated.computerUsePendingContinue, undefined);
  const stored = await f.chatStore.get("regular-chat");
  assert.equal(stored?.computerUsePendingContinue, undefined);
  assert.equal(stored?.computerUseAllowed, true, "dismissing does not revoke the chat's grant");

  await assert.rejects(f.invoke("chats:dismissComputerUseContinue", ""), /non-empty string/u);
  await assert.rejects(f.invoke("chats:dismissComputerUseContinue", "missing-chat"), /not found/u);
});

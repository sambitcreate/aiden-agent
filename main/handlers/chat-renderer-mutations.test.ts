import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { captureAnalyticsEvents } from "../services/analytics/test-support.js";
import {
  createChatApplicationService,
  type ChatApplicationDependencies,
} from "../services/chat-application-service.js";
import { ChatReadMarkerStore } from "../services/chat-read-markers.js";
import { createChatStore } from "../services/chat-store-core.js";
import { ChatTriageStore } from "../services/chat-triage.js";
import { assertRenameAllowedFromChat } from "../services/chat-title-policy.js";
import type { ChatTurnLease } from "../services/chat-turn-admission.js";
import { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../services/workspace-operation-registry.js";
import { createRendererChatMutationHandlers, type ChatDesignModeChange } from "./chat-renderer-mutations.js";
import type { Workspace } from "../services/types.js";

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
async function fixture(
  t: TestContext,
  options: {
    busyChats?: ReadonlySet<string>;
    workspaces?: Record<string, Partial<Workspace>>;
    designModeEnabled?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-renderer-chat-mutations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => root);
  // The real Inbox stores, as main wires them. Their writes after a send or a
  // delete are fire-and-forget, so each is tracked for a test to await.
  const inboxWrites: Promise<unknown>[] = [];
  const track = <T>(write: Promise<T>): Promise<T> => {
    inboxWrites.push(write);
    return write;
  };
  let triageWrites = 0;
  const triage = new ChatTriageStore(() => root, { onChange: () => { triageWrites += 1; } });
  const readMarkers = new ChatReadMarkerStore(() => root);
  await chatStore.create({ id: "design-chat", owner: { kind: "design-project", projectId: "project-1" } });
  await chatStore.create({ id: "regular-chat", title: "Regular" });
  const busyChats = options.busyChats ?? new Set<string>();
  const broadcasts: ChatDesignModeChange[] = [];
  const chatApplicationService = createChatApplicationService({
    chatStore,
    configStore: {
      getWorkspace: async (workspaceId: string) => {
        const workspace = options.workspaces?.[workspaceId];
        return workspace
          ? ({ id: workspaceId, name: workspaceId, permission: "ask", createdAt: 1, updatedAt: 1, ...workspace } as Workspace)
          : null;
      },
    },
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
    inboxState: {
      readMarkers: { remove: (chatId: string) => track(readMarkers.remove(chatId)) },
      triage: { remove: (chatId: string) => track(triage.remove(chatId)) },
    },
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
    chatTriage: { wake: (chatId) => track(triage.wake(chatId)) },
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
    designModeEnabled: () => options.designModeEnabled ?? true,
    broadcastDesignModeChanged: (change) => broadcasts.push(change),
  });
  const handlers = new Map<string, Handler>([
    ["chats:rename", rendererChats.rename as Handler],
    ["chats:renameWithFoundationModels", rendererChats.renameWithFoundationModels as Handler],
    ["chats:setModel", rendererChats.setModel as Handler],
    ["chats:setDesignMode", rendererChats.setDesignMode as Handler],
    ["chats:remove", rendererChats.remove as Handler],
    ["chats:appendMessage", rendererChats.appendMessage as Handler],
    ["chats:dismissComputerUseContinue", rendererChats.dismissComputerUseContinue as Handler],
  ]);
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return {
    chatStore,
    invoke,
    broadcasts,
    triage,
    readMarkers,
    triageWrites: () => triageWrites,
    inboxSettled: () => Promise.all(inboxWrites),
  };
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

test("sending in a snoozed chat brings it back once and leaves Pin alone; an unsnoozed chat is not written", async (t) => {
  const f = await fixture(t);
  await f.chatStore.create({ id: "other-chat", title: "Other" });
  await f.triage.set("regular-chat", { pinned: true, snoozeUntil: Date.now() + 3_600_000 });
  await f.triage.set("other-chat", { pinned: true });
  const before = f.triageWrites();

  await f.invoke("chats:appendMessage", ...append("regular-chat", "turn-snoozed"));
  await f.inboxSettled();
  const woken = await f.triage.get("regular-chat");
  assert.equal(woken?.snoozedUntil, undefined);
  assert.equal(typeof woken?.pinnedAt, "number");
  assert.equal(woken?.revision, 2);
  assert.equal(f.triageWrites(), before + 1);

  await f.invoke("chats:appendMessage", ...append("other-chat", "turn-plain"));
  await f.invoke("chats:appendMessage", ...append("regular-chat", "turn-again"));
  await f.inboxSettled();
  assert.equal(f.triageWrites(), before + 1, "no snooze, no write");
  assert.equal((await f.triage.get("other-chat"))?.revision, 1);
  assert.equal((await f.triage.get("regular-chat"))?.revision, 2);
});

test("deleting a chat drops its read marker and triage and keeps other chats'", async (t) => {
  const f = await fixture(t);
  await f.chatStore.create({ id: "other-chat", title: "Other" });
  for (const chatId of ["regular-chat", "other-chat"]) {
    await f.triage.set(chatId, { pinned: true });
    assert.equal(await f.readMarkers.markRead(chatId, 5_000, 0), true);
  }

  await f.invoke("chats:remove", "regular-chat");
  await f.inboxSettled();
  assert.equal(await f.triage.get("regular-chat"), null);
  const markers = await f.readMarkers.snapshot();
  assert.equal("regular-chat" in markers.readThrough, false);
  assert.equal(markers.readThrough["other-chat"], 5_000);
  assert.equal(typeof (await f.triage.get("other-chat"))?.pinnedAt, "number");

  // A refused delete (a Design project's hidden chat) leaves its Inbox state.
  await f.triage.set("design-chat", { done: true });
  await assert.rejects(f.invoke("chats:remove", "design-chat"));
  await f.inboxSettled();
  assert.equal(typeof (await f.triage.get("design-chat"))?.doneAt, "number");
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

const projectWorkspaces = {
  default: { folderPath: "/tmp/aiden-chats/default", noWorkspace: true as const },
  site: { folderPath: "/Users/person/site" },
  empty: {},
};

test("design mode turns on for a project chat, tells every window, and turns off again", async (t) => {
  const events = captureAnalyticsEvents(t);
  const f = await fixture(t, { workspaces: projectWorkspaces });
  await f.chatStore.create({ id: "site-chat", title: "Landing hero", workspaceId: "site" });
  const before = await f.chatStore.get("site-chat");

  const on = (await f.invoke("chats:setDesignMode", "site-chat", true, "shortcut")) as { id: string; designMode?: true };
  assert.deepEqual([on.id, on.designMode], ["site-chat", true]);
  const stored = await f.chatStore.get("site-chat");
  assert.equal(stored?.designMode, true);
  assert.equal(stored?.updatedAt, before?.updatedAt, "design mode does not move the chat in the sidebar");
  assert.deepEqual(f.broadcasts, [{ chatId: "site-chat", designMode: true }]);

  const off = (await f.invoke("chats:setDesignMode", "site-chat", false)) as { designMode?: true };
  assert.equal(off.designMode, undefined);
  assert.equal((await f.chatStore.get("site-chat"))?.designMode, undefined);
  assert.equal(f.broadcasts[f.broadcasts.length - 1]?.designMode, false);

  // A No workspace chat lives in Aiden's own folder, so it is a project chat too.
  await f.invoke("chats:setDesignMode", "regular-chat", true, "/etc/passwd");
  assert.equal((await f.chatStore.get("regular-chat"))?.designMode, true);
  // Asking again for the state a chat already has changes nothing and counts nothing.
  await f.invoke("chats:setDesignMode", "regular-chat", true, "slash");
  assert.deepEqual(events, [
    { event: "design_mode_entered", props: { source: "shortcut" } },
    { event: "design_mode_exited", props: {} },
    { event: "design_mode_entered", props: { source: "toggle" } },
  ], "an unknown source counts as the toggle");
});

test("design mode is refused outside project chats and leaves them unchanged", async (t) => {
  const f = await fixture(t, { workspaces: projectWorkspaces });
  await f.chatStore.create({ id: "folderless-chat", workspaceId: "empty" });
  await f.chatStore.create({ id: "orphan-chat", workspaceId: "deleted-workspace" });
  await f.chatStore.create({ id: "bot-chat", botId: "bot-1" });
  await f.chatStore.create({ id: "assistant-chat", workspaceId: "assistant" });
  for (const chatId of ["folderless-chat", "orphan-chat", "bot-chat", "assistant-chat"]) {
    await assert.rejects(f.invoke("chats:setDesignMode", chatId, true), /project chats only/u, chatId);
    assert.equal((await f.chatStore.get(chatId))?.designMode, undefined, chatId);
  }
  await assert.rejects(f.invoke("chats:setDesignMode", "design-chat", true), /belongs to another Aiden feature/u);
  assert.deepEqual(f.broadcasts, [], "a refusal tells no window");
});

test("the design mode channel checks its arguments and does nothing while the flag is off", async (t) => {
  const f = await fixture(t, { workspaces: projectWorkspaces });
  await assert.rejects(f.invoke("chats:setDesignMode", "regular-chat", "true"), /boolean/u);
  await assert.rejects(f.invoke("chats:setDesignMode", "regular-chat"), /boolean/u);
  await assert.rejects(f.invoke("chats:setDesignMode", "", true), /non-empty string/u);
  await assert.rejects(f.invoke("chats:setDesignMode", "missing-chat", true), /not found/u);

  const off = await fixture(t, { workspaces: projectWorkspaces, designModeEnabled: false });
  await assert.rejects(off.invoke("chats:setDesignMode", "regular-chat", true), /not available/u);
  assert.equal((await off.chatStore.get("regular-chat"))?.designMode, undefined);
  assert.deepEqual(off.broadcasts, []);
});

test("a rename and a design mode change racing on one chat both land", async (t) => {
  const f = await fixture(t, { workspaces: projectWorkspaces });
  await Promise.all([
    f.invoke("chats:rename", "regular-chat", "Pricing page"),
    f.invoke("chats:setDesignMode", "regular-chat", true),
  ]);
  const stored = await f.chatStore.get("regular-chat");
  assert.deepEqual([stored?.title, stored?.designMode], ["Pricing page", true]);
  assert.deepEqual(f.broadcasts, [{ chatId: "regular-chat", designMode: true }], "the change carries no title to undo the rename");
});

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { parseChatAppend } from "./chat-append-params.js";
import {
  createRendererChatMutationHandlers,
  type RendererChatMutationDeps,
} from "./chat-renderer-mutations.js";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import {
  appendReconciliationFailureMessage,
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";
import {
  createChatApplicationService,
  type ChatApplicationDependencies,
} from "../services/chat-application-service.js";
import {
  ChatCreateReconciliationRequiredError,
  createChatStore,
} from "../services/chat-store-core.js";
import { ChatTurnAdmission } from "../services/chat-turn-admission.js";
import { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../services/workspace-operation-registry.js";

// Private Pi protocol stored on an assistant message. It must stay on disk and
// never appear in anything the renderer channels return.
const PRIVATE_RESPONSE_ID = "PRIVATE_PI_RESPONSE_SENTINEL_7f3c";
const PRIVATE_THINKING = "PRIVATE_PI_THINKING_SENTINEL_19ad";

const event = {} as IpcMainInvokeEvent;

type ChatStore = ReturnType<typeof createChatStore>;

function rendererOwner(documentId = "renderer:document-1") {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    id: 1,
    documentId,
    isDestroyed: () => destroyed,
    send: () => undefined,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * The renderer chat channels over a real chat store and the real turn
 * admission, so reservations, releases and reconciliation fences are the
 * production ones. `wrapStore` lets a test inject a storage failure.
 */
async function fixture(
  t: TestContext,
  options: {
    admission?: ChatTurnAdmission;
    wrapStore?: (store: ChatStore) => RendererChatMutationDeps["chatStore"];
    unresolvedGuiArtifactMessage?: (chatId: string) => Promise<string | undefined>;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-append-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatStore = createChatStore(async () => root);
  await chatStore.create({ id: "chat-1", title: "Chat" });
  await chatStore.create({ id: "chat-2", title: "Other chat" });
  await chatStore.appendMessage("chat-1", {
    role: "assistant",
    content: "Earlier answer",
    pi: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: PRIVATE_THINKING },
        { type: "text", text: "Earlier answer" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      responseId: PRIVATE_RESPONSE_ID,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 10,
    },
  });
  const admission = options.admission ?? new ChatTurnAdmission();
  t.after(() => admission.releaseAll());
  const owner = rendererOwner();
  const llmClient = {
    requiresAppendReconciliation: (ownerId: string) => admission.requiresAppendReconciliation(ownerId),
    beginChatTurn: (chatId: string, turnId: string, ownerId: string) =>
      admission.tryBegin(chatId, turnId, ownerId, false),
    markAppendReconciliationRequired: (ownerId: string) => admission.markAppendReconciliationRequired(ownerId),
    clearAppendReconciliationRequired: (ownerId: string) => admission.clearAppendReconciliationRequired(ownerId),
  };
  const chatApplicationService = createChatApplicationService({
    chatStore,
    configStore: { getWorkspace: async () => null },
    llmClient: {
      ...llmClient,
      isChatOwnedByInactiveRenderer: () => false,
      isChatBusy: () => false,
      waitForChatIdle: async () => true,
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
  const handlers = createRendererChatMutationHandlers({
    chatStore: options.wrapStore ? options.wrapStore(chatStore) : chatStore,
    chatApplicationService,
    chatTitleService: { renameWithFoundationModels: async () => assert.fail("no title is generated here") },
    botApplicationService: { deleteChat: async () => assert.fail("no Bot chat is deleted here") },
    hostPlatformCapabilities: () => ({ bots: false }),
    closeDeviceSessionsForChat: () => undefined,
    chatReadMarkers: { remove: async () => undefined },
    rendererDocumentOwner: () => owner,
    llmClient,
    unresolvedGuiArtifactMessage: options.unresolvedGuiArtifactMessage ?? (async () => undefined),
    artifactRecoveryMessage: (message) => message,
    workspaceMutationGate: new WorkspaceMutationGate(),
    skillRegistry: { resolveFresh: async () => assert.fail("no skill is invoked here") },
  });
  return { chatStore, chatApplicationService, handlers, admission, owner };
}

const userMessage = (content = "hello") => ({ role: "user", content });
const meta = (turnId: string) => ({ providerId: "openrouter", model: "model-a", turnId });
const blocked = appendReconciliationFailureMessage("blocked");

test("renderer channels return the visible chat and never private Pi protocol", async (t) => {
  const f = await fixture(t);
  const stored = JSON.stringify(await f.chatStore.get("chat-1"));
  assert.ok(stored.includes(PRIVATE_RESPONSE_ID), "the private protocol is persisted");

  const appended = await f.handlers.appendMessage(event, "chat-1", userMessage("Next question"), meta("turn-1"));
  assert.deepEqual(
    appended?.messages.map((message) => [message.role, message.content]),
    [
      ["assistant", "Earlier answer"],
      ["user", "Next question"],
    ],
  );
  assert.equal(appended?.messages[0]?.pi, undefined);
  const read = await f.chatApplicationService.get("chat-1");
  const assistant = await f.handlers.createAssistant(event, { providerId: "openrouter", model: "model-a" });
  assert.equal(assistant?.workspaceId, ASSISTANT_WORKSPACE_ID);
  // Visible-history copies (chats:copyVisibleHistory) start from a payload
  // that never carries the source's private protocol.
  const copied = await f.chatStore.copyVisibleHistory({ sourceChatId: "chat-1" });
  for (const visible of [appended, read, assistant, copied]) {
    const serialized = JSON.stringify(visible);
    assert.ok(!serialized.includes(PRIVATE_RESPONSE_ID), "private response id leaked to the renderer");
    assert.ok(!serialized.includes(PRIVATE_THINKING), "private thinking leaked to the renderer");
  }
  assert.ok(JSON.stringify(await f.chatStore.get("chat-1")).includes(PRIVATE_RESPONSE_ID), "projection does not delete it");
});

test("renderer appends cannot author private or main-owned message fields", async (t) => {
  const f = await fixture(t);
  const before = await f.chatStore.get("chat-1");
  for (const forged of [
    { ...userMessage(), pi: { responseId: "forged" } },
    { ...userMessage(), timeline: [] },
    { ...userMessage(), reasoning: "forged" },
    { role: "assistant", content: "forged" },
  ]) {
    assert.throws(() => f.handlers.appendMessage(event, "chat-1", forged, meta("turn-forged")));
  }
  assert.deepEqual(await f.chatStore.get("chat-1"), before);
  assert.equal(f.admission.isAdmitted("chat-1"), false, "a rejected envelope never takes a turn");
});

test("an owner that needs append reconciliation is fenced from create and append", async (t) => {
  const f = await fixture(t);
  f.admission.markAppendReconciliationRequired(f.owner.documentId);
  const before = await f.chatStore.list();

  assert.throws(() => f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-1")), { message: blocked });
  await assert.rejects(f.handlers.createAssistant(event, {}), { message: blocked });
  await assert.rejects(
    f.chatApplicationService.create({ workspaceId: "workspace-1", title: "New" }, f.owner),
    { message: blocked },
  );
  assert.deepEqual(await f.chatStore.list(), before, "nothing was created or appended");
  assert.equal((await f.chatStore.get("chat-2"))?.messages.length, 0);
});

test("an append whose durability is indeterminate fences the document until it is replaced", async (t) => {
  const f = await fixture(t, {
    wrapStore: (store) => ({
      ...store,
      get: async () => {
        throw new Error("disk unavailable");
      },
      appendMessage: async () => {
        throw new Error("directory sync failed");
      },
      create: store.create,
      setComputerUsePendingContinue: store.setComputerUsePendingContinue,
    }),
  });

  await assert.rejects(
    f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-1")),
    { message: appendReconciliationFailureMessage("current") },
  );
  assert.equal(f.admission.requiresAppendReconciliation(f.owner.documentId), true);
  assert.equal(f.admission.isAdmitted("chat-2"), false, "the failed turn released its lease");
  assert.throws(() => f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-2")), { message: blocked });
  await assert.rejects(f.handlers.createAssistant(event, {}), { message: blocked });

  f.owner.invalidate();
  assert.equal(f.admission.requiresAppendReconciliation(f.owner.documentId), false, "a reload clears the fence");
});

test("an Assistant chat whose creation is indeterminate fences the document", async (t) => {
  const f = await fixture(t, {
    wrapStore: (store) => ({
      ...store,
      create: async () => {
        throw new ChatCreateReconciliationRequiredError("assistant-chat");
      },
      get: store.get,
      appendMessage: store.appendMessage,
      setComputerUsePendingContinue: store.setComputerUsePendingContinue,
    }),
  });

  await assert.rejects(f.handlers.createAssistant(event, {}), { message: blocked });
  assert.equal(f.admission.requiresAppendReconciliation(f.owner.documentId), true);
  assert.throws(() => f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-1")), { message: blocked });
  f.owner.invalidate();
  assert.equal(f.admission.requiresAppendReconciliation(f.owner.documentId), false);
});

test("an Assistant chat is not installed for a renderer document that is gone", async (t) => {
  const f = await fixture(t);
  const before = await f.chatStore.list();
  f.owner.invalidate();
  await assert.rejects(f.handlers.createAssistant(event, {}), /no longer active/u);
  assert.deepEqual(await f.chatStore.list(), before);
});

test("append payload capacity is reserved synchronously, before any persistence await", async (t) => {
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const f = await fixture(t, {
    admission: new ChatTurnAdmission({ maxAppendTurns: 1 }),
    // Holds the first append inside its first await.
    unresolvedGuiArtifactMessage: async () => {
      await gate;
      return undefined;
    },
  });

  const first = f.handlers.appendMessage(event, "chat-1", userMessage("first"), meta("turn-1"));
  assert.throws(
    () => f.handlers.appendMessage(event, "chat-2", userMessage("second"), meta("turn-2")),
    /Too many messages are waiting to be saved/u,
  );
  assert.equal(f.admission.isAdmitted("chat-2"), false, "the refused turn released its lease");
  openGate();
  await first;
  assert.equal((await f.chatStore.get("chat-2"))?.messages.length, 0);
  // The saved turn stays leased for the generation handoff.
  assert.equal(f.admission.isAdmitted("chat-1"), true);
});

test("an append larger than the remaining payload budget is refused without touching the store", async (t) => {
  const f = await fixture(t, { admission: new ChatTurnAdmission({ maxAppendBytes: 64 }) });
  assert.throws(
    () => f.handlers.appendMessage(event, "chat-2", userMessage("x".repeat(256)), meta("turn-1")),
    /Too many messages are waiting to be saved/u,
  );
  assert.equal(f.admission.isAdmitted("chat-2"), false);
  assert.equal((await f.chatStore.get("chat-2"))?.messages.length, 0);
});

test("the persisted message is the envelope parsed at call time, not the live IPC object", async (t) => {
  const f = await fixture(t);
  const message = userMessage("original");
  const metadata = meta("turn-1");
  const pending = f.handlers.appendMessage(event, "chat-2", message, metadata);
  message.content = "mutated after the call";
  message.role = "assistant";
  metadata.model = "mutated-model";
  const chat = await pending;
  const saved = chat?.messages[chat.messages.length - 1];
  assert.deepEqual([saved?.role, saved?.content], ["user", "original"]);
  assert.equal((await f.chatStore.get("chat-2"))?.model, "model-a");
});

test("a failed append releases its turn; a second concurrent turn on the chat is refused", async (t) => {
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const f = await fixture(t, {
    unresolvedGuiArtifactMessage: async () => {
      await gate;
      return "A previous visual artifact is still pending.";
    },
  });
  const failing = f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-1"));
  assert.throws(
    () => f.handlers.appendMessage(event, "chat-2", userMessage(), meta("turn-2")),
    /Wait for the previous response/u,
  );
  openGate();
  await assert.rejects(failing, /previous visual artifact/u);
  assert.equal(f.admission.isAdmitted("chat-2"), false);
});

const validMessage = { role: "user", content: "hello" };
const validMeta = { turnId: "turn-1" };

test("renderer append parser projects an exact bounded envelope", () => {
  assert.deepEqual(parseChatAppend("chat-1", validMessage, validMeta), {
    chatId: "chat-1",
    role: "user",
    content: "hello",
    messageModel: undefined,
    attachments: undefined,
    providerId: undefined,
    metaModel: undefined,
    autoTitle: false,
    turnId: "turn-1",
    skillReference: undefined,
    retainedBytes: 273,
  });

  assert.throws(
    () =>
      parseChatAppend("chat-1", { ...validMessage, forged: "x" }, validMeta),
    /Invalid chat message field/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        tools: ["write"],
      }),
    /Invalid chat message metadata field/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { role: "assistant", content: "forged" },
        validMeta,
      ),
    /only user messages/u,
  );
});

test("renderer append parser bounds every retained selector", () => {
  assert.throws(
    () =>
      parseChatAppend(
        "c".repeat(MAX_CHAT_ID_CHARS + 1),
        validMessage,
        validMeta,
      ),
    /Invalid chat id/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, model: "m".repeat(MAX_MODEL_ID_CHARS + 1) },
        validMeta,
      ),
    /Invalid message model/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        providerId: "p".repeat(MAX_PROVIDER_ID_CHARS + 1),
      }),
    /Invalid provider id/u,
  );
});

test("unknown append fields never echo attacker-controlled property names", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, [hugeKey]: true },
        validMeta,
      ),
    (error: unknown) => error instanceof Error && error.message.length < 100,
  );
});

test("append envelopes with many extra properties are rejected with a fixed message", () => {
  const manyFields: Record<string, unknown> = {
    role: "user",
    content: "hello",
  };
  for (let index = 0; index < 10_000; index += 1)
    manyFields[`extra-${index}`] = index;
  assert.throws(
    () => parseChatAppend("chat-1", manyFields, { turnId: "turn-1" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat message fields.",
  );
});

test("append admission charges encoded image representation and metadata", () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const size = Buffer.byteLength(data, "base64");
  const parsed = parseChatAppend(
    "chat-1",
    {
      role: "user",
      content: "",
      attachments: [
        {
          id: "a",
          name: "a.png",
          mimeType: "image/png",
          kind: "image",
          size,
          data,
        },
      ],
    },
    { turnId: "turn-1", providerId: "provider", model: "model" },
  );
  assert.ok(
    parsed.retainedBytes >=
      data.length + Buffer.byteLength("providermodel", "utf8"),
  );
});

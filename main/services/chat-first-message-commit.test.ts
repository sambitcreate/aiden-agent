import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { captureAnalyticsEvents } from "./analytics/test-support.js";
import { parseChatFirstMessage } from "../handlers/chat-first-message-params.js";
import { createChatStore, type ChatStoreDurability } from "./chat-store-core.js";
import { createFirstMessageCommitter } from "./chat-first-message-commit.js";
import { ChatTurnAdmission, type ChatTurnAdmissionOptions } from "./chat-turn-admission.js";
import { WorkspaceOperationRegistry, admitOwnedWorkspaceOperation } from "./workspace-operation-registry.js";
import { isAppendReconciliationRequiredError } from "./chat-append-commit.js";
import { chatForRenderer } from "./visible-chat-projection.js";
import { SkillRegistry } from "./skill-registry.js";
import type { RegisteredSkill } from "./skill-registry.js";

let nextTurn = 0;
function request(overrides: Record<string, unknown> = {}) {
  return {
    draftId: randomUUID(), workspaceId: "workspace", providerId: "openai", model: "test-model",
    turnId: `turn-${++nextTurn}`, message: { role: "user", content: "Investigate the failing build" },
    ...overrides,
  };
}

function documentOwner() {
  let destroyed = false;
  const listeners = new Set<() => void>();
  return {
    documentId: randomUUID(),
    isDestroyed: () => destroyed,
    onInvalidated: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate: () => {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function fixture(t: test.TestContext, durability: ChatStoreDurability = {}, admission: ChatTurnAdmissionOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-first-message-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory, undefined, durability);
  const owner = documentOwner();
  t.after(() => owner.invalidate());
  const turns = new ChatTurnAdmission(admission);
  const workspaces = new WorkspaceOperationRegistry();
  const deps: Parameters<typeof createFirstMessageCommitter>[0] = {
    store,
    beginTurn: (chatId, turnId, ownerId) => turns.tryBegin(chatId, turnId, ownerId, false),
    requiresReconciliation: (ownerId) => turns.requiresAppendReconciliation(ownerId),
    markReconciliation: (ownerId) => turns.markAppendReconciliationRequired(ownerId),
    clearReconciliation: (ownerId) => turns.clearAppendReconciliationRequired(ownerId),
    admitWorkspace: (workspaceId, document) => admitOwnedWorkspaceOperation(workspaces, document, workspaceId),
    getWorkspace: async () => ({}),
    resolveSkill: async () => { throw new Error("Skill is unavailable"); },
  };
  return { directory, store, owner, turns, workspaces, deps };
}

test("first-message parser rejects empty, forged, and oversized requests", () => {
  for (const value of [
    request({ draftId: "../chat" }),
    request({ message: { role: "assistant", content: "forged" } }),
    request({ message: { role: "user", content: "  " } }),
    request({ message: { role: "user", content: "x".repeat(1_048_577) } }),
    // The composer no longer opts a chat into Computer Use; the field is gone.
    request({ computerUseEnabled: true }),
    request({ botId: "bot" }),
    request({ workspaceId: "" }),
  ]) assert.throws(() => parseChatFirstMessage(value));
  const original = request();
  const parsed = parseChatFirstMessage(original);
  original.message.content = "changed after admission";
  assert.equal(parsed.content, "Investigate the failing build");
});

test("first message publishes a nonempty chat, title, settings, and private durable receipt", async (t) => {
  const f = await fixture(t);
  const parsed = parseChatFirstMessage(request());
  assert.deepEqual(await f.store.list(), []);
  const chat = await createFirstMessageCommitter(f.deps)(parsed, f.owner);
  assert.equal(chat.id, parsed.chatId);
  assert.equal(chat.title, parsed.content);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0]?.role, "user");
  assert.equal(chat.computerUseAllowed, undefined, "a new chat starts without a Computer Use grant");
  assert.equal((await f.store.list())[0]?.id, chat.id);
  assert.equal(f.turns.owns(chat.id, parsed.turnId, f.owner.documentId), true);
  assert.equal(chatForRenderer(chat)?.firstMessageCommit, undefined);
  const restart = createChatStore(async () => f.directory);
  assert.deepEqual((await restart.get(chat.id))?.firstMessageCommit, chat.firstMessageCommit);
});

test("attachment-only first send retains attachments and an explicit draft title", async (t) => {
  const f = await fixture(t);
  const attachment = { id: "text-1", name: "notes.txt", kind: "text", mimeType: "text/plain", size: 5, text: "notes" };
  const parsed = parseChatFirstMessage(request({
    title: "My investigation",
    message: { role: "user", content: "", attachments: [attachment] },
  }));
  const chat = await createFirstMessageCommitter(f.deps)(parsed, f.owner);
  assert.equal(chat.title, "My investigation");
  assert.deepEqual(chat.messages[0]?.attachments, [attachment]);
});

test("first send prepares skill instructions for the exact durable user message", async (t) => {
  const f = await fixture(t);
  const skill: RegisteredSkill = {
    stableId: "configured:review", invocationId: `sk1_${"a".repeat(43)}`,
    toolKey: "skill_review", name: "Review", description: "Review changes",
    instructions: "Inspect the diff carefully.", source: "configured", enabled: true, available: true,
  };
  const parsed = parseChatFirstMessage(request({
    skillInvocation: { version: 1, invocationId: skill.invocationId, displayName: "Review", source: "configured" },
  }));
  const chat = await createFirstMessageCommitter({ ...f.deps, resolveSkill: async () => skill })(parsed, f.owner);
  assert.deepEqual(chat.messages[0]?.skill, { version: 1, name: "Review", source: "configured" });
  let preparedId: string | undefined;
  assert.equal(f.turns.handoff(chat.id, parsed.turnId, f.owner.documentId, (prepared) => { preparedId = prepared?.userMessageId; }), true);
  assert.equal(preparedId, chat.messages[0]?.id);
});

test("duplicate first sends share one operation and mismatched identities cannot overwrite", async (t) => {
  const f = await fixture(t);
  const commit = createFirstMessageCommitter(f.deps);
  const input = request();
  const parsed = parseChatFirstMessage(input);
  const first = commit(parsed, f.owner);
  assert.equal(commit(parseChatFirstMessage(input), f.owner), first);
  assert.throws(() => commit(parseChatFirstMessage({ ...input, message: { role: "user", content: "different" } }), f.owner));
  const chat = await first;
  f.turns.releaseMatching(chat.id, parsed.turnId, f.owner.documentId);
  const replay = await commit(parsed, f.owner);
  assert.equal(replay.messages.length, 1);
  assert.equal(replay.messages[0]?.id, chat.messages[0]?.id);
  assert.equal(f.turns.owns(chat.id, parsed.turnId, f.owner.documentId), false, "replay must not authorize another generation");
  await assert.rejects(commit(parseChatFirstMessage({ ...input, turnId: "turn-reused" }), f.owner), /already been used/u);
  assert.equal((await f.store.get(chat.id))?.messages.length, 1);
});

test("a regular or Bot chat identity cannot be claimed by a first-message retry", async (t) => {
  const f = await fixture(t);
  const input = request();
  await f.store.create({ id: input.draftId, botId: "bot", workspaceId: "managed" });
  await assert.rejects(createFirstMessageCommitter(f.deps)(parseChatFirstMessage(input), f.owner), /already been used/u);
  assert.equal((await f.store.get(input.draftId))?.botId, "bot");
  assert.equal((await f.store.get(input.draftId))?.messages.length, 0);
});

test("completed first-send receipts retain quota until handoff or abandonment", async (t) => {
  const f = await fixture(t, {}, { maxAppendTurns: 1 });
  const commit = createFirstMessageCommitter(f.deps);
  const first = parseChatFirstMessage(request());
  const next = parseChatFirstMessage(request());
  const receipt = await commit(first, f.owner);
  assert.equal(await commit(first, f.owner), receipt, "same-lease retry reuses the bounded receipt");
  assert.throws(() => commit(next, f.owner), /Too many messages/u);
  assert.equal(f.turns.owns(next.chatId, next.turnId, f.owner.documentId), false);
  assert.equal(f.turns.handoff(first.chatId, first.turnId, f.owner.documentId, () => {}), true);
  const secondReceipt = await commit(next, f.owner);
  assert.equal(secondReceipt.messages.length, 1);
  const third = parseChatFirstMessage(request());
  assert.throws(() => commit(third, f.owner), /Too many messages/u);
  f.turns.releaseMatching(next.chatId, next.turnId, f.owner.documentId);
  assert.equal((await commit(third, f.owner)).messages.length, 1);
});

test("corrupt and mismatched UUID payload collisions are preserved byte-for-byte", async (t) => {
  const f = await fixture(t);
  const commit = createFirstMessageCommitter(f.deps);
  const preserved = async (chatId: string): Promise<string> => {
    // A torn payload is set aside under a hidden sibling by the first read;
    // a parseable mismatched payload stays where it is.
    const names = (await fs.readdir(f.directory)).filter((name) =>
      name === `${chatId}.json` || (name.startsWith(`.${chatId}.json.`) && name.endsWith(".corrupt")));
    assert.equal(names.length, 1);
    return fs.readFile(path.join(f.directory, names[0]!), "utf8");
  };
  for (const contents of ["{interrupted payload", JSON.stringify({ id: "another-id", title: "Keep me", messages: [], createdAt: 1, updatedAt: 1 })]) {
    const input = parseChatFirstMessage(request());
    await fs.writeFile(path.join(f.directory, `${input.chatId}.json`), contents, "utf8");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(commit(input, f.owner), /unreadable existing chat/u);
      assert.equal(await preserved(input.chatId), contents);
      assert.equal(f.turns.owns(input.chatId, input.turnId, f.owner.documentId), false);
    }
  }
  assert.deepEqual(await f.store.list(), []);
});

test("missing workspace and skill rejection leave no chat or lease", async (t) => {
  const f = await fixture(t);
  for (const kind of ["workspace", "skill"] as const) {
    const parsed = parseChatFirstMessage(request());
    if (kind === "skill") parsed.skillReference = { version: 1, invocationId: "configured:test", displayName: "test", source: "configured" };
    const commit = createFirstMessageCommitter({
      ...f.deps,
      getWorkspace: async () => (kind === "workspace" ? undefined : {}),
    });
    await assert.rejects(commit(parsed, f.owner));
    assert.equal(f.turns.owns(parsed.chatId, parsed.turnId, f.owner.documentId), false);
  }
  assert.deepEqual(await f.store.list(), []);
});

test("owner invalidation before installation aborts without an empty chat", async (t) => {
  const f = await fixture(t);
  const commit = createFirstMessageCommitter({ ...f.deps, getWorkspace: async () => { f.owner.invalidate(); return {}; } });
  await assert.rejects(commit(parseChatFirstMessage(request()), f.owner), /changed/u);
  assert.deepEqual(await f.store.list(), []);
});

test("workspace cancellation drains first-message preparation before releasing its operation", async (t) => {
  const f = await fixture(t);
  let completeValidation = () => {};
  let validationStarted = () => {};
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  const waiting = new Promise<void>((resolve) => { completeValidation = resolve; });
  const commit = createFirstMessageCommitter({ ...f.deps, getWorkspace: async () => { validationStarted(); await waiting; return {}; } });
  const writing = commit(parseChatFirstMessage(request()), f.owner);
  await started;
  let drained = false;
  const drain = f.workspaces.cancelAndSettle("workspace").then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  completeValidation();
  await assert.rejects(writing, /changed/u);
  await drain;
  assert.equal(drained, true);
  assert.deepEqual(await f.store.list(), []);
});

test("an owner lost during the durable write keeps ownership until that write settles", async (t) => {
  let reachedWrite = () => {};
  let finishWrite = () => {};
  const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
  const held = new Promise<void>((resolve) => { finishWrite = resolve; });
  const f = await fixture(t, {
    syncFile: async (target) => {
      if (target.endsWith(".chat-write.tmp")) { reachedWrite(); await held; }
      const handle = await fs.open(target, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    },
  });
  const input = parseChatFirstMessage(request());
  const outcome = createFirstMessageCommitter(f.deps)(input, f.owner)
    .then((chat) => ({ chat }), (error: unknown) => ({ error }));
  await writing;
  f.owner.invalidate();
  let drained = false;
  const drain = f.workspaces.cancelAndSettle("workspace").then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "the workspace must wait for the write that is still running");

  finishWrite();
  const settled = await outcome;
  await drain;
  const durable = await f.store.get(input.chatId);
  // The sender's answer and the disk agree, and the message exists at most once.
  assert.equal(durable?.messages.length ?? 0, "chat" in settled ? 1 : 0);

  const next = documentOwner();
  t.after(() => next.invalidate());
  const retry = createFirstMessageCommitter(f.deps);
  const replayed = await retry(input, next);
  assert.equal(replayed.messages.length, 1);
  assert.deepEqual((await f.store.list()).map((chat) => chat.id), [input.chatId]);
});

test("payload failure keeps draft retryable; index uncertainty blocks retry and recovers a nonempty chat", async (t) => {
  for (const phase of ["chat-write", "index-write"] as const) {
    const f = await fixture(t, {
      syncFile: async (target) => {
        if (target.endsWith(`.${phase}.tmp`)) throw new Error(`Injected ${phase} failure`);
        const handle = await fs.open(target, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      },
    });
    const input = parseChatFirstMessage(request());
    let failure: unknown;
    let assignmentReleased = false;
    const removed: string[] = [];
    const commit = createFirstMessageCommitter({
      ...f.deps,
      prepareWorkspace: async () => ({ workspaceId: "private-target", release: () => { assignmentReleased = true; } }),
      releaseUnusedWorkspace: async (id) => { removed.push(id); },
    });
    try { await commit(input, f.owner); } catch (error) { failure = error; }
    assert.equal(assignmentReleased, phase === "chat-write", "an uncertain target stays reserved until reconciliation");
    assert.deepEqual(removed, phase === "chat-write" ? ["private-target"] : []);
    assert.ok(failure);
    assert.equal(isAppendReconciliationRequiredError(failure), phase === "index-write");
    assert.equal(f.turns.requiresAppendReconciliation(f.owner.documentId), phase === "index-write");
    const restart = createChatStore(async () => f.directory);
    const chat = await restart.get(input.chatId);
    assert.equal(chat?.messages.length ?? 0, phase === "index-write" ? 1 : 0);
    assert.equal((await restart.list()).length, phase === "index-write" ? 1 : 0);
  }
});

test("private first send keeps its selected skill authoritative through folder allocation and replay", async (t) => {
  const f = await fixture(t);
  const registry = new SkillRegistry({
    getWorkspace: async (id) => ({ id, name: id, folderPath: `/private/${id}`, permission: "ask", noWorkspace: true, createdAt: 1, updatedAt: 1 }),
    listConfigured: async () => [{ id: "review", name: "Review", description: "Review changes", instructions: "Look for incorrect behavior.", enabled: true }],
    discover: async () => [],
  });
  const [skill] = (await registry.catalog("workspace"));
  let allocated = 0;
  const commit = createFirstMessageCommitter({
    ...f.deps,
    prepareWorkspace: async () => ({ workspaceId: `private-${++allocated}`, release: () => undefined }),
    resolveSkill: (id, invocationId) => registry.resolveFresh(id, invocationId),
  });
  const parsed = parseChatFirstMessage(request({
    skillInvocation: { version: 1, invocationId: skill!.invocationId, displayName: "Review", source: "configured" },
  }));
  const chat = await commit(parsed, f.owner);
  assert.equal(chat.workspaceId, "private-1");
  assert.equal(chat.messages[0]?.skill?.name, "Review");
  let preparedWorkspace: string | undefined;
  let preparedPrompt: string | undefined;
  assert.equal(f.turns.handoff(chat.id, parsed.turnId, f.owner.documentId, (prepared) => {
    preparedWorkspace = prepared?.workspaceId;
    preparedPrompt = prepared?.formattedPrompt;
  }), true);
  assert.equal(preparedWorkspace, chat.workspaceId);
  assert.ok(preparedPrompt?.includes("Look for incorrect behavior."));
  f.turns.releaseMatching(chat.id, parsed.turnId, f.owner.documentId);
  const replay = await commit(parsed, f.owner);
  assert.equal(replay.id, chat.id);
  assert.equal(replay.workspaceId, "private-1");
  assert.equal(allocated, 1, "a replay never allocates another folder");
});

test("a first message counts its new chat once, not on a replay and not when the workspace is gone", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const f = await fixture(t);
  const commit = createFirstMessageCommitter({ ...f.deps, getWorkspace: async () => ({ scratch: true }) });
  const parsed = parseChatFirstMessage(request());
  await commit(parsed, f.owner);
  assert.deepEqual(sent, [{ event: "chat_created", props: { workspace_kind: "scratch" } }]);
  await commit(parsed, f.owner);
  assert.equal(sent.length, 1, "a replay confirms delivery; it creates nothing");

  const gone = createFirstMessageCommitter({ ...f.deps, getWorkspace: async () => undefined });
  await assert.rejects(gone(parseChatFirstMessage(request()), f.owner));
  assert.equal(sent.length, 1);
});

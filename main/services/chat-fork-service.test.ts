import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { ChatForkError, type ChatForkErrorCode } from "./chat-fork-error.js";
import {
  createChatForkService,
  type ChatForkCaller,
  type ChatForkServiceDependencies,
} from "./chat-fork-service.js";
import { createChatStore } from "./chat-store-core.js";
import type { Chat, Workspace } from "./types.js";
import { createWorkspaceApplicationService, type WorkspaceApplicationDependencies } from "./workspace-application-service.js";
import { workspaceFolderMissing } from "./workspace-folder-presence.js";
import { WorkspaceMutationGate } from "./workspace-mutation-gate.js";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-fork-service-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const chat = await store.create({ title: "Parser", workspaceId: "workspace-fork" });
  await store.appendMessage(chat.id, { role: "user", content: "Why does it fail?" });
  await store.appendMessage(chat.id, { role: "assistant", content: "A missing token." });
  await store.appendMessage(chat.id, { role: "user", content: "Fix it." });
  const source = await store.appendMessage(chat.id, { role: "assistant", content: "Fixed." });
  const [firstPrompt, firstReply, secondPrompt, secondReply] = source.messages.map(({ id }) => id);
  return {
    store,
    source,
    ids: { firstPrompt: firstPrompt!, firstReply: firstReply!, secondPrompt: secondPrompt!, secondReply: secondReply! },
  };
}

function service(
  store: ReturnType<typeof createChatStore>,
  overrides: Partial<ChatForkServiceDependencies> = {},
) {
  return createChatForkService({
    chatStore: store,
    beginChatCopy: () => () => undefined,
    workspaceExists: async () => true,
    ...overrides,
  });
}

const caller: ChatForkCaller = {
  admitWorkspace: () => ({ isAborted: () => false, release: () => undefined }),
};

async function rejectsWith(promise: Promise<unknown>, code: ChatForkErrorCode) {
  await assert.rejects(promise, (error) => error instanceof ChatForkError && error.code === code);
}

test("a fork is published once and starts its summary", async (t) => {
  const { store, source, ids } = await fixture(t);
  const published: Chat[] = [];
  const summaries: string[] = [];
  const forks = service(store, {
    published: (chat) => published.push(chat),
    startSummary: (chatId) => summaries.push(chatId),
  });

  const fork = await forks.fork(
    { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
    caller,
  );

  assert.deepEqual(fork.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
  assert.equal(fork.forkedFrom?.summary?.state, "pending");
  assert.deepEqual(published.map(({ id }) => id), [fork.id]);
  assert.deepEqual(summaries, [fork.id]);
});

test("fork failures carry a code a remote client can act on", async (t) => {
  const { store, source, ids } = await fixture(t);
  const forks = service(store, { startSummary: () => undefined });
  const fork = (forkAt: { messageId: string; position: "after" | "before" }, summary?: object) =>
    forks.fork({ chatId: source.id, forkAt, ...(summary ? { summary } : {}) }, caller);

  await rejectsWith(forks.fork({ chatId: "missing-chat" }, caller), "not_found");
  await rejectsWith(fork({ messageId: "missing-message", position: "after" }), "message_not_found");
  // A prompt is not a settled reply, and nothing comes before the first prompt.
  await rejectsWith(fork({ messageId: ids.firstPrompt, position: "after" }), "ineligible");
  await rejectsWith(fork({ messageId: ids.firstPrompt, position: "before" }), "ineligible");
  // Nothing follows the last reply, so there is nothing to summarize.
  await rejectsWith(fork({ messageId: ids.secondReply, position: "after" }, {}), "ineligible");
  assert.equal((await store.list()).length, 1);
});

test("a summary needs a host that can summarize", async (t) => {
  const { store, source, ids } = await fixture(t);
  await rejectsWith(
    service(store).fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
      caller,
    ),
    "unavailable",
  );
});

test("only one copy runs at a time and a busy source is refused", async (t) => {
  const { store, source } = await fixture(t);
  await rejectsWith(service(store, { beginChatCopy: () => null }).fork({ chatId: source.id }, caller), "busy");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forks = service(store, {
    workspaceExists: async () => {
      await gate;
      return true;
    },
  });
  const first = forks.fork({ chatId: source.id }, caller);
  await rejectsWith(forks.fork({ chatId: source.id }, caller), "busy");
  release();
  await first;
  // The finished copy frees the service for the next one.
  await forks.fork({ chatId: source.id }, caller);
});

test("a chat with unrecovered artifacts is not copied until they are resolved", async (t) => {
  const { store, source } = await fixture(t);
  let blocked: string | undefined = "Recover the visual artifact first.";
  const forks = service(store, { blockedReason: async () => blocked });

  await assert.rejects(
    forks.fork({ chatId: source.id }, caller),
    (error) =>
      error instanceof ChatForkError &&
      error.code === "unavailable" &&
      error.message === "Recover the visual artifact first.",
  );
  assert.equal((await store.list()).length, 1);

  blocked = undefined;
  await forks.fork({ chatId: source.id }, caller);
  assert.equal((await store.list()).length, 2);
});

test("a source that changed since the caller saw it is not forked", async (t) => {
  const { store, source, ids } = await fixture(t);
  const forks = service(store);
  let checks = 0;
  const stale = new Error("stale");
  await assert.rejects(
    forks.fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } },
      {
        ...caller,
        assertSource: () => {
          checks += 1;
          // The pre-check passes; the source changes before the store locks it.
          if (checks > 1) throw stale;
        },
      },
    ),
    (error) => error === stale,
  );
  assert.equal((await store.list()).length, 1);
});

test("a workspace change aborts the fork and discards its prepared journal", async (t) => {
  const { store, source, ids } = await fixture(t);
  let aborted = false;
  const deleted: string[] = [];
  const forks = service(store, {
    newChatId: () => "fork-target",
    journal: {
      forkChat: async () => {
        aborted = true;
        return true;
      },
      deleteChat: async (chatId) => {
        deleted.push(chatId);
      },
    },
  });

  await rejectsWith(
    forks.fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } },
      { admitWorkspace: () => ({ isAborted: () => aborted, release: () => undefined }) },
    ),
    "busy",
  );
  assert.deepEqual(deleted, ["fork-target"]);
  assert.equal(await store.get("fork-target"), null);
});

test("a journal that cannot be carried degrades the fork instead of failing it", async (t) => {
  const { store, source, ids } = await fixture(t);
  const degraded: unknown[] = [];
  const failure = new Error("journal unavailable");
  const fork = await service(store, {
    journal: {
      forkChat: async () => {
        throw failure;
      },
      deleteChat: async () => undefined,
    },
    reportDegraded: (error) => degraded.push(error),
  }).fork({ chatId: source.id, forkAt: { messageId: ids.secondPrompt, position: "before" } }, caller);

  assert.deepEqual(fork.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
  assert.deepEqual(degraded, [failure]);
});

test("Bot chats fork only through a caller that can copy them", async (t) => {
  const { store } = await fixture(t);
  const bot = await store.create({ title: "Bot", workspaceId: "workspace-fork", botId: "bot-one" });
  await store.appendMessage(bot.id, { role: "user", content: "Hello" });
  await rejectsWith(service(store).fork({ chatId: bot.id }, caller), "not_found");

  const copy = { ...bot, id: "bot-copy" };
  const published: string[] = [];
  const copied = await service(store, { published: (chat) => published.push(chat.id) }).fork(
    { chatId: bot.id },
    { ...caller, copyBotChat: async () => copy },
  );
  assert.equal(copied, copy);
  assert.deepEqual(published, ["bot-copy"]);
});

test("a host whose turns read only the journal refuses a fork it cannot journal", async (t) => {
  const { store, source, ids } = await fixture(t);
  const degraded: unknown[] = [];
  const deleted: string[] = [];
  let forkChat: () => Promise<boolean> = async () => {
    throw new Error("rename failed");
  };
  const forks = service(store, {
    newChatId: () => "fork-target",
    journalRequired: true,
    journal: {
      forkChat: () => forkChat(),
      deleteChat: async (chatId) => {
        deleted.push(chatId);
      },
    },
    reportDegraded: (error) => degraded.push(error),
  });
  const fork = () =>
    forks.fork({ chatId: source.id, forkAt: { messageId: ids.secondPrompt, position: "before" } }, caller);

  await rejectsWith(fork(), "unavailable");
  // A partly written journal is discarded with the fork it was for.
  assert.deepEqual(deleted, ["fork-target"]);
  forkChat = async () => false;
  await rejectsWith(fork(), "unavailable");
  assert.deepEqual((await store.list()).map(({ id }) => id), [source.id]);
  assert.deepEqual(degraded, []);

  forkChat = async () => true;
  const forked = await fork();
  assert.deepEqual(forked.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
});

test("a caller can refuse the copy before it is installed", async (t) => {
  const { store, source, ids } = await fixture(t);
  const refused = new Error("too large to send");
  const summaries: string[] = [];
  await assert.rejects(
    service(store, { startSummary: (chatId) => summaries.push(chatId) }).fork(
      { chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" }, summary: {} },
      {
        ...caller,
        assertInstallable: (chat) => {
          assert.deepEqual(chat.messages.map(({ content }) => content), ["Why does it fail?", "A missing token."]);
          throw refused;
        },
      },
    ),
    (error) => error === refused,
  );
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(summaries, []);
});

test("feature-owned chats are ineligible for copy and fork", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-chat-fork-owned-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createChatStore(async () => directory);
  const owned = await store.create({ owner: { kind: "design-project", projectId: "project-1" } });
  await store.appendMessage(owned.id, { role: "user", content: "A pricing page" });
  const reply = await store.appendMessage(owned.id, { role: "assistant", content: "Here it is." });
  const published: Chat[] = [];
  const admitted: string[] = [];
  const recordingCaller: ChatForkCaller = {
    admitWorkspace: (workspaceId) => {
      admitted.push(workspaceId);
      return { isAborted: () => false, release: () => undefined };
    },
  };
  // A pending artifact block must not mask the ownership refusal as "unavailable".
  const forks = service(store, {
    published: (chat) => published.push(chat),
    startSummary: () => undefined,
    blockedReason: async () => "Recover the visual artifact first.",
  });

  await rejectsWith(forks.fork({ chatId: owned.id }, recordingCaller), "ineligible");
  await rejectsWith(
    forks.fork(
      { chatId: owned.id, forkAt: { messageId: reply.messages[1]!.id, position: "after" } },
      recordingCaller,
    ),
    "ineligible",
  );
  // Refused before any workspace admission: an owned chat never borrows the
  // default workspace's mutation gate.
  assert.deepEqual(admitted, []);
  assert.deepEqual(published, []);
  assert.equal((await store.list()).length, 1);
});

async function privateForkWorkspaces(t: TestContext, store: ReturnType<typeof createChatStore>, hidden = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-private-fork-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalFolder = path.join(root, "original");
  await fs.mkdir(originalFolder);
  await fs.writeFile(path.join(originalFolder, "private.txt"), "source-only content");
  const records = new Map<string, Workspace>([["workspace-fork", {
    id: "workspace-fork", name: "Source", folderPath: originalFolder, permission: "none",
    ...(hidden ? { noWorkspace: true as const } : {}), createdAt: 1, updatedAt: 1,
  }]]);
  let next = 0;
  const application = createWorkspaceApplicationService({
    configStore: {
      listWorkspaces: async () => [...records.values()],
      getWorkspace: async (id) => records.get(id),
      saveWorkspace: async (workspace) => { records.set(workspace.id, workspace); return workspace; },
      removeWorkspace: async (id) => { records.delete(id); },
    },
    llmClient: { cancelWorkspaceAndSettle: async () => undefined },
    scheduleService: { cancelWorkspace: async () => undefined, resumeWorkspace: async () => undefined },
    terminalService: { closeForWorkspace: () => undefined },
    workspaceMutationGate: new WorkspaceMutationGate(),
    workspaceOperationRegistry: { cancelAndSettle: async () => undefined },
    noWorkspace: {
      createDirectory: async () => { const folderPath = path.join(root, `fresh-${next + 1}`); await fs.mkdir(folderPath); return { folderPath }; },
      chatIdsIn: async (id) => (await store.list(id)).map((chat) => chat.id),
      workspaceIdsWithChats: async () => new Set((await store.list()).map((chat) => chat.workspaceId!)),
      trash: async (folder) => { await fs.rm(folder, { recursive: true }); },
    },
    createScratchWorkspaceDirectory: async () => { throw new Error("Scratch creation is outside this fixture."); },
    realpath: (folder) => fs.realpath(folder),
    stat: (folder) => fs.stat(folder),
    removeEmptyDirectory: (folder) => fs.rmdir(folder),
    createId: () => `hidden-${++next}`,
    now: () => 1,
    logError: () => undefined,
  } satisfies WorkspaceApplicationDependencies);
  return { application, records, originalFolder };
}

test("No workspace copy and populated forks isolate files and access, without changing the source", async (t) => {
  const { store, source, ids } = await fixture(t);
  const { application, records, originalFolder } = await privateForkWorkspaces(t, store);
  const forks = service(store, {
    prepareWorkspace: (id) => application.reserveNoWorkspaceChat(id),
    releaseUnusedWorkspace: (id) => application.releaseNoWorkspaceAfterChat(id),
  });
  const copies = [
    await forks.fork({ chatId: source.id }, caller),
    await forks.fork({ chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } }, caller),
    await forks.fork({ chatId: source.id, forkAt: { messageId: ids.secondPrompt, position: "before" } }, caller),
  ];
  assert.equal(new Set([source.workspaceId, ...copies.map((chat) => chat.workspaceId)]).size, 4);
  for (const copy of copies) {
    const target = records.get(copy.workspaceId!)!;
    assert.equal(target.noWorkspace, true);
    assert.notEqual(target.folderPath, originalFolder);
    assert.deepEqual(await fs.readdir(target.folderPath!), []);
    await application.update(target.id, { permission: "full" });
    await fs.writeFile(path.join(target.folderPath!, "fork.txt"), "fork only");
  }
  assert.equal(records.get(source.workspaceId!)?.permission, "none");
  assert.deepEqual(await fs.readdir(originalFolder), ["private.txt"]);
  assert.equal((await store.get(source.id))?.messages.length, 4);
});

test("named-workspace forks retain their folder and access", async (t) => {
  const { store, source, ids } = await fixture(t);
  const { application, records } = await privateForkWorkspaces(t, store, false);
  const copied = await service(store, {
    prepareWorkspace: (id) => application.reserveNoWorkspaceChat(id),
  }).fork({ chatId: source.id, forkAt: { messageId: ids.firstReply, position: "after" } }, caller);
  assert.equal(copied.workspaceId, source.workspaceId);
  assert.equal(records.size, 1);
  assert.equal(records.get(copied.workspaceId!)?.permission, "none");
});

test("a refused private fork releases its unused folder, but a committed one survives cleanup", async (t) => {
  const { store, source } = await fixture(t);
  const { application, records } = await privateForkWorkspaces(t, store);
  const forks = service(store, {
    prepareWorkspace: (id) => application.reserveNoWorkspaceChat(id),
    releaseUnusedWorkspace: (id) => application.releaseNoWorkspaceAfterChat(id),
  });
  await assert.rejects(forks.fork({ chatId: source.id }, {
    ...caller, assertInstallable: () => { throw new Error("owner revoked"); },
  }), /owner revoked/u);
  assert.equal(records.size, 1);
  const copy = await forks.fork({ chatId: source.id }, caller);
  await application.releaseNoWorkspaceAfterChat(copy.workspaceId!);
  assert.equal(records.has(copy.workspaceId!), true);
});

/** A chat in "workspace-fork" whose folder was moved away outside Aiden, plus two usable destinations. */
async function missingFolderWorkspaces(t: TestContext, store: ReturnType<typeof createChatStore>) {
  const { application, records, originalFolder } = await privateForkWorkspaces(t, store, false);
  records.set("workspace-fork", { ...records.get("workspace-fork")!, permission: "ask" });
  const root = path.dirname(originalFolder);
  const elsewhere = path.join(root, "elsewhere");
  await fs.mkdir(elsewhere);
  records.set("elsewhere", { id: "elsewhere", name: "Elsewhere", folderPath: elsewhere, permission: "ask", createdAt: 2, updatedAt: 2 });
  const home = path.join(root, "home");
  await fs.mkdir(home);
  records.set("default", {
    id: "default", name: "No workspace", folderPath: home, permission: "ask", noWorkspace: true, createdAt: 3, updatedAt: 3,
  });
  const movedFolder = `${originalFolder}-moved`;
  await fs.rename(originalFolder, movedFolder);
  const forks = service(store, {
    workspaceExists: async (id) => records.has(id),
    workspaceFolderMissing: async (id) => {
      const record = records.get(id);
      return Boolean(record && (await workspaceFolderMissing(record)));
    },
    prepareWorkspace: (id) => application.reserveNoWorkspaceChat(id),
    releaseUnusedWorkspace: (id) => application.releaseNoWorkspaceAfterChat(id),
  });
  return { forks, records, originalFolder, movedFolder };
}

test("a chat whose folder is gone continues in another workspace with its history, and the original is untouched", async (t) => {
  const { store, source, ids } = await fixture(t);
  const { forks, movedFolder } = await missingFolderWorkspaces(t, store);
  const admitted: string[] = [];
  const continued = await forks.fork(
    { chatId: source.id, continueIn: { workspaceId: "elsewhere" } },
    { admitWorkspace: (id) => { admitted.push(id); return caller.admitWorkspace(id); } },
  );

  assert.equal(continued.workspaceId, "elsewhere");
  assert.notEqual(continued.id, source.id);
  assert.deepEqual(continued.messages.map(({ content }) => content), ["Why does it fail?", "A missing token.", "Fix it.", "Fixed."]);
  assert.equal(continued.forkedFrom?.chatId, source.id);
  assert.equal(continued.forkedFrom?.messageId, ids.secondReply);
  // Both workspaces are held still while the copy is made.
  assert.deepEqual([...admitted].sort(), ["elsewhere", "workspace-fork"]);

  const original = await store.get(source.id);
  assert.equal(original?.workspaceId, "workspace-fork");
  assert.deepEqual(original?.messages.map(({ id }) => id), source.messages.map(({ id }) => id));
  assert.equal(original?.forkedFrom, undefined);
  // Nothing in the moved folder was touched or copied.
  assert.deepEqual(await fs.readdir(movedFolder), ["private.txt"]);
});

test("a destination workspace that refuses its hold releases the source workspace's hold", async (t) => {
  const { store, source } = await fixture(t);
  const { forks } = await missingFolderWorkspaces(t, store);
  const held = new Set<string>();
  const holdingCaller = (refuse?: string): ChatForkCaller => ({
    admitWorkspace: (id) => {
      if (id === refuse) throw new ChatForkError("busy", "That workspace is being changed.");
      held.add(id);
      return { isAborted: () => false, release: () => { held.delete(id); } };
    },
  });

  await rejectsWith(forks.fork({ chatId: source.id, continueIn: { workspaceId: "elsewhere" } }, holdingCaller("elsewhere")), "busy");
  assert.deepEqual([...held], []);
  assert.deepEqual((await store.list()).map(({ id }) => id), [source.id]);
  // Nothing is left held, so the next attempt goes through.
  const continued = await forks.fork({ chatId: source.id, continueIn: { workspaceId: "elsewhere" } }, holdingCaller());
  assert.equal(continued.workspaceId, "elsewhere");
  assert.deepEqual([...held], []);
});

test("No workspace as the destination uses its home, then a fresh hidden folder once the home is taken", async (t) => {
  const { store, source } = await fixture(t);
  const { forks, records } = await missingFolderWorkspaces(t, store);
  const first = await forks.fork({ chatId: source.id, continueIn: { workspaceId: "default" } }, caller);
  assert.equal(first.workspaceId, "default");
  const second = await forks.fork({ chatId: source.id, continueIn: { workspaceId: "default" } }, caller);
  assert.notEqual(second.workspaceId, "default");
  const fresh = records.get(second.workspaceId!);
  assert.equal(fresh?.noWorkspace, true);
  assert.deepEqual(await fs.readdir(fresh!.folderPath!), []);
  assert.equal(second.messages.length, 4);
});

test("continuing is only for a chat whose folder is gone, into a usable workspace, with the whole conversation", async (t) => {
  const { store, source, ids } = await fixture(t);
  const { forks, records, originalFolder, movedFolder } = await missingFolderWorkspaces(t, store);
  const continueIn = (workspaceId: string) => forks.fork({ chatId: source.id, continueIn: { workspaceId } }, caller);

  await rejectsWith(continueIn("workspace-fork"), "ineligible");
  await rejectsWith(continueIn("assistant"), "ineligible");
  await rejectsWith(continueIn("removed-workspace"), "not_found");
  const elsewhere = records.get("elsewhere")!;
  records.set("elsewhere", { ...elsewhere, folderPath: path.join(path.dirname(originalFolder), "gone") });
  await rejectsWith(continueIn("elsewhere"), "unavailable");
  records.set("elsewhere", elsewhere);
  await rejectsWith(
    forks.fork({ chatId: source.id, continueIn: { workspaceId: "elsewhere" }, forkAt: { messageId: ids.firstReply, position: "after" } }, caller),
    "ineligible",
  );
  await rejectsWith(forks.fork({ chatId: source.id, continueIn: { workspaceId: "elsewhere" }, summary: {} }, caller), "ineligible");
  // Once the folder is back the chat keeps working where it is.
  await fs.rename(movedFolder, originalFolder);
  await rejectsWith(continueIn("elsewhere"), "ineligible");
  assert.deepEqual((await store.list()).map(({ id }) => id), [source.id]);
});

test("a chat with no reply yet, or a Bot chat, is not continued elsewhere", async (t) => {
  const { store } = await fixture(t);
  const { forks } = await missingFolderWorkspaces(t, store);
  const fresh = await store.create({ title: "Fresh", workspaceId: "workspace-fork" });
  await store.appendMessage(fresh.id, { role: "user", content: "Hello?" });
  await rejectsWith(forks.fork({ chatId: fresh.id, continueIn: { workspaceId: "elsewhere" } }, caller), "ineligible");

  const bot = await store.create({ title: "Bot", workspaceId: "workspace-fork", botId: "bot-one" });
  await store.appendMessage(bot.id, { role: "user", content: "Hello" });
  await store.appendMessage(bot.id, { role: "assistant", content: "Hi." });
  let botCopies = 0;
  await rejectsWith(
    forks.fork(
      { chatId: bot.id, continueIn: { workspaceId: "elsewhere" } },
      { ...caller, copyBotChat: async (chat) => { botCopies += 1; return chat; } },
    ),
    "ineligible",
  );
  assert.equal(botCopies, 0);
  assert.equal((await store.list()).length, 3);
});

test("a host that cannot check folders refuses to continue", async (t) => {
  const { store, source } = await fixture(t);
  const forks = service(store);
  assert.equal(forks.supportsContinue, false);
  await rejectsWith(forks.fork({ chatId: source.id, continueIn: { workspaceId: "elsewhere" } }, caller), "unavailable");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_LINK_LIMIT,
  ChatLinkStore,
  parseChatLinkDocument,
  startedChatCeiling,
  type ChatLink,
  type ChatLinkDocument,
} from "./links.js";

function link(child: string, fields: Partial<ChatLink> = {}): ChatLink {
  return {
    childChatId: child,
    leadChatId: "lead-1",
    key: `agent-chat:lead-1:k:${child}`,
    title: `Child ${child}`,
    createdAt: 1_000,
    ceiling: { mode: "ask", macGrants: ["shell"], chatOnly: false },
    ...fields,
  };
}

/** Storage that keeps the last saved document and can be told to fail. */
function memoryStorage(initial?: unknown) {
  let saved: unknown = initial;
  let failSaves = false;
  const errors: string[] = [];
  return {
    storage: {
      load: async () => saved,
      save: async (document: ChatLinkDocument) => {
        if (failSaves) throw new Error("disk full");
        saved = structuredClone(document);
      },
    },
    saved: () => saved as ChatLinkDocument | undefined,
    failSaves: (value: boolean) => {
      failSaves = value;
    },
    errors,
    log: (message: string) => errors.push(message),
  };
}

test("links survive a restart and answer by child, by key and by lead", async () => {
  const memory = memoryStorage();
  const store = new ChatLinkStore(memory.storage);
  await store.restore();
  await store.add(link("child-1"));
  await store.add(link("child-2", { leadChatId: "lead-2", key: "agent-chat:lead-2:k:0" }));

  const restarted = new ChatLinkStore(memory.storage);
  await restarted.restore();
  assert.equal(restarted.get("child-1")?.leadChatId, "lead-1");
  assert.equal(restarted.byKey("lead-1", "agent-chat:lead-1:k:child-1")?.childChatId, "child-1");
  assert.deepEqual(restarted.childrenOf("lead-2").map((each) => each.childChatId), ["child-2"]);
  assert.deepEqual(restarted.ceilingFor("child-1"), { mode: "ask", macGrants: ["shell"], chatOnly: false });
  assert.equal(restarted.ceilingFor("unrelated"), undefined);
});

test("a damaged file reads as empty and damaged links are dropped one by one", async () => {
  assert.deepEqual(parseChatLinkDocument("not json at all").links, []);
  assert.deepEqual(parseChatLinkDocument({ version: 2, links: [link("child-1")] }).links, []);
  const document = parseChatLinkDocument({
    version: 1,
    links: [
      link("child-1"),
      { ...link("child-2"), ceiling: { mode: "sometimes", macGrants: [], chatOnly: false } },
      { ...link("child-3"), leadChatId: "child-3" },
      { ...link("child-4"), owed: { runId: "run-1", end: "exploded", at: 5 }, delivered: ["run-0", 7] },
      { ...link("child-1"), leadChatId: "lead-9" },
    ],
  });
  assert.deepEqual(document.links.map((each) => each.childChatId), ["child-1", "child-4"]);
  // The first link for a chat wins; a damaged optional part is dropped, not the link.
  assert.equal(document.links[0]?.leadChatId, "lead-1");
  assert.equal(document.links[1]?.owed, undefined);
  assert.deepEqual(document.links[1]?.delivered, ["run-0"]);

  const memory = memoryStorage();
  memory.storage.load = async () => {
    throw new Error("EACCES");
  };
  const store = new ChatLinkStore(memory.storage, memory.log);
  await store.restore();
  assert.deepEqual(store.childrenOf("lead-1"), []);
  assert.equal(memory.errors.length, 1);
});

test("a failed save keeps the link in memory and the next save writes it", async () => {
  const memory = memoryStorage();
  const store = new ChatLinkStore(memory.storage, memory.log);
  await store.restore();
  memory.failSaves(true);
  await store.add(link("child-1"));
  assert.equal(store.get("child-1")?.childChatId, "child-1");
  assert.equal(memory.saved(), undefined);
  assert.equal(memory.errors.length, 1);

  memory.failSaves(false);
  await store.update("child-1", (draft) => {
    draft.tookOverAt = 2_000;
  });
  assert.deepEqual(memory.saved()?.links.map((each) => [each.childChatId, each.tookOverAt]), [["child-1", 2_000]]);
});

test("a chat keeps its first link, an edit can't damage or move a link, and deleting a lead frees its chats", async () => {
  const memory = memoryStorage();
  const store = new ChatLinkStore(memory.storage);
  await store.restore();
  await store.add(link("child-1"));
  const again = await store.add(link("child-1", { leadChatId: "lead-2" }));
  assert.equal(again.leadChatId, "lead-1");
  await assert.rejects(store.update("child-1", (draft) => {
    draft.leadChatId = "lead-2";
  }));
  await assert.rejects(store.update("child-1", (draft) => {
    draft.ceiling = { mode: "always" as never, macGrants: [], chatOnly: false };
  }));
  assert.equal(store.get("child-1")?.ceiling.mode, "ask");
  assert.equal(await store.update("missing", () => undefined), undefined);

  await store.add(link("child-2"));
  await store.deleteChat("lead-1");
  assert.deepEqual(store.childrenOf("lead-1"), []);
  assert.deepEqual(memory.saved()?.links, []);
});

test("the delivered list keeps the newest 16 runs, and links beyond the memory guard drop the oldest", async () => {
  const store = new ChatLinkStore(memoryStorage().storage);
  await store.restore();
  await store.add(link("child-1"));
  await store.update("child-1", (draft) => {
    draft.delivered = Array.from({ length: 20 }, (_, index) => `run-${index}`);
  });
  assert.deepEqual(store.get("child-1")?.delivered?.[0], "run-4");
  assert.equal(store.get("child-1")?.delivered?.length, 16);

  const big = parseChatLinkDocument({
    version: 1,
    links: Array.from({ length: CHAT_LINK_LIMIT + 2 }, (_, index) => link(`child-${index}`)),
  });
  assert.equal(big.links.length, CHAT_LINK_LIMIT);
  assert.equal(big.links[0]?.childChatId, "child-2");
});

test("a started chat whose link is lost runs as Ask with no Mac grants; an ordinary chat has no ceiling", async () => {
  const store = new ChatLinkStore(memoryStorage().storage);
  await store.restore();
  assert.deepEqual(startedChatCeiling(store, "child-1", { chatId: "lead-1" }), { mode: "ask", macGrants: [], chatOnly: false });
  assert.equal(startedChatCeiling(store, "chat-1", undefined), undefined);
  await store.add(link("child-1", { ceiling: { mode: "never", macGrants: ["files"], chatOnly: false } }));
  assert.equal(startedChatCeiling(store, "child-1", { chatId: "lead-1" })?.mode, "never");
});

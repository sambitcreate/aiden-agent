import assert from "node:assert/strict";
import test from "node:test";

import type { AppSettings, Workspace } from "../types.js";
import {
  approvalCeilingOf,
  currentWorkspaceApproval,
  generationApprovalPolicy,
} from "../approval-gate/run-approval.js";
import {
  CHAT_LINK_LIMIT,
  CHAT_LINK_RESULTS_KEPT,
  ChatLinkStore,
  parseChatLinkDocument,
  startedChatCeiling,
  startedChatTurnCeiling,
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
  assert.deepEqual(
    restarted.childrenOf("lead-2").map((each) => each.childChatId),
    ["child-2"],
  );
  assert.deepEqual(restarted.ceilingFor("child-1"), {
    mode: "ask",
    macGrants: ["shell"],
    chatOnly: false,
  });
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
      {
        ...link("child-4"),
        owed: { runId: "run-1", end: "exploded", at: 5 },
        delivered: ["run-0", 7],
      },
      { ...link("child-1"), leadChatId: "lead-9" },
    ],
  });
  assert.deepEqual(
    document.links.map((each) => each.childChatId),
    ["child-1", "child-4"],
  );
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
  assert.deepEqual(
    memory.saved()?.links.map((each) => [each.childChatId, each.tookOverAt]),
    [["child-1", 2_000]],
  );
});

test("a chat keeps its first link, an edit can't damage or move a link, and deleting a lead frees its chats", async () => {
  const memory = memoryStorage();
  const store = new ChatLinkStore(memory.storage);
  await store.restore();
  await store.add(link("child-1"));
  const again = await store.add(link("child-1", { leadChatId: "lead-2" }));
  assert.equal(again.leadChatId, "lead-1");
  await assert.rejects(
    store.update("child-1", (draft) => {
      draft.leadChatId = "lead-2";
    }),
  );
  await assert.rejects(
    store.update("child-1", (draft) => {
      draft.ceiling = { mode: "always" as never, macGrants: [], chatOnly: false };
    }),
  );
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
  assert.deepEqual(startedChatCeiling(store, "child-1", { chatId: "lead-1" }), {
    mode: "ask",
    macGrants: [],
    chatOnly: false,
  });
  assert.equal(startedChatCeiling(store, "chat-1", undefined), undefined);
  await store.add(
    link("child-1", { ceiling: { mode: "never", macGrants: ["files"], chatOnly: false } }),
  );
  assert.equal(startedChatCeiling(store, "child-1", { chatId: "lead-1" })?.mode, "never");
});

test("a burst of updates shares one save behind the one in progress, and the file ends with every change", async () => {
  const memory = memoryStorage();
  let saves = 0;
  const save = memory.storage.save;
  memory.storage.save = async (document) => {
    saves += 1;
    await save(document);
  };
  const store = new ChatLinkStore(memory.storage, memory.log);
  await store.restore();
  await store.add(link("child-1"));
  saves = 0;
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update("child-1", (draft) => {
        draft.leadSentAt = 2_000 + index;
      }),
    ),
  );
  assert.ok(saves <= 2, `20 updates took ${saves} saves`);
  assert.equal(memory.saved()?.links[0]?.leadSentAt, 2_019);
});

test("only the newest links keep a result schema and result, so old ones can't grow the file", async () => {
  const memory = memoryStorage();
  const store = new ChatLinkStore(memory.storage, memory.log);
  await store.restore();
  const schema = { type: "object" };
  for (let index = 0; index < CHAT_LINK_RESULTS_KEPT + 2; index += 1) {
    await store.add(
      link(`child-${index}`, { resultSchema: schema, result: { value: { index }, at: 1_000 } }),
    );
  }
  assert.equal(store.get("child-0")?.resultSchema, undefined);
  assert.equal(store.get("child-1")?.result, undefined);
  assert.deepEqual(store.get("child-2")?.result?.value, { index: 2 });
  assert.deepEqual(store.get(`child-${CHAT_LINK_RESULTS_KEPT + 1}`)?.resultSchema, schema);
  const saved = memory.saved()?.links ?? [];
  assert.equal(saved.filter((each) => each.result !== undefined).length, CHAT_LINK_RESULTS_KEPT);
});

/** A workspace the approval policy reads, in the given mode. */
function workspaceIn(id: string, approvalMode: "ask" | "auto" | "never"): Workspace {
  return {
    id,
    name: id,
    folderPath: `/tmp/${id}`,
    permission: "ask",
    createdAt: 0,
    approvalMode,
    macGrants: { shell: true, files: true },
  } as unknown as Workspace;
}

test("a started chat's turn follows its lead's workspace as it is now: tightening the lead to Ask makes a Never-ask worktree chat ask", async () => {
  const workspaces = new Map<string, Workspace>([
    ["lead-workspace", workspaceIn("lead-workspace", "never")],
    ["worktree-1", workspaceIn("worktree-1", "never")],
  ]);
  const ports = {
    getSettings: async (): Promise<Pick<AppSettings, "approvalMode">> => ({ approvalMode: "auto" }),
    getWorkspace: async (id: string) => workspaces.get(id),
  };
  const store = new ChatLinkStore(memoryStorage().storage);
  await store.restore();
  // Started while the lead's workspace was Never ask with shell and files allowed.
  const leadPolicy = await currentWorkspaceApproval(ports, "lead-workspace");
  await store.add(link("child-1", { ceiling: approvalCeilingOf(leadPolicy!) }));
  const leadWorkspaceOf: Record<string, string> = { "lead-1": "lead-workspace" };
  const turnPolicy = async () => {
    const ceiling = await startedChatTurnCeiling({
      links: store,
      chatId: "child-1",
      startedBy: { chatId: "lead-1" },
      leadCeiling: async (leadChatId) => {
        const policy = await currentWorkspaceApproval(ports, leadWorkspaceOf[leadChatId]!);
        return policy ? approvalCeilingOf(policy) : undefined;
      },
    });
    return generationApprovalPolicy(
      {
        workspace: workspaces.get("worktree-1"),
        botBound: false,
        mode: undefined,
        permission: undefined,
        ceiling,
      },
      ports.getSettings,
    );
  };
  assert.equal((await turnPolicy())?.mode, "never");

  workspaces.set("lead-workspace", workspaceIn("lead-workspace", "ask"));
  const tightened = await turnPolicy();
  assert.equal(tightened?.mode, "ask");

  // A lead whose workspace is gone leaves the stored ceiling alone.
  workspaces.delete("lead-workspace");
  assert.equal((await turnPolicy())?.mode, "never");
});

test("a started chat whose link is lost starts its turn under Ask with no Mac grants, whatever its lead allows", async () => {
  const store = new ChatLinkStore(memoryStorage().storage);
  await store.restore();
  const ceiling = await startedChatTurnCeiling({
    links: store,
    chatId: "child-lost",
    startedBy: { chatId: "lead-1" },
    leadCeiling: async () => ({ mode: "never", macGrants: ["shell", "files"], chatOnly: false }),
  });
  assert.deepEqual(ceiling, { mode: "ask", macGrants: [], chatOnly: false });
  const policy = await generationApprovalPolicy(
    {
      workspace: workspaceIn("w1", "never"),
      botBound: false,
      mode: undefined,
      permission: undefined,
      ceiling,
    },
    async () => ({ approvalMode: "never" }),
  );
  assert.equal(policy?.mode, "ask");
  assert.equal(policy?.macGrants.size, 0);
  // A chat no chat started has no ceiling.
  assert.equal(
    await startedChatTurnCeiling({
      links: store,
      chatId: "chat-1",
      startedBy: undefined,
      leadCeiling: async () => undefined,
    }),
    undefined,
  );
});

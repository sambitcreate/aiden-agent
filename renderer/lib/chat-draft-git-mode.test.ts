import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_DRAFT_GIT_MEMORY_KEY,
  CHAT_DRAFT_GIT_MEMORY_LIMIT,
  readChatDraftGitMemory,
  rememberChatDraftGitMemory,
  resolveDraftWorktreeDefaults,
} from "./chat-draft-git-memory";
import {
  chatDraftWorktreeRequest,
  createChatDraft,
  discardChatDraft,
  getChatDraft,
  retainChatDraft,
  setChatDraftGitMode,
  updateChatDraft,
  updateChatDraftWorktree,
} from "./chat-draft";

/** A mounted draft, so creating the next one does not sweep it. */
function mountedDraft(...args: Parameters<typeof createChatDraft>) {
  const draft = createChatDraft(...args);
  retainChatDraft(draft.chat.id);
  return draft;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

function withLocalStorage(t: test.TestContext) {
  const storage = memoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  return storage;
}

test("workspace git memory defaults to This checkout and survives bad or missing storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(readChatDraftGitMemory("ws-a", storage), { gitMode: "checkout" });
  rememberChatDraftGitMemory("ws-a", { gitMode: "worktree", baseRef: "main", fromOrigin: true }, storage);
  rememberChatDraftGitMemory("ws-b", { gitMode: "checkout" }, storage);
  assert.deepEqual(readChatDraftGitMemory("ws-a", storage), { gitMode: "worktree", baseRef: "main", fromOrigin: true });
  assert.deepEqual(readChatDraftGitMemory("ws-b", storage), { gitMode: "checkout" });

  storage.setItem(CHAT_DRAFT_GIT_MEMORY_KEY, "{not json");
  assert.deepEqual(readChatDraftGitMemory("ws-a", storage), { gitMode: "checkout" });
  storage.setItem(CHAT_DRAFT_GIT_MEMORY_KEY, JSON.stringify([["ws-a", { gitMode: "elsewhere" }], ["ws-b", { gitMode: "worktree", baseRef: 7 }]]));
  assert.deepEqual(readChatDraftGitMemory("ws-a", storage), { gitMode: "checkout" });
  assert.deepEqual(readChatDraftGitMemory("ws-b", storage), { gitMode: "worktree" });

  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  assert.deepEqual(readChatDraftGitMemory("ws-a", throwing), { gitMode: "checkout" });
  assert.doesNotThrow(() => rememberChatDraftGitMemory("ws-a", { gitMode: "worktree" }, throwing));
  assert.deepEqual(readChatDraftGitMemory("ws-a", undefined), { gitMode: "checkout" });
});

test("workspace git memory keeps only the most recently used workspaces", () => {
  const storage = memoryStorage();
  for (let index = 0; index <= CHAT_DRAFT_GIT_MEMORY_LIMIT; index += 1) {
    rememberChatDraftGitMemory(`ws-${index}`, { gitMode: "worktree" }, storage);
  }
  assert.deepEqual(readChatDraftGitMemory("ws-0", storage), { gitMode: "checkout" }, "the oldest is forgotten");
  assert.equal(readChatDraftGitMemory("ws-1", storage).gitMode, "worktree");
  assert.equal(readChatDraftGitMemory(`ws-${CHAT_DRAFT_GIT_MEMORY_LIMIT}`, storage).gitMode, "worktree");
});

test("new-worktree defaults prefer a remembered base that still exists, then the default branch", () => {
  const repository = {
    branches: ["feature", "main"], remoteBranches: ["origin/main"], current: "feature",
    defaultBranch: "main", hasRemote: true,
  };
  const cases: Array<[string, Parameters<typeof resolveDraftWorktreeDefaults>, ReturnType<typeof resolveDraftWorktreeDefaults>]> = [
    ["nothing remembered", [{ gitMode: "checkout" }, repository], { baseRef: "main", fromOrigin: true }],
    ["remembered base", [{ gitMode: "worktree", baseRef: "feature", fromOrigin: false }, repository], { baseRef: "feature", fromOrigin: false }],
    ["remembered remote base", [{ gitMode: "worktree", baseRef: "origin/main" }, repository], { baseRef: "origin/main", fromOrigin: true }],
    ["remembered base deleted", [{ gitMode: "worktree", baseRef: "gone" }, repository], { baseRef: "main", fromOrigin: true }],
    ["no remote", [{ gitMode: "worktree", fromOrigin: true }, { branches: ["trunk"], current: "trunk", hasRemote: false }], { baseRef: "trunk", fromOrigin: false }],
    ["default branch only on the remote", [{ gitMode: "checkout" }, { ...repository, branches: ["feature"] }], { baseRef: "feature", fromOrigin: true }],
    ["no commits yet", [{ gitMode: "worktree" }, { branches: ["main"], unborn: true }], undefined],
  ];
  for (const [name, args, expected] of cases) {
    assert.deepEqual(resolveDraftWorktreeDefaults(...args), expected, name);
  }
});

test("a draft starts in the workspace's remembered git mode and resets it when it moves", (t) => {
  withLocalStorage(t);
  rememberChatDraftGitMemory("ws-worktree", { gitMode: "worktree", baseRef: "main", fromOrigin: true });

  const plain = mountedDraft("ws-plain");
  assert.equal(plain.gitMode, "checkout");
  assert.equal(plain.worktree, undefined);
  assert.equal(chatDraftWorktreeRequest(plain), undefined);

  const remembered = mountedDraft("ws-worktree");
  assert.equal(remembered.gitMode, "worktree");
  assert.deepEqual(remembered.worktree, { baseRef: "main", fromOrigin: true });

  // An entry point (⌥↵ in New chat in…) can ask for New worktree explicitly.
  const explicit = mountedDraft("ws-plain", undefined, undefined, { gitMode: "worktree" });
  assert.equal(explicit.gitMode, "worktree");
  assert.throws(() => chatDraftWorktreeRequest(explicit), /base branch/u);

  updateChatDraft(remembered.chat.id, { workspaceId: "ws-plain" });
  assert.equal(getChatDraft(remembered.chat.id)?.gitMode, "checkout");
  assert.equal(getChatDraft(remembered.chat.id)?.worktree, undefined);
  updateChatDraft(remembered.chat.id, { title: "Renamed" });
  assert.equal(getChatDraft(remembered.chat.id)?.gitMode, "checkout");

  for (const draft of [plain, remembered, explicit]) discardChatDraft(draft.chat.id);
});

test("worktree choices are remembered per workspace and become the first-message request", (t) => {
  withLocalStorage(t);
  const draft = mountedDraft("ws-a");
  assert.throws(() => updateChatDraftWorktree(draft.chat.id, { fromOrigin: true }), /base branch/u);
  setChatDraftGitMode(draft.chat.id, "worktree");
  updateChatDraftWorktree(draft.chat.id, { baseRef: "develop", fromOrigin: true, branchName: "  aiden/custom " });

  assert.deepEqual(chatDraftWorktreeRequest(getChatDraft(draft.chat.id)!), {
    sourceWorkspaceId: "ws-a",
    baseRef: "develop",
    fromOrigin: true,
    branchName: "aiden/custom",
    idempotencyKey: draft.chat.id,
  });
  // The branch name is this draft's own; the mode and base carry to the next draft.
  assert.deepEqual(readChatDraftGitMemory("ws-a"), { gitMode: "worktree", baseRef: "develop", fromOrigin: true });
  const next = mountedDraft("ws-a");
  assert.deepEqual(next.worktree, { baseRef: "develop", fromOrigin: true });

  updateChatDraftWorktree(draft.chat.id, { branchName: "" });
  assert.equal(getChatDraft(draft.chat.id)?.worktree?.branchName, undefined, "blank goes back to Auto");
  setChatDraftGitMode(draft.chat.id, "checkout");
  assert.equal(chatDraftWorktreeRequest(getChatDraft(draft.chat.id)!), undefined);
  assert.deepEqual(getChatDraft(draft.chat.id)?.worktree, { baseRef: "develop", fromOrigin: true }, "settings survive the toggle");
  assert.equal(readChatDraftGitMemory("ws-a").gitMode, "checkout");

  for (const item of [draft, next]) discardChatDraft(item.chat.id);
});

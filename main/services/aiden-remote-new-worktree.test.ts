import assert from "node:assert/strict";
import { test } from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { createAidenRemoteNewWorktrees, phoneChatWorktreeKey } from "./aiden-remote-new-worktree.js";
import { FirstMessageWorktreeError, FirstMessageWorktreeSettingsChangedError } from "./first-message-worktree.js";
import { InsufficientDiskSpaceError } from "./managed-worktree-capacity.js";
import type { GitBranches, Workspace } from "./types.js";
import type { FirstMessageWorktreeRequest } from "../../renderer/shared/worktree-on-send.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";

const site: Workspace = {
  id: "site",
  name: "Site",
  folderPath: "/Users/sam/projects/site",
  permission: "ask",
  createdAt: 0,
  updatedAt: 0,
};

const repository: GitBranches = {
  isRepo: true,
  current: "feature/login",
  branches: ["feature/login", "main"],
  remoteBranches: ["origin/main"],
  defaultBranch: "main",
  hasRemote: true,
  uncommitted: 0,
};

const owner: WorkspaceOperationDocumentOwner = { isDestroyed: () => false, onInvalidated: () => () => undefined };

function harness(options: {
  workspace?: Workspace | undefined;
  branches?: GitBranches | Error;
  ensure?: (request: FirstMessageWorktreeRequest, seed: string) => Promise<{ workspaceId: string; branch: string }>;
  records?: Record<string, { state: "pending" | "failed" | "ready"; workspaceId: string }>;
} = {}) {
  const requests: Array<{ request: FirstMessageWorktreeRequest; seed: string }> = [];
  const owners: string[] = [];
  const service = createAidenRemoteNewWorktrees({
    getWorkspace: async () => ("workspace" in options ? options.workspace : site),
    branches: async () => {
      const branches = options.branches ?? repository;
      if (branches instanceof Error) throw branches;
      return branches;
    },
    ensure: async (request, seed) => {
      requests.push({ request, seed });
      const made = await (options.ensure ?? (async () => ({ workspaceId: "site-worktree", branch: "aiden/fix-the-login-bug" })))(request, seed);
      return {
        ...made,
        baseRef: request.baseRef,
        startPoint: request.baseRef,
        baseCommit: "abc123",
        baseSource: "local" as const,
        reused: false,
      };
    },
    owner: (deviceId) => {
      owners.push(deviceId);
      return owner;
    },
    record: async (key) => {
      const entry = options.records?.[key];
      return entry && {
        key,
        sourceWorkspaceId: "site",
        ...entry,
        baseRef: "main",
        fromOrigin: true,
        branch: "aiden/fix",
        ownershipToken: "token",
        baseCommit: "abc123",
        startPoint: "main",
        baseSource: "local" as const,
        updatedAt: 0,
      };
    },
  });
  return { service, requests, owners };
}

const refusedWith = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof AidenRemoteServiceError &&
  error.code === code &&
  (!pattern || pattern.test(error.message)) &&
  !error.message.includes("/Users/");

test("a phone's worktree starts where a desktop draft's would, named from the message, one per chat", async () => {
  const { service, requests, owners } = harness();
  assert.deepEqual(await service.create("phone-1", "site", "Fix the login bug", "chat-1"), {
    workspaceId: "site-worktree",
    branch: "aiden/fix-the-login-bug",
  });
  assert.deepEqual(requests, [
    {
      // The default branch from its remote, not the branch the checkout is on.
      request: { sourceWorkspaceId: "site", baseRef: "main", fromOrigin: true, idempotencyKey: phoneChatWorktreeKey("chat-1") },
      seed: "Fix the login bug",
    },
  ]);
  assert.deepEqual(owners, ["phone-1"]);
  assert.notEqual(phoneChatWorktreeKey("chat-1"), phoneChatWorktreeKey("chat-2"));

  const local = harness({ branches: { ...repository, remoteBranches: [], hasRemote: false, defaultBranch: undefined } });
  await local.service.create("phone-1", "site", "Fix", "chat-1");
  assert.deepEqual(
    [local.requests[0]!.request.baseRef, local.requests[0]!.request.fromOrigin],
    ["feature/login", false],
    "without a remote: the current branch, nothing fetched",
  );
});

test("a workspace that can't have a worktree is refused before anything is made", async () => {
  const cases: Array<[string, Parameters<typeof harness>[0], string, RegExp]> = [
    ["no folder", { workspace: { ...site, folderPath: undefined } }, "workspace_unavailable", /no folder/u],
    ["scratch", { workspace: { ...site, scratch: true } }, "workspace_unavailable", /no folder/u],
    ["no access", { workspace: { ...site, permission: "none" } }, "workspace_unavailable", /no folder access/u],
    ["gone", { workspace: undefined }, "workspace_unavailable", /no folder/u],
    [
      "already a worktree",
      {
        workspace: {
          ...site,
          managedWorktree: { repositoryPath: "/r", worktreePath: "/w", branch: "aiden/x", createdFromHead: "abc" },
        },
      },
      "git_capability_denied",
      /already in a worktree/u,
    ],
    ["not a repository", { branches: { ...repository, isRepo: false } }, "git_capability_denied", /isn't a Git repository/u],
    ["no commits", { branches: { ...repository, unborn: true } }, "git_capability_denied", /no commits yet/u],
    ["unreadable", { branches: new Error("fatal: /Users/sam/projects/site: not a git repository") }, "git_capability_denied", /branches/u],
  ];
  for (const [name, options, code, pattern] of cases) {
    const { service, requests } = harness(options);
    await assert.rejects(service.create("phone-1", "site", "Fix", "chat-1"), refusedWith(code, pattern), name);
    assert.equal(requests.length, 0, name);
  }
});

test("a chat's finished setup is only the worktree New worktree made for that chat", async () => {
  const managedWorktree = {
    repositoryPath: "/r",
    worktreePath: "/w",
    branch: "aiden/fix",
    createdFromHead: "abc",
    ownershipToken: "token",
  };
  const inWorktree = { workspace: { ...site, id: "site-worktree", managedWorktree } };
  const made = { [phoneChatWorktreeKey("chat-1")]: { state: "ready" as const, workspaceId: "site-worktree" } };
  assert.equal(await harness({ ...inWorktree, records: made }).service.worktreeBranch("chat-1", "site-worktree"), "aiden/fix");
  assert.equal(
    await harness({ ...inWorktree, records: made }).service.worktreeBranch("chat-2", "site-worktree"),
    undefined,
    "another chat's worktree",
  );
  assert.equal(await harness(inWorktree).service.worktreeBranch("chat-1", "site-worktree"), undefined, "a worktree this chat never made");
  assert.equal(
    await harness({ ...inWorktree, records: { [phoneChatWorktreeKey("chat-1")]: { state: "pending", workspaceId: "site-worktree" } } })
      .service.worktreeBranch("chat-1", "site-worktree"),
    "aiden/fix",
    "saved, though its last ledger write failed",
  );
  assert.equal(
    await harness({
      workspace: { ...site, id: "site-worktree", managedWorktree: { ...managedWorktree, ownershipToken: "another" } },
      records: { [phoneChatWorktreeKey("chat-1")]: { state: "pending", workspaceId: "site-worktree" } },
    }).service.worktreeBranch("chat-1", "site-worktree"),
    undefined,
    "a worktree at that id that this attempt did not save",
  );
  assert.equal(
    await harness({ ...inWorktree, records: { [phoneChatWorktreeKey("chat-1")]: { state: "failed", workspaceId: "site-worktree" } } })
      .service.worktreeBranch("chat-1", "site-worktree"),
    undefined,
    "a failed attempt",
  );
  assert.equal(
    await harness({ records: made }).service.worktreeBranch("chat-1", "site"),
    undefined,
    "the chat is no longer in the worktree made for it",
  );
});

test("Git failures reach the phone as fixed sentences, never Git's own words", async () => {
  const fail = (error: Error) => harness({ ensure: async () => Promise.reject(error) }).service.create("phone-1", "site", "Fix", "chat-1");
  await assert.rejects(
    fail(new FirstMessageWorktreeError("fatal: unable to access 'https://sam:token@github.com/x': /Users/sam", "fetching")),
    refusedWith("git_capability_denied", /couldn't fetch main from its remote/u),
  );
  await assert.rejects(
    fail(new FirstMessageWorktreeError("disk", "creating", new InsufficientDiskSpaceError({ availableBytes: 1, requiredBytes: 2, reserveBytes: 1, estimatedBytes: 1 }))),
    refusedWith("git_capability_denied", /free disk space/u),
  );
  await assert.rejects(
    fail(new FirstMessageWorktreeError("fatal: '/Users/sam/.aiden/worktrees/site-1' already exists", "creating")),
    refusedWith("git_capability_denied", /couldn't make the worktree/u),
  );
});

test("when the default branch moved since an earlier attempt, the chat's existing worktree is used", async () => {
  const { service, requests } = harness({
    ensure: async (request) => {
      if (request.baseRef === "main") {
        throw new FirstMessageWorktreeSettingsChangedError({
          workspaceId: "site-worktree",
          branch: "aiden/fix",
          baseRef: "develop",
          startPoint: "origin/develop",
          fromOrigin: true,
        });
      }
      return { workspaceId: "site-worktree", branch: "aiden/fix" };
    },
  });
  assert.deepEqual(await service.create("phone-1", "site", "Fix", "chat-1"), { workspaceId: "site-worktree", branch: "aiden/fix" });
  assert.deepEqual(
    requests.map(({ request }) => [request.baseRef, request.idempotencyKey]),
    [["main", "phone-chat:chat-1"], ["develop", "phone-chat:chat-1"]],
  );
});

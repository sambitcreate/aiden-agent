import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Workspace } from "./types.js";
import {
  assertWorkspaceFolderPresent,
  displayWorkspaceFolder,
  missingWorktreeOptions,
  restoreNoWorkspaceFolder,
  workspaceFolderMissing,
  workspaceFolderPresence,
  workspaceFolderRemoteRefusal,
} from "./workspace-folder-presence.js";

const root = await mkdtemp(path.join(tmpdir(), "aiden-folder-presence-"));
after(() => rm(root, { recursive: true, force: true }));

test("a folder that is on disk is present, and a moved one is missing", async () => {
  const folder = path.join(root, "project");
  await mkdir(folder);
  assert.equal(await workspaceFolderPresence(folder), "present");
  await rename(folder, path.join(root, "project-moved"));
  assert.equal(await workspaceFolderPresence(folder), "missing");
});

test("a file where the folder used to be counts as missing", async () => {
  const file = path.join(root, "now-a-file");
  await writeFile(file, "not a folder");
  assert.equal(await workspaceFolderPresence(file), "missing");
  assert.equal(await workspaceFolderPresence(path.join(file, "child")), "missing");
});

test("a check that cannot answer is not reported as missing", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  assert.equal(await workspaceFolderPresence("/anywhere", () => Promise.reject(denied)), "unknown");
  assert.equal(
    await workspaceFolderMissing({ name: "Locked", folderPath: "/anywhere", permission: "ask" }, () => Promise.reject(denied)),
    false,
  );
});

test("starting in a missing folder is refused with the workspace and folder named", async () => {
  const gone = path.join(root, "deleted-project");
  await assert.rejects(
    assertWorkspaceFolderPresent({ name: "Website", folderPath: gone, permission: "ask" }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "workspace_folder_missing");
      assert.equal(
        error.message,
        `The folder for “Website” is missing: ${gone}. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, or start the chat in another workspace.`,
      );
      return true;
    },
  );
});

test("only workspaces whose chats use their folder are checked", async () => {
  const gone = path.join(root, "never-there");
  assert.equal(await workspaceFolderMissing({ name: "Website", folderPath: gone, permission: "ask" }), true);
  // No folder, No Access (the folder is never touched) and a No workspace
  // chat's hidden folder (made again when the chat runs) are left alone.
  assert.equal(await workspaceFolderMissing({ name: "No folder", folderPath: undefined, permission: "ask" }), false);
  assert.equal(await workspaceFolderMissing({ name: "Website", folderPath: gone, permission: "none" }), false);
  assert.equal(
    await workspaceFolderMissing({ name: "No workspace", folderPath: gone, permission: "ask", noWorkspace: true }),
    false,
  );
});

test("a deleted Aiden-managed worktree is checked at its checkout root and named as a worktree", async () => {
  const checkout = path.join(root, "worktrees", "fix");
  const managed = {
    name: "Website · aiden/fix",
    // The workspace can point inside the checkout.
    folderPath: path.join(checkout, "packages", "site"),
    permission: "ask" as const,
    managedWorktree: { repositoryPath: root, worktreePath: checkout, branch: "aiden/fix", createdFromHead: "abc123" },
  };
  await mkdir(path.join(checkout, "packages"), { recursive: true });
  // The nested folder alone is gone: the checkout is still there, so this is not a deleted worktree.
  assert.equal(await workspaceFolderMissing(managed), false);
  await rm(checkout, { recursive: true, force: true });
  assert.equal(await workspaceFolderMissing(managed), true);
  await assert.rejects(assertWorkspaceFolderPresent(managed), (error: Error) => {
    assert.equal(error.message, "The worktree folder for “Website · aiden/fix” is missing. Restore it, or start the chat in another workspace.");
    assert.ok(!error.message.includes(root), "Aiden picked the worktree's folder, so its path is left out");
    return true;
  });
  const refusal = await workspaceFolderRemoteRefusal(managed);
  assert.match(refusal ?? "", /worktree folder was deleted on your Mac/u);
  assert.ok(!refusal?.includes(root), "a paired device never hears a path");
  assert.equal(await workspaceFolderRemoteRefusal({ name: "Here", folderPath: root, permission: "ask" }), undefined);
});

test("the home folder is shown as ~ and other paths are left alone", () => {
  assert.equal(displayWorkspaceFolder("/Users/sam/projects/site", "/Users/sam"), "~/projects/site");
  assert.equal(displayWorkspaceFolder("/Users/samantha/site", "/Users/sam"), "/Users/samantha/site");
  assert.equal(displayWorkspaceFolder("/opt/site", "/Users/sam"), "/opt/site");
});

test("a deleted worktree offers Restore only while its branch is free, and a new chat in its main checkout", async () => {
  const repo = "/repos/site";
  const checkout = "/data/worktrees/fix";
  const worktreeWorkspace = {
    folderPath: `${checkout}/packages/web`,
    permission: "ask" as const,
    managedWorktree: {
      repositoryPath: repo, worktreePath: checkout, branch: "aiden/fix", createdFromHead: "abc123",
      worktreeGitDir: `${repo}/.git/worktrees/fix`, ownershipToken: "token",
    },
  };
  const workspace = (id: string, folderPath: string, extra: Partial<Workspace> = {}): Workspace =>
    ({ id, name: id, folderPath, permission: "ask", createdAt: 0, updatedAt: 0, ...extra }) as Workspace;
  const all = [
    workspace("root", repo),
    workspace("web", `${repo}/packages/web`),
    workspace("other-worktree", `${repo}/packages/web`, { managedWorktree: { ...worktreeWorkspace.managedWorktree, branch: "aiden/other" } }),
  ];
  const git = (
    head: string | undefined,
    worktrees: Array<{ path: string; branch?: string }> = [],
    extra: { deletionPending?: boolean; parentExists?: boolean } = {},
  ) => ({
    branchHead: async () => head,
    worktrees: async () => worktrees,
    deletionPending: async () => extra.deletionPending ?? false,
    folderExists: async (folder: string) => {
      assert.equal(folder, "/data/worktrees", "Restore needs the folder the checkout lived in");
      return extra.parentExists ?? true;
    },
  });

  // Its own stale record does not count as taking the branch; the nested main workspace is preferred.
  assert.deepEqual(
    await missingWorktreeOptions(worktreeWorkspace, all, git("def456", [{ path: repo, branch: "main" }, { path: checkout, branch: "aiden/fix" }])),
    { branch: "aiden/fix", restorable: true, mainWorkspaceId: "web", mainWorkspaceName: "web" },
  );
  assert.equal((await missingWorktreeOptions(worktreeWorkspace, all, git(undefined)))?.restorable, false, "the branch is gone");
  assert.equal(
    (await missingWorktreeOptions(worktreeWorkspace, all, git("def456", [{ path: "/elsewhere", branch: "aiden/fix" }])))?.restorable,
    false,
    "another worktree has the branch",
  );
  assert.equal(
    (await missingWorktreeOptions(worktreeWorkspace, all, git("def456", [], { deletionPending: true })))?.restorable,
    false,
    "Aiden was removing it: its files may be waiting in quarantine",
  );
  assert.equal(
    (await missingWorktreeOptions(worktreeWorkspace, all, git("def456", [], { parentExists: false })))?.restorable,
    false,
    "the folder it lived in is gone too",
  );
  assert.equal(
    (await missingWorktreeOptions({ ...worktreeWorkspace, permission: "none" }, all, git("def456")))?.restorable,
    false,
    "No Access never touches the folder",
  );
  const legacy = { ...worktreeWorkspace, managedWorktree: { ...worktreeWorkspace.managedWorktree, ownershipToken: undefined } };
  assert.equal((await missingWorktreeOptions(legacy, all, git("def456")))?.restorable, false, "no ownership marker to check");
  const failing = {
    ...git("def456"),
    branchHead: async () => Promise.reject(new Error("not a repository")),
  };
  assert.equal((await missingWorktreeOptions(worktreeWorkspace, all, failing))?.restorable, false, "a Git error only takes Restore away");
  // Without a nested match, the repository root's workspace; No Access and scratch workspaces never count.
  assert.equal((await missingWorktreeOptions(worktreeWorkspace, [all[0]!], git("def456")))?.mainWorkspaceId, "root");
  const blocked = await missingWorktreeOptions(worktreeWorkspace, [workspace("locked", repo, { permission: "none" })], git("def456"));
  assert.equal(blocked?.mainWorkspaceId, undefined);
  assert.equal(await missingWorktreeOptions({ folderPath: repo, permission: "ask" }, all, git("def456")), undefined, "not a worktree");
});

test("the main checkout is found when its workspace was added through a symlink", async () => {
  const repo = path.join(root, "real-repo");
  await mkdir(repo);
  const link = path.join(root, "linked-repo");
  await symlink(repo, link);
  const options = await missingWorktreeOptions(
    {
      folderPath: path.join(root, "gone-worktree"),
      permission: "ask",
      managedWorktree: {
        repositoryPath: repo, worktreePath: path.join(root, "gone-worktree"), branch: "aiden/x", createdFromHead: "abc",
      },
    },
    [{ id: "linked", name: "Site", folderPath: link, permission: "ask", createdAt: 0, updatedAt: 0 } as Workspace],
    {
      branchHead: async () => "abc",
      worktrees: async () => [],
      deletionPending: async () => false,
      folderExists: async () => true,
    },
  );
  assert.equal(options?.mainWorkspaceId, "linked");
});

test("a No workspace chat's missing folder is made again; a project folder never is", async () => {
  const chatFolder = path.join(root, "chat-folders", "kind-fern-hike");
  await restoreNoWorkspaceFolder({ folderPath: chatFolder, noWorkspace: true });
  assert.equal(await workspaceFolderPresence(chatFolder), "present");

  const project = path.join(root, "gone-project");
  await restoreNoWorkspaceFolder({ folderPath: project });
  assert.equal(await workspaceFolderPresence(project), "missing");
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Workspace } from "./types.js";
import {
  assertWorkspaceFolderPresent,
  displayWorkspaceFolder,
  missingWorktreeOptions,
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
  // No folder, and No Access (the folder is never touched), are left alone.
  assert.equal(await workspaceFolderMissing({ name: "No folder", folderPath: undefined, permission: "ask" }), false);
  assert.equal(await workspaceFolderMissing({ name: "Website", folderPath: gone, permission: "none" }), false);
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
    assert.equal(error.message, `The worktree folder for “Website · aiden/fix” is missing: ${checkout}. Restore it, or start the chat in another workspace.`);
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
    managedWorktree: { repositoryPath: repo, worktreePath: checkout, branch: "aiden/fix", createdFromHead: "abc123" },
  };
  const workspace = (id: string, folderPath: string, extra: Partial<Workspace> = {}): Workspace =>
    ({ id, name: id, folderPath, permission: "ask", createdAt: 0, updatedAt: 0, ...extra }) as Workspace;
  const all = [
    workspace("root", repo),
    workspace("web", `${repo}/packages/web`),
    workspace("other-worktree", `${repo}/packages/web`, { managedWorktree: { ...worktreeWorkspace.managedWorktree, branch: "aiden/other" } }),
  ];
  const git = (head: string | undefined, worktrees: Array<{ path: string; branch?: string }> = []) => ({
    branchHead: async () => head,
    worktrees: async () => worktrees,
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
  const failing = { branchHead: async () => Promise.reject(new Error("not a repository")), worktrees: async () => [] };
  assert.equal((await missingWorktreeOptions(worktreeWorkspace, all, failing))?.restorable, false, "a Git error only takes Restore away");
  // Without a nested match, the repository root's workspace; No Access and scratch workspaces never count.
  assert.equal((await missingWorktreeOptions(worktreeWorkspace, [all[0]!], git("def456")))?.mainWorkspaceId, "root");
  const blocked = await missingWorktreeOptions(worktreeWorkspace, [workspace("locked", repo, { permission: "none" })], git("def456"));
  assert.equal(blocked?.mainWorkspaceId, undefined);
  assert.equal(await missingWorktreeOptions({ folderPath: repo }, all, git("def456")), undefined, "not a worktree");
});

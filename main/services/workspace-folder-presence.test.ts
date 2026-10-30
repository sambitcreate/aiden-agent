import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  assertWorkspaceFolderPresent,
  displayWorkspaceFolder,
  restoreNoWorkspaceFolder,
  workspaceFolderMissing,
  workspaceFolderPresence,
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
  // No folder, No Access (the folder is never touched), an Aiden-managed
  // worktree (it has its own restore flow) and a No workspace chat's hidden
  // folder (made again when the chat runs) are left alone.
  assert.equal(await workspaceFolderMissing({ name: "No folder", folderPath: undefined, permission: "ask" }), false);
  assert.equal(await workspaceFolderMissing({ name: "Website", folderPath: gone, permission: "none" }), false);
  assert.equal(
    await workspaceFolderMissing({ name: "No workspace", folderPath: gone, permission: "ask", noWorkspace: true }),
    false,
  );
  assert.equal(
    await workspaceFolderMissing({
      name: "Website",
      folderPath: gone,
      permission: "ask",
      managedWorktree: { repositoryPath: root, worktreePath: gone, branch: "aiden/fix", createdFromHead: "abc123" },
    }),
    false,
  );
});

test("the home folder is shown as ~ and other paths are left alone", () => {
  assert.equal(displayWorkspaceFolder("/Users/sam/projects/site", "/Users/sam"), "~/projects/site");
  assert.equal(displayWorkspaceFolder("/Users/samantha/site", "/Users/sam"), "/Users/samantha/site");
  assert.equal(displayWorkspaceFolder("/opt/site", "/Users/sam"), "/opt/site");
});

test("a No workspace chat's missing folder is made again; a project folder never is", async () => {
  const chatFolder = path.join(root, "chat-folders", "kind-fern-hike");
  await restoreNoWorkspaceFolder({ folderPath: chatFolder, noWorkspace: true });
  assert.equal(await workspaceFolderPresence(chatFolder), "present");

  const project = path.join(root, "gone-project");
  await restoreNoWorkspaceFolder({ folderPath: project });
  assert.equal(await workspaceFolderPresence(project), "missing");
});

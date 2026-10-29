import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  assertWorkspaceFolderPresent,
  displayWorkspaceFolder,
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
  await assertWorkspaceFolderPresent({ name: "Locked", folderPath: "/anywhere" }, () => Promise.reject(denied));
});

test("starting in a missing folder is refused with the workspace and folder named", async () => {
  const gone = path.join(root, "deleted-project");
  await assert.rejects(
    assertWorkspaceFolderPresent({ name: "Website", folderPath: gone }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "workspace_folder_missing");
      assert.match(error.message, /“Website”/u);
      assert.ok(error.message.includes(gone) || error.message.includes(displayWorkspaceFolder(gone)));
      assert.match(error.message, /moved, renamed or deleted/u);
      return true;
    },
  );
  // A workspace without a folder has nothing to check.
  await assertWorkspaceFolderPresent({ name: "No folder", folderPath: undefined });
});

test("the home folder is shown as ~ and other paths are left alone", () => {
  assert.equal(displayWorkspaceFolder("/Users/sam/projects/site", "/Users/sam"), "~/projects/site");
  assert.equal(displayWorkspaceFolder("/Users/samantha/site", "/Users/sam"), "/Users/samantha/site");
  assert.equal(displayWorkspaceFolder("/opt/site", "/Users/sam"), "/opt/site");
});

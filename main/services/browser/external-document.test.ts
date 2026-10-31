import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { resolveExternalWorkspaceDocument } from "./external-document";

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-external-doc-")));
after(() => rm(base, { recursive: true, force: true }));
const workspace = path.join(base, "prompt-lab");
await mkdir(path.join(workspace, "thermostat"), { recursive: true });
await writeFile(path.join(workspace, "thermostat", "index.html"), "<h1>hi</h1>");
await writeFile(path.join(workspace, "thermostat", "style.css"), "h1{}");
await writeFile(path.join(base, "outside.html"), "<h1>outside</h1>");
await symlink(path.join(base, "outside.html"), path.join(workspace, "escape.html"));
await mkdir(path.join(workspace, "folder.html"));
const linkedWorkspace = path.join(base, "linked-lab");
await symlink(workspace, linkedWorkspace);

test("workspace HTML resolves from relative and absolute links, including through a symlinked folder", async () => {
  const expected = path.join(workspace, "thermostat", "index.html");
  assert.equal(await resolveExternalWorkspaceDocument(workspace, "thermostat/index.html"), expected);
  assert.equal(await resolveExternalWorkspaceDocument(workspace, "./thermostat/../thermostat/index.html"), expected);
  assert.equal(await resolveExternalWorkspaceDocument(workspace, expected), expected);
  assert.equal(await resolveExternalWorkspaceDocument(linkedWorkspace, path.join(linkedWorkspace, "thermostat/index.html")), expected);
});

test("paths outside the workspace, symlink escapes, other types and folders are refused", async () => {
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, "../outside.html"), /inside this workspace/u);
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, path.join(base, "outside.html")), /inside this workspace/u);
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, "escape.html"), /inside this workspace/u);
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, "thermostat/style.css"), /HTML and PDF/u);
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, "folder.html"), /Only files/u);
  await assert.rejects(resolveExternalWorkspaceDocument(workspace, "missing.html"), /no longer exists/u);
});

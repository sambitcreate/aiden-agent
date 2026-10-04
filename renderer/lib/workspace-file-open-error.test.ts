import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readWorkspaceFile } from "../../main/services/workspace-files";
import { workspaceFileOpenErrorPresentation } from "./workspace-file-open-error";

async function workspace(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-open-error-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

/** The renderer sees main-process rejections through Electron's invoke wrapper. */
async function openErrorAsRendererSeesIt(root: string, relativePath: string): Promise<string> {
  try {
    await readWorkspaceFile(root, relativePath);
  } catch (error) {
    return `Error invoking remote method 'workspaces:readFile': Error: ${(error as Error).message}`;
  }
  assert.fail(`${relativePath} unexpectedly opened`);
}

test("files the text editor can never open hide Try again and explain what to do", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await fs.writeFile(path.join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await fs.writeFile(path.join(root, "huge.log"), Buffer.alloc(1_600_000, 0x61));
  await fs.writeFile(path.join(root, "long.csv"), "row\n".repeat(60_000));
  await fs.mkdir(path.join(root, "src"));

  for (const file of ["logo.png", "latin1.txt", "huge.log", "long.csv", "src"]) {
    const presentation = workspaceFileOpenErrorPresentation(await openErrorAsRendererSeesIt(root, file));
    assert.equal(presentation.retryable, false, file);
    assert.ok(presentation.guidance, `${file} should explain an alternative`);
  }
});

test("transient open failures keep Try again", async (t) => {
  const root = await workspace(t);
  const missing = workspaceFileOpenErrorPresentation(await openErrorAsRendererSeesIt(root, "deleted.ts"));
  assert.deepEqual(missing, { retryable: true, guidance: null });
  assert.deepEqual(workspaceFileOpenErrorPresentation("Aiden could not open this file."), {
    retryable: true,
    guidance: null,
  });
});

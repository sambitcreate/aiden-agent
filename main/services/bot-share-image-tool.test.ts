import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createShareImageTool } from "./share-image-tool.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);

test("Bot share_image is pinned to the exact managed home", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-share-image-"));
  const home = path.join(parent, "home");
  const outside = path.join(parent, "outside");
  try {
    await Promise.all([fs.mkdir(home), fs.mkdir(outside)]);
    await Promise.all([
      fs.writeFile(path.join(home, "inside.png"), PNG),
      fs.writeFile(path.join(outside, "outside.png"), PNG),
    ]);
    const identity = await fs.stat(home, { bigint: true });
    let shares = 0;
    const tool = createShareImageTool({
      workspaceRoot: home,
      expectedWorkspaceIdentity: {
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
      },
      scopeToWorkspace: true,
      share: () => { shares += 1; },
    });
    await tool.execute("inside", { path: "inside.png" });
    assert.equal(shares, 1);
    await assert.rejects(
      tool.execute("outside", { path: path.join(outside, "outside.png") }),
      /must come from this Bot's folder/u,
    );
    await fs.symlink(path.join(outside, "outside.png"), path.join(home, "linked.png"));
    await assert.rejects(
      tool.execute("linked", { path: "linked.png" }),
      /must come from this Bot's folder/u,
    );
    assert.equal(shares, 1);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("Bot share_image rejects a managed-home replacement", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-share-image-swap-"));
  const home = path.join(parent, "home");
  try {
    await fs.mkdir(home);
    const identity = await fs.stat(home, { bigint: true });
    const tool = createShareImageTool({
      workspaceRoot: home,
      expectedWorkspaceIdentity: {
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
      },
      scopeToWorkspace: true,
      share: () => assert.fail("replacement image must not be shared"),
    });
    await fs.rename(home, path.join(parent, "previous"));
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "replacement.png"), PNG);
    await assert.rejects(
      tool.execute("replacement", { path: "replacement.png" }),
      /authorized image folder changed/u,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

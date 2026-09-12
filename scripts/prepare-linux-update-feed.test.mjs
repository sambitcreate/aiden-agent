import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareLinuxUpdateFeed } from "./prepare-linux-update-feed.mjs";

test("Linux update feeds pin each architecture to its exact AppImage bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-linux-feed-"));
  try {
    for (const arch of ["x64", "arm64"]) {
      const asset = path.join(root, `Aiden-Agent-1.2.3-${arch === "x64" ? "x86_64" : arch}-linux.AppImage`);
      await writeFile(asset, `image-${arch}`);
      const feed = await prepareLinuxUpdateFeed(root, arch, "1.2.3");
      const contents = await readFile(feed, "utf8");
      assert.ok(contents.includes(createHash("sha512").update(`image-${arch}`).digest("base64")));
      assert.ok(contents.includes(path.basename(asset)));
      assert.ok(!contents.includes(".deb"));
      await prepareLinuxUpdateFeed(root, arch, "1.2.3", { verify: true });
      await writeFile(asset, "changed");
      await assert.rejects(prepareLinuxUpdateFeed(root, arch, "1.2.3", { verify: true }), /does not match/u);
    }
    await assert.rejects(prepareLinuxUpdateFeed(root, "x64", "1.2.3\nurl: evil"), /stable release/u);
    await assert.rejects(prepareLinuxUpdateFeed(root, "ia32", "1.2.3"), /architecture/u);
    await assert.rejects(prepareLinuxUpdateFeed(root, "arm64", "1.2.4"), /ENOENT/u);
    const linked = path.join(root, "Aiden-Agent-1.2.5-arm64-linux.AppImage");
    await symlink(path.join(root, "Aiden-Agent-1.2.3-arm64-linux.AppImage"), linked);
    await assert.rejects(prepareLinuxUpdateFeed(root, "arm64", "1.2.5"), /regular file/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

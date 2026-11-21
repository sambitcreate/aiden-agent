import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareLinuxUpdateFeed } from "./prepare-linux-update-feed.mjs";

test("Linux update feeds pin each architecture to its exact AppImage, DEB and RPM bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-linux-feed-"));
  const names = {
    x64: ["Aiden-Agent-1.2.3-x86_64-linux.AppImage", "Aiden-Agent-1.2.3-amd64-linux.deb", "Aiden-Agent-1.2.3-x86_64-linux.rpm"],
    arm64: ["Aiden-Agent-1.2.3-arm64-linux.AppImage", "Aiden-Agent-1.2.3-arm64-linux.deb", "Aiden-Agent-1.2.3-aarch64-linux.rpm"],
  };
  const digest = (text) => createHash("sha512").update(text).digest("base64");
  try {
    for (const arch of ["x64", "arm64"]) {
      for (const name of names[arch]) await writeFile(path.join(root, name), `${name}-bytes`);
      const feed = await prepareLinuxUpdateFeed(root, arch, "1.2.3");
      assert.equal(path.basename(feed), arch === "x64" ? "latest-linux.yml" : "latest-linux-arm64.yml");
      const contents = await readFile(feed, "utf8");
      const entries = [...contents.matchAll(/^ {2}- url: (\S+)\n {4}sha512: (\S+)\n {4}size: (\d+)$/gmu)]
        .map(([, url, sha512, size]) => ({ url, sha512, size: Number(size) }));
      // Every format an installation can update from, each with its own digest and size.
      assert.deepEqual(entries, names[arch].map((name) => ({
        url: name,
        sha512: digest(`${name}-bytes`),
        size: Buffer.byteLength(`${name}-bytes`),
      })));
      // Older AppImage builds read the legacy top-level fields.
      assert.match(contents, new RegExp(`^path: ${names[arch][0].replaceAll(".", "\\.")}$`, "mu"));
      assert.match(contents, new RegExp(`^sha512: ${digest(`${names[arch][0]}-bytes`).replace(/[+/]/gu, "\\$&")}$`, "mu"));
      await prepareLinuxUpdateFeed(root, arch, "1.2.3", { verify: true });
      for (const name of names[arch]) {
        const original = await readFile(path.join(root, name), "utf8");
        await writeFile(path.join(root, name), "changed");
        await assert.rejects(prepareLinuxUpdateFeed(root, arch, "1.2.3", { verify: true }), /does not match/u);
        await writeFile(path.join(root, name), original);
      }
    }
    await assert.rejects(prepareLinuxUpdateFeed(root, "x64", "1.2.3\nurl: evil"), /stable release/u);
    await assert.rejects(prepareLinuxUpdateFeed(root, "ia32", "1.2.3"), /architecture/u);
    await assert.rejects(prepareLinuxUpdateFeed(root, "arm64", "1.2.4"), /ENOENT/u);
    await rm(path.join(root, "Aiden-Agent-1.2.3-amd64-linux.deb"));
    await assert.rejects(prepareLinuxUpdateFeed(root, "x64", "1.2.3"), /ENOENT/u);
    for (const name of names.arm64) {
      await symlink(path.join(root, name), path.join(root, name.replace("1.2.3", "1.2.5")));
    }
    await assert.rejects(prepareLinuxUpdateFeed(root, "arm64", "1.2.5"), /regular file/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

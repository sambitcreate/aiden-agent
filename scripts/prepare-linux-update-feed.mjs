/* global process */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareLinuxUpdateFeed(directory, arch, version, { verify = false } = {}) {
  if (!["x64", "arm64"].includes(arch) || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("Expected a supported Linux architecture and stable release version.");
  }
  const root = await realpath(directory);
  const name = `Aiden-Agent-${version}-${arch === "x64" ? "x86_64" : "arm64"}-linux.AppImage`;
  const asset = path.join(root, name);
  const info = await lstat(asset);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || await realpath(asset) !== asset) {
    throw new Error("Linux update asset must be a nonempty regular file.");
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(asset)) hash.update(chunk);
  const digest = hash.digest("base64");
  // Generate a minimal fixed-origin feed containing only the verified AppImage.
  // DEB/RPM installation remains owned by the distribution package manager.
  const contents = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${info.size}\npath: ${name}\nsha512: ${digest}\n`;
  const feed = path.join(root, arch === "x64" ? "latest-linux.yml" : "latest-linux-arm64.yml");
  try {
    const feedInfo = await lstat(feed);
    if (!feedInfo.isFile() || feedInfo.isSymbolicLink()) throw new Error("Linux update feed must be a regular file.");
  } catch (error) { if (error.code !== "ENOENT" || verify) throw error; }
  if (verify) {
    if (await readFile(feed, "utf8") !== contents) throw new Error("Linux update feed does not match its release asset.");
  } else await writeFile(feed, contents);
  return feed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, arch, version, mode] = process.argv.slice(2);
  if (!directory || !arch || !version || (mode !== undefined && mode !== "--verify")) {
    throw new Error("Usage: prepare-linux-update-feed.mjs <directory> <x64|arm64> <version> [--verify]");
  }
  await prepareLinuxUpdateFeed(directory, arch, version, { verify: mode === "--verify" });
}

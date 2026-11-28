/* global process */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Release asset names per format; each architecture keeps its own feed. */
export function linuxUpdateAssetNames(arch, version) {
  const x64 = arch === "x64";
  return [
    `Aiden-Agent-${version}-${x64 ? "x86_64" : "arm64"}-linux.AppImage`,
    `Aiden-Agent-${version}-${x64 ? "amd64" : "arm64"}-linux.deb`,
    `Aiden-Agent-${version}-${x64 ? "x86_64" : "aarch64"}-linux.rpm`,
  ];
}

async function describeAsset(root, name) {
  const asset = path.join(root, name);
  const info = await lstat(asset);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size === 0 ||
    (await realpath(asset)) !== asset
  ) {
    throw new Error("Linux update asset must be a nonempty regular file.");
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(asset)) hash.update(chunk);
  return { name, sha512: hash.digest("base64"), size: info.size };
}

export async function prepareLinuxUpdateFeed(directory, arch, version, { verify = false } = {}) {
  if (!["x64", "arm64"].includes(arch) || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("Expected a supported Linux architecture and stable release version.");
  }
  const root = await realpath(directory);
  const assets = [];
  for (const name of linuxUpdateAssetNames(arch, version))
    assets.push(await describeAsset(root, name));
  // A minimal fixed-origin feed with the verified AppImage, DEB and RPM.
  // Each installed format downloads only its own file (electron-updater picks
  // by extension); the AppImage stays first and in the legacy path/sha512
  // fields so older AppImage builds keep updating.
  const [appImage] = assets;
  const files = assets
    .map(({ name, sha512, size }) => `  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\n`)
    .join("");
  const contents = `version: ${version}\nfiles:\n${files}path: ${appImage.name}\nsha512: ${appImage.sha512}\n`;
  const feed = path.join(root, arch === "x64" ? "latest-linux.yml" : "latest-linux-arm64.yml");
  try {
    const feedInfo = await lstat(feed);
    if (!feedInfo.isFile() || feedInfo.isSymbolicLink())
      throw new Error("Linux update feed must be a regular file.");
  } catch (error) {
    if (error.code !== "ENOENT" || verify) throw error;
  }
  if (verify) {
    if ((await readFile(feed, "utf8")) !== contents)
      throw new Error("Linux update feed does not match its release asset.");
  } else await writeFile(feed, contents);
  return feed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, arch, version, mode] = process.argv.slice(2);
  if (!directory || !arch || !version || (mode !== undefined && mode !== "--verify")) {
    throw new Error(
      "Usage: prepare-linux-update-feed.mjs <directory> <x64|arm64> <version> [--verify]",
    );
  }
  await prepareLinuxUpdateFeed(directory, arch, version, { verify: mode === "--verify" });
}

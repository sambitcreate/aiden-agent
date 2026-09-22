/* global Buffer */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_SOURCE_FINGERPRINT_VERSION = 1;
export const PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH =
  "build/package-source-fingerprint.json";

const NON_PACKAGE_PREFIXES = ["docs/", ".memory/", ".papercuts/"];

export function isPackageSourceFingerprintPathExcluded(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return NON_PACKAGE_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

async function gitOutput(repositoryRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(stdout);
}

export async function packageSourceFingerprint(repositoryRoot) {
  const [headOutput, fileOutput] = await Promise.all([
    gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
    gitOutput(repositoryRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const head = headOutput.toString("utf8").trim();
  const relativePaths = fileOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !isPackageSourceFingerprintPathExcluded(relativePath))
    .sort();
  const hash = createHash("sha256");
  hash.update(`version\0${PACKAGE_SOURCE_FINGERPRINT_VERSION}\0head\0${head}\0`);
  for (const relativePath of relativePaths) {
    const target = path.join(repositoryRoot, relativePath);
    hash.update(`path\0${relativePath}\0`);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${await fs.readlink(target)}\0`);
      } else if (stat.isFile()) {
        hash.update(`file\0${stat.mode & 0o111}\0`);
        hash.update(await fs.readFile(target));
        hash.update("\0");
      } else {
        hash.update("unsupported\0");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("deleted\0");
    }
  }
  return {
    version: PACKAGE_SOURCE_FINGERPRINT_VERSION,
    head,
    sha256: hash.digest("hex"),
  };
}

export function assertMatchingPackageSourceFingerprint(expected, actual, source = "Packaged app") {
  for (const field of ["version", "head", "sha256"]) {
    if (expected?.[field] !== actual?.[field]) {
      throw new Error(`${source} source fingerprint ${field} does not match the working tree.`);
    }
  }
}

export async function writePackageSourceFingerprint(repositoryRoot) {
  const fingerprint = await packageSourceFingerprint(repositoryRoot);
  const target = path.join(repositoryRoot, PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
  return { fingerprint, target };
}

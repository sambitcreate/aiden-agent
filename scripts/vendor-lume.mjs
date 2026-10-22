/* global AbortController, clearTimeout, console, fetch, process, setTimeout */

// Vendors the pinned, upstream-signed Lume 0.6.1 bundle into
// build/bot-computers/lume.app for packaging (npm run bot-computers:vendor).
// Lume keeps its own Developer ID signature: it carries the virtualization
// entitlement and a provisioning profile for vm.networking, which re-signing
// would drop. Nothing here runs at app runtime.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  LUME_APP_TREE,
  LUME_ARCHIVE_MEMBERS,
  LUME_ARTIFACT_PROVENANCE,
  LUME_PRIVACY_ENVIRONMENT,
  assertLumeArtifactProvenance,
  lumeRequirement,
} from "./bot-computers-lume-pins.mjs";
import { runBoundedCommand } from "./vendor-cua-driver.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const artifactPath = path.join(repositoryRoot, "resources", "bot-computers", "lume-artifact.json");
export const VENDORED_LUME_APP = path.join(repositoryRoot, "build", "bot-computers", "lume.app");
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * The environment for every Lume run during packaging: telemetry and update
 * checks off and an empty private HOME, so `lume --version` cannot register an
 * installation or read the developer's ~/.lume.
 */
export function lumeVendorEnvironment(home) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    LUME_LOG_LEVEL: "error",
    ...LUME_PRIVACY_ENVIRONMENT,
  };
}

const run = (command, args, options = {}) =>
  runBoundedCommand(command, args, { env: lumeVendorEnvironment(os.tmpdir()), ...options });

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function validateArtifact(artifact) {
  return assertLumeArtifactProvenance(artifact);
}

/** Refuse unsafe names, then require exactly the pinned listing. */
export function assertLumeArchiveListing(listing) {
  const names = listing.split(/\r?\n/).filter((name) => name.length > 0);
  for (const name of names) {
    const segments = name.split("/");
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      segments.some((segment) => segment === ".." || segment === ".")
    ) {
      throw new Error(`Refusing unsafe path in the pinned Lume archive: ${JSON.stringify(name)}`);
    }
  }
  const actual = [...names].sort();
  const expected = [...LUME_ARCHIVE_MEMBERS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `The Lume archive listing differs from the pinned release (${names.length} entries, expected ${expected.length}).`,
    );
  }
  return names;
}

async function collectTree(root, directory = root, entries = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    const type = info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "other";
    entries.push(`${type}:${path.relative(root, absolutePath)}`);
    if (type === "directory") await collectTree(root, absolutePath, entries);
  }
  return entries;
}

/** The bundle must be a real directory whose tree is exactly the pinned one. */
export async function assertExactLumeAppTree(appPath) {
  const info = await lstat(appPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular, non-symlinked lume.app directory: ${appPath}`);
  }
  const actual = (await collectTree(appPath)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...LUME_APP_TREE])) {
    throw new Error(`The lume.app tree differs from the pinned release: ${actual.join(", ")}`);
  }
}

/** List the archive, then extract only lume.app/ into an empty directory. */
export async function extractLumeApp(archive, directory, runner = run) {
  assertLumeArchiveListing(await runner("/usr/bin/tar", ["-tzf", archive]));
  if ((await readdir(directory)).length !== 0) {
    throw new Error("Lume must be extracted into an empty staging directory.");
  }
  await runner("/usr/bin/tar", ["-xzf", archive, "-C", directory, LUME_ARTIFACT_PROVENANCE.appBundle]);
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== LUME_ARTIFACT_PROVENANCE.appBundle) {
    throw new Error("Extracting Lume produced unexpected staging entries.");
  }
  const extracted = path.join(directory, LUME_ARTIFACT_PROVENANCE.appBundle);
  await assertExactLumeAppTree(extracted);
  const resolvedDirectory = await realpath(directory);
  if ((await realpath(extracted)) !== path.join(resolvedDirectory, LUME_ARTIFACT_PROVENANCE.appBundle)) {
    throw new Error("The extracted lume.app escaped its private staging directory.");
  }
  return extracted;
}

/**
 * Hash and size first (nothing is executed for a wrong binary), then the
 * bundle metadata, then the pinned upstream signature over the whole bundle,
 * then `lume --version` with telemetry off and a throwaway HOME.
 */
export async function validateVendoredLume(appPath, runner = run, hashBinary = hashFile) {
  try {
    await assertExactLumeAppTree(appPath);
    const resolvedApp = await realpath(appPath);
    const binary = path.join(appPath, "Contents", "MacOS", "lume");
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) return false;
    if ((await realpath(binary)) !== path.join(resolvedApp, "Contents", "MacOS", "lume")) return false;
    if (binaryInfo.size !== LUME_ARTIFACT_PROVENANCE.binaryBytes) return false;
    if ((await hashBinary(binary)) !== LUME_ARTIFACT_PROVENANCE.binarySha256) return false;
    const profile = await lstat(path.join(appPath, "Contents", "embedded.provisionprofile"));
    if (!profile.isFile() || profile.isSymbolicLink() || profile.size === 0) return false;
    const infoPlist = path.join(appPath, "Contents", "Info.plist");
    const plistValue = async (key) =>
      (await runner("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist])).trim();
    if ((await plistValue("CFBundleIdentifier")) !== LUME_ARTIFACT_PROVENANCE.bundleIdentifier) return false;
    if ((await plistValue("CFBundleVersion")) !== LUME_ARTIFACT_PROVENANCE.bundleVersion) return false;
    await runner("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--deep",
      "--verbose=2",
      `-R=${lumeRequirement()}`,
      appPath,
    ]);
    const home = await mkdtemp(path.join(os.tmpdir(), "aiden-lume-vendor-home-"));
    try {
      const version = await runner(binary, ["--version"], { env: lumeVendorEnvironment(home) });
      return version.trim() === LUME_ARTIFACT_PROVENANCE.version;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

export async function downloadLumeArchive(
  archive,
  { fetchImpl = fetch, maxBytes = LUME_ARTIFACT_PROVENANCE.maxArchiveBytes, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GitHub release assets redirect to their object store; the pinned
    // SHA-256 below is the authority for whatever arrives.
    const response = await fetchImpl(LUME_ARTIFACT_PROVENANCE.url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error(`The pinned Lume download exceeds ${maxBytes} bytes.`);
    }
    let downloadedBytes = 0;
    const bound = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        callback(
          downloadedBytes > maxBytes ? new Error(`The pinned Lume download exceeds ${maxBytes} bytes.`) : undefined,
          chunk,
        );
      },
    });
    await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
  } finally {
    clearTimeout(timeout);
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Stage, validate, swap into place, validate again. A previous install is
 * moved aside and only removed once the new bundle verifies.
 */
export async function installLumeApp(stagedApp, destination = VENDORED_LUME_APP, validate = validateVendoredLume) {
  if (!(await validate(stagedApp))) {
    throw new Error("The staged lume.app failed its hash, signature, or version pin.");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const aside = `${destination}.previous-${process.pid}-${Date.now()}`;
  const hadPrevious = await pathExists(destination);
  if (hadPrevious) await rename(destination, aside);
  try {
    await rename(stagedApp, destination);
  } catch (error) {
    if (hadPrevious) await rename(aside, destination).catch(() => {});
    throw error;
  }
  if (!(await validate(destination))) {
    await rm(destination, { recursive: true, force: true });
    if (hadPrevious) await rename(aside, destination).catch(() => {});
    throw new Error("The installed lume.app failed final verification.");
  }
  if (hadPrevious) await rm(aside, { recursive: true, force: true });
  return destination;
}

export function assertLumeVendorHost(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error("Lume is vendored only on an Apple silicon Mac (darwin arm64).");
  }
}

export async function vendorLume({
  platform = process.platform,
  arch = process.arch,
  destination = VENDORED_LUME_APP,
  runner = run,
  fetchImpl = fetch,
  hashBinary = hashFile,
  log = console.log,
} = {}) {
  assertLumeVendorHost(platform, arch);
  validateArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
  const validate = (candidate) => validateVendoredLume(candidate, runner, hashBinary);
  if (await validate(destination)) {
    log(`Lume ${LUME_ARTIFACT_PROVENANCE.version} is already verified at ${destination}`);
    return destination;
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  // Stage beside the destination so the final rename never crosses volumes.
  const staging = await mkdtemp(path.join(path.dirname(destination), ".lume-staging-"));
  try {
    const archive = path.join(staging, LUME_ARTIFACT_PROVENANCE.asset);
    await downloadLumeArchive(archive, { fetchImpl });
    const actualSha256 = await hashFile(archive);
    if (actualSha256 !== LUME_ARTIFACT_PROVENANCE.sha256) {
      throw new Error(`Lume checksum mismatch: expected ${LUME_ARTIFACT_PROVENANCE.sha256}, received ${actualSha256}`);
    }
    const extractDirectory = path.join(staging, "extracted");
    await mkdir(extractDirectory, { mode: 0o700 });
    const extracted = await extractLumeApp(archive, extractDirectory, runner);
    await installLumeApp(extracted, destination, validate);
    log(
      `Vendored verified Lume ${LUME_ARTIFACT_PROVENANCE.version} (archive ${actualSha256}, binary ${LUME_ARTIFACT_PROVENANCE.binarySha256})`,
    );
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv[2]}`);
  await vendorLume();
}

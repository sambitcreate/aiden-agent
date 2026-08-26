import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, lstat, realpath, rename, rm, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { extractFile, statFile } from "@electron/asar";
import { readBoundedJsonFile, verifyPerformanceReceipt } from "./performance-receipt.mjs";

const BUILD_MARKER = /AIDEN_PERFORMANCE_BUILD_IDENTITY_V1 ([A-Za-z0-9_-]{8,2048})/u;
const MAX_APP_ASAR_BYTES = 1024 * 1024 * 1024;
const MAX_MAIN_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_DESIGNATED_REQUIREMENT_BYTES = 16 * 1024;

function sameFileIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identityFromStat(info) {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function assertBoundedRegularStat(info, maximumBytes, executable, label) {
  if (
    !info.isFile() ||
    info.size < 1n ||
    info.size > BigInt(maximumBytes) ||
    (executable && (info.mode & 0o111n) === 0n)
  ) {
    throw new Error(`${label} must be a bounded${executable ? " executable" : ""} regular file.`);
  }
}

export async function assertBoundedPerformanceAsarHeader(file, expectedIdentity) {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = identityFromStat(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, expectedIdentity)) {
      throw new Error("The benchmark app.asar changed before header inspection.");
    }
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const headerBytes = bytesRead === 8 ? header.readUInt32LE(4) : 0;
    if (
      header.readUInt32LE(0) !== 4 ||
      headerBytes < 8 ||
      headerBytes > MAX_ASAR_HEADER_BYTES ||
      BigInt(8 + headerBytes) > before.size
    ) {
      throw new Error("The benchmark app.asar has an invalid bounded header.");
    }
    const after = identityFromStat(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) {
      throw new Error("The benchmark app.asar changed during header inspection.");
    }
  } finally {
    await handle.close();
  }
  await assertPerformancePackageFileIdentity(file, expectedIdentity, {
    maximumBytes: MAX_APP_ASAR_BYTES,
    label: "The benchmark app.asar",
  });
}

export async function copyIdentityBoundPerformanceFile(
  source,
  destination,
  expectedIdentity,
  { afterFirstChunk } = {},
) {
  const sourceHandle = await open(
    source,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  let destinationHandle;
  try {
    const before = identityFromStat(await sourceHandle.stat({ bigint: true }));
    if (!sameFileIdentity(before, expectedIdentity)) {
      throw new Error("The benchmark app.asar changed before snapshot creation.");
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    const total = Number(before.size);
    let offset = 0;
    while (offset < total) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, total - offset));
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (bytesRead < 1)
        throw new Error("The benchmark app.asar changed during snapshot creation.");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (result.bytesWritten < 1) {
          throw new Error("The benchmark app.asar snapshot could not be written.");
        }
        written += result.bytesWritten;
      }
      offset += bytesRead;
      if (offset === bytesRead) await afterFirstChunk?.();
    }
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    const after = identityFromStat(await sourceHandle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) {
      throw new Error("The benchmark app.asar changed during snapshot creation.");
    }
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close();
  }
  await assertPerformancePackageFileIdentity(source, expectedIdentity, {
    maximumBytes: MAX_APP_ASAR_BYTES,
    label: "The benchmark app.asar",
  });
}

export async function capturePerformancePackageFileIdentity(
  file,
  { maximumBytes, executable = false, label = "Performance package file" },
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid performance package file bound.");
  }
  const resolved = path.resolve(file);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error(`${label} must not use symlinks.`);
  }
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat({ bigint: true });
    assertBoundedRegularStat(info, maximumBytes, executable, label);
    if ((await realpath(resolved)) !== resolved) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    return identityFromStat(info);
  } finally {
    await handle.close();
  }
}

export async function assertPerformancePackageFileIdentity(file, expected, options) {
  const current = await capturePerformancePackageFileIdentity(file, options);
  if (!sameFileIdentity(current, expected)) {
    throw new Error(`${options.label ?? "Performance package file"} changed during inspection.`);
  }
}

async function sha256BoundPerformanceFile(file, expected, options) {
  const resolved = path.resolve(file);
  const handle = await open(
    resolved,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertBoundedRegularStat(
      before,
      options.maximumBytes,
      options.executable ?? false,
      options.label,
    );
    if (!sameFileIdentity(identityFromStat(before), expected)) {
      throw new Error(`${options.label} changed before hashing.`);
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) digest.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(identityFromStat(after), expected)) {
      throw new Error(`${options.label} changed while it was being hashed.`);
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

export function parseEmbeddedPerformanceBuildIdentity(source) {
  const match = BUILD_MARKER.exec(source);
  if (!match) throw new Error("The package does not contain a performance build identity marker.");
  let value;
  try {
    value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("The package performance build identity is malformed.");
  }
  const keys = Object.keys(value ?? {})
    .sort()
    .join("\n");
  if (
    keys !==
      ["buildMode", "commit", "dirtyStateHash", "profilingBuild", "schemaVersion"]
        .sort()
        .join("\n") ||
    value.schemaVersion !== 1 ||
    typeof value.commit !== "string" ||
    typeof value.dirtyStateHash !== "string" ||
    typeof value.buildMode !== "string" ||
    typeof value.profilingBuild !== "boolean"
  ) {
    throw new Error("The package performance build identity is invalid.");
  }
  return value;
}

function runCodesign(args, execute = spawnSync) {
  return execute("/usr/bin/codesign", args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
}

export function verifyPerformanceCodeSignature(appPath, execute = spawnSync) {
  const verification = runCodesign(
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    execute,
  );
  if (verification.status !== 0) {
    throw new Error("The benchmark app must have a valid strict macOS code signature.");
  }

  const requirements = runCodesign(["-d", "-r-", appPath], execute);
  const requirementOutput = `${requirements.stdout ?? ""}\n${requirements.stderr ?? ""}`;
  // Ad-hoc signatures print the synthesized designated requirement as a comment,
  // while Developer ID signatures print it without the prefix.
  const designated = /^(?:# )?designated => (.+)$/imu.exec(requirementOutput)?.[1];
  if (
    requirements.status !== 0 ||
    !designated ||
    Buffer.byteLength(designated, "utf8") > MAX_DESIGNATED_REQUIREMENT_BYTES ||
    designated.includes("\n") ||
    designated.includes("\r")
  ) {
    throw new Error("The benchmark app must expose a bounded designated requirement.");
  }
  const designatedVerification = runCodesign(
    ["--verify", "--deep", "--strict", `-R=${designated}`, "--verbose=2", appPath],
    execute,
  );
  if (designatedVerification.status !== 0) {
    throw new Error("The benchmark app does not satisfy its designated requirement.");
  }

  const result = runCodesign(["-d", "--verbose=4", appPath], execute);
  const display = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const hash = /^CDHash=([0-9a-f]{40,64})$/imu.exec(display)?.[1]?.toLowerCase();
  if (result.status !== 0 || !hash) {
    throw new Error("The benchmark app must have a valid macOS code directory hash.");
  }
  return hash;
}

function packagedRuntimeIdentity(executable) {
  const result = spawnSync(executable, ["--aiden-performance-runtime-info"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
  });
  let value;
  try {
    value = JSON.parse((result.stdout ?? "").trim());
  } catch {
    throw new Error("The benchmark app did not report its embedded runtime identity.");
  }
  const fields = ["nodeVersion", "electronVersion", "platform", "architecture"];
  if (
    result.status !== 0 ||
    Object.keys(value ?? {})
      .sort()
      .join("\n") !== fields.sort().join("\n") ||
    fields.some(
      (field) => typeof value[field] !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/u.test(value[field]),
    )
  ) {
    throw new Error("The benchmark app runtime identity is invalid.");
  }
  return value;
}

export async function inspectPerformancePackage(appPath) {
  const resolved = path.resolve(appPath);
  if (path.basename(resolved) !== "Aiden Agent.app" || (await realpath(resolved)) !== resolved) {
    throw new Error("The benchmark package must be the real Aiden Agent.app bundle.");
  }
  const bundle = await lstat(resolved);
  if (!bundle.isDirectory() || bundle.isSymbolicLink())
    throw new Error("Invalid benchmark app bundle.");
  const appAsar = path.join(resolved, "Contents", "Resources", "app.asar");
  const executable = path.join(resolved, "Contents", "MacOS", "Aiden Agent");
  const appAsarOptions = {
    maximumBytes: MAX_APP_ASAR_BYTES,
    label: "The benchmark app.asar",
  };
  const executableOptions = {
    maximumBytes: MAX_EXECUTABLE_BYTES,
    executable: true,
    label: "The benchmark executable",
  };
  const appAsarIdentity = await capturePerformancePackageFileIdentity(appAsar, appAsarOptions);
  const executableIdentity = await capturePerformancePackageFileIdentity(
    executable,
    executableOptions,
  );
  let codeDirectoryHash = verifyPerformanceCodeSignature(resolved);
  await assertPerformancePackageFileIdentity(appAsar, appAsarIdentity, appAsarOptions);
  await assertPerformancePackageFileIdentity(executable, executableIdentity, executableOptions);

  const snapshotDirectory = await mkdtemp(
    path.join(path.dirname(resolved), ".aiden-performance-asar-inspection-"),
  );
  let mainBundle;
  let snapshotSha256;
  try {
    const snapshot = path.join(snapshotDirectory, "app.asar");
    await copyIdentityBoundPerformanceFile(appAsar, snapshot, appAsarIdentity);
    await assertPerformancePackageFileIdentity(appAsar, appAsarIdentity, appAsarOptions);
    const snapshotIdentity = await capturePerformancePackageFileIdentity(snapshot, appAsarOptions);
    await assertBoundedPerformanceAsarHeader(snapshot, snapshotIdentity);
    const mainBundleEntry = statFile(snapshot, "build/main/index.js", false);
    if (
      !("size" in mainBundleEntry) ||
      !Number.isSafeInteger(mainBundleEntry.size) ||
      mainBundleEntry.size < 1 ||
      mainBundleEntry.size > MAX_MAIN_BUNDLE_BYTES
    ) {
      throw new Error("The benchmark main bundle exceeds its extraction budget.");
    }
    mainBundle = extractFile(snapshot, "build/main/index.js", false).toString("utf8");
    await assertPerformancePackageFileIdentity(snapshot, snapshotIdentity, appAsarOptions);
    snapshotSha256 = await sha256BoundPerformanceFile(snapshot, snapshotIdentity, appAsarOptions);
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
  const embedded = parseEmbeddedPerformanceBuildIdentity(mainBundle);

  const appAsarSha256 = await sha256BoundPerformanceFile(appAsar, appAsarIdentity, appAsarOptions);
  if (appAsarSha256 !== snapshotSha256) {
    throw new Error("The benchmark app.asar changed while its private snapshot was inspected.");
  }
  await assertPerformancePackageFileIdentity(appAsar, appAsarIdentity, appAsarOptions);
  const executableSha256 = await sha256BoundPerformanceFile(
    executable,
    executableIdentity,
    executableOptions,
  );
  await assertPerformancePackageFileIdentity(executable, executableIdentity, executableOptions);

  const finalCodeDirectoryHash = verifyPerformanceCodeSignature(resolved);
  if (finalCodeDirectoryHash !== codeDirectoryHash) {
    throw new Error("The benchmark app code signature changed during inspection.");
  }
  codeDirectoryHash = finalCodeDirectoryHash;
  await assertPerformancePackageFileIdentity(executable, executableIdentity, executableOptions);
  const runtime = packagedRuntimeIdentity(executable);
  await assertPerformancePackageFileIdentity(executable, executableIdentity, executableOptions);
  await assertPerformancePackageFileIdentity(appAsar, appAsarIdentity, appAsarOptions);
  const postRuntimeCodeDirectoryHash = verifyPerformanceCodeSignature(resolved);
  if (postRuntimeCodeDirectoryHash !== codeDirectoryHash) {
    throw new Error("The benchmark app code signature changed during runtime inspection.");
  }
  return {
    schemaVersion: 1,
    ...embedded,
    runtimeNodeVersion: runtime.nodeVersion,
    runtimeElectronVersion: runtime.electronVersion,
    runtimePlatform: runtime.platform,
    runtimeArchitecture: runtime.architecture,
    appAsarSha256,
    executableSha256,
    codeDirectoryHash,
  };
}

export function assertReceiptMatchesPerformancePackage(receipt, identity) {
  const bound = receipt.packageIdentity;
  const fields = [
    "schemaVersion",
    "commit",
    "dirtyStateHash",
    "buildMode",
    "profilingBuild",
    "runtimeNodeVersion",
    "runtimeElectronVersion",
    "runtimePlatform",
    "runtimeArchitecture",
    "appAsarSha256",
    "executableSha256",
    "codeDirectoryHash",
  ];
  if (
    !bound ||
    fields.some((field) => bound[field] !== identity[field]) ||
    Object.keys(bound).length !== fields.length ||
    Object.keys(identity).length !== fields.length
  ) {
    throw new Error("The benchmark receipt is not bound to this exact signed package.");
  }
  if (
    !identity.profilingBuild ||
    identity.commit !== receipt.commit ||
    identity.dirtyStateHash !== receipt.dirtyStateHash ||
    identity.buildMode !== receipt.buildMode ||
    identity.runtimeNodeVersion !== receipt.nodeVersion ||
    identity.runtimeElectronVersion !== receipt.electronVersion ||
    identity.runtimePlatform !== receipt.platform ||
    identity.runtimeArchitecture !== receipt.architecture
  ) {
    throw new Error("The benchmark receipt source identity does not match its package.");
  }
}

export async function writeBoundReceipt(receiptPath, receipt) {
  const destination = path.resolve(receiptPath);
  if (
    (await realpath(destination)) !== destination ||
    (await realpath(path.dirname(destination))) !== path.dirname(destination)
  ) {
    throw new Error("The performance receipt and its parent must not use symlinks.");
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if ((await realpath(path.dirname(destination))) !== path.dirname(destination)) {
      throw new Error("The performance receipt parent changed during binding.");
    }
    await rename(temporary, destination);
    try {
      const directory = await open(path.dirname(destination), fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The exact bound receipt is already installed. A directory-sync error
      // is a committed result, so a retry cannot become a misleading failure.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const receiptPath = value("--receipt");
  const appPath = value("--app");
  if (!receiptPath || !appPath) {
    throw new Error(
      "Usage: performance-package-identity.mjs --receipt <receipt.json> --app <Aiden Agent.app>",
    );
  }
  const receipt = (await readBoundedJsonFile(receiptPath, 512 * 1024)).value;
  verifyPerformanceReceipt(receipt);
  const packageIdentity = await inspectPerformancePackage(appPath);
  const bound = {
    ...receipt,
    nodeVersion: packageIdentity.runtimeNodeVersion,
    platform: packageIdentity.runtimePlatform,
    architecture: packageIdentity.runtimeArchitecture,
    electronVersion: packageIdentity.runtimeElectronVersion,
    packageIdentity,
  };
  verifyPerformanceReceipt(bound);
  assertReceiptMatchesPerformancePackage(bound, packageIdentity);
  await writeBoundReceipt(receiptPath, bound);
  process.stdout.write("Performance receipt bound to the exact signed profiling package.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

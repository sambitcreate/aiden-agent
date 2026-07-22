/* global AbortController, Buffer, clearTimeout, console, fetch, process, setTimeout */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CUA_DRIVER_ARTIFACT_PROVENANCE,
  CUA_DRIVER_SHA256,
  CUA_DRIVER_SIGNING_IDENTIFIER,
  CUA_DRIVER_SIGNING_TEAM_ID,
  appleRequirement,
  assertCuaDriverArtifactProvenance,
} from "./computer-use-signing-pins.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const commandGuardPath = path.join(repositoryRoot, "scripts", "bounded-command-guard.mjs");
const artifactPath = path.join(
  repositoryRoot,
  "resources",
  "computer-use",
  "cua-driver-artifact.json",
);
const destination = path.join(repositoryRoot, "build", "computer-use", "cua-driver");
const brokerPackage = path.join(repositoryRoot, "native", "computer-use-broker");
const brokerTarget = path.join(repositoryRoot, "build", "computer-use-broker-cargo");
const brokerApp = path.join(repositoryRoot, "build", "computer-use", "CuaDriver.app");
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const CARGO_BUILD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TERMINATE_GRACE_MS = 500;
const COMMAND_KILL_GRACE_MS = 1_000;

export function runBoundedCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      timeoutMs = COMMAND_TIMEOUT_MS,
      terminateGraceMs = COMMAND_TERMINATE_GRACE_MS,
      killGraceMs = COMMAND_KILL_GRACE_MS,
      ...spawnOptions
    } = options;
    const child = spawn(process.execPath, [commandGuardPath, JSON.stringify({ command, args })], {
      ...spawnOptions,
      detached: process.platform !== "win32",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "C",
        LC_ALL: "C",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_TELEMETRY_ENABLED: "0",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let terminationError;
    let commandResult;
    let reapTimer;
    const timeout = setTimeout(() => terminate(new Error(`${command} timed out`)), timeoutMs);
    const destroyOutputPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(reapTimer);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const terminate = (error) => {
      if (terminationError) return;
      terminationError = error;
      // The detached wrapper remains an occupied member of its group while it
      // applies TERM→KILL, so no delayed signal can target a recycled PGID.
      try {
        child.send?.({ type: "terminate", graceMs: terminateGraceMs });
      } catch {
        child.kill("SIGKILL");
      }
      reapTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        destroyOutputPipes();
        finish(error);
      }, terminateGraceMs + killGraceMs);
    };
    const collect = (target) => (chunk) => {
      if (terminationError) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(new Error(`${command} returned too much output`));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("message", (message) => {
      if (message?.type !== "result" || terminationError) return;
      commandResult = message;
      try {
        child.send?.({ type: "release", graceMs: terminateGraceMs });
      } catch {
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (terminationError) {
        finish(terminationError);
      } else if (commandResult?.error) {
        finish(new Error(commandResult.error));
      } else if (commandResult?.code === 0) {
        finish();
      } else if (commandResult) {
        finish(
          new Error(
            `${command} exited ${commandResult.signal ? `after ${commandResult.signal}` : `with code ${String(commandResult.code)}`}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 1_000)}`,
          ),
        );
      } else if (!settled) {
        finish(
          new Error(
            `bounded command guard exited ${signal ? `after ${signal}` : `with code ${String(code)}`}`,
          ),
        );
      }
    });
  });
}

const run = runBoundedCommand;

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function validateArtifact(artifact) {
  return assertCuaDriverArtifactProvenance(artifact);
}

export async function validateVendoredBinary(binaryPath, runner = run, hashBinary = hashFile) {
  try {
    const info = await lstat(binaryPath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if ((await hashBinary(binaryPath)) !== CUA_DRIVER_SHA256) return false;
    await runner("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      `-R=${appleRequirement({
        identifier: CUA_DRIVER_SIGNING_IDENTIFIER,
        teamId: CUA_DRIVER_SIGNING_TEAM_ID,
      })}`,
      binaryPath,
    ]);
    const output = await runner(binaryPath, ["manifest"]);
    const current = JSON.parse(output);
    return (
      current.schema_version === "1" &&
      current.binary_version === CUA_DRIVER_ARTIFACT_PROVENANCE.version
    );
  } catch {
    return false;
  }
}

async function findBinary(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlink in pinned cua-driver archive: ${entry.name}`);
    }
    if (info.isDirectory()) {
      const nested = await findBinary(candidate);
      if (nested) return nested;
    } else if (info.isFile() && entry.name === "cua-driver") {
      return candidate;
    }
  }
  return null;
}

async function downloadArtifact(artifact, archive) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(artifact.url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ARCHIVE_BYTES) {
      throw new Error(`Pinned cua-driver archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
    }
    let downloadedBytes = 0;
    const bound = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        callback(
          downloadedBytes > MAX_ARCHIVE_BYTES
            ? new Error(`Pinned cua-driver archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`)
            : undefined,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      bound,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function installBinary(extractedBinary) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const stagedDestination = path.join(
    path.dirname(destination),
    `.cua-driver-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await copyFile(extractedBinary, stagedDestination, fsConstants.COPYFILE_EXCL);
    await chmod(stagedDestination, 0o755);
    if (!(await validateVendoredBinary(stagedDestination))) {
      throw new Error("The staged cua-driver binary failed its hash, signature, or manifest pin.");
    }
    await rename(stagedDestination, destination);
    if (!(await validateVendoredBinary(destination))) {
      await rm(destination, { force: true });
      throw new Error("The installed cua-driver binary failed final verification.");
    }
  } finally {
    await rm(stagedDestination, { force: true });
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

export async function buildBrokerApp(runner = run) {
  const cargo = process.env.CARGO || path.join(os.homedir(), ".cargo", "bin", "cargo");
  await runner(
    cargo,
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(brokerPackage, "Cargo.toml"),
      "--target-dir",
      brokerTarget,
    ],
    {
      cwd: brokerPackage,
      // A clean rustup toolchain install, crate fetch, and release/LTO compile
      // can legitimately take several minutes. It remains inside the same
      // occupied process-group guard and bounded TERM-to-KILL cleanup.
      timeoutMs: CARGO_BUILD_TIMEOUT_MS,
    },
  );
  const brokerExecutable = path.join(brokerTarget, "release", "aiden-cua-broker");
  const staging = await mkdtemp(
    path.join(repositoryRoot, "build", "computer-use", ".cua-driver-app-"),
  );
  const stagedApp = path.join(staging, "CuaDriver.app");
  const stagedContents = path.join(stagedApp, "Contents");
  const stagedMacOS = path.join(stagedContents, "MacOS");
  const stagedResources = path.join(stagedContents, "Resources");
  await mkdir(stagedMacOS, { recursive: true, mode: 0o755 });
  await mkdir(stagedResources, { recursive: true, mode: 0o755 });
  try {
    await copyFile(brokerExecutable, path.join(stagedMacOS, "aiden-cua-broker"));
    await copyFile(destination, path.join(stagedMacOS, "cua-driver"));
    await copyFile(path.join(brokerPackage, "Info.plist"), path.join(stagedContents, "Info.plist"));
    await copyFile(artifactPath, path.join(stagedResources, "cua-driver-artifact.json"));
    await copyFile(
      path.join(repositoryRoot, "resources", "computer-use", "LICENSE.cua-driver.md"),
      path.join(stagedResources, "LICENSE.cua-driver.md"),
    );
    await chmod(path.join(stagedMacOS, "aiden-cua-broker"), 0o755);
    await chmod(path.join(stagedMacOS, "cua-driver"), 0o755);
    if (!(await validateVendoredBinary(path.join(stagedMacOS, "cua-driver"), runner))) {
      throw new Error("The broker's staged cua-driver failed its upstream release pins.");
    }
    await runner("/usr/bin/plutil", ["-lint", path.join(stagedContents, "Info.plist")]);
    await runner("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(repositoryRoot, "resources", "entitlements.computer-use.plist"),
      path.join(stagedMacOS, "aiden-cua-broker"),
    ]);
    await runner("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      path.join(repositoryRoot, "resources", "entitlements.computer-use.plist"),
      stagedApp,
    ]);
    if (!(await validateVendoredBinary(path.join(stagedMacOS, "cua-driver"), runner))) {
      throw new Error("Signing the broker changed the pinned upstream cua-driver.");
    }

    // Preserve the outer .app directory so LaunchServices does not retain a
    // stale bundle vnode between development rebuilds. Replace only Contents.
    await mkdir(brokerApp, { recursive: true, mode: 0o755 });
    const installedContents = path.join(brokerApp, "Contents");
    const previousContents = path.join(
      brokerApp,
      `.Contents-${process.pid}-${Date.now()}.previous`,
    );
    if (await pathExists(installedContents)) await rename(installedContents, previousContents);
    try {
      await rename(stagedContents, installedContents);
    } catch (error) {
      if (await pathExists(previousContents)) await rename(previousContents, installedContents);
      throw error;
    }
    await rm(previousContents, { recursive: true, force: true });
    await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", brokerApp]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("The pinned Aiden cua-driver artifact currently supports macOS only.");
  }
  validateArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
  const artifact = CUA_DRIVER_ARTIFACT_PROVENANCE;
  if (await validateVendoredBinary(destination)) {
    await buildBrokerApp();
    console.log(`cua-driver ${artifact.version} is already verified at ${destination}`);
    console.log(`Aiden Computer Use broker: ${brokerApp}`);
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-vendor-"));
  try {
    const archive = path.join(temporary, artifact.asset);
    await downloadArtifact(artifact, archive);
    const actualSha256 = await hashFile(archive);
    if (actualSha256 !== artifact.sha256) {
      throw new Error(
        `cua-driver checksum mismatch: expected ${artifact.sha256}, received ${actualSha256}`,
      );
    }

    const extractDirectory = path.join(temporary, "extracted");
    await mkdir(extractDirectory, { mode: 0o700 });
    await run("/usr/bin/tar", ["-xzf", archive, "-C", extractDirectory]);
    const extractedBinary = await findBinary(extractDirectory);
    if (!extractedBinary) throw new Error("The pinned archive did not contain cua-driver.");
    const resolvedExtractDirectory = await realpath(extractDirectory);
    const resolvedExtractedBinary = await realpath(extractedBinary);
    if (!resolvedExtractedBinary.startsWith(`${resolvedExtractDirectory}${path.sep}`)) {
      throw new Error("The extracted cua-driver escaped its private staging directory.");
    }
    if (!(await validateVendoredBinary(extractedBinary))) {
      throw new Error("The downloaded cua-driver failed its binary hash or signing identity pin.");
    }

    await installBinary(extractedBinary);
    await buildBrokerApp();
    console.log(
      `Vendored verified cua-driver ${artifact.version} (archive ${actualSha256}, binary ${artifact.binarySha256})`,
    );
    console.log(`Aiden Computer Use broker: ${brokerApp}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await main();

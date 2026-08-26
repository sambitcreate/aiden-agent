/* global console, process */

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { access, lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";

import { verifyAidenFuses } from "./configure-electron-fuses.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const execFileAsync = promisify(execFile);
const MAXIMUM_GLIBC_VERSION = Object.freeze([2, 34]);
const REQUIRED_HELPERS = Object.freeze([
  "aiden-worktree-remover",
  "aiden-subagent-run-store",
  "aiden-subagent-file-mutator",
  "aiden-subagent-shell-runner",
]);

async function assertRegularFile(file, { executable = false } = {}) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file) {
    throw new Error(`Expected a regular non-symlinked package file: ${file}`);
  }
  if (executable && (info.mode & 0o111) === 0) {
    throw new Error(`Expected an executable package file: ${file}`);
  }
  return info;
}

async function assertAbsent(file) {
  try {
    await access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Linux package contains a macOS-only artifact: ${file}`);
}

async function containsNativeModule(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".node")) return true;
    }
  }
  return false;
}

async function nativeModules(directory) {
  const result = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (
        entry.isFile() &&
        (entry.name.endsWith(".node") ||
          /\.so(?:\.[0-9]+)*$/u.test(entry.name)) &&
        (await isElfFile(candidate))
      ) {
        result.push(candidate);
      }
    }
  }
  return result;
}

export function isElfMagic(contents) {
  return (
    contents.length >= 4 &&
    contents[0] === 0x7f &&
    contents[1] === 0x45 &&
    contents[2] === 0x4c &&
    contents[3] === 0x46
  );
}

async function isElfFile(file) {
  const handle = await open(file, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return isElfMagic(magic.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function assertGlibcSymbolBaseline(
  file,
  symbolTable,
  maximum = MAXIMUM_GLIBC_VERSION,
) {
  for (const match of symbolTable.matchAll(/GLIBC_(\d+)\.(\d+)/gu)) {
    const version = [Number(match[1]), Number(match[2])];
    if (
      version[0] > maximum[0] ||
      (version[0] === maximum[0] && version[1] > maximum[1])
    ) {
      throw new Error(
        `${file} requires GLIBC_${version.join(".")}; Linux packages must remain compatible with GLIBC_${maximum.join(".")}.`,
      );
    }
  }
}

async function verifyGlibcCompatibility(files) {
  for (const file of files) {
    const { stdout } = await execFileAsync("/usr/bin/objdump", ["-T", file], {
      maxBuffer: 8 * 1024 * 1024,
    });
    assertGlibcSymbolBaseline(file, stdout);
  }
}

async function verifyActiveNodePty(resources, architecture) {
  const root = path.join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  const candidates = [
    path.join(root, "build", "Release"),
    path.join(root, "prebuilds", `linux-${architecture}`),
  ];
  for (const directory of candidates) {
    try {
      await assertRegularFile(path.join(directory, "pty.node"));
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `No Linux ${architecture} node-pty native module was found under ${root}.`,
  );
}

export function assertLinuxBuildConfiguration(packageJson) {
  const build = packageJson?.build;
  const linux = build?.linux;
  const targets = new Set(linux?.target ?? []);
  for (const target of ["AppImage", "deb", "rpm"]) {
    if (!targets.has(target)) throw new Error(`Linux target ${target} is missing.`);
  }
  if (linux.executableName !== "aiden-agent") {
    throw new Error("Linux executableName must remain aiden-agent.");
  }
  if (
    packageJson.desktopName !== "com.sambitcreate.aiden-agent.desktop" ||
    linux.syncDesktopName !== true
  ) {
    throw new Error(
      "Linux desktopName and syncDesktopName must keep launcher/window association stable.",
    );
  }
  if (typeof packageJson.license !== "string" || !packageJson.license.trim()) {
    throw new Error("Linux package metadata must declare the repository license.");
  }
  if (build.toolsets?.appimage !== "1.0.3") {
    throw new Error(
      "Linux AppImage packages must use the pinned static runtime toolset.",
    );
  }
  const debDependencies = new Set(build.deb?.depends ?? []);
  for (const dependency of [
    "libsecret-1-0",
    "libasound2t64 (>= 1.0.17) | libasound2 (>= 1.0.17)",
  ]) {
    if (!debDependencies.has(dependency)) {
      throw new Error(`Debian package dependency ${dependency} is missing.`);
    }
  }
  const rpmDependencies = (build.rpm?.depends ?? []).join(" ");
  for (const dependency of ["libsecret", "alsa-lib"]) {
    if (!rpmDependencies.includes(dependency)) {
      throw new Error(`RPM package dependency ${dependency} is missing.`);
    }
  }
  const helperDestinations = new Set(
    (linux.extraFiles ?? []).map((entry) => entry.to),
  );
  for (const helper of REQUIRED_HELPERS) {
    if (!helperDestinations.has(`Helpers/${helper}`)) {
      throw new Error(`Linux package config is missing ${helper}.`);
    }
  }
  if (
    !(build.asarUnpack ?? []).some((pattern) =>
      pattern.includes("sherpa-onnx-linux-"),
    )
  ) {
    throw new Error("Linux sherpa-onnx native packages are not unpacked.");
  }
  if (
    (build.extraResources ?? []).some((entry) =>
      String(entry.from).includes("computer-use"),
    )
  ) {
    throw new Error("Computer Use resources must not be global package resources.");
  }
  if (
    !(build.mac?.extraResources ?? []).some((entry) =>
      String(entry.from).includes("cua-driver-artifact.json"),
    )
  ) {
    throw new Error("Computer Use resources must remain in the macOS package.");
  }
}

export async function discoverLinuxPackage(
  releaseDirectory = path.join(repositoryRoot, "release", "linux-development"),
) {
  const candidates = [];
  for (const entry of await readdir(releaseDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^linux(?:-[a-z0-9]+)?-unpacked$/u.test(entry.name)) {
      candidates.push(path.join(releaseDirectory, entry.name));
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked Aiden Linux package, found ${candidates.length}. Pass an explicit package directory.`,
    );
  }
  return candidates[0];
}

export async function verifyLinuxPackage(appDirectory) {
  const root = path.resolve(appDirectory);
  const executable = path.join(root, "aiden-agent");
  const resources = path.join(root, "resources");
  const asar = path.join(resources, "app.asar");
  await assertRegularFile(executable, { executable: true });
  await assertRegularFile(asar);
  await verifyAidenFuses(executable);

  for (const helper of REQUIRED_HELPERS) {
    await assertRegularFile(path.join(root, "Helpers", helper), {
      executable: true,
    });
  }
  for (const forbidden of [
    path.join(root, "Helpers", "CuaDriver.app"),
    path.join(root, "Helpers", "Aiden Foundation Models Helper.app"),
    path.join(resources, "computer-use"),
  ]) {
    await assertAbsent(forbidden);
  }

  const entries = new Set(
    listPackage(asar, { isPack: false }).map((entry) =>
      entry.replaceAll("\\", "/"),
    ),
  );
  for (const required of [
    "/build/main/index.js",
    "/build/main/subagent-inference-worker.js",
    "/build/main/subagent-inference-worker-runtime.js",
    "/resources/model-capabilities.json",
  ]) {
    if (!entries.has(required)) {
      throw new Error(`Packaged app.asar is missing ${required}.`);
    }
  }

  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
  await verifyActiveNodePty(resources, architecture);
  const sherpa = path.join(unpackedModules, `sherpa-onnx-linux-${architecture}`);
  if (!(await containsNativeModule(sherpa))) {
    throw new Error(`No sherpa-onnx native module was found under ${sherpa}.`);
  }
  await verifyGlibcCompatibility([
    executable,
    ...REQUIRED_HELPERS.map((helper) => path.join(root, "Helpers", helper)),
    ...(await nativeModules(root)),
  ]);
  console.log(`Verified hardened Linux package: ${root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assertLinuxBuildConfiguration(packageJson);
  let appDirectory;
  if (process.argv[2]) {
    const requested = path.resolve(process.argv[2]);
    try {
      await access(path.join(requested, "aiden-agent"));
      appDirectory = requested;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      appDirectory = await discoverLinuxPackage(requested);
    }
  } else {
    appDirectory = await discoverLinuxPackage();
  }
  await verifyLinuxPackage(appDirectory);
}

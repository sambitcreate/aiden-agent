#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const XCODE_DEVICE_ID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{16}$/iu;
const CORE_DEVICE_ID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/iu;
const TEST_IDENTIFIER =
  "AidenOnTheGoTests/AidenNativeIntegrationTests/testOptInPhysicalActivityKitProcessBoundaryPhase";
const TEST_TARGET_PATH = ":TestConfigurations:0:TestTargets:0";

export function parseActivityProcessProofOptions(argv, env = process.env) {
  const known = new Set(["--xcode-device-id", "--core-device-id"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!known.has(name)) {
      throw new Error(name.startsWith("--") ? `unknown option: ${name}` : `unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be supplied only once`);
    values.set(name, value);
    index += 1;
  }

  const xcodeDeviceId = values.get("--xcode-device-id") ?? env.AIDEN_IOS_XCODE_DEVICE_ID;
  const coreDeviceId = values.get("--core-device-id") ?? env.AIDEN_IOS_CORE_DEVICE_ID;
  if (!XCODE_DEVICE_ID_PATTERN.test(xcodeDeviceId ?? "")) {
    throw new Error("an exact physical --xcode-device-id (or AIDEN_IOS_XCODE_DEVICE_ID) is required");
  }
  if (!CORE_DEVICE_ID_PATTERN.test(coreDeviceId ?? "")) {
    throw new Error("an exact physical --core-device-id (or AIDEN_IOS_CORE_DEVICE_ID) is required");
  }
  return Object.freeze({ xcodeDeviceId, coreDeviceId });
}

export function physicalDestination(xcodeDeviceId) {
  return `platform=iOS,id=${xcodeDeviceId}`;
}

export function destinationArtifactPlistCommands() {
  return [
    `Add ${TEST_TARGET_PATH}:UseDestinationArtifacts bool true`,
    `Add ${TEST_TARGET_PATH}:TestBundleDestinationRelativePath string __TESTHOST__/PlugIns/AidenOnTheGoTests.xctest`,
    `Add ${TEST_TARGET_PATH}:UITargetAppBundleIdentifier string sbtbiswas.AidenOnTheGo`,
    `Delete ${TEST_TARGET_PATH}:TestBundlePath`,
    `Delete ${TEST_TARGET_PATH}:TestHostPath`,
    `Delete ${TEST_TARGET_PATH}:DependentProductPaths`,
  ];
}

export function validatePhysicalDeviceDetails(payload, options) {
  const hardware = payload?.result?.hardwareProperties;
  if (payload?.info?.outcome !== "success" || !hardware) {
    throw new Error("CoreDevice did not return physical-device details");
  }
  if (hardware.udid !== options.xcodeDeviceId) {
    throw new Error("the CoreDevice UUID and Xcode device ID do not identify the same device");
  }
  if (hardware.platform !== "iOS" || hardware.reality !== "physical") {
    throw new Error("the selected destination must be a physical iOS device");
  }
  return Object.freeze({
    udid: hardware.udid,
    platform: hardware.platform,
    reality: hardware.reality,
    marketingName: hardware.marketingName ?? null,
  });
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : "";
    throw new Error(`${command} exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function findFile(root, suffix) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(candidate, suffix);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix)) {
      return candidate;
    }
  }
  return null;
}

function plistBuddy(xctestrun, command) {
  execute("/usr/libexec/PlistBuddy", ["-c", command, xctestrun], { capture: true });
}

function deletePlistEntryIfPresent(xctestrun, entry) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Delete ${entry}`, xctestrun], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
}

function setPhase(xctestrun, phase) {
  plistBuddy(
    xctestrun,
    `Set ${TEST_TARGET_PATH}:EnvironmentVariables:AIDEN_ACTIVITYKIT_PROCESS_PHASE ${phase}`,
  );
}

function configureDestinationArtifacts(xctestrun) {
  const entriesToReplace = [
    `${TEST_TARGET_PATH}:UseDestinationArtifacts`,
    `${TEST_TARGET_PATH}:TestBundleDestinationRelativePath`,
    `${TEST_TARGET_PATH}:UITargetAppBundleIdentifier`,
  ];
  for (const entry of entriesToReplace) deletePlistEntryIfPresent(xctestrun, entry);
  for (const command of destinationArtifactPlistCommands().slice(0, 3)) plistBuddy(xctestrun, command);
  for (const entry of [
    `${TEST_TARGET_PATH}:TestBundlePath`,
    `${TEST_TARGET_PATH}:TestHostPath`,
    `${TEST_TARGET_PATH}:DependentProductPaths`,
  ]) {
    deletePlistEntryIfPresent(xctestrun, entry);
  }
}

function runSelectedPhase({ xctestrun, destination, resultBundlePath, repositoryRoot }) {
  execute(
    "xcodebuild",
    [
      "test-without-building",
      "-xctestrun",
      xctestrun,
      "-destination",
      destination,
      `-only-testing:${TEST_IDENTIFIER}`,
      "-resultBundlePath",
      resultBundlePath,
      "-quiet",
    ],
    { cwd: repositoryRoot },
  );
}

function readAidenProcesses(coreDeviceId, outputPath, repositoryRoot) {
  execute(
    "xcrun",
    [
      "devicectl",
      "device",
      "info",
      "processes",
      "--device",
      coreDeviceId,
      "--search",
      "Aiden",
      "--json-output",
      outputPath,
      "--quiet",
    ],
    { cwd: repositoryRoot, capture: true },
  );
  const payload = JSON.parse(readFileSync(outputPath, "utf8"));
  return Array.isArray(payload?.result?.runningProcesses) ? payload.result.runningProcesses : [];
}

function validateSelectedDevice(options, outputPath, repositoryRoot) {
  execute(
    "xcrun",
    [
      "devicectl",
      "device",
      "info",
      "details",
      "--device",
      options.coreDeviceId,
      "--json-output",
      outputPath,
      "--quiet",
    ],
    { cwd: repositoryRoot, capture: true },
  );
  return validatePhysicalDeviceDetails(JSON.parse(readFileSync(outputPath, "utf8")), options);
}

function mainAppProcesses(processes) {
  return processes.filter(
    (process) =>
      typeof process?.executable === "string" &&
      process.executable.endsWith("/AidenOnTheGo.app/AidenOnTheGo"),
  );
}

function ensureProcessBoundary(coreDeviceId, temporaryRoot, repositoryRoot) {
  const beforePath = join(temporaryRoot, "processes-before-relaunch.json");
  const running = mainAppProcesses(readAidenProcesses(coreDeviceId, beforePath, repositoryRoot));
  if (running.length > 1) throw new Error("more than one Aiden test-host process is running");
  if (running.length === 1) {
    const pid = running[0].processIdentifier;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Aiden test-host PID is invalid");
    execute(
      "xcrun",
      ["devicectl", "device", "process", "terminate", "--device", coreDeviceId, "--pid", String(pid), "--quiet"],
      { cwd: repositoryRoot, capture: true },
    );
  }

  const afterPath = join(temporaryRoot, "processes-after-termination.json");
  const remaining = mainAppProcesses(readAidenProcesses(coreDeviceId, afterPath, repositoryRoot));
  if (remaining.length !== 0) throw new Error("Aiden test host did not terminate before reconciliation");
}

function moveProofToTrash(temporaryRoot) {
  const trashRoot = join(homedir(), ".Trash");
  mkdirSync(trashRoot, { recursive: true });
  const baseName = temporaryRoot.split("/").at(-1);
  let destination = join(trashRoot, baseName);
  if (existsSync(destination)) destination = `${destination}-${Date.now()}`;
  renameSync(temporaryRoot, destination);
  return destination;
}

export function runActivityProcessProof(options) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "aiden-activity-process-proof."));
  const destination = physicalDestination(options.xcodeDeviceId);
  const proofId = `process-proof-${randomUUID().toUpperCase()}`;
  let xctestrun;
  let startAttempted = false;
  let destinationArtifactsConfigured = false;
  let completed = false;

  try {
    const device = validateSelectedDevice(
      options,
      join(temporaryRoot, "physical-device-details.json"),
      repositoryRoot,
    );
    process.stdout.write(`Physical destination: ${device.marketingName ?? device.udid}.\n`);
    execute(
      "xcodebuild",
      [
        "-project",
        join(repositoryRoot, "ios", "AidenOnTheGo.xcodeproj"),
        "-scheme",
        "AidenOnTheGo",
        "-configuration",
        "Debug",
        "-destination",
        destination,
        "-derivedDataPath",
        temporaryRoot,
        "build-for-testing",
        "-quiet",
      ],
      { cwd: repositoryRoot },
    );
    xctestrun = findFile(join(temporaryRoot, "Build", "Products"), ".xctestrun");
    if (!xctestrun) throw new Error("build-for-testing did not produce an .xctestrun file");

    plistBuddy(
      xctestrun,
      `Add ${TEST_TARGET_PATH}:EnvironmentVariables:AIDEN_ACTIVITYKIT_PROCESS_PROOF_ID string ${proofId}`,
    );
    plistBuddy(
      xctestrun,
      `Add ${TEST_TARGET_PATH}:EnvironmentVariables:AIDEN_ACTIVITYKIT_PROCESS_PHASE string start`,
    );
    startAttempted = true;
    runSelectedPhase({
      xctestrun,
      destination,
      resultBundlePath: join(temporaryRoot, "start.xcresult"),
      repositoryRoot,
    });
    ensureProcessBoundary(options.coreDeviceId, temporaryRoot, repositoryRoot);

    setPhase(xctestrun, "reconcile");
    configureDestinationArtifacts(xctestrun);
    destinationArtifactsConfigured = true;
    runSelectedPhase({
      xctestrun,
      destination,
      resultBundlePath: join(temporaryRoot, "reconcile.xcresult"),
      repositoryRoot,
    });
    completed = true;
    process.stdout.write(`Aiden ActivityKit process proof passed for ${proofId}.\n`);
  } finally {
    if (startAttempted && !completed && xctestrun) {
      try {
        setPhase(xctestrun, "cleanup");
        if (!destinationArtifactsConfigured) configureDestinationArtifacts(xctestrun);
        runSelectedPhase({
          xctestrun,
          destination,
          resultBundlePath: join(temporaryRoot, "cleanup.xcresult"),
          repositoryRoot,
        });
      } catch (cleanupError) {
        assert(cleanupError instanceof Error);
        process.stderr.write(`Aiden ActivityKit cleanup warning: ${cleanupError.message}\n`);
      }
    }
    const trashPath = moveProofToTrash(temporaryRoot);
    process.stdout.write(`Proof artifacts moved to ${trashPath}.\n`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    runActivityProcessProof(parseActivityProcessProofOptions(argv));
  } catch (error) {
    assert(error instanceof Error);
    process.stderr.write(`Aiden ActivityKit process proof: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

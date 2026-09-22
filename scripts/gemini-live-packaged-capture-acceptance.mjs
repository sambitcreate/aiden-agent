/* global clearTimeout, console, process, setTimeout */

import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertSamePackagedArtifactIdentity,
  discoverPackagedApp,
  packagedArtifactIdentity,
  verifyMacPackage,
} from "./verify-macos-package.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const ACCEPTANCE_ENV = "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE";
const TOKEN_ENV = "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE_TOKEN";
const PROFILE_ENV = "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE_PROFILE";
const ACCEPTANCE_SWITCH = "aiden-gemini-live-display-capture-acceptance";
const RAW_RECEIPT = "gemini-live-display-capture-acceptance.json";
const FINAL_RECEIPT = path.join(
  repositoryRoot,
  "build",
  "gemini-live-display-capture-acceptance-receipt.json",
);
const ACCEPTANCE_TIMEOUT_MS = 15 * 60 * 1_000;
const EXPECTED_CHECKS = Object.freeze([
  "display_permission_path",
  "external_source_ended",
  "native_picker_without_handler_fallback",
  "picker_cancelled",
  "picker_cancellation_rejected",
  "replacement_navigation_rejected",
  "replacement_document_denied",
  "replacement_without_chooser_fallback",
].sort());

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function codeSignatureMetadata(appPath) {
  try {
    const requirementResult = await executeFile("/usr/bin/codesign", [
      "--display",
      "--requirements",
      "-",
      appPath,
    ]);
    const displayResult = await executeFile("/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      appPath,
    ]);
    const requirementDisplay = `${requirementResult.stdout}\n${requirementResult.stderr}`;
    const codeDisplay = `${displayResult.stdout}\n${displayResult.stderr}`;
    return {
      designatedRequirement:
        requirementDisplay.match(/designated => (.+)$/m)?.[1]?.trim() ?? null,
      identifier: codeDisplay.match(/^Identifier=(.+)$/m)?.[1]?.trim() ?? null,
      teamIdentifier: codeDisplay.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null,
    };
  } catch {
    return {
      designatedRequirement: null,
      identifier: null,
      teamIdentifier: null,
    };
  }
}

async function macOSVersion() {
  try {
    const { stdout } = await executeFile("/usr/bin/sw_vers", ["-productVersion"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function monitorChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function beforeDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Aiden capture acceptance timed out after 15 minutes.")),
          ACCEPTANCE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    monitorChild(child),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function writeFinalReceipt(receipt) {
  await mkdir(path.dirname(FINAL_RECEIPT), { recursive: true });
  await writeFile(FINAL_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(FINAL_RECEIPT, 0o600);
}

function validateRawReceipt(raw, expectedArtifact, token, profile) {
  if (raw?.schemaVersion !== 1) throw new Error("Aiden emitted an unknown receipt schema.");
  if (raw?.runTokenSha256 !== createHash("sha256").update(token).digest("hex")) {
    throw new Error("Aiden emitted a receipt for a different acceptance run.");
  }
  if (
    raw?.artifact?.bundleIdentifier !== expectedArtifact.bundleIdentifier ||
    raw?.artifact?.shortVersion !== expectedArtifact.shortVersion ||
    raw?.artifact?.appAsarSha256 !== expectedArtifact.appAsarSha256
  ) {
    throw new Error("Aiden runtime receipt does not match the launched app artifact.");
  }
  const checks = Array.isArray(raw?.checks) ? [...raw.checks].sort() : [];
  if (JSON.stringify(checks) !== JSON.stringify(EXPECTED_CHECKS)) {
    throw new Error("Aiden runtime receipt omitted required capture lifecycle evidence.");
  }
  const startedAt = Date.parse(raw.startedAt);
  const completedAt = Date.parse(raw.completedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    raw.durationMs !== completedAt - startedAt ||
    raw.durationMs < 0 ||
    raw.durationMs > ACCEPTANCE_TIMEOUT_MS
  ) {
    throw new Error("Aiden runtime receipt contains invalid acceptance timing.");
  }
  if (path.dirname(path.join(profile, RAW_RECEIPT)) !== profile) {
    throw new Error("Acceptance receipt escaped the isolated profile.");
  }
  return raw;
}

async function runAcceptance() {
  if (process.platform !== "darwin") {
    throw new Error("Gemini Live display capture acceptance is macOS-only.");
  }
  if (process.env[ACCEPTANCE_ENV] !== "1") {
    throw new Error(
      `This operator test opens the macOS screen/window chooser. Re-run with ${ACCEPTANCE_ENV}=1 after reviewing the test steps.`,
    );
  }

  await rm(FINAL_RECEIPT, { force: true });
  const appPath = path.resolve(
    argumentValue("--app") ??
      (await discoverPackagedApp(path.join(repositoryRoot, "release", "development"))),
  );
  await verifyMacPackage(appPath);
  const artifactBefore = await packagedArtifactIdentity(appPath);
  const codeSignature = await codeSignatureMetadata(appPath);
  if (
    codeSignature.identifier !== null &&
    codeSignature.identifier !== artifactBefore.bundleIdentifier
  ) {
    throw new Error("The app's code-signing identifier does not match its Info.plist bundle id.");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-gemini-live-capture-"));
  const profile = path.join(temporary, "user-data");
  const configDir = path.join(temporary, "config");
  const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
  const token = randomBytes(32).toString("hex");
  let child;
  try {
    child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        `--${ACCEPTANCE_SWITCH}=${token}`,
      ],
      {
        env: {
          ...process.env,
          AIDEN_CONFIG_DIR: configDir,
          AIDEN_RUNTIME_PROFILE: "production",
          [ACCEPTANCE_ENV]: "1",
          [TOKEN_ENV]: token,
          [PROFILE_ENV]: profile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!child.pid) throw new Error("The exact packaged Aiden executable did not start.");
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    console.log("\nAiden is running from the exact packaged app with an isolated profile.");
    console.log("1. Click Begin acceptance in Aiden.");
    console.log("2. Select one disposable screen or window in the macOS chooser.");
    console.log("3. Stop sharing from the macOS sharing control so the track ends externally.");
    console.log("4. Cancel the second chooser without selecting a source.");
    console.log("No frames, source names, screenshots, audio, or prompts are written to the receipt.\n");

    const exit = await beforeDeadline(monitorChild(child));
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Packaged Aiden acceptance exited unsuccessfully (${exit.code ?? exit.signal}).`);
    }
    child = null;
    const artifactAfter = await packagedArtifactIdentity(appPath);
    assertSamePackagedArtifactIdentity(
      artifactBefore,
      artifactAfter,
      "The post-acceptance packaged app",
    );
    const raw = validateRawReceipt(
      JSON.parse(await readFile(path.join(profile, RAW_RECEIPT), "utf8")),
      artifactAfter,
      token,
      profile,
    );
    await writeFinalReceipt({
      schemaVersion: 1,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      durationMs: raw.durationMs,
      artifact: {
        bundleIdentifier: artifactAfter.bundleIdentifier,
        bundleVersion: artifactAfter.bundleVersion,
        shortVersion: artifactAfter.shortVersion,
        cdHash: artifactAfter.cdHash ?? null,
        designatedRequirement: codeSignature.designatedRequirement,
        codeSigningIdentifier: codeSignature.identifier,
        codeSigningTeamIdentifier: codeSignature.teamIdentifier,
        appAsarSha256: artifactAfter.appAsarSha256,
      },
      runtime: {
        electron: raw.runtime.electron,
        macOS: await macOSVersion(),
        darwin: raw.runtime.macOS,
        arch: raw.runtime.arch,
      },
      checks: raw.checks,
    });
    console.log(`Gemini Live display capture acceptance receipt: ${FINAL_RECEIPT}`);
  } catch (error) {
    await rm(FINAL_RECEIPT, { force: true });
    await terminate(child);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await runAcceptance();

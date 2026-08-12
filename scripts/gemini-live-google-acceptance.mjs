import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import {
  GOOGLE_LIVE_ACCEPTANCE_TOTAL_DEADLINE_MS,
  buildGoogleLiveAcceptanceReceipt,
  googleLiveAcceptanceEnabled,
  parseGoogleLiveAcceptanceArgs,
  parseGoogleLiveAppEvidence,
} from "./gemini-live-google-acceptance-core.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ),
);
const RECEIPT_DIRECTORY = path.join(repositoryRoot, "build/acceptance");
const TEMP_PREFIX = path.join(os.tmpdir(), "aiden-gemini-live-google-");

async function installedVersion(packageName) {
  const manifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "node_modules", packageName, "package.json"),
      "utf8",
    ),
  );
  return String(manifest.version);
}

async function launchInputsSha256(inputs) {
  const files = [];
  async function visit(current, root) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      files.push({
        absolute: current,
        label: path.relative(root, current) || path.basename(current),
        link: await readlink(current),
      });
      return;
    }
    if (metadata.isFile()) {
      files.push({
        absolute: current,
        label: path.relative(root, current) || path.basename(current),
      });
      return;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      await visit(absolute, root);
    }
  }
  for (const input of inputs) await visit(input, path.dirname(input));
  files.sort((left, right) => left.absolute.localeCompare(right.absolute));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.label);
    hash.update("\0");
    hash.update(file.link ?? (await readFile(file.absolute)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function electronNodeVersion() {
  const result = spawnSync(electronPath, ["-p", "process.versions.node"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout.trim())
    throw new Error("Electron Node version unavailable.");
  return result.stdout.trim();
}

function electronRuntimeVersion() {
  const probeEnvironment = { ...process.env };
  delete probeEnvironment.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: probeEnvironment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const version = result.stdout.trim().replace(/^v/u, "");
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/u.test(version))
    throw new Error("Electron runtime version unavailable.");
  return version;
}

function gitValue(args, fallback) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : fallback;
}

function childEnvironment(root, model, evidencePath) {
  const environment = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    AIDEN_CONFIG_DIR: path.join(root, "portable-config"),
    AIDEN_EXPERIMENTAL_GEMINI_LIVE: "1",
    AIDEN_EXPERIMENTAL_GEMINI_LIVE_MODEL: model,
    AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE: "1",
    AIDEN_GEMINI_LIVE_ACCEPTANCE_EVIDENCE_PATH: evidencePath,
  };
}

function elapsed(started) {
  return Math.max(0, Date.now() - started);
}

function fixedOperatorEvidence() {
  return {
    credentialEnteredInApp: false,
    liveReadyObserved: false,
    providerResponseObserved: false,
    visibleStopObserved: false,
    stopActivated: false,
    idleAfterStopObserved: false,
  };
}

function fixedAppEvidence() {
  return {
    ready: false,
    providerResponse: false,
    stopRequested: false,
    stopped: false,
  };
}

function fixedTiming() {
  return {
    credentialReadyMs: 0,
    liveReadyMs: 0,
    stopVisibleMs: 0,
    stoppedMs: 0,
    appReadyMs: 0,
    appProviderResponseMs: 0,
    appStopRequestedMs: 0,
    appStoppedMs: 0,
  };
}

function failureCode(error) {
  if (error?.code === "APP_EXITED") return "app_exited";
  if (error?.code === "DEADLINE_EXCEEDED") return "deadline_exceeded";
  if (error?.code === "OPERATOR_ABORTED") return "operator_aborted";
  return "launch_failed";
}

async function askExact(terminal, childExited, question, expected, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const error = new Error("Acceptance deadline exceeded.");
    error.code = "DEADLINE_EXCEEDED";
    throw error;
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Acceptance deadline exceeded.");
      error.code = "DEADLINE_EXCEEDED";
      reject(error);
    }, remaining);
  });
  try {
    const answer = await Promise.race([
      terminal.question(question),
      timeout,
      childExited,
    ]);
    if (answer.trim() !== expected) {
      const error = new Error("Operator aborted acceptance.");
      error.code = "OPERATOR_ABORTED";
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function requireAppEvidence(
  evidencePath,
  expectedEvent,
  child,
  deadlineAt,
) {
  while (Date.now() < deadlineAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const error = new Error("Aiden exited before acceptance completed.");
      error.code = "APP_EXITED";
      throw error;
    }
    try {
      const evidence = parseGoogleLiveAppEvidence(
        await readFile(evidencePath, "utf8"),
      );
      if (evidence.has(expectedEvent)) return evidence.get(expectedEvent);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = new Error("Acceptance deadline exceeded.");
  error.code = "DEADLINE_EXCEEDED";
  throw error;
}

async function requirePinnedAppEvidence(
  evidencePath,
  expectedEvent,
  expectedSessionId,
  child,
  deadlineAt,
) {
  const elapsedMs = await requireAppEvidence(
    evidencePath,
    expectedEvent,
    child,
    deadlineAt,
  );
  const evidence = parseGoogleLiveAppEvidence(
    await readFile(evidencePath, "utf8"),
  );
  if (evidence.get("sessionId") !== expectedSessionId)
    throw new Error("Acceptance evidence changed Live sessions.");
  return elapsedMs;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

async function writeReceipt(receipt) {
  await mkdir(RECEIPT_DIRECTORY, { recursive: true, mode: 0o700 });
  const timestamp = receipt.completedAt.replaceAll(":", "-");
  const receiptPath = path.join(
    RECEIPT_DIRECTORY,
    `gemini-live-google-${timestamp}-${randomUUID().slice(0, 8)}.json`,
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return receiptPath;
}

let parsed;
try {
  parsed = parseGoogleLiveAcceptanceArgs(process.argv.slice(2));
} catch {
  console.error(
    "Usage: AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE=1 npm run test:gemini-live:google:acceptance -- --i-understand-real-google-call --model <reviewed-model>",
  );
  process.exitCode = 2;
}

if (parsed && !googleLiveAcceptanceEnabled(process.env, parsed.confirmed)) {
  console.error(
    "Real Google Live acceptance is disabled without both explicit opt-ins.",
  );
  process.exitCode = 2;
} else if (parsed) {
  const gitDirty = gitValue(
    ["status", "--porcelain", "--untracked-files=all"],
    "unknown",
  );
  if (gitDirty !== "") {
    console.error(
      "Real Google Live acceptance requires a clean git tree so evidence is reproducible.",
    );
    process.exitCode = 2;
  }

  if (!process.exitCode) {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (build.status !== 0) {
      console.error(
        "A fresh Aiden build is required for real Google Live acceptance.",
      );
      process.exitCode = 2;
    }
  }

  if (!process.exitCode) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const deadlineAt = started + GOOGLE_LIVE_ACCEPTANCE_TOTAL_DEADLINE_MS;
    const operatorEvidence = fixedOperatorEvidence();
    const appEvidence = fixedAppEvidence();
    const timing = fixedTiming();
    const temporary = await mkdtemp(TEMP_PREFIX);
    const userData = path.join(temporary, "user-data");
    const appEvidencePath = path.join(
      userData,
      "gemini-live-acceptance-evidence.jsonl",
    );
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const environment = {
      appVersion: String(packageJson.version),
      sdkVersion: await installedVersion("@google/genai"),
      electronVersion: electronRuntimeVersion(),
      nodeVersion: electronNodeVersion(),
      macosVersion: os.release(),
      arch: process.arch,
      gitCommit: gitValue(["rev-parse", "HEAD"], "unknown"),
      gitDirty: false,
      buildSha256: await launchInputsSha256([
        path.join(repositoryRoot, "build", "main"),
        path.join(repositoryRoot, "build", "preload"),
        path.join(repositoryRoot, "build", "renderer"),
        path.join(repositoryRoot, "build", "native"),
        path.join(repositoryRoot, "node_modules"),
        path.join(repositoryRoot, "package-lock.json"),
      ]),
      model: parsed.model,
    };
    let result = "fail";
    let code = "launch_failed";
    let child;
    const terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      child = spawn(
        electronPath,
        [repositoryRoot, `--user-data-dir=${userData}`],
        {
          cwd: repositoryRoot,
          env: childEnvironment(temporary, parsed.model, appEvidencePath),
          stdio: "ignore",
        },
      );
      const childExited = new Promise((_, reject) => {
        child.once("error", () => {
          const error = new Error("Aiden failed to launch.");
          error.code = "APP_EXITED";
          reject(error);
        });
        child.once("exit", () => {
          const error = new Error("Aiden exited before acceptance completed.");
          error.code = "APP_EXITED";
          reject(error);
        });
      });

      console.log(
        "An isolated Aiden window is opening for the bounded real Google Live smoke.",
      );
      console.log(
        "Enter the Google key only in Aiden Settings; never paste it into this terminal.",
      );
      await askExact(
        terminal,
        childExited,
        "After Google is connected through Aiden and Start Live is available, type CREDENTIAL-READY: ",
        "CREDENTIAL-READY",
        deadlineAt,
      );
      operatorEvidence.credentialEnteredInApp = true;
      timing.credentialReadyMs = elapsed(started);
      await askExact(
        terminal,
        childExited,
        "After Live visibly reaches its ready/listening state, type LIVE-READY: ",
        "LIVE-READY",
        deadlineAt,
      );
      operatorEvidence.liveReadyObserved = true;
      timing.appReadyMs = await requireAppEvidence(
        appEvidencePath,
        "ready",
        child,
        deadlineAt,
      );
      appEvidence.ready = true;
      const pinnedEvidence = parseGoogleLiveAppEvidence(
        await readFile(appEvidencePath, "utf8"),
      );
      const pinnedSessionId = pinnedEvidence.get("sessionId");
      if (
        typeof pinnedSessionId !== "string" ||
        pinnedEvidence.has("stop_requested")
      )
        throw new Error(
          "Live evidence was not a fresh active session at the ready gate.",
        );
      timing.liveReadyMs = elapsed(started);
      await askExact(
        terminal,
        childExited,
        "After observing one provider response (do not enter its content), type RESPONSE-OBSERVED: ",
        "RESPONSE-OBSERVED",
        deadlineAt,
      );
      operatorEvidence.providerResponseObserved = true;
      timing.appProviderResponseMs = await requirePinnedAppEvidence(
        appEvidencePath,
        "provider_response",
        pinnedSessionId,
        child,
        deadlineAt,
      );
      appEvidence.providerResponse = true;
      await askExact(
        terminal,
        childExited,
        "While the persistent Stop control is visibly present, type STOP-VISIBLE: ",
        "STOP-VISIBLE",
        deadlineAt,
      );
      operatorEvidence.visibleStopObserved = true;
      timing.stopVisibleMs = elapsed(started);
      await askExact(
        terminal,
        childExited,
        "Click the visible Stop control; after Aiden visibly returns to idle, type STOPPED: ",
        "STOPPED",
        deadlineAt,
      );
      operatorEvidence.stopActivated = true;
      operatorEvidence.idleAfterStopObserved = true;
      timing.appStopRequestedMs = await requirePinnedAppEvidence(
        appEvidencePath,
        "stop_requested",
        pinnedSessionId,
        child,
        deadlineAt,
      );
      appEvidence.stopRequested = true;
      timing.appStoppedMs = await requirePinnedAppEvidence(
        appEvidencePath,
        "stopped",
        pinnedSessionId,
        child,
        deadlineAt,
      );
      appEvidence.stopped = true;
      timing.stoppedMs = elapsed(started);
      result = "pass";
      code = undefined;
    } catch (error) {
      code = failureCode(error);
    } finally {
      terminal.close();
      if (child) await stopChild(child);
      if (temporary.startsWith(TEMP_PREFIX)) {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    const completedAt = new Date().toISOString();
    try {
      const receipt = buildGoogleLiveAcceptanceReceipt({
        result,
        ...(code ? { failureCode: code } : {}),
        startedAt,
        completedAt,
        environment,
        timing,
        runnerEvidence: { isolatedProfile: true },
        appEvidence,
        operatorEvidence,
      });
      const receiptPath = await writeReceipt(receipt);
      console.log(
        `Google Live acceptance ${result}. Content-free receipt: ${receiptPath}`,
      );
      if (result !== "pass") process.exitCode = 1;
    } catch {
      console.error("Google Live acceptance receipt could not be written.");
      process.exitCode = 1;
    }
  }
}

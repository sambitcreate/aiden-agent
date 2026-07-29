/* global AbortController, clearTimeout, console, process, setTimeout */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SUBAGENT_PACKAGED_SOAK_CHAT_ID,
  SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME,
  SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH,
  SUBAGENT_PACKAGED_SOAK_ENV,
  SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME,
  SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX,
  assertCompletedSubagentPackagedSoakAggregate,
  assertSubagentPackagedSoakReceipt,
  createSubagentPackagedSoakAggregate,
  createSubagentPackagedSoakControl,
  parseSubagentPackagedSoakReceipt,
  recordSubagentPackagedSoakCycle,
  startSubagentPackagedSoakModel,
  subagentPackagedSoakFixture,
} from "./subagent-packaged-soak-core.mjs";
import {
  assertSamePackagedArtifactIdentity,
  discoverPackagedApp,
  packagedArtifactIdentity,
  verifyMacPackage,
} from "./verify-macos-package.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const DEFAULT_CYCLES = 100;
const MIN_CYCLES = 3;
const MAX_CYCLES = 1_000;
const CYCLE_TIMEOUT_MS = 90_000;
const EXIT_RECEIPT_GRACE_MS = 1_000;
const PROCESS_POLL_MS = 100;
const STABLE_ZERO_PROCESS_SAMPLES = 2;
const RECEIPT_POLL_MS = 50;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const CHILD_DIAGNOSTIC_TAIL_CHARS = 8_192;

function usage() {
  return [
    "Usage: AIDEN_SUBAGENT_SOAK=1 npm run test:subagents:packaged -- [--app /path/Aiden Agent.app] [--cycles 100]",
    "",
    "Runs an explicit macOS-only packaged lifecycle soak against a disposable loopback model.",
  ].join("\n");
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9]\d*$/u.test(value ?? "")) throw new Error(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CYCLES || parsed > MAX_CYCLES) {
    throw new Error(`${option} must be between ${MIN_CYCLES} and ${MAX_CYCLES}.`);
  }
  return parsed;
}

export function parseSubagentPackagedSoakArguments(argv) {
  let appPath;
  let cycles = DEFAULT_CYCLES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--app") {
      const value = argv[++index];
      if (!value) throw new Error("--app requires an unpacked .app path.");
      appPath = path.resolve(value);
      continue;
    }
    if (argument === "--cycles") {
      cycles = parsePositiveInteger(argv[++index], "--cycles");
      continue;
    }
    throw new Error(`Unknown packaged subagent soak option: ${argument}`);
  }
  return { appPath, cycles, help: false };
}

/**
 * Keep a failed packaged-smoke report actionable without retaining prompts,
 * request bodies, paths, or identifiers from the disposable fixture.
 */
export function formatSubagentPackagedSoakLoopbackEvidence(evidence) {
  const keys = ["parentToolCalls", "childStarts", "childAborts", "unexpectedRequests"];
  if (
    !evidence ||
    typeof evidence !== "object" ||
    keys.some((key) => !Number.isSafeInteger(evidence[key]) || evidence[key] < 0)
  ) {
    return null;
  }
  return `loopback parent tool calls=${evidence.parentToolCalls}, child starts=${evidence.childStarts}, child aborts=${evidence.childAborts}, unexpected requests=${evidence.unexpectedRequests}`;
}

function failureWithLoopbackEvidence(caught, model, childDiagnosticOutput) {
  const summary = formatSubagentPackagedSoakLoopbackEvidence(model?.evidence?.());
  const output = childDiagnosticOutput?.();
  if (!summary && !output) return caught;
  const message = caught instanceof Error ? caught.message : String(caught);
  const details = [summary, output].filter(Boolean).join("; ");
  return new Error(`${message} (${details}).`, { cause: caught });
}

function cycleMode(index) {
  return ["user_stop", "navigate", "quit"][index % 3];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function receiptWaitAborted() {
  const error = new Error("Packaged subagent soak receipt wait was cancelled.");
  error.name = "AbortError";
  return error;
}

function abortableReceiptSleep(milliseconds, signal) {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) return Promise.reject(receiptWaitAborted());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(receiptWaitAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function beforeDeadline(promise, deadline, message) {
  const remaining = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), remaining);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (caught) => {
        clearTimeout(timeout);
        reject(caught);
      },
    );
  });
}

async function writePrivateJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(target, PRIVATE_FILE_MODE);
}

async function privateDirectory(target) {
  await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(target, PRIVATE_DIRECTORY_MODE);
}

async function createCycleRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX));
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  return root;
}

async function seedCycle({ root, port, capability }) {
  const workspace = path.join(root, "workspace");
  const userData = path.join(root, "user-data");
  const portableConfig = path.join(root, "portable-config");
  const chats = path.join(userData, "chats");
  await Promise.all([
    privateDirectory(workspace),
    privateDirectory(chats),
    privateDirectory(portableConfig),
  ]);
  await writeFile(path.join(workspace, "README.md"), "# Disposable packaged subagent soak workspace\n", {
    encoding: "utf8",
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  const fixture = subagentPackagedSoakFixture({
    port,
    capability,
    workspacePath: workspace,
  });
  await Promise.all([
    writePrivateJson(path.join(portableConfig, "config.json"), fixture.portableConfig),
    writePrivateJson(path.join(userData, "config.json"), fixture.localConfig),
    writePrivateJson(path.join(userData, "settings.json"), fixture.settings),
    writePrivateJson(
      path.join(userData, "provider-model-cache.json"),
      fixture.providerModelCache,
    ),
    writePrivateJson(path.join(chats, "index.json"), fixture.chatIndex),
    writePrivateJson(path.join(chats, `${SUBAGENT_PACKAGED_SOAK_CHAT_ID}.json`), fixture.chat),
  ]);
  return { userData, portableConfig };
}

async function processTable() {
  const { stdout } = await executeFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

function commandMatchesExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

/** Match every executable launched from this exact target bundle, not just its main binary. */
export function isSubagentPackagedSoakPackageProcess(appPath, command) {
  if (typeof appPath !== "string" || typeof command !== "string") return false;
  const contentsPrefix = `${path.resolve(appPath)}${path.sep}Contents${path.sep}`;
  return command.startsWith(contentsPrefix);
}

async function packageOwnedProcesses(appPath) {
  return (await processTable()).filter((entry) =>
    isSubagentPackagedSoakPackageProcess(appPath, entry.command),
  );
}

async function commandForPid(pid) {
  try {
    const { stdout } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch (caught) {
    if (caught?.code === 1) return null;
    throw caught;
  }
}

async function waitForProcessExit(processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const command = await commandForPid(processInfo.pid);
    if (command === null || !commandMatchesExecutable(command, processInfo.executable)) return true;
    await sleep(PROCESS_POLL_MS);
  }
  const command = await commandForPid(processInfo.pid);
  return command === null || !commandMatchesExecutable(command, processInfo.executable);
}

async function signalTrackedProcess(processInfo, signal) {
  if (!processInfo) return;
  const command = await commandForPid(processInfo.pid);
  if (command === null) return;
  if (!commandMatchesExecutable(command, processInfo.executable)) {
    throw new Error(`Refusing to signal a reused packaged soak pid ${processInfo.pid}.`);
  }
  try {
    await executeFile("/bin/kill", [`-${signal}`, String(processInfo.pid)]);
  } catch (caught) {
    if ((await commandForPid(processInfo.pid)) !== null) throw caught;
  }
}

async function terminateTrackedProcess(processInfo) {
  if (!processInfo) return;
  await signalTrackedProcess(processInfo, "TERM");
  if (await waitForProcessExit(processInfo, 5_000)) return;
  await signalTrackedProcess(processInfo, "KILL");
  if (!(await waitForProcessExit(processInfo, 5_000))) {
    throw new Error("A tracked packaged soak process did not exit after SIGKILL.");
  }
}

async function waitForPackageProcessExit(appPath, processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const command = await commandForPid(processInfo.pid);
    if (command === null || !isSubagentPackagedSoakPackageProcess(appPath, command)) return true;
    await sleep(PROCESS_POLL_MS);
  }
  const command = await commandForPid(processInfo.pid);
  return command === null || !isSubagentPackagedSoakPackageProcess(appPath, command);
}

async function signalPackageOwnedProcess(appPath, processInfo, signal) {
  const command = await commandForPid(processInfo.pid);
  if (command === null) return;
  if (!isSubagentPackagedSoakPackageProcess(appPath, command)) {
    throw new Error(`Refusing to signal a reused packaged soak pid ${processInfo.pid}.`);
  }
  try {
    await executeFile("/bin/kill", [`-${signal}`, String(processInfo.pid)]);
  } catch (caught) {
    const current = await commandForPid(processInfo.pid);
    if (current !== null && isSubagentPackagedSoakPackageProcess(appPath, current)) throw caught;
  }
}

async function terminatePackageOwnedProcess(appPath, processInfo) {
  await signalPackageOwnedProcess(appPath, processInfo, "TERM");
  if (await waitForPackageProcessExit(appPath, processInfo, 5_000)) return;
  await signalPackageOwnedProcess(appPath, processInfo, "KILL");
  if (!(await waitForPackageProcessExit(appPath, processInfo, 5_000))) {
    throw new Error("A target-bundle packaged soak process did not exit after SIGKILL.");
  }
}

function monitorChild(child) {
  let outcome = null;
  const promise = new Promise((resolve) => {
    child.once("error", (caught) => {
      outcome = { error: caught };
      resolve(outcome);
    });
    child.once("exit", (code, signal) => {
      if (outcome) return;
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  return { promise, outcome: () => outcome };
}

export function appendSubagentPackagedSoakDiagnosticTail(previous, chunk) {
  const next = `${previous}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`;
  return next.length > CHILD_DIAGNOSTIC_TAIL_CHARS
    ? next.slice(-CHILD_DIAGNOSTIC_TAIL_CHARS)
    : next;
}

/** Retain only the bounded tail of this disposable smoke app's own diagnostics. */
function captureChildDiagnosticOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = appendSubagentPackagedSoakDiagnosticTail(output, chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output.trim();
}

function exitError(outcome) {
  if (outcome?.error) return outcome.error;
  return new Error(
    `Packaged Aiden exited before the soak receipt (${outcome?.code ?? outcome?.signal ?? "unknown"}).`,
  );
}

/**
 * The app writes and fsyncs the quit receipt immediately before it exits. Let
 * that final write win over a normal exit event instead of falsely treating a
 * valid receipt as missing because the child-process event happened first.
 */
export async function waitForSubagentPackagedSoakReceiptOrExit({
  receiptPath,
  control,
  childState,
  deadline,
  waitForReceiptFn = waitForReceipt,
}) {
  const receiptAbort = new AbortController();
  const receiptOutcome = Promise.resolve(
    waitForReceiptFn(receiptPath, control, deadline, { signal: receiptAbort.signal }),
  ).then(
    (receipt) => ({ kind: "receipt", receipt }),
    (caught) => ({ kind: "receipt_error", caught }),
  );
  try {
    const outcome = await Promise.race([
      receiptOutcome,
      childState.promise.then((childOutcome) => ({ kind: "exit", childOutcome })),
    ]);
    if (outcome.kind === "receipt") return outcome.receipt;
    if (outcome.kind === "receipt_error") throw outcome.caught;
    if (
      outcome.childOutcome?.error ||
      outcome.childOutcome?.code !== 0 ||
      outcome.childOutcome?.signal !== null
    ) {
      throw exitError(outcome.childOutcome);
    }
    // Stop the original full-cycle poll before starting the short post-exit
    // grace probe. Its rejection is captured by receiptOutcome, so no timer or
    // unhandled rejection can keep a failed smoke runner alive to the cycle deadline.
    receiptAbort.abort();
    return waitForReceiptFn(
      receiptPath,
      control,
      Math.min(deadline, Date.now() + EXIT_RECEIPT_GRACE_MS),
    );
  } finally {
    receiptAbort.abort();
  }
}

async function waitForReceipt(receiptPath, control, deadline, { signal } = {}) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw receiptWaitAborted();
    try {
      const stat = await lstat(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw new Error("Packaged subagent soak receipt is not a private regular file.");
      }
      const parsed = parseSubagentPackagedSoakReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
      return assertSubagentPackagedSoakReceipt(parsed, control);
    } catch (caught) {
      if (caught?.code !== "ENOENT" && !(caught instanceof SyntaxError)) {
        // The receipt is created with exclusive mode, but a reader can observe
        // its short write window before the main process fsyncs it.
        if (Date.now() + RECEIPT_POLL_MS >= deadline) throw caught;
      }
    }
    await abortableReceiptSleep(RECEIPT_POLL_MS, signal);
  }
  if (signal?.aborted) throw receiptWaitAborted();
  throw new Error("Packaged subagent soak did not write a valid receipt before its deadline.");
}

async function waitForStableNoOwnedSubagentPackagedSoakProcesses(
  appPath,
  timeoutMs,
  {
    listPackageProcesses = packageOwnedProcesses,
    onActive,
    sleepFn = sleep,
    now = Date.now,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let zeroSamples = 0;
  while (now() < deadline) {
    const active = await listPackageProcesses(appPath);
    if (active.length === 0) {
      zeroSamples += 1;
      if (zeroSamples >= STABLE_ZERO_PROCESS_SAMPLES) return;
    } else {
      zeroSamples = 0;
      await onActive?.(active);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleepFn(Math.min(PROCESS_POLL_MS, remaining));
  }
  const active = await listPackageProcesses(appPath);
  if (active.length > 0) {
    throw new Error("A process owned by the target Aiden package remained after the soak cycle.");
  }
  throw new Error("Target Aiden package processes did not remain absent across the stable clean interval.");
}

/** Require a short stable-zero process interval so late Electron helpers cannot escape a cycle. */
export async function waitForNoOwnedSubagentPackagedSoakProcesses(
  appPath,
  timeoutMs,
  dependencies = {},
) {
  await waitForStableNoOwnedSubagentPackagedSoakProcesses(appPath, timeoutMs, dependencies);
}

/**
 * Failure cleanup must reap every executable from the exact staged bundle, not
 * merely the spawned main process. Each signal revalidates the PID's current
 * command first, and the final stable-zero interval catches a late helper.
 */
export async function terminateLingeringSubagentPackagedSoakProcesses(
  appPath,
  {
    timeoutMs = 10_000,
    listPackageProcesses = packageOwnedProcesses,
    terminatePackageProcess = terminatePackageOwnedProcess,
    sleepFn = sleep,
    now = Date.now,
  } = {},
) {
  await waitForStableNoOwnedSubagentPackagedSoakProcesses(appPath, timeoutMs, {
    listPackageProcesses,
    sleepFn,
    now,
    onActive: async (active) => {
      const results = await Promise.allSettled(
        active.map((processInfo) => terminatePackageProcess(appPath, processInfo)),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Could not terminate every target-bundle packaged soak process.",
        );
      }
    },
  });
}

async function assertNoRunningPackagedAiden(appPath) {
  const active = await packageOwnedProcesses(appPath);
  if (active.length > 0) {
    throw new Error("Quit every process from the targeted packaged Aiden app before starting the isolated subagent soak.");
  }
}

/** Check the exact app that will run without trusting the mutable .app path. */
export async function assertSubagentPackagedSoakArtifactStable(
  appPath,
  expectedArtifact,
  {
    verifyPackage = verifyMacPackage,
    getIdentity = packagedArtifactIdentity,
  } = {},
) {
  // A bundle's outer identity cannot prove that nested signed helpers and
  // resources are unchanged. Re-run the complete package verifier before
  // every launch, then bind that verified payload to the original artifact.
  await verifyPackage(appPath);
  const actualArtifact = await getIdentity(appPath);
  assertSamePackagedArtifactIdentity(
    expectedArtifact,
    actualArtifact,
    "Packaged subagent soak artifact",
  );
  return actualArtifact;
}

/** Verify package integrity, then optionally bind it to the original staged artifact. */
export async function verifySubagentPackagedSoakArtifact(
  appPath,
  expectedArtifact,
  {
    verifyPackage = verifyMacPackage,
    getIdentity = packagedArtifactIdentity,
  } = {},
) {
  await verifyPackage(appPath);
  const actualArtifact = await getIdentity(appPath);
  if (expectedArtifact !== undefined) {
    assertSamePackagedArtifactIdentity(
      expectedArtifact,
      actualArtifact,
      "Packaged subagent soak artifact",
    );
  }
  return actualArtifact;
}

async function runCycle({ appPath, artifact, cycle, cycles }) {
  const root = await createCycleRoot();
  const mode = cycleMode(cycle - 1);
  const nonce = randomBytes(32).toString("base64url");
  const control = createSubagentPackagedSoakControl({ nonce, cycle, mode });
  const controlPath = path.join(root, SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME);
  const receiptPath = path.join(root, SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME);
  const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
  let model = null;
  let aidenProcess = null;
  let childDiagnosticOutput = null;
  let completed = false;
  let failure = null;

  try {
    model = await startSubagentPackagedSoakModel({ capability: nonce });
    const seeded = await seedCycle({ root, port: model.port, capability: nonce });
    await writePrivateJson(controlPath, control);
    await assertSubagentPackagedSoakArtifactStable(appPath, artifact);

    const child = spawn(executable, [
      `--user-data-dir=${seeded.userData}`,
      `${SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH}=${controlPath}`,
    ], {
      env: {
        ...process.env,
        AIDEN_CONFIG_DIR: seeded.portableConfig,
        AIDEN_SUBAGENTS_ENABLED: "1",
        [SUBAGENT_PACKAGED_SOAK_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error("The packaged Aiden process did not start.");
    aidenProcess = { pid: child.pid, executable };
    childDiagnosticOutput = captureChildDiagnosticOutput(child);
    const childState = monitorChild(child);
    const deadline = Date.now() + CYCLE_TIMEOUT_MS;

    const receipt = await beforeDeadline(
      waitForSubagentPackagedSoakReceiptOrExit({
        receiptPath,
        control,
        childState,
        deadline,
      }),
      deadline,
      `Packaged subagent soak cycle ${cycle}/${cycles} timed out before receipt.`,
    );
    await beforeDeadline(
      model.childStarted,
      deadline,
      `Packaged subagent soak cycle ${cycle}/${cycles} never started a child request.`,
    );
    await beforeDeadline(
      model.childAborted,
      deadline,
      `Packaged subagent soak cycle ${cycle}/${cycles} did not cancel the child request.`,
    );
    const outcome = await beforeDeadline(
      childState.promise,
      deadline,
      `Packaged subagent soak cycle ${cycle}/${cycles} did not quit normally.`,
    );
    if (outcome.error) throw outcome.error;
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(`Packaged Aiden exited abnormally (${outcome.code ?? outcome.signal}).`);
    }
    aidenProcess = null;
    await waitForNoOwnedSubagentPackagedSoakProcesses(appPath, 10_000);

    const evidence = model.evidence();
    if (
      evidence.parentToolCalls !== 1 ||
      evidence.childStarts !== 1 ||
      evidence.childAborts < 1 ||
      evidence.unexpectedRequests !== 0
    ) {
      throw new Error("The packaged subagent soak loopback observed an invalid request lifecycle.");
    }
    await model.close();
    model = null;
    await rm(root, { recursive: true, force: true });
    completed = true;
    return { receipt, requestAborts: evidence.childAborts };
  } catch (caught) {
    failure = failureWithLoopbackEvidence(caught, model, childDiagnosticOutput);
  } finally {
    if (!completed) {
      const cleanupErrors = [];
      for (const operation of [
        () => terminateTrackedProcess(aidenProcess),
        () => terminateLingeringSubagentPackagedSoakProcesses(appPath),
        () => model?.close(),
      ]) {
        try {
          await operation();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      console.error(`Packaged subagent soak evidence was retained at ${root}`);
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [failure, ...cleanupErrors].filter(Boolean),
          "Packaged subagent soak failed and emergency cleanup was incomplete.",
        );
      }
    }
  }
  throw failure;
}

async function writeAggregateReceipt(root, aggregate) {
  const receiptPath = path.join(root, "aggregate-receipt.json");
  await writePrivateJson(receiptPath, aggregate);
  return receiptPath;
}

export async function runSubagentPackagedSoak(options = parseSubagentPackagedSoakArguments(process.argv.slice(2))) {
  if (process.platform !== "darwin") {
    throw new Error("Packaged subagent soak is macOS-only.");
  }
  if (process.env[SUBAGENT_PACKAGED_SOAK_ENV] !== "1") {
    throw new Error(
      `This launches a packaged app 100 times. Re-run with ${SUBAGENT_PACKAGED_SOAK_ENV}=1 after reviewing the soak scope.`,
    );
  }
  const appPath = path.resolve(
    options.appPath ?? (await discoverPackagedApp(path.join(repositoryRoot, "release", "development"))),
  );
  await assertNoRunningPackagedAiden(appPath);
  const [artifact, reportRoot] = await Promise.all([
    verifySubagentPackagedSoakArtifact(appPath),
    mkdtemp(path.join(os.tmpdir(), "aiden-subagent-soak-report-")),
  ]);
  await chmod(reportRoot, PRIVATE_DIRECTORY_MODE);
  const aggregate = createSubagentPackagedSoakAggregate({ cycles: options.cycles, artifact });
  try {
    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      const result = await runCycle({ appPath, artifact, cycle, cycles: options.cycles });
      recordSubagentPackagedSoakCycle(aggregate, result);
      console.log(`Packaged subagent soak cycle ${cycle}/${options.cycles} passed.`);
    }
    await verifySubagentPackagedSoakArtifact(appPath, artifact);
    assertCompletedSubagentPackagedSoakAggregate(aggregate);
    const receiptPath = await writeAggregateReceipt(reportRoot, aggregate);
    console.log(`Packaged subagent soak passed. Receipt: ${receiptPath}`);
  } catch (caught) {
    console.error(`Packaged subagent soak aggregate evidence was retained at ${reportRoot}`);
    throw caught;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const options = parseSubagentPackagedSoakArguments(process.argv.slice(2));
  if (options.help) console.log(usage());
  else await runSubagentPackagedSoak(options);
}
